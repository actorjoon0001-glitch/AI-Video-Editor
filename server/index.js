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
import { mkdir, unlink, stat, writeFile, truncate, readdir, open as openFile } from "fs/promises";
import { existsSync, statfsSync, createWriteStream, readFileSync } from "fs";
import { pipeline } from "stream/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { generateMetadata, metadataProvider, fillDescriptionTemplate, descriptionVarsFrom } from "./metadata.js";
import { uploadVideo, updateVideo, youtubeConfigured, youtubeAllowsPublic, sanitizePrivacy } from "./youtube.js";
import { detectKeeps } from "./silence.js";
import { dropCache, startPageCacheJanitor } from "./pagecache.js";
import { composeThumbnailCard } from "./thumbcard.js";
import {
  tiktokConfigured, tiktokConnected, tiktokStoreReady,
  authorizeUrl, redirectUri, exchangeCode, uploadToInbox, publishStatus, disconnect as tiktokDisconnect,
} from "./tiktok.js";
import {
  storeConfigured, saveJob, listJobs, loadJob, deleteExpired, STORE_RETENTION_DAYS,
} from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 8080;
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "https://ai-video-editor-good.netlify.app,http://localhost:8888,http://localhost:5173"
).split(",").map((s) => s.trim());

// 작업 디렉터리. 컨테이너의 기본 파일시스템에는 쓸 수 있는 용량이 2GB 밖에
// 없다 — 그걸 넘기면 트래픽이 없어도, 메모리가 2% 여도 플랫폼이 SIGTERM 으로
// 서비스를 내린다. 2.2GB 를 올려 두고 아무것도 하지 않은 채 82초 만에 죽는 걸
// 실측했다. 그래서 영구 디스크가 붙어 있으면 무조건 그쪽을 쓴다.
const PERSISTENT_ROOT = process.env.DISK_MOUNT_PATH || "/var/data";
const HAS_PERSISTENT_DISK = existsSync(PERSISTENT_ROOT);
const TMP =
  process.env.TMP_DIR || (HAS_PERSISTENT_DISK ? path.join(PERSISTENT_ROOT, "aive") : "/tmp/aive");
await mkdir(TMP, { recursive: true });
console.log(
  `작업 디렉터리: ${TMP}` + (HAS_PERSISTENT_DISK ? " (영구 디스크)" : " (임시 파일시스템 — 약 2GB 제한)")
);

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
//
// 영구 디스크가 없으면 아무리 크게 잡아도 소용이 없다. 2GB 근처에서 서비스가
// 통째로 내려가므로, 올리는 쪽에서 미리 거절해야 "왜 3GB 에서 갑자기 끊기지"
// 같은 상황을 안 만든다. 1500MB 는 감지까지의 여유(약 90초 분량)를 뺀 값이다.
const EPHEMERAL_SAFE_MB = 1500;
const MAX_UPLOAD_MB = Math.min(
  Number(process.env.MAX_UPLOAD_MB) || 500,
  HAS_PERSISTENT_DISK ? Number.MAX_SAFE_INTEGER : EPHEMERAL_SAFE_MB
);
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
// 틱톡 연결 여부는 보관함을 읽어야 알 수 있어 비동기다. health 는 동기라
// 매번 물어볼 수 없으니, 부팅할 때와 연결 상태가 바뀔 때만 갱신해 둔다.
const tiktokState = { connected: false };

async function refreshTiktokState() {
  try {
    tiktokState.connected = await tiktokConnected();
  } catch (e) {
    tiktokState.connected = false;
    console.warn(`[tiktok] 연결 상태 확인 실패: ${e?.message || e}`);
  }
  return tiktokState.connected;
}

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
    // 작업 기록을 어디에 두는지. memory 면 재시작과 함께 사라진다.
    store: storeConfigured() ? "supabase" : "memory",
    storeRetentionDays: STORE_RETENTION_DAYS,
    // 실제로 설치돼 확인된 자막 서체만. 프론트는 이 목록으로 선택지를 만든다.
    subtitleFonts: subtitleFonts.map(({ key, label }) => ({ key, label })),
    youtube: youtubeConfigured(),
    youtubeAllowsPublic: youtubeAllowsPublic(),
    // 틱톡은 "키가 있는가"와 "계정이 연결됐는가"가 다르다. 키만 넣고 연결을
    // 안 한 상태가 실제로 자주 생기므로 둘을 따로 보여준다.
    tiktok: tiktokConfigured(),
    tiktokConnected: tiktokState.connected,
    // 갱신된 토큰을 적어 둘 곳이 없으면 재시작 한 번에 연결이 끊긴다.
    tiktokPersistent: tiktokStoreReady(),
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
      { method: "DELETE", path: "/api/uploads/:id" },
      { method: "POST", path: "/api/uploads/:id/complete" },
      { method: "POST", path: "/api/uploads/merge" },
      { method: "GET",  path: "/api/jobs" },
      { method: "GET",  path: "/api/jobs/:id" },
      { method: "POST", path: "/api/jobs/:id/stages/:stage/retry" },
      { method: "POST", path: "/api/jobs/:id/subtitles" },
      { method: "POST", path: "/api/jobs/:id/youtube" },
      { method: "POST", path: "/api/jobs/:id/rerun" },
      { method: "GET",  path: "/api/jobs/:id/files/:name" },
      { method: "GET",  path: "/api/health" },
      { method: "GET",  path: "/healthz" },
    ],
    allowedOrigins: ALLOWED_ORIGINS,
  };
}
// 진단용 — 큰 파일을 받을 수 있는 환경인지 프론트/운영자가 판단할 수 있게.
function diskAndMemory() {
  const out = {
    maxUploadMb: Math.round(MAX_UPLOAD_BYTES / 1024 / 1024),
    // 영구 디스크가 붙었는지. 안 붙었으면 상한이 2GB 벽에 맞춰 강제로 낮춰진다.
    persistentDisk: HAS_PERSISTENT_DISK,
    tmpDir: TMP,
  };
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
    // 돌고 있는 작업은 나이와 무관하게 남긴다 — 30분 넘게 걸리는 자막 작업이
    // 끝나기도 전에 기록이 사라지면 클라이언트는 "작업 없음"만 보게 된다.
    if (job.status === "pending" || job.status === "running") continue;
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

const STAGE_NAMES = ["edit", "transcribe", "burn", "shorts", "thumbnail", "metadata", "upload"];

// 핵심 단계 — 실패하면 후속 stage 들 의미 없으니 전체 실패로.
const CRITICAL_STAGES = new Set(["edit"]);

// 개별 재시도를 받는 stage. edit 은 원본 업로드가 이미 지워져서, upload 는
// 중복 게시 위험 때문에 제외한다 (upload 는 실패했을 때만 아래에서 허용).
const RETRYABLE_STAGES = new Set(["transcribe", "burn", "shorts", "thumbnail", "metadata"]);

const pipelineJobs = new Map();   // id → job state
const PIPELINE_JOB_TTL_MS = 60 * 60 * 1000; // 1h
// 검토 대기는 사람을 기다리는 중이라 한 시간으로는 부족하다 (원본 보관과 같은 하루).
const REVIEW_JOB_TTL_MS = 24 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of pipelineJobs.entries()) {
    // 아직 돌고 있는 작업은 아무리 오래됐어도 건드리지 않는다. TTL 은 "결과를
    // 언제까지 보관하나"지 "작업을 언제 죽이나"가 아니다. 예전엔 completedAt 이
    // 없으면 createdAt 으로 재서, 한 시간 넘게 걸리는 작업이 실행 도중에 기록도
    // 산출물도 함께 지워질 수 있었다 — 8GB 원본이면 인코딩만 47분이다.
    if (job.status === "running" || job.status === "queued") continue;
    const t = job.completedAt || job.createdAt;
    // 검토 대기는 사람을 기다리는 중이다. 한 시간 만에 치우면 점심 먹고 온
    // 사이에 확인하려던 영상과 썸네일이 사라진다.
    const ttl = job.status === "review" ? REVIEW_JOB_TTL_MS : PIPELINE_JOB_TTL_MS;
    if (now - t > ttl) {
      pipelineJobs.delete(id);
      // 산출물도 같이 정리
      for (const f of job.artifacts || []) {
        unlink(f).catch(() => {});
      }
    }
  }
}, 5 * 60 * 1000).unref();

// 원본 영상 보관.
//
// 지금까지 .upload 파일은 아무도 안 지웠다 — 작업 산출물 목록에 없어서 정리
// 대상이 아니었다. 8GB 원본 두어 개면 20GB 디스크가 찬다.
// 그렇다고 작업이 끝나자마자 지우면 "설정 바꿔서 다시 만들기" 를 할 때마다
// 8GB 를 다시 올려야 한다. 하루는 남겨 두고, 그 뒤에 치운다.
const SOURCE_TTL_MS = 24 * 60 * 60 * 1000;

// 하루가 지나도 안 지워지는 상황이 있다 — 8GB 짜리를 연달아 올리면 24시간이
// 오기 전에 20GB 가 먼저 찬다. 그래서 나이 말고 남은 용량으로도 한 번 더 건다.
const SOURCE_FREE_FLOOR_MB = 6000;

