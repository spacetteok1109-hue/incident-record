/* 보안 손질이 실제로 막고 있는지 — 백업 가져오기 검사와 PIN 잠금.
 * 먼저 저장소 뿌리에서 `python3 -m http.server 8099` 를 띄워 두세요. */
import { openApp, reporter } from './harness.mjs';

const { errors, step } = reporter();
const { browser, page } = await openApp(errors);

/* 앱 밖으로 나가는 요청이 있으면 바로 잡습니다. */
const outbound = [];
await page.route('**/*', (route) => {
  const u = route.request().url();
  if (!u.startsWith('http://127.0.0.1:8099/') && !u.startsWith('data:') && !u.startsWith('blob:')) {
    outbound.push(u);
    return route.abort();
  }
  return route.continue();
});

const importBackup = (data, mode = 'merge') => page.evaluate(async ([d, m]) => {
  const store = await import('./js/store.js');
  try {
    return { ok: true, result: await store.importBackup(d, m) };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}, [data, mode]);

await step('이 앱 백업이 아니면 거절한다', async () => {
  const r = await importBackup({ app: 'something-else', items: [] });
  if (r.ok) throw new Error('받아들임');
  if (!r.message.includes('백업 파일이 아닙니다')) throw new Error(r.message);
});

await step('사진 자리에 바깥 주소를 넣어도 요청하지 않는다', async () => {
  const r = await importBackup({
    app: 'todo-cal',
    photos: [
      { id: 'p1', data: 'https://example.invalid/track.png' },
      { id: 'p2', data: 'http://127.0.0.1:9/leak' },
      { id: 'p3', data: 'blob:http://127.0.0.1:8099/abc' },
    ],
  });
  if (!r.ok) throw new Error('통째로 실패: ' + r.message);
  if (r.result.photos !== 0) throw new Error('사진이 ' + r.result.photos + '장 들어옴');
  if (r.result.skipped !== 3) throw new Error('건너뛴 수가 ' + r.result.skipped);
  if (outbound.length) throw new Error('바깥 요청이 나감: ' + JSON.stringify(outbound));
});

await step('html 을 담은 data URL 은 사진으로 받지 않는다', async () => {
  const r = await importBackup({
    app: 'todo-cal',
    photos: [{ id: 'h1', data: 'data:text/html;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64') }],
  });
  if (r.result.photos !== 0) throw new Error('받아들임');
});

await step('제대로 된 사진은 받아들이고 형식을 우리가 정한다', async () => {
  // 1x1 PNG
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const r = await importBackup({ app: 'todo-cal', photos: [{ id: 'ok1', data: png, name: 'x.png' }] });
  if (r.result.photos !== 1) throw new Error(JSON.stringify(r.result));
  const type = await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const row = await db.get('photos', 'ok1');
    return row && row.blob && row.blob.type;
  });
  if (type !== 'image/png') throw new Error('형식이 ' + type);
});

await step('엉뚱한 모양의 줄은 버리고 쓸 만한 것만 담는다', async () => {
  const r = await importBackup({
    app: 'todo-cal',
    items: [
      { id: 'good', title: '진짜 할 일', dueDate: '2026-10-20' },
      { id: 'bad-date', title: '날짜가 이상함', dueDate: '어제' },
      { title: '아이디 없음' },
      'not an object',
      { id: 'evil', title: 'x', repeat: 'rm -rf', folderId: { nested: 1 }, checklist: 'nope' },
    ],
    expenses: [
      { id: 'e1', date: '2026-10-07', amount: '12,000', type: 'income' },
      { id: 'e2', date: '없음', amount: 1000 },
      { id: 'e3', date: '2026-10-07', amount: -500, installment: 999 },
    ],
  });
  if (r.result.items !== 3) throw new Error('항목 ' + r.result.items + '개');
  if (r.result.expenses !== 2) throw new Error('가계부 ' + r.result.expenses + '건');

  const got = await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const [bad, evil, e1, e3] = await Promise.all([
      db.get('items', 'bad-date'), db.get('items', 'evil'),
      db.get('expenses', 'e1'), db.get('expenses', 'e3'),
    ]);
    return {
      badDate: bad.dueDate, repeat: evil.repeat, folderId: evil.folderId,
      checklist: evil.checklist, amount: e1.amount, installment: e3.installment, neg: e3.amount,
    };
  });
  if (got.badDate !== null) throw new Error('이상한 날짜가 남음: ' + got.badDate);
  if (got.repeat !== 'none') throw new Error('모르는 반복값이 남음: ' + got.repeat);
  if (got.folderId !== null) throw new Error('객체가 폴더 아이디로 들어감');
  if (!Array.isArray(got.checklist)) throw new Error('체크리스트가 배열이 아님');
  if (got.amount !== 0) throw new Error('문자열 금액이 ' + got.amount);
  if (got.installment !== 36) throw new Error('할부가 ' + got.installment);
  if (got.neg !== 0) throw new Error('음수 금액이 ' + got.neg);
});

