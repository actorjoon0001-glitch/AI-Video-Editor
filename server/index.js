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
import { mkdir, unlink, stat, writeFile, truncate, open as openFile } from "fs/promises";
import { existsSync, statfsSync, createWriteStream, readFileSync } from "fs";
import { pipeline } from "stream/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { generateMetadata, metadataProvider } from "./metadata.js";
import { uploadVideo, youtubeConfigured, youtubeAllowsPublic, sanitizePrivacy } from "./youtube.js";
import { detectKeeps } from "./silence.js";
import { dropCache, startPageCacheJanitor } from "./pagecache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 8080;
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "https://ai-video-editor-good.netlify.app,http://localhost:8888,http://localhost:5173"
).split(",").map((s) => s.trim());

const TMP = process.env.TMP_DIR || "/tmp/aive";
await mkdir(TMP, { recursive: true });

// Python 인터프리터 절대 경로. Dockerfile 이 venv 를 /opt/venv 에 만들고
// 거기에 faster-whisper 를 설치하므로 시스템 python3 가 아니라 이 경로를 쓴다.
// Render 의 런타임 PATH 가 이미지 ENV 와 다르게 적용되는 케이스 회피용.
const PYTHON_BIN = process.env.PYTHON_BIN || "/opt/venv/bin/python3";

const RESULT_TTL_MS = 60 * 60 * 1000; // 결과 파일 1시간 후 삭제

// 업로드와 ffmpeg 가 만들어 내는 페이지 캐시를 주기적으로 커널에 돌려준다.
// 안 하면 컨테이너 메모리 사용량이 100% 에 붙고 플랫폼이 서비스를 재시작한다.
startPageCacheJanitor({ dir: TMP, pythonBin: PYTHON_BIN });

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

// 업로드 상한. 원본과 편집본이 디스크에 동시에 존재하므로 실제로는 이 값의
// 2배 이상 여유가 필요하다 — /api/health 의 limits 로 남은 용량을 노출한다.
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 500;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

