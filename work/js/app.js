/* app.js — 화면 구성과 앱 시작 */

import { $, el, toast, openSheet, confirmDialog, pickerSheet, onLongPress } from './ui.js';
import * as store from './store.js';
import * as db from './db.js';
import * as lock from './lock.js';
import * as exporter from './export.js';
import { editWorker, editSite, editWork, assignSheet, editAdvance } from './editor.js';
import {
  WEEKDAYS, todayKey, monthKey, monthGrid, formatDate, formatDateShort, formatMonth,
  shiftMonthKey, relativeTag, won, comma, manwon, gongsu as fmtGongsu, num,
  bytesToText, debounce, maskAccount,
} from './util.js';

const APP_VERSION = 'v1';

const state = {
  tab: 'cal',
  month: monthKey(),          // 달력 · 정산이 보고 있는 달
  selectedDate: todayKey(),
  reportMonth: monthKey(),
  theme: 'auto',
};

const main = () => $('#view');

/* ==========================================================
   시작
   ========================================================== */

async function boot() {
  state.theme = localStorage.getItem('theme') || 'auto';
  applyTheme(state.theme);

  if (await lock.isEnabled()) await showLockScreen();

  buildShell();
  store.subscribe(render);
  await render();

  db.requestPersistence();
  registerServiceWorker();
  setupAutoLock();
}

function buildShell() {
  const app = $('#app');
  app.textContent = '';
  app.append(
    el('header', { class: 'topbar', id: 'topbar' }),
    el('main', { id: 'view' }),
    buildTabbar(),
    el('button', {
      type: 'button',
      class: 'fab',
      id: 'fab',
      'aria-label': '추가',
      text: '＋',
      onclick: onFab,
    }),
  );
}

const TABS = [
  { id: 'cal', label: '일정', ico: '📅' },
  { id: 'workers', label: '팀원', ico: '👷' },
  { id: 'sites', label: '현장', ico: '🏗️' },
  { id: 'report', label: '정산', ico: '📊' },
  { id: 'settings', label: '설정', ico: '⚙️' },
];

function buildTabbar() {
  const bar = el('nav', { class: 'tabbar', id: 'tabbar' });
  TABS.forEach((t) => {
    bar.append(el('button', {
      type: 'button',
      dataset: { tab: t.id },
      onclick: () => go(t.id),
    }, [
      el('span', { class: 'ico', text: t.ico }),
      el('span', { text: t.label }),
    ]));
  });
  return bar;
}

function go(tab) {
  state.tab = tab;
  window.scrollTo(0, 0);
  render();
}

function onFab() {
  if (state.tab === 'workers') return editWorker();
  if (state.tab === 'sites') return editSite();
  return assignSheet({ dateKey: state.selectedDate });
}

/* ==========================================================
   화면 그리기
   ========================================================== */

let rendering = false;
let renderQueued = false;

async function render() {
  if (rendering) { renderQueued = true; return; }
  rendering = true;
  try {
    const view = main();
    if (!view) return;
    const [header, content] = await ({
      cal: renderCalendar,
      workers: renderWorkers,
      sites: renderSites,
      report: renderReport,
      settings: renderSettings,
    }[state.tab])();

    const bar = $('#topbar');
    bar.textContent = '';
    (Array.isArray(header) ? header : [header]).forEach((n) => n && bar.append(n));

    view.textContent = '';
    (Array.isArray(content) ? content : [content]).forEach((n) => n && view.append(n));

    document.querySelectorAll('#tabbar button').forEach((b) => {
      b.setAttribute('aria-selected', String(b.dataset.tab === state.tab));
    });
    const fab = $('#fab');
    fab.style.display = state.tab === 'report' || state.tab === 'settings' ? 'none' : '';
  } finally {
    rendering = false;
    if (renderQueued) { renderQueued = false; render(); }
  }
}

function title(text, sub) {
  return el('h1', {}, [text, sub ? el('span', { class: 'sub', text: sub }) : null]);
}

function iconBtn(ico, label, onclick) {
  return el('button', { type: 'button', class: 'icon-btn', 'aria-label': label, text: ico, onclick });
}

function section(text, right) {
  return el('div', { class: 'section-title' }, [
    el('span', { text }),
    right ? el('span', { style: { marginLeft: 'auto', fontWeight: '600', color: 'var(--text-dim)' }, text: right }) : null,
  ]);
}

function emptyBox(emoji, text, actionLabel, onAction) {
  return el('div', { class: 'empty' }, [
    el('span', { class: 'big', text: emoji }),
    el('p', { text }),
    actionLabel ? el('button', { type: 'button', class: 'btn primary', text: actionLabel, onclick: onAction, style: { marginTop: '4px' } }) : null,
  ]);
}

/* ==========================================================
   일정 (달력)
   ========================================================== */

