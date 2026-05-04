// Express server that runs ffmpeg native for fast video editing.
// Endpoints:
//   POST /api/process         — upload video + options(JSON), returns { id, url }
//   GET  /api/result/:id      — download/stream the processed mp4
//   POST /api/transcribe      — upload video, return { srt, vtt, text, segments, ... }
//   POST /api/burn-subtitles  — upload video + srt, return mp4 with hardcoded subs
//   GET  /healthz             — liveness check

import express from "express";
import cors from "cors";
import multer from "multer";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { mkdir, unlink, stat, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 8080;
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "https://ai-video-editor-good.netlify.app,http://localhost:8888,http://localhost:5173"
).split(",").map((s) => s.trim());

const TMP = process.env.TMP_DIR || "/tmp/aive";
await mkdir(TMP, { recursive: true });

const RESULT_TTL_MS = 60 * 60 * 1000; // 결과 파일 1시간 후 삭제

// ── App ──────────────────────────────────────────────────────────────────────
const app = express();

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl/healthz
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error("Origin not allowed: " + origin));
    },
  })
);

const upload = multer({
  dest: TMP,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB 상한
});

app.get("/", (req, res) => res.type("text/plain").send("AI Video Editor backend"));

// 헬스체크. /healthz 는 인프라용, /api/health 는 프론트엔드가 라우트 가용성을
// 확인하기 위해 호출. routes 배열로 어떤 엔드포인트가 살아있는지 명시한다.
function healthBody() {
  return {
    ok: true,
    version: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || "unknown",
    routes: [
      { method: "POST", path: "/api/process" },
      { method: "GET",  path: "/api/result/:id" },
      { method: "POST", path: "/api/transcribe" },
      { method: "POST", path: "/api/burn-subtitles" },
      { method: "GET",  path: "/api/health" },
      { method: "GET",  path: "/healthz" },
    ],
    allowedOrigins: ALLOWED_ORIGINS,
  };
}
app.get("/healthz", (req, res) => res.json(healthBody()));
app.get("/api/health", (req, res) => res.json(healthBody()));

app.post("/api/process", upload.single("video"), async (req, res) => {
  const id = randomUUID();
  const inputPath = req.file?.path;
  const outputPath = path.join(TMP, `${id}.mp4`);

  try {
    if (!inputPath) {
      return res.status(400).json({ error: "video file required" });
    }

    let opts;
    try {
      opts = JSON.parse(req.body.options || "{}");
    } catch (e) {
      return res.status(400).json({ error: "invalid options JSON" });
    }

    const keeps = Array.isArray(opts.keeps) ? opts.keeps : [];
    if (keeps.length === 0) {
      return res.status(400).json({ error: "keeps array required" });
    }

    // 안전한 옵션만 받음
    const safe = {
      keeps: keeps.map((k) => ({
        start: Math.max(0, Number(k.start) || 0),
        end: Math.max(0, Number(k.end) || 0),
      })).filter((k) => k.end > k.start),
      ratio: ["16:9", "9:16", "1:1"].includes(opts.ratio) ? opts.ratio : "16:9",
      speed: clamp(Number(opts.speed) || 1.0, 0.5, 2.0),
      loudnorm: opts.loudnorm !== false,
    };

    if (safe.keeps.length === 0) {
      return res.status(400).json({ error: "no valid keep ranges" });
    }

    console.log(`[${id}] processing: keeps=${safe.keeps.length}, ratio=${safe.ratio}, speed=${safe.speed}x, loudnorm=${safe.loudnorm}`);
    const t0 = Date.now();
    await processVideo(inputPath, outputPath, safe);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const size = (await stat(outputPath)).size;
    console.log(`[${id}] done in ${elapsed}s, ${(size / 1024 / 1024).toFixed(1)}MB`);

    // 만료 시 결과 정리
    setTimeout(async () => {
      try { await unlink(outputPath); } catch {}
    }, RESULT_TTL_MS).unref();

    res.json({
      id,
      url: `/api/result/${id}`,
      durationMs: Date.now() - t0,
      sizeBytes: size,
    });
  } catch (e) {
    console.error(`[${id}] failed:`, e);
    res.status(500).json({ error: String(e?.message || e) });
  } finally {
    if (inputPath) {
      try { await unlink(inputPath); } catch {}
    }
  }
});

