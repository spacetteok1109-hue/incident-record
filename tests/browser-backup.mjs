/* 백업 내보내기·가져오기 — 설정까지 따라가는지.
 * 먼저 저장소 뿌리에서 `python3 -m http.server 8099` 를 띄워 두세요. */
import { openApp, reporter, dayKey as k } from './harness.mjs';

const { errors, step } = reporter();
const { browser, page } = await openApp(errors);

const dump = () => page.evaluate(async () => {
  const store = await import('./js/store.js');
  return store.exportBackup(false);
});
const load = (data, mode) => page.evaluate(async ([d, m]) => {
  const store = await import('./js/store.js');
  return store.importBackup(d, m);
}, [data, mode]);
const meta = (key) => page.evaluate(async (k2) => {
  const db = await import('./js/db.js');
  return db.getMeta(k2, null);
}, key);

await step('설정을 바꾼 뒤 내보내면 백업에 담긴다', async () => {
  await page.evaluate(async (d) => {
    const db = await import('./js/db.js');
    const money = await import('./js/money.js');
    const store = await import('./js/store.js');
    await db.setMeta('settings', { theme: 'sky', hideCompleted: true, showBadge: false, showDdayOnCalendar: false });
    await money.loadCategories();
    await money.setCategories('expense', [
      { value: 'food', label: '밥값', emoji: '🍜' },
      { value: 'pet', label: '반려동물', emoji: '🐾' },
    ]);
    await money.setCardSettings({ closingDay: 5, paymentDay: 18, paymentNextMonth: false });
    await store.saveItem({ title: '남은 할 일', dueDate: d });
  }, k(1));

  const b = await dump();
  if (b.version !== 2) throw new Error('version ' + b.version);
  if (!b.prefs) throw new Error('prefs 가 없음');
  if (b.prefs.settings.theme !== 'sky') throw new Error(JSON.stringify(b.prefs.settings));
  if (b.prefs.categories.expense.length !== 2) throw new Error(JSON.stringify(b.prefs.categories));
  if (b.prefs.cardSettings.paymentDay !== 18) throw new Error(JSON.stringify(b.prefs.cardSettings));
});

await step('아이콘과 PIN 은 백업에 담기지 않는다', async () => {
  await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const lock = await import('./js/lock.js');
    await lock.setPin('135790');
    await db.setMeta('appIcon', { i512: new Blob(['x']), updatedAt: 1 });
  });
  const b = await dump();
  const text = JSON.stringify(b);
  if ('appIcon' in b.prefs || text.includes('appIcon')) throw new Error('아이콘이 담김');
  if ('lock' in b.prefs || text.includes('135790') || text.includes('salt')) throw new Error('PIN 이 담김');
  await page.evaluate(async () => {
    const lock = await import('./js/lock.js');
    await lock.disable('135790');
  });
});

await step('덮어쓰기로 가져오면 설정도 따라온다', async () => {
  const backup = await dump();
  // 기기를 바꾼 셈 치고 모두 지웁니다.
  await page.evaluate(async () => {
    const store = await import('./js/store.js');
    await store.wipeAll();
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.tabbar');

  const fresh = await page.evaluate(async () => {
    const money = await import('./js/money.js');
    return money.categoriesFor('expense').length;
  });
  if (fresh !== 10) throw new Error('지운 뒤 기본 분류가 ' + fresh + '개');

  const n = await load(backup, 'replace');
  if (n.prefs !== 3) throw new Error('가져온 설정이 ' + n.prefs + '개');

  const s = await meta('settings');
  if (s.theme !== 'sky' || s.hideCompleted !== true) throw new Error(JSON.stringify(s));
  const card = await meta('cardSettings');
  if (card.closingDay !== 5 || card.paymentDay !== 18 || card.paymentNextMonth !== false)
    throw new Error(JSON.stringify(card));
  const cats = await page.evaluate(async () => {
    const money = await import('./js/money.js');
    await money.loadCategories();
    return money.categoriesFor('expense').map((c) => c.label);
  });
  if (JSON.stringify(cats) !== JSON.stringify(['밥값', '반려동물'])) throw new Error(JSON.stringify(cats));
});

await step('합치기로 가져오면 이 기기 설정을 건드리지 않는다', async () => {
  const backup = await dump();
  await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const money = await import('./js/money.js');
    await db.setMeta('settings', { theme: 'sunny', hideCompleted: false, showBadge: true, showDdayOnCalendar: true });
    await money.setCardSettings({ closingDay: 0, paymentDay: 25, paymentNextMonth: true });
  });
  const n = await load(backup, 'merge');
  if (n.prefs !== 0) throw new Error('합치기인데 설정 ' + n.prefs + '개를 덮음');
  const s = await meta('settings');
  if (s.theme !== 'sunny') throw new Error('테마가 ' + s.theme);
  const card = await meta('cardSettings');
  if (card.paymentDay !== 25) throw new Error(JSON.stringify(card));
});

