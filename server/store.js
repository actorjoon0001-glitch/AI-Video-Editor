// 작업 기록을 Supabase 에 남긴다.
//
// 지금까지 작업 목록은 서버 메모리에만 있었다. 그래서 배포하거나 컨테이너가
// 재시작되면 진행 중이던 작업도, 끝난 결과도 통째로 사라졌다 — 47분 인코딩을
// 끝내고 유튜브에 올라간 영상의 링크조차 못 찾는 일이 실제로 있었다.
//
// 영상 파일은 여기 넣지 않는다. 8GB 를 넣을 자리도 없고, 완성본은 이미 유튜브에
// 있다. 여기 남는 건 몇 KB 짜리 기록 — 링크, 제목, 설명, 태그, 단계별 결과다.
//
// SDK 를 쓰지 않고 PostgREST 에 직접 요청한다. 의존성 하나 없이 필요한 건
// upsert / select / delete 세 가지뿐이다.

const URL_BASE = () => String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = () => process.env.SUPABASE_SERVICE_KEY || "";

export function storeConfigured() {
  return Boolean(URL_BASE() && KEY());
}

// 보관 기간. 테이블 기본값(3일)과 맞춰 둔다 — 화면에 남은 날짜를 계산할 때 쓴다.
export const STORE_RETENTION_DAYS = 3;

async function call(pathAndQuery, { method = "GET", body = null, prefer = null } = {}) {
  if (!storeConfigured()) throw new Error("Supabase 설정(SUPABASE_URL / SUPABASE_SERVICE_KEY)이 없습니다.");
  const headers = {
    apikey: KEY(),
    authorization: `Bearer ${KEY()}`,
    "content-type": "application/json",
  };
  if (prefer) headers.prefer = prefer;

  const res = await fetch(`${URL_BASE()}/rest/v1/${pathAndQuery}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase ${method} ${pathAndQuery} 실패 (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

// 저장할 만큼만 골라 담는다. 자막 세그먼트 원본처럼 길고 다시 안 볼 것은 뺀다.
function snapshot(job) {
  const stages = {};
  for (const [name, s] of Object.entries(job.stages || {})) {
    stages[name] = { status: s.status };
    if (s.error) stages[name].error = String(s.error).slice(0, 500);
    if (s.note) stages[name].note = s.note;
  }
  const meta = job.stages?.metadata?.result || null;
  const up = job.stages?.upload?.result || null;
  const tr = job.stages?.transcribe?.result || null;

  return {
    id: job.id,
    status: job.status,
    title: up?.title || meta?.titles?.[0] || null,
    video_id: up?.videoId || null,
    video_url: up?.url || null,
    privacy: up?.privacyStatus || null,
    source_name: job.sourceName || null,
    payload: {
      stages,
      options: job.options || null,
      createdAt: job.createdAt,
      startedAt: job.startedAt || null,
      completedAt: job.completedAt || null,
      metadata: meta && {
        titles: meta.titles, description: meta.description, tags: meta.tags,
        thumbnailCopy: meta.thumbnailCopy, thumbnailSubcopy: meta.thumbnailSubcopy,
        source: meta.source, model: meta.model,
      },
      upload: up,
      // 자막은 파일이 지워진 뒤에도 다시 쓸 수 있게 본문만 남긴다. 아주 긴
      // 영상이면 잘라 둔다 — 기록용이지 원본 보관이 아니다.
      srt: tr?.srt ? String(tr.srt).slice(0, 200_000) : null,
      subtitleLines: tr?.segments?.length || 0,
    },
  };
}

// 저장 실패가 작업을 망치면 안 된다. 기록은 부수적인 것이고, 인코딩된 영상이
// 본체다. 그래서 이 함수는 던지지 않고 false 를 돌려준다.
export async function saveJob(job) {
  if (!storeConfigured()) return false;
  try {
    await call("jobs?on_conflict=id", {
      method: "POST",
      body: [snapshot(job)],
      // expires_at 은 보내지 않는다 — 처음 만들 때의 기본값(3일)이 유지돼야
      // 갱신할 때마다 보관 기간이 늘어나지 않는다.
      prefer: "resolution=merge-duplicates,return=minimal",
    });
    return true;
  } catch (e) {
    console.warn(`[store] 작업 기록 실패 (${job.id}): ${e?.message || e}`);
    return false;
  }
}

export async function listJobs(limit = 50) {
  const cols = "id,created_at,expires_at,status,title,video_id,video_url,privacy,source_name";
  return call(`jobs?select=${cols}&order=created_at.desc&limit=${Math.min(200, limit)}`);
}

export async function loadJob(id) {
  const rows = await call(`jobs?id=eq.${encodeURIComponent(id)}&limit=1`);
  return rows?.[0] || null;
}

// ── 작은 키-값 보관함 ───────────────────────────────────────────────────────
//
// 틱톡은 토큰을 갱신할 때마다 refresh token 자체를 새것으로 바꿔 준다. 그래서
// 유튜브처럼 환경변수에 한 번 넣어두는 방식이 통하지 않는다 — 서버가 자기
// 환경변수를 고쳐 쓸 수는 없으니, 새로 받은 토큰을 어딘가 적어 둬야 다음
// 재시작 때도 이어서 쓸 수 있다.
// 값이 빈 문자열인 것과 아예 없는 것은 다르다. "연결을 끊었다"를 빈 문자열로
// 적어 두는데, 둘을 같게 다루면 환경변수에 남아 있는 씨앗 토큰이 되살아나서
// 끊기 버튼이 아무 일도 안 한 것처럼 된다. 없으면 undefined, 있으면 그 값.
export async function getSecret(key) {
  if (!storeConfigured()) return undefined;
  try {
    const rows = await call(`app_secrets?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
    return rows?.length ? String(rows[0].value ?? "") : undefined;
  } catch (e) {
    console.warn(`[store] ${key} 읽기 실패: ${e?.message || e}`);
    return undefined;
  }
}

export async function setSecret(key, value) {
  if (!storeConfigured()) return false;
  try {
    await call("app_secrets?on_conflict=key", {
      method: "POST",
      body: [{ key, value, updated_at: new Date().toISOString() }],
      prefer: "resolution=merge-duplicates,return=minimal",
    });
    return true;
  } catch (e) {
    // 여기서 실패하면 다음 재시작 때 연결이 끊긴다. 조용히 넘기면 안 되는
    // 실패라 로그를 남기고, 호출한 쪽이 사용자에게 알릴 수 있게 false 를 준다.
    console.error(`[store] ${key} 저장 실패 — 재시작하면 연결이 끊깁니다: ${e?.message || e}`);
    return false;
  }
}

export async function deleteExpired() {
  if (!storeConfigured()) return 0;
  try {
    const gone = await call("jobs?expires_at=lt.now()", {
      method: "DELETE",
      prefer: "return=representation",
    });
    if (gone?.length) console.log(`[store] 보관 기간이 지난 기록 ${gone.length}건 삭제`);
    return gone?.length || 0;
  } catch (e) {
    console.warn(`[store] 만료 기록 정리 실패: ${e?.message || e}`);
    return 0;
  }
}
