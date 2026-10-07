/* store.js — 도메인 계층 (폴더 / 항목 / 사진 메타) */

import * as db from './db.js';
import { toTimestamp, todayKey, nextRepeatDate, toDateKey, fromDateKey, REPEAT_LABELS } from './util.js';

export const FOLDER_COLORS = [
  '#5865f2', '#e0567a', '#f0913a', '#3fb27f',
  '#38a3d1', '#a061e0', '#d9534f', '#8a94a6',
];

export const TYPE_LABELS = { task: '할 일', dday: '디데이' };

/** 시간이 지정되지 않은 항목의 기본 알림 시각 */
export const DEFAULT_ALLDAY_HOUR = '09:00';

let cache = { folders: null, items: null };
const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  listeners.forEach((fn) => {
    try { fn(); } catch (e) { console.error(e); }
  });
}

/** 가계부처럼 다른 모듈이 바뀌었을 때 화면을 다시 그리게 합니다. */
export function notifyChanged() {
  invalidate();
  emit();
}

export function invalidate() {
  cache.folders = null;
  cache.items = null;
}

/* ---------------- 폴더 ---------------- */

const DEFAULT_FOLDERS = [
  { name: '개인', emoji: '🏠', color: FOLDER_COLORS[0] },
  { name: '업무', emoji: '💼', color: FOLDER_COLORS[4] },
  { name: '기념일', emoji: '🎂', color: FOLDER_COLORS[1] },
];

export async function ensureSeed() {
  const folders = await db.getAll('folders');
  if (folders.length) return;
  const seeded = DEFAULT_FOLDERS.map((f, i) => ({
    id: db.uid(),
    name: f.name,
    emoji: f.emoji,
    color: f.color,
    order: i,
    createdAt: Date.now(),
  }));
  await db.putAll('folders', seeded);
  invalidate();
}

export async function getFolders() {
  if (!cache.folders) {
    const rows = await db.getAll('folders');
    rows.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt);
    cache.folders = rows;
  }
  return cache.folders;
}

export async function getFolder(id) {
  if (!id) return null;
  const folders = await getFolders();
  return folders.find((f) => f.id === id) || null;
}

export async function saveFolder(data) {
  const folders = await getFolders();
  const existing = data.id ? folders.find((f) => f.id === data.id) : null;
  const folder = {
    id: data.id || db.uid(),
    name: (data.name || '').trim() || '새 폴더',
    emoji: data.emoji || '📁',
    color: data.color || FOLDER_COLORS[0],
    order: existing ? existing.order : folders.length,
    createdAt: existing ? existing.createdAt : Date.now(),
  };
  await db.put('folders', folder);
  invalidate();
  emit();
  return folder;
}

/**
 * 폴더를 삭제합니다.
 * mode 'move'  : 안의 항목을 폴더 없음으로 옮깁니다(기본).
 * mode 'delete': 안의 항목과 사진까지 함께 삭제합니다.
 */
export async function deleteFolder(id, mode = 'move') {
  const items = await db.getAllByIndex('items', 'folderId', id);
  if (mode === 'delete') {
    for (const it of items) await deleteItem(it.id);
  } else {
    await db.putAll('items', items.map((it) => ({ ...it, folderId: null, updatedAt: Date.now() })));
  }
  await db.del('folders', id);
  invalidate();
  emit();
}

export async function reorderFolders(orderedIds) {
  const folders = await getFolders();
  const byId = new Map(folders.map((f) => [f.id, f]));
  const updated = orderedIds.map((id, i) => ({ ...byId.get(id), order: i })).filter((f) => f.id);
  await db.putAll('folders', updated);
  invalidate();
  emit();
}

/* ---------------- 항목 ---------------- */

