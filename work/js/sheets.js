/*
 * sheets.js — 구글 스프레드시트 백업
 *
 * 서버 없이 브라우저에서 직접 구글에 로그인하고(구글 Identity Services),
 * 로그인한 계정의 드라이브에 스프레드시트 하나를 만들어 그 안을 최신 내용으로
 * 덮어씁니다.
 *
 * 권한은 `drive.file` 하나만 씁니다. 이 앱이 만든 파일 한 개에만 접근할 수 있고,
 * 드라이브의 다른 파일은 읽지도 쓰지도 못합니다.
 */

import * as db from './db.js';
import * as store from './store.js';
import { WEEKDAYS, fromDateKey, num, formatMonth } from './util.js';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const SCOPES = 'https://www.googleapis.com/auth/drive.file openid email';
const SHEET_TITLES = ['팀원', '현장', '출역', '가불', '월정산'];

const META = {
  clientId: 'google.clientId',
  spreadsheetId: 'google.spreadsheetId',
  email: 'google.email',
  auto: 'google.auto',
  lastBackup: 'google.lastBackupAt',
  fileName: 'google.fileName',
};

let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;

/* ---------------- 설정 읽기/쓰기 ---------------- */

export async function config() {
  const [clientId, spreadsheetId, email, auto, lastBackup, fileName] = await Promise.all([
    db.getMeta(META.clientId, ''),
    db.getMeta(META.spreadsheetId, ''),
    db.getMeta(META.email, ''),
    db.getMeta(META.auto, false),
    db.getMeta(META.lastBackup, 0),
    db.getMeta(META.fileName, '현장 관리 백업'),
  ]);
  return { clientId, spreadsheetId, email, auto, lastBackup, fileName };
}

export async function setClientId(id) {
  const clean = String(id || '').trim();
  await db.setMeta(META.clientId, clean);
  tokenClient = null;
  accessToken = null;
  return clean;
}

export async function setAuto(on) {
  await db.setMeta(META.auto, !!on);
}

export async function setFileName(name) {
  await db.setMeta(META.fileName, String(name || '').trim() || '현장 관리 백업');
}

export function isConnected() {
  return !!accessToken && Date.now() < tokenExpiresAt;
}