const upload = multer({
  dest: TMP,
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

app.get("/", (req, res) => res.type("text/plain").send("AI Video Editor backend"));

// faster-whisper 가용성 — 서버 부팅 시점에 한 번 체크하고 캐시.
// 자막 작업이 실제로 돌 수 있는지 (백엔드 측의) 사전 검증 용도.
let whisperReady = null;        // null = 점검 전 / true = OK / false = 없음
let whisperError = null;        // 실패 시 stderr 일부

async function checkWhisperImport() {
  return new Promise((resolve) => {
    const py = spawn(PYTHON_BIN, [
      "-c",
      "from faster_whisper import WhisperModel; print('OK')",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    py.stdout.on("data", (d) => { stdout += d.toString(); });
    py.stderr.on("data", (d) => { stderr += d.toString(); });
    py.on("error", (e) => resolve({ ok: false, error: String(e?.message || e) }));
    py.on("exit", (code) => {
      if (code === 0 && stdout.includes("OK")) return resolve({ ok: true });
      resolve({ ok: false, error: (stderr || stdout || "exit " + code).slice(-1500) });
    });
  });
}

// 부팅 후 한 번 체크 — Render 시작 로그에 결과 기록.
checkWhisperImport().then((r) => {
  whisperReady = r.ok;
  whisperError = r.ok ? null : r.error;
  if (r.ok) console.log(`Whisper OK (PYTHON_BIN=${PYTHON_BIN})`);
  else console.error(`Whisper import failed (PYTHON_BIN=${PYTHON_BIN}):\n${r.error}`);
});

// 헬스체크. /healthz 는 인프라용, /api/health 는 프론트엔드가 라우트 가용성을
// 확인하기 위해 호출. routes 배열로 어떤 엔드포인트가 살아있는지 명시한다.
function healthBody() {
  return {
    ok: true,
    version: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || "unknown",
    pythonBin: PYTHON_BIN,
    whisper: whisperReady,
    whisperError: whisperReady === false ? (whisperError || "").slice(-500) : null,
    whisperModel: process.env.WHISPER_MODEL || "tiny",
    // 큐 모드 후속 stage 가용성 — 프론트가 옵션을 켤지 말지 판단하는 데 쓴다.
    metadataProvider: metadataProvider(),
    youtube: youtubeConfigured(),
    youtubeAllowsPublic: youtubeAllowsPublic(),
    // 업로드 상한을 올릴 수 있는지는 남은 디스크와 메모리가 정한다. 원본 + 편집본이
    // 동시에 올라가므로 파일 크기의 최소 2배가 필요하다.
    limits: diskAndMemory(),
    routes: [
      { method: "POST", path: "/api/process" },
      { method: "GET",  path: "/api/result/:id" },
      { method: "POST", path: "/api/transcribe" },
      { method: "POST", path: "/api/transcribe/jobs" },
      { method: "GET",  path: "/api/transcribe/jobs/:id" },
      { method: "POST", path: "/api/burn-subtitles" },
      { method: "POST", path: "/api/jobs" },
      { method: "POST", path: "/api/uploads" },
      { method: "PUT",  path: "/api/uploads/:id" },
      { method: "POST", path: "/api/uploads/:id/complete" },
      { method: "GET",  path: "/api/jobs/:id" },
      { method: "POST", path: "/api/jobs/:id/stages/:stage/retry" },
      { method: "POST", path: "/api/jobs/:id/subtitles" },
      { method: "GET",  path: "/api/jobs/:id/files/:name" },
      { method: "GET",  path: "/api/health" },
      { method: "GET",  path: "/healthz" },
    ],
    allowedOrigins: ALLOWED_ORIGINS,
  };
}
// 진단용 — 큰 파일을 받을 수 있는 환경인지 프론트/운영자가 판단할 수 있게.
function diskAndMemory() {
  const out = { maxUploadMb: Math.round(MAX_UPLOAD_BYTES / 1024 / 1024) };
  // 프로세스가 언제 시작됐는지. 업로드 도중 이 값이 작아지면 서버가 죽었다가
  // 다시 뜬 것이다 — 클라이언트에는 "Failed to fetch" 로만 보여서 구분이 안 된다.
  out.uptimeSec = Math.round(process.uptime());
  try {
    const m = process.memoryUsage();
    out.rssMb = Math.round(m.rss / 1024 / 1024);
    out.heapMb = Math.round(m.heapUsed / 1024 / 1024);
    out.externalMb = Math.round(m.external / 1024 / 1024);
  } catch {}
  out.activeUploads = uploads.size;
  try {
    const st = statfsSync(TMP);
    out.tmpFreeMb = Math.round((st.bavail * st.bsize) / 1024 / 1024);
    out.tmpTotalMb = Math.round((st.blocks * st.bsize) / 1024 / 1024);
  } catch (e) {
    out.diskError = String(e?.message || e).slice(0, 120);
  }
  try {
    out.totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
    out.freeMemMb = Math.round(os.freemem() / 1024 / 1024);
  } catch {}
  Object.assign(out, cgroupMemory());
  if (shutdownNote) out.shutdown = shutdownNote;
  return out;
}

// 종료 사유 기록. 프로세스가 사라진 뒤에는 아무것도 물어볼 수 없으므로,
// 사라지기 직전 상태를 여기에 담아 두고 남은 몇 초 동안 헬스체크로 내보낸다.
let shutdownNote = null;
function noteShutdown(note) {
  if (shutdownNote) return;   // 첫 번째 이유가 진짜 이유다
  shutdownNote = {
    ...note,
    uptimeSec: Math.round(process.uptime()),
    activeUploads: uploads.size,
    at: new Date().toISOString(),
    ...cgroupMemory(),
  };
}

// 컨테이너가 죽는 이유를 추측하지 않고 실제로 보기 위한 것.
//
// os.totalmem() 은 호스트 전체(60GB+)를 알려줘서 아무 쓸모가 없고, process RSS 는
// 커널이 우리 대신 들고 있는 페이지 캐시를 포함하지 않는다. 컨테이너 한도에
// 실제로 잡히는 값은 cgroup 의 memory.current 뿐이다. 그 안에서 anon(프로세스)
// 인지 file(페이지 캐시)인지까지 갈라 봐야 어디를 고칠지 알 수 있다.
const CG = "/sys/fs/cgroup";
const readNum = (p) => {
  const t = readFileSync(p, "utf8").trim();
  return t === "max" ? Infinity : Number(t);
};
const toMb = (b) => (Number.isFinite(b) ? Math.round(b / 1024 / 1024) : "max");
function cgroupMemory() {
  const out = {};
  try {
    // cgroup v2
    out.cgLimitMb = toMb(readNum(`${CG}/memory.max`));
    out.cgUsedMb = toMb(readNum(`${CG}/memory.current`));
    try { out.cgPeakMb = toMb(readNum(`${CG}/memory.peak`)); } catch {}
    const stat = Object.fromEntries(
      readFileSync(`${CG}/memory.stat`, "utf8").trim().split("\n").map((l) => l.split(" "))
    );
    out.cgAnonMb = toMb(Number(stat.anon));
    out.cgFileMb = toMb(Number(stat.file));          // 페이지 캐시 전체
    out.cgDirtyMb = toMb(Number(stat.file_dirty));   // 아직 디스크로 안 내려간 부분
    out.cgWritebackMb = toMb(Number(stat.file_writeback));
    const ev = Object.fromEntries(
      readFileSync(`${CG}/memory.events`, "utf8").trim().split("\n").map((l) => l.split(" "))
    );
    out.cgOomKill = Number(ev.oom_kill);
    out.cgMaxEvents = Number(ev.max);                // 한도에 부딪힌 횟수
  } catch {
    try {
      // cgroup v1 로 물러선다
      const base = `${CG}/memory`;
      out.cgLimitMb = toMb(readNum(`${base}/memory.limit_in_bytes`));
      out.cgUsedMb = toMb(readNum(`${base}/memory.usage_in_bytes`));
    } catch (e) {
      out.cgError = String(e?.message || e).slice(0, 120);
    }
  }
  return out;
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
      quality: QUALITY_SIZES[opts.quality] ? opts.quality : "1080p",
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
    const model = sanitizeModel(req.body.model || process.env.WHISPER_MODEL || "tiny");
    const fillerMode = sanitizeFillerMode(req.body.fillerMode);
    const glossary = sanitizeGlossary(req.body.glossary);
    console.log(`[${id}] transcribe: lang=${language} model=${model} fillerMode=${fillerMode}`);
    const t0 = Date.now();
    const result = await runTranscribe(inputPath, { language, model, fillerMode, glossary });
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

      // 자막 스타일. 큐 모드와 같은 UI 를 쓰므로 같은 빌더를 태운다. 없으면
      // sanitizeSubtitleStyle() 의 기본값(흰 글자 + 검은 외곽선)으로 떨어진다.
      let style;
      try { style = req.body.style ? JSON.parse(req.body.style) : null; } catch { style = null; }

      // libass 가 SRT 파일을 직접 읽도록 subtitles 필터 사용. 이스케이프된 절대 경로.
      const escapedSrt = srtPath.replace(/\\/g, "/").replace(/:/g, "\\:");
      const args = [
        "-i", videoPath,
        "-vf", `subtitles='${escapedSrt}':force_style='${buildForceStyle(style)}'`,
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

// ── /api/transcribe/jobs — 비동기 자막 작업 ─────────────────────────────────
// Render Free 의 응답 timeout(약 30~60초) 안에 small/base 모델로 5분 영상 자막을
// 끝낼 수 없는 케이스가 잦아 동기식 /api/transcribe 가 502 로 끊어짐.
// 작업을 등록만 하고 즉시 jobId 를 돌려준 뒤 백그라운드에서 transcribe 를 돌리고,
// 프론트가 GET /api/transcribe/jobs/:id 로 폴링한다.
//
// 메모리 저장 — Render Free 는 단일 인스턴스이므로 in-memory Map 으로 충분.
// 30분 후 GC.
const jobs = new Map(); // jobId → { status, result?, error?, ... }
const JOB_TTL_MS = 30 * 60 * 1000;
const JOB_GC_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    const finishedAt = job.completedAt || job.createdAt;
    if (finishedAt && now - finishedAt > JOB_TTL_MS) jobs.delete(id);
  }
}, JOB_GC_INTERVAL_MS).unref();

app.post("/api/transcribe/jobs", upload.single("video"), async (req, res) => {
  const id = randomUUID();
  const inputPath = req.file?.path;
  if (!inputPath) {
    return res.status(400).json({ error: "video file required" });
  }
  const language = sanitizeLang(req.body.language);
  const model = sanitizeModel(req.body.model || process.env.WHISPER_MODEL || "tiny");
  const fillerMode = sanitizeFillerMode(req.body.fillerMode);
  const glossary = sanitizeGlossary(req.body.glossary);

  jobs.set(id, {
    status: "pending",
    model, language, fillerMode, glossary,
    createdAt: Date.now(),
  });

  // 클라이언트에는 즉시 응답. 폴링용 URL 동봉.
  res.status(202).json({
    jobId: id,
    statusUrl: `/api/transcribe/jobs/${id}`,
    pollIntervalMs: 2500,
    estimatedSeconds: estimateTranscribeSeconds(model),
  });

  // 백그라운드 실행. 완료 후 입력 파일 정리.
  (async () => {
    const t0 = Date.now();
    jobs.set(id, { ...jobs.get(id), status: "running", startedAt: t0 });
    console.log(`[job ${id}] start: lang=${language} model=${model} fillerMode=${fillerMode}`);
    try {
      const result = await runTranscribe(inputPath, { language, model, fillerMode, glossary });
      const elapsed = Date.now() - t0;
      jobs.set(id, {
        ...jobs.get(id),
        status: "done",
        result: { ...result, durationMs: elapsed },
        completedAt: Date.now(),
      });
      console.log(`[job ${id}] done in ${(elapsed / 1000).toFixed(1)}s, ${result.segments?.length || 0} segments`);
    } catch (e) {
      console.error(`[job ${id}] failed:`, e);
      jobs.set(id, {
        ...jobs.get(id),
        status: "error",
        error: friendlyTranscribeError(e),
        completedAt: Date.now(),
      });
    } finally {
      try { await unlink(inputPath); } catch {}
    }
  })().catch((e) => {
    // (외부에서 잡히지 않도록 안전장치)
    console.error(`[job ${id}] dispatcher crash:`, e);
  });
});

app.get("/api/transcribe/jobs/:id", (req, res) => {
  const id = String(req.params.id).replace(/[^a-f0-9-]/gi, "");
  const job = jobs.get(id);
  if (!job) {
    return res.status(404).json({
      status: "not_found",
      error: "작업을 찾을 수 없거나 만료됐습니다 (30분 보관). 다시 시도해 주세요.",
    });
  }
  const base = {
    status: job.status,
    model: job.model,
    language: job.language,
  };
  if (job.status === "done") return res.json({ ...base, result: job.result });
  if (job.status === "error") return res.json({ ...base, error: job.error });
  // pending / running — 진행률은 알 수 없지만 경과 시간 정도는 노출.
  const startedAt = job.startedAt || job.createdAt;
  return res.json({ ...base, elapsedMs: Date.now() - startedAt });
});

// 모델별 대략의 실행 시간 (영상 길이 1초당 추가 초) — 프론트가 사용자 안내에 활용.
function estimateTranscribeSeconds(model) {
  return ({
    tiny: 0.4,
    base: 0.7,
    small: 1.4,
    medium: 3.0,
    large: 6.0,
    "large-v2": 6.5,
    "large-v3": 7.0,
  })[model] || 0.5;
}

// transcribe.py 가 OOM/timeout 등으로 실패한 경우 사용자에게 한국어 힌트.
function friendlyTranscribeError(e) {
  const raw = String(e?.message || e || "").slice(-1500);
  if (/OOM|out of memory|MemoryError|killed/i.test(raw)) {
    return "메모리 부족: 기본 모델 tiny 로 자동 폴백되어야 하지만 그래도 실패 — 영상이 너무 길거나 백엔드 RAM 부족.";
  }
  if (/timeout|ETIMEDOUT/i.test(raw)) {
    return "백엔드 timeout: 영상이 너무 길거나 cold start 가 길었습니다. 다시 시도해 주세요.";
  }
  if (/no module named|ImportError|faster.whisper/i.test(raw)) {
    return "백엔드에 faster-whisper 가 설치돼 있지 않습니다. Dockerfile 빌드 확인 필요.";
  }
  if (/exit (code )?137/i.test(raw)) {
    return "백엔드 프로세스가 OOM 으로 강제 종료됐습니다 (exit 137). 더 작은 모델 또는 더 짧은 영상 시도.";
  }
  return raw || "자막 생성 실패 (원인 불명).";
}

// ── /api/jobs — 다단계 작업 파이프라인 ──────────────────────────────────────
// 클라이언트는 영상 + 옵션만 올리면 백엔드가 edit / transcribe / burn /
// thumbnail / metadata / upload 를 순차 처리. 한 단계가 실패해도 비치명적
// 단계는 다음 단계로 진행 (partial success). GET 로 폴링, 단계별 retry 지원.

const STAGE_NAMES = ["edit", "transcribe", "burn", "thumbnail", "metadata", "upload"];

// 핵심 단계 — 실패하면 후속 stage 들 의미 없으니 전체 실패로.
const CRITICAL_STAGES = new Set(["edit"]);

// 개별 재시도를 받는 stage. edit 은 원본 업로드가 이미 지워져서, upload 는
// 중복 게시 위험 때문에 제외한다 (upload 는 실패했을 때만 아래에서 허용).
const RETRYABLE_STAGES = new Set(["transcribe", "burn", "thumbnail", "metadata"]);

const pipelineJobs = new Map();   // id → job state
const PIPELINE_JOB_TTL_MS = 60 * 60 * 1000; // 1h
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of pipelineJobs.entries()) {
    const t = job.completedAt || job.createdAt;
    if (now - t > PIPELINE_JOB_TTL_MS) {
      pipelineJobs.delete(id);
      // 산출물도 같이 정리
      for (const f of job.artifacts || []) {
        unlink(f).catch(() => {});
      }
    }
  }
}, 5 * 60 * 1000).unref();