export async function sweepOldSources() {
  let names;
  try {
    names = await readdir(TMP);
  } catch (e) {
    return console.warn(`[cleanup] 작업 폴더를 읽지 못했습니다: ${e?.message || e}`);
  }

  const inUse = (file) => [...pipelineJobs.values()].some((j) => j.inputPath === file);
  const sources = [];
  for (const name of names) {
    if (!name.endsWith(".upload")) continue;
    const file = path.join(TMP, name);
    try {
      sources.push({ file, name, st: await stat(file) });
    } catch {}
  }

  const now = Date.now();
  const remove = async ({ file, name, st }, why) => {
    try {
      await unlink(file);
      console.log(`[cleanup] 원본 삭제 (${(st.size / 1024 / 1024).toFixed(0)}MB, ${why}): ${name}`);
      return true;
    } catch (e) {
      console.warn(`[cleanup] ${name} 정리 실패: ${e?.message || e}`);
      return false;
    }
  };

  const left = [];
  for (const src of sources) {
    if (inUse(src.file)) continue;
    if (now - src.st.mtimeMs > SOURCE_TTL_MS) await remove(src, "24시간 경과");
    else left.push(src);
  }

  // 아직 하루가 안 됐어도, 다음 업로드가 들어올 자리가 없으면 오래된 것부터
  // 비운다. 자리가 없어 업로드가 실패하는 쪽이 재편집을 못 하는 것보다 나쁘다.
  left.sort((a, b) => a.st.mtimeMs - b.st.mtimeMs);
  for (const src of left) {
    let freeMb = 0;
    try {
      const fs = statfsSync(TMP);
      freeMb = (fs.bavail * fs.bsize) / 1024 / 1024;
    } catch { break; }
    if (freeMb >= SOURCE_FREE_FLOOR_MB) break;
    await remove(src, `여유 공간 ${Math.round(freeMb)}MB`);
  }
}

setInterval(() => {
  sweepOldSources().catch(() => {});
  deleteExpired().catch(() => {});
}, 60 * 60 * 1000).unref();

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
  // 단계가 늘어나면 예전 작업에는 그 칸이 없다. 없는 칸을 읽다 터지면 작업
  // 전체가 조회 불가가 되므로 "아직 안 함"으로 본다.
  const states = STAGE_NAMES.map((n) => job.stages[n]?.status || "queued");
  // "검토 대기" 는 진행 중도 완료도 아니다. running 이라고 하면 화면이 계속
  // 기다리게 되고, done 이라고 하면 아직 안 올라간 걸 올라갔다고 하게 된다.
  if (states.includes("review")) return "review";
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
    // 아직 시작 못 한 작업이 왜 조용한지 알 수 있게 — 앞에 몇 개 남았는지.
    queuedBehind: job.startedAt ? 0 : (job.queuedBehind || 0),
    // 원본이 아직 디스크에 있으면 재업로드 없이 다시 만들 수 있다.
    canRerun: Boolean(job.inputPath && existsSync(job.inputPath)),
    options: job.options,
    review: job.stages.upload?.status === "review" ? reviewResponse(job).review : null,
    stages,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  };
}

// 검토 화면이 필요한 것 전부. 카드 URL 은 파일 이름이 늘 같으므로 판 번호를
// 붙인다 — 안 그러면 문구를 고쳐도 브라우저가 옛 그림을 계속 보여준다.
function reviewResponse(job) {
  const rv = job.review;
  if (!rv) return { review: null };
  const frames = job.stages.thumbnail?.result?.urls || [];
  return {
    review: {
      title: rv.title,
      titles: job.stages.metadata?.result?.titles || [],
      description: rv.description,
      tags: rv.tags,
      privacy: rv.privacy,
      thumbnail: rv.thumbnail,
      frameIndex: rv.frameIndex,
      frameUrls: frames,
      lines: rv.lines,
      card: rv.card,
      cardUrl: rv.card && !rv.card.error
        ? `/api/jobs/${job.id}/files/thumb_card.jpg?v=${rv.cardVersion}`
        : null,
      videoUrl: job.stages.burn?.status === "done"
        ? job.stages.burn.result?.url
        : job.stages.edit?.result?.url,
    },
  };
}

