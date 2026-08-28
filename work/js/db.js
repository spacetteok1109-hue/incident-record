/*
 * db.js — 기기 안에만 저장되는 저장소 (IndexedDB)
 *
 * 팀원 · 현장 · 출역 · 가불 기록이 모두 이 파일을 통해 브라우저의
 * IndexedDB에만 저장됩니다. 서버로 나가는 통신은 없습니다.
 */

const DB_NAME = 'hyunjang';
const DB_VERSION = 1;

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('workers')) {
        const s = db.createObjectStore('workers', { keyPath: 'id' });
        s.createIndex('order', 'order');
        s.createIndex('name', 'name');
      }
      if (!db.objectStoreNames.contains('sites')) {
        const s = db.createObjectStore('sites', { keyPath: 'id' });
        s.createIndex('order', 'order');
        s.createIndex('name', 'name');
      }
      if (!db.objectStoreNames.contains('works')) {
        const s = db.createObjectStore('works', { keyPath: 'id' });
        s.createIndex('dateKey', 'dateKey');
        s.createIndex('month', 'month');
        s.createIndex('workerId', 'workerId');
        s.createIndex('siteId', 'siteId');
      }
      if (!db.objectStoreNames.contains('advances')) {
        const s = db.createObjectStore('advances', { keyPath: 'id' });
        s.createIndex('workerId', 'workerId');
        s.createIndex('dateKey', 'dateKey');
        s.createIndex('month', 'month');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('데이터베이스가 다른 탭에서 사용 중입니다.'));
  });
  return dbPromise;
}

function store(db, name, mode) {
  return db.transaction(name, mode).objectStore(name);
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function put(name, value) {
  const db = await openDB();
  await wrap(store(db, name, 'readwrite').put(value));
  return value;
}

export async function putAll(name, values) {
  if (!values.length) return values;
  const db = await openDB();
  const t = db.transaction(name, 'readwrite');
  const os = t.objectStore(name);
  values.forEach((v) => os.put(v));
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(values);
    t.onerror = () => reject(t.error);
  });
}

export async function get(name, key) {
  const db = await openDB();
  return wrap(store(db, name, 'readonly').get(key));
}

export async function getAll(name) {
  const db = await openDB();
  return wrap(store(db, name, 'readonly').getAll());
}

export async function getAllByIndex(name, index, value) {
  const db = await openDB();
  return wrap(store(db, name, 'readonly').index(index).getAll(value));
}

export async function del(name, key) {
  const db = await openDB();
  return wrap(store(db, name, 'readwrite').delete(key));
}

export async function delMany(name, keys) {
  if (!keys.length) return;
  const db = await openDB();
  const t = db.transaction(name, 'readwrite');
  const os = t.objectStore(name);
  keys.forEach((k) => os.delete(k));
  return new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

export async function clearStore(name) {
  const db = await openDB();
  return wrap(store(db, name, 'readwrite').clear());
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

/* ---------- 저장 공간 ---------- */

export async function storageEstimate() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage: usage || 0, quota: quota || 0 };
  } catch {
    return null;
  }
}

/** 브라우저가 저장 공간을 임의로 비우지 않도록 요청합니다. */
export async function requestPersistence() {
  if (!navigator.storage || !navigator.storage.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
