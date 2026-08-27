/*
 * store.js — 팀원 · 현장 · 출역 · 가불 도메인 로직
 *
 * 금액 계산 규칙
 *   출역 1건의 지급액 = 일당 × 공수 + (자차를 썼다면) 차량 수당
 *   월 실지급액        = 그 달 지급액 합계 − 그 달 가불 합계
 */

import * as db from './db.js';
import { num, todayKey, monthKey, daysOfMonth } from './util.js';

export const SITE_COLORS = [
  '#5865f2', '#e0708a', '#3fb27f', '#e0a23a',
  '#6f9fe0', '#b07de0', '#e07a4a', '#4ab5b0',
];

/** 공수(하루 일한 양) 선택지 */
export const GONGSU_OPTIONS = [0.5, 1, 1.5, 2];

/** 은행 목록 — 계좌 입력할 때 고르기 편하도록 */
export const BANKS = [
  '농협', '국민', '신한', '우리', '하나', '기업', '카카오뱅크',
  '토스뱅크', '새마을금고', '수협', '부산', '대구', '경남', '광주',
  '전북', '제주', 'SC제일', '씨티', '산업', '우체국', '신협', '케이뱅크',
];

/* ---------------- 변경 알림 ---------------- */

const listeners = new Set();
let cache = null;

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  cache = null;
  listeners.forEach((fn) => {
    try { fn(); } catch (e) { console.error(e); }
  });
}

export function invalidate() {
  cache = null;
}

/**
 * 전체 데이터를 한 번만 읽어 두고 재사용합니다.
 * 기록이 몇 천 건이어도 휴대전화에서 충분히 빠릅니다.
 */
async function load() {
  if (cache) return cache;
  const [workers, sites, works, advances] = await Promise.all([
    db.getAll('workers'), db.getAll('sites'), db.getAll('works'), db.getAll('advances'),
  ]);
  cache = { workers, sites, works, advances };
  return cache;
}

/* ---------------- 팀원 ---------------- */

export function blankWorker(overrides = {}) {
  return {
    id: db.uid(),
    name: '',
    birthYear: '',       // '1968' 처럼 4자리
    phone: '',
    dailyWage: 0,        // 기본 일당
    hasCar: false,       // 자차 보유 여부
    carPay: 0,           // 자차 운행 시 얹어 줄 수당
    bankName: '',
    bankAccount: '',
    bankHolder: '',      // 예금주가 본인과 다를 때만 채웁니다
    memo: '',
    active: true,        // 끄면 목록에서 숨겨집니다(기록은 그대로)
    order: Date.now(),
    createdAt: Date.now(),
    ...overrides,
  };
}

export async function getWorkers({ includeInactive = true } = {}) {
  const { workers } = await load();
  const list = includeInactive ? workers : workers.filter((w) => w.active !== false);
  return list.slice().sort((a, b) => {
    if ((a.active !== false) !== (b.active !== false)) return a.active === false ? 1 : -1;
    return (a.order || 0) - (b.order || 0);
  });
}

export async function getWorker(id) {
  const { workers } = await load();
  return workers.find((w) => w.id === id) || null;
}

export async function saveWorker(data) {
  const worker = { ...blankWorker(), ...data };
  worker.name = String(worker.name || '').trim();
  if (!worker.name) throw new Error('이름을 입력해 주세요.');
  worker.dailyWage = num(worker.dailyWage);
  worker.carPay = num(worker.carPay);
  worker.birthYear = String(worker.birthYear || '').replace(/\D/g, '').slice(0, 4);
  worker.updatedAt = Date.now();
  await db.put('workers', worker);
  emit();
  return worker;
}

/** 팀원을 지우면 그 사람의 출역 · 가불 기록도 함께 지워집니다. */
export async function deleteWorker(id) {
  const { works, advances } = await load();
  await db.delMany('works', works.filter((w) => w.workerId === id).map((w) => w.id));
  await db.delMany('advances', advances.filter((a) => a.workerId === id).map((a) => a.id));
  await db.del('workers', id);
  emit();
}

export async function reorderWorkers(orderedIds) {
  const { workers } = await load();
  const map = new Map(workers.map((w) => [w.id, w]));
  const updated = orderedIds.map((id, i) => ({ ...map.get(id), order: i })).filter((w) => w.id);
  await db.putAll('workers', updated);
  emit();
}

/* ---------------- 현장 ---------------- */

