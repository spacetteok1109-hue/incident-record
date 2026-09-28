/* 가계부 — 할부·선납·카드 청구 흐름을 실제 브라우저에서 확인합니다.
 * 먼저 저장소 뿌리에서 `python3 -m http.server 8099` 를 띄워 두세요. */
import { chromium, devices, BASE } from './harness.mjs';
const errors = [];
const browser = await chromium.launch({ args: ['--no-sandbox', '--proxy-server=direct://', '--proxy-bypass-list=*'] });
const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const step = async (n, f) => { try { await f(); console.log('  ✓ ' + n); } catch (e) { console.log('  ✗ ' + n + ' — ' + e.message); errors.push(n + ': ' + e.message); } };
const k = (n) => new Date(Date.now() + 9 * 3600000 + n * 86400000).toISOString().slice(0, 10);

await page.goto(`${BASE}/app/index.html`, { waitUntil: 'networkidle' });
await page.waitForSelector('.tabbar');

// 카드 주기를 말일 마감 · 다음 달 25일로 못박아 회차 경계를 예측 가능하게 둡니다.
await page.evaluate(async () => {
  const money = await import('./js/money.js');
  await money.setCardSettings({ closingDay: 0, paymentDay: 25, paymentNextMonth: true, prepaid: {} });
});

const money = (fn, arg) => page.evaluate(async ([src, a]) => {
  const m = await import('./js/money.js');
  return (new Function('m', 'a', `return (${src})(m, a);`))(m, a);
}, [fn.toString(), arg]);

/* ---------- 할부 입력 ---------- */

await step('신용카드 지출에만 할부 칸이 보인다', async () => {
  await page.click('[data-tab="money"]');
  await page.waitForSelector('.card-panel');
  await page.click('.fab');
  await page.waitForSelector('.amount-input');
  const vis = async () => page.locator('.field:has(.installment-select)').isVisible();
  if (!await vis()) throw new Error('신용카드인데 안 보임');
  await page.click('.pick-grid .pick:has-text("현금")');
  if (await vis()) throw new Error('현금인데 보임');
  await page.click('.pick-grid .pick:has-text("신용카드")');
  if (!await vis()) throw new Error('신용카드로 돌아왔는데 안 보임');
  await page.click('.seg button:has-text("수입")');
  if (await vis()) throw new Error('수입인데 보임');
  await page.click('.seg button:has-text("지출")');
  // 수입으로 갔다 오면 결제수단이 계좌이체로 남으므로 다시 신용카드로 돌립니다.
  await page.click('.pick-grid .pick:has-text("신용카드")');
  if (!await vis()) throw new Error('신용카드로 돌아왔는데 안 보임(2)');
});

await step('개월 수를 고르면 매달 얼마인지 알려 준다', async () => {
  await page.fill('.amount-input', '300000');
  await page.dispatchEvent('.amount-input', 'input');
  await page.selectOption('.installment-select', '3');
  const hint = await page.textContent('.installment-hint');
  if (!hint.includes('3개월 할부') || !hint.includes('100,000원'))
    throw new Error(hint);
});

await step('할부로 저장하면 목록에 개월 수와 월 납입액이 보인다', async () => {
  await page.fill('input[placeholder="어디에 썼는지 적어 두세요"]', '노트북');
  await page.click('.sheet-head button.primary');
  await page.waitForSelector('.sheet', { state: 'detached' });
  await page.waitForTimeout(400);
  const row = page.locator('.expense-row:has-text("노트북")');
  const t = await row.textContent();
  if (!t.includes('3개월 할부')) throw new Error('할부 표시 없음: ' + t);
  if (!t.includes('300,000원')) throw new Error('전체 금액 없음: ' + t);
  if (!t.includes('월 100,000원')) throw new Error('월 납입액 없음: ' + t);
});

await step('현금으로 바꾸면 할부가 사라진다', async () => {
  const before = await money((m, a) => m.installmentCount(a), { type: 'expense', method: 'credit', installment: 3 });
  if (before !== 3) throw new Error('앞단 확인 실패');
  const saved = await page.evaluate(async () => {
    const m = await import('./js/money.js');
    const rows = await m.getAll();
    const r = rows.find((x) => x.memo === '노트북');
    const out = await m.save({ ...r, method: 'cash' });
    await m.save({ ...out, method: 'credit', installment: 3 });   // 되돌려 둡니다
    return out.installment;
  });
  if (saved !== 1) throw new Error('현금인데 할부가 ' + saved);
});

/* ---------- 카드 패널이 할부를 나눠 청구한다 ---------- */

await step('이번 회차 청구액은 할부 한 달치만 잡힌다', async () => {
  await page.evaluate(async (d) => {
    const m = await import('./js/money.js');
    await m.save({ date: d, amount: 50000, method: 'credit', category: 'food', memo: '일시불 점심' });
  }, k(0));
  await page.waitForTimeout(400);
  const t = await page.textContent('.card-panel');
  // 일시불 50,000 + 할부 첫 회 100,000 = 150,000
  if (!t.includes('150,000원')) throw new Error('청구액: ' + t);
  if (!t.includes('일시불')) throw new Error('일시불 줄 없음: ' + t);
  if (!t.includes('할부 1건')) throw new Error('할부 줄 없음: ' + t);
});

await step('할부 줄을 펼치면 회차와 남은 금액이 보인다', async () => {
  await page.click('.cp-toggle');
  await page.waitForSelector('.plan-row');
  const t = await page.textContent('.plan-row');
  if (!t.includes('노트북')) throw new Error(t);
  if (!t.includes('1/3회차')) throw new Error('회차 표기: ' + t);
  if (!t.includes('200,000원 남음')) throw new Error('남은 금액: ' + t);
  if (!t.includes('100,000원')) throw new Error('이번 달 금액: ' + t);
});

