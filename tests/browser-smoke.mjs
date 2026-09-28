/* 앱 전체 훑기 — 탭마다 그려지는지, 주요 흐름이 도는지, 콘솔 오류가 없는지.
 * 먼저 저장소 뿌리에서 `python3 -m http.server 8099` 를 띄워 두세요. */
import { openApp, reporter, dayKey as k } from './harness.mjs';

const { errors, step } = reporter();
const { browser, page } = await openApp(errors);

/** 이미 펼쳐져 있으면 그대로 두고, 접혀 있을 때만 폅니다. */
async function openGroup(name) {
  const names = await page.locator('.g-name').allTextContents();
  const i = names.indexOf(name);
  if (i < 0) throw new Error(`'${name}' 묶음이 없음: ` + JSON.stringify(names));
  const head = page.locator('.group-head').nth(i);
  if (await head.getAttribute('aria-expanded') !== 'true') {
    await head.click();
    await page.waitForSelector('.group.open .group-body');
  }
  return head;
}

await step('네 개 탭이 있고 캘린더가 첫 화면이다', async () => {
  const tabs = await page.locator('.tabbar button').allTextContents();
  if (JSON.stringify(tabs) !== JSON.stringify(['캘린더', '모아보기', '가계부', '설정']))
    throw new Error(JSON.stringify(tabs));
  const h = await page.textContent('#topbar h1');
  if (!h.startsWith('캘린더')) throw new Error('첫 화면이 ' + h);
  await page.waitForSelector('.cal-grid');
});

await step('할 일·디데이·가계부를 넣을 수 있다', async () => {
  await page.evaluate(async (d) => {
    const store = await import('./js/store.js');
    const money = await import('./js/money.js');
    const fs = await store.getFolders();
    const work = fs.find((f) => f.name === '업무').id;
    await store.saveItem({ title: '밀린 할 일', dueDate: d[0] });
    await store.saveItem({ title: '워크숍 준비', folderId: work, startDate: d[1], dueDate: d[2] });
    await store.saveItem({ title: '교재 사기', folderId: work, dueDate: d[2] });
    // 폴더에 든 디데이(기간 있음)와 폴더 없는 디데이를 둘 다 둡니다.
    await store.saveItem({ type: 'dday', title: '자격증 시험', folderId: work,
      startDate: d[5], dueDate: d[6] });
    await store.saveItem({ type: 'dday', title: '이사', dueDate: d[3] });
    await store.saveItem({ type: 'dday', title: '건강검진', dueDate: d[7] });
    await money.save({ date: d[4], amount: 12500, method: 'credit', category: 'food', memo: '점심' });
    await money.save({ date: d[4], amount: 3000000, type: 'income', method: 'transfer', category: 'salary' });
  }, [k(-3), k(-1), k(3), k(20), k(0), k(-20), k(30), k(7)]);
  await page.waitForTimeout(500);
});

await step('캘린더 위 요약이 한 줄로 줄어 달력이 위로 올라온다', async () => {
  const top = await page.evaluate(() => {
    const g = document.querySelector('.cal-grid');
    return g.getBoundingClientRect().top;
  });
  if (top > 560) throw new Error('달력이 너무 아래에서 시작: ' + Math.round(top));
  const chips = await page.locator('.sum-chip').count();
  if (!chips) throw new Error('요약 칩이 없음');
});

await step('기간 막대의 제목이 읽을 수 있는 크기다', async () => {
  const box = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.cal-bar')].find((x) => x.textContent.trim());
    if (!b) return null;
    const cs = getComputedStyle(b);
    return { h: b.getBoundingClientRect().height, size: parseFloat(cs.fontSize) };
  });
  if (!box) throw new Error('글씨가 있는 막대가 없음');
  if (box.h < 12) throw new Error('막대 높이가 ' + box.h);
  if (box.size < 9.5) throw new Error('글씨가 ' + box.size + 'px');
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

await step('막대가 있어도 그 날짜를 누를 수 있다', async () => {
  // 막대는 보이기만 하고 탭은 칸이 받습니다. 막대가 덮은 날도 골라져야 합니다.
  const day = await page.evaluate(() => {
    const bar = document.querySelector('.cal-bar');
    const r = bar.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit && hit.closest('.cal-cell') ? hit.closest('.cal-cell').textContent.trim() : null;
  });
  if (!day) throw new Error('막대 위를 눌러도 칸이 안 잡힘');
  await page.click('.cal-cell.today');
  await page.waitForSelector('.day-panel');
});

await step('고른 날짜가 기간 막대를 덮지 않는다', async () => {
  const z = await page.evaluate(() => {
    const bars = getComputedStyle(document.querySelector('.cal-bars')).zIndex;
    const cell = getComputedStyle(document.querySelector('.cal-cell.selected'));
    return { bars, cellZ: cell.zIndex, cellBg: cell.backgroundColor };
  });
  if (Number(z.bars) < 2) throw new Error('막대 z-index 가 ' + z.bars);
  if (z.cellZ !== 'auto') throw new Error('고른 칸에 z-index 가 붙음: ' + z.cellZ);
  const plain = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.cal-cell:not(.selected):not(.out):not(.overdue)')).backgroundColor);
  if (z.cellBg !== plain) throw new Error('고른 칸 배경이 달라 막대를 덮음: ' + z.cellBg);
});

