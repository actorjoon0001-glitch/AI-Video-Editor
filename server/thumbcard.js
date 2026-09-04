// 썸네일 사진 위에 텍스트 카드를 합성한다.
//
// 합성은 Pillow(파이썬)가 한다. 글자 폭을 재서 패널을 넘치는지 판단해야 하는데
// ffmpeg 의 drawtext 로는 그 측정을 할 수 없고, Node 에서 캔버스를 쓰려면 무거운
// 네이티브 모듈이 필요하다. 파이썬은 Whisper 때문에 이미 들어 있다.
//
// 여기서 절대 하지 않는 일: 실패를 이유로 업로드를 막는 것. 카드가 안 붙으면
// 원본 사진으로 올라가고 사유만 남는다.
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "thumbcard.py");

// 요청받은 서체가 우선. 없으면 이미지에 실제로 들어 있는 900 굵기 한글 서체로
// 내려간다. 파이썬 쪽에서 이름이 정확히 일치하는지 확인하므로, 목록에 있다는
// 이유만으로 엉뚱한 굵기가 선택되지는 않는다.
const FONT_PREFERENCE = [
  "Noto Sans KR Black",
  "Noto Sans CJK KR",
  "Pretendard Black",
  "NanumGothicExtraBold",
  "NanumSquare ExtraBold",
  "NanumGothic",
];

export function composeThumbnailCard({
  image,
  out,
  line1,
  line2 = null,
  line3 = null,
  pythonBin = "python3",
  timeoutMs = 30_000,
}) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(pythonBin, [SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, error: `파이썬 실행 실패: ${e?.message || e}` });
    }
    let stdout = "", stderr = "";
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      resolve({ ok: false, error: `합성이 ${timeoutMs / 1000}초를 넘겨 중단했습니다.` });
    }, timeoutMs);
    timer.unref?.();

    p.stdout.on("data", (d) => { stdout += d.toString(); });
    p.stderr.on("data", (d) => { stderr += d.toString(); });
    p.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `파이썬 실행 실패: ${e?.message || e}` });
    });
    p.on("exit", (code) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        resolve({
          ok: false,
          error: `합성 스크립트가 응답을 주지 않았습니다 (exit ${code}): ${(stderr || stdout).slice(-300)}`,
        });
      }
    });

    p.stdin.end(JSON.stringify({ image, out, line1, line2, line3, fonts: FONT_PREFERENCE }));
  });
}