async function renderCalendar() {
  const [y, m] = state.month.split('-').map(Number);
  const header = [
    title('현장 일정', formatMonth(state.month)),
    iconBtn('📆', '오늘로', () => {
      state.month = monthKey();
      state.selectedDate = todayKey();
      render();
    }),
  ];

  const content = [];
  const sites = await store.getSites();
  const workers = await store.getWorkers();
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const workerById = new Map(workers.map((w) => [w.id, w]));

  content.push(el('div', { class: 'cal-head' }, [
    el('button', { type: 'button', text: '‹', 'aria-label': '이전 달', onclick: () => shiftMonth(-1) }),
    el('div', { class: 'month', text: formatMonth(state.month) }),
    el('button', { type: 'button', text: '›', 'aria-label': '다음 달', onclick: () => shiftMonth(1) }),
  ]));

  const wd = el('div', { class: 'weekdays' });
  WEEKDAYS.forEach((w, i) => wd.append(el('div', {
    class: i === 0 ? 'sun' : i === 6 ? 'sat' : '',
    text: w,
  })));
  content.push(wd);

  const summary = await store.monthCalendarSummary(state.month);
  const grid = el('div', { class: 'cal-grid' });
  monthGrid(y, m - 1).forEach((cell) => {
    const dow = cell.date.getDay();
    const s = summary[cell.key];
    const btn = el('button', {
      type: 'button',
      class: [
        'cal-cell',
        cell.inMonth ? '' : 'out',
        cell.isToday ? 'today' : '',
        state.selectedDate === cell.key ? 'selected' : '',
        dow === 0 ? 'sun' : dow === 6 ? 'sat' : '',
      ].filter(Boolean).join(' '),
      'aria-label': `${cell.date.getMonth() + 1}월 ${cell.date.getDate()}일`,
      onclick: () => {
        state.selectedDate = cell.key;
        if (!cell.inMonth) state.month = cell.key.slice(0, 7);
        render();
      },
    }, [el('span', { class: 'num', text: String(cell.date.getDate()) })]);

    if (s) {
      const dots = el('div', { class: 'dots' });
      s.siteIds.slice(0, 4).forEach((id) => {
        dots.append(el('i', { style: { background: siteById.get(id)?.color || 'var(--accent)' } }));
      });
      btn.append(dots, el('span', { class: 'cnt', text: `${s.count}명` }));
    }
    grid.append(btn);
  });
  content.push(grid);

  /* ---- 이 달 요약 ---- */
  const monthWorks = await store.worksOfMonth(state.month);
  if (monthWorks.length) {
    const total = monthWorks.reduce((t, w) => t + store.workTotal(w), 0);
    const days = new Set(monthWorks.map((w) => w.dateKey)).size;
    content.push(el('div', { class: 'stat-row' }, [
      statBox('나간 날', `${days}일`),
      statBox('연인원', `${monthWorks.length}명`),
      statBox('일당 합계', manwon(total), won(total)),
    ]));
  }

  /* ---- 선택한 날 ---- */
  const works = await store.worksOfDate(state.selectedDate);
  const dayTotal = works.reduce((t, w) => t + store.workTotal(w), 0);

  const panel = el('section', { class: 'day-panel' }, [
    el('h2', {}, [
      el('span', { text: formatDate(state.selectedDate) }),
      relativeTag(state.selectedDate)
        ? el('span', { class: 'dday-tag', text: relativeTag(state.selectedDate) })
        : null,
      el('span', { style: { flex: '1' } }),
      el('button', {
        type: 'button',
        class: 'chip accent',
        text: '＋ 배정',
        onclick: () => assignSheet({ dateKey: state.selectedDate }),
      }),
    ]),
  ]);

  if (!works.length) {
    panel.append(emptyBox('🚧', '이 날은 나간 현장이 없습니다.'));
  } else {
    panel.append(el('div', { class: 'notice' }, [
      el('span', { class: 'ico', text: '🧾' }),
      el('span', { text: `${works.length}명 · 일당 합계 ${won(dayTotal)}` }),
    ]));

    // 현장별로 묶어서 보여 줍니다.
    const groups = new Map();
    works.forEach((w) => {
      if (!groups.has(w.siteId)) groups.set(w.siteId, []);
      groups.get(w.siteId).push(w);
    });

    const list = el('div', { class: 'card-list' });
    for (const [siteId, rows] of groups) {
      const site = siteById.get(siteId);
      const subtotal = rows.reduce((t, w) => t + store.workTotal(w), 0);
      const card = el('div', { class: 'site-block' });

      card.append(el('div', { class: 'site-block-head' }, [
        el('span', { class: 'color-dot', style: { background: site?.color || 'var(--accent)' } }),
        el('span', { class: 'nm', text: site ? site.name : '(삭제된 현장)' }),
        el('span', { class: 'amt', text: won(subtotal) }),
      ]));

      if (site?.address) {
        card.append(el('button', {
          type: 'button',
          class: 'addr',
          text: `📍 ${site.address}`,
          onclick: () => openMap(site.address),
        }));
      }

      rows.forEach((w) => {
        const worker = workerById.get(w.workerId);
        const row = el('button', {
          type: 'button',
          class: 'work-row',
          onclick: async () => { await editWork(w.id); },
        }, [
          el('span', { class: 'nm', text: worker ? worker.name : '(삭제된 팀원)' }),
          num(w.gongsu) !== 1 ? el('span', { class: 'chip warn', text: `${fmtGongsu(w.gongsu)}공수` }) : null,
          w.carUsed ? el('span', { class: 'chip', text: '🚗' }) : null,
          w.paid ? el('span', { class: 'chip ok', text: '지급' }) : null,
          el('span', { class: 'amt', text: won(store.workTotal(w)) }),
        ]);
        onLongPress(row, async () => {
          const ok = await confirmDialog({
            title: '기록을 삭제할까요?',
            message: `${worker ? worker.name : ''} · ${formatDate(w.dateKey)} 출역 기록을 지웁니다.`,
            confirmLabel: '삭제',
            danger: true,
          });
          if (ok) { await store.deleteWork(w.id); toast('삭제했습니다.'); }
        });
        card.append(row);
      });

      list.append(card);
    }
    panel.append(list);
  }
  content.push(panel);

  return [header, content];
}

function shiftMonth(delta) {
  state.month = shiftMonthKey(state.month, delta);
  // 선택한 날짜를 그 달 안으로 옮겨 둡니다.
  const day = state.selectedDate.slice(8);
  const [y, m] = state.month.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  state.selectedDate = `${state.month}-${String(Math.min(Number(day), last)).padStart(2, '0')}`;
  render();
}

function statBox(label, value, sub) {
  return el('div', { class: 'stat' }, [
    el('div', { class: 'v', text: value }),
    el('div', { class: 'l', text: label }),
    sub ? el('div', { class: 'l2', text: sub }) : null,
  ]);
}

function openMap(address) {
  const q = encodeURIComponent(address);
  window.open(`https://map.kakao.com/link/search/${q}`, '_blank', 'noopener');
}

/* ==========================================================
   팀원
   ========================================================== */