export function blankSite(overrides = {}) {
  return {
    id: db.uid(),
    name: '',
    address: '',
    unitPrice: 0,        // 현장 단가 (참고용 · 배정할 때 기본값 후보)
    client: '',          // 원청 / 업체 / 소장님 등
    contact: '',         // 연락처
    startDate: '',
    endDate: '',
    color: SITE_COLORS[0],
    memo: '',
    active: true,
    order: Date.now(),
    createdAt: Date.now(),
    ...overrides,
  };
}

export async function getSites({ includeInactive = true } = {}) {
  const { sites } = await load();
  const list = includeInactive ? sites : sites.filter((s) => s.active !== false);
  return list.slice().sort((a, b) => {
    if ((a.active !== false) !== (b.active !== false)) return a.active === false ? 1 : -1;
    return (a.order || 0) - (b.order || 0);
  });
}

export async function getSite(id) {
  const { sites } = await load();
  return sites.find((s) => s.id === id) || null;
}

export async function saveSite(data) {
  const site = { ...blankSite(), ...data };
  site.name = String(site.name || '').trim();
  if (!site.name) throw new Error('현장 이름을 입력해 주세요.');
  site.unitPrice = num(site.unitPrice);
  site.updatedAt = Date.now();
  await db.put('sites', site);
  emit();
  return site;
}

/** 현장을 지우면 그 현장의 출역 기록도 함께 지워집니다. */
export async function deleteSite(id) {
  const { works } = await load();
  await db.delMany('works', works.filter((w) => w.siteId === id).map((w) => w.id));
  await db.del('sites', id);
  emit();
}

/* ---------------- 출역(배정) ---------------- */

export function blankWork(overrides = {}) {
  const dateKey = overrides.dateKey || todayKey();
  return {
    id: db.uid(),
    dateKey,
    month: dateKey.slice(0, 7),
    siteId: '',
    workerId: '',
    wage: 0,             // 그날 적용한 일당
    gongsu: 1,           // 공수 (0.5 = 반나절)
    carUsed: false,      // 자기 차를 운행했는지
    carPay: 0,           // 차량 수당
    paid: false,         // 지급 완료 체크
    memo: '',
    createdAt: Date.now(),
    ...overrides,
  };
}

/** 출역 1건의 지급액 */
export function workTotal(work) {
  return num(work.wage) * num(work.gongsu) + (work.carUsed ? num(work.carPay) : 0);
}

export function workWagePart(work) {
  return num(work.wage) * num(work.gongsu);
}

export function workCarPart(work) {
  return work.carUsed ? num(work.carPay) : 0;
}

export async function saveWork(data) {
  const work = { ...blankWork(), ...data };
  if (!work.workerId) throw new Error('팀원을 골라 주세요.');
  if (!work.siteId) throw new Error('현장을 골라 주세요.');
  work.month = work.dateKey.slice(0, 7);
  work.wage = num(work.wage);
  work.gongsu = num(work.gongsu) || 1;
  work.carPay = num(work.carPay);
  work.updatedAt = Date.now();
  await db.put('works', work);
  emit();
  return work;
}

/** 한 현장에 여러 명을 한꺼번에 배정합니다. */
export async function saveWorks(list) {
  const rows = list.map((d) => {
    const w = { ...blankWork(), ...d };
    w.month = w.dateKey.slice(0, 7);
    w.wage = num(w.wage);
    w.gongsu = num(w.gongsu) || 1;
    w.carPay = num(w.carPay);
    return w;
  });
  await db.putAll('works', rows);
  emit();
  return rows;
}

export async function deleteWork(id) {
  await db.del('works', id);
  emit();
}

export async function deleteWorks(ids) {
  await db.delMany('works', ids);
  emit();
}

export async function getWork(id) {
  const { works } = await load();
  return works.find((w) => w.id === id) || null;
}

export async function worksOfDate(dateKey) {
  const { works } = await load();
  return works.filter((w) => w.dateKey === dateKey);
}

export async function worksOfMonth(mKey) {
  const { works } = await load();
  return works.filter((w) => w.month === mKey);
}

/** 이미 그날 그 현장에 배정된 팀원인지 */
export async function isAssigned(dateKey, siteId, workerId) {
  const { works } = await load();
  return works.some((w) => w.dateKey === dateKey && w.siteId === siteId && w.workerId === workerId);
}

