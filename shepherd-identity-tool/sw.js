// Shepherd Identity Tool (Formation) — minimal service worker
// Strategy: cache-first for the shell, network-first for everything else.
// Bump CACHE_VERSION when you ship a new index.html so clients pick it up.
//
// Registered as 'sw.js' (relative), so its scope is wherever the app is served:
// '/' on shepherd-identity-tool.netlify.app, '/formation/' under the Shepherd hub.
// Everything below is resolved against that scope and only touches this app's own
// caches — the hub and the other apps share this origin (HUB.md §9b).
const CACHE_PREFIX = 'shepherd-identity-';
const CACHE_VERSION = CACHE_PREFIX + 'v3-mounted';
const SCOPE = self.registration.scope;                       // e.g. https://apps.shepherdchurch.co/formation/
const rel = (p) => new URL(p, SCOPE).toString();
const SHELL = ['', 'index.html', 'manifest.json', 'icon-192.png', 'icon-512.png'].map(rel);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(SHELL).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_VERSION).map((k) => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (!req.url.startsWith(SCOPE)) return;                    // never intercept the hub or other apps
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE_VERSION).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req).then((m) => m || caches.match(rel('index.html'))))
  );
});
