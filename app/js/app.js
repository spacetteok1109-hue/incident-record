/* app.js — 화면 구성과 앱 시작 */

import * as db from './db.js';
import * as store from './store.js';
import * as media from './media.js';
import * as notify from './notify.js';
import * as lock from './lock.js';
import { el, $, toast, openSheet, confirmDialog, pickerSheet, openViewer, closeTopSheet, onLongPress } from './ui.js';
import { openItemEditor, openFolderEditor, openExpenseEditor } from './editor.js';
import * as money from './money.js';
import { icon } from './icons.js';
import {
  WEEKDAYS, todayKey, monthGrid, ddayLabel, formatDate, formatTime,
  relativeDateLabel, diffDays, periodProgress, formatRange, REPEAT_LABELS, bytesToText, debounce,
} from './util.js';

const APP_VERSION = '1.6.0';

const state = {
  tab: 'today',
  cal: { y: new Date().getFullYear(), m: new Date().getMonth() },
  moneyMonth: money.thisMonthKey(),
  selectedDate: todayKey(),
  folderId: null,
  settings: { theme: 'auto', hideCompleted: false, showBadge: true },
};

const main = () => $('#view');

/* ==========================================================
   시작
   ========================================================== */

async function boot() {
  await db.openDB();
  await store.ensureSeed();
  state.settings = { ...state.settings, ...(await db.getMeta('settings', {})) };
  applyTheme(state.settings.theme);
  await store.rollForwardRepeats();

  buildShell();

  if (await lock.isEnabled()) {
    await showLockScreen();
  }

  render();
  store.subscribe(() => render());

  notify.start({
    onMissed: (items) => {
      items.forEach((it) => {
        toast(`🔔 ${it.title}`, { action: '열기', onAction: () => openItemById(it.id), duration: 8000 });
      });
    },
  });

  registerServiceWorker();
  db.requestPersistence();
  setupAutoLock();
  handleLaunchParams();

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeTopSheet();
  });

  // 날짜가 바뀌면(자정) 화면을 새로 그립니다.
  let lastDay = todayKey();
  setInterval(() => {
    if (todayKey() !== lastDay) {
      lastDay = todayKey();
      store.rollForwardRepeats().then(render);
    }
  }, 60000);
}

function buildShell() {
  const app = $('#app');
  app.replaceChildren(
    el('header', { class: 'topbar', id: 'topbar' }),
    el('main', { id: 'view' }),
    el('button', {
      class: 'fab',
      id: 'fab',
      type: 'button',
      'aria-label': '새 항목 추가',
      onclick: () => (state.tab === 'money' ? createExpense() : createItem()),
    }, [icon('plus', { size: 26, strokeWidth: 2.2 })]),
    buildTabbar(),
  );
}

const TABS = [
  { id: 'today', label: '오늘', ico: 'today' },
  { id: 'calendar', label: '캘린더', ico: 'calendar' },
  { id: 'folders', label: '폴더', ico: 'folder' },
  { id: 'dday', label: '디데이', ico: 'dday' },
  { id: 'money', label: '가계부', ico: 'wallet' },
  { id: 'settings', label: '설정', ico: 'settings' },
];

function buildTabbar() {
  const bar = el('nav', { class: 'tabbar', id: 'tabbar', role: 'tablist' });
  TABS.forEach((t) => {
    bar.append(el('button', {
      type: 'button',
      role: 'tab',
      'aria-selected': String(state.tab === t.id),
      dataset: { tab: t.id },
      onclick: () => go(t.id),
    }, [
      el('span', { class: 'ico' }, [icon(t.ico, { size: 23 })]),
      el('span', { text: t.label }),
    ]));
  });
  return bar;
}

