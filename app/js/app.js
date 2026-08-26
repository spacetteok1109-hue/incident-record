/* app.js — 화면 구성과 앱 시작 */

import * as db from './db.js';
import * as store from './store.js';
import * as media from './media.js';
import * as notify from './notify.js';
import * as lock from './lock.js';
import { el, $, toast, openSheet, confirmDialog, pickerSheet, openViewer, closeTopSheet, onLongPress } from './ui.js';
import { openItemEditor, openFolderEditor } from './editor.js';
import {
  WEEKDAYS, todayKey, monthGrid, ddayLabel, formatDate, formatTime,
  relativeDateLabel, diffDays, REPEAT_LABELS, bytesToText, debounce,
} from './util.js';

const APP_VERSION = '1.0.0';

const state = {
  tab: 'today',
  cal: { y: new Date().getFullYear(), m: new Date().getMonth() },
  selectedDate: todayKey(),
  folderId: null,
  settings: { theme: 'auto', hideCompleted: false },
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
      text: '＋',
      'aria-label': '새 항목 추가',
      onclick: () => createItem(),
    }),
    buildTabbar(),
  );
}

const TABS = [
  { id: 'today', label: '오늘', ico: '☀️' },
  { id: 'calendar', label: '캘린더', ico: '📅' },
  { id: 'folders', label: '폴더', ico: '📁' },
  { id: 'dday', label: '디데이', ico: '🎯' },
  { id: 'settings', label: '설정', ico: '⚙️' },
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
      el('span', { class: 'ico', text: t.ico }),
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
    case 'settings': [header, content] = await renderSettings(); break;
    default: [header, content] = await renderToday();
  }
  if (token !== renderToken) return; // 더 최신 렌더가 있으면 버립니다.

  $('#topbar').replaceChildren(...header);
  view.replaceChildren(...content);
  $('#fab').classList.toggle('hidden', state.tab === 'settings');
}

function title(text, sub) {
  return el('h1', {}, [text, sub ? el('span', { class: 'sub', text: sub }) : null]);
}

function iconBtn(ico, label, onclick) {
  return el('button', { type: 'button', class: 'icon-btn', text: ico, 'aria-label': label, onclick });
}

/* ---------------- 오늘 ---------------- */

async function renderToday() {
  const header = [
    title('오늘', formatDate(todayKey(), { withYear: false })),
    iconBtn('🔍', '검색', openSearch),
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
    text: '✓',
    onclick: async (e) => {
      e.stopPropagation();
      const before = item.done;
      await store.toggleDone(item.id);
      if (!before && item.repeat && item.repeat !== 'none') {
        toast('완료! 다음 반복으로 넘어갔습니다.');
      }
    },
  });

  const body = el('div', { class: 'item-body' });
  body.append(el('p', { class: 'item-title', text: item.title }));

  const meta = el('div', { class: 'item-meta' });
  if (item.type === 'dday' && item.dueDate) {
    meta.append(el('span', { class: 'chip accent', text: ddayLabel(item.dueDate) }));
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
  const checks = item.checklist || [];
  if (checks.length) {
    const doneCount = checks.filter((c) => c.done).length;
    const prog = el('div', { class: 'progress' }, [
      el('span', { style: { width: `${Math.round((doneCount / checks.length) * 100)}%` } }),
    ]);
    body.append(prog);
    const ul = el('ul', { class: 'mini-checks' });
    checks.slice(0, 6).forEach((c) => {
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
    if (checks.length > 6) {
      ul.append(el('li', {}, [el('span', { class: 'txt', text: `그 외 ${checks.length - 6}개` })]));
    }
    body.append(ul);
  }

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
    iconBtn('🔍', '검색', openSearch),
    iconBtn('📆', '오늘로', () => {
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
      iconBtn('‹', '뒤로', () => { state.folderId = null; render(); }),
      title(name, `${list.filter((i) => !i.done).length}개 남음 · 전체 ${list.length}개`),
      folder ? iconBtn('✏️', '폴더 수정', async () => {
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
    iconBtn('＋', '폴더 추가', async () => { await openFolderEditor(); render(); }),
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
        class: 'edit', text: '✏️', role: 'button', 'aria-label': '폴더 수정',
        onclick: async (e) => { e.stopPropagation(); await openFolderEditor(f); render(); },
      }),
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
    iconBtn('＋', '디데이 추가', () => createItem({ type: 'dday' })),
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

  const parts = [
    el('div', { class: 'big', text: ddayLabel(item.dueDate) }),
    el('div', { class: 'info' }, [
      el('div', { class: 't', text: item.title }),
      el('div', {
        class: 'd',
        text: [formatDate(item.dueDate, { withYear: true }), folder ? `${folder.emoji} ${folder.name}` : null]
          .filter(Boolean).join(' · '),
      }),
    ]),
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
    value: { auto: '기기 설정', dark: '어둡게', light: '밝게' }[state.settings.theme],
    onclick: async () => {
      const v = await pickerSheet({
        title: '테마',
        value: state.settings.theme,
        options: [
          { value: 'auto', label: '기기 설정 따르기' },
          { value: 'dark', label: '어둡게' },
          { value: 'light', label: '밝게' },
        ],
      });
      if (v === null) return;
      state.settings.theme = v;
      await db.setMeta('settings', state.settings);
      applyTheme(v);
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
    desc: `항목 ${items.length}개 · 사진 ${bytesToText(photoBytes)}`
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
  aboutGroup.append(settingsRow({ label: '버전', value: APP_VERSION }));
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

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const dark = theme === 'dark' || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    meta.setAttribute('content', dark ? '#0f1115' : '#f4f5f8');
  }
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
      toast(`항목 ${n.items}개, 폴더 ${n.folders}개, 사진 ${n.photos}장을 가져왔습니다.`);
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

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'open-item') openItemById(e.data.itemId);
      if (e.data && e.data.type === 'reminders-checked') { store.invalidate(); render(); }
    });
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('새 버전이 준비되었습니다.', {
            action: '새로고침',
            onAction: () => { sw.postMessage({ type: 'skip-waiting' }); location.reload(); },
            duration: 8000,
          });
        }
      });
    });
  } catch (e) {
    console.warn('서비스 워커 등록 실패', e);
  }
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