function newPipelineJob(id, options) {
  const stages = {};
  for (const name of STAGE_NAMES) {
    stages[name] = { status: "queued" };
  }
  return {
    id,
    options,
    status: "queued",
    stages,
    artifacts: [],   // 정리할 임시 파일 경로 모음
    createdAt: Date.now(),
  };
}

function computeJobStatus(job) {
  const states = STAGE_NAMES.map((n) => job.stages[n].status);
  if (states.some((s) => s === "running" || s === "queued")) return "running";
  const failed = states.filter((s) => s === "failed").length;
  const done = states.filter((s) => s === "done").length;
  if (failed === 0) return "done";
  if (done === 0) return "failed";
  return "partial";
}

function jobResponse(job) {
  // url 등 외부 참조 가능 부분만 직렬화. internal path 는 숨김.
  const stages = {};
  for (const [name, s] of Object.entries(job.stages)) {
    const out = { status: s.status };
    if (s.error) out.error = s.error;
    if (s.note) out.note = s.note;
    if (s.progress) out.progress = s.progress;
    if (s.startedAt) out.startedAt = s.startedAt;
    if (s.completedAt) out.completedAt = s.completedAt;
    if (s.result) out.result = sanitizeStageResult(name, s.result);
    stages[name] = out;
  }
  return {
    jobId: job.id,
    status: computeJobStatus(job),
    options: job.options,
    stages,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  };
}

function sanitizeStageResult(name, result) {
  // 외부에 노출 가능한 필드만 골라서 반환. 디스크 path 같은 건 url 로만.
  if (name === "edit") {
    return {
      url: result.url,
      sizeBytes: result.sizeBytes,
      durationMs: result.durationMs,
    };
  }
  if (name === "transcribe") {
    return {
      srtUrl: result.srtUrl,
      vttUrl: result.vttUrl,
      segmentCount: result.segments?.length || 0,
      segments: result.segments || [],
      edited: result.edited === true,
      language: result.language,
      durationMs: result.durationMs,
      editPlan: result.editPlan || null,
    };
  }
  if (name === "thumbnail") {
    return { urls: result.urls };
  }
  if (name === "burn") {
    return {
      url: result.url,
      sizeBytes: result.sizeBytes,
      durationMs: result.durationMs,
    };
  }
  if (name === "metadata") {
    return {
      url: result.url,
      titles: result.titles,
      description: result.description,
      tags: result.tags,
      thumbnailCopy: result.thumbnailCopy,
      thumbnailSubcopy: result.thumbnailSubcopy,
      source: result.source,
      model: result.model,
    };
  }
  if (name === "upload") {
    return {
      videoId: result.videoId,
      url: result.url,
      privacyStatus: result.privacyStatus,
      publishAt: result.publishAt,
      title: result.title,
      thumbnailSet: result.thumbnailSet,
      thumbnailError: result.thumbnailError || null,
    };
  }
  return result;
}

app.post("/api/jobs", upload.single("video"), async (req, res) => {
  const id = randomUUID();
  const inputPath = req.file?.path;
  if (!inputPath) {
    return res.status(400).json({ error: "video file required" });
  }
  let options;
  try {
    options = JSON.parse(req.body.options || "{}");
  } catch {
    return res.status(400).json({ error: "invalid options JSON" });
  }
  const safeOpts = sanitizeJobOptions(options);
  const job = newPipelineJob(id, safeOpts);
  pipelineJobs.set(id, job);

  res.status(202).json({
    jobId: id,
    statusUrl: `/api/jobs/${id}`,
    pollIntervalMs: 3000,
  });

  // 백그라운드 실행
  runJobPipeline(id, inputPath).catch((e) => {
    console.error(`[job ${id}] dispatcher crash:`, e);
  });
});

// ── 청크 업로드 ─────────────────────────────────────────────────────────────
// 8GB 파일을 요청 하나로 올리면, 중간에 네트워크가 한 번만 끊겨도 처음부터 다시
// 해야 한다. 실제로 125MB 지점에서 연결이 끊겨 통째로 실패했다. 파일을 쪼개서
// 올리고 실패한 조각만 다시 보낸다.
//
// 조각은 순서대로 이어붙인다. 서버는 받은 바이트 수만 들고 있으면 되고, 클라이언트는
// 재개할 때 그 값을 물어봐서 그 지점부터 이어서 보낸다.
const uploads = new Map();  // id -> { path, received, total, createdAt, fh }
const UPLOAD_TTL_MS = 6 * 60 * 60 * 1000;

// 버려진 업로드 정리 — 안 하면 디스크가 조각 파일로 찬다.
setInterval(() => {
  const now = Date.now();
  for (const [id, u] of uploads) {
    if (now - u.updatedAt > UPLOAD_TTL_MS) {
      uploads.delete(id);
      unlink(u.path).catch(() => {});
      unlink(`${u.path}.json`).catch(() => {});
      console.log(`[upload ${id}] 만료 정리`);
    }
  }
}, 30 * 60 * 1000).unref();

app.post("/api/uploads", express.json({ limit: "1mb" }), async (req, res) => {
  const total = Number(req.body?.totalBytes) || 0;
  if (total <= 0) return res.status(400).json({ error: "totalBytes required" });
  if (total > MAX_UPLOAD_BYTES) {
    return res.status(413).json({
      error: `파일이 ${Math.round(total / 1024 / 1024)}MB 로 상한 ${MAX_UPLOAD_MB}MB 를 넘습니다.`,
    });
  }
  const id = randomUUID();
  const p = path.join(TMP, `${id}.upload`);
  // 빈 파일을 만들어 둔다 — 조각마다 createWriteStream(flags:"r+") 로 이어 쓴다.
  await writeFile(p, "");
  // 세션 정보를 디스크에도 남긴다. 메모리에만 두면 서버가 재시작할 때 8GB 를 거의
  // 다 올려놓고도 404 로 통째로 날린다 — 실제로 3520MB 지점에서 그렇게 잃었다.
  await writeFile(`${p}.json`, JSON.stringify({ total, createdAt: Date.now() }));
  uploads.set(id, { path: p, received: 0, total, writing: false, updatedAt: Date.now() });
  console.log(`[upload ${id}] 시작 — ${(total / 1024 / 1024).toFixed(1)}MB`);
  res.status(201).json({ uploadId: id, chunkSize: 16 * 1024 * 1024 });
});

// 메모리에 없으면 디스크에서 되살린다. 조각은 순서대로만 쓰고 실패 시 잘라내므로,
// 파일 크기가 곧 "받은 바이트" 다 — 별도 기록 없이 정확히 복구된다.
async function findUpload(id) {
  const inMem = uploads.get(id);
  if (inMem) return inMem;
  const p = path.join(TMP, `${id}.upload`);
  if (!existsSync(p) || !existsSync(`${p}.json`)) return null;
  try {
    const { readFile } = await import("fs/promises");
    const meta = JSON.parse(await readFile(`${p}.json`, "utf8"));
    const received = (await stat(p)).size;
    const u = { path: p, received, total: meta.total, writing: false, updatedAt: Date.now() };
    uploads.set(id, u);
    console.log(`[upload ${id}] 재시작 후 복구 — ${received} / ${meta.total} 바이트`);
    return u;
  } catch (e) {
    console.warn(`[upload ${id}] 복구 실패: ${e?.message || e}`);
    return null;
  }
}

// 재개용 — 클라이언트가 어디까지 갔는지 묻는다.
app.get("/api/uploads/:id", async (req, res) => {
  const u = await findUpload(String(req.params.id).replace(/[^a-f0-9-]/gi, ""));
  if (!u) return res.status(404).json({ error: "업로드 세션을 찾을 수 없습니다." });
  res.json({ received: u.received, total: u.total });
});