export async function spreadsheetUrl() {
  const { spreadsheetId } = await config();
  return spreadsheetId ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` : '';
}

/* ---------------- 구글 로그인 ---------------- */

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${GIS_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('구글 로그인 스크립트를 불러오지 못했습니다.')));
      return;
    }
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('구글에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.'));
    document.head.append(s);
  });
}

async function ensureTokenClient() {
  const { clientId } = await config();
  if (!clientId) {
    throw new Error('먼저 구글 클라이언트 ID를 입력해 주세요. (설정 → 구글 백업 → 클라이언트 ID)');
  }
  await loadGis();
  if (!tokenClient) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: () => {},   // requestToken() 안에서 매번 새로 지정합니다
    });
  }
  return tokenClient;
}

/**
 * 액세스 토큰을 받아 옵니다.
 * interactive=false 면 창을 띄우지 않고 조용히 갱신만 시도합니다.
 */
function requestToken({ interactive = true } = {}) {
  return ensureTokenClient().then((client) => new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };

    client.callback = (resp) => {
      if (resp.error) {
        done(reject, new Error(authErrorText(resp.error)));
        return;
      }
      accessToken = resp.access_token;
      tokenExpiresAt = Date.now() + (num(resp.expires_in) || 3600) * 1000 - 60000;
      done(resolve, accessToken);
    };
    client.error_callback = (err) => {
      done(reject, new Error(authErrorText(err?.type || err?.error)));
    };

    try {
      client.requestAccessToken({ prompt: interactive ? 'consent' : '' });
    } catch (e) {
      done(reject, e);
    }

    // 조용한 갱신은 응답이 없으면 그냥 실패로 둡니다.
    if (!interactive) {
      setTimeout(() => done(reject, new Error('자동 로그인이 만료되었습니다. 다시 연결해 주세요.')), 12000);
    }
  }));
}

function authErrorText(code) {
  switch (code) {
    case 'popup_closed':
    case 'popup_failed_to_open':
      return '구글 로그인 창이 닫혔습니다. 팝업 차단을 풀고 다시 시도해 주세요.';
    case 'access_denied':
      return '권한을 허용해야 백업할 수 있습니다.';
    case 'idpiframe_initialization_failed':
      return '브라우저가 구글 로그인을 막고 있습니다. 쿠키 차단 설정을 확인해 주세요.';
    default:
      return `구글 로그인에 실패했습니다. (${code || '알 수 없는 오류'})`;
  }
}

async function token({ interactive = true } = {}) {
  if (isConnected()) return accessToken;
  return requestToken({ interactive });
}

/** 설정 화면의 '구글 계정 연결' 버튼 */
export async function connect() {
  await requestToken({ interactive: true });
  const email = await fetchEmail();
  if (email) await db.setMeta(META.email, email);
  return email;
}

export async function disconnect() {
  if (accessToken && window.google?.accounts?.oauth2) {
    try { window.google.accounts.oauth2.revoke(accessToken); } catch { /* 이미 만료된 토큰 */ }
  }
  accessToken = null;
  tokenExpiresAt = 0;
  await db.setMeta(META.email, '');
  await db.setMeta(META.auto, false);
}

/** 백업 파일 연결만 끊고 계정은 그대로 둡니다(다음 백업 때 새 파일 생성). */
export async function forgetSpreadsheet() {
  await db.setMeta(META.spreadsheetId, '');
  await db.setMeta(META.lastBackup, 0);
}

async function fetchEmail() {
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return '';
    const j = await r.json();
    return j.email || '';
  } catch {
    return '';
  }
}

/* ---------------- 구글 API 호출 ---------------- */

async function api(url, { method = 'GET', body, interactive = true } = {}) {
  const t = await token({ interactive });
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${t}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    accessToken = null;
    tokenExpiresAt = 0;
    throw new Error('구글 로그인이 만료되었습니다. 설정에서 다시 연결해 주세요.');
  }
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j.error?.message || '';
    } catch { /* 본문이 JSON이 아닐 수 있습니다 */ }
    throw new Error(`구글 스프레드시트 오류 (${res.status}) ${detail}`.trim());
  }
  return res.status === 204 ? null : res.json();
}

/** 백업용 스프레드시트를 찾거나 새로 만듭니다. */
async function ensureSpreadsheet({ interactive = true } = {}) {
  const { spreadsheetId, fileName } = await config();
  if (spreadsheetId) {
    try {
      const meta = await api(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=spreadsheetId,sheets.properties`,
        { interactive },
      );
      return meta;
    } catch (e) {
      // 사용자가 드라이브에서 파일을 지웠을 수 있습니다. 새로 만듭니다.
      if (!/404|찾을 수 없|not found/i.test(e.message)) throw e;
      await db.setMeta(META.spreadsheetId, '');
    }
  }
  const created = await api('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    interactive,
    body: {
      properties: { title: fileName, locale: 'ko_KR' },
      sheets: SHEET_TITLES.map((title, i) => ({
        properties: { title, index: i, gridProperties: { frozenRowCount: 1 } },
      })),
    },
  });
  await db.setMeta(META.spreadsheetId, created.spreadsheetId);
  return created;
}

/* ---------------- 표 만들기 ---------------- */

function yn(v) { return v ? 'O' : ''; }

function dayName(dateKey) {
  const d = fromDateKey(dateKey);
  return d ? WEEKDAYS[d.getDay()] : '';
}

async function buildTables() {
  const [workers, sites, months] = await Promise.all([
    store.getWorkers(), store.getSites(), store.activeMonths(),
  ]);
  const balances = await store.advanceBalances();
  const workerName = (id) => workers.find((w) => w.id === id)?.name || '(삭제됨)';
  const siteName = (id) => sites.find((s) => s.id === id)?.name || '(삭제됨)';

  const 팀원 = [
    ['이름', '생년', '연락처', '일당', '자차', '차량수당', '은행', '계좌번호', '예금주', '가불잔액', '상태', '메모'],
    ...workers.map((w) => [
      w.name, w.birthYear || '', w.phone || '', num(w.dailyWage), yn(w.hasCar), num(w.carPay),
      w.bankName || '', w.bankAccount || '', w.bankHolder || '',
      num(balances[w.id] || 0), w.active === false ? '숨김' : '활동', w.memo || '',
    ]),
  ];

  const 현장 = [
    ['현장명', '주소', '단가', '업체·원청', '연락처', '시작일', '종료일', '상태', '메모'],
    ...sites.map((s) => [
      s.name, s.address || '', num(s.unitPrice), s.client || '', s.contact || '',
      s.startDate || '', s.endDate || '', s.active === false ? '종료' : '진행', s.memo || '',
    ]),
  ];

  const works = (await db.getAll('works')).slice().sort((a, b) => (a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0));
  const 출역 = [
    ['날짜', '요일', '현장', '팀원', '일당', '공수', '일당합계', '자차', '차량수당', '지급액', '지급완료', '메모'],
    ...works.map((w) => [
      w.dateKey, dayName(w.dateKey), siteName(w.siteId), workerName(w.workerId),
      num(w.wage), num(w.gongsu), store.workWagePart(w),
      yn(w.carUsed), store.workCarPart(w), store.workTotal(w),
      yn(w.paid), w.memo || '',
    ]),
  ];

  const advances = (await db.getAll('advances')).slice().sort((a, b) => (a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0));
  const 가불 = [
    ['날짜', '팀원', '구분', '금액', '메모'],
    ...advances.map((a) => [
      a.dateKey, workerName(a.workerId), a.kind === 'repay' ? '상환' : '가불', num(a.amount), a.memo || '',
    ]),
  ];

  const 월정산 = [['월', '팀원', '출역일수', '공수', '일당합계', '차량수당', '총액', '가불', '상환', '실지급', '가불잔액']];
  for (const m of months.slice().sort()) {
    const rep = await store.monthlyReport(m);
    for (const r of rep.byWorker) {
      월정산.push([
        formatMonth(m), r.name, r.days, r.gongsu, r.wagePay, r.carPay, r.total,
        r.advance, r.repay, r.net, r.balance,
      ]);
    }
    if (rep.byWorker.length) {
      월정산.push([formatMonth(m), '합계', rep.totals.days, rep.totals.gongsu, rep.totals.wagePay,
        rep.totals.carPay, rep.totals.total, rep.totals.advance, rep.totals.repay, rep.totals.net, '']);
    }
  }

  return { 팀원, 현장, 출역, 가불, 월정산 };
}

