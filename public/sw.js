// Service worker : l'interface reste disponible même si la connexion est coupée.
// Les données (API) ne sont jamais mises en cache : elles viennent toujours du serveur.
// CACHE et PRECACHE sont remplis par le serveur (version + liste des fichiers de l'interface).
const CACHE = 'garage-dev';
const PRECACHE = [];
self.addEventListener('install', (e) => e.waitUntil(
  caches.open(CACHE)
    .then((c) => Promise.allSettled(PRECACHE.map((u) => fetch(u, { cache: 'no-cache' }).then((r) => (r.ok ? c.put(u, r) : null)))))
    .then(() => self.skipWaiting())
));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api') || url.pathname.startsWith('/live-api')) return;
  const nav = e.request.mode === 'navigate';
  e.respondWith(
    fetch(e.request)
      .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: nav }).then((r) => r || (nav ? caches.match(url.pathname.startsWith('/kiosk') ? '/kiosk.html' : '/') : undefined)).then((r) => r || Response.error()))
  );
});