// 조각 append. offset 을 함께 받아, 중복 전송(재시도)이면 조용히 무시한다.
//
// 요청 본문을 파일로 바로 흘려보낸다 (express.raw 로 받지 않는다). 예전엔
// express.raw 로 16MB 를 통째로 메모리에 담은 뒤 파일에 썼는데, 컨테이너 메모리가
// 2GB 인 Render 에서 1~2GB 쯤 올리면 서버가 죽었다 (클라이언트에는 502 / "Failed
// to fetch" 로만 보인다). Node 는 컨테이너 한도가 아니라 호스트 메모리(31GB)를
// 보고 GC 를 게을리하기 때문에 더 잘 터진다. 스트리밍으로 쓰면 상주 메모리가
// 조각 크기와 무관하게 소켓 버퍼 몇 개 수준으로 유지된다.
app.put("/api/uploads/:id", async (req, res) => {
  const id = String(req.params.id).replace(/[^a-f0-9-]/gi, "");
  const u = await findUpload(id);
  if (!u) {
    req.resume();
    return res.status(404).json({ error: "업로드 세션을 찾을 수 없습니다." });
  }
  const offset = Number(req.query.offset);
  if (!Number.isFinite(offset) || offset < 0) {
    return res.status(400).json({ error: "offset required" });
  }
  // 이미 받은 지점이면 재시도로 보고 성공 처리 — 클라이언트가 응답을 못 받고
  // 다시 보낸 경우다. 여기서 400 을 주면 정상 재시도가 실패로 끝난다.
  if (offset < u.received) {
    req.resume();          // 본문을 버려야 소켓이 막히지 않는다
    return res.json({ received: u.received, total: u.total });
  }
  if (offset > u.received) {
    req.resume();
    return res.status(409).json({ error: "offset 불일치", received: u.received });
  }
  if (u.writing) {
    req.resume();
    return res.status(409).json({ error: "같은 세션에 동시 쓰기", received: u.received });
  }

  u.writing = true;
  const startAt = u.received;
  let written = 0;
  let ws;
  let closed = Promise.resolve();
  try {
    ws = createWriteStream(u.path, { flags: "r+", start: startAt });
    // close 리스너는 생성 직후 한 번만 건다. 나중에 걸면 이미 지나간 이벤트를
    // 기다리다 타임아웃까지 락을 붙잡고, 다음 조각이 계속 409 를 받는다.
    closed = new Promise((r) => ws.once("close", r));
    req.on("data", (d) => {
      written += d.length;
      // 선언한 크기를 넘기면 즉시 끊는다 — 안 그러면 디스크가 무한정 찬다.
      if (startAt + written > u.total) req.destroy(new Error("선언한 크기를 초과했습니다."));
    });
    await pipeline(req, ws);
    if (written === 0) return res.status(400).json({ error: "빈 조각" });

    // 조각마다 디스크로 강제로 밀어낸다.
    //
    // 안 하면 커널이 쓴 데이터를 "더티 페이지"로 메모리에 쌓아두는데, 컨테이너
    // 환경에서는 그것도 메모리 한도에 포함된다. 프로세스 RSS 는 96MB 로 멀쩡한데
    // 컨테이너가 통째로 죽는 일이 실제로 벌어졌다 (3GB 업로드 중 2976MB 지점,
    // 502 + 재시작). 더티 페이지는 회수할 수 없어서 OOM 을 부르지만, 한 번
    // 디스크에 내려간 페이지는 커널이 필요할 때 그냥 버릴 수 있다.
    //
    // 16MB fsync 는 수십~수백 ms — 조각 하나 전송 시간(수 초)에 비하면 무시할 만하다.
    const fh = await openFile(u.path, "r+");
    try { await fh.datasync(); } finally { await fh.close(); }
    // 디스크에 내려갔으면 캐시에 붙들고 있을 이유가 없다. 이걸 안 하면 올린
    // 만큼 그대로 컨테이너 메모리로 잡혀서 3GB 즈음 100% 에 붙는다.
    await dropCache(u.path, { pythonBin: PYTHON_BIN });

    u.received = startAt + written;
    u.updatedAt = Date.now();
    res.json({ received: u.received, total: u.total });
  } catch (e) {
    console.warn(`[upload ${id}] 조각 실패 @${startAt}: ${e?.message || e}`);
    // 끊긴 쓰기는 일부 바이트를 이미 디스크에 남긴다. 그대로 두고 클라이언트가
    // 같은 offset 부터 덮어쓰게 하면, 아직 빠져나가지 못한 이전 쓰기가 새 쓰기
    // *뒤에* 착지할 수 있다 — 크기는 맞는데 내용이 깨진 파일이 나온다. 실제로
    // md5 가 달라지는 걸 확인했다. 받은 지점까지 잘라내 항상 깨끗한 상태로
    // 되돌린다.
    try {
      ws?.destroy();
      await Promise.race([closed, new Promise((r) => setTimeout(r, 2000).unref?.())]);
      await truncate(u.path, u.received);
    } catch (te) {
      console.error(`[upload ${id}] 되감기 실패: ${te?.message || te}`);
    }
    if (!res.headersSent) {
      res.status(500).json({ error: `조각 기록 실패: ${e?.message || e}`, received: u.received });
    }
  } finally {
    // 스트림이 완전히 닫힌 뒤에야 다음 쓰기를 허용한다. 먼저 풀면 다음 조각의
    // 쓰기와 아직 빠져나가지 못한 이전 쓰기가 같은 구간에서 겹친다.
    ws?.destroy();
    await Promise.race([closed, new Promise((r) => setTimeout(r, 2000).unref?.())]);
    u.writing = false;
  }
});

// 조립 완료 → 기존 작업 파이프라인으로 넘긴다.
app.post("/api/uploads/:id/complete", express.json({ limit: "4mb" }), async (req, res) => {
  const uploadId = String(req.params.id).replace(/[^a-f0-9-]/gi, "");
  const u = await findUpload(uploadId);
  if (!u) return res.status(404).json({ error: "업로드 세션을 찾을 수 없습니다." });
  if (u.received !== u.total) {
    return res.status(400).json({
      error: `업로드가 끝나지 않았습니다 (${u.received} / ${u.total} 바이트).`,
      received: u.received,
    });
  }
  uploads.delete(uploadId);
  unlink(`${u.path}.json`).catch(() => {});

  const id = randomUUID();
  const safeOpts = sanitizeJobOptions(req.body?.options || {});
  const job = newPipelineJob(id, safeOpts);
  pipelineJobs.set(id, job);
  console.log(`[upload ${uploadId}] 완료 → job ${id} (${(u.total / 1024 / 1024).toFixed(1)}MB)`);

  res.status(202).json({ jobId: id, statusUrl: `/api/jobs/${id}`, pollIntervalMs: 3000 });

  runJobPipeline(id, u.path).catch((e) => {
    console.error(`[job ${id}] dispatcher crash:`, e);
  });
});

app.get("/api/jobs/:id", (req, res) => {
  const id = String(req.params.id).replace(/[^a-f0-9-]/gi, "");
  const job = pipelineJobs.get(id);
  if (!job) {
    return res.status(404).json({
      error: "작업을 찾을 수 없거나 만료됐습니다 (1시간 보관). 다시 업로드해 주세요.",
    });
  }
  res.json(jobResponse(job));
});

app.post("/api/jobs/:id/stages/:stage/retry", async (req, res) => {
  const id = String(req.params.id).replace(/[^a-f0-9-]/gi, "");
  const stage = String(req.params.stage);
  const job = pipelineJobs.get(id);
  if (!job) return res.status(404).json({ error: "job not found" });
  if (!STAGE_NAMES.includes(stage)) return res.status(400).json({ error: "unknown stage" });

  // upload 는 재시도가 중복 게시로 이어질 수 있어 "실패했을 때만" 허용.
  const retryable =
    RETRYABLE_STAGES.has(stage) ||
    (stage === "upload" && job.stages.upload?.status === "failed");
  if (!retryable) {
    return res.status(400).json({
      error:
        stage === "edit"
          ? "edit 은 원본 업로드가 이미 정리돼 재시도할 수 없습니다. 다시 업로드해 주세요."
          : `${stage} 단계는 재시도할 수 없습니다.`,
    });
  }

  // edit 결과 파일이 있어야 후속 stage 재시도 가능
  if (job.stages.edit?.status !== "done") {
    return res.status(400).json({ error: "edit stage 가 done 이어야 후속 stage 재시도 가능" });
  }

  job.stages[stage] = { status: "queued" };
  res.status(202).json({ ok: true, statusUrl: `/api/jobs/${id}` });

  // 백그라운드: 단일 stage 만 재실행
  retryJobStage(id, stage).catch((e) => console.error(`[job ${id}] retry crash:`, e));
});

