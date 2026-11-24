// Offline cache for MyEverythingApp. Bump VERSION when you deploy changes.
// Only handles this site's own files; API calls to other sites (prices) go straight to the network.
const VERSION = "mea-v17";
const ASSETS = ["./", "./index.html", "./manifest.json", "./icon.svg", "./icons/icon-192.png", "./icons/apple-touch-icon.png", "./vendor/supabase-js-2.119.0.js"];
self.addEventListener("install", e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS))); self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  // Network first, fall back to cache when offline. Only page loads fall back to the app shell.
  e.respondWith(fetch(req).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {}); }
    return r;
  }).catch(() => caches.match(req).then(m => m || (req.mode === "navigate" ? caches.match("./index.html") : Response.error()))));
});
