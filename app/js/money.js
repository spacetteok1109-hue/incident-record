/* money.js — 가계부
 *
 * 금액은 원 단위 정수로만 저장합니다(소수점 없음).
 * 다른 데이터와 마찬가지로 기기 안에만 저장됩니다.
 */

import * as db from './db.js';
import { notifyChanged } from './store.js';
import { todayKey, formatDate } from './util.js';

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
