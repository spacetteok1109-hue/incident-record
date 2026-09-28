/* 브라우저 검사 공통 준비물.
 * Playwright 는 이 환경에 전역으로 깔려 있어서 경로로 직접 읽습니다.
 * 다른 곳에서 돌릴 때는 PLAYWRIGHT_MODULE 로 경로를 알려 주세요.
 */
const MODULE = process.env.PLAYWRIGHT_MODULE
  || '/opt/node22/lib/node_modules/playwright/index.js';

const pw = (await import(MODULE)).default;

export const { chromium, devices } = pw;
export const BASE = process.env.APP_BASE || 'http://127.0.0.1:8099';

/** 이 앱은 기기 현지 날짜(Asia/Seoul)를 씁니다. 검사도 같은 기준으로 계산해야 합니다. */
export function dayKey(offset = 0) {
  return new Date(Date.now() + 9 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
}

export function reporter() {
  const errors = [];
  const step = async (name, fn) => {
    try {
      await fn();
      console.log('  ✓ ' + name);
    } catch (e) {
      console.log('  ✗ ' + name + ' — ' + e.message);
      errors.push(name + ': ' + e.message);
    }
  };
  return { errors, step };
}

/** 콘솔 오류까지 잡아 두는 아이폰 크기 페이지 */
export async function openApp(errors) {
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--proxy-server=direct://', '--proxy-bypass-list=*'],
  });
  const ctx = await browser.newContext({
    ...devices['iPhone 13'], locale: 'ko-KR', timezoneId: 'Asia/Seoul',
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${BASE}/app/index.html`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.tabbar');
  return { browser, page };
}
