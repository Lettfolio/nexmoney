/* NexMoney Back Office — minimal network-first service worker.
 * Bump CACHE to invalidate everything (no precache list -> no stale-shell bugs).
 * Rules: same-origin GET /admin/* only; cache 200 non-redirected successes;
 * never cache redirects (the /gate review gate) or opaque/error responses;
 * never intercept non-GET; offline navigations get a tiny inline page. */
const CACHE = 'nexmoney-admin-v1';

const OFFLINE_HTML =
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<meta name="theme-color" content="#0b1f35"><title>Offline — NexMoney</title>' +
  '<style>html,body{height:100%;margin:0}' +
  'body{background:#0b1f35;color:#e8eef6;font-family:-apple-system,Segoe UI,Inter,system-ui,sans-serif;' +
  'display:flex;align-items:center;justify-content:center;text-align:center;padding:24px}' +
  '.c{max-width:340px}.m{width:64px;height:64px;border-radius:14px;background:#f36f23;margin:0 auto 18px;' +
  'display:flex;align-items:center;justify-content:center;color:#fff;font-size:34px;font-weight:800;line-height:1}' +
  'h1{font-size:19px;margin:0 0 8px}p{margin:0;color:#9fb0c4;font-size:14px;line-height:1.5}</style></head>' +
  '<body><div class="c"><div class="m">&rsaquo;</div>' +
  '<h1>You’re offline</h1><p>Reconnect to use the back office.</p></div></body></html>';

function offlineResponse() {
  return new Response(OFFLINE_HTML, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isCacheable(request, response) {
  // Only same-origin GET /admin/* successes; skip redirects (gate) & opaque/error.
  if (!response || response.status !== 200) return false;
  if (response.redirected) return false;
  if (response.type !== 'basic') return false;
  try {
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return false;
    if (!url.pathname.startsWith('/admin/')) return false;
  } catch (e) { return false; }
  return true;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return; // never intercept non-GET

  let url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;        // let cross-origin pass through
  if (!url.pathname.startsWith('/admin/')) return;        // only our scope

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (isCacheable(request, response)) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response; // redirects (opaqueredirect to /gate) flow straight through, uncached
      })
      .catch(() =>
        caches.match(request).then((cached) => {
          if (cached) return cached;
          if (request.mode === 'navigate') return offlineResponse();
          return new Response('', { status: 504, statusText: 'Offline' });
        })
      )
  );
});
