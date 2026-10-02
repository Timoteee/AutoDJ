const CACHE_NAME = 'autodj-v7-shell';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll([
        '/',
        '/dj',
        '/display',
        '/manifest.json',
        '/icons/icon-192.png',
        '/icons/icon-512.png'
      ]).catch(() => {});
    })
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    })
  );
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  // Skip API calls and audio streams
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/cache/') || url.href.includes('webpack') || url.href.includes('hot-update')) {
    return;
  }
  const isDocument = e.request.mode === 'navigate' || /\/(dj|display)?$/.test(url.pathname);
  if (isDocument) {
    e.respondWith(
      fetch(e.request).then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request).then((cached) => cached || caches.match('/dj')))
    );
    return;
  }
  // Cache-first for static assets, network-first for everything else
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request));
    })
  );
});
