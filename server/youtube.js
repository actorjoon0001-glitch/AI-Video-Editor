// YouTube Data API v3 업로드 (resumable, 8MB 청크).
//
// googleapis 패키지를 붙이지 않고 node:https 로 직접 호출한다. 이유:
//  - Render Free 이미지 크기/부팅 시간을 늘리지 않기 위해.
//  - resumable 업로드의 청크 응답은 308 인데, fetch()는 308 을 리다이렉트로
//    처리해 버려서 (redirect:"manual" 이면 opaqueredirect) 상태 코드를 못 읽는다.
//    node:https 는 리다이렉트를 자동으로 따라가지 않으므로 308 을 그대로 본다.
//
// 인증은 OAuth 2.0 refresh token 방식. 서버에 브라우저가 없으므로 최초 동의는
// 로컬에서 한 번 받고(refresh token 발급), 그 토큰만 환경 변수로 넣는다:
//   YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET / YOUTUBE_REFRESH_TOKEN
// 공개(public) 업로드는 실수 방지를 위해 YOUTUBE_ALLOW_PUBLIC=true 일 때만 허용.

import https from "https";
import { open, stat } from "fs/promises";
import path from "path";

const CHUNK_SIZE = 8 * 1024 * 1024;
const PRIVACY_VALUES = new Set(["private", "unlisted", "public"]);

export function youtubeConfigured() {
  return Boolean(
    process.env.YOUTUBE_CLIENT_ID &&
    process.env.YOUTUBE_CLIENT_SECRET &&
    process.env.YOUTUBE_REFRESH_TOKEN
  );
}

export function youtubeAllowsPublic() {
  return process.env.YOUTUBE_ALLOW_PUBLIC === "true";
}

export function sanitizePrivacy(v) {
  const s = String(v || "private").toLowerCase();
  if (!PRIVACY_VALUES.has(s)) return "private";
  // public 은 명시적으로 열어둔 배포에서만. 아니면 조용히 private 로 낮춘다.
  if (s === "public" && !youtubeAllowsPublic()) return "private";
  return s;
}

export async function uploadVideo({
  videoPath,
  title,
  description = "",
  tags = [],
  privacy = "private",
  categoryId = "22",          // People & Blogs — 가장 무난한 기본값
  madeForKids = false,
  publishAtIso = null,
  thumbnailPath = null,
  onProgress = null,
}) {
  if (!youtubeConfigured()) {
    throw new Error(
      "YouTube 자격 증명이 없습니다. YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET / YOUTUBE_REFRESH_TOKEN 을 설정하세요."
    );
  }
  const safePrivacy = sanitizePrivacy(privacy);
  const safeTitle = String(title || "").trim().slice(0, 100);
  if (!safeTitle) throw new Error("업로드하려면 제목이 필요합니다.");

  const accessToken = await getAccessToken();
  const size = (await stat(videoPath)).size;

  const body = {
    snippet: {
      title: safeTitle,
      description: String(description || "").slice(0, 5000),
      tags: (tags || []).map(String).slice(0, 30),
      categoryId: String(categoryId),
    },
    status: {
      // 예약 게시가 걸리면 그 시각까지는 반드시 private 이어야 한다.
      privacyStatus: publishAtIso ? "private" : safePrivacy,
      selfDeclaredMadeForKids: Boolean(madeForKids),
    },
  };
  if (publishAtIso) body.status.publishAt = publishAtIso;

  const uploadUrl = await startResumableSession(accessToken, body, size);
  const video = await uploadChunks(uploadUrl, videoPath, size, onProgress);

  const result = {
    videoId: video.id,
    url: `https://youtu.be/${video.id}`,
    privacyStatus: video.status?.privacyStatus || safePrivacy,
    publishAt: video.status?.publishAt || null,
    title: video.snippet?.title || safeTitle,
    thumbnailSet: false,
  };

  if (thumbnailPath) {
    try {
      await setThumbnail(accessToken, video.id, thumbnailPath);
      result.thumbnailSet = true;
    } catch (e) {
      // 썸네일 실패가 업로드 자체를 되돌릴 수는 없으니 경고만 남긴다.
      console.warn(`[youtube] 썸네일 적용 실패 (영상은 업로드됨): ${e?.message || e}`);
      result.thumbnailError = String(e?.message || e);
    }
  }
  return result;
}

async function getAccessToken() {
  const form = new URLSearchParams({
    client_id: process.env.YOUTUBE_CLIENT_ID,
    client_secret: process.env.YOUTUBE_CLIENT_SECRET,
    refresh_token: process.env.YOUTUBE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  }).toString();

  const res = await request("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: Buffer.from(form, "utf8"),
  });
  if (res.status !== 200) {
    throw new Error(
      `YouTube 토큰 갱신 실패 (HTTP ${res.status}). refresh token 이 만료됐거나 취소됐을 수 있습니다: ${res.text.slice(0, 300)}`
    );
  }
  const token = JSON.parse(res.text).access_token;
  if (!token) throw new Error("YouTube 토큰 응답에 access_token 이 없습니다.");
  return token;
}

async function startResumableSession(accessToken, body, size) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  const res = await request(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-type": "video/mp4",
        "x-upload-content-length": String(size),
      },
      body: payload,
    }
  );
  if (res.status !== 200) {
    throw new Error(`업로드 세션 생성 실패 (HTTP ${res.status}): ${res.text.slice(0, 300)}`);
  }
  const location = res.headers.location;
  if (!location) throw new Error("업로드 세션 응답에 Location 헤더가 없습니다.");
  return location;
}

async function uploadChunks(uploadUrl, videoPath, size, onProgress) {
  const fh = await open(videoPath, "r");
  try {
    let offset = 0;
    while (offset < size) {
      const length = Math.min(CHUNK_SIZE, size - offset);
      const buf = Buffer.allocUnsafe(length);
      await fh.read(buf, 0, length, offset);

      const res = await request(uploadUrl, {
        method: "PUT",
        headers: {
          "content-type": "video/mp4",
          "content-range": `bytes ${offset}-${offset + length - 1}/${size}`,
        },
        body: buf,
      });

      if (res.status === 200 || res.status === 201) {
        return JSON.parse(res.text);
      }
      if (res.status === 308) {
        // 서버가 실제로 받은 마지막 바이트 기준으로 offset 을 맞춘다.
        const range = res.headers.range; // "bytes=0-8388607"
        const end = range ? parseInt(range.split("-")[1], 10) : NaN;
        offset = Number.isFinite(end) ? end + 1 : offset + length;
        onProgress?.({ uploaded: offset, total: size });
        continue;
      }
      throw new Error(`청크 업로드 실패 (HTTP ${res.status}): ${res.text.slice(0, 300)}`);
    }
    throw new Error("업로드가 끝났지만 YouTube 가 완료 응답을 주지 않았습니다.");
  } finally {
    await fh.close();
  }
}

async function setThumbnail(accessToken, videoId, thumbnailPath) {
  const { readFile } = await import("fs/promises");
  const data = await readFile(thumbnailPath);
  const ext = path.extname(thumbnailPath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : "image/jpeg";
  const res = await request(
    `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": mime },
      body: data,
    }
  );
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  }
}

// node:https 얇은 래퍼. 리다이렉트를 따라가지 않으므로 resumable 의 308 을
// 상태 코드 그대로 볼 수 있다.
function request(url, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: {
          ...headers,
          ...(body ? { "content-length": String(body.length) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