function go(tab, opts = {}) {
  state.tab = tab;
  state.folderId = opts.folderId ?? null;
  [...$('#tabbar').children].forEach((b) =>
    b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  window.scrollTo(0, 0);
  render();
}

/* ==========================================================
   렌더링
   ========================================================== */

let renderToken = 0;

async function render() {
  const token = ++renderToken;
  const view = main();
  if (!view) return;

  let content;
  let header;
  switch (state.tab) {
    case 'calendar': [header, content] = await renderCalendar(); break;
    case 'folders': [header, content] = await renderFolders(); break;
    case 'dday': [header, content] = await renderDday(); break;
    case 'money': [header, content] = await renderMoney(); break;
    case 'settings': [header, content] = await renderSettings(); break;
    default: [header, content] = await renderToday();
  }
  if (token !== renderToken) return; // 더 최신 렌더가 있으면 버립니다.

  $('#topbar').replaceChildren(...header);
  view.replaceChildren(...content);
  $('#fab').classList.toggle('hidden', state.tab === 'settings');
  updateBadge();
}

/* ---------------- 앱 아이콘 배지 ----------------
 * 홈 화면 아이콘 위에 오늘 남은 개수를 숫자로 띄웁니다.
 * (안드로이드 크롬, iOS 16.4 이상에서 홈 화면에 추가한 경우)
 */

export function badgeSupported() {
  return 'setAppBadge' in navigator;
}

async function updateBadge() {
  if (!badgeSupported()) return;
  try {
    if (state.settings.showBadge === false) {
      await navigator.clearAppBadge();
      return;
    }
    const { overdue, today } = await store.todayBuckets();
    const count = overdue.length + today.filter((i) => !i.done).length;
    if (count > 0) await navigator.setAppBadge(count);
    else await navigator.clearAppBadge();
  } catch {
    // 브라우저가 막아 둔 경우 — 조용히 넘어갑니다.
  }
}

function title(text, sub) {
  return el('h1', {}, [text, sub ? el('span', { class: 'sub', text: sub }) : null]);
}

function iconBtn(name, label, onclick) {
  return el('button', { type: 'button', class: 'icon-btn', 'aria-label': label, onclick },
    [icon(name, { size: 22 })]);
}

/* ---------------- 오늘 ---------------- */

async function renderToday() {
  const header = [
    title('오늘', formatDate(todayKey(), { withYear: false })),
    iconBtn('search', '검색', openSearch),
  ];

  const { overdue, today, someday } = await store.todayBuckets();
  const upcoming = await store.ddayItems();
  const nearDday = upcoming.filter((d) => {
    const diff = diffDays(todayKey(), d.dueDate);
    return diff !== null && diff >= 0 && diff <= 30;
  }).slice(0, 3);

  const content = [];

  const banner = await notificationBanner();
  if (banner) content.push(banner);

  const spend = await money.summary();
  if (spend.today || spend.todayCount) {
    content.push(el('button', {
      type: 'button',
      class: 'today-money',
      onclick: () => go('money'),
    }, [
      el('span', { class: 'tm-label', text: '오늘 쓴 돈' }),
      el('span', { class: 'tm-value money-num', text: money.formatWon(spend.today) }),
      el('span', { class: 'tm-sub', text: `${spend.todayCount}건 ›` }),
    ]));
  }

  if (nearDday.length) {
    content.push(section('다가오는 디데이'));
    const row = el('div', { class: 'card-list' });
    for (const d of nearDday) row.append(await ddayCard(d, { compact: true }));
    content.push(row);
  }

  if (overdue.length) {
    content.push(section('지난 할 일', overdue.length, true));
    content.push(await itemList(overdue));
  }

  content.push(section('오늘', today.length));
  if (today.length) content.push(await itemList(today));
  else {
    content.push(el('div', { class: 'empty' }, [
      el('span', { class: 'big', text: '🌿' }),
      el('p', { text: '오늘 할 일이 없습니다.' }),
      el('p', { text: '아래 ＋ 버튼으로 추가해 보세요.' }),
    ]));
  }

  if (someday.length) {
    content.push(section('날짜 없음', someday.length));
    content.push(await itemList(someday));
  }

  return [header, content];
}

function section(text, count, warn = false) {
  return el('div', { class: 'section-title' + (warn ? ' warn' : '') }, [
    el('span', { text }),
    count !== undefined ? el('span', { class: 'count', text: String(count) }) : null,
  ]);
}

/* ---------------- 항목 카드 ---------------- */

async function itemList(items) {
  const list = el('div', { class: 'card-list' });
  const folders = await store.getFolders();
  const byId = new Map(folders.map((f) => [f.id, f]));
  const visible = state.settings.hideCompleted ? items.filter((i) => !i.done) : items;
  for (const item of visible) list.append(await itemCard(item, byId.get(item.folderId)));
  if (!visible.length) {
    list.append(el('div', { class: 'empty' }, [el('p', { text: '항목이 없습니다.' })]));
  }
  return list;
}

async function itemCard(item, folder) {
  const overdue = !item.done && item.dueDate && item.dueDate < todayKey();
  const node = el('article', {
    class: 'item' + (item.done ? ' done' : '') + (overdue ? ' overdue' : ''),
  });

  if (folder) node.append(el('span', { class: 'bar', style: { background: folder.color } }));

  const check = el('button', {
    type: 'button',
    class: 'check' + (item.type === 'dday' ? ' dday' : ''),
    role: 'checkbox',
    'aria-checked': String(!!item.done),
    'aria-label': item.done ? '완료 취소' : '완료로 표시',
    onclick: async (e) => {
      e.stopPropagation();
      const before = item.done;
      await store.toggleDone(item.id);
      if (!before && item.repeat && item.repeat !== 'none') {
        toast('완료! 다음 반복으로 넘어갔습니다.');
      }
    },
  });

  check.append(icon('check', { size: 15, strokeWidth: 2.6 }));

  const body = el('div', { class: 'item-body' });
  body.append(el('p', { class: 'item-title', text: item.title }));

  const meta = el('div', { class: 'item-meta' });
  if (item.type === 'dday' && item.dueDate) {
    meta.append(el('span', { class: 'chip accent', text: ddayLabel(item.dueDate) }));
    const p = itemPeriod(item);
    if (p) meta.append(el('span', { class: 'chip', text: `⏳ ${periodLabel(p)}` }));
  }
  if (item.dueDate) {
    const label = relativeDateLabel(item.dueDate) + (item.dueTime ? ' ' + formatTime(item.dueTime) : '');
    meta.append(el('span', { class: 'chip' + (overdue ? ' danger' : ''), text: (overdue ? '⚠️ ' : '🗓 ') + label }));
  }
  if (item.remindAt && !item.done) {
    meta.append(el('span', { class: 'chip warn', text: '🔔' }));
  }
  if (item.repeat && item.repeat !== 'none') {
    meta.append(el('span', { class: 'chip', text: '🔁 ' + REPEAT_LABELS[item.repeat] }));
  }
  if (folder) {
    meta.append(el('span', { class: 'chip folder', text: `${folder.emoji} ${folder.name}` }));
  }
  if (item.memo) meta.append(el('span', { class: 'chip', text: '📝' }));
  if (meta.children.length) body.append(meta);

  /* 체크리스트 */
  body.append(...checklistNodes(item, { limit: 6, withBar: true }));

  /* 사진 썸네일 */
  if ((item.photoIds || []).length) {
    const photos = await media.getPhotos(item.photoIds);
    if (photos.length) {
      const row = el('div', { class: 'thumb-row' });
      photos.slice(0, 4).forEach((p) => {
        row.append(el('img', {
          src: media.photoURL(p),
          alt: '첨부 사진',
          loading: 'lazy',
          onclick: (e) => { e.stopPropagation(); openViewer(media.photoURL(p, { full: true })); },
        }));
      });
      if (photos.length > 4) row.append(el('div', { class: 'more', text: `+${photos.length - 4}` }));
      body.append(row);
    }
  }

  node.append(check, body);
  node.addEventListener('click', () => editItem(item.id));
  onLongPress(node, async () => {
    const ok = await confirmDialog({
      title: '항목 삭제',
      message: `'${item.title}'을(를) 삭제할까요?`,
      confirmLabel: '삭제',
      danger: true,
    });
    if (ok) { await store.deleteItem(item.id); toast('삭제했습니다.'); }
  });
  return node;
}

/* ---------------- 캘린더 ---------------- */

async function renderCalendar() {
  const { y, m } = state.cal;
  const header = [
    title('캘린더', `${y}년 ${m + 1}월`),
    iconBtn('search', '검색', openSearch),
    iconBtn('jumpToday', '오늘로', () => {
      const n = new Date();
      state.cal = { y: n.getFullYear(), m: n.getMonth() };
      state.selectedDate = todayKey();
      render();
    }),
  ];

  const content = [];

  const head = el('div', { class: 'cal-head' }, [
    el('button', { type: 'button', text: '‹', 'aria-label': '이전 달', onclick: () => shiftMonth(-1) }),
    el('div', { class: 'month', text: `${y}년 ${m + 1}월` }),
    el('button', { type: 'button', text: '›', 'aria-label': '다음 달', onclick: () => shiftMonth(1) }),
  ]);
  content.push(head);

  const wd = el('div', { class: 'weekdays' });
  WEEKDAYS.forEach((w, i) => wd.append(el('div', {
    class: i === 0 ? 'sun' : i === 6 ? 'sat' : '',
    text: w,
  })));
  content.push(wd);

  const summary = await store.monthSummary(y, m);
  const grid = el('div', { class: 'cal-grid' });
  monthGrid(y, m).forEach((cell) => {
    const dow = cell.date.getDay();
    const s = summary.get(cell.key);
    const c = el('button', {
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
        if (!cell.inMonth) state.cal = { y: cell.date.getFullYear(), m: cell.date.getMonth() };
        render();
      },
    }, [
      el('span', { class: 'num', text: String(cell.date.getDate()) }),
    ]);
    if (s) {
      const dots = el('div', { class: 'dots' });
      const n = Math.min(s.total, 4);
      for (let i = 0; i < n; i++) {
        dots.append(el('i', { class: s.hasDday && i === 0 ? 'dday' : (s.done >= s.total ? 'done' : '') }));
      }
      c.append(dots);
    }
    grid.append(c);
  });
  content.push(grid);

  /* 선택한 날짜의 목록 */
  const items = await store.itemsForDate(state.selectedDate);
  const panel = el('section', { class: 'day-panel' }, [
    el('h2', {}, [
      el('span', { text: formatDate(state.selectedDate, { withYear: false }) }),
      el('span', { class: 'dday-tag', text: relativeDateLabel(state.selectedDate) }),
      el('span', { style: { flex: '1' } }),
      el('button', {
        type: 'button',
        class: 'chip accent',
        text: '＋ 추가',
        onclick: () => createItem({ dueDate: state.selectedDate }),
      }),
    ]),
  ]);
  if (items.length) panel.append(await itemList(items));
  else {
    panel.append(el('div', { class: 'empty' }, [
      el('span', { class: 'big', text: '📭' }),
      el('p', { text: '이 날에는 일정이 없습니다.' }),
    ]));
  }
  content.push(panel);

  return [header, content];
}

