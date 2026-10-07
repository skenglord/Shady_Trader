// Network-only service worker: keeps the app installable without caching
// financial data, API responses, or stale trading controls for offline use.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', (event) => {
  if (event.request.method === 'GET') {
    event.respondWith(fetch(event.request));
  }
});
