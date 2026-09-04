// 브라우저에서 ffmpeg.wasm 으로 무음 컷·비율 변환·숏폼 추출을 수행하는 클라이언트.
// 외부 의존: window.FFmpegWASM, window.FFmpegUtil (UMD via index.html)

const { FFmpeg } = window.FFmpegWASM;
const { fetchFile, toBlobURL } = window.FFmpegUtil;

// 일부 환경(macOS/Safari, iCloud·사진 라이브러리에서 선택한 파일, 큰 파일,
// 네트워크 드라이브)에서 @ffmpeg/util 의 fetchFile 이 내부적으로 쓰는
// FileReader 가 "File could not be read! Code=-1" 로 실패한다.
// File.arrayBuffer() 를 먼저 시도하고 실패 시 fetchFile 로 폴백한다.
async function readFileBytes(file) {
  try {
    if (file && typeof file.arrayBuffer === "function") {
      return new Uint8Array(await file.arrayBuffer());
    }
  } catch (e) {
    console.warn("arrayBuffer() failed, falling back to fetchFile:", e);
  }
  try {
    return await fetchFile(file);
  } catch (e) {
    throw new Error(
      "파일을 읽을 수 없습니다. iCloud/사진 라이브러리/네트워크 드라이브 등에 있는 " +
      "파일이라면 로컬 폴더(Downloads, Desktop)로 옮긴 뒤 다시 시도해 주세요. " +
      "원본 오류: " + (e?.message || e)
    );
  }
}

// 백엔드 서버 URL (고속 모드용). 비어 있으면 백엔드 모드 비활성.
// localStorage("backendUrl") 로 사용자가 덮어쓸 수 있음.
const DEFAULT_BACKEND_URL = "https://ai-video-editor-api.onrender.com";
const BACKEND_URL = localStorage.getItem("backendUrl") || DEFAULT_BACKEND_URL;

// jsDelivr 는 cross-origin 리소스에 적절한 CORP 헤더를 일관되게 보냄.
// unpkg 보다 ffmpeg.wasm 로드 호환성이 높음.
// mt = multi-thread (기본, SharedArrayBuffer 필요), st = single-thread (fallback).
const FFMPEG_CORE_MT = "https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.6/dist/umd";
const FFMPEG_CORE_ST = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd";
// 하위 호환 (이미 다른 곳에서 참조될 수 있어 alias 유지)
const FFMPEG_CORE_BASE = FFMPEG_CORE_MT;

// ── DOM ──────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const dropzone = $("dropzone");
const fileInput = $("fileInput");
const pickBtn = $("pickBtn");
const controls = $("controls");
const runBtn = $("runBtn");
const resetBtn = $("resetBtn");
const progress = $("progress");
const bar = $("bar");
const statusEl = $("status");
const logEl = $("log");
const resultSection = $("result");
const resultVideo = $("resultVideo");
const downloadBtn = $("downloadBtn");
const exportDraftBtn = $("exportDraftBtn");
const resultStats = $("resultStats");
const stepper = $("stepper");
const thumbsBlock = $("thumbsBlock");
const thumbsGrid = $("thumbsGrid");
const bgmInput = $("bgmInput");
const bgmPickBtn = $("bgmPickBtn");
const bgmClearBtn = $("bgmClearBtn");
const bgmStatusEl = $("bgmStatus");

// ── State ────────────────────────────────────────────────────────────────────
let ffmpeg = null;
let ffmpegEngine = null; // "mt" | "st"
// pickedFiles 가 source of truth. pickedFile 은 pickedFiles[0] 의 별칭(편의용).
let pickedFiles = [];
// 서버 multer 상한과 같은 값. 이걸 넘으면 업로드 자체가 거부되므로 편집을 시작할
// 이유가 없다. 브라우저도 그 전에 죽는다 — 8GB 파일에서 file.arrayBuffer() 가
// NotReadableError 를 던지는데, 그 에러 문구가 "permission problems" 라서
// 원인을 짐작할 수가 없다.
let MAX_UPLOAD_MB = 500;   // /api/health 의 limits.maxUploadMb 로 갱신된다
// 브라우저에서 음량을 분석하려면 파일 전체를 메모리에 올려야 한다. 이 크기를 넘으면
// 분석을 서버에 맡긴다 — ffmpeg 는 오디오만 스트리밍으로 훑어서 크기 제한이 없다.
const BROWSER_ANALYSIS_LIMIT_MB = 400;

function oversizeMessage(totalMb) {
  return `파일이 ${totalMb.toFixed(0)}MB 입니다. 서버 업로드 상한은 ${MAX_UPLOAD_MB}MB 라 이대로는 처리할 수 없습니다.\n\n` +
    `해결 방법:\n` +
    `1) 화질을 낮춰 다시 내보내기 — 4K/고비트레이트 원본을 1080p 로 다시 쓰면 보통 10~20배 줄어듭니다 (화질 손해는 거의 없습니다).\n` +
    `2) 영상을 나눠서 따로 돌리기.\n\n` +
    `참고: 브라우저가 음량을 분석할 때 파일 전체를 메모리에 올리기 때문에, 길이도 30분 이내를 권장합니다.`;
}
let pickedFile = null;
let pickedDuration = 0; // 다중 입력 시 합산 길이
let lastKeeps = [];
let outputUrl = null;
let originalUrl = null;
let previewMode = "edited"; // "edited" | "original"
let bgmFile = null;
let thumbUrls = [];
// 자막 상태. <track> 부착 + 다운로드 버튼 + 디버그용 JSON 전체를 한 곳에서 관리.
let subtitleSrtText = "";
let subtitleVttText = "";
let subtitleJson = null;     // /api/transcribe 응답 전체 (segments / words / language ...)
let subtitleSrtUrl = null;
let subtitleVttUrl = null;
// 자막 생성 마지막 결과 사유 — "완료!" 가 에러를 덮어쓰지 않도록 보존.
let lastSubtitleStatus = null; // null | { ok: true, count, ms } | { ok: false, reason }

// 자막 파이프라인 단계별 상태 (진단 패널용). key 별로 status + detail 보관.
// status: "pending" | "running" | "ok" | "warn" | "error"
const SUB_STEP_ORDER = [
  ["option",        "1. 자동 자막 옵션"],
  ["api_base",      "2. API_BASE_URL"],
  ["health",        "3. /api/health 응답"],
  ["jobs_route",    "4. /api/transcribe/jobs 라우트 등록"],
  ["whisper_install", "5. 백엔드 faster-whisper 설치"],
  ["job_register",  "6. POST /api/transcribe/jobs"],
  ["whisper",       "7. Whisper 처리 (폴링)"],
  ["srt_text",      "8. SRT 텍스트 길이"],
  ["vtt_text",      "9. VTT 텍스트 길이"],
  ["blob",          "10. Blob URL 생성"],
  ["buttons",       "11. SRT/VTT 버튼 활성화"],
  ["track",         "12. <video> track src 연결"],
  ["burn",          "13. 자막 번인 (옵션)"],
];
const subtitleSteps = new Map();
let subtitleDebugBanner = "";
// 백엔드 헬스체크 캐시 — 한 세션 내 중복 호출 방지.
let backendHealthCache = null; // { ok, routes, checkedAt } | { ok: false, error }

const state = {
  preset: "standard",
  ratio: "16:9",
  quality: "1080p",
  mode: "full",
  speed: 1.0,
  filler: "off", // "off" | "conservative" | "aggressive"
};

// 백엔드 분석 결과를 보관 (편집 후 결과 패널 렌더링용)
let lastEditPlan = null;

// ── Sliders ──────────────────────────────────────────────────────────────────
const sliders = [
  ["silenceDb", "silenceDbVal", (v) => `${v} dB`],
  ["minSilence", "minSilenceVal", (v) => `${parseFloat(v).toFixed(1)} s`],
  ["padding", "paddingVal", (v) => `${parseFloat(v).toFixed(2)} s`],
  ["shortLen", "shortLenVal", (v) => `${v} s`],
  ["bgmVol", "bgmVolVal", (v) => `${v} dB`],
  ["subFontSize", "subFontSizeVal", (v) => `${v} px`],
  ["subMarginV", "subMarginVVal", (v) => `${v} px`],
  ["subBoxOpacity", "subBoxOpacityVal", (v) => `${v}%`],
];
for (const [src, label, fmt] of sliders) {
  const s = $(src), l = $(label);
  s.addEventListener("input", () => (l.textContent = fmt(s.value)));
}

// ── Chip groups (preset / ratio / mode) ──────────────────────────────────────
function bindChips(attr, key) {
  document.querySelectorAll(`[data-${attr}]`).forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll(`[data-${attr}]`)
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state[key] = btn.dataset[attr];
      if (attr === "preset") applyPreset(state.preset);
      if (attr === "mode") {
        // 숏폼 모드는 9:16이 기본 — 자동 전환
        if (state.mode === "short" && state.ratio === "16:9") {
          document.querySelector('[data-ratio="9:16"]').click();
        }
      }
    });
  });
}
bindChips("preset", "preset");
bindChips("ratio", "ratio");
bindChips("quality", "quality");
bindChips("mode", "mode");
bindChips("speed", "speed");
bindChips("filler", "filler");

// ── 원본/편집본 미리보기 탭 ─────────────────────────────────────────────────
// 결과 video 태그 하나의 src 만 갈아끼운다 — 두 영상을 동시에 로드하지 않아 메모리 안전.
function setPreviewMode(mode) {
  const url = mode === "original" ? originalUrl : outputUrl;
  if (!url) return;
  previewMode = mode;
  // 새 src 적용 시 자동으로 처음부터 재생 위치가 0 이 됨 (의도).
  resultVideo.src = url;
  resultVideo.load();
  document.querySelectorAll(".preview-tabs [data-preview]").forEach((btn) => {
    const active = btn.dataset.preview === mode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  // 자막은 편집본 timeline 기준이므로 원본 탭에선 표시하지 않는다.
  // edited 탭에 다시 들어오면 vttUrl 로 track 재부착.
  if (mode === "original") {
    resultVideo.querySelectorAll("track").forEach((t) => t.remove());
  } else if (subtitleVttUrl) {
    attachVttTrack(subtitleVttUrl);
  }
}
document.querySelectorAll(".preview-tabs [data-preview]").forEach((btn) => {
  btn.addEventListener("click", () => setPreviewMode(btn.dataset.preview));
});
// 속도는 숫자
const _origSpeedHandler = state.speed;
document.querySelectorAll("[data-speed]").forEach((btn) => {
  btn.addEventListener("click", () => { state.speed = parseFloat(btn.dataset.speed); });
});

function applyPreset(name) {
  const presets = {
    fast:     { db: -28, min: 0.4, pad: 0.05 },
    standard: { db: -32, min: 0.6, pad: 0.10 },
    strict:   { db: -36, min: 0.8, pad: 0.15 },
  };
  const p = presets[name];
  if (!p) return;
  $("silenceDb").value = p.db; $("silenceDbVal").textContent = `${p.db} dB`;
  $("minSilence").value = p.min; $("minSilenceVal").textContent = `${p.min.toFixed(1)} s`;
  $("padding").value = p.pad; $("paddingVal").textContent = `${p.pad.toFixed(2)} s`;
}

// ── ffmpeg.wasm 로드 ─────────────────────────────────────────────────────────
async function ensureFFmpeg(engine = "mt") {
  if (ffmpeg && ffmpegEngine === engine) return ffmpeg;
  // 다른 엔진 요청 시 기존 인스턴스 폐기
  if (ffmpeg) {
    try { ffmpeg.terminate?.(); } catch {}
    ffmpeg = null;
    ffmpegEngine = null;
  }
  // mt 는 cross-origin isolated 필수, st 는 불필요. 페이지가 isolated 면 mt 부터 시도.
  if (engine === "mt" && !window.crossOriginIsolated) {
    // 페이지가 isolated 가 아니면 자동으로 st 로 강등
    engine = "st";
  }
  setStep("load");
  setStatus(`ffmpeg 엔진 로드 중... (${engine === "mt" ? "멀티스레드" : "싱글스레드"}, 최초 1회 ~30MB)`);
  const instance = new FFmpeg();
  instance.on("log", ({ message }) => appendLog(message));
  const base = engine === "mt" ? FFMPEG_CORE_MT : FFMPEG_CORE_ST;
  try {
    if (engine === "mt") {
      const [coreURL, wasmURL, workerURL] = await Promise.all([
        toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
        toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
        toBlobURL(`${base}/ffmpeg-core.worker.js`, "text/javascript"),
      ]);
      await instance.load({ coreURL, wasmURL, workerURL });
    } else {
      // 싱글스레드 코어는 worker 없이 로드. 더 느리지만 deadlock 가능성 낮음.
      const [coreURL, wasmURL] = await Promise.all([
        toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
        toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
      ]);
      await instance.load({ coreURL, wasmURL });
    }
  } catch (e) {
    // 로드 실패 시 다음 시도가 깨끗하게 다시 시작하도록 인스턴스 폐기
    ffmpeg = null;
    ffmpegEngine = null;
    throw new Error(
      "ffmpeg 엔진 로드 실패: " + (e?.message || e) +
      "\n네트워크 또는 CDN 차단(광고 차단기/회사 방화벽) 가능성. 새로고침 후 다시 시도해 주세요."
    );
  }
  ffmpeg = instance;
  ffmpegEngine = engine;
  doneStep("load");
  return ffmpeg;
}

// ── Dropzone & file picker ───────────────────────────────────────────────────
// 단일 파일 호환을 위해 handleFile 도 alias 로 유지.
function handleFile(file) { return handleFiles(file ? [file] : []); }

function handleFiles(files) {
  // 영상 파일만 통과시킴. 순서는 사용자가 선택한 순서대로 유지.
  const accepted = (files || []).filter((f) => f && f.type && f.type.startsWith("video/"));
  if (accepted.length === 0) {
    setStatus("영상 파일이 아닙니다.");
    return;
  }
  // 이전 선택의 미리보기 URL + 자막 상태 정리 (메모리 누수 방지).
  if (originalUrl) { URL.revokeObjectURL(originalUrl); originalUrl = null; }
  if (outputUrl) { URL.revokeObjectURL(outputUrl); outputUrl = null; }
  resetSubtitleState();

  pickedFiles = accepted;
  pickedFile = accepted[0]; // 단일 호환 별칭 — 파이프라인은 pickedFiles 를 본다.
  // 미리보기는 일단 첫 번째 영상을 보여줌. 다중 입력이면 편집 후 편집본은 합쳐진 결과.
  originalUrl = URL.createObjectURL(accepted[0]);

  controls.hidden = false;
  resultSection.hidden = true;
  progress.hidden = true;

  const totalMb = accepted.reduce((a, f) => a + f.size, 0) / 1024 / 1024;
  if (accepted.length === 1) {
    document.querySelector(".dz-title").textContent = `✓ ${accepted[0].name}`;
    document.querySelector(".dz-sub").textContent =
      `${totalMb.toFixed(1)} MB · 다른 파일을 드래그하면 교체됩니다`;
  } else {
    document.querySelector(".dz-title").textContent = `✓ ${accepted.length}개 영상 선택됨`;
    document.querySelector(".dz-sub").innerHTML =
      `총 ${totalMb.toFixed(1)} MB · 업로드 순서대로 자동 병합됩니다<br>` +
      accepted.map((f, i) => `<span class="file-row">${i + 1}. ${escapeHtml(f.name)} (${(f.size / 1024 / 1024).toFixed(1)} MB)</span>`).join("");
  }
  validatePickedSize();

  // 부드럽게 컨트롤로 스크롤
  controls.scrollIntoView({ behavior: "smooth", block: "start" });
}

// 상한 초과는 편집을 시작하기 전에 알려준다. 8GB 파일을 골라놓고 "자동 편집 시작"
// 을 누른 뒤에야 알게 되면, 그때는 이미 브라우저가 몇 분 매달린 뒤다.
//
// 서버 상한(MAX_UPLOAD_MB)은 /api/health 를 받아야 알 수 있는데 그건 비동기다.
// 그래서 파일을 놓는 시점엔 아직 기본값(500)일 수 있다 — 실제로 서버 상한을
// 10GB 로 올린 뒤에도 "상한은 500MB" 경고가 그대로 떴다. health 가 도착하면
// 이 함수를 다시 불러 판정을 갱신한다.
function validatePickedSize() {
  if (pickedFiles.length === 0) return;
  const totalMb = pickedFiles.reduce((a, f) => a + f.size, 0) / 1024 / 1024;
  if (totalMb > MAX_UPLOAD_MB) {
    setStatus(oversizeMessage(totalMb));
    progress.hidden = false;
    runBtn.disabled = true;
  } else {
    // 직전 판정의 경고가 남아 있을 수 있다 — 통과했으면 지운다.
    if (/업로드 상한/.test(statusEl.textContent)) {
      setStatus("");
      progress.hidden = true;
    }
    runBtn.disabled = false;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});
pickBtn.addEventListener("click", (e) => { e.stopPropagation(); fileInput.click(); });
fileInput.addEventListener("change", () => handleFiles(Array.from(fileInput.files || [])));

["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("drag");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag");
  })
);
dropzone.addEventListener("drop", (e) => {
  const list = Array.from(e.dataTransfer?.files || []);
  if (list.length) handleFiles(list);
});

// BGM 파일 선택
bgmPickBtn.addEventListener("click", () => bgmInput.click());
bgmInput.addEventListener("change", () => {
  const f = bgmInput.files[0];
  if (!f) return;
  bgmFile = f;
  bgmStatusEl.textContent = `${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)`;
  bgmStatusEl.classList.add("has-file");
  bgmClearBtn.hidden = false;
});
bgmClearBtn.addEventListener("click", () => {
  bgmFile = null;
  bgmInput.value = "";
  bgmStatusEl.textContent = "없음";
  bgmStatusEl.classList.remove("has-file");
  bgmClearBtn.hidden = true;
});

// 페이지 어디서든 드래그 가능하도록 (드롭존 외부)
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  const list = Array.from(e.dataTransfer?.files || []).filter((f) => f.type?.startsWith("video/"));
  if (list.length) handleFiles(list);
});

// app.js 는 부트스트랩이 동적으로 주입하므로 DOMContentLoaded 가 이미 지나간
// 뒤에 실행되는 경우가 많다. 그때는 즉시 실행해야 초기화가 누락되지 않는다.
function onReady(fn) {
  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", fn, { once: true });
  } else {
    fn();
  }
}

onReady(() => {
  const hint = $("backendHint");
  if (!BACKEND_URL) {
    if (hint) hint.textContent = "* 백엔드 URL 이 설정되지 않았습니다. localStorage.setItem('backendUrl','https://...') 또는 코드 DEFAULT_BACKEND_URL 변경 필요.";
  } else if (hint) {
    hint.textContent = `* 영상이 일시 서버를 거칩니다 (HTTPS, 처리 후 1시간 내 자동 삭제). 백엔드: ${BACKEND_URL}`;
  }
  wireQueueStageOptions();
  // 탭을 새로 고쳤거나 닫았다 열었으면, 서버에서 아직 돌고 있는 작업에 다시 붙는다.
  resumeActiveJob().catch((e) => console.warn("이전 작업 복구 실패:", e));
});

// 큐 모드에서만 의미 있는 후속 단계 옵션(메타데이터/업로드) 카드를 토글하고,
// 백엔드가 실제로 그 단계를 돌릴 수 있는지(/api/health)를 반영한다.
function wireQueueStageOptions() {
  const queue = $("queueMode");
  const card = $("queueStagesCard");
  if (!queue || !card) return;

  let capsLoaded = false;
  const sync = async () => {
    card.hidden = !queue.checked;
    if (!queue.checked || capsLoaded) return;
    capsLoaded = true;
    const health = await checkBackendHealth();

    const metaHint = $("metaProviderHint");
    if (metaHint) {
      metaHint.textContent = health.metadataProvider === "claude"
        ? "* Claude 로 생성합니다 — 자막 내용만 근거로 제목/설명/태그를 씁니다."
        : "* 서버에 ANTHROPIC_API_KEY 가 없어 로컬 키워드 분석으로 생성합니다 (품질은 낮지만 자막에 없는 내용은 만들지 않습니다).";
    }

    const upload = $("ytUpload");
    const ytHint = $("ytHint");
    if (upload && !health.youtube) {
      upload.checked = false;
      upload.disabled = true;
      // 헬스체크 자체가 안 됐을 때와 자격 증명이 없을 때는 원인이 다르다.
      // 둘 다 "자격 증명이 없다"고 말하면, 잠깐 네트워크가 끊긴 것뿐인데
      // 키를 다시 발급하러 가게 된다.
      if (ytHint) {
        ytHint.textContent = health.ok
          ? "* 서버에 YouTube 자격 증명(YOUTUBE_CLIENT_ID / SECRET / REFRESH_TOKEN)이 없어 업로드를 쓸 수 없습니다."
          : `* 백엔드 상태를 확인하지 못해 업로드를 껐습니다 — ${health.error || "응답 없음"}`;
      }
    }
    const publicOpt = $("ytPrivacy")?.querySelector('option[value="public"]');
    if (publicOpt && health.youtube && !health.youtubeAllowsPublic) {
      publicOpt.disabled = true;
      publicOpt.textContent = "전체 공개 (public) — 서버에서 비활성";
    }
  };
  queue.addEventListener("change", sync);
  sync();
}

