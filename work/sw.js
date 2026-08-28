/* sw.js — 오프라인 사용 */

const CACHE = 'hyunjang-v2';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/store.js',
  './js/util.js',
  './js/ui.js',
  './js/editor.js',
  './js/lock.js',
  './js/export.js',
  './js/xlsx.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const stale = keys.filter((k) => k !== CACHE);
    await Promise.all(stale.map((k) => caches.delete(k)));
    await self.clients.claim();
    if (stale.length) await refreshOpenClients();
  })());
});

/**
 * 열려 있는 화면에 새 버전이 왔다고 알립니다.
 * 예전 코드가 돌고 있는 화면은 이 메시지를 알아듣지 못하므로,
 * 잠시 기다렸다가 직접 새로고침시킵니다.
 */
async function refreshOpenClients() {
  const clients = await self.clients.matchAll({ type: 'window' });
  if (!clients.length) return;

  await Promise.all(clients.map((client) => {
    let acked = false;
    try {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => { if (e.data === 'ack') acked = true; };
      client.postMessage({ type: 'app-updated' }, [ch.port2]);
    } catch {
      /* 메시지를 못 보내면 아래에서 바로 새로고침합니다. */
    }
    return new Promise((resolve) => {
      setTimeout(() => {
        if (!acked && typeof client.navigate === 'function') {
          client.navigate(client.url).catch(() => {});
        }
        resolve();
      }, 3000);
    });
  }));
}

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'skip-waiting' || type === 'SKIP_WAITING') self.skipWaiting();
});

/* 같은 출처의 요청만 캐시에서 먼저 찾고, 뒤에서 조용히 갱신합니다. */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./'))),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
