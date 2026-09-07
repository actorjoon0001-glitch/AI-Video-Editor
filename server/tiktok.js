// 틱톡 — 편집된 세로본을 크리에이터의 "받은함"(드래프트)으로 보낸다.
//
// 프로필에 바로 올리는 길(video.publish)도 있지만 그건 틱톡 심사를 통과해야
// 하고, 통과 전에는 무엇을 올리든 비공개로 잠긴다. 받은함으로 보내는 길
// (video.upload)은 심사가 필요 없고 공개 제한도 없다 — 실제로 게시하는 건
// 사람이 앱에서 하기 때문이다. 어차피 유튜브도 비공개로 올려놓고 확인하는
// 흐름이라 여기도 같은 모양이 된다.
//
// 유튜브와 다른 점이 하나 있고, 그게 이 파일 구조의 이유다: 틱톡은 토큰을
// 갱신할 때마다 refresh token 을 새것으로 돌려준다. 환경변수에 넣어 둔 값은
// 언젠가 쓸모없어지므로, 새로 받은 값을 Supabase 에 적어 두고 그쪽을 먼저 본다.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { getSecret, setSecret, storeConfigured } from "./store.js";

// 주소를 바꿔 끼울 수 있게 해 둔다. 진짜 계정 없이 규칙(조각 크기, Content-Range,
// 토큰 회전)을 확인하려면 가짜 서버를 향하게 할 방법이 있어야 한다.
const API_BASE = process.env.TIKTOK_API_BASE || "https://open.tiktokapis.com";
const AUTH_URL = process.env.TIKTOK_AUTH_URL || "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_URL = `${API_BASE}/v2/oauth/token/`;
const INBOX_INIT_URL = `${API_BASE}/v2/post/publish/inbox/video/init/`;
const STATUS_URL = `${API_BASE}/v2/post/publish/status/fetch/`;

const REFRESH_KEY = "tiktok_refresh_token";
const SCOPE = process.env.TIKTOK_SCOPE || "video.upload";

// 조각 규칙 (틱톡 문서):
//  - 5MB 미만이면 통째로 한 조각.
//  - 보통 조각은 5MB 이상 64MB 이하.
//  - 마지막 조각만 chunk_size 를 넘어도 된다 (128MB 까지). 그래서
//    total_chunk_count 는 올림이 아니라 "내림"이다 — 남는 꼬리는 마지막
//    조각이 흡수한다. 올림으로 계산하면 초기화 단계에서 거절당한다.
const MB = 1024 * 1024;
const MAX_CHUNK = 64 * MB;

export function tiktokConfigured() {
  return Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET);
}

export function redirectUri(req) {
  if (process.env.TIKTOK_REDIRECT_URI) return process.env.TIKTOK_REDIRECT_URI;
  // 등록해 둔 주소와 글자 하나까지 같아야 한다. 요청이 실제로 도착한 호스트에서
  // 만들면 스테이징/운영을 따로 적어 둘 필요가 없다.
  return `https://${req.get("host")}/api/tiktok/callback`;
}

export function authorizeUrl(req, state) {
  const p = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY || "",
    scope: SCOPE,
    response_type: "code",
    redirect_uri: redirectUri(req),
    state,
  });
  return `${AUTH_URL}?${p}`;
}

async function postForm(url, fields) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok || body.error) {
    const msg = body.error_description || body.error || text.slice(0, 300);
    throw new Error(`틱톡 ${url.split("/").slice(-2)[0]} 실패 (HTTP ${res.status}): ${msg}`);
  }
  return body;
}

// 새 refresh token 은 반드시 적어 둔다. 이걸 놓치면 다음 갱신 때 이미 버려진
// 토큰을 들이밀게 되고, 연결이 조용히 끊긴다.
async function rememberRefresh(token) {
  if (!token) return;
  const ok = await setSecret(REFRESH_KEY, token);
  if (!ok) {
    console.warn("[tiktok] 새 refresh token 을 저장하지 못했습니다 — 재시작하면 다시 연결해야 합니다.");
  }
}

export async function exchangeCode(code, uri) {
  const body = await postForm(TOKEN_URL, {
    client_key: process.env.TIKTOK_CLIENT_KEY,
    client_secret: process.env.TIKTOK_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: uri,
  });
  await rememberRefresh(body.refresh_token);
  return body;
}

async function storedRefreshToken() {
  // 보관함이 먼저다. 환경변수는 처음 한 번 심어 두는 씨앗일 뿐이고, 한 번
  // 갱신되고 나면 낡은 값이다.
  //
  // 보관함에 빈 값이 적혀 있으면 그건 "연결을 끊었다"는 뜻이지 "값이 없다"가
  // 아니다. 이 둘을 구분하지 않으면 끊기 버튼을 눌러도 환경변수에 남아 있는
  // 씨앗 토큰으로 다시 연결된 것처럼 보인다 — 실제로 그렇게 나왔다.
  const stored = await getSecret(REFRESH_KEY);
  if (stored !== undefined) return stored || null;
  return process.env.TIKTOK_REFRESH_TOKEN || null;
}