await step('아주 긴 글은 잘라서 담는다', async () => {
  const r = await importBackup({
    app: 'todo-cal',
    items: [{ id: 'long', title: 'ㄱ'.repeat(5000), memo: 'ㄴ'.repeat(99999) }],
  });
  if (!r.ok) throw new Error(r.message);
  const sizes = await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const it = await db.get('items', 'long');
    return [it.title.length, it.memo.length];
  });
  if (sizes[0] > 200 || sizes[1] > 5000) throw new Error(JSON.stringify(sizes));
});

/* ---------------- PIN ---------------- */

await step('여러 번 틀리면 잠시 기다리게 한다', async () => {
  const out = await page.evaluate(async () => {
    const lock = await import('./js/lock.js');
    await lock.setPin('1234');
    const tries = [];
    for (let i = 0; i < 6; i += 1) tries.push(await lock.verify('0000'));
    const wait = await lock.lockoutRemainingMs();
    // 잠긴 동안에는 맞는 PIN 도 통과하지 않습니다.
    const rightWhileLocked = await lock.verify('1234');
    return { tries, wait, rightWhileLocked };
  });
  if (out.tries.some(Boolean)) throw new Error('틀린 PIN 이 통과함');
  if (out.wait <= 0) throw new Error('기다림이 안 걸림');
  if (out.rightWhileLocked) throw new Error('잠긴 동안 통과함');
});

await step('기다림이 풀리면 맞는 PIN 으로 열리고 횟수가 초기화된다', async () => {
  const out = await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const lock = await import('./js/lock.js');
    const cfg = await db.getMeta('lock');
    // 시간이 지난 것처럼 되돌려 둡니다.
    await db.setMeta('lock', { ...cfg, lastFailAt: Date.now() - 60 * 60 * 1000 });
    const ok = await lock.verify('1234');
    const after = await db.getMeta('lock');
    return { ok, fails: after.fails, wait: await lock.lockoutRemainingMs() };
  });
  if (!out.ok) throw new Error('맞는 PIN 인데 안 열림');
  if (out.fails !== 0) throw new Error('틀린 횟수가 ' + out.fails);
  if (out.wait !== 0) throw new Error('아직 기다림이 남음');
});

await step('PIN 은 그대로 저장되지 않는다', async () => {
  const cfg = await page.evaluate(async () => {
    const db = await import('./js/db.js');
    return db.getMeta('lock');
  });
  const text = JSON.stringify(cfg);
  if (text.includes('1234')) throw new Error('PIN 이 그대로 들어 있음: ' + text);
  if (!cfg.salt || !cfg.hash) throw new Error('salt/hash 가 없음');
  if (cfg.hash.length !== 64) throw new Error('해시 길이가 ' + cfg.hash.length);
  if ((cfg.iterations || 0) < 100000) throw new Error('반복이 ' + cfg.iterations);
  await page.evaluate(async () => {
    const lock = await import('./js/lock.js');
    await lock.disable('1234');
  });
});

await step('앱이 바깥으로 아무것도 보내지 않는다', async () => {
  if (outbound.length) throw new Error(JSON.stringify(outbound));
});

console.log('\n오류:', errors.length ? errors.join('\n') : '없음');
await browser.close();
process.exit(errors.length ? 1 : 0);
