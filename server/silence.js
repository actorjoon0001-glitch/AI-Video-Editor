// 서버 측 무음 감지.
//
// 브라우저에서 하던 일을 그대로 옮긴 것. 이유는 메모리다 — 브라우저는
// file.arrayBuffer() 로 파일 전체를 램에 올린 뒤 decodeAudioData 로 PCM 전체를
// 다시 램에 올린다. 8GB 원본에서 NotReadableError 로 죽고, 버텨도 1시간짜리
// 영상이면 디코딩된 PCM 만 1.4GB 다.
//
// 여기서는 ffmpeg 가 오디오를 8kHz 모노 s16le 로 디코딩해 stdout 으로 흘려보내고,
// 우리는 그걸 받는 즉시 50ms 창의 RMS 로 접는다. 영상 길이와 무관하게 상주 메모리는
// 창 하나 + 결과 배열(30분 = 36000개 float, 약 144KB)뿐이다.

import { spawn } from "child_process";

const SAMPLE_RATE = 8000;      // 말/무음 구분에는 8kHz 면 충분하고, 데이터는 6배 적다
const WINDOW_SEC = 0.05;       // 브라우저 구현과 같은 50ms
const SAMPLES_PER_WINDOW = Math.round(SAMPLE_RATE * WINDOW_SEC);

// ffmpeg 로 PCM 을 흘려받아 창별 dBFS 배열로 접는다.
export function analyzeAudio(inputPath, { timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", inputPath,
      "-vn",                          // 비디오는 디코딩조차 하지 않는다 — 이게 속도의 핵심
      "-ac", "1",
      "-ar", String(SAMPLE_RATE),
      "-f", "s16le",
      "-",
    ], { stdio: ["ignore", "pipe", "pipe"] });

    const db = [];
    let sumSq = 0;
    let n = 0;
    let carry = null;              // 홀수 바이트로 끊긴 샘플의 앞 바이트
    let stderr = "";

    const timer = setTimeout(() => {
      ff.kill("SIGKILL");
      reject(new Error(`오디오 분석이 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않았습니다.`));
    }, timeoutMs);

    ff.stdout.on("data", (chunk) => {
      let buf = chunk;
      // s16le 은 2바이트가 한 샘플인데 청크 경계가 그 사이를 가를 수 있다.
      if (carry !== null) {
        buf = Buffer.concat([Buffer.from([carry]), chunk]);
        carry = null;
      }
      const usable = buf.length - (buf.length % 2);
      if (usable < buf.length) carry = buf[buf.length - 1];

      for (let i = 0; i < usable; i += 2) {
        const s = buf.readInt16LE(i) / 32768;
        sumSq += s * s;
        if (++n === SAMPLES_PER_WINDOW) {
          const rms = Math.sqrt(sumSq / n);
          db.push(rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100);
          sumSq = 0;
          n = 0;
        }
      }
    });

    ff.stderr.on("data", (d) => { stderr += d.toString(); });
    ff.on("error", (e) => { clearTimeout(timer); reject(e); });
    ff.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`오디오 분석 실패 (ffmpeg exit ${code}): ${stderr.slice(-300)}`));
      }
      if (db.length === 0) {
        return reject(new Error("오디오 트랙을 찾지 못했습니다. 소리가 없는 영상은 무음 기준으로 자를 수 없습니다."));
      }
      resolve({ db, winDuration: WINDOW_SEC });
    });
  });
}

// ── 아래 세 함수는 public/app.js 와 같은 알고리즘이다 ────────────────────────
// 브라우저에서 감지하든 서버에서 감지하든 같은 결과가 나와야, 파일 크기에 따라
// 경로가 갈려도 사용자가 보는 컷이 달라지지 않는다.