function shiftMonth(delta) {
  let { y, m } = state.cal;
  m += delta;
  if (m < 0) { m = 11; y -= 1; }
  if (m > 11) { m = 0; y += 1; }
  state.cal = { y, m };
  render();
}

/* ---------------- 폴더 ---------------- */

async function renderFolders() {
  const folders = await store.getFolders();
  const items = await store.getItems();

  if (state.folderId !== null) {
    const folder = await store.getFolder(state.folderId);
    if (!folder && state.folderId !== 'none') {
      state.folderId = null;
      return renderFolders();
    }
    const list = state.folderId === 'none'
      ? store.sortItems(items.filter((i) => !i.folderId))
      : await store.itemsForFolder(state.folderId);
    const name = folder ? `${folder.emoji} ${folder.name}` : '📂 폴더 없음';
    const header = [
      iconBtn('back', '뒤로', () => { state.folderId = null; render(); }),
      title(name, `${list.filter((i) => !i.done).length}개 남음 · 전체 ${list.length}개`),
      folder ? iconBtn('edit', '폴더 수정', async () => {
        await openFolderEditor(folder);
        render();
      }) : null,
    ].filter(Boolean);
    const content = [
      await itemList(list),
    ];
    return [header, content];
  }

  const header = [
    title('폴더', `${folders.length}개`),
    iconBtn('plus', '폴더 추가', async () => { await openFolderEditor(); render(); }),
  ];

  const grid = el('div', { class: 'folder-grid' });
  const counts = new Map();
  items.forEach((it) => {
    const key = it.folderId || 'none';
    const cur = counts.get(key) || { total: 0, open: 0 };
    cur.total++;
    if (!it.done) cur.open++;
    counts.set(key, cur);
  });

  folders.forEach((f) => {
    const c = counts.get(f.id) || { total: 0, open: 0 };
    grid.append(el('button', {
      type: 'button',
      class: 'folder-card',
      style: { '--fc': f.color },
      onclick: () => { state.folderId = f.id; render(); },
    }, [
      el('span', { class: 'emoji', text: f.emoji }),
      el('span', { class: 'name', text: f.name }),
      el('span', { class: 'stat', text: `할 일 ${c.open}개 · 전체 ${c.total}개` }),
      el('span', {
        class: 'edit', role: 'button', 'aria-label': '폴더 수정',
        onclick: async (e) => { e.stopPropagation(); await openFolderEditor(f); render(); },
      }, [icon('edit', { size: 17 })]),
    ]));
  });

  const none = counts.get('none');
  if (none) {
    grid.append(el('button', {
      type: 'button',
      class: 'folder-card',
      style: { '--fc': 'var(--text-faint)' },
      onclick: () => { state.folderId = 'none'; render(); },
    }, [
      el('span', { class: 'emoji', text: '📂' }),
      el('span', { class: 'name', text: '폴더 없음' }),
      el('span', { class: 'stat', text: `할 일 ${none.open}개 · 전체 ${none.total}개` }),
    ]));
  }

  const content = [grid];
  if (!folders.length) {
    content.push(el('div', { class: 'empty' }, [
      el('span', { class: 'big', text: '📁' }),
      el('p', { text: '폴더를 만들어 할 일을 나눠 보세요.' }),
    ]));
  }
  content.push(el('button', {
    type: 'button',
    class: 'btn-ghost',
    style: { marginTop: '14px' },
    text: '＋ 새 폴더',
    onclick: async () => { await openFolderEditor(); render(); },
  }));
  return [header, content];
}

/* ---------------- 디데이 ---------------- */

async function renderDday() {
  const list = await store.ddayItems();
  const header = [
    title('디데이', `${list.length}개`),
    iconBtn('plus', '디데이 추가', () => createItem({ type: 'dday' })),
  ];
  const content = [];
  if (!list.length) {
    content.push(el('div', { class: 'empty' }, [
      el('span', { class: 'big', text: '🎯' }),
      el('p', { text: '기념일이나 시험일을 등록해 보세요.' }),
      el('p', { text: '남은 날짜를 한눈에 볼 수 있습니다.' }),
    ]));
  } else {
    const wrap = el('div', { class: 'card-list' });
    for (const d of list) wrap.append(await ddayCard(d));
    content.push(wrap);
  }
  return [header, content];
}

