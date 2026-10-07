/* 가계부 분류를 직접 고치기.
 * 먼저 저장소 뿌리에서 `python3 -m http.server 8099` 를 띄워 두세요. */
import { openApp, reporter, dayKey as k } from './harness.mjs';

const { errors, step } = reporter();
const { browser, page } = await openApp(errors);

// 열려 있던 시트가 남아 탭을 가로막지 않도록, 늘 새로 연 상태에서 시작합니다.
const openManager = async () => {
  if (await page.locator('.sheet').count()) {
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.tabbar');
  }
  await page.click('[data-tab="settings"]');
  await page.waitForSelector('.settings-group');
  await page.click('.settings-row:has(.label:text-is("분류 고치기"))');
  await page.waitForSelector('.cat-manage');
};
const closeSheet = async () => {
  await page.click('.sheet-head button:has-text("닫기")');
  await page.waitForSelector('.cat-manage', { state: 'detached' });
};
const names = () => page.locator('.cat-manage .cm-name').allTextContents();
/* 확인창도 시트로 뜨므로, 쌓인 것 중 맨 위를 봅니다. */
const topSheet = () => page.locator('.sheet').last();
const topTitle = () => topSheet().locator('.sheet-head h2').textContent();
const tapTop = (label) => topSheet().locator(`.sheet-head button:has-text("${label}")`).click();
const waitTop = async (text) => {
  await page.waitForFunction((t) => {
    const hs = document.querySelectorAll('.sheet .sheet-head h2');
    return hs.length && hs[hs.length - 1].textContent.includes(t);
  }, text, { timeout: 10000 });
};

await step('설정에서 분류 목록을 연다', async () => {
  await openManager();
  const list = await names();
  if (list.length !== 10) throw new Error('기본 지출 분류가 ' + list.length + '개');
  if (list[0] !== '식비') throw new Error(JSON.stringify(list));
});

await step('수입 분류로 바꿔 볼 수 있다', async () => {
  await page.click('.sheet .seg button:has-text("수입")');
  await page.waitForTimeout(250);
  const list = await names();
  if (JSON.stringify(list) !== JSON.stringify(['급여', '용돈', '환급·환불', '기타 수입']))
    throw new Error(JSON.stringify(list));
  await page.click('.sheet .seg button:has-text("지출")');
  await page.waitForTimeout(250);
});

await step('새 분류를 더할 수 있다', async () => {
  await page.click('.cat-manage-foot button:has-text("분류 추가")');
  await page.waitForSelector('.emoji-input');
  await page.fill('.sheet input[placeholder="예) 반려동물"]', '반려동물');
  await page.click('.sheet .emoji-pick:has-text("🐾")');
  await page.click('.sheet-head button.primary');
  await page.waitForSelector('.emoji-input', { state: 'detached' });
  await page.waitForTimeout(300);
  const list = await names();
  if (list[list.length - 1] !== '반려동물') throw new Error(JSON.stringify(list));
});

await step('이름이 비면 저장되지 않는다', async () => {
  const before = (await names()).length;
  await page.click('.cat-manage-foot button:has-text("분류 추가")');
  await page.waitForSelector('.emoji-input');
  await page.click('.sheet-head button.primary');
  await page.waitForTimeout(300);
  if (!await page.locator('.emoji-input').count()) throw new Error('빈 이름인데 닫힘');
  await page.click('.sheet-head button:has-text("취소")');
  await page.waitForSelector('.emoji-input', { state: 'detached' });
  await page.waitForTimeout(250);
  if ((await names()).length !== before) throw new Error('목록이 늘어남');
});

await step('이름과 아이콘을 고칠 수 있다', async () => {
  await page.click('.cat-manage-row:has(.cm-name:text-is("식비")) .cm-main');
  await page.waitForSelector('.emoji-input');
  await page.fill('.sheet input[maxlength="20"]', '밥값');
  await page.click('.sheet .emoji-pick:has-text("🍜")');
  await page.click('.sheet-head button.primary');
  await page.waitForTimeout(300);
  const list = await names();
  if (!list.includes('밥값') || list.includes('식비')) throw new Error(JSON.stringify(list));
  const emoji = await page.locator('.cat-manage-row:has(.cm-name:text-is("밥값")) .cm-emoji').textContent();
  if (emoji.trim() !== '🍜') throw new Error('아이콘이 ' + emoji);
});

await step('아이콘을 직접 써 넣을 수도 있다', async () => {
  await page.click('.cat-manage-row:has(.cm-name:text-is("밥값")) .cm-main');
  await page.waitForSelector('.emoji-input');
  await page.fill('.emoji-input', '🥗');
  await page.click('.sheet-head button.primary');
  await page.waitForTimeout(300);
  const emoji = await page.locator('.cat-manage-row:has(.cm-name:text-is("밥값")) .cm-emoji').textContent();
  if (emoji.trim() !== '🥗') throw new Error('아이콘이 ' + emoji);
});

