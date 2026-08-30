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

export async function forMonth(monthKey) {
  const rows = await getAll();
  return rows
    .filter((r) => monthKeyOf(r.date) === monthKey)
    .sort((a, b) => (a.date === b.date
      ? (b.createdAt || 0) - (a.createdAt || 0)
      : (a.date < b.date ? 1 : -1)));
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
 */
export async function summary(monthKey = thisMonthKey()) {
  const rows = await getAll();
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
export async function byCategory(monthKey) {
  const rows = (await forMonth(monthKey)).filter((r) => r.type !== 'income');
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
  prepaid: {},          // { '2026-08': true } — 회차 키는 마감월
};

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

/** 그 회차의 신용카드 사용액 */
export async function cycleAmount(cycle) {
  const rows = await getAll();
  return rows
    .filter((r) => r.type !== 'income' && r.method === 'credit')
    .filter((r) => r.date >= cycle.start && r.date <= cycle.end)
    .reduce((t, r) => t + (Number(r.amount) || 0), 0);
}

/** 화면에 뿌릴 현재 회차 요약 */
export async function cardStatus() {
  const settings = await getCardSettings();
  const cycle = cycleOf(currentCycleKey(settings), settings);
  const amount = await cycleAmount(cycle);
  const prevKey = shiftMonthKey(cycle.key, -1);
  const prevCycle = cycleOf(prevKey, settings);
  return {
    settings,
    cycle,
    amount,
    prev: { ...prevCycle, amount: await cycleAmount(prevCycle) },
  };
}

export async function togglePrepaid(cycleKey) {
  const settings = await getCardSettings();
  const prepaid = { ...settings.prepaid };
  if (prepaid[cycleKey]) delete prepaid[cycleKey];
  else prepaid[cycleKey] = true;
  return setCardSettings({ prepaid });
}

/** '8월 1일 ~ 8월 31일' */
export function formatCycleRange(cycle) {
  return `${formatDate(cycle.start)} ~ ${formatDate(cycle.end)}`.replace(/ \([월화수목금토일]\)/g, '');
}

export function closingLabel(day) {
  return Number(day) === 0 ? '말일' : `${day}일`;
}
