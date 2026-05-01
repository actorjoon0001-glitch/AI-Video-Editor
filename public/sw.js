// Service worker that proxies @ffmpeg/* CDN requests through same-origin URLs.
//
// Cross-origin isolated 페이지에서는 `new Worker(crossOriginURL)` 생성이 차단된다.
// 따라서 ffmpeg.wasm SDK 가 spawn 하는 내부 worker 청크를 같은 출처로 가져와야 한다.
// 이 SW 가 /vendor/ffmpeg/* 요청을 jsDelivr 로 포워딩하고, 응답을 같은 출처로 반환한다.

const VERSION = "v1";

const CDN_PROXIES = {
  "/vendor/ffmpeg/": "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/",
  "/vendor/util/":   "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/umd/",
  "/vendor/core-mt/":"https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.6/dist/umd/",
};

self.addEventListener("install", (event) => {
  // 새 SW 가 즉시 활성화되도록
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // 기존 클라이언트도 즉시 컨트롤
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  for (const prefix in CDN_PROXIES) {
    if (url.pathname.startsWith(prefix)) {
      const remainder = url.pathname.slice(prefix.length);
      event.respondWith(proxyFetch(CDN_PROXIES[prefix] + remainder, event.request));
      return;
    }
  }
});

async function proxyFetch(targetUrl, originalRequest) {
  try {
    const upstream = await fetch(targetUrl, {
      // 신원/쿠키 안 보냄 — credentialless COEP 와 호환
      credentials: "omit",
      mode: "cors",
    });
    if (!upstream.ok) {
      return new Response(`Upstream ${upstream.status}: ${targetUrl}`, { status: upstream.status });
    }

    // 응답을 같은 출처로 다시 포장. wasm·js 모두 동일하게 처리.
    const headers = new Headers(upstream.headers);
    headers.set("Cross-Origin-Resource-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", "credentialless");
    if (!headers.has("Cache-Control")) {
      headers.set("Cache-Control", "public, max-age=86400");
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (e) {
    return new Response("SW proxy error: " + (e?.message || e), { status: 502 });
  }
}
