// Service Worker для Octopus MOBA // v14 force-reload
// Стратегия:
//  • index.html и любые HTML — NetworkFirst (всегда с сервера, никакого кэша для разработки)
//  • manifest.json + иконки — CacheFirst (редко меняются, можно офлайн)
//  • socket.io, /state — не кэшируем
const CACHE = 'octopus-moba-v16';
const STATIC = [
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // socket.io — никогда не кэшируем
  if (url.pathname.startsWith('/socket.io')) return;

  // HTML (index.html, /) — NetworkFirst, fallback на сервер.
  // ПРИ РАЗРАБОТКЕ: каждый раз получает свежий HTML, никакого кэша.
  if (e.request.mode === 'navigate' ||
      (e.request.headers.get('accept') || '').includes('text/html')) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match('/'))
    );
    return;
  }

  // остальное (manifest, иконки) — cache-first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        if (resp.ok && resp.type === 'basic') {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return resp;
      });
    })
  );
});
