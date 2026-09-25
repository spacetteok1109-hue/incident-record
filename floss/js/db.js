/* db.js — 작업 중이던 사진과 상자를 기기 안에만 저장해 둡니다(IndexedDB).
   서버로 보내는 통신은 없습니다. */

const NAME = 'floss-cutter';
const STORE = 'kv';
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function get(key) {
  try {
    return await run('readonly', (s) => s.get(key));
  } catch (e) {
    return undefined;
  }
}

export async function set(key, value) {
  try {
    await run('readwrite', (s) => s.put(value, key));
    return true;
  } catch (e) {
    return false;
  }
}

export async function del(key) {
  try {
    await run('readwrite', (s) => s.delete(key));
  } catch (e) { /* 저장을 막아 둔 브라우저 */ }
}