/* ---------------- 백업 실행 ---------------- */

let running = null;

/**
 * 스프레드시트를 최신 내용으로 덮어씁니다.
 * interactive=false 면 로그인 창을 띄우지 않고, 조용히 실패합니다.
 */
export async function backup({ interactive = true } = {}) {
  if (running) return running;
  running = doBackup({ interactive }).finally(() => { running = null; });
  return running;
}

async function doBackup({ interactive }) {
  const meta = await ensureSpreadsheet({ interactive });
  const spreadsheetId = meta.spreadsheetId;
  const tables = await buildTables();

  // 1) 없는 시트는 만들고, 있는 시트는 크기를 데이터에 맞춥니다.
  const existing = new Map((meta.sheets || []).map((s) => [s.properties.title, s.properties]));
  const requests = [];
  for (const title of SHEET_TITLES) {
    const rows = tables[title];
    const rowCount = Math.max(rows.length, 2);
    const colCount = Math.max(rows[0].length, 1);
    const props = existing.get(title);
    if (!props) {
      requests.push({
        addSheet: {
          properties: {
            title,
            gridProperties: { rowCount, columnCount: colCount, frozenRowCount: 1 },
          },
        },
      });
    } else {
      requests.push({
        updateSheetProperties: {
          properties: {
            sheetId: props.sheetId,
            gridProperties: { rowCount, columnCount: colCount, frozenRowCount: 1 },
          },
          fields: 'gridProperties(rowCount,columnCount,frozenRowCount)',
        },
      });
      requests.push({
        repeatCell: {
          range: { sheetId: props.sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat.bold',
        },
      });
    }
  }
  if (requests.length) {
    await api(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: 'POST', interactive, body: { requests },
    });
  }

  // 2) 내용을 통째로 덮어씁니다.
  await api(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`, {
    method: 'POST',
    interactive,
    body: {
      valueInputOption: 'RAW',
      data: SHEET_TITLES.map((title) => ({ range: `'${title}'!A1`, values: tables[title] })),
    },
  });

  const at = Date.now();
  await db.setMeta(META.lastBackup, at);
  return { spreadsheetId, at, rows: SHEET_TITLES.reduce((n, t) => n + tables[t].length - 1, 0) };
}

/* ---------------- 자동 백업 ---------------- */

let queued = null;

/**
 * 데이터가 바뀌면 호출됩니다. 자동 백업이 켜져 있고 인터넷이 연결돼 있을 때만
 * 잠시 모았다가 한 번에 올립니다.
 */
export function scheduleAutoBackup() {
  clearTimeout(queued);
  queued = setTimeout(async () => {
    try {
      const { auto, clientId } = await config();
      if (!auto || !clientId || !navigator.onLine) return;
      await backup({ interactive: false });
    } catch (e) {
      // 자동 백업 실패는 조용히 넘어갑니다. 설정 화면에 마지막 시각으로 드러납니다.
      console.warn('자동 백업 실패:', e.message);
    }
  }, 20000);
}

/** 앱을 켤 때 한 번 조용히 백업을 시도합니다. */
export async function backupOnStart() {
  try {
    const { auto, clientId, spreadsheetId } = await config();
    if (!auto || !clientId || !spreadsheetId || !navigator.onLine) return;
    await backup({ interactive: false });
  } catch (e) {
    console.warn('시작 시 백업 건너뜀:', e.message);
  }
}