// 교정한 자막을 되돌려 받는다. 프론트에서 오타를 고친 뒤 이걸 호출하면
// 디스크의 SRT/VTT 가 교체되고, 이어서 burn stage 를 retry 하면 고친 자막으로
// 다시 구워진다. 다운로드 버튼도 같은 파일을 가리키므로 함께 갱신된다.
app.post("/api/jobs/:id/subtitles", express.json({ limit: "4mb" }), async (req, res) => {
  const id = String(req.params.id).replace(/[^a-f0-9-]/gi, "");
  const job = pipelineJobs.get(id);
  if (!job) return res.status(404).json({ error: "job not found" });

  const srt = typeof req.body?.srt === "string" ? req.body.srt : null;
  const vtt = typeof req.body?.vtt === "string" ? req.body.vtt : null;
  if (!srt || !vtt) return res.status(400).json({ error: "srt 와 vtt 문자열이 모두 필요합니다." });

  const stage = job.stages.transcribe;
  if (stage?.status !== "done" || !stage.result) {
    return res.status(400).json({ error: "자막 단계가 완료된 작업에만 적용할 수 있습니다." });
  }

  const srtPath = path.join(TMP, `${id}.subtitles.srt`);
  const vttPath = path.join(TMP, `${id}.subtitles.vtt`);
  await writeFile(srtPath, srt, "utf8");
  await writeFile(vttPath, vtt, "utf8");

  stage.result.srt = srt;
  stage.result.vtt = vtt;
  if (Array.isArray(req.body.segments)) {
    stage.result.segments = req.body.segments
      .filter((x) => x && typeof x.text === "string")
      .map((x) => ({ start: Number(x.start) || 0, end: Number(x.end) || 0, text: x.text }));
  }
  stage.result.edited = true;

  console.log(`[job ${id}] 자막 교정본 적용 (${srt.length} chars)`);
  res.json({ ok: true, segmentCount: stage.result.segments?.length || 0 });
});

app.get("/api/jobs/:id/files/:name", (req, res) => {
  const id = String(req.params.id).replace(/[^a-f0-9-]/gi, "");
  const name = String(req.params.name).replace(/[^a-zA-Z0-9._-]/g, "");
  const job = pipelineJobs.get(id);
  if (!job) return res.status(404).json({ error: "job not found" });
  const file = path.join(TMP, `${id}.${name}`);
  if (!existsSync(file)) return res.status(404).json({ error: "file not found" });
  res.sendFile(file);
});

function sanitizeJobOptions(opts) {
  const keeps = Array.isArray(opts.keeps) ? opts.keeps : [];
  return {
    keeps: keeps.map((k) => ({
      start: Math.max(0, Number(k.start) || 0),
      end: Math.max(0, Number(k.end) || 0),
    })).filter((k) => k.end > k.start),
    ratio: ["16:9", "9:16", "1:1"].includes(opts.ratio) ? opts.ratio : "16:9",
    quality: QUALITY_SIZES[opts.quality] ? opts.quality : "1080p",
    speed: clamp(Number(opts.speed) || 1.0, 0.5, 2.0),
    loudnorm: opts.loudnorm !== false,
    transcribe: opts.transcribe !== false,
    thumbnails: opts.thumbnails !== false,
    thumbnailCount: clamp(parseInt(opts.thumbnailCount, 10) || 6, 1, 12),
    language: sanitizeLang(opts.language),
    model: sanitizeModel(opts.model),
    fillerMode: sanitizeFillerMode(opts.fillerMode),
    glossary: sanitizeGlossary(opts.glossary),
    subtitleStyle: sanitizeSubtitleStyle(opts.subtitleStyle),
    // keeps 를 안 보내면 서버가 무음을 직접 찾는다. 그때 쓰는 파라미터.
    sourceDuration: Math.max(0, Number(opts.sourceDuration) || 0),
    noiseDb: opts.noiseDb == null ? null : clamp(Number(opts.noiseDb) || -32, -60, -10),
    minSilence: clamp(Number(opts.minSilence) || 0.6, 0.1, 5),
    padding: clamp(Number(opts.padding) || 0.1, 0, 1),
    // 후속 stage 옵션 — 모두 명시적 opt-in.
    burn: opts.burn === true,
    metadata: opts.metadata === true,
    metadataPersona: String(opts.metadataPersona || "").slice(0, 500),
    upload: opts.upload === true,
    privacy: sanitizePrivacy(opts.privacy),
    publishAt: sanitizePublishAt(opts.publishAt),
  };
}

// ISO 8601 예약 게시 시각. 과거이거나 형식이 틀리면 무시 (즉시 게시).
function sanitizePublishAt(v) {
  if (!v) return null;
  const t = Date.parse(String(v));
  if (!Number.isFinite(t) || t <= Date.now()) return null;
  return new Date(t).toISOString();
}

async function runJobPipeline(id, inputPath) {
  const job = pipelineJobs.get(id);
  if (!job) return;
  job.status = "running";
  job.startedAt = Date.now();

  const editedPath = path.join(TMP, `${id}.edited.mp4`);
  job.artifacts.push(editedPath);

  // ── detect ── keeps 를 안 받았으면 서버가 직접 무음을 찾는다.
  // 브라우저는 분석하려면 파일 전체를 메모리에 올려야 해서 큰 파일에서 죽는다.
  // 여기서는 ffmpeg 가 오디오만 스트리밍으로 흘려주므로 길이·크기 제한이 없다.
  if (job.options.keeps.length === 0) {
    await runStage(job, "detect", async () => {
      const t0 = Date.now();
      const r = await detectKeeps(inputPath, job.options.sourceDuration, {
        noiseDb: job.options.noiseDb,
        minSilence: job.options.minSilence,
        padding: job.options.padding,
      });
      if (r.keeps.length === 0) {
        throw new Error("남길 구간이 없습니다. 영상 전체가 무음으로 판정됐습니다.");
      }
      job.options.keeps = r.keeps;
      return {
        keeps: r.keeps,
        duration: r.duration,
        stats: r.stats,
        waveform: r.waveform,
        durationMs: Date.now() - t0,
      };
    });
  }

  // ── edit ──
  await runStage(job, "edit", async () => {
    if (job.options.keeps.length === 0) {
      throw new Error("keeps 가 비어 있습니다 — 무음 감지 단계가 먼저 성공해야 합니다.");
    }
    const t0 = Date.now();
    // 예상 출력 길이 = 남긴 구간 합 / 속도. 진행률(%) 계산 기준.
    const keptSec = job.options.keeps.reduce((s, k) => s + (k.end - k.start), 0);
    const expectedSec = keptSec / (job.options.speed || 1);
    job.stages.edit.progress = { outTimeSec: 0, totalSec: expectedSec, pct: 0 };

    await processVideo(inputPath, editedPath, job.options, {
      // 5분 동안 ffmpeg 가 진행 신호를 하나도 못 내면 멎은 것으로 보고 중단한다.
      // 이게 없으면 프론트가 30분 타임아웃까지 "running" 만 보고 있게 된다.
      timeoutMs: 5 * 60 * 1000,
      onProgress: ({ outTimeSec }) => {
        const pct = expectedSec > 0
          ? Math.min(99, Math.round((outTimeSec / expectedSec) * 100))
          : 0;
        job.stages.edit.progress = { outTimeSec, totalSec: expectedSec, pct };
      },
    });
    const sizeBytes = (await stat(editedPath)).size;
    return {
      _path: editedPath,
      url: `/api/jobs/${id}/files/edited.mp4`,
      sizeBytes,
      durationMs: Date.now() - t0,
    };
  });

  if (job.stages.edit.status !== "done") {
    // edit 이 죽으면 후속 stage 는 입력 자체가 없다. queued 로 남겨두면 job 이
    // 영원히 running 으로 보이므로 명시적으로 skipped 처리한다.
    for (const name of STAGE_NAMES) {
      if (name !== "edit") {
        job.stages[name] = { status: "skipped", note: "편집 단계 실패로 중단" };
      }
    }
    job.status = computeJobStatus(job);
    job.completedAt = Date.now();
    try { await unlink(inputPath); } catch {}
    return;
  }

  // 입력 원본 정리. 이후 stage 들은 editedPath 만 본다.
  try { await unlink(inputPath); } catch {}

  // ── transcribe ── (비치명적)
  if (job.options.transcribe) {
    await runStage(job, "transcribe", () => transcribeStageFor(job, editedPath));
  } else {
    job.stages.transcribe = { status: "skipped", note: "옵션 OFF" };
  }

  // ── burn ── (비치명적) 자막 SRT 가 있어야 의미가 있다.
  await runOptionalStage(job, "burn", () => burnStageFor(job, editedPath));

  // ── thumbnail ── (비치명적)
  if (job.options.thumbnails) {
    await runStage(job, "thumbnail", () => thumbnailStageFor(job, editedPath));
  } else {
    job.stages.thumbnail = { status: "skipped", note: "옵션 OFF" };
  }

  // ── metadata ── (비치명적) 전사 결과에서 제목/설명/태그 생성.
  await runOptionalStage(job, "metadata", () => metadataStageFor(job));

  // ── upload ── (비치명적) 명시적 opt-in + 자격 증명이 있을 때만.
  await runOptionalStage(job, "upload", () => uploadStageFor(job, editedPath));

  job.status = computeJobStatus(job);
  job.completedAt = Date.now();
  console.log(`[job ${id}] complete: ${job.status}`);
}

