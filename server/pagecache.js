// 다 쓴 파일 캐시를 커널에게 돌려준다.
//
// 왜 필요한가. 컨테이너 한도는 2GB 인데, 우리가 업로드 파일에 쓴 바이트는 전부
// 페이지 캐시로 남아 그 한도에 잡힌다. 3GB 를 올리면 캐시만 1959MB — 사용량이
// 100% 에 붙는다. 커널은 이걸 문제 삼지 않는다. 실측한 결과 한도에 3972번
// 부딪히고도 매번 깨끗한 페이지를 버려서 넘겼고, oom_kill 은 끝까지 0 이었다.
// 문제 삼는 쪽은 그 위다 — 사용량이 100% 로 보이는 서비스를 플랫폼이 재시작한다.
// 실제로 100% 에 붙은 지 70초쯤 뒤에 502 와 함께 컨테이너가 갈렸다.
//
// 그래서 fsync 로 디스크에 내려보낸 뒤, 그 페이지를 캐시에서도 빼 달라고
// posix_fadvise(DONTNEED) 를 건다. Node 에는 이 함수가 없고 파이썬에는 있다 —
// Whisper 때문에 어차피 깔려 있으니 작은 도우미 프로세스로 돌린다. 매번 새로
// 띄우면 파이썬 기동 비용이 조각마다 붙으므로 한 번 띄워 두고 재사용한다.
//
// DONTNEED 는 더티 페이지를 건드리지 않는다. 아직 디스크에 안 내려간 내용은
// 그대로 남으므로, ffmpeg 가 쓰는 중인 파일에 걸어도 데이터가 상하지 않는다.
import { spawn } from "child_process";
import { readdir } from "fs/promises";
import { readFileSync } from "fs";
import path from "path";

const HELPER = `
import os, sys
for line in sys.stdin:
    p = line.rstrip("\\n")
    if not p:
        continue
    try:
        fd = os.open(p, os.O_RDONLY)
        try:
            # len 0 = 파일 끝까지
            os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
        finally:
            os.close(fd)
        sys.stdout.write("ok\\n")
    except Exception as e:
        sys.stdout.write("err %s\\n" % e)
    sys.stdout.flush()
`;

let child = null;
let disabled = false;
let buf = "";
const pending = [];   // 보낸 순서대로 resolve 를 쌓아 둔다

function ensureHelper(pythonBin) {
  if (disabled) return null;
  if (child && !child.killed && child.exitCode === null) return child;
  try {
    child = spawn(pythonBin, ["-c", HELPER], { stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    disabled = true;
    console.warn(`[pagecache] 도우미 기동 실패, 캐시 정리를 끈다: ${e?.message || e}`);
    return null;
  }
  buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      pending.shift()?.(line);
    }
  });
  child.stderr.on("data", (d) => console.warn(`[pagecache] ${d.toString().trim().slice(0, 200)}`));
  const bail = (why) => {
    // 남은 대기자를 모두 풀어 준다 — 안 그러면 호출자가 영원히 멈춘다.
    while (pending.length) pending.shift()?.("dead");
    child = null;
    if (why) console.warn(`[pagecache] 도우미 종료: ${why}`);
  };
  child.on("error", (e) => bail(e?.message || String(e)));
  child.on("exit", (code) => bail(`code ${code}`));
  child.unref?.();
  return child;
}

// 파일 하나의 깨끗한 캐시를 버린다. 실패해도 그냥 넘어간다 — 최적화지 필수가 아니다.
export function dropCache(file, { pythonBin = "python3", timeoutMs = 5000 } = {}) {
  const c = ensureHelper(pythonBin);
  if (!c) return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    const finish = (line) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(typeof line === "string" && line.startsWith("ok"));
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    pending.push(finish);
    try {
      c.stdin.write(`${file}\n`);
    } catch (e) {
      // write 가 실패하면 이 요청은 응답을 못 받는다. 큐에서 직접 빼낸다.
      const i = pending.indexOf(finish);
      if (i >= 0) pending.splice(i, 1);
      finish(null);
    }
  });
}

const CG = "/sys/fs/cgroup";
// 컨테이너 메모리 사용률(0~1). 못 읽으면 null — 그때는 정리를 건너뛴다.
export function memoryRatio() {
  try {
    const max = readFileSync(`${CG}/memory.max`, "utf8").trim();
    if (max === "max") return null;
    const cur = Number(readFileSync(`${CG}/memory.current`, "utf8").trim());
    return cur / Number(max);
  } catch {
    return null;
  }
}

// 사용률이 높을 때만 작업 디렉터리 전체를 훑어 캐시를 돌려준다.
//
// 업로드 조각마다 거는 것으로는 부족하다. ffmpeg 가 원본을 읽고 결과를 쓰는
// 동안에도 같은 속도로 캐시가 쌓이기 때문이다. 디렉터리째 주기적으로 도는 쪽이
// 경로를 하나하나 챙기는 것보다 빠뜨릴 데가 없다.
export function startPageCacheJanitor({
  dir,
  pythonBin = "python3",
  intervalMs = 5000,
  highWater = 0.5,
} = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    const ratio = memoryRatio();
    // 여유가 있으면 그냥 둔다 — 캐시는 원래 쓰라고 있는 것이고, ffmpeg 의
    // 미리읽기까지 매번 날리면 처리 속도만 깎인다.
    if (ratio === null || ratio < highWater) return;
    running = true;
    try {
      const names = await readdir(dir);
      for (const n of names) {
        await dropCache(path.join(dir, n), { pythonBin });
      }
    } catch (e) {
      console.warn(`[pagecache] 정리 실패: ${e?.message || e}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