resetBtn.addEventListener("click", () => {
  pickedFile = null;
  pickedFiles = [];
  fileInput.value = "";
  // 개인용 작업대 — 설정 패널은 항상 열어둔다 (파일 없이도 미리 조정 가능).
  progress.hidden = true;
  resultSection.hidden = true;
  const note = $("idleNote"); if (note) note.hidden = false;
  thumbsBlock.hidden = true;
  thumbUrls.forEach((u) => URL.revokeObjectURL(u));
  thumbUrls = [];
  thumbsGrid.innerHTML = "";
  if (outputUrl) { URL.revokeObjectURL(outputUrl); outputUrl = null; }
  if (originalUrl) { URL.revokeObjectURL(originalUrl); originalUrl = null; }
  resultVideo.removeAttribute("src");
  resultVideo.load();
  setPreviewMode("edited");
  resetSubtitleState();
  lastEditPlan = null;
  const epb = $("editPlanBlock"); if (epb) epb.hidden = true;
  const mb = $("metaBlock"); if (mb) mb.hidden = true;
  const sb = $("subEditBlock"); if (sb) sb.hidden = true;
  subEditState = null;
  const jpb = $("jobPipelineBlock"); if (jpb) jpb.hidden = true;
  const bdb = $("burnedDownloadBtn");
  if (bdb) { bdb.hidden = true; bdb.classList.add("disabled"); bdb.removeAttribute("href"); }
  document.querySelector(".dz-title").textContent = "여기로 영상을 드래그하세요";
  document.querySelector(".dz-sub").innerHTML =
    '또는 <button type="button" id="pickBtn" class="link">파일 선택</button> · mp4 / mov / webm · 여러 개 가능';
  // 새 pickBtn 이벤트 재바인딩
  document.getElementById("pickBtn").addEventListener("click", (e) => {
    e.stopPropagation(); fileInput.click();
  });
  setStatus("");
});

runBtn.addEventListener("click", () => {
  if (pickedFiles.length === 0) {
    setStatus("영상을 먼저 올려주세요.");
    dropzone.classList.add("drag");
    setTimeout(() => dropzone.classList.remove("drag"), 600);
    return;
  }
  const note = $("idleNote"); if (note) note.hidden = true;
  const useQueue = $("queueMode")?.checked && BACKEND_URL;
  const userSafe = $("safeMode")?.checked === true;
  // 큐 모드가 아니면 브라우저 fallback 체인. 서버 직접 인코딩은 더 이상 사용자가
  // 고르는 모드가 아니라, 브라우저 엔진이 전부 멈췄을 때의 마지막 수단이다.
  const promise = useQueue ? runQueueModePipeline() : runWithFallback({ userSafe });
  promise.catch(onError);
});

// fallback 체인:
//   1) core-mt (멀티스레드, 빠름) → 20초 hang 시
//   2) core (싱글스레드, 안정) → 20초 hang 시
//   3) 안전 모드(-an + 효과 최소) 로 core-mt 재시도 → hang 시
//   4) Render 백엔드 fallback
// 사용자가 처음부터 안전 모드를 켰으면 1·2·3 단계 중 안전 모드만 시도 후 4로 직행.
async function runWithFallback({ userSafe = false } = {}) {
  if (userSafe) {
    appendLog("[fallback] 사용자 지정 안전 모드 (오디오 제거)로 시도");
    try {
      await runPipeline({ engine: "mt", safeMode: true });
      return;
    } catch (e) {
      if (!(e instanceof EngineHangError)) throw e;
      appendLog(`[fallback] 안전 모드 멈춤 → 백엔드로 전환`);
      if (BACKEND_URL) return runServerPipeline();
      throw new Error("브라우저 모드가 모두 멈췄고 백엔드 URL 도 없습니다.");
    }
  }

  // 1) core-mt
  try {
    await runPipeline({ engine: "mt", safeMode: false });
    return;
  } catch (e) {
    if (!(e instanceof EngineHangError)) throw e;
    appendLog(`[fallback] ${e.engine} 멈춤 → 싱글스레드 코어로 재시도`);
  }

  // 2) core (single-thread)
  try {
    await runPipeline({ engine: "st", safeMode: false });
    return;
  } catch (e) {
    if (!(e instanceof EngineHangError)) throw e;
    appendLog(`[fallback] 싱글스레드도 멈춤 → 안전 모드(오디오 제거)로 재시도`);
  }

  // 3) 안전 모드 + mt
  try {
    await runPipeline({ engine: "mt", safeMode: true });
    return;
  } catch (e) {
    if (!(e instanceof EngineHangError)) throw e;
    appendLog(`[fallback] 안전 모드도 멈춤 → 백엔드로 전환`);
  }

  // 4) backend
  if (BACKEND_URL) return runServerPipeline();
  throw new Error("브라우저 모드 3단계가 모두 멈췄고 백엔드 URL 도 없습니다.");
}

// ── 백엔드 파이프라인 ────────────────────────────────────────────────────────
async function runServerPipeline() {
  if (pickedFiles.length === 0) return;
  if (pickedFiles.length > 1) {
    // 백엔드는 단일 영상만 받음. 다중 영상은 브라우저에서 먼저 병합해야 하지만
    // 그 단계가 무거워 고속 모드의 의미가 사라지므로, 명확히 안내 후 차단.
    throw new Error(
      "다중 영상 자동 병합은 브라우저 모드만 지원합니다. " +
      "고속 모드를 끄거나, 영상을 먼저 외부에서 합쳐서 한 파일로 올려주세요."
    );
  }
  runBtn.disabled = true;
  resultSection.hidden = true;
  progress.hidden = false;
  logEl.textContent = "";
  resetSteps();
  setBar(0);

  // 1) 길이
  setStep("probe");
  setStatus("길이 확인 중...");
  pickedDuration = await measureDurationFromFile(pickedFile);
  if (pickedDuration <= 0) throw new Error("브라우저가 영상 길이를 읽지 못했습니다. 다른 형식으로 시도해 주세요.");
  appendLog(`duration = ${pickedDuration.toFixed(2)}s`);
  doneStep("probe");

  // 2) Web Audio 무음 감지
  setStep("detect");
  let keeps;
  if (state.mode === "short") {
    setStatus("숏폼 모드는 고속 모드에서 미지원 — 영상 중앙 구간 사용");
    const targetLen = parseFloat($("shortLen").value);
    const start = Math.max(0, (pickedDuration - targetLen) / 2);
    keeps = [{ start, end: Math.min(pickedDuration, start + targetLen) }];
  } else {
    const noiseDb = silenceThresholdSetting();
    const minSilence = parseFloat($("minSilence").value);
    const padding = parseFloat($("padding").value);
    setStatus("Web Audio 로 무음 감지 중...");
    let silences = [];
    try {
      silences = await detectSilencesWebAudio(pickedFile, noiseDb, minSilence);
    } catch (e) {
      throw new Error("브라우저가 영상의 오디오를 디코딩하지 못합니다. (HEVC+오디오 코덱 호환 문제) — 다른 형식으로 시도해 주세요. 원인: " + e.message);
    }
    keeps = invertSilences(pickedDuration, silences, padding);
    appendLog(`silences=${silences.length}, keeps=${keeps.length}`);
  }
  if (keeps.length === 0) throw new Error("남은 구간이 없습니다. 임계값을 완화해 주세요.");
  lastKeeps = keeps;
  doneStep("detect");

  // 3) 서버 업로드 + 처리
  setStep("encode");
  const serverOpts = {
    keeps,
    ratio: state.ratio,
    quality: state.quality,
    speed: state.speed,
    loudnorm: $("loudnorm").checked,
  };
  const reqStart = Date.now();
  let phase = "upload";
  const { blob, durationMs, sizeBytes } = await processOnBackend(pickedFile, serverOpts, (p) => {
    phase = p.phase;
    if (p.phase === "upload" && p.total) {
      const pct = (p.loaded / p.total) * 100;
      setBar(pct * 0.4); // 업로드는 전체의 40% 가정
      setStatus(`서버에 업로드 중... ${(p.loaded / 1024 / 1024).toFixed(1)} / ${(p.total / 1024 / 1024).toFixed(1)} MB`);
    } else if (p.phase === "processing") {
      setBar(45);
      setStatus("서버에서 인코딩 중... (보통 영상 길이의 0.1~0.3배)");
    } else if (p.phase === "downloading") {
      setBar(85);
      setStatus("결과 영상 다운로드 중...");
    }
  });
  appendLog(`server processed in ${(durationMs / 1000).toFixed(1)}s, ${(sizeBytes / 1024 / 1024).toFixed(1)}MB`);
  doneStep("encode");

  // 결과 표시
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  outputUrl = URL.createObjectURL(blob);
  setPreviewMode("edited"); // 기본은 편집본 탭. 사용자가 원본 탭을 누르면 전환.
  renderCutTimeline(pickedDuration, lastKeeps);
  downloadBtn.href = outputUrl;
  downloadBtn.download = outputFileName(pickedFile.name);

  const outDuration = keeps.reduce((a, k) => a + (k.end - k.start), 0) / state.speed;
  const cutTotal = pickedDuration - keeps.reduce((a, k) => a + (k.end - k.start), 0);
  renderStats({
    inputDuration: pickedDuration,
    outputDuration: outDuration,
    cutTime: cutTotal,
    cuts: keeps.length,
    ratio: state.ratio,
    speed: state.speed,
    sizeMB: blob.size / 1024 / 1024,
    inputCount: pickedFiles.length,
  });
  renderEditPlan();

  // 썸네일은 결과 mp4 가 작아서 ffmpeg.wasm 로 빠르게 추출 가능 — 일단 스킵하거나 결과에서 직접 추출
  setStep("thumbs");
  setStatus("썸네일 추출 (선택)");
  doneStep("thumbs");
  thumbsBlock.hidden = true;

  // 자동 자막 (옵션, 백엔드 호출). 서버 모드도 같은 엔드포인트 사용.
  await maybeGenerateSubtitles(blob);

  setBar(100);
  setStatus(combineCompletionStatus(`완료! 총 ${((Date.now() - reqStart) / 1000).toFixed(1)}초`));
  resultSection.hidden = false;
  resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
  runBtn.disabled = false;
}

// ── 파이프라인 ───────────────────────────────────────────────────────────────
// engine: "mt" (default, 멀티스레드 core-mt) 또는 "st" (싱글스레드 core, fallback)
// safeMode: true 면 오디오 트랙 자체를 버려서(-an) 오디오 필터 deadlock 회피
async function runPipeline({ engine = "mt", safeMode = false } = {}) {
  if (pickedFiles.length === 0) return;
  runBtn.disabled = true;
  resultSection.hidden = true;
  progress.hidden = false;
  // 첫 시도가 아니면 로그를 비우지 않고 누적 → fallback 시 디버깅에 유용
  if (engine === "mt" && !safeMode) {
    logEl.textContent = "";
    resetSteps();
  }
  setBar(0);

  const ff = await ensureFFmpeg(engine);
  const outName = "output.mp4";

  setStep("probe");
  setStatus("길이 확인 중...");
  // 1단계: 브라우저 메타데이터로 즉시 길이 읽기 시도 (대부분의 코덱에서 즉시 끝남)
  // 다중 파일이면 합산.
  let browserDur = 0;
  for (const f of pickedFiles) browserDur += await measureDurationFromFile(f);
  pickedDuration = browserDur;
  if (pickedDuration > 0) {
    appendLog(`duration (browser, ${pickedFiles.length}개 합산) = ${pickedDuration.toFixed(2)}s`);
  }

  // 단일 파일이면 곧바로 input 으로 적재. 여러 개면 Stage 0 (병합) 거쳐 merged.mp4 생성.
  let inName;
  if (pickedFiles.length === 1) {
    inName = "input" + extOf(pickedFiles[0].name);
    setStatus("파일 읽는 중...");
    const inputBytes = await readFileBytes(pickedFiles[0]);
    appendLog(`read ${inputBytes.byteLength} bytes from ${pickedFiles[0].name}`);
    if (inputBytes.byteLength === 0) {
      throw new Error("파일이 비어 있거나 읽기에 실패했습니다.");
    }
    setStatus("ffmpeg에 파일 적재 중...");
    await ff.writeFile(inName, inputBytes);
  } else {
    // 여러 영상 → 단일 입력으로 자동 병합 (재인코딩으로 코덱·해상도 통일 후 concat).
    inName = await mergeInputsToSingle(ff, pickedFiles, { noAudio: safeMode });
  }
  if (bgmFile) {
    appendLog(`uploading BGM: ${bgmFile.name}`);
    const bgmBytes = await readFileBytes(bgmFile);
    await ff.writeFile("bgm" + extOf(bgmFile.name), bgmBytes);
  }

  // 2단계: 메타데이터로 못 읽었으면 ffmpeg 로 폴백 (HEVC 등 일부 브라우저 미지원 코덱)
  if (pickedDuration <= 0) {
    setStatus("길이 측정 중 (ffmpeg)...");
    pickedDuration = await measureDuration(ff, inName);
    appendLog(`duration (ffmpeg) = ${pickedDuration.toFixed(2)}s`);
  }
  if (pickedDuration <= 0) {
    throw new Error("영상 길이를 읽을 수 없습니다. 다른 형식의 파일로 시도해 주세요.");
  }
  doneStep("probe");

  // 모드별 keep 구간 결정
  setStep("detect");
  let keeps;
  if (state.mode === "short") {
    setStatus("음량 분석으로 하이라이트 구간 탐색 중...");
    const targetLen = parseFloat($("shortLen").value);
    // 단일 파일이면 sourceFile 을 넘겨 Web Audio 빠른 경로 시도. 다중 입력 병합은
    // 이미 ffmpeg 안에 있어 file 객체가 없으므로 ffmpeg fallback 만 사용.
    const sourceFile = pickedFiles.length === 1 ? pickedFiles[0] : null;
    keeps = await pickHighlightWindow(ff, inName, pickedDuration, targetLen, sourceFile);
    appendLog(`highlight: ${keeps[0].start.toFixed(2)} → ${keeps[0].end.toFixed(2)}`);
  } else {
    const noiseDb = silenceThresholdSetting();
    const minSilence = parseFloat($("minSilence").value);
    const padding = parseFloat($("padding").value);
    setStatus(`무음 감지 (noise<${noiseDb}dB, ≥${minSilence}s)...`);
    const silences = await detectSilences(ff, inName, noiseDb, minSilence);

    // 필러 모드 ON 이면 백엔드 Whisper 분석을 호출해 filler cuts 를 받아
    // 무음 컷과 합친다. 안전 모드/오디오 없는 입력에선 의미 없으므로 건너뜀.
    let fillerCuts = [];
    if (state.filler !== "off" && !safeMode) {
      try {
        setStatus(`백엔드 Whisper 분석 (필러 모드: ${state.filler})...`);
        // 다중 입력은 첫 파일만 보낼 수 없으므로 분석 건너뜀 (병합 후엔 ffmpeg FS 안)
        if (pickedFiles.length === 1) {
          lastEditPlan = await fetchEditPlan(pickedFiles[0], state.filler);
          fillerCuts = lastEditPlan?.editPlan?.cuts || [];
          appendLog(`editPlan: filler ${fillerCuts.length}개 · NG ${lastEditPlan?.editPlan?.ngCandidates?.length || 0}개 · slow ${lastEditPlan?.editPlan?.speedSegments?.length || 0}개`);
        } else {
          appendLog("필러 분석 생략: 다중 입력은 단일 파일 업로드만 지원");
        }
      } catch (e) {
        appendLog(`필러 분석 실패 (무음 컷만 적용): ${e?.message || e}`);
      }
    }

    const allCuts = mergeAllCuts(silences, fillerCuts);
    keeps = invertSilences(pickedDuration, allCuts, padding);
    appendLog(`silences: ${silences.length} · filler: ${fillerCuts.length} · merged cuts: ${allCuts.length} · keeps: ${keeps.length}`);
  }
  doneStep("detect");

  if (keeps.length === 0) {
    throw new Error("남은 구간이 없습니다. 임계값을 완화해 보세요.");
  }
  lastKeeps = keeps;

  // 컷 + 비율 + 속도 + BGM + 정규화
  setStep("encode");
  const cutTotal = pickedDuration - keeps.reduce((a, k) => a + (k.end - k.start), 0);
  // 안전 모드: 오디오 deadlock 의 흔한 원인(atempo·loudnorm·sidechain·BGM)을
  // 한 번에 끈다. -an 까지 적용되면 오디오 트랙이 아예 없어져 worker 가 막힐
  // 여지가 사실상 사라진다.
  const encodeOpts = {
    ratio: state.ratio,
    speed: safeMode ? 1.0 : state.speed,
    bgmName: safeMode ? null : (bgmFile ? "bgm" + extOf(bgmFile.name) : null),
    bgmVolDb: parseFloat($("bgmVol").value),
    loudnorm: safeMode ? false : $("loudnorm").checked,
    noAudio: safeMode, // 안전 모드 = 오디오 완전 제거
  };
  const encodeStart = Date.now();

  // 단계별 진행: A(컷 분리 N개) · B(concat) · C(효과 + 인코딩).
  // SDK progress 이벤트(0~1) 만 사용 — -progress pipe:2 / -stats_period 제거.
  let stage = { phase: "segment", current: 0, total: keeps.length };
  let stageProgress = 0; // 현재 단계 내 진행 (0~1)
  const onStage = (s) => { stage = s; stageProgress = 0; };
  const onSdkProgress = ({ progress: p }) => {
    if (typeof p === "number" && p >= 0) stageProgress = Math.min(1, p);
  };
  ff.on("progress", onSdkProgress);

  // 단계별 가중치(전체 100% 중) — 효과 단계가 가장 무거움.
  const W = { segment: 30, concat: 5, effects: 65 };
  const encodeTimer = setInterval(() => {
    const elapsed = (Date.now() - encodeStart) / 1000;
    let pct = 0;
    let label = "";
    if (stage.phase === "segment") {
      const segDone = (stage.current - 1 + stageProgress) / Math.max(1, stage.total);
      pct = W.segment * segDone;
      label = `컷 분리 중 ${stage.current}/${stage.total}`;
    } else if (stage.phase === "concat") {
      pct = W.segment + W.concat * stageProgress;
      label = "조각 합치는 중";
    } else if (stage.phase === "effects") {
      pct = W.segment + W.concat + W.effects * stageProgress;
      label = "비율·속도·음량 적용 중";
    }
    setBar(Math.min(99, pct));
    setStatus(`${label} · 경과 ${formatHMS(elapsed)}`);
  }, 500);

  try {
    await applyCutsAndRatio(ff, inName, outName, keeps, encodeOpts, onStage);
  } finally {
    clearInterval(encodeTimer);
    ff.off("progress", onSdkProgress);
  }
  setBar(100);
  doneStep("encode");

  // 결과 추출
  setStatus("결과 영상 준비 중...");
  const data = await ff.readFile(outName);
  const blob = new Blob([data.buffer], { type: "video/mp4" });
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  outputUrl = URL.createObjectURL(blob);
  setPreviewMode("edited"); // 기본은 편집본 탭. 사용자가 원본 탭을 누르면 전환.
  renderCutTimeline(pickedDuration, lastKeeps);
  downloadBtn.href = outputUrl;
  downloadBtn.download = outputFileName(pickedFile.name);

  // 통계 (속도 적용 후 길이)
  const rawOutDuration = keeps.reduce((a, k) => a + (k.end - k.start), 0);
  const outDuration = rawOutDuration / state.speed;

  // 출력 길이 sanity check: 자동 컷 결과는 항상 원본 ≤ 원본이어야 함.
  // 실제 인코딩 결과의 duration 을 측정해 keep 합산값과 0.5초 이상 차이나면 경고.
  // 길이가 늘어나는 케이스는 거의 항상 키프레임 스냅 / 타임스탬프 버그.
  try {
    const measured = await measureDurationFromBlob(blob);
    appendLog(`output duration check: measured=${measured.toFixed(2)}s · expected=${outDuration.toFixed(2)}s · input=${pickedDuration.toFixed(2)}s`);
    if (state.speed === 1.0 && measured > pickedDuration + 0.5) {
      appendLog(`⚠ 출력(${measured.toFixed(2)}s)이 원본(${pickedDuration.toFixed(2)}s)보다 깁니다 — 컷 정확도 버그 가능성. 디버그 로그를 확인해 주세요.`);
      setStatus(`경고: 출력 길이가 원본보다 깁니다 (${measured.toFixed(1)}s > ${pickedDuration.toFixed(1)}s). 결과는 사용 가능하지만 정확도 점검 필요.`);
    }
  } catch (e) {
    appendLog(`output duration check skipped: ${e?.message || e}`);
  }
  renderStats({
    inputDuration: pickedDuration,
    outputDuration: outDuration,
    cutTime: cutTotal,
    cuts: keeps.length,
    ratio: state.ratio,
    speed: state.speed,
    sizeMB: blob.size / 1024 / 1024,
    inputCount: pickedFiles.length,
  });
  renderEditPlan();

  // 썸네일 후보 추출
  setStep("thumbs");
  setStatus("썸네일 후보 추출 중...");
  await extractThumbnails(ff, outName, outDuration, 6);
  doneStep("thumbs");

  // 자동 자막 (옵션, 백엔드 호출).
  // 인코딩 끝난 결과 mp4 를 그대로 백엔드에 보내 Whisper 로 전사.
  await maybeGenerateSubtitles(blob);

  setBar(100);
  setStatus(combineCompletionStatus("완료!"));
  resultSection.hidden = false;
  resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
  runBtn.disabled = false;

  try { await ff.deleteFile(inName); } catch {}
  try { await ff.deleteFile(outName); } catch {}
  if (encodeOpts.bgmName) { try { await ff.deleteFile(encodeOpts.bgmName); } catch {} }
}