// 선행 조건을 먼저 확인해서, 못 도는 stage 는 "왜 건너뛰었는지"를 남기고
// skipped 로 끝낸다 (실패가 아니라 미실행이라는 걸 UI 가 구분할 수 있게).
async function runOptionalStage(job, name, fn) {
  const skip = stageSkipReason(job, name);
  if (skip) {
    job.stages[name] = { status: "skipped", note: skip };
    return;
  }
  await runStage(job, name, fn);
}

function stageSkipReason(job, name) {
  const o = job.options;
  if (name === "burn") {
    if (!o.burn) return "옵션 OFF";
    if (job.stages.transcribe?.status !== "done") return "자막 단계가 성공해야 번인 가능";
    if (!job.stages.transcribe.result?.srt) return "SRT 자막이 비어 있음";
    return null;
  }
  if (name === "metadata") {
    if (!o.metadata) return "옵션 OFF";
    if (job.stages.transcribe?.status !== "done") return "자막 단계가 성공해야 메타데이터 생성 가능";
    if (!(job.stages.transcribe.result?.segments?.length > 0)) return "자막 세그먼트가 비어 있음";
    return null;
  }
  if (name === "upload") {
    if (!o.upload) return "옵션 OFF";
    if (!youtubeConfigured()) return "서버에 YouTube 자격 증명(YOUTUBE_*)이 없음";
    if (!uploadTitleFor(job)) return "제목이 없음 — 메타데이터 단계가 성공해야 업로드 가능";
    return null;
  }
  return null;
}

async function retryJobStage(id, stage) {
  const job = pipelineJobs.get(id);
  if (!job) return;
  const editedPath = path.join(TMP, `${id}.edited.mp4`);
  if (stage === "transcribe") {
    await runStage(job, "transcribe", () => transcribeStageFor(job, editedPath));
  } else if (stage === "thumbnail") {
    await runStage(job, "thumbnail", () => thumbnailStageFor(job, editedPath));
  } else if (stage === "burn") {
    await runOptionalStage(job, "burn", () => burnStageFor(job, editedPath));
  } else if (stage === "metadata") {
    await runOptionalStage(job, "metadata", () => metadataStageFor(job));
  } else if (stage === "upload") {
    await runOptionalStage(job, "upload", () => uploadStageFor(job, editedPath));
  }
  job.status = computeJobStatus(job);
}