async function renderWorkers() {
  const mKey = monthKey();
  const [workers, counts, balances] = await Promise.all([
    store.getWorkers(), store.monthCounts(mKey), store.advanceBalances(),
  ]);

  const header = [
    title('팀원', `${workers.filter((w) => w.active !== false).length}명`),
    iconBtn('💸', '가불 입력', () => editAdvance({ workerId: workers[0]?.id || '' })),
  ];

  if (!workers.length) {
    return [header, emptyBox('👷', '팀원을 등록해 주세요.\n이름과 일당만 있으면 바로 쓸 수 있습니다.', '팀원 추가', () => editWorker())];
  }

  const content = [];
  content.push(section(`${formatMonth(mKey)} 출역`, `${Object.values(counts).reduce((n, c) => n + c.days, 0)}명일`));

  const list = el('div', { class: 'card-list' });
  workers.forEach((w) => {
    const c = counts[w.id] || { days: 0, gongsu: 0, total: 0 };
    const bal = balances[w.id] || 0;
    const inactive = w.active === false;

    const card = el('button', {
      type: 'button',
      class: `person-card${inactive ? ' off' : ''}`,
      onclick: () => workerDetail(w.id),
    }, [
      el('div', { class: 'p-head' }, [
        el('span', { class: 'p-name', text: w.name }),
        w.hasCar ? el('span', { class: 'chip', text: '🚗 자차' }) : null,
        inactive ? el('span', { class: 'chip', text: '숨김' }) : null,
        bal > 0 ? el('span', { class: 'chip danger', text: `가불 ${manwon(bal)}` }) : null,
        el('span', { style: { flex: '1' } }),
        el('span', { class: 'p-count', text: c.days ? `${c.days}일` : '—' }),
      ]),
      el('div', { class: 'p-sub' }, [
        el('span', { text: w.dailyWage ? `일당 ${comma(w.dailyWage)}` : '일당 미등록' }),
        w.birthYear ? el('span', { text: `${w.birthYear}년생` }) : null,
        c.total ? el('span', { text: `이번 달 ${manwon(c.total)}원` }) : null,
      ]),
    ]);
    onLongPress(card, () => editWorker(w.id));
    list.append(card);
  });
  content.push(list);
  content.push(el('p', { class: 'hint', style: { margin: '12px 4px 0' }, text: '카드를 누르면 상세, 길게 누르면 바로 수정입니다.' }));

  return [header, content];
}

async function workerDetail(id) {
  const worker = await store.getWorker(id);
  if (!worker) return;
  const mKey = monthKey();
  const [counts, advances, bal] = await Promise.all([
    store.monthCounts(mKey), store.advancesOf(id), store.advanceBalance(id),
  ]);
  const c = counts[id] || { days: 0, gongsu: 0, total: 0 };
  const works = (await store.worksOfMonth(mKey)).filter((w) => w.workerId === id);
  const sites = await store.getSites();
  const siteById = new Map(sites.map((s) => [s.id, s]));

  await openSheet({
    title: worker.name,
    showConfirm: false,
    cancelLabel: '닫기',
    buildBody: ({ body, close }) => {
      body.append(el('div', { class: 'stat-row' }, [
        statBox(`${formatMonth(mKey)} 출역`, `${c.days}일`, `${fmtGongsu(c.gongsu)}공수`),
        statBox('이번 달 일당', manwon(c.total), won(c.total)),
        statBox('가불 잔액', bal ? manwon(bal) : '0', bal ? won(bal) : '없음'),
      ]));

      /* 기본 정보 */
      const g = el('div', { class: 'settings-group', style: { marginTop: '16px' } });
      const info = (label, value, onclick) => el(onclick ? 'button' : 'div', {
        type: onclick ? 'button' : null,
        class: 'settings-row',
        onclick,
      }, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'label', text: label }),
          el('div', { class: 'desc', text: value || '—' }),
        ]),
        onclick ? el('span', { class: 'value', text: '복사' }) : null,
      ]);

      g.append(info('일당', worker.dailyWage ? won(worker.dailyWage) : '미등록'));
      if (worker.birthYear) g.append(info('생년', `${worker.birthYear}년`));
      if (worker.phone) {
        g.append(el('button', {
          type: 'button', class: 'settings-row',
          onclick: () => { location.href = `tel:${worker.phone.replace(/[^\d+]/g, '')}`; },
        }, [
          el('div', { class: 'grow' }, [
            el('div', { class: 'label', text: '연락처' }),
            el('div', { class: 'desc', text: worker.phone }),
          ]),
          el('span', { class: 'value', text: '전화' }),
        ]));
      }
      if (worker.hasCar) g.append(info('차량 수당', worker.carPay ? won(worker.carPay) : '금액 없음 (기록만)'));
      if (worker.bankAccount) {
        const full = `${worker.bankName} ${worker.bankAccount}${worker.bankHolder ? ' ' + worker.bankHolder : ''}`.trim();
        g.append(info('계좌', `${worker.bankName} ${maskAccount(worker.bankAccount)}`, async () => {
          await copyText(full);
          toast('계좌를 복사했습니다.');
        }));
      }
      if (worker.memo) g.append(info('메모', worker.memo));
      body.append(g);

      /* 이번 달 출역 */
      body.append(section(`${formatMonth(mKey)} 나간 현장`, `${works.length}일`));
      if (!works.length) {
        body.append(el('p', { class: 'hint', text: '이번 달 기록이 없습니다.' }));
      } else {
        const list = el('div', { class: 'card-list' });
        works.slice().sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1)).forEach((w) => {
          const site = siteById.get(w.siteId);
          list.append(el('button', {
            type: 'button',
            class: 'work-row',
            onclick: async () => { close(); await editWork(w.id); },
          }, [
            el('span', { class: 'dt', text: formatDateShort(w.dateKey) }),
            el('span', { class: 'color-dot', style: { background: site?.color || 'var(--accent)' } }),
            el('span', { class: 'nm', text: site ? site.name : '(삭제됨)' }),
            num(w.gongsu) !== 1 ? el('span', { class: 'chip warn', text: `${fmtGongsu(w.gongsu)}공수` }) : null,
            w.carUsed ? el('span', { class: 'chip', text: '🚗' }) : null,
            el('span', { class: 'amt', text: comma(store.workTotal(w)) }),
          ]));
        });
        body.append(list);
      }

      /* 가불 */
      body.append(el('div', { class: 'section-title' }, [
        el('span', { text: '가불 내역' }),
        el('span', { style: { flex: '1' } }),
        el('button', {
          type: 'button', class: 'chip accent', text: '＋ 입력',
          onclick: async () => { close(); await editAdvance({ workerId: id }); },
        }),
      ]));
      if (!advances.length) {
        body.append(el('p', { class: 'hint', text: '가불 기록이 없습니다.' }));
      } else {
        const list = el('div', { class: 'card-list' });
        advances.forEach((a) => {
          list.append(el('button', {
            type: 'button',
            class: 'work-row',
            onclick: async () => { close(); await editAdvance({ workerId: id, id: a.id }); },
          }, [
            el('span', { class: 'dt', text: formatDateShort(a.dateKey) }),
            el('span', { class: a.kind === 'repay' ? 'chip ok' : 'chip danger', text: a.kind === 'repay' ? '상환' : '가불' }),
            el('span', { class: 'nm', text: a.memo || '' }),
            el('span', { class: 'amt', text: `${a.kind === 'repay' ? '−' : '+'}${comma(a.amount)}` }),
          ]));
        });
        body.append(list);
      }

      body.append(el('button', {
        type: 'button', class: 'btn primary',
        text: '정보 수정',
        style: { width: '100%', marginTop: '18px' },
        onclick: async () => { close(); await editWorker(id); },
      }));
    },
  });
}

