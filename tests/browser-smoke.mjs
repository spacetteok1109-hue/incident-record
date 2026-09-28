/* 앱 전체 훑기 — 탭마다 그려지는지, 주요 흐름이 도는지, 콘솔 오류가 없는지.
 * 먼저 저장소 뿌리에서 `python3 -m http.server 8099` 를 띄워 두세요. */
import { openApp, reporter, dayKey as k } from './harness.mjs';

const { errors, step } = reporter();
const { browser, page } = await openApp(errors);

await step('다섯 개 탭이 있고 캘린더가 첫 화면이다', async () => {
  const tabs = await page.locator('.tabbar button').allTextContents();
  if (tabs.length !== 5) throw new Error(JSON.stringify(tabs));
  if (tabs.some((t) => t.includes('오늘'))) throw new Error('없앤 오늘 탭이 남음');
  const h = await page.textContent('#topbar h1');
  if (!h.startsWith('캘린더')) throw new Error('첫 화면이 ' + h);
  await page.waitForSelector('.cal-grid');
});

await step('할 일·디데이·가계부를 넣을 수 있다', async () => {
  await page.evaluate(async (d) => {
    const store = await import('./js/store.js');
    const money = await import('./js/money.js');
    const fs = await store.getFolders();
    await store.saveItem({ title: '밀린 할 일', dueDate: d[0] });
    await store.saveItem({ title: '워크숍 준비', folderId: fs[1].id, startDate: d[1], dueDate: d[2] });
    await store.saveItem({ type: 'dday', title: '이사', dueDate: d[3] });
    await money.save({ date: d[4], amount: 12500, method: 'credit', category: 'food', memo: '점심' });
    await money.save({ date: d[4], amount: 3000000, type: 'income', method: 'transfer', category: 'salary' });
  }, [k(-3), k(-1), k(3), k(20), k(0)]);
  await page.waitForTimeout(500);
});

await step('지난 미완료가 있는 날 칸이 칠해진다', async () => {
  // 처음 켤 때 들어가는 예시 자료도 있으므로 '밀린 할 일' 을 넣은 날만 봅니다.
  const day = Number(k(-3).slice(8));
  const painted = await page.evaluate((d) => {
    const cell = [...document.querySelectorAll('.cal-cell:not(.out)')]
      .find((c) => Number(c.querySelector('.num')?.textContent) === d);
    return cell ? cell.classList.contains('overdue') : null;
  }, day);
  if (painted === null) throw new Error(day + '일 칸을 못 찾음');
  if (!painted) throw new Error(day + '일 칸이 안 칠해짐');
});

await step('여러 날에 걸친 일은 줄로 그려진다', async () => {
  const w = await page.evaluate(() => {
    const mine = [...document.querySelectorAll('.cal-bar')].filter((b) => b.title === '워크숍 준비');
    const cell = document.querySelector('.cal-cell').getBoundingClientRect().width;
    return { count: mine.length, widest: Math.max(...mine.map((b) => b.getBoundingClientRect().width)), cell };
  });
  if (!w.count) throw new Error('막대 없음');
  if (w.widest <= w.cell * 1.5) throw new Error('한 칸을 넘지 못함: ' + JSON.stringify(w));
});

await step('날짜를 골라도 막대가 가려지지 않는다', async () => {
  await page.click('.cal-cell.today');
  await page.waitForSelector('.day-panel');
  const covered = await page.evaluate(() => {
    const bars = [...document.querySelectorAll('.cal-bar')];
    return bars.filter((b) => {
      const r = b.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !(top === b || b.contains(top));
    }).length;
  });
  if (covered) throw new Error(covered + '개 막대가 가려짐');
});

await step('고른 날에 그 날 가계부도 같이 보인다', async () => {
  const t = await page.textContent('.day-panel');
  if (!t.includes('12,500원')) throw new Error('지출 없음');
  if (!t.includes('+3,000,000원')) throw new Error('수입 없음');
});

await step('폴더 탭이 그려진다', async () => {
  await page.click('[data-tab="folders"]');
  await page.waitForSelector('.folder-grid');
});

await step('디데이를 체크하면 목록에서 사라지고 되돌릴 수 있다', async () => {
  await page.click('[data-tab="dday"]');
  await page.waitForSelector('.dday-card');
  const before = await page.locator('.dday-card').count();
  await page.click('.dday-card .dday-check');
  await page.waitForTimeout(400);
  const after = await page.locator('.dday-card:not(.done)').count();
  if (after !== before - 1) throw new Error(`${before} → ${after}`);
  await page.click('.done-toggle');
  await page.waitForSelector('.dday-card.done');
  await page.click('.dday-card.done .dday-check');
  await page.waitForTimeout(400);
  if (await page.locator('.dday-card:not(.done)').count() !== before) throw new Error('되돌리기 실패');
});