async function runStage(job, name, fn) {
  const t0 = Date.now();
  job.stages[name] = { status: "running", startedAt: t0 };
  try {
    const result = await fn();
    job.stages[name] = {
      status: "done",
      result,
      startedAt: t0,
      completedAt: Date.now(),
    };
    console.log(`[job ${job.id}] stage ${name} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.error(`[job ${job.id}] stage ${name} failed:`, e);
    job.stages[name] = {
      status: "failed",
      error: friendlyTranscribeError(e),
      startedAt: t0,
      completedAt: Date.now(),
    };
  }
}

async function transcribeStageFor(job, editedPath) {
  const stage = job.stages.transcribe;
  if (stage) stage.progress = { phase: "model_load", pct: 0 };
  const t0 = Date.now();
  const result = await runTranscribe(editedPath, {
    language: job.options.language,
    model: job.options.model,
    fillerMode: job.options.fillerMode,
    glossary: job.options.glossary,
    onProgress: (p) => {
      if (!stage) return;
      if (p.phase === "progress" && p.total > 0) {
        stage.progress = {
          phase: "progress",
          outTimeSec: p.done,
          totalSec: p.total,
          pct: Math.min(99, Math.round((p.done / p.total) * 100)),
        };
      } else {
        // model_load / model_ready / transcribe_start — 퍼센트는 없지만
        // "모델 받는 중"인지 "전사 중"인지는 알려줄 수 있다.
        stage.progress = { phase: p.phase, pct: 0, totalSec: p.total || 0 };
      }
    },
  });
  // SRT/VTT 를 디스크에 떨어뜨리고 url 로 노출
  const srtPath = path.join(TMP, `${job.id}.subtitles.srt`);
  const vttPath = path.join(TMP, `${job.id}.subtitles.vtt`);
  const { writeFile } = await import("fs/promises");
  if (result.srt) await writeFile(srtPath, result.srt, "utf8");
  if (result.vtt) await writeFile(vttPath, result.vtt, "utf8");
  job.artifacts.push(srtPath, vttPath);
  return {
    ...result,
    // transcribe.py 는 소요시간을 모른다. HTTP 엔드포인트 쪽은 각자 재던
    // durationMs 를 큐 파이프라인에서는 아무도 안 넣어서 항상 0.0s 로 찍혔다.
    durationMs: Date.now() - t0,
    srtUrl: result.srt ? `/api/jobs/${job.id}/files/subtitles.srt` : null,
    vttUrl: result.vtt ? `/api/jobs/${job.id}/files/subtitles.vtt` : null,
  };
}

async function thumbnailStageFor(job, editedPath) {
  const count = job.options.thumbnailCount || 6;
  // 영상 길이를 빠르게 ffprobe 로 (ffmpeg 호출 파싱 대신 ffprobe 정확).
  const dur = await probeDurationSec(editedPath);
  const urls = [];
  for (let i = 0; i < count; i++) {
    // 시작/끝 10% 회피 후 균등 분포
    const t = dur * 0.1 + (dur * 0.8 * (i + 0.5) / count);
    const out = path.join(TMP, `${job.id}.thumb_${i}.jpg`);
    await runFFmpeg([
      "-ss", t.toFixed(2),
      "-i", editedPath,
      "-frames:v", "1",
      "-q:v", "3",
      "-vf", "scale=480:-2",
      "-y", out,
    ]);
    job.artifacts.push(out);
    urls.push(`/api/jobs/${job.id}/files/thumb_${i}.jpg`);
  }
  return { urls };
}

// SRT 를 편집본에 영구 합성. /api/burn-subtitles 와 같은 libass 필터를 쓰되,
// 파일이 이미 디스크에 있으므로 업로드/다운로드 왕복이 없다.

// ── 자막 번인 스타일 ────────────────────────────────────────────────────────
// libass 의 force_style 문자열을 만든다. 색은 ASS 규격이라 &HAABBGGRR (BGR 순서,
// AA 는 "투명도"가 아니라 alpha 의 반대 — 00 이 불투명, FF 가 완전 투명) 이다.
// 흔히 틀리는 부분이라 여기서 한 번에 변환한다.
const SUBTITLE_FONT = process.env.SUBTITLE_FONT || "NanumGothic";

// ffmpeg 이 SRT 를 ASS 로 바꿀 때 스크립트 해상도를 항상 384x288 로 박아 넣는다
// (probe: "PlayResX: 384 / PlayResY: 288"). 그래서 FontSize/MarginV/Outline 은
// 픽셀이 아니라 288 높이 기준 단위다 — FontSize=48 을 그대로 주면 1080p 에서
// 180px 짜리 글자가 나와 화면을 잡아먹는다. UI 는 "1080p 픽셀"로 받고 여기서
// 한 번만 환산한다.
const ASS_PLAY_RES_Y = 288;
const pxToAss = (px) => Math.max(0, (Number(px) || 0) * (ASS_PLAY_RES_Y / 1080));

function assColour(hex, alphaPct = 100) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  const rgb = m ? m[1] : "ffffff";
  const r = rgb.slice(0, 2), g = rgb.slice(2, 4), b = rgb.slice(4, 6);
  const a = Math.round((1 - clamp(Number(alphaPct) / 100, 0, 1)) * 255)
    .toString(16).padStart(2, "0");
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

function sanitizeSubtitleStyle(v) {
  const o = v && typeof v === "object" ? v : {};
  return {
    // 아래 값들은 전부 "1080p 기준 픽셀". 환산은 buildForceStyle() 에서 한다.
    fontSize: clamp(parseInt(o.fontSize, 10) || 54, 16, 200),
    color: /^#?[0-9a-f]{6}$/i.test(o.color || "") ? o.color : "#ffffff",
    // "outline" = 글자 외곽선만 / "box" = 반투명 배경 박스
    background: o.background === "box" ? "box" : "outline",
    boxColor: /^#?[0-9a-f]{6}$/i.test(o.boxColor || "") ? o.boxColor : "#000000",
    boxOpacity: clamp(parseInt(o.boxOpacity, 10) || 60, 0, 100),
    outline: clamp(Number(o.outline) || 6, 0, 24),
    marginV: clamp(parseInt(o.marginV, 10) || 60, 0, 500),
    bold: o.bold === true,
  };
}

function buildForceStyle(style) {
  const st = sanitizeSubtitleStyle(style);
  const parts = [
    `FontName=${SUBTITLE_FONT}`,
    `FontSize=${pxToAss(st.fontSize).toFixed(1)}`,
    `PrimaryColour=${assColour(st.color, 100)}`,
    `Bold=${st.bold ? -1 : 0}`,
    `MarginV=${Math.round(pxToAss(st.marginV))}`,
    "Shadow=0",
  ];
  if (st.background === "box") {
    // BorderStyle=3(불투명 박스)에서 libass 는 박스를 BackColour 가 아니라
    // OutlineColour 로 칠한다. BackColour 만 지정하면 사용자가 무슨 색을 골라도
    // 항상 기본값(검정)으로 나온다 — 실제로 빨강/파랑을 넣어 렌더해 확인했다.
    // 다른 렌더러 호환을 위해 둘 다 같은 값으로 채운다. Outline 은 박스 여백.
    const box = assColour(st.boxColor, st.boxOpacity);
    // Outline 은 여기서 박스 안쪽 여백 — 1080p 기준 10px 정도가 보기 좋다.
    parts.push("BorderStyle=3", `OutlineColour=${box}`, `BackColour=${box}`,
      `Outline=${pxToAss(10).toFixed(1)}`);
  } else {
    parts.push("BorderStyle=1", "OutlineColour=&H00000000",
      `Outline=${pxToAss(st.outline).toFixed(1)}`);
  }
  return parts.join(",");
}

async function burnStageFor(job, editedPath) {
  const srtPath = path.join(TMP, `${job.id}.subtitles.srt`);
  if (!existsSync(srtPath)) {
    throw new Error("자막 SRT 파일을 찾을 수 없습니다. 자막 단계를 다시 시도해 주세요.");
  }
  const out = path.join(TMP, `${job.id}.burned.mp4`);
  job.artifacts.push(out);

  const escapedSrt = srtPath.replace(/\\/g, "/").replace(/:/g, "\\:");
  const t0 = Date.now();
  await runFFmpeg([
    "-i", editedPath,
    "-vf", `subtitles='${escapedSrt}':force_style='${buildForceStyle(job.options.subtitleStyle)}'`,
    "-c:v", "libx264", "-preset", "veryfast",
    "-crf", String(QUALITY_CRF[job.options.quality] ?? 20),
    "-c:a", "copy",
    "-movflags", "+faststart",
    "-y", out,
  ]);
  return {
    _path: out,
    url: `/api/jobs/${job.id}/files/burned.mp4`,
    sizeBytes: (await stat(out)).size,
    durationMs: Date.now() - t0,
  };
}

// 전사 세그먼트 → 제목 후보 / 설명 / 태그 / 썸네일 카피.
async function metadataStageFor(job) {
  const segments = job.stages.transcribe?.result?.segments || [];
  const meta = await generateMetadata(segments, { persona: job.options.metadataPersona });
  const metaPath = path.join(TMP, `${job.id}.metadata.json`);
  await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
  job.artifacts.push(metaPath);
  return { ...meta, url: `/api/jobs/${job.id}/files/metadata.json` };
}

// YouTube 업로드. 자막 번인본이 있으면 그쪽을 올린다 (사용자가 번인을 요청한
// 이상 그게 최종 산출물이므로).
async function uploadStageFor(job, editedPath) {
  const burned = job.stages.burn?.status === "done" ? job.stages.burn.result?._path : null;
  const videoPath = burned && existsSync(burned) ? burned : editedPath;
  const meta = job.stages.metadata?.result || {};
  const thumb = job.stages.thumbnail?.status === "done"
    ? path.join(TMP, `${job.id}.thumb_0.jpg`)
    : null;

  return uploadVideo({
    videoPath,
    title: uploadTitleFor(job),
    description: meta.description || "",
    tags: meta.tags || [],
    privacy: job.options.privacy,
    publishAtIso: job.options.publishAt,
    thumbnailPath: thumb && existsSync(thumb) ? thumb : null,
    onProgress: ({ uploaded, total }) => {
      console.log(`[job ${job.id}] upload ${((uploaded / total) * 100).toFixed(0)}%`);
    },
  });
}

function uploadTitleFor(job) {
  const titles = job.stages.metadata?.status === "done"
    ? job.stages.metadata.result?.titles
    : null;
  return titles?.length ? titles[0] : null;
}

function probeDurationSec(file) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      file,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d.toString(); });
    p.stderr.on("data", (d) => { stderr += d.toString(); });
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code === 0) resolve(parseFloat(stdout.trim()) || 0);
      else reject(new Error(`ffprobe exit ${code}: ${stderr.slice(-200)}`));
    });
  });
}

const server = app.listen(PORT, () => {
  console.log(`AI Video Editor backend listening on :${PORT}`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
});

// 컨테이너에서 node 가 PID 1 로 뜨면 커널이 기본 시그널 동작을 걸어주지 않는다.
// 즉 핸들러를 직접 등록하지 않으면 SIGTERM 이 무시되고, 배포 때마다 Render 가
// 유예 시간 뒤 SIGKILL 로 강제 종료하게 된다 (진행 중이던 응답이 그냥 끊김).
//
// 종료 이유는 반드시 남긴다. 업로드 도중 컨테이너가 사라지는 일이 반복되는데,
// 밖에서 보이는 건 502 와 초기화된 uptime 뿐이라 원인을 구분할 수 없었다.
// 신호를 받았다면 플랫폼이 내린 결정이고, 예외로 죽었다면 우리 코드가 문제다.
// 둘을 갈라야 고칠 데를 안다. 죽기 전에 그 사실을 헬스체크로 내보내려면 잠깐
// 더 살아 있어야 하므로, 업로드가 진행 중일 때는 유예 시간을 길게 잡는다.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    noteShutdown({ kind: "signal", detail: sig });
    console.log(`${sig} 수신 (uptime ${Math.round(process.uptime())}s, 업로드 ${uploads.size}건) — 종료합니다.`);
    // 바로 server.close() 를 부르면 헬스체크도 함께 닫혀서, 왜 죽었는지 물어볼
    // 창구가 사라진다. 이유를 알릴 몇 초를 벌고 나서 닫는다.
    setTimeout(() => {
      server.close(() => process.exit(0));
      setTimeout(() => {
        console.log("유예 시간 초과 — 강제 종료합니다.");
        process.exit(0);
      }, uploads.size > 0 ? 20_000 : 10_000).unref();
    }, 6_000).unref();
  });
}

// 잡히지 않은 예외로 죽는 경우. 기본 동작은 스택을 찍고 즉시 종료라서, 밖에서는
// 신호로 죽은 것과 구분이 안 된다. 이유를 남기고 조금 늦게 종료한다.
process.on("uncaughtException", (e) => {
  noteShutdown({ kind: "uncaughtException", detail: `${e?.message || e}`, stack: (e?.stack || "").slice(0, 800) });
  console.error(`[치명] 잡히지 않은 예외 (uptime ${Math.round(process.uptime())}s):`, e);
  setTimeout(() => process.exit(1), 20_000).unref();
});
process.on("unhandledRejection", (e) => {
  noteShutdown({ kind: "unhandledRejection", detail: `${e?.message || e}`, stack: (e?.stack || "").slice(0, 800) });
  console.error(`[치명] 처리되지 않은 거부 (uptime ${Math.round(process.uptime())}s):`, e);
});

// ── ffmpeg pipeline ──────────────────────────────────────────────────────────
// keep 구간이 이 개수를 넘으면 trim+concat 대신 select 방식으로 전환한다.
// trim+concat 은 구간마다 [0:v]/[0:a] 브랜치를 하나씩 만들기 때문에, 구간이
// 수백 개가 되면 ffmpeg 가 입력 스트림을 수백 갈래로 split 하면서 메모리와
// 필터 그래프 구축 시간이 폭발한다 (Render Free 512MB 에서는 사실상 멈춤).
// select/aselect 는 브랜치 없이 한 번만 디코드하므로 구간 수와 무관하게
// 메모리가 일정하다. 대신 타임스탬프를 CFR 로 다시 매기므로 VFR 소스에서
// 미세하게 어긋날 수 있어, 구간이 적을 때는 더 정확한 trim+concat 을 쓴다.
const SELECT_FILTER_THRESHOLD = 30;

async function processVideo(input, output, opts, { onProgress, timeoutMs } = {}) {
  const { keeps, ratio, speed, loudnorm } = opts;
  const quality = QUALITY_SIZES[opts.quality] ? opts.quality : "1080p";

  const ratioFilter = ratioToFilter(ratio, quality);
  let filter;

  if (keeps.length > SELECT_FILTER_THRESHOLD) {
    // 구간을 OR(+) 로 이어 붙인 하나의 select 식.
    // between(t,s,e) 은 끝 경계를 포함(t<=e)해서 구간마다 프레임이 한 장씩 더
    // 붙고, 오디오는 샘플 단위라 그만큼 안 늘어난다 → 구간 수에 비례해 A/V 가
    // 어긋난다 (197구간에서 6초). 반열린 구간 [s,e) 로 잡아야 맞는다.
    const expr = keeps
      .map((k) => `(gte(t,${k.start.toFixed(3)})*lt(t,${k.end.toFixed(3)}))`)
      .join("+");
    filter =
      `[0:v]select='${expr}',setpts=N/FRAME_RATE/TB,${ratioFilter}[vcat];` +
      `[0:a]aselect='${expr}',asetpts=N/SR/TB[acat]`;
  } else {
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
    filter = parts.join(";") +
      `;${concatInputs}concat=n=${keeps.length}:v=1:a=1[vcat][acat]`;
  }

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
    "-nostdin",
    "-i", input,
    "-filter_complex", filter,
    "-map", "[vfinal]",
    "-map", "[afinal]",
    "-c:v", "libx264",
    // preset 은 veryfast 유지. Render Standard 는 1 CPU 라 preset 을 올리면
    // 인코딩 시간이 크게 늘어난다 — 화질은 CRF 로 올리는 편이 낫다.
    "-preset", "veryfast",
    "-crf", String(QUALITY_CRF[quality] ?? 20),
    "-c:a", "aac",
    "-b:a", "160k",
    "-movflags", "+faststart",
    // 진행률을 stderr 로 강제 출력 — 이게 없으면 edit 단계가 완전한 블랙박스라
    // "느린 것"과 "멈춘 것"을 구분할 수 없다.
    "-progress", "pipe:2",
    "-y",
    output,
  ];

  await runFFmpeg(args, { onProgress, timeoutMs });
}

// 출력 해상도표. 세로 기준(720p/1080p)으로 비율마다 목표 크기를 잡는다.
const QUALITY_SIZES = {
  "720p":  { "16:9": [1280, 720],  "9:16": [720, 1280],   "1:1": [720, 720] },
  "1080p": { "16:9": [1920, 1080], "9:16": [1080, 1920],  "1:1": [1080, 1080] },
};
const QUALITY_CRF = { "720p": 21, "1080p": 20 };

function ratioToFilter(ratio, quality = "1080p") {
  const table = QUALITY_SIZES[quality] || QUALITY_SIZES["1080p"];
  const [w, h] = table[ratio] || table["16:9"];
  // force_original_aspect_ratio=increase + crop = "가득 채운 뒤 가운데 잘라내기".
  // 예전엔 비율마다 다른 식을 직접 썼는데, 세로 원본을 16:9 로 뽑을 때 스케일
  // 결과가 crop 목표보다 좁아져서 ffmpeg 가 실패하는 조합이 있었다. 이 관용구는
  // 방향에 상관없이 항상 목표 크기를 덮는다.
  return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;
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

function runFFmpeg(args, { onProgress, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let timer = null;
    let timedOut = false;

    // 한 번이라도 진행 신호가 오면 타이머를 되감는다 — 느린 것과 멎은 것을
    // 구분하기 위한 유휴(idle) 타임아웃이지 전체 실행 시간 제한이 아니다.
    const arm = () => {
      if (!timeoutMs) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        ff.kill("SIGKILL");
      }, timeoutMs);
    };
    arm();

    ff.stderr.on("data", (d) => {
      const chunk = d.toString();
      stderr += chunk;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
      arm();
      if (onProgress) {
        // -progress pipe:2 는 "out_time_us=12345678" 같은 key=value 를 흘린다.
        const m = chunk.match(/out_time_us=(\d+)/g);
        if (m?.length) {
          const us = Number(m[m.length - 1].split("=")[1]);
          if (Number.isFinite(us)) onProgress({ outTimeSec: us / 1e6 });
        }
      }
    });

    ff.on("error", (e) => { clearTimeout(timer); reject(e); });
    ff.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      if (timedOut) {
        return reject(new Error(
          `ffmpeg 가 ${Math.round(timeoutMs / 1000)}초 동안 아무 진행도 하지 못해 중단했습니다. ` +
          `영상이 너무 길거나 컷 구간이 너무 많아 서버 메모리를 넘겼을 수 있습니다.`
        ));
      }
      // 137 = SIGKILL, 보통 OOM killer.
      if (code === 137 || signal === "SIGKILL") {
        return reject(new Error(
          "ffmpeg 가 메모리 부족으로 강제 종료됐습니다 (exit 137). 더 짧은 영상으로 시도해 주세요."
        ));
      }
      reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`));
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
  const s = String(v || "tiny").toLowerCase();
  return ALLOWED_MODELS.has(s) ? s : "tiny";
}

