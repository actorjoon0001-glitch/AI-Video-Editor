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
// 백엔드 헬스체크 캐시 — 한 세션 내 중복 호출 방지.
let backendHealthCache = null; // { ok, routes, checkedAt } | { ok: false, error }

const state = {
  preset: "standard",
  ratio: "16:9",
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
  // 부드럽게 컨트롤로 스크롤
  controls.scrollIntoView({ behavior: "smooth", block: "start" });
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

// 백엔드 URL 미설정 시 토글 비활성
window.addEventListener("DOMContentLoaded", () => {
  const cb = $("serverMode");
  const hint = $("serverModeHint");
  if (!cb) return;
  if (!BACKEND_URL) {
    cb.disabled = true;
    if (hint) hint.textContent = "* 백엔드 URL 이 설정되지 않았습니다. localStorage.setItem('backendUrl','https://...') 또는 코드 DEFAULT_BACKEND_URL 변경 필요.";
  } else if (hint) {
    hint.textContent = `* 영상이 일시 서버를 거칩니다 (HTTPS, 처리 후 1시간 내 자동 삭제). 백엔드: ${BACKEND_URL}`;
  }
});

resetBtn.addEventListener("click", () => {
  pickedFile = null;
  pickedFiles = [];
  fileInput.value = "";
  controls.hidden = true;
  progress.hidden = true;
  resultSection.hidden = true;
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
  const useServer = $("serverMode")?.checked && BACKEND_URL;
  // 사용자가 명시적으로 안전 모드를 켰으면 fallback 체인 건너뛰고 바로 안전 모드.
  const userSafe = $("safeMode")?.checked === true;
  (useServer
    ? runServerPipeline()
    : runWithFallback({ userSafe })
  ).catch(onError);
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
    const noiseDb = parseFloat($("silenceDb").value);
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
  setStatus(`완료! 총 ${((Date.now() - reqStart) / 1000).toFixed(1)}초`);
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
    const noiseDb = parseFloat($("silenceDb").value);
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
  setStatus("완료!");
  resultSection.hidden = false;
  resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
  runBtn.disabled = false;

  try { await ff.deleteFile(inName); } catch {}
  try { await ff.deleteFile(outName); } catch {}
  if (encodeOpts.bgmName) { try { await ff.deleteFile(encodeOpts.bgmName); } catch {} }
}

// ── Web Audio 기반 무음 감지 (백엔드 모드용 — ffmpeg.wasm 불필요) ─────────────
async function detectSilencesWebAudio(file, noiseDb, minSilence) {
  // AudioContext 로 디코딩 (브라우저가 코덱 지원해야 함, AAC 는 대부분 OK).
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  let buf;
  try {
    buf = await ctx.decodeAudioData(await file.arrayBuffer());
  } finally {
    ctx.close().catch(() => {});
  }
  const sr = buf.sampleRate;
  const nch = buf.numberOfChannels;
  const winSize = Math.max(1, Math.floor(sr * 0.05)); // 50ms 창
  const winDuration = winSize / sr;
  const totalWin = Math.floor(buf.length / winSize);
  const noiseLin = Math.pow(10, noiseDb / 20);

  const channels = [];
  for (let c = 0; c < nch; c++) channels.push(buf.getChannelData(c));

  const silences = [];
  let silentRun = 0;
  let runStart = 0;
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
    const isSilent = rms < noiseLin;
    if (isSilent) {
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

// ── 백엔드 처리 흐름 (/api/process 업로드) ───────────────────────────────────
// ── 자동 자막 (백엔드 Whisper) ─────────────────────────────────────────────
// 인코딩 끝난 결과 blob 을 백엔드 /api/transcribe 로 전송 → SRT/VTT 받음.
// "자막 번인" 옵션이면 SRT 와 함께 /api/burn-subtitles 호출 → 번인된 mp4 로 교체.
// ── 백엔드 Whisper 분석 (editPlan) ──────────────────────────────────────────
// 필러 모드 가 OFF 가 아닐 때 인코딩 전 호출. 같은 /api/transcribe 엔드포인트를
// fillerMode 옵션과 함께 호출해 word-level + editPlan 을 받는다.
async function fetchEditPlan(file, fillerMode) {
  if (!BACKEND_URL) throw new Error("백엔드 URL 미설정");
  // 같은 헬스체크 캐시를 공유 — 자막 + 필러가 둘 다 켜져도 health 는 한 번만.
  const health = await checkBackendHealth();
  if (!health.ok) {
    throw new Error(`자막/필러 서버 연결 실패: ${health.error}`);
  }
  const fd = new FormData();
  fd.append("video", file);
  fd.append("language", "ko");
  fd.append("model", "small");
  fd.append("fillerMode", fillerMode);
  const r = await fetch(`${BACKEND_URL}/api/transcribe`, { method: "POST", body: fd });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    if (r.status === 404 && isRouteMissingResponse(t)) {
      backendHealthCache = null;
      throw new Error(
        "자막 서버 연결 실패: 백엔드 API URL 또는 배포 상태를 확인하세요. " +
        "(/api/transcribe 라우트 없음 — Render 재배포 필요)"
      );
    }
    throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
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
    backendHealthCache = { ok: false, error: "백엔드 URL 이 설정돼 있지 않습니다." };
    return backendHealthCache;
  }
  try {
    const r = await fetch(`${BACKEND_URL}/api/health`, { method: "GET" });
    if (!r.ok) {
      // /api/health 가 없으면 /healthz fallback 시도 (구버전 호환).
      const r2 = await fetch(`${BACKEND_URL}/healthz`).catch(() => null);
      if (r2?.ok) {
        backendHealthCache = { ok: true, routes: null, legacy: true };
        return backendHealthCache;
      }
      backendHealthCache = { ok: false, error: `백엔드 헬스체크 실패 (HTTP ${r.status}). 배포 상태 확인 필요.` };
      return backendHealthCache;
    }
    const body = await r.json();
    backendHealthCache = { ok: true, routes: body.routes || null, version: body.version };
    return backendHealthCache;
  } catch (e) {
    backendHealthCache = { ok: false, error: `백엔드 연결 실패: ${e?.message || e}` };
    return backendHealthCache;
  }
}

// 백엔드 응답이 Express 의 "Cannot POST /api/X" HTML 인지 판별 — 라우트 미존재 시그널.
function isRouteMissingResponse(text) {
  return /Cannot (POST|GET) \//.test(text || "");
}

async function maybeGenerateSubtitles(resultBlob) {
  resetSubtitleState();
  const enabled = $("autoSubtitles")?.checked === true;
  if (!enabled) {
    syncSubtitleButtons(); // 비활성 상태 그대로 유지
    return;
  }
  if (!BACKEND_URL) {
    appendLog("자동 자막: 백엔드 URL 이 설정돼 있지 않아 건너뜀");
    syncSubtitleButtons("백엔드 URL 미설정");
    return;
  }

  // 사전 헬스체크. 라우트가 없으면 무거운 영상 업로드를 시작하지 않는다.
  setStatus("자동 자막: 백엔드 헬스체크 중...");
  const health = await checkBackendHealth();
  if (!health.ok) {
    const msg = `자막 서버 연결 실패: ${health.error || "알 수 없음"}`;
    appendLog(msg);
    setStatus(msg);
    syncSubtitleButtons("백엔드 연결 실패 (배포 상태 확인 필요)");
    return;
  }
  // routes 가 노출되면 transcribe 가 등록돼 있는지 직접 확인.
  if (Array.isArray(health.routes)) {
    const has = health.routes.some((r) => r.path === "/api/transcribe" && r.method === "POST");
    if (!has) {
      const msg = "자막 서버는 살아있지만 /api/transcribe 라우트가 없음. " +
        "백엔드(Render) 가 옛 컨테이너로 돌고 있을 가능성 — 강제 재배포 필요.";
      appendLog(msg);
      setStatus(msg);
      syncSubtitleButtons("/api/transcribe 라우트 없음 (백엔드 재배포 필요)");
      return;
    }
  }

  setStatus("자동 자막 생성 중 (백엔드 Whisper)...");
  let result;
  try {
    const fd = new FormData();
    fd.append("video", resultBlob, "edited.mp4");
    fd.append("language", "ko");
    fd.append("model", "small");
    const r = await fetch(`${BACKEND_URL}/api/transcribe`, { method: "POST", body: fd });
    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      // Express 가 라우트 미존재 시 "Cannot POST /api/transcribe" HTML 을 돌려줌.
      // 그 텍스트를 그대로 노출하지 않고 한국어 안내로 바꿔준다.
      if (r.status === 404 && isRouteMissingResponse(errText)) {
        backendHealthCache = null; // 다음 시도 때 다시 확인
        throw new Error(
          "자막 서버 연결 실패: 백엔드 API URL 또는 배포 상태를 확인하세요. " +
          "(/api/transcribe 라우트가 등록되지 않음 — Render 재배포 필요)"
        );
      }
      throw new Error(`HTTP ${r.status}: ${errText.slice(0, 300)}`);
    }
    result = await r.json();
  } catch (e) {
    console.error("자동 자막 실패:", e);
    appendLog(`자동 자막 실패: ${e?.message || e}`);
    setStatus(`자막 생성 실패 (영상은 정상 출력됨): ${e?.message || e}`);
    syncSubtitleButtons(`실패: ${e?.message || e}`);
    return;
  }

  // /api/transcribe 응답 검증 + 상태 저장
  subtitleJson = result;
  subtitleSrtText = (result.srt || "").trim();
  subtitleVttText = (result.vtt || "").trim();
  appendLog(
    `자막 ${result.segments?.length || 0}줄 · ` +
    `SRT ${subtitleSrtText.length}바이트 · VTT ${subtitleVttText.length}바이트 · ` +
    `${((result.durationMs || 0) / 1000).toFixed(1)}s`
  );

  // SRT Blob URL — application/x-subrip 가 정확. 일부 브라우저는 알 수 없는 MIME 일 때
  // download attr 를 무시하므로 명시적으로 지정.
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
  }
  syncSubtitleButtons();

  // 번인 옵션
  const burn = $("burnSubtitles")?.checked === true;
  if (burn && subtitleSrtText.length > 0) {
    setStatus("자막 번인 중 (백엔드 ffmpeg)...");
    try {
      const fd = new FormData();
      fd.append("video", resultBlob, "edited.mp4");
      fd.append("srt", subtitleSrtText);
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
    } catch (e) {
      console.error("번인 실패:", e);
      appendLog(`번인 실패 (자막은 정상 생성됨): ${e?.message || e}`);
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
  // load 이벤트 시 강제로 showing 으로 설정 (default 무시되는 브라우저 대응)
  track.addEventListener("load", () => {
    if (track.track) track.track.mode = "showing";
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

function ratioToFilter(ratio) {
  // 입력 해상도와 무관하게 중심 크롭 후 목표 비율 컨테이너로 스케일.
  // setsar=1 로 픽셀 정사각형 보장.
  if (ratio === "16:9") {
    // 가로영상 그대로 1280x720 표준
    return "scale='if(gt(a,16/9),1280,-2)':'if(gt(a,16/9),-2,720)',crop=1280:720,setsar=1";
  }
  if (ratio === "9:16") {
    // 세로 720x1280 — 가로영상이면 중앙 크롭
    return "crop='min(iw,ih*9/16)':ih,scale=720:1280,setsar=1";
  }
  if (ratio === "1:1") {
    return "crop='min(iw,ih)':'min(iw,ih)',scale=720:720,setsar=1";
  }
  return "scale=trunc(iw/2)*2:trunc(ih/2)*2";
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
function setBar(pct) { bar.style.width = `${pct}%`; }
function formatHMS(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const r = (s % 60).toString().padStart(2, "0");
  return `${m}:${r}`;
}
function setStatus(msg) { statusEl.textContent = msg; }
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
  // 편집 실패 시 미리보기는 노출하지 않는다. 진행 패널의 status 영역에 에러만 표시.
  resultSection.hidden = true;
  setStatus("오류: " + (err?.message || err));
  runBtn.disabled = false;
}