await step('순서를 옮길 수 있고 첫 줄은 위로 못 간다', async () => {
  const before = await names();
  const firstUp = page.locator('.cat-manage-row').first().locator('.cm-move').first();
  if (!await firstUp.isDisabled()) throw new Error('첫 줄 ↑ 가 눌림');
  await page.locator('.cat-manage-row').first().locator('.cm-move').nth(1).click();
  await page.waitForTimeout(300);
  const after = await names();
  if (after[0] !== before[1] || after[1] !== before[0]) throw new Error(JSON.stringify([before, after]));
});

await step('고친 분류가 가계부 입력 화면에 그대로 나온다', async () => {
  await closeSheet();
  await page.click('[data-tab="money"]');
  await page.waitForSelector('.method-row');
  await page.click('.fab');
  await page.waitForSelector('.pick-grid');
  const picks = await page.locator('.field:has(.pick-grid) >> nth=-1').locator('.pick').allTextContents();
  if (!picks.some((t) => t.includes('밥값'))) throw new Error(JSON.stringify(picks));
  if (!picks.some((t) => t.includes('반려동물'))) throw new Error(JSON.stringify(picks));
});

await step('입력 화면의 편집 버튼으로도 열 수 있다', async () => {
  await page.click('.field-link:has-text("편집")');
  await page.waitForSelector('.cat-manage');
  await closeSheet();
  await page.click('.sheet-head button:has-text("취소")');
  await page.waitForSelector('.sheet', { state: 'detached' });
});

await step('안 쓰는 분류는 바로 지워진다', async () => {
  await openManager();
  const before = (await names()).length;
  await page.click('.cat-manage-row:has(.cm-name:text-is("반려동물")) .cm-main');
  await page.waitForSelector('.emoji-input');
  await page.click('.sheet button:has-text("이 분류 지우기")');
  await waitTop('분류 삭제');
  await tapTop('삭제');
  await page.waitForTimeout(500);
  const list = await names();
  if (list.includes('반려동물')) throw new Error(JSON.stringify(list));
  if (list.length !== before - 1) throw new Error(`${before} → ${list.length}`);
});

await step('쓰고 있는 분류를 지우면 내역을 옮길 곳을 고른다', async () => {
  await openManager();
  const cat = await page.evaluate(async () => {
    const m = await import('./js/money.js');
    return m.categoriesFor('expense').find((c) => c.label === '밥값').value;
  });
  await page.evaluate(async ([c, d]) => {
    const m = await import('./js/money.js');
    await m.save({ date: d, amount: 9000, method: 'cash', category: c, memo: '김밥' });
    await m.save({ date: d, amount: 7000, method: 'cash', category: c, memo: '국수' });
  }, [cat, k(0)]);

  await page.click('.cat-manage-row:has(.cm-name:text-is("밥값")) .cm-main');
  await page.waitForSelector('.emoji-input');
  await page.click('.sheet button:has-text("이 분류 지우기")');
  await waitTop('어디로 옮길까요');
  const head = await topTitle();
  if (!head.includes('2건')) throw new Error('건수 안내가 없음: ' + head);
  await topSheet().locator('.settings-row:has-text("교통")').click();
  await page.waitForTimeout(600);

  const list = await names();
  if (list.includes('밥값')) throw new Error('분류가 안 지워짐: ' + JSON.stringify(list));

  const moved = await page.evaluate(async () => {
    const m = await import('./js/money.js');
    const rows = await m.getAll();
    return rows.filter((r) => ['김밥', '국수'].includes(r.memo)).map((r) => r.category);
  });
  if (new Set(moved).size !== 1 || moved.length !== 2) throw new Error(JSON.stringify(moved));
  const dest = await page.evaluate(async () => {
    const m = await import('./js/money.js');
    return m.categoriesFor('expense').find((c) => c.label === '교통').value;
  });
  if (moved[0] !== dest) throw new Error('옮긴 곳이 다름: ' + JSON.stringify(moved));
});

await step('기본 분류로 되돌릴 수 있다', async () => {
  await openManager();
  await page.click('.cat-manage-foot button:has-text("기본 분류로 되돌리기")');
  await waitTop('기본 분류로 되돌리기');
  await tapTop('되돌리기');
  await page.waitForTimeout(500);
  const list = await names();
  if (JSON.stringify(list.slice(0, 3)) !== JSON.stringify(['식비', '카페·간식', '교통']))
    throw new Error(JSON.stringify(list));
  if (list.length !== 10) throw new Error('개수가 ' + list.length);
});

await step('앱을 다시 열어도 고친 분류가 남아 있다', async () => {
  await openManager();
  await page.click('.cat-manage-row:has(.cm-name:text-is("쇼핑")) .cm-main');
  await page.waitForSelector('.emoji-input');
  await page.fill('.sheet input[maxlength="20"]', '지름');
  await page.click('.sheet-head button.primary');
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'networkidle' });
  await openManager();
  const list = await names();
  if (!list.includes('지름') || list.includes('쇼핑')) throw new Error(JSON.stringify(list));
});

console.log('\n오류:', errors.length ? errors.join('\n') : '없음');
await browser.close();
process.exit(errors.length ? 1 : 0);