// Whisper 의 initial_prompt 는 224 토큰 창을 쓴다. 한국어는 글자당 토큰이 커서
// 400자쯤에서 자른다 — 그 이상은 앞부분이 잘려 오히려 효과가 떨어진다.
const GLOSSARY_MAX = 400;
function sanitizeGlossary(v) {
  return String(v || "").replace(/\s+/g, " ").trim().slice(0, GLOSSARY_MAX);
}

const ALLOWED_FILLER_MODES = new Set(["off", "conservative", "aggressive"]);
function sanitizeFillerMode(v) {
  const s = String(v || "off").toLowerCase();
  return ALLOWED_FILLER_MODES.has(s) ? s : "off";
}

const PROGRESS_PREFIX = "@@P@@";

// transcribe.py 를 별도 프로세스로 실행해 stdout JSON 파싱.
// stdout 은 깨끗한 JSON 만 반환하도록 transcribe.py 가 보장한다.
function runTranscribe(input, { language, model, fillerMode, glossary, onProgress }) {
  return new Promise((resolve, reject) => {
    const args = [
      path.join(__dirname, "transcribe.py"),
      "--input", input,
      "--language", language,
      "--model", model,
      // beam_size=1 + int8 = Render Free CPU 에서 가장 안전한 기본값.
      "--beam-size", "1",
      "--compute-type", "int8",
    ];
    if (fillerMode && fillerMode !== "off") {
      args.push("--filler-mode", fillerMode);
    }
    if (glossary) args.push("--initial-prompt", glossary);
    const py = spawn(PYTHON_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    py.stdout.on("data", (d) => { stdout += d.toString(); });
    // transcribe.py 는 "@@P@@{json}" 형태로 진행 상황을 stderr 에 흘린다.
    // (stdout 은 결과 JSON 전용이라 섞을 수 없다.)
    let pending = "";
    py.stderr.on("data", (d) => {
      const chunk = d.toString();
      stderr += chunk;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
      if (!onProgress) return;
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() || "";
      for (const line of lines) {
        const i = line.indexOf(PROGRESS_PREFIX);
        if (i < 0) continue;
        try { onProgress(JSON.parse(line.slice(i + PROGRESS_PREFIX.length))); } catch {}
      }
    });
    py.on("error", reject);
    py.on("exit", (code) => {
      if (code !== 0) {
        const clean = stderr.split("\n").filter((l) => !l.includes(PROGRESS_PREFIX)).join("\n");
        return reject(new Error(`transcribe exit ${code}: ${clean.slice(-1500)}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`transcribe JSON parse error: ${e.message}; stderr=${stderr.slice(-500)}`));
      }
    });
  });
}