// 고정 임계값은 영상마다 틀린다. 조용한 방은 바닥이 -55dB, 에어컨이 돌면 -28dB —
// 후자에서 -32dB 를 쓰면 무음이 0개가 된다. 실제 측정한 바닥 기준으로 잡는다.
export function autoSilenceThresholdDb(db) {
  const sorted = Float64Array.from(db).sort();
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];
  const floorDb = at(0.05);
  const speechDb = at(0.85);
  const range = speechDb - floorDb;
  const margin = Math.min(10, Math.max(3, range * 0.3));
  // speechDb - 6 은 말소리를 먹지 않으려는 상한인데, 다이내믹 레인지가 6dB 보다
  // 좁으면 이 값이 노이즈 바닥보다 아래로 내려간다. 그러면 임계값 아래인 창이
  // 하나도 없어 무음이 0개가 되고, 결과는 원본과 같은 길이가 된다.
  // 바닥보다는 반드시 위에 있어야 한다.
  const threshold = Math.max(floorDb + 1.5, Math.min(floorDb + margin, speechDb - 6));
  // range 가 좁으면 말과 소음을 음량만으로 가르기 어렵다 — UI 가 경고할 수 있게 알린다.
  return { thresholdDb: Math.max(-50, Math.min(-18, threshold)), floorDb, speechDb, range, lowContrast: range < 8 };
}

export function silencesFromWindows(db, winDuration, thresholdDb, minSilence) {
  const silences = [];
  let run = 0;
  let runStart = 0;
  for (let w = 0; w < db.length; w++) {
    if (db[w] < thresholdDb) {
      if (run === 0) runStart = w * winDuration;
      run++;
    } else if (run > 0) {
      const dur = run * winDuration;
      if (dur >= minSilence) silences.push({ start: runStart, end: runStart + dur });
      run = 0;
    }
  }
  if (run > 0) {
    const dur = run * winDuration;
    if (dur >= minSilence) silences.push({ start: runStart, end: runStart + dur });
  }
  return silences;
}

export function invertSilences(duration, silences, padding) {
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

// 업로드된 파일에서 keeps 를 직접 산출한다. noiseDb 가 null 이면 자동 측정.
export async function detectKeeps(inputPath, duration, {
  noiseDb = null, minSilence = 0.6, padding = 0.1,
} = {}) {
  const { db, winDuration } = await analyzeAudio(inputPath);
  const auto = autoSilenceThresholdDb(db);
  const thresholdDb = noiseDb == null ? auto.thresholdDb : Number(noiseDb);
  const silences = silencesFromWindows(db, winDuration, thresholdDb, minSilence);
  // duration 을 못 받았으면 분석한 창 수로 되돌린다.
  const total = duration > 0 ? duration : db.length * winDuration;
  const keeps = invertSilences(total, silences, padding);
  return {
    keeps,
    duration: total,
    stats: {
      ...auto,
      thresholdDb,
      auto: noiseDb == null,
      silenceCount: silences.length,
      silenceSec: silences.reduce((s, x) => s + (x.end - x.start), 0),
    },
    // 프론트가 파형을 그리는 데 쓴다. 50ms 창이라 30분 영상이 36000개 —
    // 그대로 보내면 JSON 이 커지므로 최대 4000개로 줄여서 보낸다 (화면 폭보다 촘촘).
    waveform: { db: downsample(db, 4000), winDuration: winDuration * Math.max(1, Math.ceil(db.length / 4000)), thresholdDb },
  };
}

// 구간별 최대값으로 줄인다. 평균을 쓰면 짧은 말소리가 뭉개져 임계선과의 관계가
// 안 보인다 — 파형은 "왜 여기가 잘렸나" 를 설명하는 그림이라 peak 이 맞다.
function downsample(db, target) {
  if (db.length <= target) return db.map((v) => Math.round(v * 10) / 10);
  const step = db.length / target;
  const out = new Array(target);
  for (let i = 0; i < target; i++) {
    const a = Math.floor(i * step);
    const b = Math.max(a + 1, Math.floor((i + 1) * step));
    let peak = -100;
    for (let j = a; j < b && j < db.length; j++) if (db[j] > peak) peak = db[j];
    out[i] = Math.round(peak * 10) / 10;
  }
  return out;
}
