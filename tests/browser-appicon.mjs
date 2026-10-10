/* 가진 사진으로 앱 아이콘 바꾸기.
 * 먼저 저장소 뿌리에서 `python3 -m http.server 8099` 를 띄워 두세요. */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openApp, reporter } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PIC = join(here, 'fixtures-icon.png');

const { errors, step } = reporter();
const { browser, page } = await openApp(errors);

const openIconSheet = async () => {
  if (await page.locator('.sheet').count()) {
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.tabbar');
  }
  await page.click('[data-tab="settings"]');
  await page.waitForSelector('.settings-group');
  await page.click('.settings-row:has(.label:text-is("앱 아이콘"))');
  await page.waitForSelector('.icon-preview');
};

await step('처음에는 기본 아이콘이다', async () => {
  await openIconSheet();
  const note = await page.textContent('.ip-note');
  if (note.trim() !== '기본 아이콘') throw new Error(note);
  const src = await page.getAttribute('.ip-img', 'src');
  if (!src.includes('icon-512.png')) throw new Error(src);
});

await step('사진을 고르면 정사각형 아이콘 세 벌이 만들어진다', async () => {
  await page.setInputFiles('.sheet input[type="file"]', PIC);
  await page.waitForTimeout(900);
  const note = await page.textContent('.ip-note');
  if (note.trim() !== '내가 고른 사진') throw new Error(note);

  const info = await page.evaluate(async () => {
    const media = await import('./js/media.js');
    const saved = await media.getAppIcon();
    if (!saved) return null;
    const read = async (b) => {
      const bmp = await createImageBitmap(b);
      const out = { w: bmp.width, h: bmp.height, type: b.type, size: b.size };
      bmp.close();
      return out;
    };
    return { i512: await read(saved.i512), i192: await read(saved.i192), i180: await read(saved.i180) };
  });
  if (!info) throw new Error('저장된 아이콘이 없음');
  const want = { i512: 512, i192: 192, i180: 180 };
  for (const [k, size] of Object.entries(want)) {
    if (info[k].w !== size || info[k].h !== size) throw new Error(`${k}: ${info[k].w}x${info[k].h}`);
    if (info[k].type !== 'image/png') throw new Error(`${k} 형식이 ${info[k].type}`);
    if (!info[k].size) throw new Error(`${k} 가 비어 있음`);
  }
});

await step('탭 아이콘이 바로 바뀐다', async () => {
  const href = await page.getAttribute('#app-favicon', 'href');
  if (!href.startsWith('blob:')) throw new Error('favicon 이 ' + href);
  const apple = await page.getAttribute('link[rel="apple-touch-icon"]', 'href');
  if (!apple.startsWith('blob:')) throw new Error('apple-touch-icon 이 ' + apple);
});

await step('서비스 워커가 매니페스트 주소로 내 사진을 내보낸다', async () => {
  // 서비스 워커가 자리 잡을 때까지 기다립니다.
  await page.evaluate(() => navigator.serviceWorker.ready);
  const out = await page.evaluate(async () => {
    const urls = [
      './icons/icon-512.png', './icons/icon-192.png',
      './icons/icon-maskable-512.png', './icons/apple-touch-icon.png',
    ];
    const res = [];
    for (const u of urls) {
      const r = await fetch(u, { cache: 'no-store' });
      const b = await r.blob();
      const bmp = await createImageBitmap(b);
      res.push({ u, w: bmp.width, type: b.type });
      bmp.close();
    }
    return res;
  });
  const want = { './icons/icon-512.png': 512, './icons/icon-192.png': 192,
    './icons/icon-maskable-512.png': 512, './icons/apple-touch-icon.png': 180 };
  for (const r of out) {
    if (r.type !== 'image/png') throw new Error(`${r.u} 형식이 ${r.type}`);
    if (r.w !== want[r.u]) throw new Error(`${r.u} 너비가 ${r.w}`);
  }
  // 내 사진이 맞는지 — 기본 아이콘은 가운데가 흰색, 테스트 사진은 주황 한 색입니다.
  const mid = await page.evaluate(async () => {
    const r = await fetch('./icons/icon-192.png', { cache: 'no-store' });
    const bmp = await createImageBitmap(await r.blob());
    const cv = document.createElement('canvas');
    cv.width = cv.height = bmp.width;
    cv.getContext('2d').drawImage(bmp, 0, 0);
    const d = cv.getContext('2d').getImageData(96, 96, 1, 1).data;
    bmp.close();
    return [d[0], d[1], d[2]];
  });
  if (!(mid[0] > 230 && mid[1] > 110 && mid[1] < 170 && mid[2] < 80))
    throw new Error('기본 아이콘이 그대로 나옴: ' + JSON.stringify(mid));
});

