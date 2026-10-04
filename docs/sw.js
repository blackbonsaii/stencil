// Offline support: always try the network first so updates show up straight away;
// fall back to the cached copy when offline or the network is slow.
const VERSION = "stencil-v1.4";
const FILES = ["./", "index.html", "styles.css?v=1.4", "app.js?v=1.4", "protocol.js?v=1.4", "raster.js?v=1.4", "imaging.js?v=1.4",
               "printer.js?v=1.4", "sheet.js?v=1.4", "manifest.webmanifest", "icon.svg", "icon-180.png", "icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.open(VERSION).then(async cache => {
    try {
      const r = await Promise.race([
        fetch(e.request, { cache: "no-cache" }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("slow")), 4000)),
      ]);
      if (r.ok) cache.put(e.request, r.clone());
      return r;
    } catch {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      if (cached) return cached;
      throw new Error("offline and not cached");
    }
  }));
});