async function ddayCard(item, { compact = false } = {}) {
  const diff = diffDays(todayKey(), item.dueDate);
  const cls = ['dday-card', diff === 0 ? 'today' : (diff < 0 ? 'past' : '')].filter(Boolean);
  const folder = await store.getFolder(item.folderId);

  const period = itemPeriod(item);
  const dateText = period
    ? formatRange(item.startDate, item.dueDate)
    : formatDate(item.dueDate, { withYear: true });

  const info = el('div', { class: 'info' }, [
    el('div', { class: 't', text: item.title }),
    el('div', {
      class: 'd',
      text: [dateText, folder ? `${folder.emoji} ${folder.name}` : null].filter(Boolean).join(' · '),
    }),
  ]);

  if (period) {
    info.append(
      el('div', { class: 'progress' }, [el('span', { style: { width: `${period.percent}%` } })]),
      el('div', { class: 'd period-line' }, [
        el('span', { text: periodLabel(period) }),
        el('span', { class: 'pct', text: `${period.percent}%` }),
      ]),
    );
  }

  // 디데이에도 체크리스트를 보여 주고 바로 체크할 수 있게 합니다.
  if (!compact) info.append(...checklistNodes(item, { limit: 5, withBar: false }));

  const parts = [
    el('div', { class: 'big', text: ddayLabel(item.dueDate) }),
    info,
  ];

  let cover = null;
  if (!compact && (item.photoIds || []).length) {
    const photos = await media.getPhotos(item.photoIds);
    if (photos.length) {
      cover = el('img', {
        class: 'cover',
        src: media.photoURL(photos[0]),
        alt: '',
        loading: 'lazy',
        onclick: (e) => { e.stopPropagation(); openViewer(media.photoURL(photos[0], { full: true })); },
      });
    }
  }

  // 사진이 있으면 사진을 위에 깔고 그 아래에 내용을 한 줄로 놓습니다.
  const card = cover
    ? el('article', { class: cls.join(' ') + ' with-photo' }, [cover, el('div', { class: 'row' }, parts)])
    : el('article', { class: cls.join(' ') }, parts);
  card.addEventListener('click', () => editItem(item.id));
  return card;
}

/**
 * 카드 안에 넣을 체크리스트 조각을 만듭니다.
 * 할 일 카드와 디데이 카드가 같은 모양을 쓰도록 여기서 한 번만 만듭니다.
 * withBar 는 완료율 막대를 함께 그릴지 여부입니다.
 * (디데이 카드에는 기간 진행 막대가 이미 있어 헷갈리지 않도록 숫자로만 보여 줍니다.)
 */
function checklistNodes(item, { limit = 6, withBar = true } = {}) {
  const checks = item.checklist || [];
  if (!checks.length) return [];
  const doneCount = checks.filter((c) => c.done).length;
  const nodes = [];

  if (withBar) {
    nodes.push(el('div', { class: 'progress' }, [
      el('span', { style: { width: `${Math.round((doneCount / checks.length) * 100)}%` } }),
    ]));
  } else {
    nodes.push(el('div', { class: 'check-count' }, [
      el('span', { text: `체크리스트 ${doneCount}/${checks.length}` }),
    ]));
  }

  const ul = el('ul', { class: 'mini-checks' });
  checks.slice(0, limit).forEach((c) => {
    ul.append(el('li', { class: c.done ? 'on' : '' }, [
      el('button', {
        type: 'button',
        class: 'box',
        text: '✓',
        'aria-label': c.text,
        onclick: (e) => { e.stopPropagation(); store.toggleChecklistItem(item.id, c.id); },
      }),
      el('span', { class: 'txt', text: c.text }),
    ]));
  });
  if (checks.length > limit) {
    ul.append(el('li', {}, [el('span', { class: 'txt', text: `그 외 ${checks.length - limit}개` })]));
  }
  nodes.push(ul);
  return nodes;
}

/** 시작일이 제대로 들어 있는 항목만 기간 정보를 돌려줍니다. */
function itemPeriod(item) {
  if (!item.startDate || !item.dueDate) return null;
  if (item.startDate > item.dueDate) return null;
  return periodProgress(item.startDate, item.dueDate);
}

function periodLabel(p) {
  if (p.phase === 'before') return `시작까지 ${p.untilStart}일`;
  if (p.phase === 'after') return `${p.total}일 기간 종료`;
  return `${p.total}일 중 ${p.elapsed}일째 · ${p.remaining}일 남음`;
}

/* ---------------- 가계부 ---------------- */

