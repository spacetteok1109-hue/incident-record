/* 가계부 — 결제수단을 골라 나눠 보기.
 * 먼저 저장소 뿌리에서 `python3 -m http.server 8099` 를 띄워 두세요. */
import { openApp, reporter, dayKey as k } from './harness.mjs';

const { errors, step } = reporter();
const { browser, page } = await openApp(errors);

const amountOf = (label) => page.locator(`.method-chip:has(.mc-label:text-is("${label}")) .mc-amount`).textContent();
const chip = (label) => page.locator(`.method-chip:has(.mc-label:text-is("${label}"))`);

await page.evaluate(async (d) => {
  const m = await import('./js/money.js');
  await m.save({ date: d[0], amount: 1450000, method: 'credit', category: 'shopping', memo: '노트북', installment: 6 });
  await m.save({ date: d[1], amount: 68000, method: 'credit', category: 'food', memo: '회식' });
  await m.save({ date: d[2], amount: 43200, method: 'debit', category: 'living', memo: '마트' });
  await m.save({ date: d[3], amount: 8900, method: 'debit', category: 'cafe', memo: '커피' });
  await m.save({ date: d[3], amount: 54000, method: 'cash', category: 'transport', memo: '택시' });
  await m.save({ date: d[2], amount: 89000, method: 'transfer', category: 'bill', memo: '관리비' });
  await m.save({ date: d[3], amount: 2800000, type: 'income', method: 'transfer', category: 'salary' });
}, [k(-3), k(-2), k(-1), k(0)]);

await page.click('[data-tab="money"]');
await page.waitForSelector('.method-row');

await step('신용·체크·현금·전체가 모두 한 화면에 보인다', async () => {
  const labels = await page.locator('.mc-label').allTextContents();
  for (const want of ['전체', '신용카드', '체크카드', '현금']) {
    if (!labels.includes(want)) throw new Error(want + ' 없음: ' + JSON.stringify(labels));
  }
  // 가로로 밀지 않아도 다 보여야 합니다.
  const hidden = await page.evaluate(() => {
    const row = document.querySelector('.method-row');
    const rb = row.getBoundingClientRect();
    return [...row.children]
      .filter((c) => c.getBoundingClientRect().right > rb.right + 1)
      .map((c) => c.textContent);
  });
  if (hidden.length) throw new Error('칸 밖으로 나간 칩: ' + JSON.stringify(hidden));
});

await step('칩마다 그 수단으로 쓴 금액이 적혀 있다', async () => {
  const got = {
    전체: (await amountOf('전체')).trim(),
    신용카드: (await amountOf('신용카드')).trim(),
    체크카드: (await amountOf('체크카드')).trim(),
    현금: (await amountOf('현금')).trim(),
    계좌이체: (await amountOf('계좌이체')).trim(),
  };
  const want = {
    전체: '1,713,100원', 신용카드: '1,518,000원', 체크카드: '52,100원',
    현금: '54,000원', 계좌이체: '89,000원',
  };
  if (JSON.stringify(got) !== JSON.stringify(want))
    throw new Error(JSON.stringify(got));
});

await step('수단별 금액을 다 더하면 전체와 같다', async () => {
  const out = await page.evaluate(async () => {
    const m = await import('./js/money.js');
    const t = await m.methodTotals(m.thisMonthKey());
    const parts = m.METHODS.reduce((s, x) => s + t[x.value], 0);
    return { all: t.all, parts };
  });
  if (out.all !== out.parts) throw new Error(JSON.stringify(out));
});

await step('수입은 수단 금액에 섞이지 않는다', async () => {
  // 2,800,000 수입이 계좌이체인데도 계좌이체 칩은 지출 89,000 만 세야 합니다.
  if ((await amountOf('계좌이체')).trim() !== '89,000원')
    throw new Error(await amountOf('계좌이체'));
});

await step('체크카드를 누르면 그 수단만 보인다', async () => {
  await chip('체크카드').click();
  await page.waitForTimeout(400);
  if (await chip('체크카드').getAttribute('aria-selected') !== 'true') throw new Error('안 골라짐');

  const tiles = await page.locator('.stat-tile').allTextContents();
  if (!tiles[0].includes('오늘 체크카드') || !tiles[0].includes('8,900원'))
    throw new Error('오늘 타일: ' + tiles[0]);
  if (!tiles[1].includes('이 달 체크카드') || !tiles[1].includes('52,100원'))
    throw new Error('이 달 타일: ' + tiles[1]);

  const head = await page.locator('.section-title').last().textContent();
  if (!head.includes('체크카드 내역')) throw new Error('목록 제목: ' + head);

  const list = await page.locator('.expense-row').allTextContents();
  if (list.length !== 2) throw new Error('줄이 ' + list.length + '개: ' + JSON.stringify(list));
  if (list.some((t) => t.includes('노트북') || t.includes('택시')))
    throw new Error('다른 수단이 섞임: ' + JSON.stringify(list));

  const cats = await page.locator('.cat-row').allTextContents();
  if (!cats.every((t) => t.includes('생활') || t.includes('카페'))) throw new Error(JSON.stringify(cats));
});

await step('현금만 따로 볼 수 있다', async () => {
  await chip('현금').click();
  await page.waitForTimeout(400);
  if (await chip('체크카드').getAttribute('aria-selected') !== 'false') throw new Error('체크가 아직 켜짐');
  const list = await page.locator('.expense-row').allTextContents();
  if (list.length !== 1 || !list[0].includes('택시')) throw new Error(JSON.stringify(list));
});

await step('고른 칩을 다시 누르면 전체로 돌아온다', async () => {
  await chip('현금').click();
  await page.waitForTimeout(400);
  if (await chip('전체').getAttribute('aria-selected') !== 'true') throw new Error('전체로 안 돌아옴');
  const head = await page.locator('.section-title').last().textContent();
  if (!head.includes('전체 내역')) throw new Error(head);
  if (await page.locator('.expense-row').count() !== 7) throw new Error('줄 수가 다름');
});

await step('전체일 때 둘째 타일은 전체 칩과 겹치지 않는다', async () => {
  const tiles = await page.locator('.stat-tile').allTextContents();
  const total = (await amountOf('전체')).trim();
  if (tiles[1].includes(total)) throw new Error('전체 칩과 같은 숫자: ' + tiles[1]);
  // 수입 2,800,000 − 지출 1,713,100 = 1,086,900
  if (!tiles[1].includes('남은 금액') || !tiles[1].includes('1,086,900원'))
    throw new Error('둘째 타일: ' + tiles[1]);
});

await step('기록이 없는 수단도 0원으로 자리를 지킨다', async () => {
  await page.evaluate(async () => {
    const m = await import('./js/money.js');
    for (const r of await m.getAll()) await m.remove(r.id);
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('[data-tab="money"]');
  await page.waitForSelector('.method-row');
  const labels = await page.locator('.mc-label').allTextContents();
  if (JSON.stringify(labels) !== JSON.stringify(['전체', '신용카드', '체크카드', '현금']))
    throw new Error(JSON.stringify(labels));
  if ((await amountOf('현금')).trim() !== '0원') throw new Error(await amountOf('현금'));
});

console.log('\n오류:', errors.length ? errors.join('\n') : '없음');
await browser.close();
process.exit(errors.length ? 1 : 0);