/* ==========================================================
   현장
   ========================================================== */

async function renderSites() {
  const mKey = monthKey();
  const [sites, counts] = await Promise.all([store.getSites(), store.siteCounts(mKey)]);

  const header = [title('현장', `${sites.filter((s) => s.active !== false).length}곳`)];

  if (!sites.length) {
    return [header, emptyBox('🏗️', '현장을 등록해 주세요.\n이름만 있어도 배정할 수 있습니다.', '현장 추가', () => editSite())];
  }

  const content = [section(`${formatMonth(mKey)} 투입 현황`)];
  const list = el('div', { class: 'card-list' });

  sites.forEach((s) => {
    const c = counts[s.id] || { days: 0, total: 0, workerIds: [] };
    const card = el('button', {
      type: 'button',
      class: `site-card${s.active === false ? ' off' : ''}`,
      onclick: () => siteDetail(s.id),
    }, [
      el('div', { class: 'p-head' }, [
        el('span', { class: 'color-dot', style: { background: s.color } }),
        el('span', { class: 'p-name', text: s.name }),
        s.active === false ? el('span', { class: 'chip', text: '종료' }) : null,
        el('span', { style: { flex: '1' } }),
        el('span', { class: 'p-count', text: c.days ? `${c.days}명일` : '—' }),
      ]),
      el('div', { class: 'p-sub' }, [
        s.unitPrice ? el('span', { text: `단가 ${comma(s.unitPrice)}` }) : null,
        c.workerIds.length ? el('span', { text: `${c.workerIds.length}명 투입` }) : null,
        c.total ? el('span', { text: `${manwon(c.total)}원` }) : null,
      ]),
      s.address ? el('div', { class: 'p-addr', text: `📍 ${s.address}` }) : null,
    ]);
    onLongPress(card, () => editSite(s.id));
    list.append(card);
  });
  content.push(list);
  content.push(el('p', { class: 'hint', style: { margin: '12px 4px 0' }, text: '카드를 누르면 상세, 길게 누르면 바로 수정입니다.' }));

  return [header, content];
}