async function renderMoney() {
  const monthKey = state.moneyMonth;
  const sum = await money.summary(monthKey);
  const rows = await money.forMonth(monthKey);

  const header = [
    title('가계부', money.formatMonth(monthKey)),
    iconBtn('jumpToday', '이번 달로', () => {
      state.moneyMonth = money.thisMonthKey();
      render();
    }),
  ];

  const content = [];

  /* 월 이동 */
  content.push(el('div', { class: 'cal-head' }, [
    el('button', { type: 'button', text: '‹', 'aria-label': '이전 달',
      onclick: () => { state.moneyMonth = money.shiftMonthKey(monthKey, -1); render(); } }),
    el('div', { class: 'month', text: money.formatMonth(monthKey) }),
    el('button', { type: 'button', text: '›', 'aria-label': '다음 달',
      onclick: () => { state.moneyMonth = money.shiftMonthKey(monthKey, 1); render(); } }),
  ]));

  /* 요약 — 오늘 / 이번 달 / 신용카드 */
  content.push(el('div', { class: 'stat-row' }, [
    statTile('오늘 쓴 돈', money.formatWon(sum.today), sum.todayCount ? `${sum.todayCount}건` : '기록 없음', 'today'),
    statTile('이 달 지출', money.formatWon(sum.month), `${sum.count}건`, 'total'),
    statTile('신용카드', money.formatWon(sum.credit), sum.month ? `지출의 ${Math.round((sum.credit / sum.month) * 100)}%` : '—', 'card'),
  ]));

  /* 결제수단별 · 수입 */
  const breakdown = el('div', { class: 'settings-group' });
  breakdown.append(el('div', { class: 'head', text: '이 달 내역' }));
  [
    ['신용카드', sum.credit],
    ['체크카드', sum.debit],
    ['현금', sum.cash],
    ['계좌이체', sum.month - sum.credit - sum.debit - sum.cash],
  ].forEach(([label, value]) => {
    if (!value) return;
    breakdown.append(el('div', { class: 'settings-row' }, [
      el('div', { class: 'grow' }, [el('div', { class: 'label', text: label })]),
      el('span', { class: 'value money-num', text: money.formatWon(value) }),
    ]));
  });
  if (sum.income) {
    breakdown.append(el('div', { class: 'settings-row' }, [
      el('div', { class: 'grow' }, [el('div', { class: 'label', text: '수입' })]),
      el('span', { class: 'value money-num income', text: money.formatWon(sum.income, { sign: true }) }),
    ]));
    breakdown.append(el('div', { class: 'settings-row' }, [
      el('div', { class: 'grow' }, [el('div', { class: 'label', text: '남은 금액' })]),
      el('span', { class: 'value money-num', text: money.formatWon(sum.income - sum.month, { sign: true }) }),
    ]));
  }
  if (breakdown.children.length > 1) content.push(breakdown);

  /* 분류별 */
  const cats = await money.byCategory(monthKey);
  if (cats.length) {
    content.push(section('분류별'));
    const list = el('div', { class: 'cat-list' });
    cats.slice(0, 6).forEach((c) => {
      list.append(el('div', { class: 'cat-row' }, [
        el('span', { class: 'cat-emoji', text: c.info.emoji }),
        el('div', { class: 'cat-body' }, [
          el('div', { class: 'cat-top' }, [
            el('span', { text: c.info.label }),
            el('span', { class: 'money-num', text: money.formatWon(c.amount) }),
          ]),
          el('div', { class: 'progress' }, [el('span', { style: { width: `${c.percent}%` } })]),
        ]),
        el('span', { class: 'cat-pct', text: `${c.percent}%` }),
      ]));
    });
    content.push(list);
  }

  /* 날짜별 목록 */
  if (!rows.length) {
    content.push(el('div', { class: 'empty' }, [
      el('span', { class: 'big', text: '🧾' }),
      el('p', { text: '이 달에 기록한 내역이 없습니다.' }),
      el('p', { text: '아래 ＋ 버튼으로 오늘 쓴 돈을 적어 보세요.' }),
    ]));
  } else {
    content.push(section('전체 내역', rows.length));
    const wrap = el('div', { class: 'card-list' });
    money.groupByDate(rows).forEach((day) => {
      wrap.append(el('div', { class: 'day-head' }, [
        el('span', { text: day.label }),
        el('span', { class: 'money-num', text: money.formatWon(day.spent) }),
      ]));
      day.rows.forEach((r) => wrap.append(expenseRow(r)));
    });
    content.push(wrap);
  }

  return [header, content];
}

function statTile(label, value, sub, kind) {
  return el('div', { class: `stat-tile ${kind}` }, [
    el('div', { class: 'stat-label', text: label }),
    el('div', { class: 'stat-value', text: value }),
    el('div', { class: 'stat-sub', text: sub }),
  ]);
}

function expenseRow(r) {
  const cat = money.categoryInfo(r.category, r.type);
  const isIncome = r.type === 'income';
  return el('button', {
    type: 'button',
    class: 'expense-row',
    onclick: async () => { await openExpenseEditor(r); },
  }, [
    el('span', { class: 'ex-emoji', text: cat.emoji }),
    el('div', { class: 'ex-body' }, [
      el('div', { class: 'ex-title', text: r.memo || cat.label }),
      el('div', { class: 'ex-meta' }, [
        el('span', { class: 'chip', text: money.methodInfo(r.method).label }),
        r.memo ? el('span', { class: 'chip', text: cat.label }) : null,
      ]),
    ]),
    el('span', {
      class: 'ex-amount money-num' + (isIncome ? ' income' : ''),
      text: isIncome ? money.formatWon(r.amount, { sign: true }) : money.formatWon(r.amount),
    }),
  ]);
}

async function createExpense(defaults = {}) {
  const saved = await openExpenseEditor(null, defaults);
  if (saved) toast('기록했습니다.');
}

/* ---------------- 검색 ---------------- */

function openSearch() {
  openSheet({
    title: '검색',
    showConfirm: false,
    cancelLabel: '닫기',
    buildBody: ({ body, close }) => {
      const results = el('div', { class: 'card-list', style: { marginTop: '10px' } });
      const input = el('input', {
        type: 'text',
        placeholder: '제목, 메모, 체크리스트에서 찾기',
        'data-autofocus': '',
        oninput: debounce(async (e) => {
          const q = e.target.value;
          if (!q.trim()) { results.replaceChildren(); return; }
          const found = await store.searchItems(q);
          results.replaceChildren();
          if (!found.length) {
            results.append(el('div', { class: 'empty' }, [el('p', { text: '결과가 없습니다.' })]));
            return;
          }
          const folders = await store.getFolders();
          const byId = new Map(folders.map((f) => [f.id, f]));
          for (const it of found.slice(0, 50)) {
            const card = await itemCard(it, byId.get(it.folderId));
            card.addEventListener('click', () => close(null), { once: true });
            results.append(card);
          }
        }, 180),
      });
      body.append(el('div', { class: 'search-bar' }, [el('span', { text: '🔍' }), input]), results);
    },
  });
}

/* ---------------- 설정 ---------------- */

