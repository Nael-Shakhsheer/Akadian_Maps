// Offline support: the app keeps working on campus with a weak signal.
// App files and map data: network first (always fresh), cache as fallback.
// Libraries, map tiles, fonts and icons: cache first (they never change for a given URL).
const CACHE = 'akadian-v2';
const SHELL = ['/', '/style.css', '/manifest.webmanifest', '/icons/icon-192.png'];
const LONG_LIVED = ['/vendor/', '/api/public/tiles/', '/api/public/fonts/', '/icons/'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function keep(req, res) {
  if (res.ok) {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy));
  }
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (LONG_LIVED.some((p) => url.pathname.startsWith(p))) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => keep(req, res))));
    return;
  }
  // deep links (?to=344 …) all share the same page, so fall back to the cached "/" when offline
  e.respondWith(fetch(req).then((res) => keep(req, res))
    .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/') : undefined))));
});