function sanitizeStageResult(name, result) {
  // 외부에 노출 가능한 필드만 골라서 반환. 디스크 path 같은 건 url 로만.
  if (name === "edit") {
    return {
      url: result.url,
      sizeBytes: result.sizeBytes,
      durationMs: result.durationMs,
      quality: result.quality || null,
      downgradedFrom: result.downgradedFrom || null,
      sourceHeight: result.sourceHeight || null,
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
  if (name === "shorts") {
    return {
      url: result.url,
      startSec: result.startSec,
      lengthSec: result.lengthSec,
      fit: result.fit,
      withSubtitles: result.withSubtitles === true,
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
      thumbnailLine1: result.thumbnailLine1,
      thumbnailLine2: result.thumbnailLine2,
      thumbnailLine3: result.thumbnailLine3,
      source: result.source,
      model: result.model,
      fallbackFrom: result.fallbackFrom || null,
      fallbackReason: result.fallbackReason || null,
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
      // 화이트리스트라 여기 안 적으면 프론트까지 못 간다. 카드가 왜 안 붙었는지는
      // 조용히 사라지면 안 되는 정보다.
      thumbnailCard: result.thumbnailCard || null,
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
  job.sourceName = req.file?.originalname || "";
  pipelineJobs.set(id, job);
  saveJob(job);

  res.status(202).json({
    jobId: id,
    statusUrl: `/api/jobs/${id}`,
    pollIntervalMs: 3000,
  });

  // 백그라운드 실행 — 큐에 넣고 차례가 오면 돈다.
  enqueueJob(id, inputPath);
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

// 업로드 취소. 중간에 그만둔 파일은 디스크에 그대로 남아 다음 작업이 쓸 자리를
// 먹는다 (TTL 청소는 6시간 뒤에나 돈다). 사용자가 취소하거나 다른 파일을 고르면
// 바로 치울 수 있게 한다.
app.delete("/api/uploads/:id", async (req, res) => {
  const id = String(req.params.id).replace(/[^a-f0-9-]/gi, "");
  const u = await findUpload(id);
  if (!u) return res.status(404).json({ error: "업로드 세션을 찾을 수 없습니다." });
  if (u.writing) return res.status(409).json({ error: "조각을 쓰는 중입니다. 잠시 후 다시 시도하세요." });
  uploads.delete(id);
  const freedMb = Math.round(u.received / 1024 / 1024);
  await Promise.all([
    unlink(u.path).catch(() => {}),
    unlink(`${u.path}.json`).catch(() => {}),
  ]);
  console.log(`[upload ${id}] 취소 — ${freedMb}MB 회수`);
  res.json({ deleted: true, freedMb });
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
  // 새 원본이 자리 잡기 전에 오래된 것부터 치운다.
  sweepOldSources().catch(() => {});

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
  job.sourceName = u.name || "";
  pipelineJobs.set(id, job);
  saveJob(job);
  console.log(`[upload ${uploadId}] 완료 → job ${id} (${(u.total / 1024 / 1024).toFixed(1)}MB)`);

  res.status(202).json({ jobId: id, statusUrl: `/api/jobs/${id}`, pollIntervalMs: 3000 });

  enqueueJob(id, u.path);
});

// 보관된 작업 목록. 서버 메모리가 아니라 Supabase 를 본다 — 재시작해도, 새로
// 고쳐도 남아 있어야 하는 게 이 목록의 존재 이유다.
app.get("/api/jobs", async (req, res) => {
  if (!storeConfigured()) {
    return res.json({ store: "memory", retentionDays: null, jobs: [], note: "Supabase 미설정 — 기록이 서버 재시작과 함께 사라집니다." });
  }
  try {
    const rows = await listJobs(Number(req.query.limit) || 50);
    const jobs = rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      // 화면에 "보관 N일 남음" 으로 쓰려고 서버에서 계산해 둔다 — 시계가 어긋난
      // 브라우저에서도 같은 숫자가 보이게.
      daysLeft: Math.max(0, Math.ceil((new Date(r.expires_at) - Date.now()) / 86400000)),
      status: r.status,
      title: r.title,
      videoId: r.video_id,
      videoUrl: r.video_url,
      privacy: r.privacy,
      // 파일이 아직 있으면 다시 만들 수 있고, 없으면 기록만 남은 것이다.
      filesAvailable: pipelineJobs.has(r.id),
    }));
    res.json({ store: "supabase", retentionDays: STORE_RETENTION_DAYS, jobs });
  } catch (e) {
    res.status(502).json({ error: String(e?.message || e) });
  }
});

// 여러 클립을 이어 붙여 하나의 작업으로 만든다.
//
// 화면은 예전부터 "업로드 순서대로 자동 병합됩니다" 라고 적어 뒀지만, 그 병합은
// 브라우저 ffmpeg 경로에만 있었다. 큐 모드는 pickedFiles[0] 하나만 보내서,
// 세 개를 고르면 조용히 첫 번째만 편집됐다 — 약속이 지켜지지 않는 쪽이 더 나쁘다.
app.post("/api/uploads/merge", express.json({ limit: "4mb" }), async (req, res) => {
  const ids = (Array.isArray(req.body?.uploadIds) ? req.body.uploadIds : [])
    .map((v) => String(v).replace(/[^a-f0-9-]/gi, ""))
    .filter(Boolean);
  if (ids.length < 2) return res.status(400).json({ error: "합칠 업로드가 2개 이상 필요합니다." });

  const parts = [];
  for (const uid of ids) {
    const u = await findUpload(uid);
    if (!u) return res.status(404).json({ error: `업로드 세션을 찾을 수 없습니다 (${uid}).` });
    if (u.received !== u.total) {
      return res.status(400).json({ error: `아직 다 올라오지 않았습니다 (${uid}).` });
    }
    parts.push(u);
  }

  const id = randomUUID();
  const merged = path.join(TMP, `${id}.upload`);
  try {
    await concatVideos(parts.map((p) => p.path), merged);
  } catch (e) {
    console.error(`[merge ${id}] 실패:`, e);
    try { await unlink(merged); } catch {}
    return res.status(500).json({ error: `영상을 이어 붙이지 못했습니다: ${String(e?.message || e).slice(0, 300)}` });
  }

  // 조각 원본은 합친 뒤에는 필요 없다. 합본이 곧 이 작업의 원본이다.
  for (const uid of ids) uploads.delete(uid);
  await Promise.all(parts.flatMap((p) => [
    unlink(p.path).catch(() => {}),
    unlink(`${p.path}.json`).catch(() => {}),
  ]));

  const safeOpts = sanitizeJobOptions(req.body?.options || {});
  const job = newPipelineJob(id, safeOpts);
  job.sourceName = parts.map((p) => p.name).filter(Boolean).join(" + ") ||
    `${parts.length}개 영상 병합`;
  pipelineJobs.set(id, job);
  saveJob(job);
  const mb = (await stat(merged)).size / 1024 / 1024;
  console.log(`[merge ${id}] ${parts.length}개 → ${mb.toFixed(1)}MB`);

  res.status(202).json({ jobId: id, statusUrl: `/api/jobs/${id}`, pollIntervalMs: 3000 });
  enqueueJob(id, merged);
});

// 같은 카메라로 이어 찍은 클립이면 재인코딩 없이 붙는다 (-c copy). 코덱이나
// 해상도가 다르면 concat demuxer 가 거부하므로, 그때만 다시 인코딩한다 —
// 되는 경우까지 항상 재인코딩하면 몇 분씩 그냥 버리게 된다.
async function concatVideos(inputs, out) {
  const listPath = `${out}.list.txt`;
  await writeFile(
    listPath,
    inputs.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"),
    "utf8"
  );
  const base = ["-nostdin", "-f", "concat", "-safe", "0", "-i", listPath];
  // 결과 파일 이름은 <id>.upload 다 — 확장자가 없으니 ffmpeg 가 컨테이너를
  // 못 고르고 "Error initializing the muxer" 로 끝난다. 형식을 직접 지정한다.
  const tail = ["-f", "mp4", "-movflags", "+faststart", "-y", out];
  try {
    await runFFmpeg([...base, "-c", "copy", ...tail]);
  } catch (e) {
    console.warn(`[merge] 무손실 병합 실패 — 다시 인코딩합니다: ${e?.message || e}`);
    await runFFmpeg([
      ...base,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-b:a", "160k",
      ...tail,
    ]);
  } finally {
    await unlink(listPath).catch(() => {});
  }
}

app.get("/api/jobs/:id", async (req, res) => {
  const id = String(req.params.id).replace(/[^a-f0-9-]/gi, "");
  const job = pipelineJobs.get(id);
  if (job) return res.json(jobResponse(job));

  // 메모리에 없으면 보관된 기록을 돌려준다. 파일은 없어도 제목·설명·태그와
  // 유튜브 링크는 그대로 쓸 수 있다 — 그게 대개 다시 필요한 것들이다.
  if (storeConfigured()) {
    try {
      const row = await loadJob(id);
      if (row) {
        // 기록이 queued/running 에서 멈춰 있다는 건 그 상태로 서버가 사라졌다는
        // 뜻이다. 그대로 돌려주면 화면이 영영 "대기 중" 을 붙잡고 폴링한다.
        const interrupted = row.status === "running" || row.status === "queued";
        return res.json({
          jobId: row.id,
          status: interrupted ? "failed" : (row.status || "done"),
          archived: true,
          interrupted,
          message: interrupted
            ? "작업 도중 서버가 재시작돼 중단됐습니다. 기록만 남아 있습니다."
            : null,
          canRerun: false,
          expiresAt: row.expires_at,
          daysLeft: Math.max(0, Math.ceil((new Date(row.expires_at) - Date.now()) / 86400000)),
          options: row.payload?.options || {},
          stages: archivedStages(row),
          createdAt: row.payload?.createdAt || Date.parse(row.created_at),
          completedAt: row.payload?.completedAt || null,
        });
      }
    } catch (e) {
      console.warn(`[store] 기록 조회 실패 (${id}): ${e?.message || e}`);
    }
  }
  res.status(404).json({
    error: "작업을 찾을 수 없거나 보관 기간이 지났습니다.",
  });
});

// 보관된 기록을 화면이 아는 모양(stages)으로 되살린다. 파일이 없으므로 다운로드
// 링크는 빼고, 글자로 남은 결과만 채운다.
function archivedStages(row) {
  const p = row.payload || {};
  const out = {};
  for (const [name, s] of Object.entries(p.stages || {})) {
    out[name] = { status: s.status, note: s.note, error: s.error };
  }
  if (p.metadata && out.metadata) out.metadata.result = p.metadata;
  if (p.upload && out.upload) out.upload.result = p.upload;
  if (p.srt && out.transcribe) {
    out.transcribe.result = { srt: p.srt, segmentCount: p.subtitleLines || 0 };
  }
  return out;
}

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

// 이미 올라간 영상의 제목·설명·태그·공개범위를 덮어쓴다.
//
// 영상 파일은 못 바꾼다 — 유튜브가 교체를 허용하지 않는다. 화면을 고치려면
// /rerun 으로 다시 만들어 새 영상으로 올려야 한다. 여기서 되는 건 글자와
// 썸네일뿐이고, 그거야말로 영상을 보고 나서 제일 자주 고치는 것들이다.
app.post("/api/jobs/:id/youtube", express.json({ limit: "1mb" }), async (req, res) => {
  const id = String(req.params.id).replace(/[^a-f0-9-]/gi, "");
  const job = pipelineJobs.get(id);
  if (!job) return res.status(404).json({ error: "작업을 찾을 수 없거나 만료됐습니다." });

  const videoId = job.stages.upload?.result?.videoId;
  if (!videoId) return res.status(400).json({ error: "이 작업에서 업로드된 영상이 없습니다." });

  const b = req.body || {};
  // 썸네일은 이미 만들어 둔 것 중에서 고른다 — 카드본이 기본, 원본 사진도 가능.
  let thumbnailPath = null;
  if (b.thumbnail === "card" || b.thumbnail === "raw") {
    const p = path.join(TMP, `${id}.${b.thumbnail === "card" ? "thumb_card" : "thumb_0"}.jpg`);
    if (!existsSync(p)) return res.status(400).json({ error: "선택한 썸네일 파일이 없습니다 (보관 기간이 지났을 수 있습니다)." });
    thumbnailPath = p;
  }

  try {
    const out = await updateVideo({
      videoId,
      title: typeof b.title === "string" ? b.title : null,
      description: typeof b.description === "string" ? b.description : null,
      tags: Array.isArray(b.tags) ? b.tags : null,
      privacy: b.privacy ? sanitizePrivacy(b.privacy) : null,
      thumbnailPath,
    });
    // 작업 기록도 같이 갱신해야 화면이 옛 제목을 계속 보여주지 않는다.
    const st = job.stages.upload.result;
    st.title = out.title;
    st.privacyStatus = out.privacyStatus;
    console.log(`[job ${id}] 유튜브 수정 — ${out.videoId} (${out.privacyStatus})`);
    res.json(out);
  } catch (e) {
    console.error(`[job ${id}] 유튜브 수정 실패:`, e);
    res.status(502).json({ error: String(e?.message || e) });
  }
});

// ── 틱톡 ────────────────────────────────────────────────────────────────────
//
// 연결 자체를 우리 서버에서 끝낸다. 유튜브 때는 OAuth Playground 를 거치느라
// 화면을 몇 번이나 오갔는데, 틱톡은 콜백 주소만 등록해 두면 버튼 한 번이면 된다.

// state 는 CSRF 방지용. 혼자 쓰는 도구라 메모리에 하나만 들고 있으면 충분하다.
let tiktokAuthState = null;

app.get("/api/tiktok/connect", (req, res) => {
  if (!tiktokConfigured()) {
    return res.status(400).type("text/html; charset=utf-8").send(
      "<h2>틱톡 자격 증명이 없습니다</h2><p>렌더 환경변수에 TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET 을 넣어 주세요.</p>"
    );
  }
  tiktokAuthState = randomUUID();
  res.redirect(authorizeUrl(req, tiktokAuthState));
});

app.get("/api/tiktok/callback", async (req, res) => {
  const page = (title, body) => res.type("text/html; charset=utf-8").send(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<body style="font:16px/1.7 system-ui;padding:40px;background:#111;color:#eee">` +
    `<h2>${title}</h2>${body}</body>`
  );

  if (req.query.error) {
    return page("틱톡 연결 실패", `<p>${escapeHtmlServer(String(req.query.error_description || req.query.error))}</p>`);
  }
  // state 가 안 맞으면 우리가 시작한 흐름이 아니다.
  if (!req.query.state || req.query.state !== tiktokAuthState) {
    return page("틱톡 연결 실패", "<p>요청이 만료됐거나 우리가 시작한 연결이 아닙니다. 다시 눌러 주세요.</p>");
  }
  tiktokAuthState = null;

  try {
    await exchangeCode(String(req.query.code || ""), redirectUri(req));
    await refreshTiktokState();
    const warn = tiktokStoreReady()
      ? ""
      : "<p style='color:#fb0'>주의: 기록 저장소(Supabase)가 없어 서버가 재시작되면 다시 연결해야 합니다.</p>";
    console.log("[tiktok] 계정 연결 완료");
    page("틱톡 연결 완료", `<p>이 창을 닫고 편집 화면으로 돌아가면 됩니다.</p>${warn}`);
  } catch (e) {
    console.error("[tiktok] 연결 실패:", e);
    page("틱톡 연결 실패", `<p>${escapeHtmlServer(String(e?.message || e))}</p>`);
  }
});

app.post("/api/tiktok/disconnect", async (req, res) => {
  await tiktokDisconnect();
  await refreshTiktokState();
  res.json({ ok: true, connected: tiktokState.connected });
});

// 세로본을 틱톡 받은함으로 보낸다. 게시는 사람이 앱에서 한다.
app.post("/api/jobs/:id/tiktok", async (req, res) => {
  const id = String(req.params.id).replace(/[^a-f0-9-]/gi, "");
  const job = pipelineJobs.get(id);
  if (!job) return res.status(404).json({ error: "작업을 찾을 수 없거나 만료됐습니다." });
  if (!tiktokConfigured()) return res.status(400).json({ error: "서버에 틱톡 자격 증명이 없습니다." });
  if (!(await tiktokConnected())) {
    return res.status(409).json({ error: "틱톡 계정이 연결되지 않았습니다. '틱톡 연결'을 먼저 눌러 주세요." });
  }

  const file = path.join(TMP, `${id}.shorts.mp4`);
  if (!existsSync(file)) {
    return res.status(400).json({
      error: "이 작업에는 세로본이 없습니다. '세로본도 만들기'를 켜고 다시 만들어 주세요.",
    });
  }

  try {
    const out = await uploadToInbox(file, {
      onProgress: ({ chunk, chunks, sent, total }) => {
        console.log(`[job ${id}] 틱톡 전송 ${chunk}/${chunks} (${((sent / total) * 100).toFixed(0)}%)`);
      },
    });
    // 기록에 남겨야 화면이 새로고침 뒤에도 "보냈음"을 안다.
    job.tiktok = { publishId: out.publishId, sentAt: Date.now(), sizeBytes: out.sizeBytes };
    saveJob(job);
    console.log(`[job ${id}] 틱톡 받은함 전송 완료 — ${out.publishId}`);
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error(`[job ${id}] 틱톡 전송 실패:`, e);
    res.status(502).json({ error: String(e?.message || e) });
  }
});

app.get("/api/jobs/:id/tiktok", async (req, res) => {
  const id = String(req.params.id).replace(/[^a-f0-9-]/gi, "");
  const job = pipelineJobs.get(id);
  const publishId = job?.tiktok?.publishId;
  if (!publishId) return res.status(404).json({ error: "이 작업에서 틱톡으로 보낸 영상이 없습니다." });
  try {
    res.json({ publishId, ...(await publishStatus(publishId)) });
  } catch (e) {
    res.status(502).json({ error: String(e?.message || e) });
  }
});

// 위의 안내 페이지는 우리가 만든 문자열을 그대로 넣는 자리가 있다. 틱톡이
// 돌려준 오류 문구가 그대로 들어가므로 최소한의 이스케이프는 해야 한다.
function escapeHtmlServer(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// ── 업로드 전 검토 ──────────────────────────────────────────────────────────

function reviewJobOr404(req, res) {
  const id = String(req.params.id).replace(/[^a-f0-9-]/gi, "");
  const job = pipelineJobs.get(id);
  if (!job) {
    res.status(404).json({ error: "작업을 찾을 수 없거나 만료됐습니다." });
    return null;
  }
  if (!job.review || job.stages.upload?.status !== "review") {
    res.status(409).json({ error: "이 작업은 업로드 검토 대기 상태가 아닙니다." });
    return null;
  }
  return job;
}

// 검토 화면에서 고친 값을 담아 둔다. 아직 올리지는 않는다.
// 프레임이나 문구가 바뀌면 썸네일 카드를 다시 그려서 바로 볼 수 있게 한다.
app.post("/api/jobs/:id/review", express.json({ limit: "1mb" }), async (req, res) => {
  const job = reviewJobOr404(req, res);
  if (!job) return;

  const b = req.body || {};
  const rv = job.review;
  const frameCount = job.stages.thumbnail?.result?.urls?.length || 0;

  if (typeof b.title === "string") rv.title = b.title.trim().slice(0, 100);
  if (typeof b.description === "string") rv.description = b.description.slice(0, 5000);
  if (Array.isArray(b.tags)) {
    rv.tags = b.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 40);
  }
  if (b.privacy) rv.privacy = sanitizePrivacy(b.privacy);
  if (["card", "raw", "none"].includes(b.thumbnail)) rv.thumbnail = b.thumbnail;

  // 카드를 다시 그려야 하는 변경인지 먼저 판단한다 — 매번 다시 그리면 문구를
  // 한 글자 고칠 때마다 파이썬을 띄우게 된다.
  let redraw = false;
  if (b.frameIndex != null && frameCount > 0) {
    const i = Math.max(0, Math.min(frameCount - 1, parseInt(b.frameIndex, 10) || 0));
    if (i !== rv.frameIndex) { rv.frameIndex = i; redraw = true; }
  }
  if (Array.isArray(b.lines)) {
    const next = [0, 1, 2].map((i) => String(b.lines[i] ?? "").trim().slice(0, 24));
    if (next.join("\u0000") !== rv.lines.join("\u0000")) { rv.lines = next; redraw = true; }
  }
  if (b.redraw === true) redraw = true;
  // 지난번에 카드를 못 만들었으면 지금은 값이 그대로여도 다시 그려 본다.
  // 안 그러면 실패한 문구를 고쳐도 옛 에러 메시지가 그대로 남는다.
  if (rv.card?.error) redraw = true;

  if (redraw && frameCount > 0) await rebuildReviewCard(job);
  saveJob(job);
  res.json(reviewResponse(job));
});

// 확인 끝. 지금 올린다.
app.post("/api/jobs/:id/review/approve", express.json({ limit: "1mb" }), async (req, res) => {
  const job = reviewJobOr404(req, res);
  if (!job) return;
  if (!job.review.title) {
    return res.status(400).json({ error: "제목이 비어 있습니다." });
  }

  const editedPath = path.join(TMP, `${job.id}.edited.mp4`);
  if (!existsSync(editedPath)) {
    return res.status(410).json({ error: "편집본이 서버에서 지워졌습니다. 다시 만들어 주세요." });
  }

  job.stages.upload = { status: "queued" };
  job.status = "running";
  res.status(202).json({ ok: true, statusUrl: `/api/jobs/${job.id}`, pollIntervalMs: 3000 });

  // 업로드는 네트워크 대기라 인코딩 큐를 막지 않는다. 바로 시작한다.
  runStage(job, "upload", () => uploadStageFor(job, editedPath))
    .then(() => {
      job.status = computeJobStatus(job);
      job.completedAt = Date.now();
      saveJob(job);
    })
    .catch((e) => console.error(`[job ${job.id}] 승인 업로드 실패:`, e));
});

// 안 올리기로 했다. 영상과 기록은 그대로 두고 업로드만 접는다.
app.post("/api/jobs/:id/review/skip", async (req, res) => {
  const job = reviewJobOr404(req, res);
  if (!job) return;
  job.review = null;
  job.stages.upload = { status: "skipped", note: "검토 후 업로드하지 않음" };
  job.status = computeJobStatus(job);
  job.completedAt = Date.now();
  saveJob(job);
  console.log(`[job ${job.id}] 검토 후 업로드 취소`);
  res.json({ ok: true });
});

// 설정만 바꿔 처음부터 다시 만든다. 원본이 서버에 남아 있으므로 8GB 를 다시
// 올릴 필요가 없다. 결과는 새 작업이고, 유튜브에는 새 비공개 영상으로 올라간다.
app.post("/api/jobs/:id/rerun", express.json({ limit: "4mb" }), async (req, res) => {
  const id = String(req.params.id).replace(/[^a-f0-9-]/gi, "");
  const prev = pipelineJobs.get(id);
  if (!prev) return res.status(404).json({ error: "작업을 찾을 수 없거나 만료됐습니다." });
  if (!prev.inputPath || !existsSync(prev.inputPath)) {
    return res.status(410).json({ error: "원본 영상이 서버에서 지워졌습니다. 다시 업로드해 주세요." });
  }

  // 안 보낸 항목은 이전 설정을 그대로 쓴다 — 컷 기준만 바꾸고 싶은데 자막
  // 설정까지 다시 채워 보내야 한다면 그게 더 불편하다.
  const merged = sanitizeJobOptions({ ...prev.options, ...(req.body?.options || {}) });
  // keeps 를 물려받으면 새 무음 기준이 무시된다. 무음 관련 설정이 바뀌었으면
  // 다시 찾게 한다.
  const silenceChanged = ["noiseDb", "minSilence", "padding"].some(
    (k) => merged[k] !== prev.options[k]
  );
  if (silenceChanged) merged.keeps = [];

  const newId = randomUUID();
  const job = newPipelineJob(newId, merged);
  pipelineJobs.set(newId, job);
  job.sourceName = prev.sourceName || "";
  saveJob(job);
  console.log(`[job ${id}] → 다시 만들기 job ${newId}${silenceChanged ? " (무음 재탐지)" : ""}`);

  res.status(202).json({ jobId: newId, statusUrl: `/api/jobs/${newId}`, pollIntervalMs: 3000 });
  enqueueJob(newId, prev.inputPath);
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
    // 릴스·틱톡용 세로본. 길이는 숏폼에서 실제로 쓰는 범위로만 받는다.
    shorts: opts.shorts === true,
    shortsLengthSec: clamp(parseInt(opts.shortsLengthSec, 10) || 60, 15, 180),
    shortsFit: opts.shortsFit === "crop" ? "crop" : "blur",
    metadata: opts.metadata === true,
    metadataPersona: String(opts.metadataPersona || "").slice(0, 500),
    // 설명글 템플릿과 채널 고정값. 코드가 아니라 사용자가 들고 있어야 문구를
    // 고칠 때마다 배포하지 않는다.
    descriptionTemplate: String(opts.descriptionTemplate || "").slice(0, 8000),
    channel: sanitizeChannel(opts.channel),
    upload: opts.upload === true,
    // 올리기 전에 한 번 보고 고칠 기회를 준다. 유튜브는 올린 뒤에 영상 파일을
    // 못 바꾸므로, 화면을 다시 만들어야 하는 실수는 올리기 전에 잡는 게 유일한
    // 방법이다. 제목·설명·썸네일은 나중에도 고칠 수 있지만 그것도 여기서 미리
    // 보는 편이 훨씬 싸다.
    reviewBeforeUpload: opts.reviewBeforeUpload !== false,
    privacy: sanitizePrivacy(opts.privacy),
    publishAt: sanitizePublishAt(opts.publishAt),
  };
}

// 설명글에 들어갈 채널 고정값. 길이만 제한하고 내용은 그대로 둔다 — 링크 형태를
// 우리가 단정하면 사용자가 쓰려는 주소를 막게 된다.
function sanitizeChannel(v) {
  const o = v && typeof v === "object" ? v : {};
  const s = (x, n) => String(x || "").trim().slice(0, n);
  return {
    inquiryUrl: s(o.inquiryUrl, 300),
    catalogUrl: s(o.catalogUrl, 300),
    houseNo: s(o.houseNo, 40),
    email: s(o.email, 200),
    instagram: s(o.instagram, 300),
  };
}

// ISO 8601 예약 게시 시각. 과거이거나 형식이 틀리면 무시 (즉시 게시).
function sanitizePublishAt(v) {
  if (!v) return null;
  const t = Date.parse(String(v));
  if (!Number.isFinite(t) || t <= Date.now()) return null;
  return new Date(t).toISOString();
}

// 큐 모드라는 이름과 달리 여기엔 큐가 없었다. 작업이 들어오는 즉시 실행해서,
// 두 개를 올리면 ffmpeg 두 개와 Whisper 두 개가 동시에 돌았다. 컨테이너 메모리는
// 2GB 이고 Whisper small 하나가 그 절반 넘게 쓰므로, 둘째 작업을 시작하는 순간
// 컨테이너가 통째로 죽는다 — 실제로 그렇게 두 작업을 한꺼번에 잃었다.
// CPU 도 하나뿐이라 동시에 돌려서 빨라질 것도 없다. 한 번에 하나만 돌린다.
const jobQueue = [];
let jobRunning = false;

function enqueueJob(id, inputPath) {
  jobQueue.push({ id, inputPath });
  refreshQueuePositions();
  pumpJobQueue();
}

// 대기 중인 작업이 자기 차례를 알 수 있게 한다 ("앞에 2개").
// 줄에서 앞선 대기자 수에, 지금 돌고 있는 작업 한 건을 더해야 실제로 기다리는
// 수가 된다 — 그게 빠지면 맨 앞 대기자가 "앞에 0개"인데 시작을 안 한다.
function refreshQueuePositions() {
  const ahead = jobRunning ? 1 : 0;
  jobQueue.forEach((entry, i) => {
    const job = pipelineJobs.get(entry.id);
    if (job) job.queuedBehind = i + ahead;
  });
}

async function pumpJobQueue() {
  if (jobRunning) return;
  const next = jobQueue.shift();
  if (!next) return;
  jobRunning = true;
  refreshQueuePositions();
  try {
    await runJobPipeline(next.id, next.inputPath);
  } catch (e) {
    console.error(`[job ${next.id}] dispatcher crash:`, e);
  } finally {
    jobRunning = false;
    // 앞 작업이 어떻게 끝났든 다음 작업은 돈다.
    pumpJobQueue();
  }
}

async function runJobPipeline(id, inputPath) {
  const job = pipelineJobs.get(id);
  if (!job) return;
  // 설정만 바꿔 다시 만들 때 원본을 다시 올리지 않아도 되도록 기억해 둔다.
  job.inputPath = inputPath;
  job.status = "running";
  job.queuedBehind = 0;
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

    const enc = await processVideo(inputPath, editedPath, job.options, {
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
    // 요청한 화질보다 낮게 뽑혔으면 뒤따르는 번인도 같은 CRF 를 써야 한다.
    job.options.quality = enc.quality;
    const sizeBytes = (await stat(editedPath)).size;
    return {
      _path: editedPath,
      // 뒤이어 도는 번인이 진행률의 분모로 쓴다. 인코딩에 걸린 시간(durationMs)이
      // 아니라 만들어진 영상의 길이다.
      durationSec: expectedSec,
      url: `/api/jobs/${id}/files/edited.mp4`,
      sizeBytes,
      durationMs: Date.now() - t0,
      quality: enc.quality,
      // 원본보다 큰 화질을 골랐으면 조용히 내리지 말고 그 사실을 남긴다.
      downgradedFrom: enc.quality !== enc.requestedQuality ? enc.requestedQuality : null,
      sourceHeight: enc.sourceHeight || null,
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
    return;
  }

  // 원본은 여기서 지우지 않는다. 예전엔 편집이 끝나자마자 지웠는데, 그러면
  // 결과를 보고 나서 컷 기준이나 자막 모양만 바꾸고 싶을 때 8GB 를 처음부터
  // 다시 올려야 했다. 하루 동안 남겨 두고 sweepOldSources() 가 치운다.

  // ── transcribe ── (비치명적)
  if (job.options.transcribe) {
    await runStage(job, "transcribe", () => transcribeStageFor(job, editedPath));
  } else {
    job.stages.transcribe = { status: "skipped", note: "옵션 OFF" };
  }

  // ── burn ── (비치명적) 자막 SRT 가 있어야 의미가 있다.
  await runOptionalStage(job, "burn", () => burnStageFor(job, editedPath));

  // ── shorts ── (비치명적) 릴스·틱톡용 세로본.
  await runOptionalStage(job, "shorts", () => shortsStageFor(job, editedPath));

  // ── thumbnail ── (비치명적)
  if (job.options.thumbnails) {
    await runStage(job, "thumbnail", () => thumbnailStageFor(job, editedPath));
  } else {
    job.stages.thumbnail = { status: "skipped", note: "옵션 OFF" };
  }

  // ── metadata ── (비치명적) 전사 결과에서 제목/설명/태그 생성.
  await runOptionalStage(job, "metadata", () => metadataStageFor(job));

  // ── upload ── (비치명적) 명시적 opt-in + 자격 증명이 있을 때만.
  // 검토를 켜 뒀고 실제로 올릴 수 있는 상태라면, 올리기 직전에 멈춰 세운다.
  const skipUpload = stageSkipReason(job, "upload");
  if (!skipUpload && job.options.reviewBeforeUpload) {
    await prepareReview(job);
  } else {
    await runOptionalStage(job, "upload", () => uploadStageFor(job, editedPath));
  }

  job.status = computeJobStatus(job);
  job.completedAt = Date.now();
  console.log(`[job ${id}] complete: ${job.status}`);
  saveJob(job);
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
  if (name === "shorts") {
    if (!o.shorts) return "옵션 OFF";
    if (job.stages.edit?.status !== "done") return "편집 단계가 성공해야 세로본 생성 가능";
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
  } else if (stage === "shorts") {
    await runOptionalStage(job, "shorts", () => shortsStageFor(job, editedPath));
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
    saveJob(job);
  } catch (e) {
    console.error(`[job ${job.id}] stage ${name} failed:`, e);
    job.stages[name] = {
      status: "failed",
      error: friendlyTranscribeError(e),
      startedAt: t0,
      completedAt: Date.now(),
    };
    // 실패 사유까지 담긴 뒤에 기록해야 한다. 앞에서 저장하면 "running" 인
    // 상태가 남아, 서버가 죽었을 때와 단계가 실패했을 때를 구분할 수 없다.
    saveJob(job);
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

// ── 세로본 (릴스 · 틱톡) ────────────────────────────────────────────────────
//
// 유튜브용 결과물은 16:9 다. 릴스와 틱톡은 9:16 이라 그대로 못 올린다.
// 원본을 다시 올리게 하는 대신, 이미 편집된 영상에서 세로본을 한 편 더 뽑는다.
//
// 어디를 자를지는 자막이 알려준다. 말이 제일 촘촘한 구간이 대개 설명이 붙는
// 대목이고, 소리 크기로 고르는 것보다 훨씬 정확하다 (에어컨 소리가 제일 큰
// 구간을 고르는 일이 없다).
const SHORTS_W = 1080;
const SHORTS_H = 1920;

function pickShortsWindow(segments, totalSec, lengthSec) {
  if (!segments?.length || totalSec <= lengthSec) return 0;
  // 문장 시작점만 후보로 둔다 — 말 중간에서 시작하면 무슨 얘긴지 알 수 없다.
  let bestStart = 0;
  let bestScore = -1;
  for (const seg of segments) {
    const start = Math.max(0, Math.min(seg.start, totalSec - lengthSec));
    const end = start + lengthSec;
    let score = 0;
    for (const s of segments) {
      // 창 안에 들어온 만큼만 센다. 걸친 문장은 걸친 비율만큼.
      const overlap = Math.min(s.end, end) - Math.max(s.start, start);
      if (overlap <= 0) continue;
      const dur = Math.max(0.01, s.end - s.start);
      score += (s.text || "").trim().length * (overlap / dur);
    }
    if (score > bestScore) { bestScore = score; bestStart = start; }
  }
  return bestStart;
}

// 16:9 를 9:16 으로 옮기는 두 가지 방법.
//
// crop 은 좌우를 3분의 2 가까이 잘라낸다 — 인물은 괜찮지만 집 내부 와이드샷은
// 반 이상이 사라진다. blur 는 화면 전체를 남기고 위아래를 흐린 배경으로 채운다.
// 집을 보여주는 게 목적이면 아무것도 안 잘리는 쪽이 기본이어야 한다.
function shortsFilter(fit) {
  if (fit === "crop") {
    return `scale=${SHORTS_W}:${SHORTS_H}:force_original_aspect_ratio=increase,` +
      `crop=${SHORTS_W}:${SHORTS_H},setsar=1`;
  }
  return (
    `split=2[bg][fg];` +
    `[bg]scale=${SHORTS_W}:${SHORTS_H}:force_original_aspect_ratio=increase,` +
    `crop=${SHORTS_W}:${SHORTS_H},boxblur=40:3[bgb];` +
    `[fg]scale=${SHORTS_W}:-2[fgs];` +
    `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1`
  );
}

// 줄바꿈을 직접 넣는다.
//
// ffmpeg 은 SRT 를 ASS 로 바꾸면서 스크립트 해상도를 늘 384x288 (4:3) 로 박는다.
// 그 4:3 캔버스를 9:16 화면에 펴 놓으니 가로와 세로의 배율이 달라져서, libass 는
// 화면이 아직 반이나 남았는데도 줄을 끊는다. 게다가 한글은 글자 사이 어디서나
// 끊을 수 있어 "가격에" 가 "가 / 격에" 로 갈라진다.
// 배율을 맞출 방법이 없으니 우리가 띄어쓰기에서 미리 끊고, libass 에게는
// WrapStyle=2 로 "네가 끊지 마라" 고 한다.
const SHORTS_WRAP_CHARS = 13;

function wrapCaption(text, maxChars = SHORTS_WRAP_CHARS) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (!cur) {
      cur = w;
    } else if (cur.length + 1 + w.length <= maxChars) {
      cur += " " + w;
    } else {
      lines.push(cur);
      cur = w;
    }
    // 띄어쓰기 없이 긴 낱말은 그냥 잘라 넘긴다 — 안 그러면 한 줄이 화면을 넘는다.
    while (cur.length > maxChars) {
      lines.push(cur.slice(0, maxChars));
      cur = cur.slice(maxChars);
    }
  }
  if (cur) lines.push(cur);
  return lines.join("\n");
}

// 잘라낼 구간에 걸치는 자막만 남기고 0초 기준으로 당긴다.
// 원본 SRT 를 그대로 쓰면 31초 지점부터 잘라낸 영상에 31초짜리 타임코드가
// 붙어서 자막이 아예 안 나온다.
function sliceSrt(segments, startSec, lengthSec) {
  const end = startSec + lengthSec;
  const lines = [];
  let n = 0;
  for (const s of segments || []) {
    if (s.end <= startSec || s.start >= end) continue;
    const from = Math.max(0, s.start - startSec);
    const to = Math.min(lengthSec, s.end - startSec);
    if (to - from < 0.05) continue;
    const text = wrapCaption(s.text);
    if (!text) continue;
    lines.push(`${++n}\n${srtTime(from)} --> ${srtTime(to)}\n${text}\n`);
  }
  return lines.join("\n");
}

function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const p = (v, n = 2) => String(v).padStart(n, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:` +
    `${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
}

async function shortsStageFor(job, editedPath) {
  // 자막을 구운 영상은 쓰지 않는다. 그걸 세로로 옮기면 자막까지 같이 줄거나
  // 잘린다 — 흐린 배경에서는 글자가 절반 크기가 되고, 좌우를 잘라내면 문장
  // 양끝이 화면 밖으로 나간다. 둘 다 실제로 그렇게 나왔다.
  // 세로로 옮긴 다음에 자막을 얹으면 세로 화면에 맞는 크기로 온전히 들어간다.
  const totalSec = job.stages.edit?.result?.durationSec || await probeDurationSec(editedPath);
  const lengthSec = Math.min(job.options.shortsLengthSec || 60, totalSec);
  const segments = job.stages.transcribe?.status === "done"
    ? job.stages.transcribe.result?.segments
    : null;
  const startSec = pickShortsWindow(segments, totalSec, lengthSec);

  let chain = `[0:v]${shortsFilter(job.options.shortsFit)}`;
  let withSubtitles = false;
  if (job.options.burn && segments?.length) {
    const srt = sliceSrt(segments, startSec, lengthSec);
    if (srt.trim()) {
      const srtPath = path.join(TMP, `${job.id}.shorts.srt`);
      await writeFile(srtPath, srt, "utf8");
      job.artifacts.push(srtPath);
      const escaped = srtPath.replace(/\\/g, "/").replace(/:/g, "\\:");
      // 세로 화면은 아래쪽 15% 쯤을 앱 UI(설명글·버튼)가 덮는다. 그 위로 올린다.
      // 글자는 폰으로 보는 화면이라 본편보다 키운다.
      const style = buildForceStyle(job.options.subtitleStyle, {
        frameH: SHORTS_H, fontScale: 1.4, marginVPx: 300, marginHPx: 60,
      }) + ",WrapStyle=2";
      chain += `,subtitles='${escaped}':force_style='${style}'`;
      withSubtitles = true;
    }
  }

  const out = path.join(TMP, `${job.id}.shorts.mp4`);
  const t0 = Date.now();
  job.stages.shorts.progress = { outTimeSec: 0, totalSec: lengthSec, pct: 0 };

  await runFFmpeg([
    "-nostdin",
    "-ss", startSec.toFixed(2),
    "-i", editedPath,
    "-t", lengthSec.toFixed(2),
    "-filter_complex", `${chain}[v]`,
    "-map", "[v]",
    "-map", "0:a?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart",
    "-progress", "pipe:2",
    "-y", out,
  ], {
    timeoutMs: 5 * 60 * 1000,
    onProgress: ({ outTimeSec }) => {
      job.stages.shorts.progress = {
        outTimeSec, totalSec: lengthSec,
        pct: Math.min(99, Math.round((outTimeSec / lengthSec) * 100)),
      };
    },
  });

  job.artifacts.push(out);
  return {
    _path: out,
    url: `/api/jobs/${job.id}/files/shorts.mp4`,
    startSec,
    lengthSec,
    fit: job.options.shortsFit,
    withSubtitles,
    sizeBytes: (await stat(out)).size,
    durationMs: Date.now() - t0,
  };
}

// 썸네일로 쓸 프레임을 뽑는다.
//
// 예전엔 480:-2 로 줄여서 저장했다. 목록에 늘어놓고 고르는 용도로만 생각한
// 크기였는데, 유튜브에 올리는 카드도 같은 파일을 썼다 — 1920 원본을 480 으로
// 줄였다가 1280 으로 다시 늘리니 화질의 1/16 만 남았고, 뭘 찍어도 뿌옇게
// 나왔다. 유튜브 썸네일 규격이 1280x720 이므로 그 이상으로 뽑는다.
const THUMB_WIDTH = 1280;

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
      "-q:v", "2",
      // 원본보다 크게 늘리지는 않는다 — 없는 화질이 생기지는 않는다.
      "-vf", `scale='min(${THUMB_WIDTH},iw)':-2`,
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

// 고를 수 있는 자막 서체. key 는 옵션에 실려 오는 값, family 는 fontconfig 이름.
const SUBTITLE_FONT_CHOICES = [
  { key: "gothic", label: "나눔고딕", family: "NanumGothic" },
  { key: "barungothic", label: "나눔바른고딕", family: "NanumBarunGothic" },
  { key: "square", label: "나눔스퀘어", family: "NanumSquare" },
  { key: "squareround", label: "나눔스퀘어라운드", family: "NanumSquareRound" },
  { key: "myeongjo", label: "나눔명조", family: "NanumMyeongjo" },
  { key: "gothicbold", label: "나눔고딕 굵게", family: "NanumGothicExtraBold" },
  // 이 둘만 이름에 띄어쓰기가 있다 — 붙여 쓰면 fc-match 가 엉뚱한 걸 돌려준다.
  { key: "pen", label: "나눔손글씨 펜", family: "Nanum Pen Script" },
  { key: "brush", label: "나눔손글씨 붓", family: "Nanum Brush Script" },
];

// 설치돼 있다고 확인된 것만 남긴다. libass 는 없는 서체를 지정하면 조용히 다른
// 걸로 대체하므로, 목록에만 있고 이미지엔 없는 서체를 고르면 아무 오류 없이
// 엉뚱한 글씨로 구워진다 — 40분짜리 인코딩을 끝내고 나서야 알게 된다.
let subtitleFonts = [{ key: "gothic", label: "나눔고딕", family: SUBTITLE_FONT }];

function fcMatchFamily(family) {
  return new Promise((resolve) => {
    const p = spawn("fc-match", ["-f", "%{family}", family], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.on("error", () => resolve(null));
    p.on("exit", () => resolve(out.trim()));
  });
}

(async () => {
  const found = [];
  for (const f of SUBTITLE_FONT_CHOICES) {
    // fc-match 는 못 찾아도 가장 비슷한 걸 돌려주므로, 이름이 실제로 일치하는지
    // 확인해야 한다. 별칭이 쉼표로 붙어 나오는 경우가 있어 갈라서 본다.
    const m = await fcMatchFamily(f.family);
    if (m && m.split(",").some((x) => x.trim().toLowerCase() === f.family.toLowerCase())) {
      found.push(f);
    }
  }
  if (found.length) subtitleFonts = found;
  console.log(`자막 서체 ${subtitleFonts.length}종: ${subtitleFonts.map((f) => f.family).join(", ")}`);
})();

function subtitleFontFamily(key) {
  return subtitleFonts.find((f) => f.key === key)?.family || SUBTITLE_FONT;
}

// ffmpeg 이 SRT 를 ASS 로 바꿀 때 스크립트 해상도를 항상 384x288 로 박아 넣는다
// (probe: "PlayResX: 384 / PlayResY: 288"). 그래서 FontSize/MarginV/Outline 은
// 픽셀이 아니라 288 높이 기준 단위다 — FontSize=48 을 그대로 주면 1080p 에서
// 180px 짜리 글자가 나와 화면을 잡아먹는다. UI 는 "1080p 픽셀"로 받고 여기서
// 한 번만 환산한다.
const ASS_PLAY_RES_Y = 288;
// px 는 "결과물 높이 기준 픽셀"이다. 가로 영상은 1080 높이가 기준이고, 세로본은
// 1920 이라 같은 값을 쓰면 글자가 1.8배로 커진다.
const pxToAssAt = (px, frameH) => Math.max(0, (Number(px) || 0) * (ASS_PLAY_RES_Y / frameH));
const pxToAss = (px) => pxToAssAt(px, 1080);

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
    font: SUBTITLE_FONT_CHOICES.some((f) => f.key === o.font) ? o.font : "gothic",
    color: /^#?[0-9a-f]{6}$/i.test(o.color || "") ? o.color : "#ffffff",
    // 외곽선 색. 예전엔 검정으로 박혀 있어서 밝은 배경에서 글자가 묻혔다.
    outlineColor: /^#?[0-9a-f]{6}$/i.test(o.outlineColor || "") ? o.outlineColor : "#000000",
    // "outline" = 글자 외곽선만 / "box" = 반투명 배경 박스
    background: o.background === "box" ? "box" : "outline",
    boxColor: /^#?[0-9a-f]{6}$/i.test(o.boxColor || "") ? o.boxColor : "#000000",
    boxOpacity: clamp(parseInt(o.boxOpacity, 10) || 60, 0, 100),
    outline: clamp(Number(o.outline) || 6, 0, 24),
    marginV: clamp(parseInt(o.marginV, 10) || 60, 0, 500),
    bold: o.bold === true,
  };
}

function buildForceStyle(style, {
  frameH = 1080, fontScale = 1, marginVPx = null, marginHPx = null,
} = {}) {
  const st = sanitizeSubtitleStyle(style);
  const px = (v) => pxToAssAt(v, frameH);
  const parts = [
    `FontName=${subtitleFontFamily(st.font)}`,
    `FontSize=${px(st.fontSize * fontScale).toFixed(1)}`,
    `PrimaryColour=${assColour(st.color, 100)}`,
    `Bold=${st.bold ? -1 : 0}`,
    `MarginV=${Math.round(px(marginVPx ?? st.marginV))}`,
    "Shadow=0",
  ];
  // 줄바꿈 위치는 좌우 여백이 정한다. 한글은 글자 사이 어디서나 끊을 수 있어서
  // 여백을 안 주면 "가격에" 가 "가 / 격에" 로 갈라진다.
  if (marginHPx != null) {
    parts.push(`MarginL=${Math.round(px(marginHPx))}`, `MarginR=${Math.round(px(marginHPx))}`);
  }
  if (st.background === "box") {
    // BorderStyle=3(불투명 박스)에서 libass 는 박스를 BackColour 가 아니라
    // OutlineColour 로 칠한다. BackColour 만 지정하면 사용자가 무슨 색을 골라도
    // 항상 기본값(검정)으로 나온다 — 실제로 빨강/파랑을 넣어 렌더해 확인했다.
    // 다른 렌더러 호환을 위해 둘 다 같은 값으로 채운다. Outline 은 박스 여백.
    const box = assColour(st.boxColor, st.boxOpacity);
    // Outline 은 여기서 박스 안쪽 여백 — 1080p 기준 10px 정도가 보기 좋다.
    parts.push("BorderStyle=3", `OutlineColour=${box}`, `BackColour=${box}`,
      `Outline=${px(10).toFixed(1)}`);
  } else {
    parts.push("BorderStyle=1", `OutlineColour=${assColour(st.outlineColor, 100)}`,
      `Outline=${px(st.outline * fontScale).toFixed(1)}`);
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

  // 번인은 편집과 같은 길이를 통째로 다시 인코딩한다 — 즉 편집만큼 오래 걸린다.
  // 진행률을 안 내보내면 그동안 "진행 중"만 떠서 멎은 것과 구분이 안 된다.
  const totalSec = job.stages.edit?.result?.durationSec || 0;
  job.stages.burn.progress = { outTimeSec: 0, totalSec, pct: 0 };

  await runFFmpeg([
    "-i", editedPath,
    "-vf", `subtitles='${escapedSrt}':force_style='${buildForceStyle(job.options.subtitleStyle)}'`,
    "-c:v", "libx264", "-preset", "veryfast",
    "-crf", String(QUALITY_CRF[job.options.quality] ?? 20),
    "-c:a", "copy",
    "-movflags", "+faststart",
    "-progress", "pipe:2",
    "-y", out,
  ], {
    // 편집 단계와 같은 기준 — 전체 제한이 아니라 "5분 동안 아무 진전이 없으면".
    timeoutMs: 5 * 60 * 1000,
    onProgress: ({ outTimeSec }) => {
      const pct = totalSec > 0 ? Math.min(99, Math.round((outTimeSec / totalSec) * 100)) : 0;
      job.stages.burn.progress = { outTimeSec, totalSec, pct };
    },
  });
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

  // 설명글은 모델이 통째로 쓰지 않는다. 모델은 조각(한 줄 요약·소개·제원·챕터)만
  // 만들고, 채널 고유의 문구와 링크는 사용자가 UI 에서 관리하는 템플릿이 갖는다.
  // 템플릿이 없으면 조각을 최소한으로 이어 붙여 예전 형태를 유지한다.
  const vars = descriptionVarsFrom(meta, job.options.channel || {});
  meta.description = job.options.descriptionTemplate
    ? fillDescriptionTemplate(job.options.descriptionTemplate, vars)
    : [meta.oneLiner, "", meta.intro, "",
       ...(meta.chapters || []).map((c) => `${c.time} ${c.title}`)]
        .join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const metaPath = path.join(TMP, `${job.id}.metadata.json`);
  await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
  job.artifacts.push(metaPath);
  return { ...meta, url: `/api/jobs/${job.id}/files/metadata.json` };
}

// ── 업로드 전 검토 ──────────────────────────────────────────────────────────
//
// 유튜브에 올라간 영상은 파일을 못 바꾼다. 제목·설명·태그·썸네일은 나중에도
// 덮어쓸 수 있지만, 화면이 틀렸으면 새 영상으로 다시 올리는 수밖에 없다.
// 그래서 마지막에 한 번 멈춰서, 실제로 올라갈 것들을 그대로 보여주고 고치게
// 한다. 여기서 만들어 두는 값이 곧 uploadStageFor 가 쓰는 값이다.

// 추출된 프레임 파일 경로. 없는 번호를 고르면 null.
function reviewFramePath(job, index) {
  const n = job.stages.thumbnail?.result?.urls?.length || 0;
  const i = Math.max(0, Math.min(n - 1, Number(index) || 0));
  if (n === 0) return null;
  const p = path.join(TMP, `${job.id}.thumb_${i}.jpg`);
  return existsSync(p) ? p : null;
}

// 고른 프레임 위에 문구를 얹은 카드를 만든다. 실패해도 던지지 않는다 —
// 카드는 덤이고, 못 만들면 원본 사진으로 올리면 된다.
async function rebuildReviewCard(job) {
  const rv = job.review;
  if (!rv) return null;
  const frame = reviewFramePath(job, rv.frameIndex);
  if (!frame) {
    rv.card = { error: "썸네일 프레임이 없습니다." };
    return rv.card;
  }
  const cardPath = path.join(TMP, `${job.id}.thumb_card.jpg`);
  const card = await composeThumbnailCard({
    image: frame,
    out: cardPath,
    line1: rv.lines[0] || "",
    line2: rv.lines[1] || null,
    line3: rv.lines[2] || null,
    pythonBin: PYTHON_BIN,
  });
  if (card.ok) {
    if (!job.artifacts.includes(cardPath)) job.artifacts.push(cardPath);
    rv.cardVersion = (rv.cardVersion || 0) + 1;
    rv.card = { font: card.font, sizes: card.sizes, bytes: card.bytes };
    console.log(`[job ${job.id}] 썸네일 카드 생성 (${card.font}, ${card.sizes.join("/")}px)`);
  } else {
    rv.card = { error: card.error };
    console.warn(`[job ${job.id}] 썸네일 카드 실패: ${card.error}`);
  }
  return rv.card;
}

async function prepareReview(job) {
  const meta = job.stages.metadata?.status === "done" ? job.stages.metadata.result : {};
  const frames = job.stages.thumbnail?.result?.urls || [];
  job.review = {
    title: uploadTitleFor(job) || "",
    description: meta.description || "",
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    privacy: job.options.privacy,
    // 프레임이 아예 없으면 얹을 자리도 없다.
    thumbnail: frames.length ? "card" : "none",
    frameIndex: 0,
    lines: [
      meta.thumbnailLine1 || meta.thumbnailCopy || "",
      meta.thumbnailLine2 || meta.thumbnailSubcopy || "",
      meta.thumbnailLine3 || "",
    ],
    cardVersion: 0,
    card: null,
  };
  if (frames.length) await rebuildReviewCard(job);
  job.stages.upload = { status: "review", note: "검토 대기 — 확인 후 업로드하세요." };
  job.status = "review";
  console.log(`[job ${job.id}] 업로드 전 검토 대기`);
  saveJob(job);
}

// 검토에서 고른 값을 실제 업로드 인자로 바꾼다. 검토를 끄고 돌렸으면 review 가
// 없으므로, 그때는 메타데이터 단계 결과를 그대로 쓰고 카드도 여기서 만든다.
async function uploadInputsFor(job) {
  const meta = job.stages.metadata?.result || {};
  if (job.review) {
    const rv = job.review;
    const thumbnailPath =
      rv.thumbnail === "card" ? path.join(TMP, `${job.id}.thumb_card.jpg`)
      : rv.thumbnail === "raw" ? reviewFramePath(job, rv.frameIndex)
      : null;
    return {
      title: rv.title || uploadTitleFor(job),
      description: rv.description || "",
      tags: rv.tags || [],
      privacy: rv.privacy || job.options.privacy,
      thumbnailPath,
      thumbnailCard: rv.card,
    };
  }

  // 추출된 사진은 그대로 두고, 그 위에 문구를 얹은 카드를 한 장 더 만든다.
  // 원본이 남아 있어야 문구만 바꿔 다시 만들 수 있다.
  const rawThumb = job.stages.thumbnail?.status === "done"
    ? path.join(TMP, `${job.id}.thumb_0.jpg`)
    : null;
  let thumbnailPath = rawThumb && existsSync(rawThumb) ? rawThumb : null;
  let thumbnailCard = null;
  if (thumbnailPath) {
    job.review = {
      frameIndex: 0,
      lines: [
        meta.thumbnailLine1 || meta.thumbnailCopy || "",
        meta.thumbnailLine2 || meta.thumbnailSubcopy || "",
        meta.thumbnailLine3 || "",
      ],
      cardVersion: 0,
    };
    thumbnailCard = await rebuildReviewCard(job);
    const cardPath = path.join(TMP, `${job.id}.thumb_card.jpg`);
    // 카드는 덤이다. 못 만들어도 사진으로 올린다.
    if (thumbnailCard && !thumbnailCard.error && existsSync(cardPath)) thumbnailPath = cardPath;
    job.review = null;
  }
  return {
    title: uploadTitleFor(job),
    description: meta.description || "",
    tags: meta.tags || [],
    privacy: job.options.privacy,
    thumbnailPath,
    thumbnailCard,
  };
}

// YouTube 업로드. 자막 번인본이 있으면 그쪽을 올린다 (사용자가 번인을 요청한
// 이상 그게 최종 산출물이므로).
async function uploadStageFor(job, editedPath) {
  const burned = job.stages.burn?.status === "done" ? job.stages.burn.result?._path : null;
  const videoPath = burned && existsSync(burned) ? burned : editedPath;
  const inputs = await uploadInputsFor(job);

  const result = await uploadVideo({
    videoPath,
    title: inputs.title,
    description: inputs.description,
    tags: inputs.tags,
    privacy: inputs.privacy,
    publishAtIso: job.options.publishAt,
    thumbnailPath: inputs.thumbnailPath && existsSync(inputs.thumbnailPath) ? inputs.thumbnailPath : null,
    onProgress: ({ uploaded, total }) => {
      console.log(`[job ${job.id}] upload ${((uploaded / total) * 100).toFixed(0)}%`);
    },
  });
  return { ...result, thumbnailCard: inputs.thumbnailCard };
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

// 원본이 "몇 p" 인지. 세로로 찍은 영상은 height 가 긴 쪽이라 그것만 보면
// 1080x1920 짜리를 1920p 로 오해한다 — 720p/1080p 는 늘 짧은 변 기준이다.
// 못 읽으면 0 을 돌려준다. 여기서 실패했다고 인코딩까지 막을 이유는 없고,
// 0 이면 화질을 낮추지 않고 요청대로 간다.
function probeVideoHeight(file) {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=p=0",
      file,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.on("error", () => resolve(0));
    p.on("exit", (code) => {
      if (code !== 0) return resolve(0);
      const [w, h] = out.trim().split("\n")[0].split(",").map((n) => parseInt(n, 10) || 0);
      resolve(w && h ? Math.min(w, h) : 0);
    });
  });
}

const server = app.listen(PORT, () => {
  console.log(`AI Video Editor backend listening on :${PORT}`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
  if (tiktokConfigured()) {
    refreshTiktokState().then((c) => {
      console.log(`[tiktok] 자격 증명 있음 · 계정 연결 ${c ? "됨" : "안 됨"}` +
        `${tiktokStoreReady() ? "" : " · 경고: 보관함이 없어 재시작하면 연결이 끊깁니다"}`);
    });
  }
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
  const asked = QUALITY_SIZES[opts.quality] ? opts.quality : "1080p";
  // 원본보다 큰 화질을 고르면 여기서 내린다. 안 그러면 없는 화질을 만드느라
  // 몇 시간을 더 쓰고 결과는 똑같다.
  const sourceHeight = await probeVideoHeight(input);
  const quality = capQualityToSource(asked, sourceHeight);
  if (quality !== asked) {
    console.log(`[encode] 원본 ${sourceHeight}p — ${asked} 요청을 ${quality} 로 낮춥니다 (확대해도 화질은 안 늘어납니다).`);
  }

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
  // 실제로 쓴 화질을 돌려준다 — 요청과 다를 수 있고, 다르면 화면에 알려야 한다.
  return { quality, requestedQuality: asked, sourceHeight };
}

// 출력 해상도표. 세로 기준(720p/1080p)으로 비율마다 목표 크기를 잡는다.
const QUALITY_SIZES = {
  "720p":  { "16:9": [1280, 720],   "9:16": [720, 1280],   "1:1": [720, 720] },
  "1080p": { "16:9": [1920, 1080],  "9:16": [1080, 1920],  "1:1": [1080, 1080] },
  "1440p": { "16:9": [2560, 1440],  "9:16": [1440, 2560],  "1:1": [1440, 1440] },
  "4k":    { "16:9": [3840, 2160],  "9:16": [2160, 3840],  "1:1": [2160, 2160] },
};
// 해상도가 올라가면 같은 CRF 에서도 눈에 보이는 결점이 줄어든다. 한 단계마다
// 1 씩 올려서 파일 크기와 인코딩 시간을 아낀다.
const QUALITY_CRF = { "720p": 21, "1080p": 20, "1440p": 21, "4k": 22 };

// 화질 순서. 원본보다 큰 값을 고르면 이 순서를 따라 내려간다.
const QUALITY_ORDER = ["720p", "1080p", "1440p", "4k"];

// 원본에 없는 화질은 만들어 낼 수 없다.
//
// 1080p 로 찍은 걸 4K 로 뽑으면 픽셀만 늘어나고 화질은 그대로인데, 인코딩은
// 세 배 가까이 오래 걸린다 — 10분짜리면 두 시간을 더 태우고 얻는 게 없다.
// 그래서 원본 세로 해상도를 넘는 선택은 조용히 한 단계씩 낮춘다.
function capQualityToSource(quality, sourceHeight) {
  if (!sourceHeight || !QUALITY_SIZES[quality]) return quality;
  let q = quality;
  for (;;) {
    const target = Math.min(...QUALITY_SIZES[q]["16:9"]);
    // 살짝 모자란 원본(1080p 라고 하지만 1078px 같은 경우)까지 내리지는 않는다.
    if (target <= sourceHeight * 1.02) return q;
    const i = QUALITY_ORDER.indexOf(q);
    if (i <= 0) return q;
    q = QUALITY_ORDER[i - 1];
  }
}

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
