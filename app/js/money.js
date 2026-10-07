/* money.js — 가계부
 *
 * 금액은 원 단위 정수로만 저장합니다(소수점 없음).
 * 다른 데이터와 마찬가지로 기기 안에만 저장됩니다.
 */

import * as db from './db.js';
import { notifyChanged } from './store.js';
import { todayKey, formatDate, addDaysKey, diffDays } from './util.js';

export const METHODS = [
  { value: 'credit', label: '신용카드', short: '신용' },
  { value: 'debit', label: '체크카드', short: '체크' },
  { value: 'cash', label: '현금', short: '현금' },
  { value: 'transfer', label: '계좌이체', short: '이체' },
];

export const EXPENSE_CATEGORIES = [
  { value: 'food', label: '식비', emoji: '🍚' },
  { value: 'cafe', label: '카페·간식', emoji: '☕' },
  { value: 'transport', label: '교통', emoji: '🚌' },
  { value: 'living', label: '생활', emoji: '🏠' },
  { value: 'shopping', label: '쇼핑', emoji: '🛍️' },
  { value: 'health', label: '의료·건강', emoji: '💊' },
  { value: 'culture', label: '문화·여가', emoji: '🎬' },
  { value: 'social', label: '경조사', emoji: '🎁' },
  { value: 'bill', label: '통신·공과금', emoji: '📱' },
  { value: 'etc', label: '기타', emoji: '📦' },
];

export const INCOME_CATEGORIES = [
  { value: 'salary', label: '급여', emoji: '💰' },
  { value: 'allowance', label: '용돈', emoji: '🧧' },
  { value: 'refund', label: '환급·환불', emoji: '↩️' },
  { value: 'etcIncome', label: '기타 수입', emoji: '➕' },
];

export function categoriesFor(type) {
  return type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
}

export function categoryInfo(value, type) {
  const list = categoriesFor(type);
  return list.find((c) => c.value === value) || list[list.length - 1];
}

export function methodInfo(value) {
  return METHODS.find((m) => m.value === value) || METHODS[0];
}

/* ---------------- 금액 ---------------- */

const WON = new Intl.NumberFormat('ko-KR');

/** 12500 -> '12,500원' */
export function formatWon(n, { sign = false } = {}) {
  const v = Math.round(Number(n) || 0);
  const body = `${WON.format(Math.abs(v))}원`;
  if (!sign) return body;
  if (v === 0) return body;
  return (v > 0 ? '+' : '−') + body;
}

/** '12,500' 처럼 입력해도 숫자로 읽습니다. */
export function parseAmount(text) {
  const digits = String(text == null ? '' : text).replace(/[^0-9]/g, '');
  if (!digits) return 0;
  return Math.min(Number(digits), 999999999999);
}

/* ---------------- 항목 ---------------- */