async function siteDetail(id) {
  const site = await store.getSite(id);
  if (!site) return;
  const mKey = monthKey();
  const works = (await store.worksOfMonth(mKey)).filter((w) => w.siteId === id);
  const workers = await store.getWorkers();
  const workerById = new Map(workers.map((w) => [w.id, w]));
  const total = works.reduce((t, w) => t + store.workTotal(w), 0);

  await openSheet({
    title: site.name,
    showConfirm: false,
    cancelLabel: '닫기',
    buildBody: ({ body, close }) => {
      body.append(el('div', { class: 'stat-row' }, [
        statBox('단가', site.unitPrice ? manwon(site.unitPrice) : '—', site.unitPrice ? won(site.unitPrice) : ''),
        statBox(`${formatMonth(mKey)} 투입`, `${works.length}명일`),
        statBox('나간 일당', manwon(total), won(total)),
      ]));

      const g = el('div', { class: 'settings-group', style: { marginTop: '16px' } });
      if (site.address) {
        g.append(el('button', {
          type: 'button', class: 'settings-row',
          onclick: () => openMap(site.address),
        }, [
          el('div', { class: 'grow' }, [
            el('div', { class: 'label', text: '주소' }),
            el('div', { class: 'desc', text: site.address }),
          ]),
          el('span', { class: 'value', text: '지도' }),
        ]));
      }
      if (site.client) {
        g.append(el('div', { class: 'settings-row' }, [
          el('div', { class: 'grow' }, [
            el('div', { class: 'label', text: '업체 · 원청' }),
            el('div', { class: 'desc', text: site.client }),
          ]),
        ]));
      }
      if (site.contact) {
        g.append(el('button', {
          type: 'button', class: 'settings-row',
          onclick: () => { location.href = `tel:${site.contact.replace(/[^\d+]/g, '')}`; },
        }, [
          el('div', { class: 'grow' }, [
            el('div', { class: 'label', text: '연락처' }),
            el('div', { class: 'desc', text: site.contact }),
          ]),
          el('span', { class: 'value', text: '전화' }),
        ]));
      }
      if (site.startDate || site.endDate) {
        g.append(el('div', { class: 'settings-row' }, [
          el('div', { class: 'grow' }, [
            el('div', { class: 'label', text: '기간' }),
            el('div', { class: 'desc', text: `${site.startDate || '—'} ~ ${site.endDate || '—'}` }),
          ]),
        ]));
      }
      if (site.memo) {
        g.append(el('div', { class: 'settings-row' }, [
          el('div', { class: 'grow' }, [
            el('div', { class: 'label', text: '메모' }),
            el('div', { class: 'desc', text: site.memo }),
          ]),
        ]));
      }
      if (g.children.length) body.append(g);

      body.append(section(`${formatMonth(mKey)} 출역`, `${works.length}명일`));
      if (!works.length) {
        body.append(el('p', { class: 'hint', text: '이번 달 기록이 없습니다.' }));
      } else {
        const byDate = new Map();
        works.forEach((w) => {
          if (!byDate.has(w.dateKey)) byDate.set(w.dateKey, []);
          byDate.get(w.dateKey).push(w);
        });
        const list = el('div', { class: 'card-list' });
        [...byDate.keys()].sort().forEach((dk) => {
          const rows = byDate.get(dk);
          list.append(el('div', { class: 'work-row', style: { fontWeight: '700' } }, [
            el('span', { class: 'dt', text: formatDateShort(dk) }),
            el('span', { class: 'nm', text: rows.map((r) => workerById.get(r.workerId)?.name || '?').join(', ') }),
            el('span', { class: 'amt', text: comma(rows.reduce((t, r) => t + store.workTotal(r), 0)) }),
          ]));
        });
        body.append(list);
      }

      body.append(el('div', { class: 'row', style: { marginTop: '18px' } }, [
        el('button', {
          type: 'button', class: 'btn',
          text: '이 현장에 배정',
          onclick: async () => { close(); await assignSheet({ dateKey: state.selectedDate, siteId: id }); },
        }),
        el('button', {
          type: 'button', class: 'btn primary',
          text: '정보 수정',
          onclick: async () => { close(); await editSite(id); },
        }),
      ]));
    },
  });
}

/* ==========================================================
   정산
   ========================================================== */

async function renderReport() {
  const mKey = state.reportMonth;
  const rep = await store.monthlyReport(mKey);

  const header = [
    title('정산', formatMonth(mKey)),
    iconBtn('📋', '요약 복사', () => copyReport(rep)),
  ];

  const content = [];
  content.push(el('div', { class: 'cal-head' }, [
    el('button', { type: 'button', text: '‹', 'aria-label': '이전 달', onclick: () => { state.reportMonth = shiftMonthKey(mKey, -1); render(); } }),
    el('div', { class: 'month', text: formatMonth(mKey) }),
    el('button', { type: 'button', text: '›', 'aria-label': '다음 달', onclick: () => { state.reportMonth = shiftMonthKey(mKey, 1); render(); } }),
  ]));

  if (!rep.byWorker.length) {
    content.push(emptyBox('📊', '이 달에는 기록이 없습니다.'));
    return [header, content];
  }

  const t = rep.totals;
  content.push(el('div', { class: 'stat-row' }, [
    statBox('나간 날', `${t.workDays}일`, `연인원 ${t.days}명`),
    statBox('총 지급액', manwon(t.total), won(t.total)),
    statBox('실지급', manwon(t.net), won(t.net)),
  ]));

  content.push(el('div', { class: 'sum-card' }, [
    sumRow('일당 합계', t.wagePay),
    t.carPay ? sumRow('차량 수당', t.carPay) : null,
    sumRow('총액', t.total, true),
    t.advance ? sumRow('가불 (미리 준 돈)', -t.advance) : null,
    t.repay ? sumRow('상환 (돌려받음)', t.repay) : null,
    sumRow('실지급액', t.net, true),
  ]));

  /* ---- 팀원별 ---- */
  content.push(section('팀원별', `${rep.byWorker.length}명`));
  const table = el('div', { class: 'tbl' });
  table.append(el('div', { class: 'tbl-head' }, [
    el('span', { class: 'c-name', text: '이름' }),
    el('span', { class: 'c-num', text: '출역' }),
    el('span', { class: 'c-amt', text: '총액' }),
    el('span', { class: 'c-amt', text: '실지급' }),
  ]));
  rep.byWorker.forEach((r) => {
    table.append(el('button', {
      type: 'button',
      class: 'tbl-row',
      onclick: () => workerSettlement(r, mKey),
    }, [
      el('span', { class: 'c-name' }, [
        el('span', { text: r.name }),
        r.carDays ? el('span', { class: 'chip', text: `🚗${r.carDays}` }) : null,
      ]),
      el('span', { class: 'c-num', text: `${r.days}일` }),
      el('span', { class: 'c-amt', text: comma(r.total) }),
      el('span', { class: 'c-amt strong', text: comma(r.net) }),
    ]));
  });
  table.append(el('div', { class: 'tbl-row total' }, [
    el('span', { class: 'c-name', text: '합계' }),
    el('span', { class: 'c-num', text: `${t.days}일` }),
    el('span', { class: 'c-amt', text: comma(t.total) }),
    el('span', { class: 'c-amt strong', text: comma(t.net) }),
  ]));
  content.push(table);

  /* ---- 현장별 ---- */
  content.push(section('현장별', `${rep.bySite.length}곳`));
  const st = el('div', { class: 'tbl' });
  st.append(el('div', { class: 'tbl-head' }, [
    el('span', { class: 'c-name', text: '현장' }),
    el('span', { class: 'c-num', text: '투입' }),
    el('span', { class: 'c-amt', text: '나간 일당' }),
  ]));
  rep.bySite.forEach((r) => {
    st.append(el('div', { class: 'tbl-row' }, [
      el('span', { class: 'c-name' }, [
        el('span', { class: 'color-dot', style: { background: r.site?.color || 'var(--accent)' } }),
        el('span', { text: r.name }),
      ]),
      el('span', { class: 'c-num', text: `${r.days}명일` }),
      el('span', { class: 'c-amt', text: comma(r.total) }),
    ]));
  });
  content.push(st);

  content.push(el('button', {
    type: 'button',
    class: 'btn primary',
    style: { width: '100%', marginTop: '18px' },
    text: '📄 정산서 만들기 (인쇄 · PDF)',
    onclick: () => exporter.openStatement({ month: mKey }),
  }));
  content.push(el('div', { class: 'row', style: { marginTop: '8px' } }, [
    el('button', { type: 'button', class: 'btn', text: '엑셀로 내보내기', onclick: () => exporter.exportWorkbook() }),
    el('button', { type: 'button', class: 'btn', text: 'CSV로 내보내기', onclick: () => exporter.exportMonthCsv(rep) }),
  ]));

  return [header, content];
}

