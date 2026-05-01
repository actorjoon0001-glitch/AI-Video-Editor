// 브라우저에서 ffmpeg.wasm 으로 무음 컷·비율 변환·숏폼 추출을 수행하는 클라이언트.
// 외부 의존: window.FFmpegWASM, window.FFmpegUtil (UMD via index.html)

const { FFmpeg } = window.FFmpegWASM;
const { fetchFile, toBlobURL } = window.FFmpegUtil;

const FFMPEG_CORE_BASE = "https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/umd";

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

// ── State ────────────────────────────────────────────────────────────────────
let ffmpeg = null;
let pickedFile = null;
let pickedDuration = 0;
let lastKeeps = [];
let outputUrl = null;

const state = {
  preset: "standard",
  ratio: "16:9",
  mode: "full",
};

// ── Sliders ──────────────────────────────────────────────────────────────────
const sliders = [
  ["silenceDb", "silenceDbVal", (v) => `${v} dB`],
  ["minSilence", "minSilenceVal", (v) => `${parseFloat(v).toFixed(1)} s`],
  ["padding", "paddingVal", (v) => `${parseFloat(v).toFixed(2)} s`],
  ["shortLen", "shortLenVal", (v) => `${v} s`],
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
      "Netlify 배포본에서 시도해 주세요."
    );
  }
  setStep("load");
  setStatus("ffmpeg 엔진 로드 중... (최초 1회, ~30MB)");
  ffmpeg = new FFmpeg();
  ffmpeg.on("log", ({ message }) => appendLog(message));
  ffmpeg.on("progress", ({ progress: p }) => setBar(Math.min(0.99, p) * 100));
  await ffmpeg.load({
    coreURL: await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
    workerURL: await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.worker.js`, "text/javascript"),
  });
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

// 페이지 어디서든 드래그 가능하도록 (드롭존 외부)
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f && f.type.startsWith("video/")) handleFile(f);
});

resetBtn.addEventListener("click", () => {
  pickedFile = null;
  fileInput.value = "";
  controls.hidden = true;
  progress.hidden = true;
  resultSection.hidden = true;
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

runBtn.addEventListener("click", () => runPipeline().catch(onError));

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
  setStatus("파일 업로드 중...");
  await ff.writeFile(inName, await fetchFile(pickedFile));

  setStatus("길이 측정 중...");
  pickedDuration = await measureDuration(ff, inName);
  appendLog(`duration = ${pickedDuration.toFixed(2)}s`);
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

  // 컷 + 비율 변환
  setStep("encode");
  const cutTotal = pickedDuration - keeps.reduce((a, k) => a + (k.end - k.start), 0);
  setStatus(`컷·인코딩 중... (제거 ${cutTotal.toFixed(1)}s · 비율 ${state.ratio})`);
  setBar(0);
  await applyCutsAndRatio(ff, inName, outName, keeps, state.ratio);
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

  // 통계
  const outDuration = keeps.reduce((a, k) => a + (k.end - k.start), 0);
  renderStats({
    inputDuration: pickedDuration,
    outputDuration: outDuration,
    cutTime: cutTotal,
    cuts: keeps.length,
    ratio: state.ratio,
    sizeMB: blob.size / 1024 / 1024,
  });

  setBar(100);
  setStatus("완료!");
  resultSection.hidden = false;
  resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
  runBtn.disabled = false;

  try { await ff.deleteFile(inName); } catch {}
  try { await ff.deleteFile(outName); } catch {}
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

async function measureDuration(ff, inName) {
  let dur = 0;
  const handler = ({ message }) => {
    const m = message.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
    if (m) dur = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
  };
  ff.on("log", handler);
  await ff.exec(["-i", inName, "-f", "null", "-"]).catch(() => {});
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
  await ff.exec([
    "-i", inName,
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

async function applyCutsAndRatio(ff, inName, outName, keeps, ratio) {
  const ratioFilter = ratioToFilter(ratio);
  const parts = [];
  for (let i = 0; i < keeps.length; i++) {
    const { start, end } = keeps[i];
    parts.push(
      `[0:v]trim=start=${start.toFixed(3)}:end=${end.toFixed(3)},setpts=PTS-STARTPTS,${ratioFilter}[v${i}];` +
      `[0:a]atrim=start=${start.toFixed(3)}:end=${end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`
    );
  }
  const concatInputs = keeps.map((_, i) => `[v${i}][a${i}]`).join("");
  const filter = parts.join(";") +
    `;${concatInputs}concat=n=${keeps.length}:v=1:a=1[outv][outa]`;

  await ff.exec([
    "-i", inName,
    "-filter_complex", filter,
    "-map", "[outv]", "-map", "[outa]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    outName,
  ]);
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

function renderStats({ inputDuration, outputDuration, cutTime, cuts, ratio, sizeMB }) {
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
    <div><strong>${sizeMB.toFixed(1)} MB</strong><span>파일 크기</span></div>
  `;
}

function onError(err) {
  console.error(err);
  setStatus("오류: " + (err?.message || err));
  runBtn.disabled = false;
}
