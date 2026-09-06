/* sw.js — 오프라인 사용과 백그라운드 알림 확인 */

const CACHE = 'todo-cal-v15';
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
  './js/media.js',
  './js/notify.js',
  './js/lock.js',
  './js/icons.js',
  './js/money.js',
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
    // 예전 버전이 열려 있었다면 새 파일로 바꿔 줍니다.
    if (stale.length) await refreshOpenClients();
  })());
});

/**
 * 열려 있는 화면에 새 버전이 왔다고 알립니다.
 *
 * 새 코드가 돌고 있는 화면은 스스로 처리하고 'ack' 를 보내 줍니다.
 * 예전 코드가 돌고 있는 화면은 이 메시지를 알아듣지 못하므로,
 * 잠시 기다렸다가 직접 새로고침시킵니다. 이렇게 하지 않으면
 * 앱이 예전 파일을 계속 띄운 채로 남습니다.
 */
async function refreshOpenClients() {
  const clients = await self.clients.matchAll({ type: 'window' });
  if (!clients.length) return;

  const pending = clients.map((client) => {
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
  });

  await Promise.all(pending);
}

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skip-waiting') self.skipWaiting();
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

/* ---------------- 알림 클릭 ---------------- */

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = new URL(data.url || './index.html', self.location.href).href;

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      if (client.url.startsWith(self.registration.scope)) {
        await client.focus();
        if (data.itemId) client.postMessage({ type: 'open-item', itemId: data.itemId });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

/* ---------------- 백그라운드 알림 확인 ---------------- */
/*
 * 앱이 닫혀 있을 때도 브라우저가 지원하면 주기적으로 깨어나
 * 알림 시각이 지난 항목을 찾아 알림을 띄웁니다.
 * (Chrome/Android의 periodicSync를 지원하는 경우에만 동작합니다.)
 */

const DB_NAME = 'todo-cal';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getAllItems(db) {
  return new Promise((resolve, reject) => {
    const req = db.transaction('items', 'readonly').objectStore('items').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function putItem(db, item) {
  return new Promise((resolve, reject) => {
    const t = db.transaction('items', 'readwrite');
    t.objectStore('items').put(item);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

async function checkReminders() {
  let db;
  try {
    db = await openDB();
  } catch {
    return;
  }
  if (!db.objectStoreNames.contains('items')) return;

  const items = await getAllItems(db);
  const now = Date.now();
  const due = items.filter((it) => !it.done && it.remindAt && !it.notifiedAt && it.remindAt <= now);

  for (const it of due) {
    const timeText = it.dueTime ? ` ${it.dueTime}` : '';
    await self.registration.showNotification(it.title || '알림', {
      body: `${it.dueDate || ''}${timeText}`.trim() || '예정된 알림입니다.',
      tag: 'item-' + it.id,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      data: { itemId: it.id, url: './index.html?item=' + encodeURIComponent(it.id) },
    });
    await putItem(db, { ...it, notifiedAt: Date.now() });
  }

  if (due.length) {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clientList.forEach((c) => c.postMessage({ type: 'reminders-checked' }));
  }
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'check-reminders') event.waitUntil(checkReminders());
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'check-reminders') event.waitUntil(checkReminders());
});