app.get("/api/result/:id", (req, res) => {
  const id = String(req.params.id).replace(/[^a-f0-9-]/gi, "");
  const file = path.join(TMP, `${id}.mp4`);
  if (!existsSync(file)) return res.status(404).json({ error: "not found or expired" });
  res.download(file, "edited.mp4");
});

// ── /api/transcribe — Whisper 자막 생성 ─────────────────────────────────────
// Body: multipart/form-data { video, language?, model? }
// Resp: { srt, vtt, text, segments, language, duration, durationMs }
app.post("/api/transcribe", upload.single("video"), async (req, res) => {
  const id = randomUUID();
  const inputPath = req.file?.path;
  try {
    if (!inputPath) return res.status(400).json({ error: "video file required" });
    const language = sanitizeLang(req.body.language);
    const model = sanitizeModel(req.body.model || process.env.WHISPER_MODEL || "small");
    const fillerMode = sanitizeFillerMode(req.body.fillerMode);
    console.log(`[${id}] transcribe: lang=${language} model=${model} fillerMode=${fillerMode}`);
    const t0 = Date.now();
    const result = await runTranscribe(inputPath, { language, model, fillerMode });
    const elapsed = Date.now() - t0;
    console.log(`[${id}] transcribe done in ${(elapsed / 1000).toFixed(1)}s, ${result.segments?.length || 0} segments`);
    res.json({ ...result, durationMs: elapsed });
  } catch (e) {
    console.error(`[${id}] transcribe failed:`, e);
    res.status(500).json({ error: String(e?.message || e) });
  } finally {
    if (inputPath) { try { await unlink(inputPath); } catch {} }
  }
});

