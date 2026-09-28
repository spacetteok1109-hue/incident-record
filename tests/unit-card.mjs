/* 카드 결제 주기 · 할부 · 선납 — 순수 계산 검사 (브라우저 없이 돕니다) */
import {
  cycleOf, currentCycleKey, cycleKeyForDate, formatCycleRange, closingLabel,
  installmentCount, installmentShare, installmentLabel, prepaidAmount,
  CARD_PRESETS, INSTALLMENT_MONTHS,
} from '../app/js/money.js';

let fail = 0;
const eq = (n, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.log(`  ✗ ${n}\n     got  ${g}\n     want ${w}`); fail += 1; }
  else console.log(`  ✓ ${n}`);
};
const pick = (c) => ({ start: c.start, end: c.end, pay: c.payDate });

/* ---------------- 합산 기간 ---------------- */

const A = { closingDay: 0, paymentDay: 25, paymentNextMonth: true, prepaid: {} };
eq('말일마감: 8월 회차', pick(cycleOf('2026-08', A)), { start: '2026-08-01', end: '2026-08-31', pay: '2026-09-25' });
eq('말일마감: 2월(28일)', pick(cycleOf('2026-02', A)), { start: '2026-02-01', end: '2026-02-28', pay: '2026-03-25' });
eq('말일마감: 윤년 2월(29일)', pick(cycleOf('2028-02', A)), { start: '2028-02-01', end: '2028-02-29', pay: '2028-03-25' });
eq('말일마감: 12월 → 다음 해 결제', pick(cycleOf('2026-12', A)), { start: '2026-12-01', end: '2026-12-31', pay: '2027-01-25' });

const B = { closingDay: 14, paymentDay: 1, paymentNextMonth: true, prepaid: {} };
eq('14일마감: 8월 회차', pick(cycleOf('2026-08', B)), { start: '2026-07-15', end: '2026-08-14', pay: '2026-09-01' });
eq('14일마감: 연초', pick(cycleOf('2026-01', B)), { start: '2025-12-15', end: '2026-01-14', pay: '2026-02-01' });

const C = { closingDay: 31, paymentDay: 10, paymentNextMonth: true, prepaid: {} };
eq('31일마감이 2월이면 28일', cycleOf('2026-02', C).end, '2026-02-28');

const D = { closingDay: 20, paymentDay: 27, paymentNextMonth: false, prepaid: {} };
eq('같은 달 결제', pick(cycleOf('2026-08', D)), { start: '2026-07-21', end: '2026-08-20', pay: '2026-08-27' });

eq('마감일 표기', [closingLabel(0), closingLabel(14)], ['말일', '14일']);
eq('합산 기간 표기', formatCycleRange(cycleOf('2026-08', A)), '8월 1일 ~ 8월 31일');
eq('오늘이 속한 회차가 나온다', /^\d{4}-\d{2}$/.test(currentCycleKey(A)), true);

/* ---------------- 프리셋: 6일 ~ 다음 달 5일, 18일 결제 ---------------- */

const P = CARD_PRESETS.find((x) => x.closingDay === 5 && x.paymentDay === 18);
eq('프리셋이 있다', !!P, true);
const E = { ...P, prepaid: {} };
eq('프리셋: 9월 회차', pick(cycleOf('2026-09', E)), { start: '2026-08-06', end: '2026-09-05', pay: '2026-09-18' });
eq('프리셋: 연초', pick(cycleOf('2026-01', E)), { start: '2025-12-06', end: '2026-01-05', pay: '2026-01-18' });
eq('프리셋: 2월이 짧아도', pick(cycleOf('2026-03', E)), { start: '2026-02-06', end: '2026-03-05', pay: '2026-03-18' });
eq('프리셋: 합산 기간 표기', formatCycleRange(cycleOf('2026-09', E)), '8월 6일 ~ 9월 5일');
eq('프리셋: 결제일은 늘 마감월 18일',
   ['2026-04', '2026-07', '2026-12'].map((k) => cycleOf(k, E).payDate),
   ['2026-04-18', '2026-07-18', '2026-12-18']);