// ── Web Audio 기반 무음 감지 (백엔드 모드용 — ffmpeg.wasm 불필요) ─────────────
// null = 자동(측정한 노이즈 바닥 기준). 숫자 = 슬라이더 값 그대로.
function silenceThresholdSetting() {
  return $("silenceAuto")?.checked !== false ? null : parseFloat($("silenceDb").value);
}

// 50ms 창마다 RMS 를 dBFS 로 뽑는다. 무음 판정과 임계값 자동 계산이 같은 배열을
// 쓰도록 분리해 뒀다 (디코딩은 한 번만).
async function analyzeAudioWindows(file) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  let buf;
  try {
    buf = await ctx.decodeAudioData(await file.arrayBuffer());
  } finally {
    ctx.close().catch(() => {});
  }
  const sr = buf.sampleRate;
  const nch = buf.numberOfChannels;
  const winSize = Math.max(1, Math.floor(sr * 0.05));
  const winDuration = winSize / sr;
  const totalWin = Math.floor(buf.length / winSize);
  const channels = [];
  for (let c = 0; c < nch; c++) channels.push(buf.getChannelData(c));

  const db = new Float32Array(totalWin);
  for (let w = 0; w < totalWin; w++) {
    let sumSq = 0;
    const off = w * winSize;
    for (let c = 0; c < nch; c++) {
      const data = channels[c];
      for (let i = 0; i < winSize; i++) {
        const s = data[off + i];
        sumSq += s * s;
      }
    }
    const rms = Math.sqrt(sumSq / (winSize * nch));
    // 완전 무음(0)은 log 가 -Infinity 라 하한을 둔다.
    db[w] = rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
  }
  return { db, winDuration, duration: buf.duration };
}

// 고정 임계값(-32dB 등)은 영상마다 틀린다. 조용한 방에서 찍으면 바닥이 -55dB 라
// -32 가 너무 높아 말끝까지 잘리고, 에어컨 돌아가는 방이나 카메라 내장 마이크는
// 바닥이 -28dB 라 -32 아래로 내려가는 구간이 아예 없어서 컷이 0개가 된다.
// (실제로 102초 영상에서 무음이 1개만 잡힌 적이 있다.)
//
// 그래서 실제 측정한 노이즈 바닥 기준으로 잡는다: 하위 5% = 바닥, 상위 15% = 말소리.
function autoSilenceThresholdDb(db) {
  const sorted = Float32Array.from(db).sort();
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];
  const floorDb = at(0.05);
  const speechDb = at(0.85);
  const range = speechDb - floorDb;
  // 바닥에서 얼마나 띄울지 — 다이내믹 레인지가 좁으면 적게 띄워야 말소리를 안 먹는다.
  const margin = Math.min(10, Math.max(3, range * 0.3));
  // speechDb - 6 은 말소리를 먹지 않으려는 상한인데, 다이내믹 레인지가 6dB 보다
  // 좁으면 이 값이 노이즈 바닥보다 아래로 내려간다. 그러면 임계값 아래인 창이
  // 하나도 없어 무음이 0개가 되고, 결과는 원본과 같은 길이가 된다.
  // 바닥보다는 반드시 위에 있어야 한다.
  const threshold = Math.max(floorDb + 1.5, Math.min(floorDb + margin, speechDb - 6));
  return {
    thresholdDb: Math.max(-50, Math.min(-18, threshold)),
    floorDb,
    speechDb,
    range,
    // range 가 좁으면 말과 소음을 음량만으로 가르기 어렵다 — UI 가 경고할 수 있게.
    lowContrast: range < 8,
  };
}

function silencesFromWindows(db, winDuration, thresholdDb, minSilence) {
  const silences = [];
  let silentRun = 0;
  let runStart = 0;
  for (let w = 0; w < db.length; w++) {
    if (db[w] < thresholdDb) {
      if (silentRun === 0) runStart = w * winDuration;
      silentRun++;
    } else if (silentRun > 0) {
      const dur = silentRun * winDuration;
      if (dur >= minSilence) silences.push({ start: runStart, end: runStart + dur });
      silentRun = 0;
    }
  }
  if (silentRun > 0) {
    const dur = silentRun * winDuration;
    if (dur >= minSilence) silences.push({ start: runStart, end: runStart + dur });
  }
  return silences;
}

// noiseDb 가 null 이면 자동 측정. stats 를 같이 돌려줘서 로그/경고에 쓴다.
async function detectSilencesWebAudio(file, noiseDb, minSilence, stats = null) {
  const { db, winDuration } = await analyzeAudioWindows(file);
  const auto = autoSilenceThresholdDb(db);
  const thresholdDb = noiseDb == null ? auto.thresholdDb : noiseDb;
  const silences = silencesFromWindows(db, winDuration, thresholdDb, minSilence);
  if (stats) {
    Object.assign(stats, auto, {
      thresholdDb,
      auto: noiseDb == null,
      silenceCount: silences.length,
      silenceSec: silences.reduce((s, x) => s + (x.end - x.start), 0),
      // 파형 그리기에 그대로 재사용 — 오디오를 두 번 디코딩하지 않기 위해.
      db, winDuration,
    });
  }
  return silences;
}

// ── 백엔드 처리 흐름 (/api/process 업로드) ───────────────────────────────────
// ── 자동 자막 (백엔드 Whisper) ─────────────────────────────────────────────
// 인코딩 끝난 결과 blob 을 백엔드 /api/transcribe 로 전송 → SRT/VTT 받음.
// "자막 번인" 옵션이면 SRT 와 함께 /api/burn-subtitles 호출 → 번인된 mp4 로 교체.
// ── 백엔드 Whisper 분석 (editPlan) ──────────────────────────────────────────
// 필러 모드 가 OFF 가 아닐 때 인코딩 전 호출. 같은 /api/transcribe 엔드포인트를
// fillerMode 옵션과 함께 호출해 word-level + editPlan 을 받는다.
async function fetchEditPlan(file, fillerMode) {
  if (!BACKEND_URL) throw new Error("백엔드 URL 미설정");
  // 헬스체크 결과를 자막/필러 둘 다 공유 — 한 세션에 한 번만.
  const health = await checkBackendHealth();
  if (!health.ok) throw new Error(`자막/필러 서버 연결 실패: ${health.error}`);
  // 비동기 jobs 패턴 + 폴링. 진행 안내는 인자로 받은 onProgress.
  return runTranscribeJob(file, {
    fillerMode,
    model: selectedWhisperModel(),
    glossary: $("glossary")?.value?.trim() || "",
    onProgress: (msg) => setStatus(msg),
  });
}

// 자막 모델은 UI 선택을 따른다. 예전엔 큐 모드가 "tiny" 를 하드코딩해서,
// 서버 메모리를 늘려도 자막 품질이 그대로였다.
// 자막 번인 스타일. 백엔드 buildForceStyle() 과 키를 맞춘다.
function subtitleStyleFromUI() {
  return {
    // 크기/여백은 "1080p 기준 픽셀". 서버가 ASS 단위로 환산한다.
    fontSize: parseInt($("subFontSize")?.value, 10) || 54,
    color: $("subColor")?.value || "#ffffff",
    background: $("subBackground")?.value || "outline",
    boxColor: $("subBoxColor")?.value || "#000000",
    boxOpacity: parseInt($("subBoxOpacity")?.value, 10) || 60,
    marginV: parseInt($("subMarginV")?.value, 10) || 60,
    bold: $("subBold")?.checked === true,
    outline: 6,
  };
}

// 미리보기는 16:9 미니 프레임이고, 값이 1080p 픽셀이므로 그대로 축소하면
// 실제 번인 비율과 일치한다 (배율 = 미리보기 높이 / 1080).
function renderSubtitleStylePreview() {
  const el = $("subStyleSample");
  const box = $("subStylePreview");
  if (!el || !box) return;
  const st = subtitleStyleFromUI();
  const scale = box.clientHeight / 1080;
  el.style.fontSize = `${Math.max(5, st.fontSize * scale)}px`;
  el.style.color = st.color;
  el.style.fontWeight = st.bold ? "700" : "500";
  el.style.marginBottom = `${Math.max(0, st.marginV * scale)}px`;
  if (st.background === "box") {
    const a = (st.boxOpacity / 100).toFixed(2);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(st.boxColor.slice(i, i + 2), 16));
    el.style.background = `rgba(${r},${g},${b},${a})`;
    el.style.padding = `${(6 * scale).toFixed(1)}px ${(10 * scale).toFixed(1)}px`;
    el.style.textShadow = "none";
  } else {
    el.style.background = "transparent";
    el.style.padding = "0";
    const w = Math.max(1, st.outline * scale).toFixed(1);
    el.style.textShadow = `0 0 ${w}px #000, ${w}px ${w}px ${w}px #000, -${w}px -${w}px ${w}px #000`;
  }
}

function selectedWhisperModel() {
  return $("whisperModel")?.value || "small";
}