async function renderSettings() {
  const header = [title('설정')];
  const content = [];

  const perm = notify.permission();
  const est = await db.storageEstimate();
  const photoBytes = await media.photoStorageSize();
  const items = await store.getItems();
  const lockOn = await lock.isEnabled();
  const doneCount = items.filter((i) => i.done).length;

  content.push(el('div', { class: 'notice' }, [
    el('span', { class: 'ico', text: '🔒' }),
    el('span', {
      html: '모든 데이터는 <b>이 기기 안에만</b> 저장됩니다. 인터넷으로 전송되거나 서버에 올라가지 않습니다. '
        + '앱 데이터를 지우거나 브라우저 저장소를 비우면 복구할 수 없으니, 중요한 내용은 아래에서 백업해 두세요.',
    }),
  ]));

  /* 알림 */
  const notifGroup = group('알림');
  notifGroup.append(settingsRow({
    label: '알림 권한',
    desc: perm === 'granted' ? '허용됨 — 지정한 시각에 알림이 옵니다.'
      : perm === 'denied' ? '차단됨 — 브라우저(사이트) 설정에서 알림을 허용해 주세요.'
        : perm === 'unsupported' ? '이 브라우저는 알림을 지원하지 않습니다.'
          : '아직 허용하지 않았습니다.',
    value: perm === 'granted' ? '✓' : '',
    onclick: perm === 'default' ? async () => {
      const r = await notify.requestPermission();
      toast(r === 'granted' ? '알림을 허용했습니다.' : '알림이 허용되지 않았습니다.');
      render();
    } : null,
  }));
  if (notify.needsInstallForNotifications()) {
    notifGroup.append(settingsRow({
      label: '아이폰에서 알림 받기',
      desc: 'Safari 공유 버튼 → "홈 화면에 추가"로 설치한 뒤, 홈 화면 아이콘으로 열면 알림을 켤 수 있습니다.',
    }));
  }
  notifGroup.append(settingsRow({
    label: '테스트 알림 보내기',
    desc: '알림이 정상적으로 뜨는지 확인합니다.',
    onclick: async () => {
      if (notify.permission() !== 'granted') { toast('먼저 알림을 허용해 주세요.'); return; }
      const ok = await notify.testNotification();
      toast(ok ? '알림을 보냈습니다.' : '알림을 보내지 못했습니다.');
    },
  }));
  const upcoming = await store.upcomingReminders();
  notifGroup.append(settingsRow({
    label: '예정된 알림',
    desc: upcoming.length
      ? upcoming.slice(0, 3).map((i) => `${i.title} · ${new Date(i.remindAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`).join('\n')
      : '앞으로 7일 안에 예정된 알림이 없습니다.',
    value: String(upcoming.length),
  }));
  content.push(notifGroup);

  /* 잠금 */
  const lockGroup = group('보안');
  lockGroup.append(settingsRow({
    label: '화면 잠금 (PIN)',
    desc: lockOn ? '앱을 열 때 PIN을 물어봅니다.' : '숫자 4~10자리로 앱을 잠글 수 있습니다.',
    value: lockOn ? '켜짐' : '꺼짐',
    onclick: async () => {
      if (lockOn) {
        const pin = await pinPrompt('PIN 확인', '잠금을 해제하려면 현재 PIN을 입력하세요.');
        if (pin === null) return;
        const ok = await lock.disable(pin);
        toast(ok ? '화면 잠금을 껐습니다.' : 'PIN이 맞지 않습니다.');
      } else {
        const pin = await pinPrompt('새 PIN', '숫자 4~10자리를 입력하세요.');
        if (pin === null) return;
        const again = await pinPrompt('PIN 확인', '한 번 더 입력하세요.');
        if (again === null) return;
        if (pin !== again) { toast('두 번 입력한 PIN이 다릅니다.'); return; }
        try {
          await lock.setPin(pin);
          toast('화면 잠금을 켰습니다.');
        } catch (e) { toast(e.message); }
      }
      render();
    },
  }));
  if (lockOn) {
    const mins = await lock.autoLockMinutes();
    lockGroup.append(settingsRow({
      label: '자동 잠금',
      desc: '앱을 벗어난 뒤 이 시간이 지나면 다시 잠깁니다.',
      value: mins === 0 ? '바로' : `${mins}분 후`,
      onclick: async () => {
        const v = await pickerSheet({
          title: '자동 잠금',
          value: mins,
          options: [
            { value: 0, label: '바로' },
            { value: 1, label: '1분 후' },
            { value: 5, label: '5분 후' },
            { value: 15, label: '15분 후' },
            { value: 60, label: '1시간 후' },
          ],
        });
        if (v === null) return;
        await lock.setAutoLockMinutes(v);
        render();
      },
    }));
  }
  content.push(lockGroup);

  /* 표시 */
  const viewGroup = group('표시');
  viewGroup.append(settingsRow({
    label: '테마',
    value: THEME_LABELS[state.settings.theme] || '기기 설정',
    onclick: async () => {
      const v = await pickerSheet({
        title: '테마',
        value: state.settings.theme,
        options: [
          { value: 'mono', label: '흰색 · 검정', emoji: '🖤', desc: '흰 바탕에 검정 포인트' },
          { value: 'sky', label: '흰색 · 하늘', emoji: '🩵', desc: '흰 바탕에 하늘색 포인트' },
          { value: 'sunny', label: '흰색 · 노랑', emoji: '💛', desc: '흰 바탕에 노랑 포인트' },
          { value: 'modern', label: '모던', emoji: '🌿', desc: '짙은 먹색 바탕에 민트 포인트' },
          { value: 'light', label: '밝게', emoji: '☀️' },
          { value: 'dark', label: '어둡게', emoji: '🌙' },
          { value: 'auto', label: '기기 설정 따르기', emoji: '⚙️' },
        ],
      });
      if (v === null) return;
      state.settings.theme = v;
      // 저장을 기다리지 않고 화면부터 바꿔 줍니다.
      applyTheme(v);
      await db.setMeta('settings', state.settings);
      render();
    },
  }));
  viewGroup.append(settingsRow({
    label: '완료한 항목 숨기기',
    desc: '목록에서 완료 표시된 항목을 감춥니다.',
    toggle: state.settings.hideCompleted,
    onclick: async () => {
      state.settings.hideCompleted = !state.settings.hideCompleted;
      await db.setMeta('settings', state.settings);
      render();
    },
  }));
  if (badgeSupported()) {
    viewGroup.append(settingsRow({
      label: '홈 화면 아이콘에 개수 표시',
      desc: '오늘 남은 할 일 개수를 앱 아이콘 위에 숫자로 띄웁니다.',
      toggle: state.settings.showBadge !== false,
      onclick: async () => {
        state.settings.showBadge = state.settings.showBadge === false;
        await db.setMeta('settings', state.settings);
        render();
      },
    }));
  }
  content.push(viewGroup);

  /* 데이터 */
  const dataGroup = group('데이터');
  dataGroup.append(settingsRow({
    label: '백업 파일 내보내기',
    desc: '할 일·폴더·사진을 JSON 파일 하나로 저장합니다. 기기를 바꿀 때 사용하세요.',
    onclick: exportData,
  }));
  dataGroup.append(settingsRow({
    label: '백업 파일 가져오기',
    desc: '내보낸 JSON 파일을 불러옵니다.',
    onclick: importData,
  }));
  dataGroup.append(settingsRow({
    label: '저장 공간',
    desc: `항목 ${items.length}개 · 가계부 ${(await money.getAll()).length}건 · 사진 ${bytesToText(photoBytes)}`
      + (est ? ` · 앱 전체 ${bytesToText(est.usage)}${est.quota ? ` / ${bytesToText(est.quota)}` : ''}` : ''),
  }));
  dataGroup.append(settingsRow({
    label: '완료한 항목 정리',
    desc: `완료 표시된 ${doneCount}개를 지웁니다.`,
    onclick: doneCount ? async () => {
      const ok = await confirmDialog({
        title: '완료 항목 정리',
        message: `완료한 ${doneCount}개 항목을 삭제할까요?`,
        confirmLabel: '삭제',
        danger: true,
      });
      if (!ok) return;
      const n = await store.purgeCompleted();
      toast(`${n}개를 정리했습니다.`);
      render();
    } : null,
  }));
  dataGroup.append(settingsRow({
    label: '모든 데이터 삭제',
    danger: true,
    desc: '이 기기에 저장된 할 일, 폴더, 사진, 설정을 전부 지웁니다.',
    onclick: async () => {
      const ok = await confirmDialog({
        title: '전체 삭제',
        message: '정말로 모든 데이터를 지울까요? 백업이 없으면 복구할 수 없습니다.',
        confirmLabel: '전부 삭제',
        danger: true,
      });
      if (!ok) return;
      media.releasePhotoURLs();
      await store.wipeAll();
      await store.ensureSeed();
      toast('모두 삭제했습니다.');
      go('today');
    },
  }));
  content.push(dataGroup);

  /* 앱 정보 */
  const aboutGroup = group('앱');
  if (!notify.isStandalone()) {
    aboutGroup.append(settingsRow({
      label: '홈 화면에 추가하기',
      desc: 'iPhone: 공유 버튼 → 홈 화면에 추가 / Android: 메뉴 → 앱 설치. 설치하면 주소창 없이 앱처럼 열립니다.',
    }));
  }
  aboutGroup.append(settingsRow({
    label: '버전',
    desc: '눌러서 최신 버전을 확인하고 새로 불러옵니다.',
    value: APP_VERSION,
    onclick: checkForUpdate,
  }));
  content.push(aboutGroup);

  return [header, content];
}

