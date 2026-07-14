// Service worker: caches the app so it works offline (e.g. patchy signal on a walk).
const CACHE = "epa-memoriser-v5";
const ASSETS = [
  ".",
  "index.html",
  "css/style.css",
  "data.enc.json",
  "js/crypto.js",
  "js/audio.js",
  "js/engine.js",
  "js/voice.js",
  "js/app.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Audio clips never change once generated: serve cache-first to save data.
// Everything else is network-first (updates when online, cache when offline).
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const isAudio = e.request.url.includes("/audio/");
  if (isAudio) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      }))
    );
    return;
  }
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