await step('고른 날에 그 날 가계부도 같이 보인다', async () => {
  const t = await page.textContent('.day-panel');
  if (!t.includes('12,500원')) throw new Error('지출 없음');
  if (!t.includes('+3,000,000원')) throw new Error('수입 없음');
});

await step('모아보기에 디데이와 폴더가 한 화면에 모여 있다', async () => {
  await page.click('[data-tab="list"]');
  await page.waitForSelector('.group');
  const names = await page.locator('.g-name').allTextContents();
  if (names[0] !== '다가오는 디데이') throw new Error('첫 묶음이 ' + names[0]);
  if (!names.includes('폴더 없음')) throw new Error(JSON.stringify(names));
  if (names.length < 3) throw new Error('묶음이 ' + names.length + '개뿐: ' + JSON.stringify(names));
  const sub = await page.textContent('#topbar h1 .sub');
  if (!/디데이 \d+개 · 할 일 \d+개/.test(sub)) throw new Error(sub);
});

await step('처음에는 모두 접혀 있어 한 화면에 들어온다', async () => {
  if (await page.locator('.group-body').count()) throw new Error('펼쳐진 묶음이 있음');
  const bottom = await page.evaluate(() => {
    const gs = [...document.querySelectorAll('.group')];
    return gs[gs.length - 1].getBoundingClientRect().bottom;
  });
  if (bottom > 700) throw new Error('마지막 묶음이 화면 밖: ' + Math.round(bottom));
});

await step('묶음을 누르면 그 자리에서 펼쳐지고 다시 누르면 접힌다', async () => {
  const head = page.locator('.group-head').first();
  await head.click();
  await page.waitForSelector('.group.open .group-body');
  if (await head.getAttribute('aria-expanded') !== 'true') throw new Error('aria-expanded 안 바뀜');
  if (!await page.locator('.dd-row').count()) throw new Error('디데이 줄이 없음');
  await head.click();
  await page.waitForTimeout(250);
  if (await page.locator('.group-body').count()) throw new Error('다시 눌러도 안 접힘');
});

await step('폴더를 누르면 그 폴더의 디데이와 할 일이 같이 나온다', async () => {
  await openGroup('업무');
  const body = page.locator('.group.open .group-body');
  const dd = await body.locator('.dd-row').allTextContents();
  const tasks = await body.locator('.item').allTextContents();
  if (!dd.some((t) => t.includes('자격증 시험'))) throw new Error('디데이: ' + JSON.stringify(dd));
  if (!tasks.some((t) => t.includes('교재 사기'))) throw new Error('할 일: ' + JSON.stringify(tasks));
  // 폴더 안에서는 같은 폴더 이름을 또 붙이지 않습니다.
  if (tasks.some((t) => t.includes('업무'))) throw new Error('폴더 딱지가 남음: ' + JSON.stringify(tasks));
});

await step('기간이 있는 디데이는 줄 안에 진행 막대가 보인다', async () => {
  const bar = page.locator('.dd-row:has-text("자격증 시험") .progress > span');
  if (!await bar.count()) throw new Error('막대 없음');
  const w = await bar.evaluate((n) => n.getBoundingClientRect().width);
  if (w <= 0) throw new Error('막대 너비가 ' + w);
});

await step('디데이를 체크하면 목록에서 사라지고 되돌릴 수 있다', async () => {
  const body = page.locator('.group.open .group-body');
  const before = await body.locator('.dd-row').count();
  await body.locator('.dd-row .dd-check').first().click();
  await page.waitForTimeout(500);
  const after = await page.locator('.group.open .group-body .dd-row').count();
  if (after !== before - 1) throw new Error(`${before} → ${after}`);
  // 완료한 것은 '다가오는 디데이' 묶음 안 '완료함' 에서 되돌립니다.
  await openGroup('다가오는 디데이');
  await page.waitForSelector('.done-toggle');
  await page.click('.done-toggle');
  await page.waitForSelector('.dd-row.done');
  await page.click('.dd-row.done .dd-check');
  await page.waitForTimeout(500);
  if (await page.locator('.dd-row.done').count()) throw new Error('되돌리기 실패');
});

await step('전체 보기로 폴더 하나만 크게 볼 수 있다', async () => {
  await page.click('[data-tab="list"]');
  await page.waitForSelector('.group');
  await openGroup('업무');
  await page.waitForSelector('.group-more');
  await page.click('.group-more');
  await page.waitForSelector('.card-list');
  const h = await page.textContent('#topbar h1');
  if (!h.includes('업무')) throw new Error('제목이 ' + h);
  await page.click('[aria-label="뒤로"]');
  await page.waitForSelector('.group');
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

await step('폴더마다 색이 실제로 다르게 칠해진다', async () => {
  await page.click('[data-tab="list"]');
  await page.waitForSelector('.group');
  const colors = await page.evaluate(() => [...document.querySelectorAll('.group')]
    .map((g) => g.style.getPropertyValue('--fc')).filter(Boolean));
  if (colors.length < 3) throw new Error('색이 붙은 묶음이 ' + colors.length + '개');
  if (new Set(colors).size < 2) throw new Error('전부 같은 색: ' + JSON.stringify(colors));
});

console.log('\n오류:', errors.length ? errors.join('\n') : '없음');
await browser.close();
process.exit(errors.length ? 1 : 0);