/**
 * 달력에 점을 찍기 위한 요약.
 * { 'YYYY-MM-DD': { count, total, siteIds:Set } }
 */
export async function monthCalendarSummary(mKey) {
  const works = await worksOfMonth(mKey);
  const map = {};
  for (const w of works) {
    const cell = map[w.dateKey] || (map[w.dateKey] = { count: 0, total: 0, siteIds: [] });
    cell.count += 1;
    cell.total += workTotal(w);
    if (!cell.siteIds.includes(w.siteId)) cell.siteIds.push(w.siteId);
  }
  return map;
}

/* ---------------- 가불 ---------------- */

export function blankAdvance(overrides = {}) {
  const dateKey = overrides.dateKey || todayKey();
  return {
    id: db.uid(),
    workerId: '',
    dateKey,
    month: dateKey.slice(0, 7),
    kind: 'advance',     // 'advance' 가불(선지급) / 'repay' 상환·정산 상계
    amount: 0,
    memo: '',
    createdAt: Date.now(),
    ...overrides,
  };
}

export async function saveAdvance(data) {
  const adv = { ...blankAdvance(), ...data };
  if (!adv.workerId) throw new Error('팀원을 골라 주세요.');
  adv.amount = Math.abs(num(adv.amount));
  if (!adv.amount) throw new Error('금액을 입력해 주세요.');
  adv.month = adv.dateKey.slice(0, 7);
  adv.updatedAt = Date.now();
  await db.put('advances', adv);
  emit();
  return adv;
}

export async function deleteAdvance(id) {
  await db.del('advances', id);
  emit();
}

export async function advancesOf(workerId) {
  const { advances } = await load();
  return advances
    .filter((a) => a.workerId === workerId)
    .sort((a, b) => (a.dateKey < b.dateKey ? 1 : a.dateKey > b.dateKey ? -1 : 0));
}

/** 아직 정산되지 않고 남아 있는 가불 (가불 합계 − 상환 합계) */
export async function advanceBalance(workerId) {
  const list = await advancesOf(workerId);
  return list.reduce((s, a) => s + (a.kind === 'repay' ? -num(a.amount) : num(a.amount)), 0);
}

export async function advanceBalances() {
  const { advances } = await load();
  const map = {};
  for (const a of advances) {
    map[a.workerId] = (map[a.workerId] || 0) + (a.kind === 'repay' ? -num(a.amount) : num(a.amount));
  }
  return map;
}

/* ---------------- 월 정산 ---------------- */

/**
 * 한 달치 정산 표를 만듭니다.
 *
 * byWorker: 팀원별 { days(나간 날 수), gongsu, wagePay, carPay, total,
 *                   advance(그 달 가불), repay, net(실지급), balance(남은 가불) }
 * bySite:   현장별 { days, headcount, total }
 */
export async function monthlyReport(mKey) {
  const { workers, sites } = await load();
  const works = await worksOfMonth(mKey);
  const { advances } = await load();
  const balances = await advanceBalances();

  const byWorker = new Map();
  const ensureWorker = (id) => {
    if (!byWorker.has(id)) {
      const w = workers.find((x) => x.id === id);
      byWorker.set(id, {
        workerId: id,
        name: w ? w.name : '(삭제된 팀원)',
        worker: w || null,
        days: 0, gongsu: 0, wagePay: 0, carPay: 0, carDays: 0, total: 0,
        advance: 0, repay: 0, net: 0,
        balance: balances[id] || 0,
        dates: [],
      });
    }
    return byWorker.get(id);
  };

  const bySite = new Map();
  const ensureSite = (id) => {
    if (!bySite.has(id)) {
      const s = sites.find((x) => x.id === id);
      bySite.set(id, {
        siteId: id,
        name: s ? s.name : '(삭제된 현장)',
        site: s || null,
        days: 0, gongsu: 0, total: 0, workerIds: [], dates: [],
      });
    }
    return bySite.get(id);
  };

  for (const w of works) {
    const row = ensureWorker(w.workerId);
    row.days += 1;
    row.gongsu += num(w.gongsu);
    row.wagePay += workWagePart(w);
    row.carPay += workCarPart(w);
    if (w.carUsed) row.carDays += 1;
    if (!row.dates.includes(w.dateKey)) row.dates.push(w.dateKey);

    const srow = ensureSite(w.siteId);
    srow.days += 1;
    srow.gongsu += num(w.gongsu);
    srow.total += workTotal(w);
    if (!srow.workerIds.includes(w.workerId)) srow.workerIds.push(w.workerId);
    if (!srow.dates.includes(w.dateKey)) srow.dates.push(w.dateKey);
  }

  for (const a of advances) {
    if (a.month !== mKey) continue;
    const row = ensureWorker(a.workerId);
    if (a.kind === 'repay') row.repay += num(a.amount);
    else row.advance += num(a.amount);
  }

  const workerRows = [...byWorker.values()].map((r) => {
    r.total = r.wagePay + r.carPay;
    r.net = r.total - r.advance + r.repay;
    r.dates.sort();
    return r;
  }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'ko'));

  const siteRows = [...bySite.values()].map((r) => {
    r.headcount = r.workerIds.length;
    r.dates.sort();
    return r;
  }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'ko'));

  const totals = workerRows.reduce((t, r) => ({
    days: t.days + r.days,
    gongsu: t.gongsu + r.gongsu,
    wagePay: t.wagePay + r.wagePay,
    carPay: t.carPay + r.carPay,
    total: t.total + r.total,
    advance: t.advance + r.advance,
    repay: t.repay + r.repay,
    net: t.net + r.net,
  }), { days: 0, gongsu: 0, wagePay: 0, carPay: 0, total: 0, advance: 0, repay: 0, net: 0 });

  totals.workerCount = workerRows.length;
  totals.siteCount = siteRows.length;
  totals.workDays = new Set(works.map((w) => w.dateKey)).size;

  return { month: mKey, byWorker: workerRows, bySite: siteRows, totals, works };
}