// 백엔드 비동기 transcribe job 등록 후 폴링.
// 동기 /api/transcribe 가 Render Free 의 응답 timeout(30~60s)에 자주 끊어져서,
// POST /api/transcribe/jobs → GET /api/transcribe/jobs/:id 패턴으로 전환.
async function runTranscribeJob(file, { fillerMode = "off", model, glossary, onProgress } = {}) {
  if (!BACKEND_URL) throw new Error("백엔드 URL 미설정");

  // 1) 작업 등록 (multipart 업로드)
  const fd = new FormData();
  fd.append("video", file);
  fd.append("language", "ko");
  if (model) fd.append("model", model);
  if (glossary) fd.append("glossary", glossary);
  if (fillerMode && fillerMode !== "off") fd.append("fillerMode", fillerMode);

  const startResp = await fetch(`${BACKEND_URL}/api/transcribe/jobs`, {
    method: "POST",
    body: fd,
  });
  if (!startResp.ok) {
    const t = await startResp.text().catch(() => "");
    if (startResp.status === 404 && isRouteMissingResponse(t)) {
      backendHealthCache = null;
      throw new Error(
        "자막 서버 연결 실패: /api/transcribe/jobs 라우트 없음. " +
        "백엔드 API URL 또는 배포 상태를 확인하세요. (Render 재배포 필요)"
      );
    }
    throw new Error(`자막 작업 등록 실패: HTTP ${startResp.status} ${t.slice(0, 200)}`);
  }
  const { jobId, pollIntervalMs = 2500 } = await startResp.json();
  setSubtitleStep("job_register", "ok",
    `HTTP ${startResp.status} · jobId=${jobId.slice(0, 8)}…`);
  appendLog(`자막 작업 등록: ${jobId}`);

  // 2) 폴링. 최대 5분 (영상 길이/모델에 따라 조정 가능).
  const POLL_MS = Math.max(1500, pollIntervalMs);
  const MAX_TOTAL_MS = 5 * 60 * 1000;
  const startedAt = Date.now();
  setSubtitleStep("whisper", "running", "폴링 시작 (Whisper 처리 대기)");
  while (Date.now() - startedAt < MAX_TOTAL_MS) {
    await new Promise((res) => setTimeout(res, POLL_MS));
    let st;
    try {
      const sr = await fetch(`${BACKEND_URL}/api/transcribe/jobs/${jobId}`);
      if (!sr.ok) {
        if (sr.status === 404) {
          throw new Error("자막 작업이 만료됐거나 존재하지 않습니다. 다시 시도해 주세요.");
        }
        throw new Error(`상태 조회 실패: HTTP ${sr.status}`);
      }
      st = await sr.json();
    } catch (e) {
      // 일시적 네트워크 오류 → 다음 polling 으로 넘어감 (절반은 견디고 절반은 throw)
      console.warn("polling 일시 실패:", e);
      continue;
    }
    if (st.status === "done") {
      appendLog(`자막 완료: ${st.result?.segments?.length || 0}줄 · ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      return st.result;
    }
    if (st.status === "error") {
      setSubtitleStep("whisper", "error", st.error || "백엔드에서 처리 실패");
      throw new Error(st.error || "자막 생성 실패");
    }
    // pending / running
    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(0);
    onProgress?.(`자막 생성 중 · 경과 ${elapsedSec}s · 모델 ${st.model || "?"}`);
  }
  throw new Error("자막 생성 timeout (5분 초과). 영상이 너무 길거나 모델이 너무 큽니다. 더 짧은 영상 또는 tiny 모델로 시도하세요.");
}

// 무음 컷 (silences) 과 필러 컷 (fillerCuts) 을 합쳐 시간순 정렬·중복 병합.
// padding 은 invertSilences 에서 적용되므로 여기선 단순 병합만.
function mergeAllCuts(silences, fillerCuts) {
  const all = [
    ...silences.map((s) => ({ start: s.start, end: s.end })),
    ...fillerCuts.map((c) => ({ start: c.start, end: c.end })),
  ].sort((a, b) => a.start - b.start);
  if (all.length === 0) return [];
  const merged = [all[0]];
  for (let i = 1; i < all.length; i++) {
    const last = merged[merged.length - 1];
    if (all[i].start <= last.end + 0.05) {
      last.end = Math.max(last.end, all[i].end);
    } else {
      merged.push(all[i]);
    }
  }
  return merged;
}

// 결과 패널의 editPlan 카드 렌더 — 카드 + 상세보기.
function renderEditPlan() {
  const block = $("editPlanBlock");
  const sum = $("editPlanSummary");
  const det = $("editPlanDetails");
  if (!block || !sum || !det) return;
  if (!lastEditPlan?.editPlan) {
    block.hidden = true;
    return;
  }
  const ep = lastEditPlan.editPlan;
  const cutSeconds = (ep.cuts || []).reduce((a, c) => a + (c.end - c.start), 0);
  const ngSeconds = (ep.ngCandidates || []).reduce((a, c) => a + (c.end - c.start), 0);

  sum.innerHTML = `
    <div><strong>${ep.cuts?.length || 0}개</strong><span>필러 컷 (${cutSeconds.toFixed(1)}s)</span></div>
    <div><strong>${ep.speedSegments?.length || 0}개</strong><span>가속 후보 (느린 구간)</span></div>
    <div><strong>${ep.ngCandidates?.length || 0}개</strong><span>NG 후보 (${ngSeconds.toFixed(1)}s)</span></div>
  `;

  const fillerList = (ep.cuts || [])
    .slice(0, 50)
    .map((c) => `<li>${formatHMS(c.start)} — "${c.word || "?"}" (${(c.end - c.start).toFixed(2)}s)</li>`)
    .join("");
  const speedList = (ep.speedSegments || [])
    .slice(0, 30)
    .map((s) => `<li>${formatHMS(s.start)} → ${formatHMS(s.end)} · ${s.speed}x · ${s.wps} 단어/초</li>`)
    .join("");
  const ngList = (ep.ngCandidates || [])
    .slice(0, 20)
    .map((c) => `<li>${formatHMS(c.start)} → ${formatHMS(c.end)} · 유사도 ${c.similarity} · 다음: "${(c.next_text_preview || "").slice(0, 40)}…"</li>`)
    .join("");
  det.innerHTML = `
    ${fillerList ? `<p><strong>필러 컷 (적용됨)</strong><ul>${fillerList}</ul></p>` : ""}
    ${speedList ? `<p><strong>가속 후보 (이번 PR 에선 표시만)</strong><ul>${speedList}</ul></p>` : ""}
    ${ngList ? `<p><strong>NG 후보 (자동 삭제 X — 검토용)</strong><ul>${ngList}</ul></p>` : ""}
  `;
  block.hidden = false;
}

// 백엔드 라우트 가용성 확인. /api/health 가 routes 배열을 돌려주므로 그걸 보고
// transcribe 가 살아있는지까지 검증한다. 한 세션에 한 번만 호출 (캐시).
async function checkBackendHealth() {
  if (backendHealthCache) return backendHealthCache;
  if (!BACKEND_URL) {
    backendHealthCache = {
      ok: false,
      error: "백엔드 URL 이 설정돼 있지 않습니다.",
      url: null, httpStatus: null, body: null,
    };
    return backendHealthCache;
  }
  const url = `${BACKEND_URL}/api/health`;
  try {
    const r = await fetch(url, { method: "GET" });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      // /api/health 가 없으면 /healthz fallback 시도 (구버전 호환).
      const r2 = await fetch(`${BACKEND_URL}/healthz`).catch(() => null);
      if (r2?.ok) {
        backendHealthCache = {
          ok: true, routes: null, legacy: true,
          url, httpStatus: r.status, body: txt.slice(0, 200),
        };
        return backendHealthCache;
      }
      backendHealthCache = {
        ok: false,
        error: `백엔드 헬스체크 실패 (HTTP ${r.status}). 배포 상태 확인 필요.`,
        url, httpStatus: r.status, body: txt.slice(0, 200),
      };
      return backendHealthCache;
    }
    const body = await r.json();
    backendHealthCache = {
      ok: true, routes: body.routes || null, version: body.version,
      whisper: body.whisper,
      // 큐 모드 후속 단계 가용성 (구버전 백엔드면 undefined).
      metadataProvider: body.metadataProvider || null,
      youtube: body.youtube === true,
      youtubeAllowsPublic: body.youtubeAllowsPublic === true,
      // 업로드 상한·여유 디스크. 이걸 빠뜨려서, 서버에서 상한을 10GB 로 올린 뒤에도
      // 프론트는 계속 기본값 500MB 로 판정하고 "상한은 500MB" 경고를 띄웠다.
      limits: body.limits || null,
      url, httpStatus: 200, body: JSON.stringify(body).slice(0, 200),
    };
    return backendHealthCache;
  } catch (e) {
    backendHealthCache = {
      ok: false, error: `백엔드 연결 실패: ${e?.message || e}`,
      url, httpStatus: null, body: null,
    };
    return backendHealthCache;
  }
}

// 백엔드 응답이 Express 의 "Cannot POST /api/X" HTML 인지 판별 — 라우트 미존재 시그널.
function isRouteMissingResponse(text) {
  return /Cannot (POST|GET) \//.test(text || "");
}

async function maybeGenerateSubtitles(resultBlob) {
  resetSubtitleState();
  resetSubtitleSteps();
  lastSubtitleStatus = null;

  // 1) 옵션
  const enabled = $("autoSubtitles")?.checked === true;
  setSubtitleStep("option", enabled ? "ok" : "warn", enabled ? "ON" : "OFF (사용자가 해제)");
  if (!enabled) {
    lastSubtitleStatus = { ok: false, reason: "자동 자막 OFF" };
    syncSubtitleButtons();
    return;
  }

  // 2) API_BASE_URL
  setSubtitleStep("api_base", BACKEND_URL ? "ok" : "error", BACKEND_URL || "(없음)");
  if (!BACKEND_URL) {
    const reason = "백엔드 URL 미설정";
    appendLog("자동 자막: " + reason);
    lastSubtitleStatus = { ok: false, reason };
    syncSubtitleButtons(reason);
    return;
  }

  // 3) 헬스체크
  setSubtitleStep("health", "running", `GET ${BACKEND_URL}/api/health`);
  setStatus("자동 자막: 백엔드 헬스체크 중...");
  const health = await checkBackendHealth();
  const healthDetail = `HTTP ${health.httpStatus ?? "—"}${health.legacy ? " (legacy /healthz fallback)" : ""}${health.body ? ` · ${health.body.slice(0, 80)}` : ""}`;
  if (!health.ok) {
    setSubtitleStep("health", "error", healthDetail);
    // 백엔드가 옛 컨테이너로 도는 케이스 ("Cannot GET /api/health") → 명시적 안내 배너
    if (health.body && /Cannot GET \/api\/health/.test(health.body)) {
      setSubtitleBanner(
        "<strong>Render 백엔드가 최신 코드로 배포되지 않았습니다.</strong><br>" +
        "Render 대시보드 → ai-video-editor-api 서비스 → <code>Manual Deploy → Deploy latest commit</code> 클릭 후 빌드 완료 대기."
      );
    } else {
      setSubtitleBanner(`<strong>자막 서버 연결 실패.</strong><br>${escapeHtml(health.error || "알 수 없음")}`);
    }
    const reason = `백엔드 연결 실패 — ${health.error || "알 수 없음"}`;
    appendLog(`자막 서버 연결 실패: ${health.error || "알 수 없음"}`);
    lastSubtitleStatus = { ok: false, reason };
    syncSubtitleButtons("백엔드 연결 실패 (배포 상태 확인 필요)");
    return;
  }
  setSubtitleStep("health", "ok", healthDetail);

  // 4) jobs 라우트 등록 확인
  if (Array.isArray(health.routes)) {
    const has = health.routes.some(
      (r) => r.path === "/api/transcribe/jobs" && r.method === "POST"
    );
    if (!has) {
      setSubtitleStep("jobs_route", "error",
        "routes 응답에 POST /api/transcribe/jobs 가 없음. 옛 컨테이너로 추정.");
      setSubtitleBanner(
        "<strong>Render 백엔드가 최신 코드로 배포되지 않았습니다.</strong><br>" +
        "헬스체크는 살아있지만 <code>/api/transcribe/jobs</code> 라우트가 없습니다. " +
        "Render 대시보드 → <code>Manual Deploy → Deploy latest commit</code> 필요."
      );
      const reason = "/api/transcribe/jobs 라우트 없음 — Render 재배포 필요";
      appendLog("자막 서버는 살아있지만 " + reason);
      lastSubtitleStatus = { ok: false, reason };
      syncSubtitleButtons("자막 jobs 라우트 없음 (백엔드 재배포 필요)");
      return;
    }
    setSubtitleStep("jobs_route", "ok", "POST /api/transcribe/jobs 등록됨");
  } else {
    setSubtitleStep("jobs_route", "warn", "legacy /healthz 응답 — routes 검증 불가");
  }

  // 5) 백엔드 faster-whisper 설치 여부 — health.whisper 가 false 이면 미리 차단
  if (typeof health.whisper === "boolean") {
    if (health.whisper) {
      setSubtitleStep("whisper_install", "ok", `Python: ${health.pythonBin || "?"} · 모델: ${health.whisperModel || "?"}`);
    } else {
      const errSnippet = (health.whisperError || "").slice(-200);
      setSubtitleStep("whisper_install", "error",
        `Python(${health.pythonBin || "?"}) 에서 faster-whisper import 실패. ${errSnippet}`);
      setSubtitleBanner(
        "<strong>백엔드에 faster-whisper 가 설치돼 있지 않습니다.</strong><br>" +
        "Render Dockerfile 빌드 단계에서 <code>pip install faster-whisper</code> 가 실패했거나 venv 경로 불일치. " +
        "Render 대시보드 → <code>Manual Deploy → Clear build cache & deploy</code> 권장."
      );
      const reason = "백엔드 faster-whisper 미설치 — Dockerfile 빌드 확인 필요";
      appendLog("자막 차단: " + reason);
      lastSubtitleStatus = { ok: false, reason };
      syncSubtitleButtons("백엔드 faster-whisper 미설치");
      return;
    }
  } else {
    setSubtitleStep("whisper_install", "warn", "health 응답에 whisper 필드가 없음 (옛 백엔드 가능성)");
  }

  // 6–7) 작업 등록 + Whisper 폴링
  setSubtitleStep("job_register", "running", `POST ${BACKEND_URL}/api/transcribe/jobs`);
  setStatus("자동 자막: 작업 등록 중...");
  let result;
  try {
    result = await runTranscribeJob(resultBlob, {
      model: selectedWhisperModel(),
      onProgress: (msg) => setStatus(msg),
    });
  } catch (e) {
    console.error("자동 자막 실패:", e);
    const reason = e?.message || String(e);
    // job_register 또는 whisper 단계 중 하나가 실패. running 인 단계를 error 로.
    if (subtitleSteps.get("job_register")?.status !== "ok") {
      setSubtitleStep("job_register", "error", reason);
    } else {
      setSubtitleStep("whisper", "error", reason);
    }
    setSubtitleBanner(`<strong>자막 처리 실패.</strong><br>${escapeHtml(reason)}`);
    appendLog(`자동 자막 실패: ${reason}`);
    lastSubtitleStatus = { ok: false, reason };
    syncSubtitleButtons(`실패: ${reason}`);
    return;
  }
  setSubtitleStep("whisper", "ok",
    `${result?.segments?.length || 0}줄 · ${((result?.durationMs || 0) / 1000).toFixed(1)}s · 모델 ${result?.model || "?"}`);

  lastSubtitleStatus = {
    ok: true,
    count: result?.segments?.length || 0,
    ms: result?.durationMs || 0,
  };

  // 7–8) SRT/VTT 텍스트
  subtitleJson = result;
  subtitleSrtText = (result.srt || "").trim();
  subtitleVttText = (result.vtt || "").trim();
  setSubtitleStep("srt_text", subtitleSrtText.length > 0 ? "ok" : "warn",
    `${subtitleSrtText.length} bytes`);
  setSubtitleStep("vtt_text", subtitleVttText.length > 0 ? "ok" : "warn",
    `${subtitleVttText.length} bytes`);
  appendLog(
    `자막 ${result.segments?.length || 0}줄 · ` +
    `SRT ${subtitleSrtText.length}바이트 · VTT ${subtitleVttText.length}바이트 · ` +
    `${((result.durationMs || 0) / 1000).toFixed(1)}s`
  );

  // 9) Blob URL
  if (subtitleSrtText.length > 0) {
    subtitleSrtUrl = URL.createObjectURL(
      new Blob([subtitleSrtText], { type: "application/x-subrip;charset=utf-8" })
    );
  }
  if (subtitleVttText.length > 0) {
    subtitleVttUrl = URL.createObjectURL(
      new Blob([subtitleVttText], { type: "text/vtt;charset=utf-8" })
    );
    attachVttTrack(subtitleVttUrl);
  } else {
    setSubtitleStep("track", "warn", "VTT 본문이 비어 있어 트랙을 부착하지 않음");
  }
  const blobOk = !!(subtitleSrtUrl || subtitleVttUrl);
  setSubtitleStep("blob", blobOk ? "ok" : "error",
    `SRT=${subtitleSrtUrl ? "OK" : "—"} · VTT=${subtitleVttUrl ? "OK" : "—"}`);

  // 10) 버튼 활성화
  syncSubtitleButtons();
  setSubtitleStep("buttons",
    (subtitleSrtUrl || subtitleVttUrl) ? "ok" : "warn",
    `SRT ${subtitleSrtUrl ? "활성" : "비활성"} · VTT ${subtitleVttUrl ? "활성" : "비활성"}`);

  // 번인 옵션
  const burn = $("burnSubtitles")?.checked === true;
  if (!burn) {
    setSubtitleStep("burn", "warn", "OFF (자막 번인 토글 꺼짐)");
  } else if (subtitleSrtText.length === 0) {
    setSubtitleStep("burn", "warn", "건너뜀 (SRT 본문 없음)");
  } else {
    setSubtitleStep("burn", "running", `POST ${BACKEND_URL}/api/burn-subtitles`);
    setStatus("자막 번인 중 (백엔드 ffmpeg)...");
    try {
      const fd = new FormData();
      fd.append("video", resultBlob, "edited.mp4");
      fd.append("srt", subtitleSrtText);
      fd.append("style", JSON.stringify(subtitleStyleFromUI()));
      const r = await fetch(`${BACKEND_URL}/api/burn-subtitles`, { method: "POST", body: fd });
      if (!r.ok) {
        const errText = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status}: ${errText.slice(0, 300)}`);
      }
      const burnedBlob = await r.blob();
      if (outputUrl) URL.revokeObjectURL(outputUrl);
      outputUrl = URL.createObjectURL(burnedBlob);
      setPreviewMode("edited");
      const dl = $("downloadBtn");
      dl.href = outputUrl;
      dl.download = (dl.download || "edited.mp4").replace(/\.mp4$/, "-subtitled.mp4");
      appendLog("번인 완료 — 편집본을 자막 합성본으로 교체");
      setSubtitleStep("burn", "ok", `${(burnedBlob.size / 1024 / 1024).toFixed(1)} MB 교체 완료`);
    } catch (e) {
      console.error("번인 실패:", e);
      appendLog(`번인 실패 (자막은 정상 생성됨): ${e?.message || e}`);
      setSubtitleStep("burn", "error", e?.message || String(e));
    }
  }
}

// 버튼 표시 상태 동기화. 항상 보이지만 자막이 없을 때는 disabled.
// 클릭은 별도 핸들러(setupSubtitleButtonClicks) 가 잡는다 — href + download 만으로는
// 일부 케이스에서 동작하지 않는 것을 본 적이 있어 명시적 a.click() 트리거를 추가.
function syncSubtitleButtons(reasonNote) {
  const set = (btnId, url, defaultName) => {
    const a = $(btnId);
    if (!a) return;
    a.hidden = false; // 항상 노출. 비활성은 클래스로.
    if (url) {
      a.href = url;
      a.setAttribute("download", defaultName);
      a.classList.remove("disabled");
      a.setAttribute("aria-disabled", "false");
      a.removeAttribute("title");
    } else {
      a.removeAttribute("href");
      a.classList.add("disabled");
      a.setAttribute("aria-disabled", "true");
      a.title = reasonNote || "자막 생성 안 됨 (자동 자막 ON 후 다시 시도)";
    }
  };
  set("srtDownloadBtn", subtitleSrtUrl, "subtitles.srt");
  set("vttDownloadBtn", subtitleVttUrl, "subtitles.vtt");
}

// 페이지 로드 시 한 번만 등록. <a download> 만으로 동작이 안 보이는 환경(예: SW 가
// 같은 출처 fetch 를 가로챈 페이지)에서 명시적으로 a.click() 을 다시 호출하거나
// 동적으로 일회용 anchor 를 만들어 다운로드를 강제한다.
function setupSubtitleButtonClicks() {
  const handler = (kind) => (e) => {
    const url = kind === "srt" ? subtitleSrtUrl : subtitleVttUrl;
    if (!url) {
      e.preventDefault();
      console.warn(`${kind.toUpperCase()} 자막이 아직 생성되지 않음`);
      return;
    }
    // 기본 동작이 막히는 환경 대비 — 일회용 anchor 로 강제 다운로드.
    e.preventDefault();
    const tmp = document.createElement("a");
    tmp.href = url;
    tmp.download = kind === "srt" ? "subtitles.srt" : "subtitles.vtt";
    tmp.rel = "noopener";
    document.body.appendChild(tmp);
    tmp.click();
    setTimeout(() => tmp.remove(), 0);
  };
  $("srtDownloadBtn")?.addEventListener("click", handler("srt"));
  $("vttDownloadBtn")?.addEventListener("click", handler("vtt"));
}
setupSubtitleButtonClicks();
// 초기 진입 시점에 비활성 상태로 표시.
syncSubtitleButtons();

function resetSubtitleState() {
  subtitleSrtText = "";
  subtitleVttText = "";
  subtitleJson = null;
  if (subtitleSrtUrl) { URL.revokeObjectURL(subtitleSrtUrl); subtitleSrtUrl = null; }
  if (subtitleVttUrl) { URL.revokeObjectURL(subtitleVttUrl); subtitleVttUrl = null; }
  // 비디오 element 의 기존 track 제거
  resultVideo.querySelectorAll("track").forEach((t) => t.remove());
  syncSubtitleButtons();
  // 진단 패널도 숨김 — 새 파이프라인 진입 시점에 다시 띄워진다.
  const block = document.getElementById("subtitleDebugBlock");
  if (block) block.hidden = true;
  setSubtitleBanner("");
  subtitleSteps.clear();
}

// VTT track 부착. <video crossorigin="anonymous"> + blob: URL 조합에서 일부 브라우저가
// 늦게 추가된 track 의 mode 를 "hidden" 으로 두고 안 그리는 케이스가 있어, load 이벤트
// + textTracks 폴링을 모두 건다. 또한 video 가 이미 src 를 가진 상태에서 track 만 붙이면
// 무시되는 경우가 있어 video.load() 로 강제 재해석.
function attachVttTrack(vttUrl) {
  resultVideo.querySelectorAll("track").forEach((t) => t.remove());
  const track = document.createElement("track");
  track.kind = "subtitles";
  track.label = "한국어";
  track.srclang = "ko";
  track.src = vttUrl;
  track.default = true;
  setSubtitleStep("track", "running", `track.src=${vttUrl.slice(0, 60)}…`);
  // load 이벤트 시 강제로 showing 으로 설정 (default 무시되는 브라우저 대응)
  track.addEventListener("load", () => {
    if (track.track) track.track.mode = "showing";
    setSubtitleStep("track", "ok", `track 부착 완료 · mode=${track.track?.mode || "?"}`);
  });
  track.addEventListener("error", () => {
    setSubtitleStep("track", "error", "track 로드 실패 (VTT 형식 또는 CORS 확인 필요)");
  });
  resultVideo.appendChild(track);
  // 비디오에 이미 src 가 적용된 상태라면 재해석 트리거 (현재 위치 보존).
  const t = resultVideo.currentTime;
  resultVideo.load();
  if (Number.isFinite(t) && t > 0) {
    resultVideo.addEventListener("loadedmetadata", () => { resultVideo.currentTime = t; }, { once: true });
  }
  // 백업: 짧은 폴링으로 1초 안에 mode=showing 강제.
  let tries = 0;
  const tick = () => {
    const tracks = resultVideo.textTracks;
    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i].mode !== "showing") tracks[i].mode = "showing";
    }
    if (tries++ < 10) setTimeout(tick, 100);
  };
  tick();
}

// ── 큐 모드 파이프라인 ───────────────────────────────────────────────────────
// 무음 감지만 브라우저에서 빠르게 끝낸 뒤, 영상 + keeps + 옵션을 백엔드 /api/jobs
// 로 한 번에 보낸다. 인코딩·자막·썸네일은 백엔드가 단계별로 돌리고, 프론트는 3초
// 폴링으로 진행 상태를 다단계 패널에 그린다. 한 단계 실패해도 나머지는 진행.
// detect 는 큰 파일에서만 도는 단계 — 브라우저가 분석을 못 할 때 서버가 대신한다.
// 안 돌면 renderJobPipeline 이 알아서 숨긴다.
const STAGE_LABELS = [
  ["detect",     "0. 무음 감지 (서버)"],
  ["edit",       "1. 편집 (cut + ratio + speed + loudnorm)"],
  ["transcribe", "2. 자막 (Whisper)"],
  ["burn",       "3. 자막 번인"],
  ["thumbnail",  "4. 썸네일 추출"],
  ["metadata",   "5. 메타데이터 (제목/설명/태그)"],
  ["upload",     "6. YouTube 업로드"],
];
const JOB_STAGE_ICON = {
  queued: "·", running: "⏳", done: "✓", failed: "✗", skipped: "⊘",
};

