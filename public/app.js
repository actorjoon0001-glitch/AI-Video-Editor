// 브라우저에서 ffmpeg.wasm 으로 무음 컷을 수행하는 클라이언트.
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
const resultMeta = $("resultMeta");

const sliders = [
  ["silenceDb", "silenceDbVal", (v) => `${v} dB`],
  ["minSilence", "minSilenceVal", (v) => `${parseFloat(v).toFixed(1)} s`],
  ["padding", "paddingVal", (v) => `${parseFloat(v).toFixed(2)} s`],
];
for (const [src, label, fmt] of sliders) {
  const s = $(src), l = $(label);
  s.addEventListener("input", () => (l.textContent = fmt(s.value)));
}

// ── State ────────────────────────────────────────────────────────────────────
let ffmpeg = null;
let pickedFile = null;
let lastResultBlob = null;
let lastKeeps = [];
let lastDuration = 0;

// ── ffmpeg.wasm 로드 ─────────────────────────────────────────────────────────
async function ensureFFmpeg() {
  if (ffmpeg) return ffmpeg;
  if (!window.crossOriginIsolated) {
    throw new Error(
      "이 페이지가 cross-origin isolated 상태가 아니라 ffmpeg.wasm 멀티스레드 모드를 쓸 수 없습니다. " +
      "Netlify 배포본에서 시도해 주세요. (로컬에서는 dev 서버에 COOP/COEP 헤더 필요)"
    );
  }
  setStatus("ffmpeg.wasm 로드 중... (최초 1회, ~30MB)");
  ffmpeg = new FFmpeg();
  ffmpeg.on("log", ({ message }) => appendLog(message));
  ffmpeg.on("progress", ({ progress: p }) => setBar(Math.min(0.99, p) * 100));
  await ffmpeg.load({
    coreURL: await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
    workerURL: await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.worker.js`, "text/javascript"),
  });
  setStatus("ffmpeg 준비 완료");
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
  setStatus(`선택됨: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
  $("dz-title-x") || (document.querySelector(".dz-title").textContent = `✓ ${file.name}`);
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

resetBtn.addEventListener("click", () => {
  pickedFile = null;
  fileInput.value = "";
  controls.hidden = true;
  progress.hidden = true;
  resultSection.hidden = true;
  document.querySelector(".dz-title").textContent = "여기로 영상 파일을 드래그하세요";
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
  setBar(0);

  const ff = await ensureFFmpeg();

  const inName = "input" + extOf(pickedFile.name);
  const outName = "output.mp4";

  setStatus("파일 업로드 중...");
  await ff.writeFile(inName, await fetchFile(pickedFile));

  setStatus("길이 측정 중...");
  const duration = await measureDuration(ff, inName);
  lastDuration = duration;
  appendLog(`duration = ${duration.toFixed(2)}s`);

  const noiseDb = parseFloat($("silenceDb").value);
  const minSilence = parseFloat($("minSilence").value);
  const padding = parseFloat($("padding").value);

  setStatus(`무음 감지 중 (noise<${noiseDb}dB, ≥${minSilence}s)...`);
  const silences = await detectSilences(ff, inName, noiseDb, minSilence);
  appendLog(`silences detected: ${silences.length}`);
  for (const s of silences) appendLog(`  silence ${s.start.toFixed(2)} → ${s.end.toFixed(2)}`);

  const keeps = invertSilences(duration, silences, padding);
  lastKeeps = keeps;
  appendLog(`keep segments: ${keeps.length}`);
  for (const k of keeps) appendLog(`  keep ${k.start.toFixed(2)} → ${k.end.toFixed(2)}`);

  if (keeps.length === 0) {
    throw new Error("남은 구간이 없습니다. 임계값을 완화해 보세요.");
  }

  const cutTotal = duration - keeps.reduce((a, k) => a + (k.end - k.start), 0);
  setStatus(`컷 적용 중... (제거 ${cutTotal.toFixed(1)}s / 총 ${duration.toFixed(1)}s)`);
  setBar(0);
  await applyCuts(ff, inName, outName, keeps);

  setStatus("결과 추출 중...");
  const data = await ff.readFile(outName);
  const blob = new Blob([data.buffer], { type: "video/mp4" });
  lastResultBlob = blob;
  const url = URL.createObjectURL(blob);
  resultVideo.src = url;
  downloadBtn.href = url;
  downloadBtn.download = `edited-${pickedFile.name.replace(/\.[^.]+$/, "")}.mp4`;
  resultMeta.textContent = `${(blob.size / 1024 / 1024).toFixed(1)} MB · ${keeps.length} 컷 · 제거 ${cutTotal.toFixed(1)}s`;

  setBar(100);
  setStatus("완료!");
  resultSection.hidden = false;
  runBtn.disabled = false;

  // FS 청소
  try { await ff.deleteFile(inName); } catch {}
  try { await ff.deleteFile(outName); } catch {}
}

// ── ffmpeg 헬퍼 ──────────────────────────────────────────────────────────────
function extOf(name) {
  const m = name.match(/\.[a-zA-Z0-9]+$/);
  return m ? m[0].toLowerCase() : ".mp4";
}

async function measureDuration(ff, inName) {
  let dur = 0;
  const handler = ({ message }) => {
    const m = message.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
    if (m) dur = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
  };
  ff.on("log", handler);
  // -f null - on no input would fail, run a no-op decode just to get headers
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

async function applyCuts(ff, inName, outName, keeps) {
  // trim & concat 필터
  const parts = [];
  for (let i = 0; i < keeps.length; i++) {
    const { start, end } = keeps[i];
    parts.push(
      `[0:v]trim=start=${start.toFixed(3)}:end=${end.toFixed(3)},setpts=PTS-STARTPTS[v${i}];` +
      `[0:a]atrim=start=${start.toFixed(3)}:end=${end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`
    );
  }
  const concatInputs = keeps.map((_, i) => `[v${i}][a${i}]`).join("");
  const filter = parts.join(";") +
    `;${concatInputs}concat=n=${keeps.length}:v=1:a=1[outv][outa]`;

  await ff.exec([
    "-i", inName,
    "-filter_complex", filter,
    "-map", "[outv]",
    "-map", "[outa]",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    outName,
  ]);
}

// ── CapCut 드래프트 내보내기 ─────────────────────────────────────────────────
exportDraftBtn.addEventListener("click", () => {
  if (!pickedFile || lastKeeps.length === 0) return;
  const draft = buildCapCutDraft(pickedFile.name, lastKeeps, lastDuration);
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
  const videoId = uuid();
  const audioId = uuid();
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
  return {
    id: uuid(),
    name: fileName.replace(/\.[^.]+$/, ""),
    duration: us(cursor),
    fps: 30.0,
    canvas_config: { width: 1920, height: 1080, ratio: "16:9" },
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

// ── UI 헬퍼 ──────────────────────────────────────────────────────────────────
function setBar(pct) { bar.style.width = `${pct}%`; }
function setStatus(msg) { statusEl.textContent = msg; }
function appendLog(msg) {
  logEl.textContent += msg + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}
function onError(err) {
  console.error(err);
  setStatus("오류: " + (err?.message || err));
  runBtn.disabled = false;
}