// ── /api/burn-subtitles — SRT 를 영상에 영구 합성 ──────────────────────────
// Body: multipart/form-data { video, srt }
// Resp: streams mp4 (Content-Type: video/mp4)
app.post(
  "/api/burn-subtitles",
  upload.fields([{ name: "video", maxCount: 1 }, { name: "srt", maxCount: 1 }]),
  async (req, res) => {
    const id = randomUUID();
    const videoPath = req.files?.video?.[0]?.path;
    const srtUploadPath = req.files?.srt?.[0]?.path;
    const srtPath = path.join(TMP, `${id}.srt`);
    const outputPath = path.join(TMP, `${id}.burned.mp4`);
    try {
      if (!videoPath) return res.status(400).json({ error: "video file required" });
      // SRT 는 multipart 파일이거나 form 필드 둘 다 허용. 가능하면 form 필드 우선.
      let srt = req.body.srt;
      if (!srt && srtUploadPath) {
        const { readFile } = await import("fs/promises");
        srt = await readFile(srtUploadPath, "utf8");
      }
      if (!srt || typeof srt !== "string" || srt.length === 0) {
        return res.status(400).json({ error: "srt content required" });
      }
      await writeFile(srtPath, srt, "utf8");

      // libass 가 SRT 파일을 직접 읽도록 subtitles 필터 사용. 이스케이프된 절대 경로.
      const escapedSrt = srtPath.replace(/\\/g, "/").replace(/:/g, "\\:");
      const args = [
        "-i", videoPath,
        "-vf", `subtitles='${escapedSrt}':force_style='FontName=Arial,FontSize=20,Outline=2,Shadow=0,MarginV=40'`,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "copy",
        "-movflags", "+faststart",
        "-y", outputPath,
      ];
      console.log(`[${id}] burn-subtitles: ${srt.length} chars SRT`);
      const t0 = Date.now();
      await runFFmpeg(args);
      console.log(`[${id}] burn done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      res.download(outputPath, "subtitled.mp4", async (err) => {
        // 응답 끝나면 정리
        try { await unlink(outputPath); } catch {}
      });
    } catch (e) {
      console.error(`[${id}] burn failed:`, e);
      res.status(500).json({ error: String(e?.message || e) });
    } finally {
      if (videoPath) { try { await unlink(videoPath); } catch {} }
      if (srtUploadPath) { try { await unlink(srtUploadPath); } catch {} }
      try { await unlink(srtPath); } catch {}
    }
  }
);

app.listen(PORT, () => {
  console.log(`AI Video Editor backend listening on :${PORT}`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
});

// ── ffmpeg pipeline ──────────────────────────────────────────────────────────
async function processVideo(input, output, opts) {
  const { keeps, ratio, speed, loudnorm } = opts;

  const ratioFilter = ratioToFilter(ratio);
  const parts = [];
  for (let i = 0; i < keeps.length; i++) {
    const { start, end } = keeps[i];
    parts.push(
      `[0:v]trim=start=${start.toFixed(3)}:end=${end.toFixed(3)},setpts=PTS-STARTPTS,${ratioFilter}[v${i}]`
    );
    parts.push(
      `[0:a]atrim=start=${start.toFixed(3)}:end=${end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`
    );
  }
  const concatInputs = keeps.map((_, i) => `[v${i}][a${i}]`).join("");
  let filter = parts.join(";") +
    `;${concatInputs}concat=n=${keeps.length}:v=1:a=1[vcat][acat]`;

  // 속도
  filter += `;[vcat]setpts=${(1 / speed).toFixed(4)}*PTS[vfinal]`;
  let aOut = "[acat]";
  if (speed !== 1.0) {
    filter += `;${aOut}${atempoChain(speed)}[asp]`;
    aOut = "[asp]";
  }

  // 음량 정규화
  if (loudnorm) {
    filter += `;${aOut}loudnorm=I=-16:LRA=11:TP=-1.5[afinal]`;
  } else {
    filter += `;${aOut}anull[afinal]`;
  }

  const args = [
    "-i", input,
    "-filter_complex", filter,
    "-map", "[vfinal]",
    "-map", "[afinal]",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-c:a", "aac",
    "-b:a", "160k",
    "-movflags", "+faststart",
    "-y",
    output,
  ];

  await runFFmpeg(args);
}

function ratioToFilter(ratio) {
  if (ratio === "9:16") return "crop='min(iw,ih*9/16)':ih,scale=720:1280,setsar=1";
  if (ratio === "1:1") return "crop='min(iw,ih)':'min(iw,ih)',scale=720:720,setsar=1";
  return "scale='if(gt(a,16/9),1280,-2)':'if(gt(a,16/9),-2,720)',crop=1280:720,setsar=1";
}

function atempoChain(speed) {
  if (speed === 1.0) return "anull";
  const parts = [];
  let s = speed;
  while (s > 2.0) { parts.push("atempo=2.0"); s /= 2.0; }
  while (s < 0.5) { parts.push("atempo=0.5"); s /= 0.5; }
  parts.push(`atempo=${s.toFixed(4)}`);
  return parts.join(",");
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    ff.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    ff.on("error", reject);
    ff.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// ── Whisper 자막 ────────────────────────────────────────────────────────────
const ALLOWED_LANGS = new Set([
  "ko", "en", "ja", "zh", "es", "fr", "de", "it", "pt", "ru", "vi", "th", "id", "auto",
]);
const ALLOWED_MODELS = new Set([
  "tiny", "base", "small", "medium", "large", "large-v2", "large-v3",
]);

function sanitizeLang(v) {
  const s = String(v || "ko").toLowerCase();
  return ALLOWED_LANGS.has(s) ? s : "ko";
}
function sanitizeModel(v) {
  const s = String(v || "small").toLowerCase();
  return ALLOWED_MODELS.has(s) ? s : "small";
}

const ALLOWED_FILLER_MODES = new Set(["off", "conservative", "aggressive"]);
function sanitizeFillerMode(v) {
  const s = String(v || "off").toLowerCase();
  return ALLOWED_FILLER_MODES.has(s) ? s : "off";
}

// transcribe.py 를 별도 프로세스로 실행해 stdout JSON 파싱.
// stdout 은 깨끗한 JSON 만 반환하도록 transcribe.py 가 보장한다.
function runTranscribe(input, { language, model, fillerMode }) {
  return new Promise((resolve, reject) => {
    const args = [
      path.join(__dirname, "transcribe.py"),
      "--input", input,
      "--language", language,
      "--model", model,
    ];
    if (fillerMode && fillerMode !== "off") {
      args.push("--filler-mode", fillerMode);
    }
    const py = spawn("python3", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    py.stdout.on("data", (d) => { stdout += d.toString(); });
    py.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    py.on("error", reject);
    py.on("exit", (code) => {
      if (code !== 0) {
        return reject(new Error(`transcribe exit ${code}: ${stderr.slice(-1500)}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`transcribe JSON parse error: ${e.message}; stderr=${stderr.slice(-500)}`));
      }
    });
  });
}