async function runQueueModePipeline() {
  if (pickedFiles.length === 0) return;
  if (pickedFiles.length > 1) {
    throw new Error(
      "큐 모드는 단일 영상만 지원합니다. 다중 영상은 일반 모드에서 자동 병합 후 시도하세요."
    );
  }
  if (!BACKEND_URL) throw new Error("백엔드 URL 미설정");

  runBtn.disabled = true;
  resultSection.hidden = true;
  progress.hidden = false;
  logEl.textContent = "";
  resetSteps();
  setBar(0);
  setStatus("큐 모드: 무음 감지 중 (브라우저)...");

  // 1) 브라우저에서 무음 감지 → keeps 산출
  const sourceFile = pickedFiles[0];
  const noiseDb = silenceThresholdSetting();
  const minSilence = parseFloat($("minSilence").value);
  const padding = parseFloat($("padding").value);
  const duration = await measureDurationFromFile(sourceFile);
  if (duration <= 0) throw new Error("브라우저가 영상 길이를 못 읽었습니다.");

  // 큰 파일은 브라우저가 분석하다 죽는다 (file.arrayBuffer() 가 파일 전체를 램에
  // 올린다 — 8GB 원본에서 NotReadableError). 서버에 맡기고 keeps 를 비워 보내면
  // detect 단계가 직접 찾는다.
  const sourceMb = sourceFile.size / 1024 / 1024;
  const serverDetect = state.mode !== "short" && sourceMb > BROWSER_ANALYSIS_LIMIT_MB;

  let keeps;
  if (serverDetect) {
    keeps = [];
    lastWaveform = null;
    appendLog(`무음 감지를 서버에 위임 (${sourceMb.toFixed(0)}MB > ${BROWSER_ANALYSIS_LIMIT_MB}MB) — 브라우저 메모리 한계 회피`);
    setStatus("큐 모드: 업로드 후 서버가 무음을 분석합니다...");
  } else if (state.mode === "short") {
    const targetLen = parseFloat($("shortLen").value);
    const w = await pickHighlightWindowWebAudio(sourceFile, duration, targetLen).catch(() => null);
    keeps = w ? [w] : [{ start: 0, end: Math.min(duration, targetLen) }];
  } else {
    const stats = {};
    const silences = await detectSilencesWebAudio(sourceFile, noiseDb, minSilence, stats);
    keeps = invertSilences(duration, silences, padding);
    lastWaveform = { db: stats.db, winDuration: stats.winDuration, thresholdDb: stats.thresholdDb };
    appendLog(
      `무음 감지: 노이즈 바닥 ${stats.floorDb.toFixed(1)}dB · 말소리 ${stats.speechDb.toFixed(1)}dB` +
      ` → 임계값 ${stats.thresholdDb.toFixed(1)}dB${stats.auto ? " (자동)" : " (수동)"}` +
      ` · 무음 ${stats.silenceCount}개 / ${stats.silenceSec.toFixed(1)}초`
    );
  }
  if (!serverDetect && keeps.length === 0) {
    throw new Error("남은 구간이 없습니다. 임계값을 완화해 보세요.");
  }
  // 컷 타임라인과 CapCut 드래프트가 같은 keeps 를 쓴다. 예전엔 큐 모드에서 이걸
  // 안 채워서 CapCut 버튼이 아무 반응도 없었다.
  lastKeeps = keeps;
  pickedDuration = duration;

  // 예전엔 무음이 0~1개만 잡혀도 그냥 원본 길이 그대로 인코딩해놓고 "완료" 라고
  // 했다. 사용자 입장에선 몇 분 기다린 결과가 원본과 똑같은데 왜인지 알 수가 없다.
  const keptSec = keeps.reduce((s, k) => s + (k.end - k.start), 0);
  const cutPct = duration > 0 ? (1 - keptSec / duration) * 100 : 0;
  if (serverDetect) {
    appendLog(`큐 모드: duration=${duration.toFixed(2)}s — 무음 감지는 서버가 수행`);
  } else {
    appendLog(`큐 모드: keeps=${keeps.length}, duration=${duration.toFixed(2)}s, 컷 ${cutPct.toFixed(1)}%`);
  }
  if (!serverDetect && cutPct < 2) {
    appendLog(
      "! 잘라낼 무음을 거의 못 찾았습니다 — 결과가 원본과 비슷한 길이로 나옵니다." +
      " 녹음 환경 소음이 크면 '컷 편집 세부'에서 무음 임계 dB 를 올려(-26 쪽) 다시 시도하세요."
    );
    setStatus(`무음이 거의 없어 컷이 ${cutPct.toFixed(1)}% 뿐입니다 — 그대로 진행합니다.`);
  }
  setBar(10);

  // 2) 업로드
  setStatus("큐 모드: 작업 등록 중 (영상 업로드)...");
  const jobOptions = {
    keeps,
    // keeps 가 비어 있으면 서버가 이 값들로 직접 무음을 찾는다.
    sourceDuration: duration,
    noiseDb,
    minSilence,
    padding,
    ratio: state.ratio,
    speed: state.speed,
    loudnorm: $("loudnorm").checked,
    transcribe: $("autoSubtitles")?.checked === true,
    thumbnails: true,
    fillerMode: state.filler || "off",
    language: "ko",
    model: selectedWhisperModel(),
    glossary: $("glossary")?.value?.trim() || "",
    subtitleStyle: subtitleStyleFromUI(),
    burn: $("burnSubtitles")?.checked === true,
    metadata: $("genMetadata")?.checked === true,
    metadataPersona: $("metaPersona")?.value?.trim() || "",
    upload: $("ytUpload")?.checked === true,
    privacy: $("ytPrivacy")?.value || "private",
  };

  const totalMb = (sourceFile.size / 1024 / 1024).toFixed(1);
  // 큰 파일은 조각으로 올린다 — 한 번에 올리면 중간에 한 번만 끊겨도 처음부터다.
  // 작은 파일은 왕복이 늘 뿐이라 기존 단일 요청(XHR, 진행률·타임아웃 지원)을 쓴다.
  let uploadResult;
  if (sourceFile.size > CHUNK_UPLOAD_THRESHOLD_MB * 1024 * 1024) {
    uploadResult = await uploadJobChunked(sourceFile, jobOptions, totalMb);
  } else {
    const fd = new FormData();
    fd.append("video", sourceFile);
    fd.append("options", JSON.stringify(jobOptions));
    uploadResult = await uploadJobRequest(fd, totalMb);
  }
  const { jobId, pollIntervalMs = 3000 } = uploadResult;
  appendLog(`작업 등록: ${jobId}`);

  // 3) 폴링 — 결과 패널을 미리 보여서 진행 상태 노출.
  resultSection.hidden = false;
  $("jobPipelineBlock").hidden = false;
  // 전 단계 패널 초기화
  renderJobPipeline(makeInitialJobState(jobId));

  rememberJob(jobId);
  await followJob(jobId, pollIntervalMs);
  runBtn.disabled = false;
}

// ── 작업 따라가기 ────────────────────────────────────────────────────────────
//
// 총 경과 시간으로는 끊지 않는다. 예전엔 30분 고정 제한이었는데, 8.2GB 원본은
// 인코딩에만 47분이 걸려서 멀쩡히 돌고 있는 작업을 실패로 표시해 버렸다 —
// 서버는 끝까지 정상으로 완주했는데 화면만 포기한 것이다. 판단 기준은 "얼마나
// 오래 걸렸나"가 아니라 "진행이 멈췄나"여야 한다.
const STALL_LIMIT_MS = 20 * 60 * 1000;

// 진행이 있었는지 판단할 지문. 단계 상태와 퍼센트가 그대로면 멈춘 것으로 본다.
function jobProgressSignature(job) {
  return Object.entries(job.stages || {})
    .map(([k, s]) => `${k}:${s.status}:${s.progress?.pct ?? ""}:${s.progress?.phase ?? ""}`)
    .join("|");
}

async function followJob(jobId, pollIntervalMs = 3000) {
  const POLL_MS = Math.max(1500, pollIntervalMs);
  let consecutiveErrors = 0;
  let signature = null;
  let movedAt = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const polled = await pollJobOnce(jobId);
    if (polled.gone) { forgetJob(jobId); throw new Error(JOB_GONE_MESSAGE); }
    if (!polled.job) {
      // 일시적인 네트워크 오류는 넘어가되, 계속 실패하면 화면이 조용히 얼어붙지
      // 않도록 포기한다.
      if (++consecutiveErrors >= POLL_FAIL_LIMIT) {
        throw new Error(
          `상태 조회가 ${POLL_FAIL_LIMIT}회 연속 실패했습니다. 네트워크 또는 백엔드를 확인해 주세요.`
        );
      }
      continue;
    }
    consecutiveErrors = 0;
    const job = polled.job;
    renderJobPipeline(job);
    // 서버는 한 번에 하나만 돌린다. 순서를 기다리는 중이면 그렇다고 말해 준다 —
    // 안 그러면 아무 단계도 안 움직여서 멈춘 것처럼 보인다.
    const waiting = job.queuedBehind > 0
      ? ` — 앞선 작업 ${job.queuedBehind}개가 끝나면 시작합니다`
      : "";
    setStatus(`큐 모드: ${job.status}${terminalLabel(job)}${waiting}`);

    if (job.status === "done" || job.status === "partial" || job.status === "failed") {
      forgetJob(jobId);
      // 인코딩 결과를 다운로드 링크/미리보기로 연결
      await wireQueueResults(job);
      return job;
    }

    const sig = jobProgressSignature(job);
    if (sig !== signature) {
      signature = sig;
      movedAt = Date.now();
    } else if (Date.now() - movedAt > STALL_LIMIT_MS) {
      throw new Error(
        `작업이 ${Math.round(STALL_LIMIT_MS / 60000)}분 동안 한 발짝도 나가지 못했습니다. ` +
        `백엔드가 멈춘 것으로 보입니다 (작업 ID: ${jobId}).`
      );
    }
  }
}

// ── 새로고침해도 작업을 놓치지 않기 ──────────────────────────────────────────
//
// 작업은 서버에서 도는데 진행 상황을 보는 건 이 탭뿐이다. 예전엔 탭을 새로
// 고치면 작업 ID를 잃어버려서, 한 시간짜리 작업이 서버에서 멀쩡히 끝나도
// 결과를 받아올 방법이 없었다. ID 만 남겨 두면 다시 붙을 수 있다.
const ACTIVE_JOB_KEY = "activeJobId";
function rememberJob(jobId) {
  try { localStorage.setItem(ACTIVE_JOB_KEY, jobId); } catch {}
}
function forgetJob(jobId) {
  try {
    if (!jobId || localStorage.getItem(ACTIVE_JOB_KEY) === jobId) {
      localStorage.removeItem(ACTIVE_JOB_KEY);
    }
  } catch {}
}

async function resumeActiveJob() {
  let jobId = null;
  try { jobId = localStorage.getItem(ACTIVE_JOB_KEY); } catch {}
  if (!jobId || !BACKEND_URL) return;

  const polled = await pollJobOnce(jobId);
  if (polled.gone || !polled.job) { forgetJob(jobId); return; }

  const job = polled.job;
  resultSection.hidden = false;
  $("jobPipelineBlock").hidden = false;
  renderJobPipeline(job);
  appendLog(`이전 작업에 다시 연결: ${jobId}`);

  if (job.status === "done" || job.status === "partial" || job.status === "failed") {
    forgetJob(jobId);
    setStatus(`이전 작업 결과를 불러왔습니다: ${job.status}${terminalLabel(job)}`);
    await wireQueueResults(job);
    return;
  }
  setStatus(`진행 중이던 작업에 다시 연결했습니다: ${job.status}`);
  runBtn.disabled = true;
  try {
    await followJob(jobId);
  } catch (e) {
    setStatus(`오류: ${e?.message || e}`);
  } finally {
    runBtn.disabled = false;
  }
}

// 작업 목록은 서버 메모리에만 있다. 백엔드가 재시작되면 (재배포, 메모리 초과 등)
// 진행 중이던 작업이 통째로 사라진다.
const JOB_GONE_MESSAGE =
  "작업이 사라졌습니다. 백엔드가 재시작된 것으로 보입니다 " +
  "(재배포 또는 메모리 초과). 작업 목록이 서버 메모리에만 있어서 재시작되면 함께 없어집니다. " +
  "다시 실행해 주세요.";
const POLL_FAIL_LIMIT = 10;

// 한 번 폴링. 예전엔 404 를 try 블록 안에서 throw 했는데 바로 아래 catch 가
// 그걸 삼켜서 continue 로 돌아갔다 — 작업이 사라져도 화면이 멈춘 채로 30분간
// 조용히 재시도만 했다. 결과를 값으로 돌려주고 판단은 호출부에서 한다.
async function pollJobOnce(jobId) {
  try {
    const r = await fetch(`${BACKEND_URL}/api/jobs/${jobId}`);
    if (r.status === 404) return { gone: true, job: null };
    if (!r.ok) {
      appendLog(`상태 조회 일시 실패 (${r.status}) — 재시도`);
      return { gone: false, job: null };
    }
    return { gone: false, job: await r.json() };
  } catch (e) {
    console.warn("polling 일시 실패:", e);
    return { gone: false, job: null };
  }
}