/* ---------------- 날짜가 걸리는 회차 ---------------- */

eq('마감 전날은 그 회차', cycleKeyForDate('2026-09-05', E), '2026-09');
eq('마감 다음 날은 다음 회차', cycleKeyForDate('2026-09-06', E), '2026-10');
eq('달 중간', cycleKeyForDate('2026-09-20', E), '2026-10');
eq('말일 마감이면 그 달이 곧 회차',
   ['2026-09-01', '2026-09-30'].map((d) => cycleKeyForDate(d, A)), ['2026-09', '2026-09']);
eq('연말을 넘어간다', cycleKeyForDate('2026-12-20', E), '2027-01');

/* ---------------- 할부 개월 수 ---------------- */

const row = (o) => ({ type: 'expense', method: 'credit', amount: 100000, date: '2026-09-10', ...o });
eq('일시불이 기본', installmentCount(row({})), 1);
eq('6개월은 그대로', installmentCount(row({ installment: 6 })), 6);
eq('0·1·음수는 일시불', [0, 1, -3].map((n) => installmentCount(row({ installment: n }))), [1, 1, 1]);
eq('36개월을 넘지 않는다', installmentCount(row({ installment: 99 })), 36);
eq('체크카드·현금·수입에는 할부가 없다', [
  installmentCount(row({ method: 'debit', installment: 6 })),
  installmentCount(row({ method: 'cash', installment: 6 })),
  installmentCount(row({ type: 'income', installment: 6 })),
], [1, 1, 1]);

/* ---------------- 할부 월별 금액 ---------------- */

eq('나누어 떨어지면 똑같이', [0, 1, 2].map((i) => installmentShare(300000, 3, i)), [100000, 100000, 100000]);
eq('나머지는 첫 달에', [0, 1, 2].map((i) => installmentShare(100000, 3, i)), [33334, 33333, 33333]);
eq('전부 더하면 원금', [3, 6, 7, 12, 36].map((n) => {
  let t = 0; for (let i = 0; i < n; i += 1) t += installmentShare(100001, n, i); return t;
}), [100001, 100001, 100001, 100001, 100001]);
eq('범위 밖은 0', [installmentShare(300000, 3, -1), installmentShare(300000, 3, 3)], [0, 0]);
eq('일시불은 첫 달에 전액', [installmentShare(50000, 1, 0), installmentShare(50000, 1, 1)], [50000, 0]);
eq('원보다 작은 할부도 합이 맞는다',
   (() => { let t = 0; for (let i = 0; i < 12; i += 1) t += installmentShare(7, 12, i); return t; })(), 7);

eq('일시불 문구', installmentLabel(100000, 1), '일시불');
eq('딱 떨어지는 문구', installmentLabel(300000, 3), '3개월 할부 · 매달 100,000원');
eq('나머지가 있는 문구', installmentLabel(100000, 3), '3개월 할부 · 첫 달 33,334원, 이후 33,333원');
eq('금액을 아직 안 넣었으면', installmentLabel(0, 6), '6개월 할부');
eq('고를 수 있는 개월', [INSTALLMENT_MONTHS.includes(6), INSTALLMENT_MONTHS.includes(12), INSTALLMENT_MONTHS.includes(1)],
   [true, true, false]);

/* ---------------- 선납 금액 ---------------- */

eq('숫자 그대로', prepaidAmount('2026-09', { prepaid: { '2026-09': 150000 } }, 500000), 150000);
eq('예전 true 는 전액', prepaidAmount('2026-09', { prepaid: { '2026-09': true } }, 500000), 500000);
eq('기록이 없으면 0', prepaidAmount('2026-09', { prepaid: {} }, 500000), 0);
eq('0·음수는 0', [0, -5].map((v) => prepaidAmount('2026-09', { prepaid: { '2026-09': v } }, 500000)), [0, 0]);
eq('설정이 통째로 없어도 0', prepaidAmount('2026-09', undefined, 500000), 0);

console.log(fail ? `\n${fail}건 실패` : '\n전부 통과');
process.exit(fail ? 1 : 0);