await step('가계부 탭에 카드 패널과 요약이 있다', async () => {
  await page.click('[data-tab="money"]');
  await page.waitForSelector('.card-panel');
  const t = await page.textContent('.card-panel');
  for (const w of ['신용카드 결제 예정', '합산 기간', '결제일', '선납']) {
    if (!t.includes(w)) throw new Error(w + ' 없음: ' + t);
  }
  if (await page.locator('.stat-tile').count() !== 2) throw new Error('요약 타일 개수가 다름');
});

await step('요약 타일 글자가 칸 밖으로 넘치지 않는다', async () => {
  const over = await page.evaluate(() => [...document.querySelectorAll('.stat-value')]
    .filter((v) => v.scrollWidth > v.clientWidth + 1)
    .map((v) => v.textContent));
  if (over.length) throw new Error('잘린 금액: ' + JSON.stringify(over));
});

await step('카드 주기 프리셋이 세 항목을 한꺼번에 채운다', async () => {
  await page.click('.cp-setting');
  await page.waitForSelector('.sheet');
  const chips = await page.locator('.sheet .chip-row .chip.tap').allTextContents();
  if (chips.length !== 1) throw new Error(JSON.stringify(chips));
  await page.click('.sheet .chip-row .chip.tap');
  await page.waitForTimeout(150);
  const v = await page.evaluate(() => [...document.querySelectorAll('.sheet select')].map((x) => x.value));
  if (JSON.stringify(v) !== JSON.stringify(['5', '0', '18'])) throw new Error(JSON.stringify(v));
  const preview = await page.textContent('.sheet .hint >> nth=1');
  if (!/\d+월 6일 ~ \d+월 5일/.test(preview)) throw new Error(preview);
  if (!/\d+월 18일/.test(preview)) throw new Error(preview);
  await page.click('.sheet-head button:has-text("취소")');
  await page.waitForSelector('.sheet', { state: 'detached' });
});

await step('테마를 바꾸면 바로 반영되고 새로고침해도 남는다', async () => {
  await page.click('[data-tab="settings"]');
  await page.waitForSelector('.settings-group');
  await page.click('.settings-row:has(.label:text-is("테마"))');
  await page.waitForSelector('.sheet');
  await page.click('.sheet .settings-row:has-text("흰색 · 하늘")');
  await page.waitForSelector('.sheet', { state: 'detached' });
  await page.waitForTimeout(250);
  if (await page.getAttribute('html', 'data-theme') !== 'sky') throw new Error('바로 안 바뀜');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.tabbar');
  if (await page.getAttribute('html', 'data-theme') !== 'sky') throw new Error('새로고침 뒤 사라짐');
});

await step('모든 테마에서 강조색 위 글자가 읽힌다', async () => {
  const lum = (c) => {
    const [r, g, b] = c;
    const f = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const results = await page.evaluate(async (themes) => {
    const out = [];
    for (const t of themes) {
      document.documentElement.dataset.theme = t;
      const cs = getComputedStyle(document.documentElement);
      out.push([t, cs.getPropertyValue('--accent').trim(), cs.getPropertyValue('--on-accent').trim()]);
    }
    return out;
  }, ['light', 'sky', 'modern', 'mono', 'sunny']);

  const parse = (s) => {
    let m = s.match(/rgba?\(([^)]+)\)/);
    if (m) return m[1].split(/[,\s/]+/).slice(0, 3).map((n) => Number(n) / 255);
    m = s.match(/color\(srgb ([^)]+)\)/);
    if (m) return m[1].trim().split(/[\s/]+/).slice(0, 3).map(Number);
    m = s.match(/^#([0-9a-f]{6})$/i);
    if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
    throw new Error('못 읽는 색: ' + s);
  };
  const bad = results.filter(([, a, o]) => {
    const [l1, l2] = [lum(parse(a)), lum(parse(o))].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05) < 4.5;
  });
  if (bad.length) throw new Error('대비 부족: ' + JSON.stringify(bad));
});

console.log('\n오류:', errors.length ? errors.join('\n') : '없음');
await browser.close();
process.exit(errors.length ? 1 : 0);
