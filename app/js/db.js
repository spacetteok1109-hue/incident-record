/*
 * db.js — 로컬 전용 저장소 (IndexedDB)
 *
 * 이 앱의 모든 데이터(할 일, 폴더, 사진, 설정)는 이 파일을 통해
 * 브라우저의 IndexedDB에만 저장됩니다. 서버로 전송되는 데이터는 없습니다.
 */

const DB_NAME = 'todo-cal';
const DB_VERSION = 2;

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('folders')) {
        const s = db.createObjectStore('folders', { keyPath: 'id' });
        s.createIndex('order', 'order');
      }
      if (!db.objectStoreNames.contains('items')) {
        const s = db.createObjectStore('items', { keyPath: 'id' });
        s.createIndex('folderId', 'folderId');
        s.createIndex('dueDate', 'dueDate');
        s.createIndex('remindAt', 'remindAt');
        s.createIndex('type', 'type');
      }
      if (!db.objectStoreNames.contains('photos')) {
        const s = db.createObjectStore('photos', { keyPath: 'id' });
        s.createIndex('itemId', 'itemId');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      // v2: 가계부
      if (!db.objectStoreNames.contains('expenses')) {
        const s = db.createObjectStore('expenses', { keyPath: 'id' });
        s.createIndex('date', 'date');
        s.createIndex('method', 'method');
        s.createIndex('category', 'category');
      }
      void e;
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('데이터베이스가 다른 탭에서 사용 중입니다.'));
  });
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function put(store, value) {
  const db = await openDB();
  const os = tx(db, store, 'readwrite');
  await wrap(os.put(value));
  return value;
}

export async function putAll(store, values) {
  const db = await openDB();
  const t = db.transaction(store, 'readwrite');
  const os = t.objectStore(store);
  values.forEach((v) => os.put(v));
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(values);
    t.onerror = () => reject(t.error);
  });
}

export async function get(store, key) {
  const db = await openDB();
  return wrap(tx(db, store, 'readonly').get(key));
}

export async function getAll(store) {
  const db = await openDB();
  return wrap(tx(db, store, 'readonly').getAll());
}

export async function getAllByIndex(store, index, value) {
  const db = await openDB();
  return wrap(tx(db, store, 'readonly').index(index).getAll(value));
}

export async function del(store, key) {
  const db = await openDB();
  const os = tx(db, store, 'readwrite');
  return wrap(os.delete(key));
}

export async function clearStore(store) {
  const db = await openDB();
  return wrap(tx(db, store, 'readwrite').clear());
}

/* ---------- 설정(meta) ---------- */

export async function getMeta(key, fallback = null) {
  const row = await get('meta', key);
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  return put('meta', { key, value });
}

/* ---------- 아이디 ---------- */

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/* ---------- 저장 용량 ---------- */

export async function storageEstimate() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage: usage || 0, quota: quota || 0 };
  } catch {
    return null;
  }
}

/**
 * 브라우저가 저장 공간을 자동으로 비우지 않도록 요청합니다.
 * (승인되면 사용자가 직접 지우기 전까지 데이터가 유지됩니다.)
 */
export async function requestPersistence() {
  if (!navigator.storage || !navigator.storage.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
