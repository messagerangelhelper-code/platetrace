// Keeps the camera's own files on the phone so it opens instantly, even on a weak signal.
// Cache first, then quietly refresh in the background for next time. Photos and videos are never cached here.
const CACHE = "pt-camera-v6";
const LIB = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js";
const FILES = ["./", "index.html", "camera.css", "camera.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE)
  .then((c) => c.addAll(FILES).then(() => c.add(LIB).catch(() => {})))
  .then(() => self.skipWaiting())));

self.addEventListener("activate", (e) => e.waitUntil(caches.keys()
  .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  .then(() => self.clients.claim())));

self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (u.origin !== location.origin && e.request.url !== LIB) return;   // uploads and other sites go straight to the network
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit || Response.error());
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }       // open from the phone right away
    return net;
  }));
});
