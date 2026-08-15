/* 서비스 워커 — 오프라인 지원 + 갱신 전략
 *
 * 정책 데이터가 index.html 안에 들어 있어서 캐시 전략이 갈린다:
 *   index.html  → 네트워크 우선. 온라인이면 항상 최신 마감·최신 정책을 본다.
 *                 (캐시 우선으로 하면 지난주 마감일을 보게 되는데, 이 앱에선 그게 치명적)
 *   그 외 정적  → 캐시 우선. 아이콘·매니페스트는 바뀔 일이 없다.
 * 오프라인이면 양쪽 다 캐시로 떨어진다.
 */
const VERSION = "v1";
const CACHE = "policy-board-" + VERSION;
const SHELL = [
  "/",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())   // 일부 자산 실패해도 설치는 진행
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 외부 요청은 건드리지 않는다

  const isDoc = req.mode === "navigate" || url.pathname === "/" || url.pathname.endsWith(".html");

  if (isDoc) {
    // 네트워크 우선 — 최신 정책 데이터를 놓치지 않기 위해
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/").then(r => r || caches.match(req)))
    );
    return;
  }

  // 캐시 우선 — 아이콘·매니페스트
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    }))
  );
});