export async function tiktokConnected() {
  if (!tiktokConfigured()) return false;
  return Boolean(await storedRefreshToken());
}

// 액세스 토큰은 24시간이라 매번 받아 올 필요가 없다. 만료 1분 전까지 재사용.
let cached = { token: null, expiresAt: 0 };

export async function accessToken() {
  if (!tiktokConfigured()) throw new Error("서버에 틱톡 자격 증명(TIKTOK_CLIENT_KEY/SECRET)이 없습니다.");
  if (cached.token && Date.now() < cached.expiresAt - 60_000) return cached.token;

  const refresh = await storedRefreshToken();
  if (!refresh) throw new Error("틱톡 계정이 연결되지 않았습니다. 화면에서 '틱톡 연결'을 눌러 주세요.");

  const body = await postForm(TOKEN_URL, {
    client_key: process.env.TIKTOK_CLIENT_KEY,
    client_secret: process.env.TIKTOK_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refresh,
  });
  if (body.refresh_token && body.refresh_token !== refresh) {
    await rememberRefresh(body.refresh_token);
  }
  cached = {
    token: body.access_token,
    expiresAt: Date.now() + (Number(body.expires_in) || 86400) * 1000,
  };
  return cached.token;
}

// 연결을 끊는다. 토큰을 지워야 "연결됨" 표시가 사실과 맞는다.
export async function disconnect() {
  cached = { token: null, expiresAt: 0 };
  return setSecret(REFRESH_KEY, "");
}

function planChunks(size) {
  if (size <= MAX_CHUNK) return { chunkSize: size, count: 1 };
  const chunkSize = MAX_CHUNK;
  // 내림. 나머지는 마지막 조각이 함께 가져간다.
  const count = Math.max(1, Math.floor(size / chunkSize));
  return { chunkSize, count };
}

async function apiPost(url, token, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  const err = body?.error;
  if (!res.ok || (err && err.code && err.code !== "ok")) {
    throw new Error(`틱톡 API 실패 (HTTP ${res.status}): ${err?.message || err?.code || text.slice(0, 300)}`);
  }
  return body;
}

// 파일을 받은함으로 보낸다. 성공하면 publish_id 를 돌려주고, 그걸로 나중에
// 처리 상태를 물어볼 수 있다.
export async function uploadToInbox(filePath, { onProgress } = {}) {
  const token = await accessToken();
  const { size } = await stat(filePath);
  if (!size) throw new Error("보낼 영상 파일이 비어 있습니다.");
  const { chunkSize, count } = planChunks(size);

  const init = await apiPost(INBOX_INIT_URL, token, {
    source_info: {
      source: "FILE_UPLOAD",
      video_size: size,
      chunk_size: chunkSize,
      total_chunk_count: count,
    },
  });
  const uploadUrl = init?.data?.upload_url;
  const publishId = init?.data?.publish_id;
  if (!uploadUrl || !publishId) {
    throw new Error(`틱톡이 업로드 주소를 주지 않았습니다: ${JSON.stringify(init).slice(0, 300)}`);
  }

  for (let i = 0; i < count; i++) {
    const start = i * chunkSize;
    // 마지막 조각은 남은 바이트를 전부 가져간다 (chunk_size 보다 클 수 있다).
    const end = i === count - 1 ? size - 1 : start + chunkSize - 1;
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": "video/mp4",
        "content-length": String(end - start + 1),
        "content-range": `bytes ${start}-${end}/${size}`,
      },
      body: createReadStream(filePath, { start, end }),
      duplex: "half",
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`조각 ${i + 1}/${count} 전송 실패 (HTTP ${res.status}): ${t.slice(0, 200)}`);
    }
    onProgress?.({ sent: end + 1, total: size, chunk: i + 1, chunks: count });
  }

  return { publishId, sizeBytes: size, chunks: count };
}

// 틱톡이 영상을 다 받아 처리했는지. 받은함에 뜨기까지 몇 초 걸린다.
export async function publishStatus(publishId) {
  const token = await accessToken();
  const body = await apiPost(STATUS_URL, token, { publish_id: publishId });
  return {
    status: body?.data?.status || "UNKNOWN",
    failReason: body?.data?.fail_reason || null,
  };
}

export function tiktokStoreReady() {
  // 보관함이 없으면 갱신된 토큰을 적어 둘 데가 없다 — 연결은 되지만 재시작
  // 한 번으로 끊긴다. 그 사실을 화면에서 미리 알려야 한다.
  return storeConfigured();
}
