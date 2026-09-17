// 유튜브 채널 여러 개를 등록해 두고 영상마다 골라 올린다.
//
// 지금까지는 refresh token 을 환경 변수 하나에 넣어 뒀다. 그러면 채널을 바꿀
// 때마다 OAuth Playground 를 다시 돌려서 렌더 환경 변수를 갈아끼워야 했고,
// 무엇보다 채널을 두 개 쓸 수가 없었다 — 갈아끼우면 앞의 채널은 못 쓴다.
//
// 연결을 우리 서버에서 받으면 그럴 일이 없다. 채널마다 토큰을 따로 보관하고,
// 업로드할 때 어느 채널인지만 고르면 된다.
//
// 구글의 refresh token 은 틱톡과 달리 갱신해도 값이 안 바뀐다. 대신 앱이
// "테스트" 상태면 7일 만에 만료된다 — 그건 코드로 못 고치고 Google Cloud
// Console 에서 앱을 "프로덕션"으로 게시해야 한다.

import { getSecret, setSecret, storeConfigured } from "./store.js";

// 주소를 바꿔 끼울 수 있게 해 둔다 — 진짜 계정 없이 등록/선택 흐름을 확인하려면
// 가짜 구글을 향하게 할 방법이 있어야 한다.
const GOOGLE_OAUTH_BASE = process.env.GOOGLE_OAUTH_BASE || "https://oauth2.googleapis.com";
const GOOGLE_API_BASE = process.env.GOOGLE_API_BASE || "https://www.googleapis.com";
const AUTH_URL = process.env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = `${GOOGLE_OAUTH_BASE}/token`;
const CHANNELS_URL = `${GOOGLE_API_BASE}/youtube/v3/channels?part=snippet&mine=true`;

const CHANNELS_KEY = "youtube_channels";

// 업로드와 수정(제목·설명·썸네일) 둘 다 필요하다.
const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube",
].join(" ");

export function youtubeOAuthConfigured() {
  return Boolean(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET);
}

export function youtubeRedirectUri(req) {
  if (process.env.YOUTUBE_REDIRECT_URI) return process.env.YOUTUBE_REDIRECT_URI;
  return `https://${req.get("host")}/api/youtube/callback`;
}

export function youtubeAuthorizeUrl(req, state) {
  const p = new URLSearchParams({
    client_id: process.env.YOUTUBE_CLIENT_ID || "",
    redirect_uri: youtubeRedirectUri(req),
    response_type: "code",
    scope: SCOPES,
    // refresh token 은 offline 일 때만 나온다. 그리고 한 번 동의한 계정은
    // 두 번째부터 refresh token 을 안 주므로 매번 동의를 다시 받는다 —
    // 채널을 추가하려는 것이므로 계정 선택 화면도 항상 띄워야 한다.
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "true",
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
  try { body = JSON.parse(text); } catch { body = {}; }
  if (!res.ok || body.error) {
    throw new Error(
      `구글 토큰 요청 실패 (HTTP ${res.status}): ${body.error_description || body.error || text.slice(0, 200)}`
    );
  }
  return body;
}

// ── 보관 ────────────────────────────────────────────────────────────────────
// [{ id, title, refreshToken, addedAt }] 목록 + 기본 채널.

export async function listChannels() {
  if (!storeConfigured()) return [];
  try {
    const raw = await getSecret(CHANNELS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveChannels(list) {
  return setSecret(CHANNELS_KEY, JSON.stringify(list));
}

// 화면에 줄 수 있는 것만. refresh token 은 절대 밖으로 내보내지 않는다.
export function publicChannels(list) {
  return list.map(({ id, title, addedAt }) => ({ id, title, addedAt }));
}

export async function addChannelFromCode(code, redirectUri) {
  const tok = await postForm(TOKEN_URL, {
    client_id: process.env.YOUTUBE_CLIENT_ID,
    client_secret: process.env.YOUTUBE_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  if (!tok.refresh_token) {
    throw new Error(
      "구글이 refresh token 을 주지 않았습니다. 동의 화면을 건너뛴 경우입니다 — 다시 시도해 주세요."
    );
  }

  // 어느 채널에 연결됐는지 확인해서 이름을 붙여 둔다. 이게 없으면 목록이
  // 토큰 문자열만 늘어선 화면이 된다.
  const res = await fetch(CHANNELS_URL, {
    headers: { authorization: `Bearer ${tok.access_token}` },
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));
  const item = body?.items?.[0];
  if (!item) {
    throw new Error(
      "이 계정에서 유튜브 채널을 찾지 못했습니다. 채널이 있는 계정(또는 브랜드 채널)으로 다시 선택해 주세요."
    );
  }

  const entry = {
    id: item.id,
    title: item.snippet?.title || item.id,
    refreshToken: tok.refresh_token,
    addedAt: Date.now(),
  };
  const list = await listChannels();
  // 같은 채널을 다시 연결하면 토큰만 새것으로 바꾼다 (재연결이 곧 갱신이다).
  const i = list.findIndex((c) => c.id === entry.id);
  if (i >= 0) list[i] = { ...list[i], ...entry };
  else list.push(entry);
  const ok = await saveChannels(list);
  return { channel: publicChannels([entry])[0], stored: ok, replaced: i >= 0 };
}

export async function removeChannel(id) {
  const list = await listChannels();
  const next = list.filter((c) => c.id !== id);
  if (next.length === list.length) return false;
  await saveChannels(next);
  return true;
}

// 업로드에 쓸 refresh token 을 고른다.
//
// 등록된 채널이 하나도 없으면 예전처럼 환경 변수를 쓴다 — 이미 돌고 있는
// 작업이 이 변경 때문에 멈추면 안 된다.
export async function refreshTokenFor(channelId) {
  const list = await listChannels();
  if (list.length) {
    const picked = (channelId && list.find((c) => c.id === channelId)) || list[0];
    return { token: picked.refreshToken, channelId: picked.id, channelTitle: picked.title };
  }
  const env = process.env.YOUTUBE_REFRESH_TOKEN;
  if (!env) return null;
  return { token: env, channelId: null, channelTitle: null };
}
