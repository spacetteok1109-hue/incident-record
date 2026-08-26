/* util.js — 날짜/문자열 유틸리티 */

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

/** 'YYYY-MM-DD' + 'HH:MM' -> epoch ms. 시간이 없으면 그날 00:00 */
export function toTimestamp(dateKey, timeStr) {
  const d = fromDateKey(dateKey);
  if (!d) return null;
  if (timeStr) {
    const m = timeStr.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      d.setHours(Number(m[1]), Number(m[2]), 0, 0);
      return d.getTime();
    }
  }
  return d.getTime();
}

export function addDays(date, n) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + n);
  return d;
}

export function addMonths(date, n) {
  const d = new Date(date.getTime());
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  // 31일 -> 2월처럼 날짜가 넘칠 때는 해당 월의 마지막 날로 맞춥니다.
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d;
}

/** 두 날짜의 '일' 차이 (b - a), 시각은 무시 */
export function diffDays(aKey, bKey) {
  const a = fromDateKey(aKey);
  const b = fromDateKey(bKey);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/**
 * 디데이 표기.
 * 목표일이 오늘이면 'D-DAY', 미래면 'D-n', 과거면 'D+n'.
 */
export function ddayLabel(targetKey, baseKey = todayKey()) {
  const d = diffDays(baseKey, targetKey);
  if (d === null) return '';
  if (d === 0) return 'D-DAY';
  return d > 0 ? `D-${d}` : `D+${Math.abs(d)}`;
}

/** '8월 26일 (화)' 형태 */
export function formatDate(dateKey, opts = {}) {
  const d = fromDateKey(dateKey);
  if (!d) return '';
  const y = opts.withYear ? `${d.getFullYear()}년 ` : '';
  return `${y}${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`;
}

/** '오후 3:05' */
export function formatTime(timeStr) {
  if (!timeStr) return '';
  const m = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return '';
  const h = Number(m[1]);
  const ampm = h < 12 ? '오전' : '오후';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${ampm} ${h12}:${m[2]}`;
}

/** '오늘', '내일', '어제', 그 외에는 날짜 */
export function relativeDateLabel(dateKey) {
  const d = diffDays(todayKey(), dateKey);
  if (d === 0) return '오늘';
  if (d === 1) return '내일';
  if (d === 2) return '모레';
  if (d === -1) return '어제';
  return formatDate(dateKey);
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

/** 반복 규칙에 따른 다음 날짜 키 */
export function nextRepeatDate(dateKey, repeat) {
  const d = fromDateKey(dateKey);
  if (!d || !repeat || repeat === 'none') return null;
  if (repeat === 'daily') return toDateKey(addDays(d, 1));
  if (repeat === 'weekday') {
    let n = addDays(d, 1);
    while (n.getDay() === 0 || n.getDay() === 6) n = addDays(n, 1);
    return toDateKey(n);
  }
  if (repeat === 'weekly') return toDateKey(addDays(d, 7));
  if (repeat === 'monthly') return toDateKey(addMonths(d, 1));
  if (repeat === 'yearly') return toDateKey(addMonths(d, 12));
  return null;
}

/** 'YYYY-MM-DD' 에서 n일 뒤의 날짜 키 */
export function addDaysKey(dateKey, n) {
  const d = fromDateKey(dateKey);
  if (!d) return null;
  return toDateKey(addDays(d, n));
}

/**
 * 두 날짜 사이의 총 일수 (양 끝을 모두 셈).
 * 8월 1일 ~ 8월 3일 이면 3일입니다.
 */
export function daysInclusive(startKey, endKey) {
  const d = diffDays(startKey, endKey);
  return d === null ? null : d + 1;
}

/** 총 일수로 마감일을 계산합니다. 시작일 포함이라 하루를 뺍니다. */
export function endDateFromDuration(startKey, days) {
  const n = Number(days);
  if (!startKey || !Number.isFinite(n) || n < 1) return null;
  return addDaysKey(startKey, Math.round(n) - 1);
}

/**
 * '8월 26일 (수) → 9월 4일 (금)' 형태의 기간 표기.
 * 두 날짜의 해가 다를 때만 연도를 붙입니다.
 */
export function formatRange(startKey, endKey) {
  if (!startKey || !endKey) return '';
  const crossYear = startKey.slice(0, 4) !== endKey.slice(0, 4);
  return `${formatDate(startKey, { withYear: crossYear })} → ${formatDate(endKey, { withYear: crossYear })}`;
}

/**
 * 기간의 진행 상황.
 * phase: 'before' 시작 전 / 'during' 진행 중 / 'after' 종료됨
 */
export function periodProgress(startKey, endKey, baseKey = todayKey()) {
  const total = daysInclusive(startKey, endKey);
  if (total === null || total < 1) return null;
  const elapsed = diffDays(startKey, baseKey) + 1; // 시작일 당일이 1일째
  if (elapsed < 1) {
    return { total, phase: 'before', elapsed: 0, remaining: total, untilStart: 1 - elapsed, percent: 0 };
  }
  if (elapsed > total) {
    return { total, phase: 'after', elapsed: total, remaining: 0, sinceEnd: elapsed - total, percent: 100 };
  }
  return { total, phase: 'during', elapsed, remaining: total - elapsed, percent: Math.round((elapsed / total) * 100) };
}

export const REPEAT_LABELS = {
  none: '반복 안 함',
  daily: '매일',
  weekday: '주중(월~금)',
  weekly: '매주',
  monthly: '매월',
  yearly: '매년',
};

export const REMIND_OPTIONS = [
  { value: '', label: '알림 없음' },
  { value: '0', label: '정시에' },
  { value: '5', label: '5분 전' },
  { value: '10', label: '10분 전' },
  { value: '30', label: '30분 전' },
  { value: '60', label: '1시간 전' },
  { value: '180', label: '3시간 전' },
  { value: '1440', label: '1일 전' },
  { value: '2880', label: '2일 전' },
  { value: '10080', label: '1주일 전' },
];

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

/** XSS 방지를 위해 HTML에 넣기 전 이스케이프 */
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