await step('크롬이 읽는 매니페스트에 내 사진이 통째로 들어간다', async () => {
  /* 홈 화면에 추가할 때 브라우저는 아이콘 파일을 따로 내려받는데, 그 요청은
     서비스 워커를 거치지 않습니다. 그래서 아이콘 주소를 가로채는 것만으로는
     모자라고, 매니페스트 안에 그림이 들어 있어야 합니다.
     Page.getAppManifest 는 크롬이 설치할 때 쓰는 바로 그 경로입니다. */
  await page.evaluate(() => navigator.serviceWorker.ready);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.enable');
  const m = await cdp.send('Page.getAppManifest');
  if (m.errors && m.errors.length) throw new Error('매니페스트 오류: ' + JSON.stringify(m.errors));

  const icons = (JSON.parse(m.data || '{}').icons) || [];
  if (!icons.length) throw new Error('아이콘이 없음');
  const external = icons.filter((i) => !i.src.startsWith('data:'));
  if (external.length) throw new Error('따로 내려받아야 하는 아이콘이 남음: ' + JSON.stringify(external));

  const sizes = icons.map((i) => i.sizes).sort();
  if (JSON.stringify(sizes) !== JSON.stringify(['192x192', '512x512'])) throw new Error(JSON.stringify(sizes));
  if (!icons.some((i) => (i.purpose || '').includes('maskable'))) throw new Error('maskable 이 없음');

  // 담긴 그림이 정말 내 사진인지 — 가운데 픽셀 색으로 확인합니다.
  const big = icons.find((i) => i.sizes === '512x512').src;
  // CSP 가 connect-src 'self' 라 data: 를 fetch 할 수 없습니다.
  // img-src 는 data: 를 허용하므로 <img> 로 불러옵니다.
  const mid = await page.evaluate((src) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth;
      cv.height = img.naturalHeight;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(Math.floor(cv.width / 2), Math.floor(cv.height / 2), 1, 1).data;
      resolve([d[0], d[1], d[2], cv.width]);
    };
    img.onerror = () => reject(new Error('그림을 못 읽음'));
    img.src = src;
  }), big);
  if (mid[3] !== 512) throw new Error('담긴 그림 크기가 ' + mid[3]);
  if (!(mid[0] > 230 && mid[1] > 110 && mid[1] < 170 && mid[2] < 80))
    throw new Error('기본 아이콘이 담김: ' + JSON.stringify(mid));
});

await step('앱을 다시 열어도 내 아이콘이 남아 있다', async () => {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.tabbar');
  const href = await page.getAttribute('#app-favicon', 'href');
  if (!href.startsWith('blob:')) throw new Error('favicon 이 ' + href);
  await page.click('[data-tab="settings"]');
  await page.waitForSelector('.settings-group');
  const row = await page.textContent('.settings-row:has(.label:text-is("앱 아이콘"))');
  if (!row.includes('내 사진')) throw new Error(row);
});

await step('기본 아이콘으로 되돌릴 수 있다', async () => {
  await openIconSheet();
  await page.click('.icon-foot button:has-text("기본 아이콘으로 되돌리기")');
  await page.waitForTimeout(700);
  const note = await page.textContent('.ip-note');
  if (note.trim() !== '기본 아이콘') throw new Error(note);
  const href = await page.getAttribute('#app-favicon', 'href');
  if (href.startsWith('blob:')) throw new Error('아직 blob: ' + href);

  const mid = await page.evaluate(async () => {
    const r = await fetch('./icons/icon-192.png', { cache: 'no-store' });
    const bmp = await createImageBitmap(await r.blob());
    const cv = document.createElement('canvas');
    cv.width = cv.height = bmp.width;
    cv.getContext('2d').drawImage(bmp, 0, 0);
    const d = cv.getContext('2d').getImageData(96, 96, 1, 1).data;
    bmp.close();
    return [d[0], d[1], d[2]];
  });
  if (mid[0] > 230 && mid[1] > 110 && mid[1] < 170 && mid[2] < 80)
    throw new Error('아직 내 사진이 나옴: ' + JSON.stringify(mid));
});

await step('되돌리면 매니페스트도 기본 아이콘으로 간다', async () => {
  await page.evaluate(() => navigator.serviceWorker.ready);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.enable');
  const m = await cdp.send('Page.getAppManifest');
  if (m.errors && m.errors.length) throw new Error('매니페스트 오류: ' + JSON.stringify(m.errors));
  const icons = (JSON.parse(m.data || '{}').icons) || [];
  if (icons.length !== 3) throw new Error('아이콘이 ' + icons.length + '개');
  if (icons.some((i) => i.src.startsWith('data:'))) throw new Error('아직 내 사진이 박혀 있음');
});

await step('이미지가 아닌 파일은 거절한다', async () => {
  const msg = await page.evaluate(async () => {
    const media = await import('./js/media.js');
    try {
      await media.setAppIcon(new File(['hello'], 'a.txt', { type: 'text/plain' }));
      return null;
    } catch (e) { return e.message; }
  });
  if (!msg || !msg.includes('이미지')) throw new Error('거절하지 않음: ' + msg);
});

console.log('\n오류:', errors.length ? errors.join('\n') : '없음');
await browser.close();
process.exit(errors.length ? 1 : 0);