await step('다음 달 회차에는 2회차가 걸린다', async () => {
  const out = await page.evaluate(async () => {
    const m = await import('./js/money.js');
    const s = await m.getCardSettings();
    const next = m.cycleOf(m.shiftMonthKey(m.currentCycleKey(s), 1), s);
    const bd = await m.cycleBreakdown(next, s);
    return { total: bd.total, lump: bd.lump, idx: bd.plans[0]?.index, due: bd.plans[0]?.due };
  });
  if (out.lump !== 0) throw new Error('다음 달 일시불이 ' + out.lump);
  if (out.idx !== 2 || out.due !== 100000) throw new Error(JSON.stringify(out));
});

await step('4개월 뒤에는 할부가 끝나 있다', async () => {
  const out = await page.evaluate(async () => {
    const m = await import('./js/money.js');
    const s = await m.getCardSettings();
    const later = m.cycleOf(m.shiftMonthKey(m.currentCycleKey(s), 3), s);
    return (await m.cycleBreakdown(later, s)).plans.length;
  });
  if (out !== 0) throw new Error('아직 ' + out + '건 남음');
});

await step('남은 할부금이 이 달 내역에 뜬다', async () => {
  const t = await page.textContent('.settings-group');
  if (!t.includes('남은 할부금')) throw new Error(t);
  if (!t.includes('300,000원')) throw new Error('잔액: ' + t);
});

/* ---------- 선납 금액 ---------- */

await step('선납 금액을 적을 수 있다', async () => {
  await page.click('.cp-tap');
  await page.waitForSelector('.sheet');
  await page.fill('.sheet .amount-input', '50000');
  await page.dispatchEvent('.sheet .amount-input', 'input');
  const hint = await page.textContent('.sheet .hint >> nth=1');
  if (!hint.includes('100,000원')) throw new Error('남을 금액 안내: ' + hint);
  await page.click('.sheet-head button.primary');
  await page.waitForSelector('.sheet', { state: 'detached' });
  await page.waitForTimeout(400);
});

await step('선납을 빼고 남을 금액이 크게 보인다', async () => {
  const big = await page.textContent('.cp-amount');
  if (big.trim() !== '100,000원') throw new Error('큰 금액이 ' + big);
  const sub = await page.textContent('.cp-amount-sub');
  if (!sub.includes('청구 150,000원')) throw new Error(sub);
  const line = await page.textContent('.cp-tap');
  if (!line.includes('선납') || !line.includes('−50,000원')) throw new Error('선납 줄: ' + line);
  if (!await page.locator('.prepaid-bar').isVisible()) throw new Error('선납 막대 없음');
});

await step('전액을 누르면 청구액이 그대로 들어온다', async () => {
  await page.click('.cp-tap');
  await page.waitForSelector('.sheet');
  await page.click('.sheet .chip.tap:has-text("전액")');
  const v = await page.inputValue('.sheet .amount-input');
  if (v !== '150,000') throw new Error('금액이 ' + v);
  await page.click('.sheet-head button.primary');
  await page.waitForSelector('.sheet', { state: 'detached' });
  await page.waitForTimeout(400);
  if (!await page.locator('.card-panel.paid').count()) throw new Error('다 낸 표시가 안 됨');
  const big = await page.textContent('.cp-amount');
  if (big.trim() !== '0원') throw new Error('남을 금액이 ' + big);
});

await step('지우면 선납 기록이 없어진다', async () => {
  await page.click('.cp-tap');
  await page.waitForSelector('.sheet');
  await page.click('.sheet .chip.tap:has-text("지우기")');
  await page.click('.sheet-head button.primary');
  await page.waitForSelector('.sheet', { state: 'detached' });
  await page.waitForTimeout(400);
  if (await page.locator('.cp-amount-sub').count()) throw new Error('청구액 줄이 남아 있음');
  const line = await page.textContent('.cp-tap');
  if (!line.includes('미리 낸 금액 적기')) throw new Error('빈 선납 줄: ' + line);
  const big = await page.textContent('.cp-amount');
  if (big.trim() !== '150,000원') throw new Error('청구액이 ' + big);
});

await step('예전 자료의 true 선납도 전액으로 읽힌다', async () => {
  const out = await page.evaluate(async () => {
    const m = await import('./js/money.js');
    const s = await m.getCardSettings();
    await m.setCardSettings({ prepaid: { [m.currentCycleKey(s)]: true } });
    const st = await m.cardStatus();
    await m.setCardSettings({ prepaid: {} });
    return { prepaid: st.prepaid, due: st.due };
  });
  if (out.prepaid !== 150000 || out.due !== 0) throw new Error(JSON.stringify(out));
});

await step('앱을 다시 열어도 할부와 선납이 남아 있다', async () => {
  await page.evaluate(async () => {
    const m = await import('./js/money.js');
    const s = await m.getCardSettings();
    await m.setPrepaid(m.currentCycleKey(s), 30000);
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('[data-tab="money"]');
  await page.waitForSelector('.card-panel');
  const t = await page.textContent('.card-panel');
  if (!t.includes('할부 1건')) throw new Error('할부가 사라짐: ' + t);
  if (!t.includes('−30,000원')) throw new Error('선납이 사라짐: ' + t);
  const row = await page.textContent('.expense-row:has-text("노트북")');
  if (!row.includes('3개월 할부')) throw new Error(row);
});

console.log('\n오류:', errors.length ? errors.join('\n') : '없음');
await browser.close();
process.exit(errors.length ? 1 : 0);
