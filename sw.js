const cacheName = "ghn-dashboard-v18";
const assets = [
  "./",
  "./index.html",
  "./styles.css?v=17",
  "./app.js?v=17",
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

      const windows = await self.clients.matchAll({ type: "window" });
      await Promise.all(windows.map((client) => client.navigate(client.url)));
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html"))),
  );
});