function group(name) {
  return el('section', { class: 'settings-group' }, [el('div', { class: 'head', text: name })]);
}

function settingsRow({ label, desc, value, onclick, toggle, danger }) {
  const children = [
    el('div', { class: 'grow' }, [
      el('div', { class: 'label', text: label }),
      desc ? el('div', { class: 'desc', text: desc, style: { whiteSpace: 'pre-line' } }) : null,
    ]),
  ];
  if (toggle !== undefined) {
    children.push(el('span', { class: 'switch', role: 'switch', 'aria-checked': String(!!toggle) }));
  } else if (value) {
    children.push(el('span', { class: 'value', text: value }));
  } else if (onclick) {
    children.push(el('span', { class: 'value', text: '›' }));
  }
  const cls = 'settings-row' + (danger ? ' danger' : '');
  return onclick
    ? el('button', { type: 'button', class: cls, onclick }, children)
    : el('div', { class: cls }, children);
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (state.settings.theme === 'auto') applyTheme('auto');
});

const THEME_LABELS = {
  auto: '기기 설정',
  dark: '어둡게',
  light: '밝게',
  sky: '흰색·하늘',
  mono: '흰색·검정',
  sunny: '흰색·노랑',
  modern: '모던',
};

const THEME_COLORS = {
  dark: '#0f1115', light: '#f4f5f8', sky: '#f3faff',
  modern: '#0b0c0e', mono: '#f5f5f6', sunny: '#fffdf4',
};

/** 'auto'는 기기 설정을 읽어 실제 테마로 바꿔 줍니다. */
function resolveTheme(theme) {
  if (theme !== 'auto') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme) {
  const resolved = resolveTheme(theme);
  document.documentElement.setAttribute('data-theme', resolved);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[resolved] || THEME_COLORS.dark);
  // 다음에 앱을 열 때 화면이 깜빡이지 않도록 미리 저장해 둡니다.
  try { localStorage.setItem('theme', theme); } catch { /* 저장을 막아 둔 브라우저 */ }
}

/* ---------------- 백업 ---------------- */

async function exportData() {
  toast('백업 파일을 만드는 중…');
  try {
    const data = await store.exportBackup(true);
    const json = JSON.stringify(data);
    const blob = new Blob([json], { type: 'application/json' });
    const name = `todo-backup-${todayKey()}.json`;

    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: '할 일 백업' });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('백업 파일을 저장했습니다.');
  } catch (e) {
    console.error(e);
    toast('백업에 실패했습니다.');
  }
}

function importData() {
  const input = el('input', { type: 'file', accept: 'application/json,.json', class: 'hidden' });
  document.body.append(input);
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.remove();
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const mode = await pickerSheet({
        title: '가져오기 방식',
        options: [
          { value: 'merge', label: '합치기', desc: '지금 데이터를 두고 백업 내용을 더합니다.' },
          { value: 'replace', label: '덮어쓰기', desc: '지금 데이터를 모두 지우고 백업으로 바꿉니다.' },
        ],
      });
      if (!mode) return;
      if (mode === 'replace') {
        const ok = await confirmDialog({
          title: '덮어쓰기',
          message: '현재 기기에 있는 데이터를 모두 지우고 백업으로 바꿉니다.',
          confirmLabel: '덮어쓰기',
          danger: true,
        });
        if (!ok) return;
        media.releasePhotoURLs();
      }
      const n = await store.importBackup(data, mode);
      toast(`항목 ${n.items}개, 폴더 ${n.folders}개, 가계부 ${n.expenses}건, 사진 ${n.photos}장을 가져왔습니다.`);
      render();
    } catch (e) {
      console.error(e);
      toast(e.message || '파일을 읽지 못했습니다.');
    }
  });
  input.click();
}

/* ---------------- 잠금 화면 ---------------- */