function sumRow(label, amount, strong = false) {
  return el('div', { class: `sum-row${strong ? ' strong' : ''}` }, [
    el('span', { text: label }),
    el('span', { text: `${amount < 0 ? '−' : ''}${comma(Math.abs(amount))}원` }),
  ]);
}

async function workerSettlement(row, mKey) {
  const works = (await store.worksOfMonth(mKey)).filter((w) => w.workerId === row.workerId);
  const sites = await store.getSites();
  const siteById = new Map(sites.map((s) => [s.id, s]));

  await openSheet({
    title: `${row.name} · ${formatMonth(mKey)}`,
    showConfirm: false,
    cancelLabel: '닫기',
    buildBody: ({ body }) => {
      body.append(el('div', { class: 'sum-card' }, [
        sumRow(`출역 ${row.days}일 (${fmtGongsu(row.gongsu)}공수)`, row.wagePay),
        row.carPay ? sumRow(`차량 수당 (${row.carDays}일)`, row.carPay) : null,
        sumRow('총액', row.total, true),
        row.advance ? sumRow('이 달 가불', -row.advance) : null,
        row.repay ? sumRow('이 달 상환', row.repay) : null,
        sumRow('실지급액', row.net, true),
      ]));

      if (row.balance) {
        body.append(el('div', { class: 'notice warn' }, [
          el('span', { class: 'ico', text: '⚠️' }),
          el('span', { text: `아직 정산되지 않은 가불 잔액이 ${won(row.balance)} 있습니다.` }),
        ]));
      }

      body.append(section('날짜별'));
      const list = el('div', { class: 'card-list' });
      works.slice().sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1)).forEach((w) => {
        const site = siteById.get(w.siteId);
        list.append(el('div', { class: 'work-row' }, [
          el('span', { class: 'dt', text: formatDateShort(w.dateKey) }),
          el('span', { class: 'color-dot', style: { background: site?.color || 'var(--accent)' } }),
          el('span', { class: 'nm', text: site ? site.name : '(삭제됨)' }),
          num(w.gongsu) !== 1 ? el('span', { class: 'chip warn', text: `${fmtGongsu(w.gongsu)}공수` }) : null,
          w.carUsed ? el('span', { class: 'chip', text: '🚗' }) : null,
          el('span', { class: 'amt', text: comma(store.workTotal(w)) }),
        ]));
      });
      body.append(list);

      body.append(el('button', {
        type: 'button', class: 'btn primary',
        style: { width: '100%', marginTop: '18px' },
        text: '📄 이 사람 명세서 (인쇄 · PDF)',
        onclick: () => exporter.openStatement({ month: mKey, workerId: row.workerId }),
      }));

      body.append(el('button', {
        type: 'button', class: 'btn',
        style: { width: '100%', marginTop: '8px' },
        text: '정산 내역 문자로 복사',
        onclick: async () => {
          const lines = [
            `${row.name} · ${formatMonth(mKey)} 정산`,
            `출역 ${row.days}일 (${fmtGongsu(row.gongsu)}공수)`,
            `일당 ${comma(row.wagePay)}원`,
          ];
          if (row.carPay) lines.push(`차량수당 ${comma(row.carPay)}원`);
          lines.push(`총액 ${comma(row.total)}원`);
          if (row.advance) lines.push(`가불 −${comma(row.advance)}원`);
          if (row.repay) lines.push(`상환 +${comma(row.repay)}원`);
          lines.push(`실지급 ${comma(row.net)}원`);
          await copyText(lines.join('\n'));
          toast('복사했습니다. 문자로 붙여넣으세요.');
        },
      }));
    },
  });
}