// /api/jobs 업로드. XHR 을 쓰는 이유는 진행률과 타임아웃 때문 (fetch 는 둘 다 안 됨).
function uploadJobRequest(fd, totalMb) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BACKEND_URL}/api/jobs`);
    xhr.responseType = "json";
    // 업로드가 15분 동안 한 바이트도 못 가면 끊어진 것으로 본다.
    xhr.timeout = 15 * 60 * 1000;

    let lastPct = -1;
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      if (pct === lastPct) return;
      lastPct = pct;
      const doneMb = (e.loaded / 1024 / 1024).toFixed(1);
      setStatus(`큐 모드: 영상 업로드 ${pct}% (${doneMb} / ${totalMb} MB)`);
      // 업로드는 전체 진행바의 10~30% 구간을 차지한다고 보고 매핑.
      setBar(10 + pct * 0.2);
    };
    xhr.upload.onloadend = () => {
      setStatus("큐 모드: 업로드 완료 — 서버가 작업을 등록하는 중...");
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const body = xhr.response || {};
        if (!body.jobId) return reject(new Error("서버 응답에 jobId 가 없습니다."));
        return resolve(body);
      }
      const detail = typeof xhr.response === "string"
        ? xhr.response.slice(0, 200)
        : JSON.stringify(xhr.response || {}).slice(0, 200);
      reject(new Error(`작업 등록 실패: HTTP ${xhr.status} ${detail}`));
    };
    xhr.onerror = () => reject(new Error(
      "업로드 중 연결이 끊겼습니다. 파일이 크면 네트워크가 중간에 끊길 수 있습니다."
    ));
    xhr.ontimeout = () => reject(new Error(
      "업로드가 15분을 넘겨 중단했습니다. 파일이 너무 크거나 업로드 속도가 느립니다."
    ));
    xhr.send(fd);
  });
}

// 조각 업로드. 큰 파일을 요청 하나로 올리면 중간에 네트워크가 한 번만 끊겨도
// 처음부터 다시 해야 한다 — 실제로 8.2GB 를 올리다 125MB 지점에서 끊겨 통째로
// 실패했다. 파일을 잘라 보내고, 실패한 조각만 다시 보낸다.
const CHUNK_RETRIES = 5;
// 이 크기를 넘으면 조각 업로드. 작은 파일은 단일 요청이 더 빠르다.
const CHUNK_UPLOAD_THRESHOLD_MB = 200;

async function uploadJobChunked(file, options, totalMb) {
  const started = Date.now();
  const create = await fetch(`${BACKEND_URL}/api/uploads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ totalBytes: file.size }),
  });
  if (!create.ok) {
    const t = await create.text().catch(() => "");
    throw new Error(`업로드 세션 생성 실패 (HTTP ${create.status}): ${t.slice(0, 200)}`);
  }
  const { uploadId, chunkSize } = await create.json();
  const CHUNK = chunkSize || 16 * 1024 * 1024;
  const chunkLabel = CHUNK >= 1024 * 1024
    ? `${(CHUNK / 1024 / 1024).toFixed(0)}MB`
    : `${(CHUNK / 1024).toFixed(0)}KB`;
  appendLog(`조각 업로드 시작 — ${Math.ceil(file.size / CHUNK)}개 조각 (${chunkLabel}씩)`);

  let offset = 0;
  while (offset < file.size) {
    let ok = false;
    let lastErr = null;
    for (let attempt = 1; attempt <= CHUNK_RETRIES; attempt++) {
      // 조각 범위는 매 시도마다 현재 offset 으로 다시 계산한다. 재시도 중에 서버가
      // 앞서 나갈 수 있는데(끊긴 요청이 사실은 서버까지 도달했던 경우), 범위를
      // 고정해두면 그 다음 전송이 엉뚱한 위치의 데이터를 보내 파일이 깨진다.
      const end = Math.min(offset + CHUNK, file.size);
      if (offset >= file.size) { ok = true; break; }
      try {
        const r = await fetch(`${BACKEND_URL}/api/uploads/${uploadId}?offset=${offset}`, {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: file.slice(offset, end),
        });
        if (r.ok) {
          offset = (await r.json()).received;
          ok = true;
          break;
        }
        // 409 는 두 경우다: offset 이 어긋났거나(재시도가 중간에 성공), 직전 조각의
        // 쓰기가 아직 정리되는 중이거나. 둘 다 서버가 알려준 지점으로 맞춘 뒤
        // 잠깐 기다렸다 다시 보내면 된다 — 여기서 성공으로 처리하면 while 루프가
        // 같은 자리를 쉬지 않고 다시 두드린다.
        if (r.status === 409) {
          const body = await r.json().catch(() => ({}));
          if (Number.isFinite(body.received)) offset = body.received;
          await new Promise((rs) => setTimeout(rs, 300));
          continue;
        }
        lastErr = new Error(`HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 150)}`);
      } catch (e) {
        lastErr = e;   // 네트워크 끊김 — 이게 원래 통째로 실패시키던 원인이다
      }
      // 서버가 실제로 어디까지 받았는지 물어보고 그 지점부터 재개한다.
      try {
        const st = await fetch(`${BACKEND_URL}/api/uploads/${uploadId}`);
        if (st.ok) offset = (await st.json()).received;
      } catch {}
      const waitMs = Math.min(8000, 500 * 2 ** (attempt - 1));
      appendLog(`조각 재시도 ${attempt}/${CHUNK_RETRIES} (${(offset / 1024 / 1024).toFixed(0)}MB 지점) — ${lastErr?.message || ""}`);
      setStatus(`업로드 재시도 중 ${attempt}/${CHUNK_RETRIES}... (${(offset / 1024 / 1024).toFixed(0)} / ${totalMb} MB)`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    if (!ok) {
      throw new Error(
        `업로드가 ${(offset / 1024 / 1024).toFixed(0)}MB 지점에서 ${CHUNK_RETRIES}번 재시도 후에도 실패했습니다: ${lastErr?.message || ""}`
      );
    }
    const pct = Math.round((offset / file.size) * 100);
    const mbps = offset / 1024 / 1024 / ((Date.now() - started) / 1000);
    const remainSec = mbps > 0 ? (file.size / 1024 / 1024 - offset / 1024 / 1024) / mbps : 0;
    setStatus(
      `큐 모드: 영상 업로드 ${pct}% (${(offset / 1024 / 1024).toFixed(0)} / ${totalMb} MB` +
      `${remainSec > 5 ? ` · 남은 시간 약 ${fmtClock(remainSec)}` : ""})`
    );
    setBar(10 + pct * 0.2);
  }

  setStatus("큐 모드: 업로드 완료 — 서버가 작업을 등록하는 중...");
  const done = await fetch(`${BACKEND_URL}/api/uploads/${uploadId}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ options }),
  });
  if (!done.ok) {
    const t = await done.text().catch(() => "");
    throw new Error(`작업 등록 실패 (HTTP ${done.status}): ${t.slice(0, 200)}`);
  }
  const body = await done.json();
  if (!body.jobId) throw new Error("서버 응답에 jobId 가 없습니다.");
  appendLog(`업로드 완료 — ${((Date.now() - started) / 1000).toFixed(0)}초, 평균 ${(file.size / 1024 / 1024 / ((Date.now() - started) / 1000)).toFixed(1)} MB/s`);
  return body;
}

function makeInitialJobState(jobId) {
  const stages = {};
  for (const [name] of STAGE_LABELS) stages[name] = { status: "queued" };
  return { jobId, status: "queued", stages };
}

function terminalLabel(job) {
  const s = job.status;
  if (s === "done") return " — 모든 단계 완료";
  if (s === "partial") return " — 일부 단계 실패 (다른 단계는 사용 가능)";
  if (s === "failed") return " — 실패";
  return "";
}

function renderJobPipeline(job) {
  const ol = document.getElementById("jobStages");
  if (!ol) return;
  ol.innerHTML = STAGE_LABELS.map(([key, label]) => {
    const s = job.stages?.[key];
    // detect 는 큰 파일에서만 돈다 — 안 돈 작업에서는 줄 자체를 감춘다.
    if (key === "detect" && !s) return "";
    const icon = JOB_STAGE_ICON[(s || { status: "queued" }).status] || "·";
    const detail = jobStageDetailText(key, s || { status: "queued" });
    const detailHtml = detail ? `<span class="detail">${escapeHtml(detail)}</span>` : "";
    // edit 은 원본이 이미 지워져 재시도 불가. upload 는 중복 게시 위험 때문에
    // 실패했을 때만 (백엔드도 같은 규칙으로 막는다).
    const retryBtn = s?.status === "failed" && key !== "edit"
      ? `<button type="button" class="btn" data-retry="${key}">다시 시도</button>` : "";
    return `<li class="job-stage ${(s || { status: "queued" }).status}">
      <span class="icon">${icon}</span>
      <span><span class="label">${label}</span>${detailHtml}</span>
      <span class="actions">${retryBtn}</span>
    </li>`;
  }).join("");
  // 다시 시도 버튼 핸들러
  ol.querySelectorAll("[data-retry]").forEach((btn) => {
    btn.addEventListener("click", () => retryJobStage(job.jobId, btn.dataset.retry));
  });
}

function jobStageDetailText(key, s) {
  if (s.error) return `에러: ${s.error}`;
  if (s.note) return s.note;
  if (key === "detect" && s.status === "done" && s.result) {
    const st = s.result.stats || {};
    return `무음 ${st.silenceCount}곳 / ${(st.silenceSec || 0).toFixed(1)}초 · 임계 ${(st.thresholdDb || 0).toFixed(1)}dB` +
      `${st.auto ? " (자동)" : ""}${st.lowContrast ? " · 음량 대비 낮음" : ""}`;
  }
  if (s.status === "running") {
    const elapsed = s.startedAt ? ` · ${Math.round((Date.now() - s.startedAt) / 1000)}초 경과` : "";
    const p = s.progress;
    // 자막 단계는 퍼센트가 나오기 전에 모델 다운로드/로딩 구간이 있다.
    // 그 구간이 제일 길 수 있으므로 뭘 하는 중인지라도 알려준다.
    if (p?.phase === "model_load") return `Whisper 모델 준비 중 (처음 쓰는 모델이면 다운로드)${elapsed}`;
    if (p?.phase === "model_ready" || p?.phase === "transcribe_start") return `음성 분석 시작${elapsed}`;
    if (p?.totalSec > 0 && p.outTimeSec >= 0) {
      const verb = key === "transcribe" ? "전사" : "인코딩";
      return `${verb} ${p.pct}% (${p.outTimeSec.toFixed(0)}s / ${p.totalSec.toFixed(0)}s)${elapsed}`;
    }
    return `진행 중${elapsed}`;
  }
  if (s.status === "done" && s.result) {
    if (key === "edit") {
      const mb = s.result.sizeBytes ? ` · ${(s.result.sizeBytes / 1024 / 1024).toFixed(1)} MB` : "";
      const t = s.result.durationMs ? ` · ${(s.result.durationMs / 1000).toFixed(1)}s` : "";
      return `완료${mb}${t}`;
    }
    if (key === "transcribe") {
      return `${s.result.segmentCount || 0}줄 · ${s.result.language || "?"} · ${((s.result.durationMs || 0) / 1000).toFixed(1)}s`;
    }
    if (key === "thumbnail") {
      return `${s.result.urls?.length || 0}장 추출`;
    }
    if (key === "burn") {
      const mb = s.result.sizeBytes ? ` · ${(s.result.sizeBytes / 1024 / 1024).toFixed(1)} MB` : "";
      return `자막 합성 완료${mb} · ${((s.result.durationMs || 0) / 1000).toFixed(1)}s`;
    }
    if (key === "metadata") {
      const via = s.result.source === "claude" ? `Claude(${s.result.model})` : "로컬 키워드 분석";
      return `제목 후보 ${s.result.titles?.length || 0}개 · 태그 ${s.result.tags?.length || 0}개 · ${via}`;
    }
    if (key === "upload") {
      return `${s.result.privacyStatus || "?"} 로 게시 · ${s.result.url || ""}`;
    }
  }
  return "";
}

async function retryJobStage(jobId, stage) {
  setStatus(`${stage} 단계 재시도 중...`);
  try {
    const r = await fetch(`${BACKEND_URL}/api/jobs/${jobId}/stages/${stage}/retry`, { method: "POST" });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
    }
    appendLog(`${stage} 재시도 등록`);
    // 폴링은 메인 루프가 이미 돌고 있을 수도 있으나 종료된 경우엔 재개
    pollUntilTerminal(jobId).catch(onError);
  } catch (e) {
    appendLog(`재시도 실패: ${e?.message || e}`);
  }
}

// 단계 재시도 후에도 같은 규칙으로 따라간다. 예전엔 여기도 30분 제한이었고,
// 넘기면 오류도 없이 조용히 빠져나가 화면이 영원히 "진행 중"으로 남았다.
const pollUntilTerminal = (jobId) => followJob(jobId);

// 큐 모드 결과를 기존 결과 UI 에 연결: 편집본을 미리보기 비디오에, SRT/VTT 를
// 다운로드 버튼에, 썸네일을 썸네일 그리드에.
async function wireQueueResults(job) {
  const editUrl = job.stages.edit?.result?.url;
  if (editUrl) {
    const fullUrl = BACKEND_URL + editUrl;
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    // 백엔드 파일은 blob URL 이 아니라 직접 URL — preview 도 그대로 사용 가능.
    outputUrl = fullUrl;
    resultVideo.src = fullUrl;
    resultVideo.load();
    const dl = $("downloadBtn");
    dl.href = fullUrl;
    dl.download = "edited.mp4";
    dl.classList.remove("disabled");
  }
  // 자막
  const tr = job.stages.transcribe;
  if (tr?.status === "done" && tr.result) {
    if (tr.result.srtUrl) {
      const srtBtn = $("srtDownloadBtn");
      srtBtn.href = BACKEND_URL + tr.result.srtUrl;
      srtBtn.classList.remove("disabled");
      srtBtn.removeAttribute("aria-disabled");
    }
    if (tr.result.vttUrl) {
      const vttBtn = $("vttDownloadBtn");
      const vttUrl = BACKEND_URL + tr.result.vttUrl;
      vttBtn.href = vttUrl;
      vttBtn.classList.remove("disabled");
      vttBtn.removeAttribute("aria-disabled");
      // 미리보기 플레이어에 track 부착
      attachVttTrack(vttUrl);
    }
  }
  // 썸네일
  const th = job.stages.thumbnail;
  if (th?.status === "done" && th.result?.urls) {
    thumbsGrid.innerHTML = "";
    thumbUrls.forEach((u) => URL.revokeObjectURL(u));
    thumbUrls = [];
    for (const u of th.result.urls) {
      const img = document.createElement("img");
      img.src = BACKEND_URL + u;
      img.alt = "썸네일 후보";
      img.addEventListener("click", () => {
        const a = document.createElement("a");
        a.href = BACKEND_URL + u;
        a.download = u.split("/").pop() || "thumb.jpg";
        a.click();
      });
      thumbsGrid.appendChild(img);
    }
    thumbsBlock.hidden = false;
  }
  // 자막 번인본 — 편집본과 별개 파일이라 다운로드 버튼을 따로 노출한다.
  const burn = job.stages.burn;
  const burnedBtn = $("burnedDownloadBtn");
  if (burnedBtn && burn?.status === "done" && burn.result?.url) {
    burnedBtn.href = BACKEND_URL + burn.result.url;
    burnedBtn.hidden = false;
    burnedBtn.classList.remove("disabled");
    burnedBtn.removeAttribute("aria-disabled");
  }
  renderMetadata(job.stages.metadata, job.stages.upload);
  // 서버가 무음을 찾았으면 그 결과로 타임라인을 그린다 (브라우저는 분석을 안 했다).
  const det = job.stages?.detect?.result;
  if (det?.keeps?.length) {
    lastKeeps = det.keeps;
    pickedDuration = det.duration || pickedDuration;
    if (det.waveform?.db?.length) lastWaveform = det.waveform;
    const st = det.stats || {};
    appendLog(
      `서버 무음 감지: 노이즈 바닥 ${st.floorDb?.toFixed(1)}dB · 말소리 ${st.speechDb?.toFixed(1)}dB` +
      ` → 임계값 ${st.thresholdDb?.toFixed(1)}dB${st.auto ? " (자동)" : " (수동)"}` +
      ` · 무음 ${st.silenceCount}개 / ${st.silenceSec?.toFixed(1)}초`
    );
    if (st.lowContrast) {
      appendLog("! 말소리와 배경 소음의 음량 차이가 작아 자동 감지가 부정확할 수 있습니다.");
    }
  }
  renderCutTimeline(pickedDuration, lastKeeps);
  renderSubtitleEditor(job);
}

// ── 자막 교정 ───────────────────────────────────────────────────────────────
// Whisper 오인식(예: "사각"→"4학")을 브라우저에서 바로 고치고, 고친 자막을
// 백엔드로 되돌려 보낸다. SRT/VTT 재생성은 클라이언트에서 하고, 서버는 파일만
// 교체한다 — 그래야 다운로드 버튼과 번인이 같은 교정본을 쓴다.
let subEditState = null; // { jobId, segments: [{start,end,text}] }

function renderSubtitleEditor(job) {
  const block = $("subEditBlock");
  if (!block) return;
  const tr = job.stages?.transcribe;
  const segs = tr?.status === "done" ? tr.result?.segments : null;
  if (!segs?.length) { block.hidden = true; subEditState = null; return; }

  subEditState = { jobId: job.jobId, segments: segs.map((s) => ({ ...s })) };
  block.hidden = false;
  const hint = $("subEditHint");
  if (hint) hint.textContent = `${segs.length}줄 · 고친 뒤 "교정 적용"`;
  $("subEditStatus").textContent = "";
  $("subEditReburn").hidden = job.stages?.burn?.status !== "done";

  $("subEditList").innerHTML = subEditState.segments.map((sg, i) => `
    <li class="subedit-row">
      <button type="button" class="subedit-time" data-seek="${sg.start}">${fmtClock(sg.start)}</button>
      <input type="text" class="subedit-text" data-idx="${i}" value="${escapeHtml(sg.text)}" />
    </li>`).join("");

  const list = $("subEditList");
  list.querySelectorAll("[data-seek]").forEach((b) => {
    b.addEventListener("click", () => {
      // 해당 구간으로 미리보기를 이동시켜 귀로 확인하며 고칠 수 있게.
      resultVideo.currentTime = parseFloat(b.dataset.seek) || 0;
      resultVideo.play().catch(() => {});
    });
  });
  list.querySelectorAll(".subedit-text").forEach((inp) => {
    inp.addEventListener("input", () => {
      subEditState.segments[Number(inp.dataset.idx)].text = inp.value;
      $("subEditStatus").textContent = "수정됨 — 적용하지 않으면 반영되지 않습니다";
    });
  });
}

function fmtClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function tsSrt(sec) {
  const ms = Math.max(0, Math.round((Number(sec) || 0) * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  const s2 = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  return `${h}:${m}:${s2},${String(ms % 1000).padStart(3, "0")}`;
}

function buildSrtVtt(segments) {
  const srt = segments.map((sg, i) =>
    `${i + 1}\n${tsSrt(sg.start)} --> ${tsSrt(sg.end)}\n${sg.text.trim()}\n`).join("\n");
  const vtt = "WEBVTT\n\n" + segments.map((sg) =>
    `${tsSrt(sg.start).replace(",", ".")} --> ${tsSrt(sg.end).replace(",", ".")}\n${sg.text.trim()}\n`).join("\n");
  return { srt, vtt };
}

async function applySubtitleEdits() {
  if (!subEditState) return;
  const status = $("subEditStatus");
  status.textContent = "적용 중...";
  try {
    const { srt, vtt } = buildSrtVtt(subEditState.segments);
    const r = await fetch(`${BACKEND_URL}/api/jobs/${subEditState.jobId}/subtitles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ srt, vtt, segments: subEditState.segments }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 150)}`);

    // 미리보기 자막을 교정본으로 교체. 서버 파일은 URL 이 같아 캐시될 수 있으니
    // 방금 만든 VTT 를 blob 으로 붙인다.
    if (subtitleVttUrl?.startsWith("blob:")) URL.revokeObjectURL(subtitleVttUrl);
    subtitleVttUrl = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
    attachVttTrack(subtitleVttUrl);

    // 다운로드 버튼도 교정본으로.
    const srtBtn = $("srtDownloadBtn");
    if (srtBtn) {
      srtBtn.href = URL.createObjectURL(new Blob([srt], { type: "text/plain" }));
      srtBtn.classList.remove("disabled");
    }
    const vttBtn = $("vttDownloadBtn");
    if (vttBtn) { vttBtn.href = subtitleVttUrl; vttBtn.classList.remove("disabled"); }

    status.textContent = "적용 완료 — 다운로드/미리보기에 반영됐습니다";
    $("subEditReburn").hidden = false;
    appendLog("자막 교정본 적용");
  } catch (e) {
    status.textContent = `적용 실패: ${e?.message || e}`;
  }
}

// 메타데이터 패널 — 제목 후보/설명/태그/썸네일 카피 + 업로드 결과 링크.
function renderMetadata(metaStage, uploadStage) {
  const block = $("metaBlock");
  if (!block) return;
  const m = metaStage?.status === "done" ? metaStage.result : null;
  if (!m) { block.hidden = true; return; }
  block.hidden = false;

  const src = $("metaSource");
  if (src) {
    // Claude 를 쓰려다 실패해서 휴리스틱으로 내려온 경우, 조용히 품질만 떨어지면
    // 왜 결과가 나빠졌는지 알 수가 없으니 사유를 그대로 보여준다.
    src.textContent = m.source === "claude"
      ? (m.model || "Claude")   // 모델 ID 자체에 이미 "claude" 가 들어있다
      : m.fallbackFrom === "claude"
        ? `로컬 키워드 분석 (Claude 호출 실패: ${m.fallbackReason || "사유 미상"})`
        : "로컬 키워드 분석";
  }

  const titles = $("metaTitles");
  if (titles) {
    titles.innerHTML = (m.titles || [])
      .map((t) => `<li><span>${escapeHtml(t)}</span><button type="button" class="btn ghost" data-copy-text="${escapeHtml(t)}">복사</button></li>`)
      .join("");
  }
  const desc = $("metaDescription");
  if (desc) desc.textContent = m.description || "";

  const tags = $("metaTags");
  const tagsText = (m.tags || []).join(", ");
  if (tags) {
    tags.innerHTML = (m.tags || []).map((t) => `<span class="meta-tag">${escapeHtml(t)}</span>`).join("");
  }
  const tagsHidden = $("metaTagsText");
  if (tagsHidden) tagsHidden.textContent = tagsText;

  const hook = $("metaThumbCopy");
  if (hook) {
    hook.textContent = m.thumbnailSubcopy
      ? `${m.thumbnailCopy} / ${m.thumbnailSubcopy}`
      : (m.thumbnailCopy || "-");
  }

  const upRow = $("metaUploadRow");
  const up = uploadStage?.status === "done" ? uploadStage.result : null;
  if (upRow) {
    if (up?.url) {
      upRow.hidden = false;
      const link = $("uploadedLink");
      if (link) { link.href = up.url; link.textContent = `업로드된 영상 열기 (${up.privacyStatus})`; }
      const st = $("uploadedStatus");
      if (st) {
        st.textContent = [
          `제목: ${up.title || "-"}`,
          up.publishAt ? `예약 게시: ${up.publishAt}` : null,
          up.thumbnailSet ? "썸네일 적용됨" : (up.thumbnailError ? `썸네일 실패: ${up.thumbnailError}` : null),
        ].filter(Boolean).join(" · ");
      }
    } else {
      upRow.hidden = true;
    }
  }
}

// ── 개인용 설정 저장 ────────────────────────────────────────────────────────
// 혼자 쓰는 도구라 매번 같은 값을 다시 고르는 게 제일 번거롭다. 체크박스/슬라이더/
// 칩 선택/텍스트 입력을 전부 localStorage 에 넣고 다음 방문에 그대로 복원한다.
const PREFS_KEY = "aive.prefs.v1";
const PREF_CHECKBOXES = [
  "queueMode", "autoSubtitles", "burnSubtitles",
  "genMetadata", "ytUpload", "loudnorm", "safeMode", "subBold", "silenceAuto",
];
const PREF_RANGES = ["silenceDb", "minSilence", "padding", "shortLen", "bgmVol",
  "subFontSize", "subMarginV", "subBoxOpacity"];
const PREF_TEXTS = ["metaPersona", "ytPrivacy", "whisperModel", "glossary",
  "subColor", "subBackground", "subBoxColor"];
const PREF_CHIPS = ["preset", "ratio", "quality", "mode", "speed", "filler"];

function readPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; }
}

function savePrefs() {
  const p = {};
  for (const id of PREF_CHECKBOXES) if ($(id)) p[id] = $(id).checked;
  for (const id of PREF_RANGES) if ($(id)) p[id] = $(id).value;
  for (const id of PREF_TEXTS) if ($(id)) p[id] = $(id).value;
  for (const attr of PREF_CHIPS) {
    const active = document.querySelector(`[data-${attr}].active`);
    if (active) p[`chip.${attr}`] = active.dataset[attr];
  }
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch {}
}

function restorePrefs() {
  const p = readPrefs();
  for (const id of [...PREF_CHECKBOXES]) {
    if (p[id] !== undefined && $(id)) $(id).checked = p[id];
  }
  for (const id of [...PREF_RANGES, ...PREF_TEXTS]) {
    if (p[id] !== undefined && $(id)) $(id).value = p[id];
  }
  // 슬라이더 라벨 재동기화
  for (const [src, label, fmt] of sliders) {
    const s = $(src), l = $(label);
    if (s && l) l.textContent = fmt(s.value);
  }
  // 칩은 click() 으로 복원해야 state 와 preset 부수효과까지 같이 반영된다.
  // preset 은 슬라이더를 덮어쓰므로 복원 순서에서 제외 (저장된 슬라이더 값 우선).
  for (const attr of PREF_CHIPS) {
    if (attr === "preset") continue;
    const v = p[`chip.${attr}`];
    if (v === undefined) continue;
    const btn = document.querySelector(`[data-${attr}="${v}"]`);
    if (btn && !btn.classList.contains("active")) btn.click();
  }
  const preset = p["chip.preset"];
  if (preset) {
    document.querySelectorAll("[data-preset]").forEach((b) => {
      b.classList.toggle("active", b.dataset.preset === preset);
    });
    state.preset = preset;
  }
  // 큐 모드 카드 표시 여부는 change 리스너가 정하므로, 복원 후 한 번 알린다.
  $("queueMode")?.dispatchEvent(new Event("change", { bubbles: true }));
  renderSubtitleStylePreview();
}

function wirePrefPersistence() {
  const ids = [...PREF_CHECKBOXES, ...PREF_RANGES, ...PREF_TEXTS];
  for (const id of ids) {
    const el = $(id);
    if (el) {
      el.addEventListener("change", savePrefs);
      el.addEventListener("input", savePrefs);
    }
  }
  for (const attr of PREF_CHIPS) {
    document.querySelectorAll(`[data-${attr}]`).forEach((b) => {
      // bindChips 가 먼저 등록돼 있으므로 여기서는 저장만 (state 는 이미 갱신됨).
      b.addEventListener("click", savePrefs);
    });
  }
}

// ── 상단바: 백엔드 URL 편집 + 능력치 표시등 ─────────────────────────────────
function wireTopbar() {
  const toggle = $("backendToggle");
  const panel = $("backendPanel");
  const input = $("backendUrlInput");
  if (toggle && panel) {
    toggle.addEventListener("click", () => { panel.hidden = !panel.hidden; });
  }
  if (input) input.value = localStorage.getItem("backendUrl") || DEFAULT_BACKEND_URL;

  $("backendSaveBtn")?.addEventListener("click", () => {
    const v = (input?.value || "").trim().replace(/\/+$/, "");
    if (v) localStorage.setItem("backendUrl", v);
    else localStorage.removeItem("backendUrl");
    location.reload();
  });
  $("backendResetBtn")?.addEventListener("click", () => {
    localStorage.removeItem("backendUrl");
    location.reload();
  });

  const hint = $("backendPanelHint");
  if (hint) hint.textContent = `현재: ${BACKEND_URL || "(미설정)"} · 저장하면 페이지를 새로 읽습니다.`;

  refreshStatusPills();
}

function setPill(id, state, text) {
  const el = $(id);
  if (!el) return;
  el.dataset.state = state;
  el.textContent = text;
}

async function refreshStatusPills() {
  const health = await checkBackendHealth();
  if (!health.ok) {
    setPill("pillBackend", "bad", "백엔드 연결 실패");
    setPill("pillWhisper", "off", "자막 불가");
    setPill("pillMeta", "off", "메타데이터 불가");
    setPill("pillYoutube", "off", "업로드 불가");
    return;
  }
  const ver = health.version && health.version !== "unknown" ? health.version.slice(0, 7) : null;
  setPill("pillBackend", "ok", ver ? `백엔드 ${ver}` : "백엔드 연결됨");
  setPill("pillWhisper", health.whisper === false ? "bad" : "ok",
    health.whisper === false ? "자막 엔진 오류" : "자막");
  setPill("pillMeta", "ok",
    health.metadataProvider === "claude" ? "메타데이터 Claude" : "메타데이터 로컬");
  // 상한은 서버가 정한다 (MAX_UPLOAD_MB 환경변수). 프론트에 박아두면 서버에서
  // 올려도 프론트가 계속 막는다.
  if (health.limits?.maxUploadMb > 0) {
    MAX_UPLOAD_MB = health.limits.maxUploadMb;
    validatePickedSize();   // 파일을 먼저 놓았어도 갱신된 상한으로 다시 판정
  }
  setPill("pillYoutube", health.youtube ? "ok" : "off",
    health.youtube ? (health.youtubeAllowsPublic ? "YouTube 공개 허용" : "YouTube 비공개만") : "YouTube 미설정");
}

onReady(() => {
  restorePrefs();
  wirePrefPersistence();
  wireTopbar();
  for (const id of ["subFontSize", "subMarginV", "subColor", "subBackground",
                    "subBoxColor", "subBoxOpacity", "subBold"]) {
    $(id)?.addEventListener("input", renderSubtitleStylePreview);
    $(id)?.addEventListener("change", renderSubtitleStylePreview);
  }
  // 스타일 패널은 번인을 켰을 때만 의미가 있다. 숨어 있는 동안은 미리보기의
  // clientHeight 가 0 이라 글자 크기 환산이 0 으로 죽으므로, 보여준 다음에
  // 반드시 다시 그린다.
  const syncSubStyleBox = () => {
    const box = $("subStyleBox");
    if (!box) return;
    box.hidden = $("burnSubtitles")?.checked !== true;
    if (!box.hidden) renderSubtitleStylePreview();
  };
  $("burnSubtitles")?.addEventListener("change", syncSubStyleBox);
  syncSubStyleBox();
  // 자동일 때 슬라이더는 아무 효과가 없으므로 비활성 표시.
  const syncSilenceAuto = () => {
    const auto = $("silenceAuto")?.checked !== false;
    const slider = $("silenceDb");
    if (slider) slider.disabled = auto;
    const lbl = $("silenceDbVal");
    if (lbl) lbl.textContent = auto ? "자동" : `${slider?.value} dB`;
  };
  $("miniProg")?.addEventListener("click", () => {
    document.getElementById("progress")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("cutsPlayRemoved")?.addEventListener("click", () => {
    previewRemovedOnly(pickedDuration, lastKeeps).catch(onError);
  });
  $("silenceAuto")?.addEventListener("change", syncSilenceAuto);
  $("silenceDb")?.addEventListener("input", syncSilenceAuto);
  syncSilenceAuto();
  renderSubtitleStylePreview();
  $("subEditApply")?.addEventListener("click", () => applySubtitleEdits().catch(onError));
  $("subEditReburn")?.addEventListener("click", () => {
    if (subEditState) retryJobStage(subEditState.jobId, "burn");
  });
});

// 복사 버튼 — data-copy(요소 id의 텍스트) 또는 data-copy-text(리터럴).
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-copy], [data-copy-text]");
  if (!btn) return;
  const text = btn.dataset.copyText ?? ($(btn.dataset.copy)?.textContent || "");
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const prev = btn.textContent;
    btn.textContent = "복사됨";
    setTimeout(() => { btn.textContent = prev; }, 1200);
  } catch {
    appendLog("클립보드 복사 실패 — 직접 선택해 복사해 주세요.");
  }
});

async function processOnBackend(file, opts, onProgress) {
  if (!BACKEND_URL) throw new Error("백엔드 URL 이 설정되지 않았습니다.");

  const fd = new FormData();
  fd.append("video", file);
  fd.append("options", JSON.stringify(opts));

  // 업로드 진행률 추적을 위해 XHR 사용 (fetch 는 upload progress 지원 약함)
  const result = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BACKEND_URL}/api/process`);
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress({ phase: "upload", loaded: e.loaded, total: e.total });
      }
    };
    xhr.upload.onloadend = () => onProgress?.({ phase: "processing" });
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
      else reject(new Error(`서버 ${xhr.status}: ${xhr.response?.error || "fail"}`));
    };
    xhr.onerror = () => reject(new Error("네트워크 오류"));
    xhr.send(fd);
  });

  // 결과 mp4 다운로드
  onProgress?.({ phase: "downloading" });
  const r = await fetch(`${BACKEND_URL}${result.url}`);
  if (!r.ok) throw new Error(`결과 다운로드 실패: ${r.status}`);
  const blob = await r.blob();
  return { blob, durationMs: result.durationMs, sizeBytes: result.sizeBytes };
}

