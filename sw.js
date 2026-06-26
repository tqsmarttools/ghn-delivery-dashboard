const cacheName = "ghn-dashboard-v35";
const assets = [
  "./",
  "./index.html",
  "./styles.css?v=21",
  "./app.js?v=35",
  "./manifest.webmanifest?v=18",
  "./icons/icon-192.png?v=18",
  "./icons/icon-512.png?v=18",
  "./icons/apple-touch-icon.png?v=18",
  "./data/sample-orders.json",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(assets)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== cacheName).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isLiveDataRequest =
    url.pathname.endsWith("/data/latest.enc.json") || url.pathname.endsWith("/data/latest.json");
  if (isLiveDataRequest) {
    event.respondWith(fetch(event.request, { cache: "no-store" }));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) =>
      cached || fetch(event.request).catch(() => caches.match("./index.html")),
    ),
  );
});
