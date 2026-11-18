// Service worker: lets the app open even when the connection is bad or gone.
// Reports themselves are queued by the app (src/outbox.ts), not here.
const CACHE = 'entrada-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Never touch API calls, sign-in, uploads, or other sites.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.auth/')) return;

  if (url.pathname.startsWith('/assets/')) {
    // Fingerprinted build files never change: serve from cache first.
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }

  if (req.mode === 'navigate') {
    // Pages: try the network (to pick up new versions), fall back to the cached app.
    event.respondWith(fetch(req).then((res) => {
      if (res.ok && url.pathname === '/') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); }
      return res;
    }).catch(() => caches.match(url.pathname === '/admin.html' ? req : '/').then((hit) => hit || caches.match('/index.html'))));
  }
});
