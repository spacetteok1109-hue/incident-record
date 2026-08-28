/* sw.js — 한 번 열어 두면 인터넷 없이도 그대로 쓰도록 파일을 챙겨 둡니다. */

const CACHE = 'floss-cutter-v1';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/ui.js',
  './js/db.js',
  './js/color.js',
  './js/detect.js',
  './js/crop.js',
  './js/sample.js',
  './js/palette.js',
  './js/ocr.js',
  './data/dmc.json',
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
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // 글자 인식기 등 바깥 주소는 그대로 둡니다.

  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true });
    const network = fetch(request).then(async (res) => {
      if (res && res.ok) {
        const cache = await caches.open(CACHE);
        cache.put(request, res.clone());
      }
      return res;
    }).catch(() => null);
    // 캐시가 있으면 먼저 보여 주고, 뒤에서 새 파일을 받아 둡니다.
    return cached || (await network) || new Response('오프라인입니다.', { status: 503 });
  })());
});