// ── ffmpeg helpers ───────────────────────────────────────────────────────────
function extOf(name) {
  const m = name.match(/\.[a-zA-Z0-9]+$/);
  return m ? m[0].toLowerCase() : ".mp4";
}

function outputFileName(orig) {
  const base = orig.replace(/\.[^.]+$/, "");
  const tag = state.mode === "short" ? "short" : "edited";
  return `${tag}-${base}.mp4`;
}

// 길이는 HTML5 video 메타데이터로 즉시 읽음. ffmpeg 디코딩 불필요.
// 브라우저가 코덱(HEVC 등)을 못 읽으면 ffmpeg fallback.
function measureDurationFromFile(file) {
  return measureDurationFromBlob(file);
}

// File / Blob 둘 다 동일 로직으로 처리한다 (File ⊂ Blob).
function measureDurationFromBlob(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      resolve(val);
    };
    v.onloadedmetadata = () => {
      if (Number.isFinite(v.duration) && v.duration > 0) finish(v.duration);
      else finish(0);
    };
    v.onerror = () => finish(0);
    setTimeout(() => finish(0), 5000);
    v.src = url;
  });
}

async function measureDuration(ff, inName) {
  // ffmpeg fallback: -t 0.001 로 1ms 만 처리 후 종료. probe 정보만 출력되고 디코딩 안 함.
  let dur = 0;
  const handler = ({ message }) => {
    const m = message.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
    if (m) dur = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
  };
  ff.on("log", handler);
  await ff.exec(["-t", "0.001", "-i", inName, "-f", "null", "-"]).catch(() => {});
  ff.off("log", handler);
  return dur;
}

async function detectSilences(ff, inName, noiseDb, minSilence) {
  const silences = [];
  let pendingStart = null;
  const handler = ({ message }) => {
    let m;
    if ((m = message.match(/silence_start:\s*(-?\d+\.?\d*)/))) {
      pendingStart = Math.max(0, parseFloat(m[1]));
    } else if ((m = message.match(/silence_end:\s*(-?\d+\.?\d*)/))) {
      const end = parseFloat(m[1]);
      if (pendingStart !== null) {
        silences.push({ start: pendingStart, end });
        pendingStart = null;
      }
    }
  };
  ff.on("log", handler);
  // -vn: 비디오 디코딩 건너뜀 → 오디오만 처리해 무음 감지가 훨씬 빠름.
  await ff.exec([
    "-i", inName,
    "-vn",
    "-af", `silencedetect=noise=${noiseDb}dB:d=${minSilence}`,
    "-f", "null", "-",
  ]);
  ff.off("log", handler);
  return silences;
}

function invertSilences(duration, silences, padding) {
  const keeps = [];
  let cursor = 0;
  for (const s of silences) {
    const cutStart = Math.max(cursor, s.start + padding);
    const cutEnd = Math.min(duration, s.end - padding);
    if (cutStart > cursor + 0.05) keeps.push({ start: cursor, end: Math.min(cutStart, duration) });
    cursor = Math.max(cursor, cutEnd);
  }
  if (cursor < duration - 0.05) keeps.push({ start: cursor, end: duration });
  return keeps.filter((k) => k.end - k.start > 0.1);
}

// 숏폼: 가장 음량이 큰 N초 윈도우를 찾는다. 두 가지 전략:
//  1) Web Audio API 로 원본 파일 디코딩 → JS 에서 RMS 슬라이딩 윈도우 (가장 빠름,
//     비디오 디코딩 안 함, ffmpeg.wasm 손 안 댐)
//  2) Web Audio 디코딩이 실패하면 (코덱 미지원, 대용량) ffmpeg.wasm fallback —
//     이 경우에도 -vn 으로 비디오 디코딩 회피 + 1초당 1샘플로 다운샘플 +
//     메타데이터를 file=stdout 이 아니라 ffmpeg FS 파일로 받아 파싱.
async function pickHighlightWindow(ff, inName, duration, targetLen, sourceFile) {
  // ── 전략 1: Web Audio (sourceFile 이 있을 때만) ──────────────────────────
  if (sourceFile) {
    try {
      const win = await pickHighlightWindowWebAudio(sourceFile, duration, targetLen);
      if (win) {
        appendLog(`highlight (WebAudio): ${win.start.toFixed(2)} → ${win.end.toFixed(2)}`);
        return [win];
      }
    } catch (e) {
      appendLog(`WebAudio highlight 실패 (ffmpeg 로 fallback): ${e?.message || e}`);
    }
  }

  // ── 전략 2: ffmpeg.wasm fallback ─────────────────────────────────────────
  // -vn: 비디오 디코딩 회피 (HEVC 같이 무거운 코덱에서 결정적). 하이라이트엔 비디오 불필요.
  // asetnsamples=44100:p=0: 약 1초 단위로 프레임을 모아 astats 호출 횟수를 1/N 로 감소.
  // metadata 는 ffmpeg FS 의 stats.txt 로 떨어뜨려 한 번에 읽는다 (worker stderr 채널 포화 회피).
  const statsFile = "highlight_stats.txt";
  try { await ff.deleteFile(statsFile); } catch {}
  await execWithWatchdog(ff, [
    "-i", inName,
    "-vn",
    "-af",
    `asetnsamples=44100:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=${statsFile}`,
    "-f", "null", "-",
  ]);

  let samples = [];
  try {
    const raw = await ff.readFile(statsFile);
    const text = new TextDecoder().decode(raw);
    samples = [...text.matchAll(/lavfi\.astats\.Overall\.RMS_level=(-?\d+\.?\d*)/g)]
      .map((m) => parseFloat(m[1]));
    try { await ff.deleteFile(statsFile); } catch {}
  } catch (e) {
    appendLog(`highlight stats 파일 읽기 실패: ${e?.message || e}`);
  }

  if (samples.length === 0) {
    // 측정 실패 → 영상 중앙 구간 사용
    const start = Math.max(0, (duration - targetLen) / 2);
    return [{ start, end: Math.min(duration, start + targetLen) }];
  }
  return [pickWindowFromSamples(samples, duration, targetLen)];
}

// Web Audio 전략: AudioContext 로 디코딩 → 50ms 단위 RMS → targetLen 슬라이딩 윈도우 최대.
async function pickHighlightWindowWebAudio(file, duration, targetLen) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  let buf;
  try {
    buf = await ctx.decodeAudioData(await file.arrayBuffer());
  } finally {
    ctx.close().catch(() => {});
  }
  const sr = buf.sampleRate;
  const winSize = Math.max(1, Math.floor(sr * 0.05)); // 50ms
  const winDur = winSize / sr;
  const totalWin = Math.floor(buf.length / winSize);
  const channels = [];
  for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c));

  const samples = new Array(totalWin);
  for (let w = 0; w < totalWin; w++) {
    let sumSq = 0;
    const off = w * winSize;
    for (let c = 0; c < channels.length; c++) {
      const data = channels[c];
      for (let i = 0; i < winSize; i++) {
        const s = data[off + i];
        sumSq += s * s;
      }
    }
    const rms = Math.sqrt(sumSq / (winSize * channels.length));
    // dB 로 환산 (참조 1.0). 무음(-Infinity)은 -100 으로 클램프.
    samples[w] = rms > 0 ? 20 * Math.log10(rms) : -100;
  }
  if (totalWin === 0) return null;
  // duration 추정은 buf.duration 우선. 인자로 받은 duration 은 fallback.
  const effectiveDur = buf.duration > 0 ? buf.duration : duration;
  return pickWindowFromSamples(samples, effectiveDur, targetLen);
}

// 공통: dB 샘플 배열 + 총 길이 + 타깃 길이 → 가장 음량 큰 윈도우 시작/끝 (초).
function pickWindowFromSamples(samples, duration, targetLen) {
  const norm = samples.map((v) => (Number.isFinite(v) ? v : -100));
  const secPerSample = duration / norm.length;
  const window = Math.max(1, Math.round(targetLen / secPerSample));
  let bestSum = -Infinity, bestIdx = 0, runSum = 0;
  for (let i = 0; i < norm.length; i++) {
    runSum += norm[i];
    if (i >= window) runSum -= norm[i - window];
    if (i >= window - 1 && runSum > bestSum) {
      bestSum = runSum;
      bestIdx = i - window + 1;
    }
  }
  const start = Math.max(0, bestIdx * secPerSample);
  const end = Math.min(duration, start + targetLen);
  return { start, end };
}

// 거대한 단일 filter_complex 는 ffmpeg.wasm core-mt 에서 keep 수가 늘어나면
// 필터 그래프 init 단계에서 worker 가 멈추는 경향이 있다. 작은 파일·소수 컷에서도
// 재현됨. 그래서 3단계로 나눈다:
//  A. 각 keep 을 -c copy 로 분리해 짧은 mp4 조각으로 export (재인코딩 X)
//  B. concat demuxer + -c copy 로 조각들을 하나로 합침 (재인코딩 X)
//  C. 합쳐진 단일 파일에 ratio/speed/loudnorm/BGM 을 한 번만 적용
// 각 단계의 ffmpeg 호출은 필터 그래프가 단순해 worker init 병목이 사라진다.
// Stage 0: 다중 영상 → 통일된 단일 입력. 코덱/해상도가 달라도 concat 가능하도록
// 각 파일을 ultrafast H.264+AAC 로 정규화 후 concat demuxer 로 결합한다.
async function mergeInputsToSingle(ff, files, { noAudio = false } = {}) {
  setStatus(`${files.length}개 영상 병합 중 (1/${files.length} 적재)`);
  const segs = [];
  for (let i = 0; i < files.length; i++) {
    const raw = `raw_${String(i).padStart(4, "0")}${extOf(files[i].name)}`;
    setStatus(`병합: ${i + 1}/${files.length} 적재 중`);
    const bytes = await readFileBytes(files[i]);
    if (bytes.byteLength === 0) throw new Error(`${files[i].name} 파일을 읽을 수 없습니다.`);
    await ff.writeFile(raw, bytes);

    const norm = `norm_${String(i).padStart(4, "0")}.mp4`;
    setStatus(`병합: ${i + 1}/${files.length} 정규화 중`);
    const args = [
      "-i", raw,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
    ];
    if (noAudio) {
      args.push("-an");
    } else {
      args.push("-c:a", "aac", "-b:a", "160k", "-ar", "44100");
    }
    args.push("-y", norm);
    await execWithWatchdog(ff, args);
    try { await ff.deleteFile(raw); } catch {}
    segs.push(norm);
  }

  setStatus("병합: concat 결합 중");
  const list = segs.map((f) => `file '${f}'`).join("\n");
  await ff.writeFile("merge_list.txt", new TextEncoder().encode(list));
  const concatArgs = [
    "-f", "concat", "-safe", "0",
    "-i", "merge_list.txt",
    "-c", "copy",
  ];
  if (noAudio) concatArgs.push("-an");
  concatArgs.push("-y", "merged_input.mp4");
  await execWithWatchdog(ff, concatArgs);

  for (const s of segs) { try { await ff.deleteFile(s); } catch {} }
  try { await ff.deleteFile("merge_list.txt"); } catch {}
  appendLog(`merged ${files.length} files → merged_input.mp4`);
  return "merged_input.mp4";
}

async function applyCutsAndRatio(ff, inName, outName, keeps, opts, onStage) {
  const { ratio, speed, bgmName, bgmVolDb, loudnorm, noAudio } = opts;
  const ratioFilter = ratioToFilter(ratio);

  const segFiles = [];
  // 단계 A: 컷 분리. -c copy 는 keyframe 스냅 때문에 요청한 -ss 시점보다 앞 키프레임부터
  // 데이터를 포함시켜 출력이 의도보다 길어지는 버그가 있었다. 작은 ultrafast 재인코딩은
  // 단일 키프레임에서 시작하는 정확한 컷을 만들고, 필터 그래프도 단순해서 worker hang 우려가 없다.
  // 안전 모드에선 -an 으로 오디오를 통째로 버린다.
  for (let i = 0; i < keeps.length; i++) {
    onStage?.({ phase: "segment", current: i + 1, total: keeps.length });
    const seg = `seg_${String(i).padStart(4, "0")}.mp4`;
    const { start, end } = keeps[i];
    const segArgs = [
      // -ss/-to 를 -i 앞에 둬서 빠른 키프레임 시크 후, 재인코딩 시 정확한 시점부터 출력.
      "-ss", start.toFixed(3),
      "-to", end.toFixed(3),
      "-i", inName,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
    ];
    if (noAudio) {
      segArgs.push("-an");
    } else {
      segArgs.push("-c:a", "aac", "-b:a", "160k");
    }
    segArgs.push("-avoid_negative_ts", "make_zero", "-y", seg);
    await execWithWatchdog(ff, segArgs);
    segFiles.push(seg);
  }

  // 단계 B: concat demuxer 로 합치기
  onStage?.({ phase: "concat" });
  const list = segFiles.map((f) => `file '${f}'`).join("\n");
  await ff.writeFile("concat_list.txt", new TextEncoder().encode(list));
  const concatArgs = [
    "-f", "concat",
    "-safe", "0",
    "-i", "concat_list.txt",
    "-c", "copy",
  ];
  if (noAudio) concatArgs.push("-an");
  concatArgs.push("-y", "joined.mp4");
  await execWithWatchdog(ff, concatArgs);

  // 단계 C: 효과 적용 (ratio/speed/loudnorm/BGM)
  onStage?.({ phase: "effects" });
  const speedV = speed === 1.0 ? null : `setpts=${(1 / speed).toFixed(4)}*PTS`;
  // 오디오 체인은 noAudio 이면 모두 무시.
  const speedA = (noAudio || speed === 1.0) ? null : atempoChain(speed);
  let vChain = ratioFilter;
  if (speedV) vChain += `,${speedV}`;
  let aChain = "";
  if (!noAudio) {
    if (speedA && speedA !== "anull") aChain = speedA;
    if (loudnorm) aChain = (aChain ? aChain + "," : "") + "loudnorm=I=-16:LRA=11:TP=-1.5";
  }

  let effectsArgs;
  if (noAudio) {
    // 안전 모드: 비디오만 처리, 오디오 트랙 없음. 가장 단순한 경로.
    effectsArgs = ["-i", "joined.mp4", "-vf", vChain, "-an"];
  } else if (!bgmName) {
    // 일반 경로: -vf / -af 단순 사용. filter_complex 회피.
    effectsArgs = ["-i", "joined.mp4", "-vf", vChain];
    if (aChain) effectsArgs.push("-af", aChain);
  } else {
    // BGM + 사이드체인 더킹 — 이때만 filter_complex 사용 (입력 2개 + 그래프 분기)
    let voicePrefix = "[0:a]";
    if (aChain) voicePrefix += aChain + ",";
    const filter =
      `[0:v]${vChain}[vout];` +
      `${voicePrefix}asplit=2[voice][voice2];` +
      `[1:a]volume=${bgmVolDb}dB,aloop=loop=-1:size=2e9[bgmraw];` +
      `[bgmraw][voice2]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=250[bgmducked];` +
      `[voice][bgmducked]amix=inputs=2:duration=first:dropout_transition=0[aout]`;
    effectsArgs = [
      "-i", "joined.mp4",
      "-i", bgmName,
      "-filter_complex", filter,
      "-map", "[vout]", "-map", "[aout]",
      "-shortest",
    ];
  }
  effectsArgs.push(
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
  );
  if (!noAudio) effectsArgs.push("-c:a", "aac", "-b:a", "160k");
  effectsArgs.push("-movflags", "+faststart", "-y", outName);
  await execWithWatchdog(ff, effectsArgs);

  // 정리
  for (const f of segFiles) { try { await ff.deleteFile(f); } catch {} }
  try { await ff.deleteFile("concat_list.txt"); } catch {}
  try { await ff.deleteFile("joined.mp4"); } catch {}
}

// 20초 동안 log/progress 가 없으면 worker hang 으로 보고 ffmpeg.wasm 인스턴스를
// 강제 종료. 다음 호출에서 ensureFFmpeg() 가 새 인스턴스를 만든다.
const HANG_TIMEOUT_MS = 20_000;

// fallback chain (mt → st → backend) 가 잡을 수 있는 전용 에러.
class EngineHangError extends Error {
  constructor(engine) {
    super(`ffmpeg ${engine} engine hung for ${HANG_TIMEOUT_MS / 1000}s`);
    this.name = "EngineHangError";
    this.engine = engine;
  }
}

async function execWithWatchdog(ff, args) {
  let lastActivity = Date.now();
  const tap = () => { lastActivity = Date.now(); };
  ff.on("log", tap);
  ff.on("progress", tap);
  let killed = false;
  const watchdog = setInterval(() => {
    if (Date.now() - lastActivity > HANG_TIMEOUT_MS) {
      killed = true;
      clearInterval(watchdog);
      try { ff.terminate?.(); } catch {}
      const hungEngine = ffmpegEngine;
      ffmpeg = null;
      ffmpegEngine = null;
      // exec 의 promise 가 자체적으로 reject 되는데, killed 플래그로 식별 후
      // EngineHangError 로 다시 throw 한다.
      ff._hungEngine = hungEngine; // catch 에서 참조
    }
  }, 1000);
  try {
    await ff.exec(args);
  } catch (e) {
    if (killed) throw new EngineHangError(ff._hungEngine || "unknown");
    throw e;
  } finally {
    clearInterval(watchdog);
    ff.off("log", tap);
    ff.off("progress", tap);
  }
}