await step('설정이 없는 예전 백업도 그대로 읽힌다', async () => {
  const old = { app: 'todo-cal', version: 1, folders: [], items: [{ id: 'old1', title: '예전 항목' }], expenses: [], photos: [] };
  const n = await load(old, 'replace');
  if (n.items !== 1) throw new Error(JSON.stringify(n));
  if (n.prefs !== 0) throw new Error('없는 설정을 가져옴');
  const s = await meta('settings');
  if (!s || s.theme !== 'sunny') throw new Error('설정이 날아감: ' + JSON.stringify(s));
});

await step('설정 자리에 엉뚱한 값이 와도 걸러진다', async () => {
  const bad = {
    app: 'todo-cal',
    items: [],
    prefs: {
      settings: { theme: 'javascript:alert(1)', hideCompleted: 'yes', showBadge: 0 },
      categories: { expense: [{ value: '', label: '빈값' }, { value: 'ok', label: 'ㄱ'.repeat(99) }], income: 'nope' },
      cardSettings: { closingDay: 99, paymentDay: -3, prepaid: { 'not-a-month': 5, '2026-09': -10, '2026-10': 50000 } },
    },
  };
  const n = await load(bad, 'replace');
  if (n.prefs !== 3) throw new Error('설정이 ' + n.prefs + '개');

  const s = await meta('settings');
  if (s.theme !== 'auto') throw new Error('모르는 테마가 남음: ' + s.theme);
  if (s.hideCompleted !== true || s.showBadge !== false) throw new Error(JSON.stringify(s));

  const cats = await meta('categories');
  if (cats.expense.length !== 1) throw new Error(JSON.stringify(cats.expense));
  if (cats.expense[0].label.length > 20) throw new Error('이름이 안 잘림');
  if ('income' in cats) throw new Error('잘못된 수입 분류가 들어감');

  const card = await meta('cardSettings');
  if (card.closingDay !== 0) throw new Error('마감일이 ' + card.closingDay);
  if (card.paymentDay !== 25) throw new Error('결제일이 ' + card.paymentDay);
  if (JSON.stringify(card.prepaid) !== JSON.stringify({ '2026-10': 50000 }))
    throw new Error(JSON.stringify(card.prepaid));
});

await step('가져온 테마가 화면에 바로 입혀진다', async () => {
  await page.evaluate(async () => {
    const store = await import('./js/store.js');
    await store.wipeAll();
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.tabbar');

  const backup = { app: 'todo-cal', version: 2, folders: [], items: [], expenses: [], photos: [],
    prefs: { settings: { theme: 'mono', hideCompleted: false, showBadge: true, showDdayOnCalendar: true } } };

  await page.click('[data-tab="settings"]');
  await page.waitForSelector('.settings-group');
  await page.evaluate(async (d) => {
    // 설정 화면에서 쓰는 경로와 같게 가져온 뒤 입힙니다.
    const store = await import('./js/store.js');
    await store.importBackup(d, 'replace');
  }, backup);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.tabbar');
  const theme = await page.getAttribute('html', 'data-theme');
  if (theme !== 'mono') throw new Error('테마가 ' + theme);
});

console.log('\n오류:', errors.length ? errors.join('\n') : '없음');
await browser.close();
process.exit(errors.length ? 1 : 0);
