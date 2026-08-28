/* util.js — 날짜 · 금액 유틸리티 */

export const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

export function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Date -> 'YYYY-MM-DD' (로컬 시간 기준) */
export function toDateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 'YYYY-MM-DD' -> Date (로컬 자정). 잘못된 값이면 null */
export function fromDateKey(key) {
  if (!key || typeof key !== 'string') return null;
  const m = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function todayKey() {
  return toDateKey(new Date());
}

/** 'YYYY-MM' (그 달을 가리키는 키) */
export function monthKey(dateKeyOrDate = new Date()) {
  if (typeof dateKeyOrDate === 'string') return dateKeyOrDate.slice(0, 7);
  return toDateKey(dateKeyOrDate).slice(0, 7);
}

export function addDays(date, n) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + n);
  return d;
}

export function addMonths(date, n) {
  const d = new Date(date.getTime());
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  return d;
}

/** 'YYYY-MM' 에서 n달 뒤의 월 키 */
export function shiftMonthKey(mKey, n) {
  const [y, m] = mKey.split('-').map(Number);
  const d = addMonths(new Date(y, m - 1, 1), n);
  return monthKey(d);
}

/** '2026년 8월' */
export function formatMonth(mKey) {
  const [y, m] = mKey.split('-').map(Number);
  return `${y}년 ${m}월`;
}

/** '8월 26일 (화)' */
export function formatDate(dateKey, opts = {}) {
  const d = fromDateKey(dateKey);
  if (!d) return '';
  const y = opts.withYear ? `${d.getFullYear()}년 ` : '';
  return `${y}${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`;
}

/** '8/26 (화)' — 좁은 자리용 */
export function formatDateShort(dateKey) {
  const d = fromDateKey(dateKey);
  if (!d) return '';
  return `${d.getMonth() + 1}/${d.getDate()} (${WEEKDAYS[d.getDay()]})`;
}

export function diffDays(aKey, bKey) {
  const a = fromDateKey(aKey);
  const b = fromDateKey(bKey);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

export function relativeDateLabel(dateKey) {
  const d = diffDays(todayKey(), dateKey);
  if (d === 0) return '오늘';
  if (d === 1) return '내일';
  if (d === -1) return '어제';
  return formatDate(dateKey);
}

/**
 * '오늘' · '내일' · '어제' 만 돌려주고, 그 밖의 날짜는 빈 문자열입니다.
 * 날짜를 이미 적어 둔 옆에 덧붙일 때 씁니다.
 */
export function relativeTag(dateKey) {
  const label = relativeDateLabel(dateKey);
  return label === formatDate(dateKey) ? '' : label;
}

/** 달력 그리드에 필요한 42칸(6주)의 날짜 배열 */
export function monthGrid(year, month /* 0-based */) {
  const first = new Date(year, month, 1);
  const start = addDays(first, -first.getDay());
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    cells.push({
      date: d,
      key: toDateKey(d),
      inMonth: d.getMonth() === month,
      isToday: toDateKey(d) === todayKey(),
    });
  }
  return cells;
}

/** 그 달의 모든 날짜 키 */
export function daysOfMonth(mKey) {
  const [y, m] = mKey.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  const out = [];
  for (let i = 1; i <= last; i++) out.push(`${mKey}-${pad2(i)}`);
  return out;
}

/* ---------------- 금액 ---------------- */

/** 숫자로 정리. 빈 값이나 이상한 값은 0 */
export function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** 1200000 -> '1,200,000' */
export function comma(v) {
  return Math.round(num(v)).toLocaleString('ko-KR');
}

/** 1200000 -> '1,200,000원' */
export function won(v) {
  return `${comma(v)}원`;
}

/**
 * 1200000 -> '120만', 1250000 -> '125만', 13500 -> '1.4만'
 * 합계처럼 자리가 좁을 때 씁니다.
 */
export function manwon(v) {
  const n = num(v);
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs < 10000) return comma(n);
  const man = n / 10000;
  const s = abs >= 100000 ? String(Math.round(man)) : man.toFixed(1).replace(/\.0$/, '');
  return `${s}만`;
}

/** 공수 표기: 1 -> '1', 0.5 -> '0.5' */
export function gongsu(v) {
  const n = num(v);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function bytesToText(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** XSS 방지 */
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** 계좌번호를 뒤 4자리만 남기고 가립니다. */
export function maskAccount(acct) {
  const s = String(acct || '').trim();
  if (s.length <= 4) return s;
  const tail = s.slice(-4);
  return `${'•'.repeat(Math.min(s.replace(/\D/g, '').length - 4, 8))}${tail}`;
}