export function blankItem(overrides = {}) {
  return {
    id: null,
    folderId: null,
    type: 'task',
    title: '',
    memo: '',
    done: false,
    doneAt: null,
    checklist: [],
    startDate: null,
    showAsBar: true,
    dueDate: null,
    dueTime: null,
    endTime: null,
    remindOffset: null,
    remindAt: null,
    notifiedAt: null,
    repeat: 'none',
    pinned: false,
    photoIds: [],
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

/** 마감 시각과 알림 오프셋으로 실제 알림 시각(epoch ms)을 계산합니다. */
export function computeRemindAt(item) {
  if (item.remindOffset === null || item.remindOffset === undefined || item.remindOffset === '') return null;
  if (!item.dueDate) return null;
  const base = toTimestamp(item.dueDate, item.dueTime || DEFAULT_ALLDAY_HOUR);
  if (base === null) return null;
  return base - Number(item.remindOffset) * 60000;
}

export async function getItems() {
  if (!cache.items) {
    cache.items = await db.getAll('items');
  }
  return cache.items;
}

export async function getItem(id) {
  return db.get('items', id);
}

export async function saveItem(data) {
  const now = Date.now();
  const item = {
    ...blankItem(),
    ...data,
    id: data.id || db.uid(),
    title: (data.title || '').trim() || '제목 없음',
    createdAt: data.createdAt || now,
    updatedAt: now,
  };
  if (item.remindOffset === '' ) item.remindOffset = null;
  if (item.remindOffset !== null) item.remindOffset = Number(item.remindOffset);
  const prevRemindAt = data.remindAt ?? null;
  item.remindAt = computeRemindAt(item);
  // 알림 시각이 바뀌면 '이미 알림을 보냈다'는 표시를 지웁니다.
  if (item.remindAt !== prevRemindAt) item.notifiedAt = null;
  if (item.done) item.remindAt = null;
  await db.put('items', item);
  invalidate();
  emit();
  return item;
}

export async function deleteItem(id) {
  const photos = await db.getAllByIndex('photos', 'itemId', id);
  for (const p of photos) await db.del('photos', p.id);
  await db.del('items', id);
  invalidate();
  emit();
}

/**
 * 완료 상태를 토글합니다.
 * 반복 항목을 완료하면 원본은 다음 날짜로 넘어가고,
 * 완료된 기록이 새 항목으로 남습니다.
 */
export async function toggleDone(id) {
  const item = await db.get('items', id);
  if (!item) return null;

  if (!item.done && item.repeat && item.repeat !== 'none' && item.dueDate) {
    const doneCopy = {
      ...item,
      id: db.uid(),
      done: true,
      doneAt: Date.now(),
      repeat: 'none',
      remindAt: null,
      notifiedAt: null,
      photoIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    let next = nextRepeatDate(item.dueDate, item.repeat);
    // 지난 날짜라면 오늘 이후가 될 때까지 앞으로 감습니다.
    let guard = 0;
    while (next && next < todayKey() && guard++ < 500) {
      next = nextRepeatDate(next, item.repeat);
    }
    const advanced = {
      ...item,
      dueDate: next || item.dueDate,
      done: false,
      doneAt: null,
      notifiedAt: null,
      checklist: (item.checklist || []).map((c) => ({ ...c, done: false })),
      updatedAt: Date.now(),
    };
    advanced.remindAt = computeRemindAt(advanced);
    await db.putAll('items', [doneCopy, advanced]);
    invalidate();
    emit();
    return advanced;
  }

  const updated = { ...item, done: !item.done, doneAt: !item.done ? Date.now() : null, updatedAt: Date.now() };
  updated.remindAt = updated.done ? null : computeRemindAt(updated);
  if (!updated.done) updated.notifiedAt = null;
  await db.put('items', updated);
  invalidate();
  emit();
  return updated;
}

export async function toggleChecklistItem(itemId, checkId) {
  const item = await db.get('items', itemId);
  if (!item) return null;
  const checklist = (item.checklist || []).map((c) =>
    c.id === checkId ? { ...c, done: !c.done } : c);
  const updated = { ...item, checklist, updatedAt: Date.now() };
  await db.put('items', updated);
  invalidate();
  emit();
  return updated;
}

export async function markNotified(id) {
  const item = await db.get('items', id);
  if (!item) return;
  await db.put('items', { ...item, notifiedAt: Date.now() });
  invalidate();
}

/* ---------------- 조회 헬퍼 ---------------- */

export function sortItems(items) {
  return items.slice().sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const ad = a.dueDate || '9999-99-99';
    const bd = b.dueDate || '9999-99-99';
    if (ad !== bd) return ad < bd ? -1 : 1;
    const at = a.dueTime || '99:99';
    const bt = b.dueTime || '99:99';
    if (at !== bt) return at < bt ? -1 : 1;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}

export async function itemsForDate(dateKey) {
  const items = await getItems();
  // 기간이 있는 항목은 시작일에도 보여 줍니다.
  return sortItems(items.filter((it) => it.dueDate === dateKey || it.startDate === dateKey));
}

export async function itemsForFolder(folderId) {
  const items = await getItems();
  return sortItems(items.filter((it) => (it.folderId || null) === (folderId || null)));
}

/** 오늘 화면: 지난 미완료 + 오늘 + 기한 없는 미완료 */
export async function todayBuckets() {
  const items = await getItems();
  const today = todayKey();
  const overdue = [];
  const todays = [];
  const someday = [];
  for (const it of items) {
    if (it.type === 'dday') continue;
    if (it.done) {
      if (it.dueDate === today) todays.push(it);
      continue;
    }
    if (!it.dueDate) someday.push(it);
    else if (it.dueDate < today) overdue.push(it);
    else if (it.dueDate === today) todays.push(it);
  }
  return {
    overdue: sortItems(overdue),
    today: sortItems(todays),
    someday: sortItems(someday),
  };
}

/**
 * 달력에 줄(막대)로 그릴 항목들.
 * 시작일과 마감일이 다른, 즉 여러 날에 걸친 항목만 해당합니다.
 */
export async function spanningItems(fromKey, toKey, { includeDday = true } = {}) {
  const items = await getItems();
  return items
    .filter((it) => includeDday || it.type !== 'dday')
    // 항목별로 '마감일에만 표시'를 고른 것은 줄로 그리지 않습니다.
    .filter((it) => it.showAsBar !== false)
    .filter((it) => it.startDate && it.dueDate && it.startDate < it.dueDate)
    .filter((it) => it.startDate <= toKey && it.dueDate >= fromKey)
    .sort((a, b) => (a.startDate === b.startDate
      ? (a.dueDate < b.dueDate ? 1 : -1)
      : (a.startDate < b.startDate ? -1 : 1)));
}

/** 진행 중인 디데이. 완료 표시한 것은 기본으로 빼고 돌려줍니다. */
export async function ddayItems({ includeDone = false } = {}) {
  const items = await getItems();
  const list = items.filter((it) => it.type === 'dday' && it.dueDate
    && (includeDone || !it.done));
  const today = todayKey();
  return list.sort((a, b) => {
    const af = a.dueDate >= today;
    const bf = b.dueDate >= today;
    // 다가오는 날짜를 먼저, 지난 날짜는 최근 순으로 뒤에
    if (af !== bf) return af ? -1 : 1;
    if (af) return a.dueDate < b.dueDate ? -1 : 1;
    return a.dueDate > b.dueDate ? -1 : 1;
  });
}

/** 완료 표시한 디데이. 최근에 완료한 것부터. */
export async function doneDdayItems() {
  const items = await getItems();
  return items
    .filter((it) => it.type === 'dday' && it.done)
    .sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
}

export async function upcomingReminders(withinMs = 7 * 86400000) {
  const items = await getItems();
  const now = Date.now();
  return items
    .filter((it) => !it.done && it.remindAt && it.remindAt > now && it.remindAt < now + withinMs)
    .sort((a, b) => a.remindAt - b.remindAt);
}

export async function searchItems(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const items = await getItems();
  return sortItems(items.filter((it) => {
    if ((it.title || '').toLowerCase().includes(q)) return true;
    if ((it.memo || '').toLowerCase().includes(q)) return true;
    return (it.checklist || []).some((c) => (c.text || '').toLowerCase().includes(q));
  }));
}

/** 완료된 지 n일 지난 항목 정리 */
export async function purgeCompleted(olderThanDays = 0) {
  const items = await getItems();
  const cutoff = Date.now() - olderThanDays * 86400000;
  const targets = items.filter((it) => it.done && (it.doneAt || 0) <= cutoff);
  for (const it of targets) await deleteItem(it.id);
  return targets.length;
}

/**
 * 예전 버전에서 만든 '일정(event)' 항목을 '할 일(task)'로 옮깁니다.
 * 두 종류가 하는 일이 같아 하나로 합쳤습니다. 시간·반복·알림은 그대로 남습니다.
 */
export async function migrateEventsToTasks() {
  const items = await getItems();
  const targets = items.filter((it) => it.type === 'event');
  if (!targets.length) return 0;
  await db.putAll('items', targets.map((it) => ({ ...it, type: 'task', updatedAt: Date.now() })));
  invalidate();
  return targets.length;
}

/** 지난 반복 항목을 오늘 이후로 밀어 놓습니다(앱을 오랜만에 열었을 때). */
export async function rollForwardRepeats() {
  const items = await getItems();
  const today = todayKey();
  const updates = [];
  for (const it of items) {
    if (it.done || !it.repeat || it.repeat === 'none' || !it.dueDate) continue;
    if (it.dueDate >= today) continue;
    let next = it.dueDate;
    let guard = 0;
    while (next < today && guard++ < 2000) {
      const n = nextRepeatDate(next, it.repeat);
      if (!n) break;
      next = n;
    }
    if (next !== it.dueDate) {
      const upd = { ...it, dueDate: next, notifiedAt: null, updatedAt: Date.now() };
      upd.remindAt = computeRemindAt(upd);
      updates.push(upd);
    }
  }
  if (updates.length) {
    await db.putAll('items', updates);
    invalidate();
    emit();
  }
  return updates.length;
}

/** 백업용 JSON (사진은 base64로 포함) */
export async function exportBackup(includePhotos = true) {
  const [folders, items, photos, expenses] = await Promise.all([
    db.getAll('folders'), db.getAll('items'), db.getAll('photos'), db.getAll('expenses'),
  ]);
  const outPhotos = [];
  if (includePhotos) {
    for (const p of photos) {
      outPhotos.push({
        id: p.id, itemId: p.itemId, name: p.name, type: p.type,
        createdAt: p.createdAt, width: p.width, height: p.height,
        data: await blobToDataURL(p.blob),
        thumb: p.thumb ? await blobToDataURL(p.thumb) : null,
      });
    }
  }
  return {
    app: 'todo-cal',
    version: 1,
    exportedAt: new Date().toISOString(),
    folders,
    items,
    expenses,
    photos: outPhotos,
  };
}

/* ---------------- 백업 읽어 들이기 ----------------
   백업 파일은 바깥에서 온 자료입니다. 우리가 아는 칸만 골라 담고,
   모양이 안 맞는 줄은 버립니다. 통째로 집어넣으면 화면이 깨지거나
   엉뚱한 값이 섞여 들어옵니다.
*/

const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const bool = (v) => !!v;
const dateKey = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const timeKey = (v) => (/^\d{2}:\d{2}$/.test(v) ? v : null);
const id = (v) => (typeof v === 'string' && v && v.length <= 64 ? v : null);

function cleanFolder(f) {
  if (!f || !id(f.id)) return null;
  return {
    id: f.id,
    name: str(f.name, 40) || '이름 없음',
    emoji: str(f.emoji, 8) || '📁',
    color: /^#[0-9a-f]{3,8}$/i.test(f.color) ? f.color : FOLDER_COLORS[0],
    order: num(f.order),
    createdAt: num(f.createdAt) || Date.now(),
  };
}

function cleanChecklist(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 200).map((c) => ({
    id: id(c?.id) || db.uid(),
    text: str(c?.text, 200),
    done: bool(c?.done),
  })).filter((c) => c.text);
}

function cleanItem(it) {
  if (!it || !id(it.id)) return null;
  const type = it.type === 'dday' ? 'dday' : 'task';
  return {
    id: it.id,
    type,
    title: str(it.title, 200) || '제목 없음',
    memo: str(it.memo, 5000),
    folderId: id(it.folderId),
    startDate: dateKey(it.startDate),
    dueDate: dateKey(it.dueDate),
    dueTime: timeKey(it.dueTime),
    remindAt: num(it.remindAt) || null,
    repeat: typeof it.repeat === 'string' && it.repeat in REPEAT_LABELS ? it.repeat : 'none',
    checklist: cleanChecklist(it.checklist),
    photoIds: Array.isArray(it.photoIds) ? it.photoIds.filter(id).slice(0, 50) : [],
    showAsBar: it.showAsBar !== false,
    pinned: bool(it.pinned),
    done: bool(it.done),
    doneAt: num(it.doneAt) || null,
    createdAt: num(it.createdAt) || Date.now(),
    updatedAt: num(it.updatedAt) || Date.now(),
  };
}

function cleanExpense(r) {
  if (!r || !id(r.id)) return null;
  const date = dateKey(r.date);
  if (!date) return null;
  return {
    id: r.id,
    date,
    type: r.type === 'income' ? 'income' : 'expense',
    amount: Math.max(0, Math.round(num(r.amount))),
    method: str(r.method, 20) || 'cash',
    category: str(r.category, 64) || 'etc',
    memo: str(r.memo, 200),
    installment: Math.min(36, Math.max(1, Math.round(num(r.installment)) || 1)),
    createdAt: num(r.createdAt) || Date.now(),
    updatedAt: num(r.updatedAt) || Date.now(),
  };
}

export async function importBackup(data, mode = 'merge') {
  if (!data || typeof data !== 'object' || data.app !== 'todo-cal') {
    throw new Error('이 앱의 백업 파일이 아닙니다.');
  }

  const pick = (key, fn) => (Array.isArray(data[key]) ? data[key] : [])
    .slice(0, 20000).map(fn).filter(Boolean);

  const folders = pick('folders', cleanFolder);
  const items = pick('items', cleanItem);
  const expenses = pick('expenses', cleanExpense);

  const photos = [];
  let badPhotos = 0;
  for (const p of (Array.isArray(data.photos) ? data.photos : []).slice(0, 5000)) {
    if (!p || !id(p.id)) { badPhotos += 1; continue; }
    try {
      const blob = dataURLToBlob(p.data);
      photos.push({
        id: p.id,
        itemId: id(p.itemId),
        name: str(p.name, 120) || 'photo.jpg',
        type: blob.type,
        createdAt: num(p.createdAt) || Date.now(),
        width: num(p.width),
        height: num(p.height),
        size: blob.size,
        blob,
        thumb: p.thumb ? dataURLToBlob(p.thumb) : null,
      });
    } catch {
      badPhotos += 1;   // 형식이 안 맞는 사진은 버리고 나머지는 살립니다.
    }
  }

  if (mode === 'replace') {
    await Promise.all([
      db.clearStore('folders'), db.clearStore('items'),
      db.clearStore('photos'), db.clearStore('expenses'),
    ]);
  }
  if (folders.length) await db.putAll('folders', folders);
  if (items.length) await db.putAll('items', items);
  if (expenses.length) await db.putAll('expenses', expenses);
  if (photos.length) await db.putAll('photos', photos);

  invalidate();
  emit();
  return {
    folders: folders.length,
    items: items.length,
    expenses: expenses.length,
    photos: photos.length,
    skipped: badPhotos
      + Math.max(0, (data.folders?.length || 0) - folders.length)
      + Math.max(0, (data.items?.length || 0) - items.length)
      + Math.max(0, (data.expenses?.length || 0) - expenses.length),
  };
}

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/* 백업에 담긴 사진은 반드시 data:image/... 형태여야 합니다.
   바깥 주소(http:, blob: 등)를 받아 fetch 하면, 기기 안에만 둔다는 약속을 깨고
   가져오기만 해도 바깥으로 신호가 나갑니다. 그래서 직접 해독합니다. */
const DATA_IMAGE_RE = /^data:(image\/(?:png|jpeg|jpg|webp|gif|avif));base64,([A-Za-z0-9+/=\s]+)$/i;
const MAX_PHOTO_BYTES = 12 * 1024 * 1024;

export function dataURLToBlob(url) {
  const m = DATA_IMAGE_RE.exec(String(url || '').trim());
  if (!m) throw new Error('사진 형식이 올바르지 않습니다.');
  const type = m[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : m[1].toLowerCase();
  const bin = atob(m[2].replace(/\s+/g, ''));
  if (bin.length > MAX_PHOTO_BYTES) throw new Error('사진이 너무 큽니다.');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  // 형식을 우리가 정해 둡니다. text/html 같은 걸 넣어 blob 주소로 열리는 길을 막습니다.
  return new Blob([bytes], { type });
}

export async function wipeAll() {
  await Promise.all([
    db.clearStore('folders'), db.clearStore('items'),
    db.clearStore('photos'), db.clearStore('meta'), db.clearStore('expenses'),
  ]);
  invalidate();
  emit();
}

/**
 * 달력 칸에 쓰는 요약.
 * 달력에는 앞뒤 달의 며칠도 함께 보이므로, 달이 아니라 화면에 보이는
 * 날짜 범위 전체를 대상으로 합니다.
 */
export async function rangeSummary(fromKey, toKey, { includeDday = true } = {}) {
  const all = await getItems();
  const items = includeDday ? all : all.filter((it) => it.type !== 'dday');
  const today = todayKey();
  const map = new Map();
  const mark = (key, it) => {
    if (!key || key < fromKey || key > toKey) return;
    const cur = map.get(key) || { total: 0, done: 0, hasDday: false, overdue: false, marks: [] };
    cur.total++;
    if (it.done) cur.done++;
    if (it.type === 'dday') cur.hasDday = true;
    // 지난 날짜인데 아직 끝내지 않은 할 일이 있으면 그 칸을 표시합니다.
    if (!it.done && it.type !== 'dday' && key < today) cur.overdue = true;
    // 점을 폴더 색으로 찍기 위해 항목 정보를 함께 남깁니다.
    cur.marks.push({ id: it.id, folderId: it.folderId || null, type: it.type, done: !!it.done });
    map.set(key, cur);
  };
  for (const it of items) {
    mark(it.dueDate, it);
    // 줄로 그리는 항목만 시작일에도 표시를 남깁니다.
    // '마감일에만 표시'인 항목은 마감일 하나에만 점이 찍힙니다.
    if (it.startDate && it.startDate !== it.dueDate && it.showAsBar !== false) {
      mark(it.startDate, it);
    }
  }
  return map;
}

export { toDateKey, fromDateKey };