// atempo 는 0.5~2.0 범위만 허용 → 큰 배율은 체인.
function atempoChain(speed) {
  if (speed === 1.0) return "anull";
  let parts = [];
  let s = speed;
  while (s > 2.0) { parts.push("atempo=2.0"); s /= 2.0; }
  while (s < 0.5) { parts.push("atempo=0.5"); s /= 0.5; }
  parts.push(`atempo=${s.toFixed(4)}`);
  return parts.join(",");
}

// 백엔드 server/index.js 의 같은 이름 함수와 표를 맞춰 둔다 — 어느 경로로
// 처리하든 같은 옵션이면 같은 해상도가 나와야 한다.
const QUALITY_SIZES = {
  "720p":  { "16:9": [1280, 720],  "9:16": [720, 1280],  "1:1": [720, 720] },
  "1080p": { "16:9": [1920, 1080], "9:16": [1080, 1920], "1:1": [1080, 1080] },
};

function ratioToFilter(ratio, quality) {
  const table = QUALITY_SIZES[quality] || QUALITY_SIZES[state.quality] || QUALITY_SIZES["1080p"];
  const size = table[ratio];
  if (!size) return "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  const [w, h] = size;
  // "가득 채운 뒤 가운데 잘라내기". 비율마다 다른 식을 쓰던 예전 방식은 세로
  // 원본을 16:9 로 뽑을 때 스케일 결과가 crop 목표보다 좁아져 실패할 수 있었다.
  return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;
}

// ── 썸네일 후보 추출 ─────────────────────────────────────────────────────────
async function extractThumbnails(ff, srcName, duration, count) {
  // 기존 썸네일 정리
  thumbUrls.forEach((u) => URL.revokeObjectURL(u));
  thumbUrls = [];
  thumbsGrid.innerHTML = "";

  for (let i = 0; i < count; i++) {
    // 영상 시작/끝은 페이드/타이틀 가능성 → 안쪽 80% 구간에서 균등 분포
    const t = duration * 0.1 + (duration * 0.8 * (i + 0.5) / count);
    const out = `thumb_${i}.jpg`;
    try {
      await ff.exec([
        "-ss", t.toFixed(2),
        "-i", srcName,
        "-frames:v", "1",
        "-q:v", "3",
        "-vf", "scale=480:-2",
        out,
      ]);
      const data = await ff.readFile(out);
      const blob = new Blob([data.buffer], { type: "image/jpeg" });
      const url = URL.createObjectURL(blob);
      thumbUrls.push(url);
      const img = document.createElement("img");
      img.src = url;
      img.alt = `${t.toFixed(1)}s 시점 썸네일`;
      img.title = `${t.toFixed(1)}s — 클릭하면 다운로드`;
      img.addEventListener("click", () => {
        const a = document.createElement("a");
        a.href = url;
        a.download = `thumb-${i + 1}.jpg`;
        a.click();
      });
      thumbsGrid.appendChild(img);
      try { await ff.deleteFile(out); } catch {}
    } catch (e) {
      appendLog(`thumb ${i} failed: ${e.message || e}`);
    }
  }
  if (thumbUrls.length > 0) thumbsBlock.hidden = false;
}

// ── 컷 타임라인 ──────────────────────────────────────────────────────────────
// "얼마나 줄었다"는 숫자만으로는 무엇이 잘렸는지 알 수 없다. 원본 길이를 막대로
// 펴서 남긴 구간과 잘린 구간을 칠하고, 클릭하면 원본의 그 지점으로 보낸다.
let cutsPreviewTimer = null;
let lastWaveform = null;   // { db, winDuration, thresholdDb } — 무음 감지 때 나온 것 재사용
let wavePlayhead = null;

// 파형 + 컷 구간 + 임계선을 한 캔버스에 겹쳐 그린다. "왜 여기가 잘렸나" 를
// 설명하는 게 목적이라 임계선이 핵심이다 — 선 아래로 내려간 구간이 잘린 구간이다.
function renderWaveform(duration, keeps, wf = lastWaveform) {
  const cv = $("cutsWave");
  if (!cv || !wf?.db?.length || !duration) { if (cv) cv.hidden = true; return; }
  cv.hidden = false;

  const { db, winDuration, thresholdDb } = wf;
  const dpr = window.devicePixelRatio || 1;
  const cssW = cv.clientWidth || cv.parentElement.clientWidth || 800;
  const cssH = 140;
  cv.width = Math.round(cssW * dpr);
  cv.height = Math.round(cssH * dpr);
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssW, cssH);

  const FLOOR = -60;                                  // 표시 하한
  const norm = (d) => Math.max(0, Math.min(1, (d - FLOOR) / (0 - FLOOR)));
  const xOf = (t) => (t / duration) * cssW;

  // 잘린 구간 배경 먼저 (파형이 그 위에 올라오도록)
  g.fillStyle = "rgba(179, 56, 74, 0.18)";
  for (const r of removedRanges(duration, keeps)) {
    g.fillRect(xOf(r.start), 0, Math.max(1, xOf(r.end) - xOf(r.start)), cssH);
  }

  // 파형 — 픽셀 열마다 그 구간의 최대 음량을 쓴다(peak). 평균을 쓰면 짧은 말소리가
  // 뭉개져서 임계선과의 관계가 안 보인다.
  const perPx = db.length / cssW;
  for (let x = 0; x < cssW; x++) {
    const a = Math.floor(x * perPx);
    const b = Math.max(a + 1, Math.floor((x + 1) * perPx));
    let peak = -100;
    for (let i = a; i < b && i < db.length; i++) if (db[i] > peak) peak = db[i];
    const h = norm(peak) * (cssH - 16);
    const t = (a * winDuration);
    const inCut = !keeps.some((k) => t >= k.start && t < k.end);
    g.fillStyle = inCut ? "#e0637a" : "#5cf2c0";
    g.fillRect(x, (cssH - h) / 2, 1, h);
  }

  // 임계선
  if (Number.isFinite(thresholdDb)) {
    const h = norm(thresholdDb) * (cssH - 16);
    const y = (cssH - h) / 2;
    g.strokeStyle = "rgba(255,255,255,.55)";
    g.setLineDash([5, 4]);
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, y); g.lineTo(cssW, y); g.stroke();
    g.beginPath(); g.moveTo(0, cssH - y); g.lineTo(cssW, cssH - y); g.stroke();
    g.setLineDash([]);
    // 라벨은 파형 위에 그냥 얹으면 초록 배경과 겹쳐 안 읽힌다 — 어두운 판을 깔고 쓴다.
    g.font = "10px system-ui, sans-serif";
    const text = `무음 기준 ${thresholdDb.toFixed(1)}dB`;
    const tw = g.measureText(text).width;
    g.fillStyle = "rgba(10, 11, 16, 0.85)";
    g.fillRect(5, 4, tw + 12, 15);
    g.fillStyle = "rgba(255,255,255,.9)";
    g.fillText(text, 11, 15);
  }

  cv.onclick = (e) => {
    const rect = cv.getBoundingClientRect();
    const t = ((e.clientX - rect.left) / rect.width) * duration;
    playOriginalRange(t, duration);
  };
}

// 원본 재생 중일 때 재생 위치를 파형 위에 세로선으로 표시.
function startPlayheadLoop(duration) {
  cancelAnimationFrame(wavePlayhead);
  const cv = $("cutsWave");
  const marker = $("cutsPlayhead");
  if (!cv || !marker) return;
  const tick = () => {
    if (previewMode === "original" && duration > 0) {
      marker.hidden = false;
      marker.style.left = `${(resultVideo.currentTime / duration) * 100}%`;
    } else {
      marker.hidden = true;
    }
    wavePlayhead = requestAnimationFrame(tick);
  };
  tick();
}

function renderCutTimeline(duration, keeps, wf = lastWaveform) {
  const block = $("cutsBlock");
  if (!block) return;
  if (!duration || !keeps?.length) { block.hidden = true; return; }

  const removed = removedRanges(duration, keeps);
  const keptSec = keeps.reduce((s, k) => s + (k.end - k.start), 0);
  const cutSec = duration - keptSec;
  block.hidden = false;

  $("cutsSummary").textContent =
    `원본 ${fmtClock(duration)} → 편집본 ${fmtClock(keptSec)} · ` +
    `${removed.length}곳 / ${cutSec.toFixed(1)}초 삭제 (${((cutSec / duration) * 100).toFixed(0)}%)`;

  // 남긴 구간과 잘린 구간을 하나의 배열로 합쳐 시간순으로 그린다.
  const spans = [
    ...keeps.map((k) => ({ ...k, kind: "keep" })),
    ...removed.map((r) => ({ ...r, kind: "cut" })),
  ].sort((a, b) => a.start - b.start);

  $("cutsBar").innerHTML = spans.map((s) => {
    const pct = ((s.end - s.start) / duration) * 100;
    const label = `${s.kind === "keep" ? "남김" : "잘림"} ${fmtClock(s.start)}–${fmtClock(s.end)} (${(s.end - s.start).toFixed(1)}초)`;
    return `<button type="button" class="cuts-seg ${s.kind}" style="width:${pct}%"
      data-start="${s.start}" data-end="${s.end}" title="${label}" aria-label="${label}"></button>`;
  }).join("");

  // 눈금 — 원본 기준 시각을 5등분해서 표시.
  $("cutsAxis").innerHTML = Array.from({ length: 6 }, (_, i) =>
    `<span>${fmtClock((duration * i) / 5)}</span>`).join("");

  renderWaveform(duration, keeps, wf);
  startPlayheadLoop(duration);

  $("cutsBar").querySelectorAll(".cuts-seg").forEach((el) => {
    el.addEventListener("click", () => {
      playOriginalRange(parseFloat(el.dataset.start), parseFloat(el.dataset.end));
    });
  });
}

function removedRanges(duration, keeps) {
  const out = [];
  let cursor = 0;
  for (const k of [...keeps].sort((a, b) => a.start - b.start)) {
    if (k.start > cursor + 0.01) out.push({ start: cursor, end: k.start });
    cursor = Math.max(cursor, k.end);
  }
  if (cursor < duration - 0.01) out.push({ start: cursor, end: duration });
  return out;
}

// 원본 탭으로 전환해 지정 구간만 재생하고 끝나면 멈춘다. src 를 갈아끼우면
// 로드가 끝나야 seek 이 먹으므로 loadeddata 를 기다린다.
function playOriginalRange(start, end) {
  if (!originalUrl) return;
  clearTimeout(cutsPreviewTimer);
  const go = () => {
    resultVideo.currentTime = start;
    resultVideo.play().catch(() => {});
    cutsPreviewTimer = setTimeout(() => resultVideo.pause(), Math.max(300, (end - start) * 1000));
  };
  if (previewMode !== "original") {
    setPreviewMode("original");
    resultVideo.addEventListener("loadeddata", go, { once: true });
  } else {
    go();
  }
}

// 잘린 구간만 이어서 재생 — 무음만 제대로 지웠는지 귀로 확인하는 용도.
async function previewRemovedOnly(duration, keeps) {
  const removed = removedRanges(duration, keeps);
  if (!originalUrl || removed.length === 0) return;
  if (previewMode !== "original") {
    setPreviewMode("original");
    await new Promise((r) => resultVideo.addEventListener("loadeddata", r, { once: true }));
  }
  for (const r of removed) {
    resultVideo.currentTime = r.start;
    await resultVideo.play().catch(() => {});
    await new Promise((res) => setTimeout(res, Math.max(200, (r.end - r.start) * 1000)));
  }
  resultVideo.pause();
}

// ── CapCut 드래프트 내보내기 ─────────────────────────────────────────────────
exportDraftBtn.addEventListener("click", () => {
  if (!pickedFile || lastKeeps.length === 0) return;
  const draft = buildCapCutDraft(pickedFile.name, lastKeeps, pickedDuration);
  const blob = new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "draft_content.json";
  a.click();
  URL.revokeObjectURL(url);
});

function uuid() {
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
  ).toUpperCase();
}
const us = (s) => Math.round(s * 1e6);

function buildCapCutDraft(fileName, keeps, duration) {
  const videoId = uuid(), audioId = uuid();
  const vSegs = [], aSegs = [];
  let cursor = 0;
  for (const k of keeps) {
    const dur = k.end - k.start;
    const common = {
      source_timerange: { start: us(k.start), duration: us(dur) },
      target_timerange: { start: us(cursor), duration: us(dur) },
      speed: 1.0, volume: 1.0, visible: true, extra_material_refs: [],
    };
    vSegs.push({ id: uuid(), material_id: videoId, ...common });
    aSegs.push({ id: uuid(), material_id: audioId, ...common });
    cursor += dur;
  }
  const ratioMap = { "16:9": [1920, 1080], "9:16": [1080, 1920], "1:1": [1080, 1080] };
  const [w, h] = ratioMap[state.ratio] || [1920, 1080];
  return {
    id: uuid(),
    name: fileName.replace(/\.[^.]+$/, ""),
    duration: us(cursor),
    fps: 30.0,
    canvas_config: { width: w, height: h, ratio: state.ratio },
    materials: {
      videos: [{ id: videoId, type: "video", path: fileName, material_name: fileName, duration: us(duration) }],
      audios: [{ id: audioId, type: "extract_music", path: fileName, name: fileName, duration: us(duration) }],
      texts: [], stickers: [], effects: [], transitions: [],
    },
    tracks: [
      { id: uuid(), type: "video", segments: vSegs },
      { id: uuid(), type: "audio", segments: aSegs },
    ],
    version: 360000,
    new_version: "100.0.0",
  };
}

// ── UI helpers ───────────────────────────────────────────────────────────────
function setBar(pct) {
  bar.style.width = `${pct}%`;
  const fill = $("miniProgFill");
  if (fill) fill.style.width = `${pct}%`;
  syncMiniProgress();
}
function formatHMS(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const r = (s % 60).toString().padStart(2, "0");
  return `${m}:${r}`;
}
function setStatus(msg) {
  statusEl.textContent = msg;
  const t = $("miniProgText");
  // 여러 줄 안내(용량 초과 등)는 첫 줄만 요약으로 쓴다.
  if (t) t.textContent = String(msg || "").split("\n")[0].slice(0, 120);
  syncMiniProgress();
}

// 진행 패널이 열려 있는 동안만 상단 요약을 띄운다.
function syncMiniProgress() {
  const mini = $("miniProg");
  if (!mini) return;
  const active = !progress.hidden && String(statusEl.textContent || "").trim().length > 0;
  mini.hidden = !active;
  document.querySelector(".wb")?.classList.toggle("wb--running", active);
}

// ── 자막 파이프라인 진단 패널 ────────────────────────────────────────────
function resetSubtitleSteps() {
  subtitleSteps.clear();
  subtitleDebugBanner = "";
  for (const [key] of SUB_STEP_ORDER) {
    subtitleSteps.set(key, { status: "pending", detail: "" });
  }
  renderSubtitleSteps();
}

function setSubtitleStep(key, status, detail) {
  if (!subtitleSteps.has(key)) subtitleSteps.set(key, { status: "pending", detail: "" });
  const cur = subtitleSteps.get(key);
  subtitleSteps.set(key, {
    status: status || cur.status,
    detail: detail !== undefined ? String(detail) : cur.detail,
  });
  // 진단 패널을 즉시 노출 — 자막 처리 중 라이브로 보이게.
  const block = document.getElementById("subtitleDebugBlock");
  if (block) block.hidden = false;
  renderSubtitleSteps();
}

function setSubtitleBanner(html) {
  subtitleDebugBanner = html || "";
  const banner = document.getElementById("subtitleDebugBanner");
  if (!banner) return;
  if (html) {
    banner.innerHTML = html;
    banner.hidden = false;
    const block = document.getElementById("subtitleDebugBlock");
    if (block) block.hidden = false;
  } else {
    banner.hidden = true;
    banner.textContent = "";
  }
}

const SUB_ICON = {
  pending: "·",
  running: "⏳",
  ok: "✓",
  warn: "⚠",
  error: "✗",
};
function renderSubtitleSteps() {
  const ol = document.getElementById("subtitleSteps");
  if (!ol) return;
  ol.innerHTML = SUB_STEP_ORDER.map(([key, label]) => {
    const s = subtitleSteps.get(key) || { status: "pending", detail: "" };
    const icon = SUB_ICON[s.status] || "·";
    const detail = s.detail
      ? `<span class="detail">${escapeHtml(s.detail)}</span>` : "";
    return `<li class="sub-step ${s.status}">
      <span class="icon">${icon}</span>
      <span><span class="label">${label}</span>${detail}</span>
    </li>`;
  }).join("");
}

// 인코딩 완료 메시지에 자막 결과를 덧붙인다 — 자막 실패가 "완료!" 에 가려지지 않게.
function combineCompletionStatus(base) {
  const s = lastSubtitleStatus;
  if (!s) return base;
  if (s.ok) return `${base} · 자막 ${s.count}줄 (${(s.ms / 1000).toFixed(1)}s)`;
  if (s.reason === "자동 자막 OFF") return base; // 사용자가 끈 거니 침묵
  return `${base} · ⚠ 자막 실패: ${s.reason}`;
}
function appendLog(msg) {
  logEl.textContent += msg + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}
function resetSteps() {
  stepper.querySelectorAll("li").forEach((li) => li.classList.remove("active", "done"));
}
function setStep(name) {
  stepper.querySelectorAll("li").forEach((li) => {
    if (li.dataset.step === name) li.classList.add("active");
    else li.classList.remove("active");
  });
}
function doneStep(name) {
  const li = stepper.querySelector(`[data-step="${name}"]`);
  if (li) {
    li.classList.remove("active");
    li.classList.add("done");
  }
}

function renderStats({ inputDuration, outputDuration, cutTime, cuts, ratio, speed, sizeMB, inputCount }) {
  const fmt = (s) => {
    const m = Math.floor(s / 60);
    const r = Math.round(s - m * 60);
    return m > 0 ? `${m}분 ${r}초` : `${r}초`;
  };
  // 다중 입력 표시는 입력 영상이 2개 이상일 때만.
  const inputCountCard = inputCount && inputCount > 1
    ? `<div><strong>${inputCount}개</strong><span>원본 영상 수</span></div>` : "";
  resultStats.innerHTML = `
    ${inputCountCard}
    <div><strong>${fmt(inputDuration)}</strong><span>원본 길이</span></div>
    <div><strong>${fmt(outputDuration)}</strong><span>편집본 길이</span></div>
    <div><strong>${fmt(cutTime)}</strong><span>제거된 시간</span></div>
    <div><strong>${cuts}</strong><span>컷 수</span></div>
    <div><strong>${ratio}</strong><span>출력 비율</span></div>
    <div><strong>${speed}x</strong><span>재생 속도</span></div>
    <div><strong>${sizeMB.toFixed(1)} MB</strong><span>파일 크기</span></div>
  `;
}

function onError(err) {
  console.error(err);
  // 브라우저의 NotReadableError 원문은 "permission problems" 라고만 해서 실제 원인
  // (파일이 너무 크거나, 외장/네트워크 드라이브가 끊겼거나, 파일이 바뀜)을 알 수 없다.
  const name = err?.name || "";
  if (name === "NotReadableError" || /could not be read/i.test(err?.message || "")) {
    const mb = pickedFiles.reduce((a, f) => a + f.size, 0) / 1024 / 1024;
    setStatus(mb > MAX_UPLOAD_MB
      ? oversizeMessage(mb)
      : "브라우저가 파일을 읽지 못했습니다. 외장 드라이브·네트워크 드라이브에 있거나 " +
        "선택 후 파일이 옮겨졌을 수 있습니다. 파일을 내 컴퓨터 디스크로 복사한 뒤 다시 선택해 주세요.");
    resultSection.hidden = true;
    runBtn.disabled = false;
    return;
  }
  // 편집 실패 시 미리보기는 노출하지 않는다. 진행 패널의 status 영역에 에러만 표시.
  resultSection.hidden = true;
  setStatus("오류: " + (err?.message || err));
  runBtn.disabled = false;
}