/** 이번 달 팀원별 출역 횟수만 빠르게 (팀원 목록에 표시) */
export async function monthCounts(mKey) {
  const works = await worksOfMonth(mKey);
  const map = {};
  for (const w of works) {
    const row = map[w.workerId] || (map[w.workerId] = { days: 0, gongsu: 0, total: 0 });
    row.days += 1;
    row.gongsu += num(w.gongsu);
    row.total += workTotal(w);
  }
  return map;
}

/** 현장별 이번 달 투입 요약 */
export async function siteCounts(mKey) {
  const works = await worksOfMonth(mKey);
  const map = {};
  for (const w of works) {
    const row = map[w.siteId] || (map[w.siteId] = { days: 0, total: 0, workerIds: [] });
    row.days += 1;
    row.total += workTotal(w);
    if (!row.workerIds.includes(w.workerId)) row.workerIds.push(w.workerId);
  }
  return map;
}

/** 최근 활동이 있었던 달 목록 (정산 화면의 월 선택용) */
export async function activeMonths() {
  const { works, advances } = await load();
  const set = new Set([...works.map((w) => w.month), ...advances.map((a) => a.month)]);
  set.add(monthKey());
  return [...set].filter(Boolean).sort().reverse();
}

/* ---------------- 백업 / 복원 ---------------- */

export const BACKUP_VERSION = 1;

export async function exportBackup() {
  const { workers, sites, works, advances } = await load();
  return {
    app: 'hyunjang',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    workers, sites, works, advances,
  };
}

/**
 * mode: 'merge' 같은 id는 덮어쓰고 나머지는 추가 / 'replace' 전부 지우고 넣기
 */
export async function importBackup(data, mode = 'merge') {
  if (!data || data.app !== 'hyunjang') throw new Error('이 앱의 백업 파일이 아닙니다.');
  if (mode === 'replace') {
    await Promise.all(['workers', 'sites', 'works', 'advances'].map((s) => db.clearStore(s)));
  }
  const fix = (row, extra = {}) => ({ ...row, ...extra });
  await db.putAll('workers', (data.workers || []).map((r) => fix(r)));
  await db.putAll('sites', (data.sites || []).map((r) => fix(r)));
  await db.putAll('works', (data.works || []).map((r) => fix(r, { month: (r.dateKey || '').slice(0, 7) })));
  await db.putAll('advances', (data.advances || []).map((r) => fix(r, { month: (r.dateKey || '').slice(0, 7) })));
  emit();
  return {
    workers: (data.workers || []).length,
    sites: (data.sites || []).length,
    works: (data.works || []).length,
    advances: (data.advances || []).length,
  };
}

export async function wipeAll() {
  await Promise.all(['workers', 'sites', 'works', 'advances'].map((s) => db.clearStore(s)));
  emit();
}

export { daysOfMonth };
