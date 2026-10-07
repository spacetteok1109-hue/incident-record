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

const APP_VERSION = '2.8.0';

const state = {
  tab: 'calendar',
  cal: { y: new Date().getFullYear(), m: new Date().getMonth() },
  moneyMonth: money.thisMonthKey(),
  // 가계부에서 골라 둔 결제수단. 'all' 이면 전부 합쳐 봅니다.
  moneyMethod: 'all',
  showDoneDday: false,
  showCardPlans: false,
  // 모아보기에서 펼쳐 둔 묶음. 처음에는 모두 접어 두고 눌러서 폅니다.
  openGroups: new Set(),
  selectedDate: todayKey(),
  folderId: null,
  settings: { theme: 'auto', hideCompleted: false, showBadge: true, showDdayOnCalendar: true },
};

const main = () => $('#view');

/* ==========================================================
   시작
   ========================================================== */

async function boot() {
  await db.openDB();
  await store.ensureSeed();
  state.settings = { ...state.settings, ...(await db.getMeta('settings', {})) };
  await money.loadCategories();
  applyTheme(state.settings.theme);
  await store.migrateEventsToTasks();
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
  { id: 'calendar', label: '캘린더', ico: 'calendar' },
  { id: 'list', label: '모아보기', ico: 'folder' },
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
    case 'list': [header, content] = await renderList(); break;
    case 'money': [header, content] = await renderMoney(); break;
    case 'settings': [header, content] = await renderSettings(); break;
    default: [header, content] = await renderCalendar();
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

/** 캘린더 위에 붙는 한 줄 요약 — 칸을 많이 먹지 않게 작게 둡니다. */
async function calendarSummary() {
  const out = [];

  const banner = await notificationBanner();
  if (banner) out.push(banner);

  const { overdue } = await store.todayBuckets();
  const spend = await money.summary();
  const chips = [];

  if (overdue.length) {
    chips.push(el('button', {
      type: 'button',
      class: 'sum-chip warn',
      onclick: () => {
        state.selectedDate = overdue[0].dueDate;
        state.cal = {
          y: Number(overdue[0].dueDate.slice(0, 4)),
          m: Number(overdue[0].dueDate.slice(5, 7)) - 1,
        };
        render();
      },
    }, [
      el('span', { class: 'sc-dot' }),
      el('span', { class: 'sc-label', text: '지난 할 일' }),
      el('span', { class: 'sc-value', text: `${overdue.length}개` }),
    ]));
  }

  if (spend.today || spend.todayCount) {
    chips.push(el('button', {
      type: 'button',
      class: 'sum-chip',
      onclick: () => go('money'),
    }, [
      el('span', { class: 'sc-label', text: '오늘 쓴 돈' }),
      el('span', { class: 'sc-value money-num', text: money.formatWon(spend.today) }),
    ]));
  }

  if (chips.length) out.push(el('div', { class: 'sum-row' }, chips));
  return out;
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

async function itemCard(item, folder, { showFolder = true } = {}) {
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
  // 폴더 안에서 보고 있을 때는 같은 이름을 또 붙이지 않습니다.
  if (folder && showFolder) {
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

  const content = [...(await calendarSummary())];

  content.push(el('div', { class: 'cal-head' }, [
    el('button', { type: 'button', text: '‹', 'aria-label': '이전 달', onclick: () => shiftMonth(-1) }),
    el('div', { class: 'month', text: `${y}년 ${m + 1}월` }),
    el('button', { type: 'button', text: '›', 'aria-label': '다음 달', onclick: () => shiftMonth(1) }),
  ]));

  const wd = el('div', { class: 'weekdays' });
  WEEKDAYS.forEach((w, i) => wd.append(el('div', {
    class: i === 0 ? 'sun' : i === 6 ? 'sat' : '',
    text: w,
  })));
  content.push(wd);

  const withDday = state.settings.showDdayOnCalendar !== false;
  const cells = monthGrid(y, m);
  const from = cells[0].key;
  const to = cells[cells.length - 1].key;
  const summary = await store.rangeSummary(from, to, { includeDday: withDday });
  const spans = await store.spanningItems(from, to, { includeDday: withDday });
  const folders = await store.getFolders();
  const folderColor = new Map(folders.map((f) => [f.id, f.color]));

  const grid = el('div', { class: 'cal-grid' });
  for (let w = 0; w < 6; w++) {
    const week = cells.slice(w * 7, w * 7 + 7);
    grid.append(calendarWeek(week, summary, spans, folderColor));
  }
  content.push(grid);

  content.push(await dayPanel(state.selectedDate));
  return [header, content];
}

/** 한 주(7칸) + 그 주를 가로지르는 기간 막대 */
function calendarWeek(week, summary, spans, folderColor) {
  const spanIds = new Set(spans.map((it) => it.id));
  const lanes = layoutSpans(week, spans);
  const laneCount = Math.min(lanes.length, 3);

  const row = el('div', { class: 'cal-week' });
  const cellWrap = el('div', { class: 'cal-week-cells' });

  week.forEach((cell) => {
    const dow = cell.date.getDay();
    const s = summary.get(cell.key);
    const btn = el('button', {
      type: 'button',
      class: [
        'cal-cell',
        cell.inMonth ? '' : 'out',
        cell.isToday ? 'today' : '',
        state.selectedDate === cell.key ? 'selected' : '',
        s && s.overdue ? 'overdue' : '',
        dow === 0 ? 'sun' : dow === 6 ? 'sat' : '',
      ].filter(Boolean).join(' '),
      'aria-label': `${cell.date.getMonth() + 1}월 ${cell.date.getDate()}일`,
      style: { '--lanes': String(laneCount) },
      onclick: () => {
        state.selectedDate = cell.key;
        if (!cell.inMonth) state.cal = { y: cell.date.getFullYear(), m: cell.date.getMonth() };
        render();
      },
    }, [el('span', { class: 'num', text: String(cell.date.getDate()) })]);

    // 줄로 그린 항목은 빼고, 나머지는 점으로. 색은 폴더 색을 따릅니다.
    if (s && s.marks) {
      const dotMarks = s.marks.filter((m) => !spanIds.has(m.id));
      if (dotMarks.length) {
        const dots = el('div', { class: 'dots' });
        dotMarks.slice(0, 4).forEach((m) => {
          const color = folderColor.get(m.folderId) || null;
          const style = {};
          if (m.type === 'dday') {
            // 디데이는 같은 색의 빈 동그라미로 구분합니다.
            style.background = 'transparent';
            style.borderColor = color || 'var(--accent)';
          } else if (color) {
            style.background = color;
            style.borderColor = color;
          }
          dots.append(el('i', {
            class: (m.done ? 'done' : '') + (m.type === 'dday' ? ' dday' : ''),
            style,
          }));
        });
        if (dotMarks.length > 4) dots.append(el('i', { class: 'more' }));
        btn.append(dots);
      }
    }
    cellWrap.append(btn);
  });

  row.append(cellWrap);

  if (laneCount) {
    const bars = el('div', { class: 'cal-bars', style: { '--lanes': String(laneCount) } });
    lanes.slice(0, 3).forEach((lane, li) => {
      lane.forEach((seg) => {
        const color = folderColor.get(seg.item.folderId);
        bars.append(el('div', {
          class: 'cal-bar'
            + (seg.item.type === 'dday' ? ' dday' : '')
            + (seg.item.done ? ' done' : '')
            + (seg.startsHere ? ' start' : '')
            + (seg.endsHere ? ' end' : ''),
          style: {
            left: `calc(${(seg.from / 7) * 100}% + 2px)`,
            width: `calc(${((seg.to - seg.from + 1) / 7) * 100}% - 4px)`,
            top: `${li * LANE_H}px`,
            // 색은 CSS 로 넘겨, 배경만 반투명하게 하고 글씨는 또렷하게 둡니다.
            '--bc': color || 'var(--accent)',
          },
          title: seg.item.title,
        }, [seg.startsHere ? el('span', { text: seg.item.title }) : null]));
      });
    });
    row.append(bars);
  }
  return row;
}

/** 기간 막대 한 줄의 높이(px). CSS 의 --lane-h 와 맞춰 둡니다. */
const LANE_H = 17;

/** 그 주를 지나가는 항목들을 겹치지 않게 줄(lane)에 배치합니다. */
function layoutSpans(week, spans) {
  const first = week[0].key;
  const last = week[6].key;
  const lanes = [];

  for (const item of spans) {
    if (item.dueDate < first || item.startDate > last) continue;
    const from = Math.max(0, week.findIndex((c) => c.key >= item.startDate));
    let to = week.findIndex((c) => c.key > item.dueDate);
    to = to === -1 ? 6 : to - 1;
    if (to < from) continue;

    const seg = {
      item,
      from,
      to,
      startsHere: item.startDate >= first,
      endsHere: item.dueDate <= last,
    };
    let placed = false;
    for (const lane of lanes) {
      if (lane.every((s2) => seg.to < s2.from || seg.from > s2.to)) {
        lane.push(seg);
        placed = true;
        break;
      }
    }
    if (!placed) lanes.push([seg]);
  }
  return lanes;
}

/** 날짜를 고르면 그 날의 일정과 가계부를 함께 보여 줍니다. */
async function dayPanel(dateKey) {
  const items = await store.itemsForDate(dateKey);
  const expenses = await money.forDate(dateKey);
  const spent = expenses.filter((r) => r.type !== 'income').reduce((t, r) => t + r.amount, 0);
  const earned = expenses.filter((r) => r.type === 'income').reduce((t, r) => t + r.amount, 0);

  const panel = el('section', { class: 'day-panel' }, [
    el('h2', {}, [
      el('span', { text: formatDate(dateKey, { withYear: false }) }),
      el('span', { class: 'dday-tag', text: relativeDateLabel(dateKey) }),
    ]),
    el('div', { class: 'day-actions' }, [
      el('button', {
        type: 'button', class: 'chip accent', text: '＋ 할 일',
        onclick: () => createItem({ dueDate: dateKey }),
      }),
      el('button', {
        type: 'button', class: 'chip', text: '＋ 지출',
        onclick: () => createExpense({ date: dateKey }),
      }),
    ]),
  ]);

  if (items.length) panel.append(await itemList(items));

  if (expenses.length) {
    panel.append(el('div', { class: 'day-money-head' }, [
      el('span', { text: '가계부' }),
      el('span', { class: 'money-num', text: money.formatWon(spent) }),
      earned ? el('span', { class: 'money-num income', text: money.formatWon(earned, { sign: true }) }) : null,
    ]));
    const list = el('div', { class: 'card-list' });
    expenses.forEach((r) => list.append(expenseRow(r)));
    panel.append(list);
  }

  if (!items.length && !expenses.length) {
    panel.append(el('div', { class: 'empty' }, [
      el('span', { class: 'big', text: '📭' }),
      el('p', { text: '이 날에는 기록이 없습니다.' }),
    ]));
  }
  return panel;
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

async function renderList() {
  /* 폴더 하나만 따로 들여다보는 화면 (묶음에서 '전체 보기' 로 옵니다) */
  if (state.folderId !== null) return folderDetail();

  const folders = await store.getFolders();
  const items = await store.getItems();
  const dday = await store.ddayItems();
  const doneDday = await store.doneDdayItems();
  const openTasks = items.filter((it) => it.type !== 'dday' && !it.done).length;

  const header = [
    title('모아보기', `디데이 ${dday.length}개 · 할 일 ${openTasks}개`),
    iconBtn('plus', '새 폴더', async () => { await openFolderEditor(); render(); }),
  ];

  const content = [];

  /* 1) 날짜 순으로 본 디데이 전체 */
  content.push(await groupCard({
    id: 'dday',
    emoji: '🎯',
    name: '다가오는 디데이',
    color: 'var(--accent)',
    stat: dday.length ? `${dday.length}개` : '없음',
    count: dday.length + doneDday.length,
    build: async (body) => {
      for (const d of dday) body.append(await ddayRow(d));
      if (!dday.length) body.append(hintLine('등록한 디데이가 없습니다. ＋ 로 추가해 보세요.'));
      if (doneDday.length) body.append(await doneDdaySection(doneDday));
    },
  }));

  /* 2) 폴더별 */
  const byFolder = new Map();
  for (const it of items) {
    const key = it.folderId || 'none';
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key).push(it);
  }

  for (const f of folders) {
    content.push(await folderGroup(f.id, f.emoji, f.name, f.color, byFolder.get(f.id) || [], f));
  }
  if (byFolder.has('none')) {
    content.push(await folderGroup('none', '📂', '폴더 없음', 'var(--text-faint)', byFolder.get('none'), null));
  }

  if (!folders.length) {
    content.push(el('div', { class: 'empty' }, [
      el('span', { class: 'big', text: '📁' }),
      el('p', { text: '폴더를 만들어 할 일과 디데이를 나눠 보세요.' }),
    ]));
  }

  content.push(el('button', {
    type: 'button',
    class: 'btn-ghost',
    style: { marginTop: '12px' },
    text: '＋ 새 폴더',
    onclick: async () => { await openFolderEditor(); render(); },
  }));

  return [header, content];
}

/** 폴더 하나를 묶음으로 만듭니다. 디데이를 먼저, 그 다음 할 일. */
async function folderGroup(id, emoji, name, color, list, folder) {
  const dd = store.sortItems(list.filter((it) => it.type === 'dday' && !it.done));
  const tasks = store.sortItems(list.filter((it) => it.type !== 'dday'));
  const openTasks = tasks.filter((it) => !it.done).length;
  const stat = [dd.length ? `디데이 ${dd.length}` : null, `할 일 ${openTasks}`]
    .filter(Boolean).join(' · ');

  return groupCard({
    id: `folder:${id}`,
    emoji,
    name,
    color,
    stat,
    count: list.length,
    onEdit: folder ? async () => { await openFolderEditor(folder); render(); } : null,
    build: async (body) => {
      for (const d of dd) body.append(await ddayRow(d));
      const visible = state.settings.hideCompleted ? tasks.filter((t) => !t.done) : tasks;
      if (dd.length && visible.length) body.append(el('div', { class: 'group-split' }));
      for (const t of visible) body.append(await itemCard(t, folder, { showFolder: false }));
      if (!dd.length && !visible.length) body.append(hintLine('아직 넣은 것이 없습니다.'));
      body.append(el('button', {
        type: 'button',
        class: 'group-more',
        text: '전체 보기 ›',
        onclick: () => { state.folderId = id; render(); },
      }));
    },
  });
}

/** 접었다 펼치는 묶음 한 덩어리 */
async function groupCard({ id, emoji, name, color, stat, count = 0, onEdit = null, build }) {
  const open = state.openGroups.has(id);
  const wrap = el('section', { class: 'group' + (open ? ' open' : ''), style: { '--fc': color } });

  const head = el('button', {
    type: 'button',
    class: 'group-head',
    'aria-expanded': String(open),
    onclick: () => {
      if (open) state.openGroups.delete(id);
      else state.openGroups.add(id);
      render();
    },
  }, [
    el('span', { class: 'g-emoji', text: emoji }),
    el('span', { class: 'g-name', text: name }),
    el('span', { class: 'g-stat', text: stat }),
    el('span', { class: 'g-caret' }, [icon('chevron', { size: 17 })]),
  ]);
  wrap.append(head);

  if (onEdit) {
    head.append(el('span', {
      class: 'g-edit', role: 'button', 'aria-label': `${name} 폴더 수정`,
      onclick: (e) => { e.stopPropagation(); onEdit(); },
    }, [icon('edit', { size: 16 })]));
  }

  if (open) {
    const body = el('div', { class: 'group-body' });
    await build(body);
    wrap.append(body);
  } else if (!count) {
    wrap.classList.add('faint');
  }
  return wrap;
}

function hintLine(text) {
  return el('div', { class: 'group-hint', text });
}

/** 완료한 디데이 — 접어 두고 되돌리거나 한 번에 지웁니다. */
async function doneDdaySection(done) {
  const open = state.showDoneDday === true;
  const wrap = el('div', { class: 'done-wrap' });
  wrap.append(el('button', {
    type: 'button',
    class: 'done-toggle' + (open ? ' open' : ''),
    onclick: () => { state.showDoneDday = !open; render(); },
  }, [
    el('span', { class: 'dt-label', text: `완료함 ${done.length}개` }),
    el('span', { class: 'dt-arrow', text: open ? '접기 ⌃' : '펼치기 ⌄' }),
  ]));

  if (open) {
    for (const d of done) wrap.append(await ddayRow(d));
    wrap.append(el('button', {
      type: 'button',
      class: 'btn danger',
      style: { marginTop: '8px' },
      text: `완료한 디데이 ${done.length}개 모두 지우기`,
      onclick: async () => {
        const ok = await confirmDialog({
          title: '완료한 디데이 삭제',
          message: `완료 표시한 디데이 ${done.length}개를 지울까요? 첨부한 사진도 함께 지워집니다.`,
          confirmLabel: '삭제',
          danger: true,
        });
        if (!ok) return;
        for (const d of done) await store.deleteItem(d.id);
        toast(`${done.length}개를 지웠습니다.`);
      },
    }));
  }
  return wrap;
}

/** 디데이 한 줄 — 많아도 훑어보기 쉽게 낮게 만들었습니다. */
async function ddayRow(item) {
  const diff = diffDays(todayKey(), item.dueDate);
  const cls = ['dd-row', item.done ? 'done' : (diff === 0 ? 'today' : (diff < 0 ? 'past' : ''))]
    .filter(Boolean).join(' ');
  const row = el('article', { class: cls });

  row.append(el('span', { class: 'dd-badge', text: ddayLabel(item.dueDate) }));

  const period = itemPeriod(item);
  const checks = item.checklist || [];
  const doneChecks = checks.filter((c) => c.done).length;
  const sub = [
    period ? formatRange(item.startDate, item.dueDate) : formatDate(item.dueDate, { withYear: false }),
    checks.length ? `☑ ${doneChecks}/${checks.length}` : null,
  ].filter(Boolean).join(' · ');

  const main = el('button', {
    type: 'button',
    class: 'dd-main',
    onclick: () => openItemById(item.id),
  }, [
    el('span', { class: 'dd-title', text: item.title }),
    el('span', { class: 'dd-sub', text: sub }),
    period ? el('span', { class: 'progress' }, [el('span', { style: { width: `${period.percent}%` } })]) : null,
  ]);
  row.append(main);

  const wasDone = !!item.done;
  row.append(el('button', {
    type: 'button',
    class: 'dd-check',
    role: 'checkbox',
    'aria-checked': String(wasDone),
    'aria-label': wasDone ? '완료 취소' : '완료로 표시',
    onclick: async (e) => {
      e.stopPropagation();
      await store.toggleDone(item.id);
      if (!wasDone) {
        toast('완료했습니다. 목록에서 숨겼습니다.', {
          action: '되돌리기',
          onAction: () => store.toggleDone(item.id),
          duration: 6000,
        });
      }
    },
  }, [icon('check', { size: 15, strokeWidth: 2.6 })]));

  return row;
}

/** 폴더 하나만 크게 보는 화면 */
async function folderDetail() {
  const items = await store.getItems();
  const folder = await store.getFolder(state.folderId);
  if (!folder && state.folderId !== 'none') {
    state.folderId = null;
    return renderList();
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

  return [header, [await itemList(list)]];
}

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
  const method = state.moneyMethod;
  const totals = await money.methodTotals(monthKey);
  const sum = await money.summary(monthKey, { method });
  const rows = await money.forMonth(monthKey, { method });
  const picked = method === 'all' ? null : money.methodInfo(method);

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

  /* 신용카드 결제 예정 */
  content.push(await cardPanel());

  /* 결제수단 고르기 — 수단별 금액을 띄워 두고, 누르면 그 수단만 봅니다. */
  content.push(methodPicker(totals, method));

  /* 요약 — 오늘 / 둘째 칸.
     수단을 고른 동안에는 그 수단의 이 달 합계를 크게 보여 주고,
     전체일 때는 위 '전체' 칩과 같은 숫자가 되므로 수입에서 쓴 돈을 뺀
     '남은 금액' 을 대신 올립니다. */
  const todayLabel = picked ? `오늘 ${picked.label}` : '오늘 쓴 돈';
  const second = (!picked && sum.income)
    ? statTile('남은 금액', money.formatWon(sum.income - sum.month, { sign: true }),
      `수입 ${money.formatWon(sum.income)}`, 'total')
    : statTile(picked ? `이 달 ${picked.label}` : '이 달 지출',
      money.formatWon(sum.month), `${sum.count}건`, 'total');
  content.push(el('div', { class: 'stat-row' }, [
    statTile(todayLabel, money.formatWon(sum.today), sum.todayCount ? `${sum.todayCount}건` : '기록 없음', 'today'),
    second,
  ]));

  /* 수입 · 남은 금액 · 남은 할부금 (수단별 금액은 위 칩에서 봅니다) */
  const breakdown = el('div', { class: 'settings-group' });
  breakdown.append(el('div', { class: 'head', text: '이 달 정리' }));
  if (sum.income) {
    breakdown.append(el('div', { class: 'settings-row' }, [
      el('div', { class: 'grow' }, [el('div', { class: 'label', text: '수입' })]),
      el('span', { class: 'value money-num income', text: money.formatWon(sum.income, { sign: true }) }),
    ]));
    // 수단을 고른 동안에는 위 타일에 '남은 금액' 이 없으므로 여기에 둡니다.
    if (picked) {
      breakdown.append(el('div', { class: 'settings-row' }, [
        el('div', { class: 'grow' }, [el('div', { class: 'label', text: '남은 금액' })]),
        el('span', { class: 'value money-num',
          text: money.formatWon(sum.income - totals.all, { sign: true }) }),
      ]));
    }
  }
  // 아직 다 내지 않은 할부가 있으면 잔액을 알려 줍니다.
  const outstanding = await money.installmentOutstanding(await money.getCardSettings());
  if (outstanding.total && (method === 'all' || method === 'credit')) {
    breakdown.append(el('div', { class: 'settings-row' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'label', text: '남은 할부금' }),
        el('div', { class: 'desc', text: `${outstanding.count}건` }),
      ]),
      el('span', { class: 'value money-num', text: money.formatWon(outstanding.total) }),
    ]));
  }
  if (breakdown.children.length > 1) content.push(breakdown);

  /* 분류별 */
  const cats = await money.byCategory(monthKey, { method });
  if (cats.length) {
    content.push(section('분류별'));
    const list = el('div', { class: 'cat-list panel' });
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
      el('p', { text: picked ? `이 달에 ${picked.label}로 쓴 기록이 없습니다.` : '이 달에 기록한 내역이 없습니다.' }),
      el('p', { text: picked ? '위에서 ‘전체’를 누르면 다 볼 수 있습니다.' : '아래 ＋ 버튼으로 오늘 쓴 돈을 적어 보세요.' }),
    ]));
  } else {
    content.push(section(picked ? `${picked.label} 내역` : '전체 내역', rows.length));
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

/**
 * 결제수단 고르는 줄.
 * 칩마다 그 수단으로 이 달에 쓴 금액이 적혀 있어, 고르지 않아도 한눈에 비교됩니다.
 * 기록이 없는 수단도 신용·체크·현금은 늘 보여 줘서 자리가 흔들리지 않게 합니다.
 */
function methodPicker(totals, picked) {
  const ALWAYS = ['credit', 'debit', 'cash'];
  const shown = money.METHODS.filter((m) => ALWAYS.includes(m.value) || totals[m.value]);

  const row = el('div', { class: 'method-row', role: 'tablist', 'aria-label': '결제수단 고르기' });
  const chip = (value, label, amount) => el('button', {
    type: 'button',
    class: 'method-chip' + (picked === value ? ' on' : ''),
    role: 'tab',
    'aria-selected': String(picked === value),
    onclick: () => {
      // 이미 고른 것을 다시 누르면 전체로 돌아옵니다.
      state.moneyMethod = picked === value ? 'all' : value;
      render();
    },
  }, [
    el('span', { class: 'mc-label', text: label }),
    el('span', { class: 'mc-amount money-num', text: money.formatWon(amount) }),
  ]);

  row.append(chip('all', '전체', totals.all));
  shown.forEach((m) => row.append(chip(m.value, m.label, totals[m.value])));
  return row;
}

/** 신용카드 청구 예정 — 할부·선납까지 한눈에 */
async function cardPanel() {
  const st = await money.cardStatus();
  const c = st.cycle;
  const hasPrepaid = st.prepaid > 0;
  const settled = hasPrepaid && st.due === 0;
  const dLabel = c.daysLeft === 0 ? '오늘 결제'
    : c.daysLeft > 0 ? `D-${c.daysLeft}` : `${Math.abs(c.daysLeft)}일 지남`;

  const card = el('section', { class: 'card-panel' + (settled ? ' paid' : '') });

  card.append(el('div', { class: 'cp-top' }, [
    el('span', { class: 'cp-title', text: settled ? '이번 회차 결제 끝' : '신용카드 결제 예정' }),
    el('button', {
      type: 'button', class: 'cp-setting', 'aria-label': '결제 주기 설정',
      onclick: openCardSettings,
    }, [icon('settings', { size: 17 })]),
  ]));

  /* 실제로 더 낼 금액을 가장 크게 보여 줍니다. */
  card.append(el('div', { class: 'cp-amount money-num', text: money.formatWon(st.due) }));
  if (hasPrepaid) {
    card.append(el('div', { class: 'cp-amount-sub' }, [
      el('span', { text: `청구 ${money.formatWon(st.amount)}` }),
      st.over ? el('span', { class: 'cp-dot', text: '·' }) : null,
      st.over ? el('span', { class: 'prepaid', text: `${money.formatWon(st.over)} 더 냄` }) : null,
    ]));
    card.append(prepaidBar(st));
  }

  card.append(cpLine('합산 기간', [el('span', { text: money.formatCycleRange(c) })]));
  card.append(cpLine('결제일', [
    el('span', { text: formatDate(c.payDate, { withYear: false }) }),
    el('span', { class: 'cp-dday' + (c.daysLeft <= 3 && c.daysLeft >= 0 ? ' near' : ''), text: dLabel }),
  ]));

  /* 할부가 걸려 있으면 일시불과 나눠서 보여 줍니다. */
  if (st.plans.length) {
    card.append(cpLine('일시불', [
      el('span', { class: 'money-num', text: money.formatWon(st.lump) }),
    ]));

    const open = state.showCardPlans;
    card.append(el('button', {
      type: 'button',
      class: 'cp-line cp-toggle',
      'aria-expanded': String(open),
      onclick: () => { state.showCardPlans = !state.showCardPlans; render(); },
    }, [
      el('span', { class: 'cp-key', text: `할부 ${st.plans.length}건` }),
      el('span', { class: 'cp-val' }, [
        el('span', { class: 'money-num', text: money.formatWon(st.installment) }),
        el('span', { class: 'cp-caret' + (open ? ' open' : '') }, [icon('chevron', { size: 16 })]),
      ]),
    ]));

    if (open) {
      const list = el('div', { class: 'plan-list' });
      st.plans.forEach((p) => {
        const cat = money.categoryInfo(p.row.category, 'expense');
        list.append(el('button', {
          type: 'button', class: 'plan-row',
          onclick: async () => { await openExpenseEditor(p.row); render(); },
        }, [
          el('span', { class: 'plan-emoji', text: cat.emoji }),
          el('div', { class: 'plan-body' }, [
            el('div', { class: 'plan-title', text: p.row.memo || cat.label }),
            el('div', { class: 'plan-sub', text: p.left
              ? `${p.index}/${p.months}회차 · ${money.formatWon(p.remaining)} 남음`
              : `${p.index}/${p.months}회차 · 이번이 마지막` }),
          ]),
          el('span', { class: 'plan-due money-num', text: money.formatWon(p.due) }),
        ]));
      });
      card.append(list);
    }
  }

  /* 선납 — 누르면 금액을 적거나 고칩니다. FAB 과 겹치지 않게 줄로 둡니다. */
  card.append(el('button', {
    type: 'button',
    class: 'cp-line cp-tap',
    'aria-label': hasPrepaid ? '선납 금액 고치기' : '선납한 금액 적기',
    onclick: () => openPrepaidSheet(st),
  }, [
    el('span', { class: 'cp-key', text: '선납' }),
    el('span', { class: 'cp-val' }, [
      hasPrepaid
        ? el('span', { class: 'money-num prepaid', text: `−${money.formatWon(st.prepaid)}` })
        : el('span', { class: 'cp-empty', text: '미리 낸 금액 적기' }),
      el('span', { class: 'cp-caret cp-next' }, [icon('chevron', { size: 16 })]),
    ]),
  ]));

  if (st.prev.amount) {
    card.append(cpLine('지난 회차', [
      el('span', { class: 'money-num', text: money.formatWon(st.prev.amount) }),
      el('span', { class: 'cp-dday', text: st.prev.prepaid ? '선납함' : '결제됨' }),
    ]));
  }

  return card;
}

function cpLine(key, vals) {
  return el('div', { class: 'cp-line' }, [
    el('span', { class: 'cp-key', text: key }),
    el('span', { class: 'cp-val' }, vals),
  ]);
}

/** 청구액 중 얼마나 미리 냈는지 보여 주는 막대 */
function prepaidBar(st) {
  const pct = st.amount ? Math.min(100, Math.round((st.prepaid / st.amount) * 100)) : 100;
  return el('div', { class: 'prepaid-bar', role: 'img',
    'aria-label': `청구액의 ${pct}%를 미리 냈습니다` }, [
    el('span', { style: { width: `${pct}%` } }),
  ]);
}

/** 이번 회차에 미리 낸 금액을 적는 시트 */
async function openPrepaidSheet(st) {
  let amount = st.prepaid;

  const saved = await openSheet({
    title: '선납 금액',
    confirmLabel: '저장',
    buildBody: ({ body }) => {
      body.append(el('div', { class: 'hint' }, [
        el('span', { text: `${money.formatCycleRange(st.cycle)} 회차 청구액은 ` }),
        el('span', { class: 'strong', text: money.formatWon(st.amount) }),
        el('span', { text: '입니다. 이 중 미리 낸 금액을 적어 주세요.' }),
      ]));

      const input = el('input', {
        type: 'text', inputmode: 'numeric', class: 'amount-input',
        placeholder: '0', 'data-autofocus': '',
        value: amount ? new Intl.NumberFormat('ko-KR').format(amount) : '',
        oninput: (e) => {
          amount = money.parseAmount(e.target.value);
          e.target.value = amount ? new Intl.NumberFormat('ko-KR').format(amount) : '';
          refresh();
        },
      });
      body.append(field('미리 낸 금액',
        el('div', { class: 'amount-row' }, [input, el('span', { class: 'won', text: '원' })])));

      const quick = el('div', { class: 'chip-row' });
      const set = (n) => {
        amount = Math.max(0, n);
        input.value = amount ? new Intl.NumberFormat('ko-KR').format(amount) : '';
        refresh();
      };
      quick.append(el('button', { type: 'button', class: 'chip tap', text: '전액',
        onclick: () => set(st.amount) }));
      quick.append(el('button', { type: 'button', class: 'chip tap', text: '절반',
        onclick: () => set(Math.round(st.amount / 2)) }));
      [100000, 500000].forEach((n) => quick.append(el('button', {
        type: 'button', class: 'chip tap', text: `+${new Intl.NumberFormat('ko-KR').format(n)}`,
        onclick: () => set((amount || 0) + n),
      })));
      quick.append(el('button', { type: 'button', class: 'chip tap', text: '지우기',
        onclick: () => set(0) }));
      body.append(quick);

      const out = el('div', { class: 'hint' });
      function refresh() {
        const left = st.amount - amount;
        out.replaceChildren(el('span', { class: 'strong', text: left > 0
          ? `결제일에 ${money.formatWon(left)} 빠져나갑니다.`
          : (left === 0 ? '결제일에 빠져나갈 금액이 없습니다.'
            : `청구액보다 ${money.formatWon(-left)} 더 냈습니다.`) }));
      }
      refresh();
      body.append(out);
    },
    onConfirm: async () => {
      await money.setPrepaid(st.cycle.key, amount);
      return true;
    },
  });

  if (saved) toast(amount ? `선납 ${money.formatWon(amount)}으로 적어 두었습니다.` : '선납 기록을 지웠습니다.');
  render();
}

async function openCardSettings() {
  const cur = await money.getCardSettings();
  const draft = { ...cur };

  await openSheet({
    title: '카드 결제 주기',
    confirmLabel: '저장',
    buildBody: ({ body }) => {
      body.append(el('div', { class: 'hint' }, [
        el('span', { text: '카드사가 정한 합산 마감일과 결제일을 넣어 주세요. ' }),
        el('span', { class: 'strong', text: '마감일까지 쓴 금액이 그 다음 결제일에 빠져나갑니다.' }),
      ]));

      // 자주 쓰는 조합은 한 번 눌러서 채웁니다.
      const presetRow = el('div', { class: 'chip-row' });
      body.append(presetRow);

      const closeSel = el('select', {
        onchange: (e) => { draft.closingDay = Number(e.target.value); },
      }, [
        el('option', { value: '0', text: '말일', selected: Number(draft.closingDay) === 0 }),
        ...[5, 10, 12, 14, 15, 17, 20, 25].map((d) => el('option', {
          value: String(d), text: `${d}일`, selected: Number(draft.closingDay) === d,
        })),
      ]);
      body.append(field('합산 마감일', closeSel));

      const monthSel = el('select', {
        onchange: (e) => { draft.paymentNextMonth = e.target.value === '1'; },
      }, [
        el('option', { value: '1', text: '다음 달', selected: draft.paymentNextMonth }),
        el('option', { value: '0', text: '같은 달', selected: !draft.paymentNextMonth }),
      ]);
      const daySel = el('select', {
        onchange: (e) => { draft.paymentDay = Number(e.target.value); },
      }, [1, 5, 10, 12, 13, 14, 15, 17, 18, 20, 21, 23, 25, 27].map((d) => el('option', {
        value: String(d), text: `${d}일`, selected: Number(draft.paymentDay) === d,
      })));
      body.append(el('div', { class: 'field' }, [
        el('label', { text: '결제일' }),
        el('div', { class: 'row' }, [monthSel, daySel]),
      ]));

      const preview = el('div', { class: 'hint' });
      const refresh = () => {
        // 프리셋으로 바뀐 값도 화면에 그대로 보이게 맞춰 둡니다.
        closeSel.value = String(Number(draft.closingDay) || 0);
        monthSel.value = draft.paymentNextMonth ? '1' : '0';
        daySel.value = String(Number(draft.paymentDay) || 25);
        const c = money.cycleOf(money.currentCycleKey(draft), draft);
        preview.replaceChildren(
          el('span', { text: `이번 회차: ${money.formatCycleRange(c)}` }),
          el('br'),
          el('span', { class: 'strong', text: `${formatDate(c.payDate, { withYear: true })} 결제` }),
        );
      };
      [closeSel, monthSel, daySel].forEach((n) => n.addEventListener('change', refresh));
      presetRow.append(...money.CARD_PRESETS.map((p) => el('button', {
        type: 'button', class: 'chip tap', text: p.label,
        onclick: () => {
          draft.closingDay = p.closingDay;
          draft.paymentNextMonth = p.paymentNextMonth;
          draft.paymentDay = p.paymentDay;
          refresh();
        },
      })));
      refresh();
      body.append(preview);
    },
    onConfirm: async () => money.setCardSettings(draft),
  });
  render();
}

/* ---------------- 가계부 분류 고치기 ---------------- */

/* 고를 수 있는 아이콘. 여기 없는 것은 직접 써 넣으면 됩니다. */
const CATEGORY_EMOJIS = [
  '🍚', '🍜', '🍗', '☕', '🍰', '🍺', '🛒', '🏠', '🧻', '🚌', '🚗', '⛽',
  '✈️', '🏨', '🛍️', '👕', '👟', '💊', '🏥', '💇', '💅', '🎬', '🎮', '📚',
  '🎵', '🏃', '🐾', '🎁', '💐', '📱', '💡', '💧', '🔥', '📦', '💰', '🧧',
  '↩️', '➕', '🏦', '📈',
];

/** 분류 목록을 고치는 시트. 바뀌는 대로 바로 저장합니다. */
export async function openCategoryManager(startType = 'expense') {
  let type = startType === 'income' ? 'income' : 'expense';

  await openSheet({
    title: '가계부 분류',
    showConfirm: false,
    cancelLabel: '닫기',
    buildBody: ({ body }) => {
      const seg = el('div', { class: 'seg' });
      const list = el('div', { class: 'cat-manage' });
      const foot = el('div', { class: 'cat-manage-foot' });

      [['expense', '지출'], ['income', '수입']].forEach(([value, label]) => {
        seg.append(el('button', {
          type: 'button',
          text: label,
          'aria-pressed': String(type === value),
          onclick: () => {
            if (type === value) return;
            type = value;
            [...seg.children].forEach((b, i) =>
              b.setAttribute('aria-pressed', String(['expense', 'income'][i] === type)));
            draw();
          },
        }));
      });
      body.append(seg);

      body.append(el('div', { class: 'hint' }, [
        el('span', { text: '이름과 아이콘을 바꾸거나, 새로 더하거나, 순서를 옮길 수 있습니다. ' }),
        el('span', { class: 'strong', text: '분류를 지워도 적어 둔 금액은 사라지지 않습니다.' }),
      ]));
      body.append(list);
      body.append(foot);

      async function save(next) {
        await money.setCategories(type, next);
        draw();
      }

      function draw() {
        const cats = money.categoriesFor(type);
        list.replaceChildren();

        cats.forEach((c, i) => {
          list.append(el('div', { class: 'cat-manage-row' }, [
            el('button', {
              type: 'button',
              class: 'cm-main',
              onclick: () => openCategoryEditor(type, c, draw),
            }, [
              el('span', { class: 'cm-emoji', text: c.emoji }),
              el('span', { class: 'cm-name', text: c.label }),
              el('span', { class: 'cm-edit' }, [icon('edit', { size: 15 })]),
            ]),
            el('button', {
              type: 'button', class: 'cm-move', 'aria-label': `${c.label} 위로`,
              disabled: i === 0,
              onclick: () => {
                const next = cats.slice();
                [next[i - 1], next[i]] = [next[i], next[i - 1]];
                save(next);
              },
            }, ['↑']),
            el('button', {
              type: 'button', class: 'cm-move', 'aria-label': `${c.label} 아래로`,
              disabled: i === cats.length - 1,
              onclick: () => {
                const next = cats.slice();
                [next[i + 1], next[i]] = [next[i], next[i + 1]];
                save(next);
              },
            }, ['↓']),
          ]));
        });

        foot.replaceChildren(
          el('button', {
            type: 'button', class: 'btn-ghost', text: '＋ 분류 추가',
            onclick: () => openCategoryEditor(type, null, draw),
          }),
          el('button', {
            type: 'button', class: 'btn', style: { marginTop: '8px' },
            text: '기본 분류로 되돌리기',
            onclick: async () => {
              const ok = await confirmDialog({
                title: '기본 분류로 되돌리기',
                message: `${type === 'income' ? '수입' : '지출'} 분류를 처음 상태로 되돌립니다. 적어 둔 금액은 그대로입니다.`,
                confirmLabel: '되돌리기',
              });
              if (!ok) return;
              await money.resetCategories(type);
              toast('기본 분류로 되돌렸습니다.');
              draw();
            },
          }),
        );
      }

      draw();
    },
  });
  render();
}

/** 분류 하나를 만들거나 고치는 시트 */
async function openCategoryEditor(type, cat, onDone) {
  const isNew = !cat;
  const draft = isNew
    ? { value: money.newCategoryValue(), label: '', emoji: '📦' }
    : { ...cat };

  await openSheet({
    title: isNew ? '새 분류' : '분류 수정',
    confirmLabel: '저장',
    buildBody: ({ body, close }) => {
      body.append(field('이름', el('input', {
        type: 'text',
        value: draft.label,
        placeholder: '예) 반려동물',
        maxlength: '20',
        'data-autofocus': '',
        oninput: (e) => { draft.label = e.target.value; },
      })));

      const typed = el('input', {
        type: 'text',
        class: 'emoji-input',
        value: draft.emoji,
        maxlength: '4',
        'aria-label': '아이콘 직접 쓰기',
        oninput: (e) => {
          draft.emoji = e.target.value;
          mark();
        },
      });
      const grid = el('div', { class: 'emoji-row' });
      CATEGORY_EMOJIS.forEach((em) => {
        grid.append(el('button', {
          type: 'button', class: 'emoji-pick', text: em,
          onclick: () => { draft.emoji = em; typed.value = em; mark(); },
        }));
      });
      const mark = () => [...grid.children].forEach((b) =>
        b.setAttribute('aria-pressed', String(b.textContent === draft.emoji)));
      mark();
      body.append(field('아이콘', typed, grid));

      if (!isNew) {
        body.append(el('button', {
          type: 'button',
          class: 'btn danger',
          style: { marginTop: '6px' },
          text: '이 분류 지우기',
          onclick: async () => {
            if (await deleteCategory(type, cat)) close(null);
          },
        }));
      }
    },
    onConfirm: async () => {
      const label = draft.label.trim();
      if (!label) {
        toast('이름을 적어 주세요.');
        return false;
      }
      const cats = money.categoriesFor(type);
      const next = isNew
        ? [...cats, { ...draft, label }]
        : cats.map((c) => (c.value === draft.value ? { ...draft, label } : c));
      await money.setCategories(type, next);
      return true;
    },
  });

  if (onDone) onDone();
}

/** 분류를 지웁니다. 쓰고 있는 내역이 있으면 옮길 곳을 먼저 고릅니다. */
async function deleteCategory(type, cat) {
  const cats = money.categoriesFor(type);
  if (cats.length <= 1) {
    toast('분류는 하나 이상 있어야 합니다.');
    return false;
  }

  const used = await money.countByCategory(cat.value, type);
  let moveTo = null;

  if (used) {
    const others = cats.filter((c) => c.value !== cat.value);
    moveTo = await pickerSheet({
      title: `${cat.label} 내역 ${used}건을 어디로 옮길까요?`,
      value: others[0].value,
      options: others.map((c) => ({ value: c.value, label: c.label, emoji: c.emoji })),
    });
    if (moveTo === null) return false;
  } else {
    const ok = await confirmDialog({
      title: '분류 삭제',
      message: `'${cat.label}' 분류를 지울까요?`,
      confirmLabel: '삭제',
      danger: true,
    });
    if (!ok) return false;
  }

  if (moveTo) await money.replaceCategory(cat.value, moveTo, type);
  await money.setCategories(type, cats.filter((c) => c.value !== cat.value));
  toast(used ? `${used}건을 옮기고 지웠습니다.` : '지웠습니다.');
  return true;
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
  const months = money.installmentCount(r);
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
        months > 1 ? el('span', { class: 'chip accent', text: `${months}개월 할부` }) : null,
        r.memo ? el('span', { class: 'chip', text: cat.label }) : null,
      ]),
    ]),
    el('div', { class: 'ex-right' }, [
      el('span', {
        class: 'ex-amount money-num' + (isIncome ? ' income' : ''),
        text: isIncome ? money.formatWon(r.amount, { sign: true }) : money.formatWon(r.amount),
      }),
      months > 1 ? el('span', {
        class: 'ex-permonth',
        text: `월 ${money.formatWon(money.installmentShare(r.amount, months, 1))}`,
      }) : null,
    ]),
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

  /* 가계부 */
  const moneyGroup = group('가계부');
  const cats = money.allCategories();
  moneyGroup.append(settingsRow({
    label: '분류 고치기',
    desc: '이름·아이콘을 바꾸거나 새 분류를 더합니다.',
    value: `지출 ${cats.expense.length} · 수입 ${cats.income.length}`,
    onclick: () => openCategoryManager('expense'),
  }));
  moneyGroup.append(settingsRow({
    label: '카드 결제 주기',
    desc: '합산 마감일과 결제일을 정합니다.',
    onclick: openCardSettings,
  }));
  content.push(moneyGroup);

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
  viewGroup.append(settingsRow({
    label: '캘린더에 디데이 표시',
    desc: '끄면 달력의 점과 줄에서 디데이가 빠집니다. 디데이 탭과 날짜별 목록에는 그대로 남습니다.',
    toggle: state.settings.showDdayOnCalendar !== false,
    onclick: async () => {
      state.settings.showDdayOnCalendar = state.settings.showDdayOnCalendar === false;
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
      go('calendar');
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

function field(label, ...controls) {
  return el('div', { class: 'field' }, [el('label', { text: label }), ...controls]);
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
  if (state.tab === 'list' && state.folderId && state.folderId !== 'none' && !base.folderId) {
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

/** 한 줄로 접힌 안내. 눌러야 설명이 보이고, 오른쪽 ✕ 로 지웁니다. */
function slimNotice(emoji, headline, detail, warn = false) {
  const box = el('div', { class: 'notice slim' + (warn ? ' warn' : '') });
  const body = el('div', { class: 'n-detail', text: detail, hidden: true });
  box.append(
    el('button', {
      type: 'button',
      class: 'n-head',
      onclick: () => { body.hidden = !body.hidden; },
    }, [
      el('span', { class: 'ico', text: emoji }),
      el('span', { class: 'n-text', text: headline }),
      el('span', { class: 'n-more', text: '자세히' }),
    ]),
    body,
    el('button', {
      type: 'button', class: 'n-close', 'aria-label': '안내 닫기',
      onclick: async () => { await db.setMeta('notifBannerDismissed', true); render(); },
    }, [icon('close', { size: 15 })]),
  );
  return box;
}

async function notificationBanner() {
  const perm = notify.permission();
  if (perm === 'granted' || perm === 'unsupported') return null;
  const dismissed = await db.getMeta('notifBannerDismissed', false);
  if (dismissed) return null;

  if (notify.needsInstallForNotifications()) {
    return slimNotice('📲', '알림을 받으려면 홈 화면에 추가해 주세요.',
      'Safari 아래 공유 버튼 → "홈 화면에 추가" → 홈 화면 아이콘으로 열기');
  }

  if (perm === 'denied') {
    return slimNotice('🔕', '알림이 차단되어 있습니다.',
      '브라우저의 사이트 설정에서 알림을 허용해 주세요.', true);
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