export function blankExpense(overrides = {}) {
  return {
    id: null,
    date: todayKey(),
    type: 'expense',
    amount: 0,
    method: 'credit',
    category: 'food',
    memo: '',
    installment: 1,       // 1 = 일시불, 2 이상 = N개월 할부
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

export async function getAll() {
  return db.getAll('expenses');
}

export async function get(id) {
  return db.get('expenses', id);
}

export async function save(data) {
  const now = Date.now();
  const row = {
    ...blankExpense(),
    ...data,
    id: data.id || db.uid(),
    amount: Math.round(Number(data.amount) || 0),
    createdAt: data.createdAt || now,
    updatedAt: now,
  };
  // 수입에는 카드 결제수단이 의미가 없으므로 정리합니다.
  if (row.type === 'income' && (row.method === 'credit' || row.method === 'debit')) {
    row.method = 'transfer';
  }
  // 할부는 신용카드 지출에서만 의미가 있습니다.
  row.installment = installmentCount(row);
  await db.put('expenses', row);
  notifyChanged();
  return row;
}

export async function remove(id) {
  await db.del('expenses', id);
  notifyChanged();
}

/* ---------------- 조회 ---------------- */

/** 'YYYY-MM' */
export function monthKeyOf(dateKey) {
  return (dateKey || '').slice(0, 7);
}

export function thisMonthKey() {
  return monthKeyOf(todayKey());
}

/** 'YYYY-MM' 에서 n개월 이동 */
export function shiftMonthKey(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function formatMonth(key) {
  const [y, m] = key.split('-').map(Number);
  return `${y}년 ${m}월`;
}

/** 'all'(또는 빈 값)이면 전부, 아니면 그 결제수단만 통과시킵니다. */
export function matchesMethod(row, method) {
  return !method || method === 'all' || row.method === method;
}

export async function forMonth(monthKey, { method = 'all' } = {}) {
  const rows = await getAll();
  return rows
    .filter((r) => monthKeyOf(r.date) === monthKey && matchesMethod(r, method))
    .sort((a, b) => (a.date === b.date
      ? (b.createdAt || 0) - (a.createdAt || 0)
      : (a.date < b.date ? 1 : -1)));
}

/**
 * 그 달의 결제수단별 지출 합계. all 은 전체 합계입니다.
 * 수단을 골라 보는 칩에 그대로 씁니다.
 */
export async function methodTotals(monthKey) {
  const rows = (await getAll())
    .filter((r) => monthKeyOf(r.date) === monthKey && r.type !== 'income');
  const out = { all: 0 };
  for (const m of METHODS) out[m.value] = 0;
  for (const r of rows) {
    const n = Math.round(Number(r.amount) || 0);
    out.all += n;
    if (out[r.method] !== undefined) out[r.method] += n;
  }
  return out;
}

export async function forDate(dateKey) {
  const rows = await getAll();
  return rows
    .filter((r) => r.date === dateKey)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/** 날짜별로 묶어 [{date, rows, spent, earned}] 로 돌려줍니다. */
export function groupByDate(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.date)) map.set(r.date, []);
    map.get(r.date).push(r);
  }
  return [...map.entries()].map(([date, list]) => ({
    date,
    label: formatDate(date),
    rows: list,
    spent: sum(list.filter((r) => r.type !== 'income')),
    earned: sum(list.filter((r) => r.type === 'income')),
  }));
}

function sum(rows) {
  return rows.reduce((t, r) => t + (Number(r.amount) || 0), 0);
}

/**
 * 화면 위쪽 요약.
 *  today  — 오늘 쓴 돈
 *  month  — 이번(선택한) 달에 쓴 돈
 *  credit — 그 달 신용카드 사용액
 *  income — 그 달 수입
 * method 를 주면 그 결제수단만 세어 줍니다.
 */
export async function summary(monthKey = thisMonthKey(), { method = 'all' } = {}) {
  const rows = (await getAll()).filter((r) => matchesMethod(r, method));
  const today = todayKey();
  const inMonth = rows.filter((r) => monthKeyOf(r.date) === monthKey);
  const spend = inMonth.filter((r) => r.type !== 'income');

  return {
    today: sum(rows.filter((r) => r.date === today && r.type !== 'income')),
    todayCount: rows.filter((r) => r.date === today && r.type !== 'income').length,
    month: sum(spend),
    credit: sum(spend.filter((r) => r.method === 'credit')),
    debit: sum(spend.filter((r) => r.method === 'debit')),
    cash: sum(spend.filter((r) => r.method === 'cash')),
    income: sum(inMonth.filter((r) => r.type === 'income')),
    count: inMonth.length,
  };
}

/** 그 달의 분류별 지출 (많은 순) */
export async function byCategory(monthKey, { method = 'all' } = {}) {
  const rows = (await forMonth(monthKey, { method })).filter((r) => r.type !== 'income');
  const map = new Map();
  for (const r of rows) {
    map.set(r.category, (map.get(r.category) || 0) + (Number(r.amount) || 0));
  }
  const total = sum(rows);
  return [...map.entries()]
    .map(([category, amount]) => ({
      category,
      amount,
      percent: total ? Math.round((amount / total) * 100) : 0,
      info: categoryInfo(category, 'expense'),
    }))
    .sort((a, b) => b.amount - a.amount);
}

/** 기록이 있는 달 목록 (최근 순) */
export async function monthsWithData() {
  const rows = await getAll();
  const set = new Set(rows.map((r) => monthKeyOf(r.date)));
  set.add(thisMonthKey());
  return [...set].sort().reverse();
}


/* ==========================================================
   할부
   ==========================================================
   할부로 산 것은 가계부에는 '산 날 · 전체 금액' 으로 한 번만 적고,
   카드 청구서에는 그 금액을 개월 수로 나눠 매달 한 번씩 올립니다.
   나누어 떨어지지 않는 나머지는 첫 달에 붙입니다(카드사 관행).
*/

export const INSTALLMENT_MONTHS = [2, 3, 4, 5, 6, 9, 10, 12, 18, 24, 36];

/** 그 내역의 할부 개월 수. 신용카드 지출이 아니면 언제나 1(일시불). */
export function installmentCount(row) {
  if (!row || row.type === 'income' || row.method !== 'credit') return 1;
  const n = Math.round(Number(row.installment) || 1);
  if (!Number.isFinite(n) || n < 2) return 1;
  return Math.min(n, 36);
}

/** n개월 할부에서 i번째(0부터) 달에 빠져나갈 금액. */
export function installmentShare(amount, n, i) {
  const total = Math.round(Number(amount) || 0);
  const months = Math.max(1, Math.round(Number(n) || 1));
  if (i < 0 || i >= months) return 0;
  if (months === 1) return total;
  const base = Math.floor(total / months);
  // 나머지는 첫 달에 몰아 줍니다.
  return i === 0 ? total - base * (months - 1) : base;
}

/** 0번째부터 i번째 달까지 이미 나간 금액 */
function paidThrough(amount, n, i) {
  let t = 0;
  for (let k = 0; k <= i; k += 1) t += installmentShare(amount, n, k);
  return t;
}

/** '6개월 할부 · 매달 16,667원' 처럼 */
export function installmentLabel(amount, n) {
  const months = Math.max(1, Math.round(Number(n) || 1));
  if (months < 2) return '일시불';
  const first = installmentShare(amount, months, 0);
  const rest = installmentShare(amount, months, 1);
  if (!amount) return `${months}개월 할부`;
  if (first === rest) return `${months}개월 할부 · 매달 ${formatWon(rest)}`;
  return `${months}개월 할부 · 첫 달 ${formatWon(first)}, 이후 ${formatWon(rest)}`;
}

/* ==========================================================
   신용카드 결제 주기
   ==========================================================
   합산 마감일(closingDay)까지의 사용액이 한 회차가 되고,
   그 다음 결제일(paymentDay)에 빠져나갑니다.
   예) 마감 말일 · 결제 다음 달 25일  →  8월 1~31일 사용분을 9월 25일에 결제
       마감 14일  · 결제 다음 달 1일  →  7월 15일~8월 14일 사용분을 9월 1일에 결제
   선납은 회차별로 표시해 둡니다(어느 회차를 미리 냈는지).
*/

export const DEFAULT_CARD = {
  closingDay: 0,        // 0 = 말일
  paymentDay: 25,
  paymentNextMonth: true,
  // 회차별로 미리 낸 금액. 키는 마감월, 값은 원 단위 금액.
  // 예전 자료에 남아 있는 true 는 '전액' 으로 읽습니다.
  prepaid: {},          // { '2026-08': 150000 }
};

/**
 * 자주 쓰는 합산·결제 조합. 한 번 누르면 아래 항목이 한꺼번에 채워집니다.
 * 마감일이 5일이면 회차는 '지난달 6일 ~ 이번달 5일'이 됩니다.
 */
export const CARD_PRESETS = [
  { label: '6일~다음 달 5일 · 18일 결제', closingDay: 5, paymentNextMonth: false, paymentDay: 18 },
];

export async function getCardSettings() {
  const saved = await db.getMeta('cardSettings', null);
  return { ...DEFAULT_CARD, ...(saved || {}), prepaid: { ...(saved?.prepaid || {}) } };
}

export async function setCardSettings(patch) {
  const cur = await getCardSettings();
  const next = { ...cur, ...patch };
  await db.setMeta('cardSettings', next);
  notifyChanged();
  return next;
}

function lastDayOf(year, month /* 1-based */) {
  return new Date(year, month, 0).getDate();
}

function dateKey(year, month, day) {
  const last = lastDayOf(year, month);
  const d = Math.min(day <= 0 ? last : day, last);
  return `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * 마감월(cycleKey, 'YYYY-MM')의 결제 회차 정보.
 * 합산 기간의 시작·끝, 결제일, 남은 날짜를 돌려줍니다.
 */
export function cycleOf(cycleKey, settings = DEFAULT_CARD) {
  const [y, m] = cycleKey.split('-').map(Number);
  const closing = Number(settings.closingDay) || 0;

  const end = dateKey(y, m, closing);
  // 지난달 마감 다음 날부터 이번 마감일까지
  const prev = new Date(y, m - 2, 1);
  const prevEnd = dateKey(prev.getFullYear(), prev.getMonth() + 1, closing);
  const start = addDaysKey(prevEnd, 1);

  const payMonth = new Date(y, m - 1 + (settings.paymentNextMonth ? 1 : 0), 1);
  const payDate = dateKey(payMonth.getFullYear(), payMonth.getMonth() + 1, Number(settings.paymentDay) || 25);

  return {
    key: cycleKey,
    start,
    end,
    payDate,
    daysLeft: diffDays(todayKey(), payDate),
    // 선납 기록이 있는지 여부. 얼마인지는 prepaidAmount() 로 봅니다.
    prepaid: !!settings.prepaid?.[cycleKey],
  };
}

/** 오늘이 속한 마감 회차의 키('YYYY-MM') */
export function currentCycleKey(settings = DEFAULT_CARD) {
  const today = todayKey();
  const [y, m] = today.split('-').map(Number);
  const thisCycle = cycleOf(`${y}-${String(m).padStart(2, '0')}`, settings);
  // 이미 마감이 지났으면 다음 회차입니다.
  if (today > thisCycle.end) {
    const n = new Date(y, m, 1);
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
  }
  return thisCycle.key;
}

/** 그 날짜에 쓴 돈이 청구되는 회차 키('YYYY-MM') */
export function cycleKeyForDate(dateKey, settings = DEFAULT_CARD) {
  const [y, m] = dateKey.split('-').map(Number);
  const c = cycleOf(`${y}-${String(m).padStart(2, '0')}`, settings);
  if (dateKey > c.end) return shiftMonthKey(c.key, 1);
  if (dateKey < c.start) return shiftMonthKey(c.key, -1);
  return c.key;
}

/** 'YYYY-MM' 두 개 사이의 개월 차 */
function monthsBetweenKeys(from, to) {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

/**
 * 그 회차에 실제로 빠져나갈 금액을 뜯어 봅니다.
 *  lump        — 이번 회차에 쓴 일시불 합계
 *  installment — 이번 달에 걸린 할부금 합계
 *  plans       — 이번 달에 걸린 할부 건별 내역
 */
export async function cycleBreakdown(cycle, settings = DEFAULT_CARD) {
  const rows = (await getAll()).filter((r) => r.type !== 'income' && r.method === 'credit');
  let lump = 0;
  const plans = [];

  for (const r of rows) {
    const months = installmentCount(r);
    if (months < 2) {
      if (r.date >= cycle.start && r.date <= cycle.end) lump += Math.round(Number(r.amount) || 0);
      continue;
    }
    const i = monthsBetweenKeys(cycleKeyForDate(r.date, settings), cycle.key);
    if (i < 0 || i >= months) continue;
    const due = installmentShare(r.amount, months, i);
    plans.push({
      row: r,
      months,
      index: i + 1,                                        // 사람이 세는 회차(1부터)
      due,
      left: months - (i + 1),                              // 이번 것 빼고 남은 횟수
      remaining: Math.round(Number(r.amount) || 0) - paidThrough(r.amount, months, i),
    });
  }

  plans.sort((a, b) => b.due - a.due);
  const installment = plans.reduce((t, p) => t + p.due, 0);
  return { lump, installment, plans, total: lump + installment };
}

/** 그 회차의 청구액 (일시불 + 이번 달 할부금) */
export async function cycleAmount(cycle, settings = DEFAULT_CARD) {
  return (await cycleBreakdown(cycle, settings)).total;
}

/** 아직 다 내지 않은 할부 잔액 (이번 회차분 포함) */
export async function installmentOutstanding(settings = DEFAULT_CARD) {
  const rows = (await getAll()).filter((r) => r.type !== 'income' && r.method === 'credit');
  const curKey = currentCycleKey(settings);
  let total = 0;
  let count = 0;
  for (const r of rows) {
    const months = installmentCount(r);
    if (months < 2) continue;
    const i = monthsBetweenKeys(cycleKeyForDate(r.date, settings), curKey);
    if (i >= months) continue;                                  // 이미 다 냈습니다
    const paid = i <= 0 ? 0 : paidThrough(r.amount, months, i - 1);
    total += Math.round(Number(r.amount) || 0) - paid;
    count += 1;
  }
  return { total, count };
}

/** 그 회차에 미리 낸 금액. 예전 자료의 true 는 '전액' 으로 읽습니다. */
export function prepaidAmount(cycleKey, settings = DEFAULT_CARD, cycleTotal = 0) {
  const v = settings?.prepaid?.[cycleKey];
  if (v === true) return Math.round(Number(cycleTotal) || 0);
  const n = Math.round(Number(v) || 0);
  return n > 0 ? n : 0;
}

/** 화면에 뿌릴 현재 회차 요약 */
export async function cardStatus() {
  const settings = await getCardSettings();
  const cycle = cycleOf(currentCycleKey(settings), settings);
  const bd = await cycleBreakdown(cycle, settings);
  const prepaid = prepaidAmount(cycle.key, settings, bd.total);

  const prevCycle = cycleOf(shiftMonthKey(cycle.key, -1), settings);
  const prevBd = await cycleBreakdown(prevCycle, settings);

  return {
    settings,
    cycle,
    amount: bd.total,
    lump: bd.lump,
    installment: bd.installment,
    plans: bd.plans,
    prepaid,
    due: Math.max(0, bd.total - prepaid),
    // 선납이 청구액보다 많으면 다음 달로 넘어갈 몫입니다.
    over: Math.max(0, prepaid - bd.total),
    prev: {
      ...prevCycle,
      amount: prevBd.total,
      prepaid: prepaidAmount(prevCycle.key, settings, prevBd.total),
    },
  };
}

/** 그 회차에 미리 낸 금액을 적어 둡니다. 0 이면 기록을 지웁니다. */
export async function setPrepaid(cycleKey, amount) {
  const settings = await getCardSettings();
  const prepaid = { ...settings.prepaid };
  const n = Math.round(Number(amount) || 0);
  if (n > 0) prepaid[cycleKey] = n;
  else delete prepaid[cycleKey];
  return setCardSettings({ prepaid });
}

/** 선납 기록을 켜고 끕니다. 금액을 주면 그만큼, 안 주면 '전액' 으로 둡니다. */
export async function togglePrepaid(cycleKey, fullAmount) {
  const settings = await getCardSettings();
  if (settings.prepaid?.[cycleKey]) return setPrepaid(cycleKey, 0);
  if (fullAmount != null) return setPrepaid(cycleKey, fullAmount);
  // 금액을 모르면 '전액' 표시만 남깁니다. 청구액이 바뀌면 따라갑니다.
  return setCardSettings({ prepaid: { ...settings.prepaid, [cycleKey]: true } });
}

/** '8월 1일 ~ 8월 31일' */
export function formatCycleRange(cycle) {
  return `${formatDate(cycle.start)} ~ ${formatDate(cycle.end)}`.replace(/ \([월화수목금토일]\)/g, '');
}

export function closingLabel(day) {
  return Number(day) === 0 ? '말일' : `${day}일`;
}
