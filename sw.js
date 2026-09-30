// Service Worker：讓 Chrome 願意把這個頁面當成「可安裝的應用程式」。
//
// 為什麼要有這支：Chrome 的安裝條件除了 manifest（name／icons／start_url／display）之外，
// 還要求網頁註冊一個「有 fetch handler 的 service worker」。沒有它，按「安裝應用程式」會失敗。
//
// 策略刻意選**網路優先**：資料（items.json／changes.json）完全不進快取，
// 永遠拿最新的一份；快取只在離線時當備援。避免出現「看到舊資料」這種最糟的錯誤。
const CACHE = 'cex-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  if (/\.(json|gz)$/i.test(url.pathname)) return;   // 資料不進快取 → 永遠是新的

  event.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || new Response('離線，且這份沒有快取。', {
        status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' },
      })))
  );
});