async function copyReport(rep) {
  const t = rep.totals;
  const lines = [`${formatMonth(rep.month)} 정산`, ''];
  rep.byWorker.forEach((r) => {
    lines.push(`${r.name} ${r.days}일 · 총 ${comma(r.total)} · 실지급 ${comma(r.net)}`);
  });
  lines.push('', `합계 ${comma(t.total)}원 / 실지급 ${comma(t.net)}원`);
  await copyText(lines.join('\n'));
  toast('정산 요약을 복사했습니다.');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = el('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

/* ==========================================================
   설정
   ========================================================== */

function group(name) {
  return el('div', {}, [
    name ? el('div', { class: 'section-title', text: name }) : null,
    el('div', { class: 'settings-group' }),
  ]);
}

function settingsRow({ label, desc, value, onclick, toggle, danger }) {
  const node = el(onclick || toggle !== undefined ? 'button' : 'div', {
    type: onclick || toggle !== undefined ? 'button' : null,
    class: `settings-row${danger ? ' danger' : ''}`,
    onclick,
  }, [
    el('div', { class: 'grow' }, [
      el('div', { class: 'label', text: label }),
      desc ? el('div', { class: 'desc', text: desc }) : null,
    ]),
    toggle !== undefined
      ? el('span', { class: 'switch', role: 'switch', 'aria-checked': toggle ? 'true' : 'false' })
      : (value ? el('span', { class: 'value', text: value }) : null),
  ]);
  return node;
}

async function renderSettings() {
  const header = [title('설정')];
  const content = [];

  /* ---- 내보내기 ---- */
  const months = await store.activeMonths();
  const thisMonth = months[0] || monthKey();
  const xBox = group('내보내기');
  const x = xBox.lastChild;

  x.append(settingsRow({
    label: '정산서 만들기',
    desc: `${formatMonth(thisMonth)} 정산서를 문서로 보고, 인쇄하거나 PDF로 저장합니다.`,
    value: '문서',
    onclick: () => exporter.openStatement({ month: thisMonth }),
  }));
  x.append(settingsRow({
    label: '엑셀 파일로 내보내기',
    desc: '팀원 · 현장 · 출역 · 가불 · 월정산 5개 시트가 담긴 .xlsx 파일을 만듭니다.',
    value: '엑셀',
    onclick: () => exporter.exportWorkbook(),
  }));
  content.push(xBox);
  content.push(el('p', { class: 'hint', style: { margin: '8px 4px 0' },
    text: '만든 파일은 기기에 저장되거나 공유 시트로 넘어갑니다. 서버로 올라가는 것은 없습니다.' }));

  /* ---- 데이터 ---- */
  const dBox = group('데이터');
  const d = dBox.lastChild;
  const est = await db.storageEstimate();
  d.append(settingsRow({
    label: '백업 파일 내보내기',
    desc: '전체 데이터를 JSON 파일 하나로 저장합니다.',
    value: '내보내기',
    onclick: exportData,
  }));
  d.append(settingsRow({
    label: '백업 파일 가져오기',
    desc: '다른 기기에서 내보낸 파일을 불러옵니다.',
    value: '가져오기',
    onclick: importData,
  }));
  if (est) {
    d.append(settingsRow({
      label: '저장 공간',
      desc: `${bytesToText(est.usage)} 사용 중`,
    }));
  }
  d.append(settingsRow({
    label: '전체 삭제',
    desc: '팀원 · 현장 · 출역 · 가불 기록을 모두 지웁니다.',
    danger: true,
    value: '삭제',
    onclick: async () => {
      const ok = await confirmDialog({
        title: '모두 삭제할까요?',
        message: '이 기기에 저장된 모든 기록이 지워집니다. 먼저 백업 파일을 내보내 두세요.',
        confirmLabel: '전부 삭제',
        danger: true,
      });
      if (!ok) return;
      await store.wipeAll();
      toast('모두 삭제했습니다.');
    },
  }));
  content.push(dBox);

  /* ---- 잠금 ---- */
  const enabled = await lock.isEnabled();
  const lBox = group('보안');
  const l = lBox.lastChild;
  l.append(settingsRow({
    label: 'PIN 잠금',
    desc: enabled ? '앱을 열 때 PIN을 묻습니다.' : '계좌번호가 들어 있으니 켜 두시길 권합니다.',
    toggle: enabled,
    onclick: async () => {
      if (enabled) {
        const pin = await pinPrompt('PIN 확인', '잠금을 끄려면 지금 PIN을 입력하세요.');
        if (!pin) return;
        if (await lock.disable(pin)) { toast('잠금을 껐습니다.'); render(); }
        else toast('PIN이 맞지 않습니다.');
        return;
      }
      const pin = await pinPrompt('새 PIN', '숫자 4~10자리를 정해 주세요.');
      if (!pin) return;
      const again = await pinPrompt('한 번 더', '같은 PIN을 다시 입력하세요.');
      if (again !== pin) { toast('두 번 입력한 PIN이 다릅니다.'); return; }
      await lock.setPin(pin);
      toast('잠금을 켰습니다.');
      render();
    },
  }));
  if (enabled) {
    const mins = await lock.autoLockMinutes();
    l.append(settingsRow({
      label: '자동 잠금',
      desc: '앱을 벗어난 뒤 이 시간이 지나면 다시 잠급니다.',
      value: mins === 0 ? '바로' : `${mins}분`,
      onclick: async () => {
        const v = await pickerSheet({
          title: '자동 잠금',
          value: mins,
          options: [0, 1, 5, 15, 60].map((n) => ({ value: n, label: n === 0 ? '바로 잠금' : `${n}분 뒤` })),
        });
        if (v === null) return;
        await lock.setAutoLockMinutes(v);
        render();
      },
    }));
  }
  content.push(lBox);

  /* ---- 표시 ---- */
  const tBox = group('표시');
  const th = tBox.lastChild;
  const THEMES = [
    { value: 'auto', label: '기기 설정 따르기' },
    { value: 'sky', label: '하양 · 하늘색' },
    { value: 'light', label: '밝게' },
    { value: 'dark', label: '어둡게' },
  ];
  th.append(settingsRow({
    label: '테마',
    value: THEMES.find((t) => t.value === state.theme)?.label,
    onclick: async () => {
      const v = await pickerSheet({ title: '테마', value: state.theme, options: THEMES });
      if (!v) return;
      state.theme = v;
      localStorage.setItem('theme', v);
      applyTheme(v);
      render();
    },
  }));
  content.push(tBox);

  /* ---- 앱 ---- */
  const aBox = group('앱');
  aBox.lastChild.append(settingsRow({
    label: '버전',
    desc: '눌러서 최신 버전을 확인합니다.',
    value: APP_VERSION,
    onclick: checkForUpdate,
  }));
  content.push(aBox);
  content.push(el('p', {
    class: 'hint',
    style: { margin: '16px 4px 0', lineHeight: '1.6' },
    text: '모든 기록은 이 기기 안에만 저장됩니다. 서버로 보내는 통신이 없고, 내보내기로 만든 파일만 기기에 남습니다.',
  }));

  return [header, content];
}

function applyTheme(theme) {
  let t = theme;
  if (t === 'auto') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0f1115');
  }
}

/* ---------------- 백업 파일 ---------------- */

async function exportData() {
  const data = await store.exportBackup();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = el('a', {
    href: URL.createObjectURL(blob),
    download: `현장관리_백업_${todayKey()}.json`,
  });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast('백업 파일을 저장했습니다.');
}

function importData() {
  const input = el('input', { type: 'file', accept: 'application/json,.json', style: { display: 'none' } });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const mode = await pickerSheet({
        title: '어떻게 넣을까요?',
        options: [
          { value: 'merge', label: '합치기', desc: '지금 기록을 그대로 두고 더합니다.' },
          { value: 'replace', label: '전부 바꾸기', desc: '지금 기록을 지우고 파일 내용으로 채웁니다.' },
        ],
      });
      if (!mode) return;
      const n = await store.importBackup(data, mode);
      toast(`팀원 ${n.workers} · 현장 ${n.sites} · 출역 ${n.works}건을 불러왔습니다.`);
    } catch (e) {
      toast(e.message || '파일을 읽지 못했습니다.');
    }
  });
  document.body.append(input);
  input.click();
}