/** PIN 입력을 받는 작은 시트. 취소하면 null을 돌려줍니다. */
function pinPrompt(title, message) {
  let value = '';
  return openSheet({
    title,
    confirmLabel: '확인',
    buildBody: ({ body, setConfirmEnabled }) => {
      setConfirmEnabled(false);
      body.append(el('p', {
        text: message,
        style: { margin: '2px 0 4px', fontSize: '14px', color: 'var(--text-dim)' },
      }));
      const input = el('input', {
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
      });
      body.append(input);
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
        keypad.append(el('button', {
          type: 'button', text: '→', 'aria-label': '확인', onclick: submit,
        }));
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

/* ---------------- 항목 만들기/열기 ---------------- */

async function createItem(defaults = {}) {
  const base = { ...defaults };
  if (state.tab === 'calendar' && !base.dueDate) base.dueDate = state.selectedDate;
  if (state.tab === 'dday' && !base.type) base.type = 'dday';
  if (state.tab === 'folders' && state.folderId && state.folderId !== 'none' && !base.folderId) {
    base.folderId = state.folderId;
  }
  const saved = await openItemEditor(null, base);
  if (saved) toast('저장했습니다.');
}

async function editItem(id) {
  const item = await store.getItem(id);
  if (!item) return;
  await openItemEditor(item);
}

async function openItemById(id) {
  const item = await store.getItem(id);
  if (item) await openItemEditor(item);
}

function handleLaunchParams() {
  const params = new URLSearchParams(location.search);
  const itemId = params.get('item');
  if (itemId) {
    history.replaceState(null, '', location.pathname);
    setTimeout(() => openItemById(itemId), 300);
  }
  if (params.get('action') === 'new') {
    history.replaceState(null, '', location.pathname);
    setTimeout(() => createItem(), 300);
  }
}

/* ---------------- 알림 안내 배너 ---------------- */

async function notificationBanner() {
  const perm = notify.permission();
  if (perm === 'granted' || perm === 'unsupported') return null;
  const dismissed = await db.getMeta('notifBannerDismissed', false);
  if (dismissed) return null;

  if (notify.needsInstallForNotifications()) {
    return el('div', { class: 'notice' }, [
      el('span', { class: 'ico', text: '📲' }),
      el('div', {}, [
        el('div', { text: '알림을 받으려면 홈 화면에 추가해 주세요.' }),
        el('div', { style: { color: 'var(--text-dim)', marginTop: '4px', fontSize: '12.5px' },
          text: 'Safari 아래 공유 버튼 → "홈 화면에 추가" → 홈 화면 아이콘으로 열기' }),
        el('button', {
          type: 'button', style: { marginTop: '6px' }, text: '다시 보지 않기',
          onclick: async () => { await db.setMeta('notifBannerDismissed', true); render(); },
        }),
      ]),
    ]);
  }

  if (perm === 'denied') {
    return el('div', { class: 'notice warn' }, [
      el('span', { class: 'ico', text: '🔕' }),
      el('div', {}, [
        el('div', { text: '알림이 차단되어 있습니다. 브라우저의 사이트 설정에서 알림을 허용해 주세요.' }),
        el('button', {
          type: 'button', style: { marginTop: '6px' }, text: '다시 보지 않기',
          onclick: async () => { await db.setMeta('notifBannerDismissed', true); render(); },
        }),
      ]),
    ]);
  }

  return el('div', { class: 'notice' }, [
    el('span', { class: 'ico', text: '🔔' }),
    el('div', {}, [
      el('div', { text: '일정 시각에 알림을 받으시겠어요?' }),
      el('button', {
        type: 'button', style: { marginTop: '6px' }, text: '알림 켜기',
        onclick: async () => {
          const r = await notify.requestPermission();
          toast(r === 'granted' ? '알림을 켰습니다.' : '알림이 허용되지 않았습니다.');
          render();
        },
      }),
    ]),
  ]);
}

/* ---------------- 서비스 워커 ---------------- */

let swRegistration = null;
let reloading = false;

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  // 페이지를 열 때 이미 서비스 워커가 있었는지 기억해 둡니다.
  // 처음 설치될 때는 새로고침할 필요가 없습니다.
  const hadController = !!navigator.serviceWorker.controller;

  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'open-item') openItemById(e.data.itemId);
    if (e.data && e.data.type === 'reminders-checked') { store.invalidate(); render(); }
    if (e.data && e.data.type === 'app-updated') {
      // 새 코드가 돌고 있다고 알려 주면 서비스 워커가 강제로 새로고침하지 않습니다.
      if (e.ports && e.ports[0]) e.ports[0].postMessage('ack');
      applyUpdate();
    }
  });

  // 새 버전이 실제로 넘겨받으면 화면도 새 코드로 바꿔 줍니다.
  // 이게 없으면 앱은 예전 파일을 계속 띄운 채로 남습니다.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    applyUpdate();
  });

  try {
    swRegistration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    // 앱을 다시 열 때마다 새 버전이 있는지 확인합니다.
    swRegistration.update().catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && swRegistration) {
        swRegistration.update().catch(() => {});
      }
    });
  } catch (e) {
    console.warn('서비스 워커 등록 실패', e);
  }
}

/**
 * 새 버전을 화면에 반영합니다.
 * 편집 중이면 입력을 날리지 않도록 물어보고 넘어갑니다.
 */
function applyUpdate() {
  if (reloading) return;
  if (document.querySelector('.sheet-backdrop')) {
    toast('새 버전이 준비되었습니다.', {
      action: '새로고침',
      onAction: () => { reloading = true; location.reload(); },
      duration: 10000,
    });
    return;
  }
  reloading = true;
  location.reload();
}

/** 설정에서 직접 업데이트를 확인할 때 */
async function checkForUpdate() {
  if (!swRegistration) {
    location.reload();
    return;
  }
  toast('업데이트를 확인하는 중…');
  try {
    await swRegistration.update();
  } catch {
    /* 오프라인이면 그냥 새로고침합니다. */
  }
  reloading = true;
  setTimeout(() => location.reload(), 600);
}

/* ---------------- 시작 ---------------- */

window.addEventListener('DOMContentLoaded', () => {
  boot().catch((err) => {
    console.error(err);
    document.body.append(el('div', { class: 'empty' }, [
      el('span', { class: 'big', text: '😢' }),
      el('p', { text: '앱을 시작하지 못했습니다: ' + (err.message || err) }),
    ]));
  });
});
