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
const FFMPEG_CORE_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.6/dist/umd";

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
let pickedFile = null;
let pickedDuration = 0;
let lastKeeps = [];
let outputUrl = null;
let bgmFile = null;
let thumbUrls = [];

const state = {
  preset: "standard",
  ratio: "16:9",
  mode: "full",
  speed: 1.0,
};

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
async function ensureFFmpeg() {
  if (ffmpeg) return ffmpeg;
  if (!window.crossOriginIsolated) {
    throw new Error(
      "이 페이지가 cross-origin isolated 상태가 아닙니다. " +
      "Netlify 배포본에서 시도해 주세요. (로컬 정적 서버는 COOP/COEP 헤더가 필요)"
    );
  }
  setStep("load");
  setStatus("ffmpeg 엔진 로드 중... (최초 1회, ~30MB)");
  const instance = new FFmpeg();
  instance.on("log", ({ message }) => appendLog(message));
  // 주의: 전역 progress 핸들러를 두지 않는다. 인코딩 단계에서 직접 시간 기반으로 추적.
  // ffmpeg.wasm 의 progress 이벤트는 복잡한 필터 그래프에서 0↔1 을 오가며 튀는 경향이 있어
  // 우리의 time= 파싱 진행률과 충돌해 바가 갑자기 0% 로 보이는 문제 유발.
  try {
    const [coreURL, wasmURL, workerURL] = await Promise.all([
      toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
      toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
      toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.worker.js`, "text/javascript"),
    ]);
    await instance.load({ coreURL, wasmURL, workerURL });
  } catch (e) {
    // 로드 실패 시 다음 시도가 깨끗하게 다시 시작하도록 인스턴스 폐기
    ffmpeg = null;
    throw new Error(
      "ffmpeg 엔진 로드 실패: " + (e?.message || e) +
      "\n네트워크 또는 CDN 차단(광고 차단기/회사 방화벽) 가능성. 새로고침 후 다시 시도해 주세요."
    );
  }
  ffmpeg = instance;
  doneStep("load");
  return ffmpeg;
}

// ── Dropzone & file picker ───────────────────────────────────────────────────
function handleFile(file) {
  if (!file || !file.type.startsWith("video/")) {
    setStatus("영상 파일이 아닙니다.");
    return;
  }
  pickedFile = file;
  controls.hidden = false;
  resultSection.hidden = true;
  progress.hidden = true;
  document.querySelector(".dz-title").textContent = `✓ ${file.name}`;
  document.querySelector(".dz-sub").textContent =
    `${(file.size / 1024 / 1024).toFixed(1)} MB · 다른 파일을 드래그하면 교체됩니다`;
  // 부드럽게 컨트롤로 스크롤
  controls.scrollIntoView({ behavior: "smooth", block: "start" });
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});
pickBtn.addEventListener("click", (e) => { e.stopPropagation(); fileInput.click(); });
fileInput.addEventListener("change", () => handleFile(fileInput.files[0]));

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
  const f = e.dataTransfer?.files?.[0];
  if (f) handleFile(f);
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
  const f = e.dataTransfer?.files?.[0];
  if (f && f.type.startsWith("video/")) handleFile(f);
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
  fileInput.value = "";
  controls.hidden = true;
  progress.hidden = true;
  resultSection.hidden = true;
  thumbsBlock.hidden = true;
  thumbUrls.forEach((u) => URL.revokeObjectURL(u));
  thumbUrls = [];
  thumbsGrid.innerHTML = "";
  if (outputUrl) { URL.revokeObjectURL(outputUrl); outputUrl = null; }
  document.querySelector(".dz-title").textContent = "여기로 영상을 드래그하세요";
  document.querySelector(".dz-sub").innerHTML =
    '또는 <button type="button" id="pickBtn" class="link">파일 선택</button> · mp4 / mov / webm';
  // 새 pickBtn 이벤트 재바인딩
  document.getElementById("pickBtn").addEventListener("click", (e) => {
    e.stopPropagation(); fileInput.click();
  });
  setStatus("");
});

runBtn.addEventListener("click", () => {
  const useServer = $("serverMode")?.checked && BACKEND_URL;
  (useServer ? runServerPipeline() : runPipeline()).catch(onError);
});

// ── 백엔드 파이프라인 ────────────────────────────────────────────────────────
async function runServerPipeline() {
  if (!pickedFile) return;
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
  resultVideo.src = outputUrl;
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
  });

  // 썸네일은 결과 mp4 가 작아서 ffmpeg.wasm 로 빠르게 추출 가능 — 일단 스킵하거나 결과에서 직접 추출
  setStep("thumbs");
  setStatus("썸네일 추출 (선택)");
  doneStep("thumbs");
  thumbsBlock.hidden = true;

  setBar(100);
  setStatus(`완료! 총 ${((Date.now() - reqStart) / 1000).toFixed(1)}초`);
  resultSection.hidden = false;
  resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
  runBtn.disabled = false;
}

// ── 파이프라인 ───────────────────────────────────────────────────────────────
async function runPipeline() {
  if (!pickedFile) return;
  runBtn.disabled = true;
  resultSection.hidden = true;
  progress.hidden = false;
  logEl.textContent = "";
  resetSteps();
  setBar(0);

  const ff = await ensureFFmpeg();
  const inName = "input" + extOf(pickedFile.name);
  const outName = "output.mp4";

  setStep("probe");
  setStatus("길이 확인 중...");
  // 1단계: 브라우저 메타데이터로 즉시 길이 읽기 시도 (대부분의 코덱에서 즉시 끝남)
  pickedDuration = await measureDurationFromFile(pickedFile);
  if (pickedDuration > 0) {
    appendLog(`duration (browser) = ${pickedDuration.toFixed(2)}s`);
  }

  setStatus("파일 읽는 중...");
  const inputBytes = await readFileBytes(pickedFile);
  appendLog(`read ${inputBytes.byteLength} bytes from ${pickedFile.name}`);
  if (inputBytes.byteLength === 0) {
    throw new Error("파일이 비어 있거나 읽기에 실패했습니다.");
  }
  setStatus("ffmpeg에 파일 적재 중...");
  await ff.writeFile(inName, inputBytes);
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
    keeps = await pickHighlightWindow(ff, inName, pickedDuration, targetLen);
    appendLog(`highlight: ${keeps[0].start.toFixed(2)} → ${keeps[0].end.toFixed(2)}`);
  } else {
    const noiseDb = parseFloat($("silenceDb").value);
    const minSilence = parseFloat($("minSilence").value);
    const padding = parseFloat($("padding").value);
    setStatus(`무음 감지 (noise<${noiseDb}dB, ≥${minSilence}s)...`);
    const silences = await detectSilences(ff, inName, noiseDb, minSilence);
    keeps = invertSilences(pickedDuration, silences, padding);
    appendLog(`silences: ${silences.length} · keeps: ${keeps.length}`);
  }
  doneStep("detect");

  if (keeps.length === 0) {
    throw new Error("남은 구간이 없습니다. 임계값을 완화해 보세요.");
  }
  lastKeeps = keeps;

  // 컷 + 비율 + 속도 + BGM + 정규화
  setStep("encode");
  const cutTotal = pickedDuration - keeps.reduce((a, k) => a + (k.end - k.start), 0);
  const encodeOpts = {
    ratio: state.ratio,
    speed: state.speed,
    bgmName: bgmFile ? "bgm" + extOf(bgmFile.name) : null,
    bgmVolDb: parseFloat($("bgmVol").value),
    loudnorm: $("loudnorm").checked,
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
  resultVideo.src = outputUrl;
  downloadBtn.href = outputUrl;
  downloadBtn.download = outputFileName(pickedFile.name);

  // 통계 (속도 적용 후 길이)
  const rawOutDuration = keeps.reduce((a, k) => a + (k.end - k.start), 0);
  const outDuration = rawOutDuration / state.speed;
  renderStats({
    inputDuration: pickedDuration,
    outputDuration: outDuration,
    cutTime: cutTotal,
    cuts: keeps.length,
    ratio: state.ratio,
    speed: state.speed,
    sizeMB: blob.size / 1024 / 1024,
  });

  // 썸네일 후보 추출
  setStep("thumbs");
  setStatus("썸네일 후보 추출 중...");
  await extractThumbnails(ff, outName, outDuration, 6);
  doneStep("thumbs");

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
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
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

// 숏폼: astats(루드니스 평균 dB) 윈도우 검색으로 가장 시끄러운 구간 N초 선택
async function pickHighlightWindow(ff, inName, duration, targetLen) {
  // 1초 간격으로 RMS 측정 → 슬라이딩 윈도우 합 최대 위치
  const samples = [];
  const handler = ({ message }) => {
    const m = message.match(/lavfi\.astats\.Overall\.RMS_level=(-?\d+\.?\d*)/);
    if (m) samples.push(parseFloat(m[1]));
  };
  ff.on("log", handler);
  await ff.exec([
    "-i", inName,
    "-af", "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
    "-f", "null", "-",
  ]).catch(() => {});
  ff.off("log", handler);

  if (samples.length === 0) {
    // 측정 실패 시 영상 중간을 사용
    const start = Math.max(0, (duration - targetLen) / 2);
    return [{ start, end: Math.min(duration, start + targetLen) }];
  }

  // RMS는 dB(음수). -inf 같은 값은 -100으로 클램프
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
  return [{ start, end }];
}

// 거대한 단일 filter_complex 는 ffmpeg.wasm core-mt 에서 keep 수가 늘어나면
// 필터 그래프 init 단계에서 worker 가 멈추는 경향이 있다. 작은 파일·소수 컷에서도
// 재현됨. 그래서 3단계로 나눈다:
//  A. 각 keep 을 -c copy 로 분리해 짧은 mp4 조각으로 export (재인코딩 X)
//  B. concat demuxer + -c copy 로 조각들을 하나로 합침 (재인코딩 X)
//  C. 합쳐진 단일 파일에 ratio/speed/loudnorm/BGM 을 한 번만 적용
// 각 단계의 ffmpeg 호출은 필터 그래프가 단순해 worker init 병목이 사라진다.
async function applyCutsAndRatio(ff, inName, outName, keeps, opts, onStage) {
  const { ratio, speed, bgmName, bgmVolDb, loudnorm } = opts;
  const ratioFilter = ratioToFilter(ratio);

  const segFiles = [];
  // 단계 A: 컷 분리 (-c copy)
  for (let i = 0; i < keeps.length; i++) {
    onStage?.({ phase: "segment", current: i + 1, total: keeps.length });
    const seg = `seg_${String(i).padStart(4, "0")}.mp4`;
    const { start, end } = keeps[i];
    // -ss/-to 를 -i 앞에 둬서 keyframe 스냅 + 빠른 시크.
    // -avoid_negative_ts make_zero 로 세그먼트 PTS 를 0 부터 다시 시작.
    await execWithWatchdog(ff, [
      "-ss", start.toFixed(3),
      "-to", end.toFixed(3),
      "-i", inName,
      "-c", "copy",
      "-avoid_negative_ts", "make_zero",
      "-y", seg,
    ]);
    segFiles.push(seg);
  }

  // 단계 B: concat demuxer 로 합치기
  onStage?.({ phase: "concat" });
  const list = segFiles.map((f) => `file '${f}'`).join("\n");
  await ff.writeFile("concat_list.txt", new TextEncoder().encode(list));
  await execWithWatchdog(ff, [
    "-f", "concat",
    "-safe", "0",
    "-i", "concat_list.txt",
    "-c", "copy",
    "-y", "joined.mp4",
  ]);

  // 단계 C: 효과 적용 (ratio/speed/loudnorm/BGM)
  onStage?.({ phase: "effects" });
  const speedV = speed === 1.0 ? null : `setpts=${(1 / speed).toFixed(4)}*PTS`;
  const speedA = speed === 1.0 ? null : atempoChain(speed);
  let vChain = ratioFilter;
  if (speedV) vChain += `,${speedV}`;
  let aChain = "";
  if (speedA && speedA !== "anull") aChain = speedA;
  if (loudnorm) aChain = (aChain ? aChain + "," : "") + "loudnorm=I=-16:LRA=11:TP=-1.5";

  let effectsArgs;
  if (!bgmName) {
    // 단순한 -vf / -af 경로. filter_complex 회피.
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
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart",
    "-y", outName,
  );
  await execWithWatchdog(ff, effectsArgs);

  // 정리
  for (const f of segFiles) { try { await ff.deleteFile(f); } catch {} }
  try { await ff.deleteFile("concat_list.txt"); } catch {}
  try { await ff.deleteFile("joined.mp4"); } catch {}
}

// 20초 동안 log/progress 가 없으면 worker hang 으로 보고 ffmpeg.wasm 인스턴스를
// 강제 종료. 다음 호출에서 ensureFFmpeg() 가 새 인스턴스를 만든다.
const HANG_TIMEOUT_MS = 20_000;
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
      ffmpeg = null; // 다음 시도가 깨끗하게 다시 로드
    }
  }, 1000);
  try {
    await ff.exec(args);
  } catch (e) {
    if (killed) {
      throw new Error(
        "브라우저 ffmpeg 가 20초간 진행이 없어 중단됐습니다. " +
        "세부 설정의 '고속 모드'(외부 서버) 를 켜고 다시 시도해 주세요. " +
        "긴 영상이거나 BGM·loudnorm 조합이면 브라우저 인코딩이 부담입니다."
      );
    }
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

function renderStats({ inputDuration, outputDuration, cutTime, cuts, ratio, speed, sizeMB }) {
  const fmt = (s) => {
    const m = Math.floor(s / 60);
    const r = Math.round(s - m * 60);
    return m > 0 ? `${m}분 ${r}초` : `${r}초`;
  };
  resultStats.innerHTML = `
    <div><strong>${fmt(outputDuration)}</strong><span>출력 길이</span></div>
    <div><strong>${fmt(cutTime)}</strong><span>제거된 시간</span></div>
    <div><strong>${cuts}</strong><span>컷 수</span></div>
    <div><strong>${ratio}</strong><span>출력 비율</span></div>
    <div><strong>${speed}x</strong><span>재생 속도</span></div>
    <div><strong>${sizeMB.toFixed(1)} MB</strong><span>파일 크기</span></div>
  `;
}

function onError(err) {
  console.error(err);
  setStatus("오류: " + (err?.message || err));
  runBtn.disabled = false;
}