/* ==========================================================
   잠금 화면
   ========================================================== */

function pinPrompt(t, message) {
  let value = '';
  return openSheet({
    title: t,
    confirmLabel: '확인',
    buildBody: ({ body, setConfirmEnabled }) => {
      setConfirmEnabled(false);
      body.append(el('p', {
        text: message,
        style: { margin: '2px 0 4px', fontSize: '14px', color: 'var(--text-dim)' },
      }));
      body.append(el('input', {
        type: 'password',
        inputmode: 'numeric',
        pattern: '[0-9]*',
        autocomplete: 'off',
        maxlength: '10',
        placeholder: '● ● ● ●',
        'data-autofocus': '',
        style: { fontSize: '20px', letterSpacing: '6px', textAlign: 'center' },
        oninput: (e) => {
          e.target.value = e.target.value.replace(/\D/g, '');
          value = e.target.value;
          setConfirmEnabled(value.length >= 4);
        },
      }));
    },
    onConfirm: () => (value.length >= 4 ? value : false),
  });
}

function showLockScreen() {
  return new Promise((resolve) => {
    let pin = '';
    const dots = el('div', { class: 'lock-dots' });
    const err = el('div', { class: 'lock-error' });

    const renderDots = () => {
      dots.replaceChildren();
      for (let i = 0; i < Math.max(pin.length, 4); i++) {
        dots.append(el('i', { class: i < pin.length ? 'on' : '' }));
      }
    };

    const unlock = () => {
      screen.remove();
      document.body.style.overflow = '';
      resolve(true);
    };

    let verifying = false;

    const submit = async () => {
      if (verifying) return;
      verifying = true;
      const ok = await lock.verify(pin);
      verifying = false;
      if (ok) { unlock(); return; }
      err.textContent = 'PIN이 맞지 않습니다.';
      pin = '';
      renderDots();
      if (navigator.vibrate) navigator.vibrate(120);
    };

    // 4자리 이상 입력하면 조용히 한 번 확인해 보고, 맞으면 바로 열립니다.
    const tryAuto = debounce(async () => {
      if (pin.length < 4 || verifying) return;
      verifying = true;
      const ok = await lock.verify(pin);
      verifying = false;
      if (ok) unlock();
    }, 350);

    const keypad = el('div', { class: 'keypad' });
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'ok'].forEach((k) => {
      if (k === 'clear') {
        keypad.append(el('button', {
          type: 'button', text: '⌫', 'aria-label': '지우기',
          onclick: () => { pin = pin.slice(0, -1); err.textContent = ''; renderDots(); },
        }));
      } else if (k === 'ok') {
        keypad.append(el('button', { type: 'button', text: '→', 'aria-label': '확인', onclick: submit }));
      } else {
        keypad.append(el('button', {
          type: 'button', text: k,
          onclick: () => {
            if (pin.length >= 10) return;
            pin += k;
            err.textContent = '';
            renderDots();
            tryAuto();
          },
        }));
      }
    });

    const screen = el('div', { class: 'lock-screen', id: 'lock-screen' }, [
      el('div', { class: 'lock-ico', text: '🔒' }),
      el('h2', { text: 'PIN을 입력하세요' }),
      dots,
      err,
      keypad,
    ]);
    renderDots();
    document.body.append(screen);
    document.body.style.overflow = 'hidden';
  });
}

function setupAutoLock() {
  let hiddenAt = null;
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    if (hiddenAt === null) return;
    if (!(await lock.isEnabled())) return;
    if ($('#lock-screen')) return;
    const mins = await lock.autoLockMinutes();
    if (Date.now() - hiddenAt >= mins * 60000) {
      await showLockScreen();
      render();
    }
    hiddenAt = null;
  });
}

/* ==========================================================
   서비스 워커
   ========================================================== */

let waitingWorker = null;

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    if (reg.waiting) waitingWorker = reg.waiting;
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          waitingWorker = sw;
          toast('새 버전이 있습니다.', { action: '지금 적용', onAction: applyUpdate, duration: 8000 });
        }
      });
    });
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  } catch (e) {
    console.warn('서비스 워커 등록 실패:', e);
  }
}

function applyUpdate() {
  if (waitingWorker) waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  else location.reload();
}

async function checkForUpdate() {
  if (!('serviceWorker' in navigator)) { location.reload(); return; }
  toast('확인 중…');
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) { location.reload(); return; }
    await reg.update();
    if (reg.waiting) { waitingWorker = reg.waiting; applyUpdate(); return; }
    toast('이미 최신 버전입니다.');
  } catch {
    location.reload();
  }
}

/* ==========================================================
   시작
   ========================================================== */

boot().catch((e) => {
  console.error(e);
  document.getElementById('app').innerHTML =
    `<div class="empty"><span class="big">⚠️</span><p>앱을 여는 중 문제가 생겼습니다.<br><small>${e.message}</small></p></div>`;
});
