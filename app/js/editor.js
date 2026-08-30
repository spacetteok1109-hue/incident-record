/* editor.js — 항목 편집 시트, 폴더 편집 시트 */

import { el, openSheet, toast, confirmDialog, openViewer } from './ui.js';
import * as store from './store.js';
import * as media from './media.js';
import * as money from './money.js';
import * as db from './db.js';
import {
  REPEAT_LABELS, REMIND_OPTIONS, todayKey,
  daysInclusive, endDateFromDuration, periodProgress, formatRange,
} from './util.js';

const TYPES = [
  { value: 'task', label: '할 일' },
  { value: 'dday', label: '디데이' },
  { value: 'money', label: '가계부' },
];

const FOLDER_EMOJIS = ['📁', '🏠', '💼', '📚', '💪', '🎂', '✈️', '💰', '🛒', '❤️', '🎮', '🍽️', '🐾', '🌱', '⭐'];

/**
 * 항목 편집 시트를 엽니다.
 * item이 없으면 새 항목을 만듭니다.
 * @returns 저장된 항목 또는 null
 */
export async function openItemEditor(item = null, defaults = {}) {
  const folders = await store.getFolders();
  const isNew = !item;
  const draft = item
    ? { ...store.blankItem(), ...item, checklist: (item.checklist || []).map((c) => ({ ...c })), photoIds: [...(item.photoIds || [])] }
    : store.blankItem({ dueDate: todayKey(), ...defaults });

  // 편집 중 새로 추가한 사진 (취소하면 지웁니다)
  const addedPhotoIds = [];

  const result = await openSheet({
    title: isNew ? '새로 만들기' : '수정',
    confirmLabel: '저장',
    buildBody: (api) => buildForm(api, draft, folders, addedPhotoIds, item),
    onConfirm: async () => {
      if (!draft.title.trim()) {
        toast('제목을 입력해 주세요.');
        return false;
      }
      if (draft.type === 'dday' && !draft.dueDate) {
        toast('디데이는 목표 날짜가 필요합니다.');
        return false;
      }
      draft.checklist = draft.checklist.filter((c) => c.text.trim());
      const saved = await store.saveItem(draft);
      await media.attachPhotos(saved.photoIds || [], saved.id);
      return saved;
    },
  });

  if (!result) {
    // 취소: 이번 편집에서 추가한 사진만 정리합니다.
    for (const id of addedPhotoIds) {
      if (!item || !(item.photoIds || []).includes(id)) await media.deletePhoto(id);
    }
    return null;
  }
  return result;
}

function buildForm(api, draft, folders, addedPhotoIds, original) {
  const { body } = api;

  /* ----- 종류 ----- */
  const seg = el('div', { class: 'seg' });
  TYPES.forEach((t) => {
    seg.append(el('button', {
      type: 'button',
      text: t.label,
      'aria-pressed': String(draft.type === t.value),
      onclick: async () => {
        // 가계부는 저장하는 내용이 달라 전용 입력 화면으로 넘깁니다.
        if (t.value === 'money') {
          api.close(null);
          const { openExpenseEditor } = await import('./editor.js');
          await openExpenseEditor(null, { date: draft.dueDate || todayKey() });
          return;
        }
        draft.type = t.value;
        if (t.value === 'dday') {
          draft.dueTime = null;
          draft.repeat = 'none';
          if (!draft.dueDate) draft.dueDate = todayKey();
        } else {
          // 기간은 디데이에서만 쓰므로 정리합니다.
          draft.startDate = null;
        }
        [...seg.children].forEach((b, i) => b.setAttribute('aria-pressed', String(TYPES[i].value === draft.type)));
        rerenderDynamic();
      },
    }));
  });
  body.append(field('종류', seg));

  /* ----- 제목 ----- */
  const titleInput = el('input', {
    type: 'text',
    class: 'title-input',
    value: draft.title,
    placeholder: '무엇을 할까요?',
    'data-autofocus': '',
    maxlength: '200',
    oninput: (e) => { draft.title = e.target.value; },
  });
  body.append(field('제목', titleInput));

  /* ----- 폴더 ----- */
  const folderSel = el('select', {
    onchange: (e) => { draft.folderId = e.target.value || null; },
  }, [
    el('option', { value: '', text: '폴더 없음', selected: !draft.folderId }),
    ...folders.map((f) => el('option', {
      value: f.id,
      text: `${f.emoji} ${f.name}`,
      selected: draft.folderId === f.id,
    })),
  ]);
  body.append(field('폴더', folderSel));

  /* ----- 날짜/시간/반복/알림 (종류에 따라 달라지는 영역) ----- */
  const dynamic = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } });
  body.append(dynamic);

  function rerenderDynamic() {
    dynamic.replaceChildren();
    const isDday = draft.type === 'dday';

    const dateInput = el('input', {
      type: 'date',
      value: draft.dueDate || '',
      onchange: (e) => { draft.dueDate = e.target.value || null; },
    });

    if (isDday) {
      dynamic.append(buildPeriodFields(draft, dateInput));
    } else {  // 할 일도 여러 날에 걸칠 수 있습니다.
      const timeInput = el('input', {
        type: 'time',
        value: draft.dueTime || '',
        onchange: (e) => { draft.dueTime = e.target.value || null; },
      });
      const row = el('div', { class: 'row' }, [
        el('div', { class: 'field', style: { flex: '1.3' } }, [el('label', { text: '날짜' }), dateInput]),
        el('div', { class: 'field' }, [el('label', { text: '시간' }), timeInput]),
      ]);
      dynamic.append(row);

      // 여러 날에 걸치는 할 일이면 시작일을 둘 수 있습니다(달력에 줄로 표시).
      const spanToggle = el('span', { class: 'switch', role: 'switch',
        'aria-checked': String(!!draft.startDate) });
      dynamic.append(el('button', {
        type: 'button',
        class: 'switch-row',
        style: { width: '100%', textAlign: 'left' },
        onclick: () => {
          draft.startDate = draft.startDate ? null : (draft.dueDate || todayKey());
          rerenderDynamic();
        },
      }, [
        el('div', {}, [
          el('div', { class: 'label', text: '여러 날에 걸침' }),
          el('div', { class: 'desc', text: '시작일을 정하면 달력에 줄로 이어져 보입니다.' }),
        ]),
        spanToggle,
      ]));

      if (draft.startDate) {
        dynamic.append(field('시작일', el('input', {
          type: 'date',
          value: draft.startDate,
          onchange: (e) => { draft.startDate = e.target.value || null; rerenderDynamic(); },
        })));
        if (draft.dueDate && draft.startDate > draft.dueDate) {
          dynamic.append(el('div', { class: 'hint' }, [
            el('span', { class: 'warn', text: '⚠️ 마감일이 시작일보다 빠릅니다.' }),
          ]));
        }
        dynamic.append(barToggleRow(draft, rerenderDynamic));
      }

      const clearRow = el('button', {
        type: 'button',
        class: 'btn-ghost',
        text: draft.dueDate ? '날짜 지우기 (언젠가 할 일로)' : '날짜 없음',
        onclick: () => {
          draft.dueDate = null;
          draft.dueTime = null;
          draft.startDate = null;
          draft.remindOffset = null;
          rerenderDynamic();
        },
      });
      dynamic.append(clearRow);
    }

    /* 반복 */
    if (!isDday) {
      const repeatSel = el('select', {
        onchange: (e) => { draft.repeat = e.target.value; },
        disabled: !draft.dueDate,
      }, Object.entries(REPEAT_LABELS).map(([v, label]) =>
        el('option', { value: v, text: label, selected: draft.repeat === v })));
      dynamic.append(field('반복', repeatSel));
    }

    /* 알림 */
    const remindSel = el('select', {
      onchange: (e) => { draft.remindOffset = e.target.value === '' ? null : Number(e.target.value); },
      disabled: !draft.dueDate,
    }, REMIND_OPTIONS.map((o) => el('option', {
      value: o.value,
      text: o.value === '0' && (isDday || !draft.dueTime) ? '당일 오전 9시' : o.label,
      selected: String(draft.remindOffset ?? '') === o.value,
    })));
    const remindField = field('알림', remindSel);
    if (!draft.dueTime && draft.dueDate) {
      remindField.append(el('div', {
        class: 'desc',
        style: { fontSize: '11.5px', color: 'var(--text-dim)' },
        text: '시간을 지정하지 않으면 기준 시각은 오전 9시입니다.',
      }));
    }
    dynamic.append(remindField);
  }
  rerenderDynamic();

  /* ----- 체크리스트 ----- */
  const checkWrap = el('div', { class: 'checklist-edit' });
  const addCheckBtn = el('button', {
    type: 'button',
    class: 'btn-ghost',
    html: '<span>＋</span><span>체크리스트 항목 추가</span>',
    onclick: () => {
      draft.checklist.push({ id: db.uid(), text: '', done: false });
      renderChecks(true);
    },
  });
  body.append(field('체크리스트', checkWrap, addCheckBtn));

  function renderChecks(focusLast = false) {
    checkWrap.replaceChildren();
    draft.checklist.forEach((c, idx) => {
      const box = el('button', {
        type: 'button',
        class: 'box',
        'aria-checked': String(!!c.done),
        role: 'checkbox',
        text: '✓',
        'aria-label': '완료 표시',
        onclick: () => { c.done = !c.done; box.setAttribute('aria-checked', String(c.done)); },
      });
      const input = el('input', {
        type: 'text',
        value: c.text,
        placeholder: '세부 항목',
        maxlength: '200',
        oninput: (e) => { c.text = e.target.value; },
        onkeydown: (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            draft.checklist.splice(idx + 1, 0, { id: db.uid(), text: '', done: false });
            renderChecks(true);
          }
        },
      });
      checkWrap.append(el('div', { class: 'check-row' }, [
        box,
        input,
        el('button', {
          type: 'button', class: 'del', text: '✕', 'aria-label': '삭제',
          onclick: () => { draft.checklist.splice(idx, 1); renderChecks(); },
        }),
      ]));
    });
    if (focusLast) {
      const inputs = checkWrap.querySelectorAll('input');
      inputs[inputs.length - 1]?.focus();
    }
  }
  renderChecks();

  /* ----- 메모 ----- */
  const memo = el('textarea', {
    placeholder: '메모를 남겨 보세요',
    maxlength: '5000',
    oninput: (e) => { draft.memo = e.target.value; },
  });
  memo.value = draft.memo || '';
  body.append(field('메모', memo));

  /* ----- 사진 ----- */
  const photoGrid = el('div', { class: 'photo-grid' });
  const fileInput = el('input', {
    type: 'file',
    accept: 'image/*',
    multiple: true,
    class: 'hidden',
    onchange: async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      for (const f of files) {
        try {
          const photo = await media.addPhoto(f, draft.id || null);
          draft.photoIds.push(photo.id);
          addedPhotoIds.push(photo.id);
        } catch (err) {
          toast(err.message || '사진을 추가하지 못했습니다.');
        }
      }
      renderPhotos();
    },
  });
  body.append(field('사진', photoGrid), fileInput);

  async function renderPhotos() {
    photoGrid.replaceChildren();
    const photos = await media.getPhotos(draft.photoIds);
    photos.forEach((p) => {
      photoGrid.append(el('div', { class: 'photo-cell' }, [
        el('img', {
          src: media.photoURL(p),
          alt: p.name || '첨부 사진',
          loading: 'lazy',
          onclick: () => openViewer(media.photoURL(p, { full: true })),
        }),
        el('button', {
          type: 'button', class: 'rm', text: '✕', 'aria-label': '사진 삭제',
          onclick: async () => {
            draft.photoIds = draft.photoIds.filter((id) => id !== p.id);
            await media.deletePhoto(p.id);
            renderPhotos();
          },
        }),
      ]));
    });
    photoGrid.append(el('button', {
      type: 'button',
      class: 'photo-add',
      onclick: () => fileInput.click(),
    }, [
      el('span', { class: 'ico', text: '＋' }),
      el('span', { text: '사진 추가' }),
    ]));
  }
  renderPhotos();

  /* ----- 삭제 ----- */
  if (original) {
    body.append(el('button', {
      type: 'button',
      class: 'btn danger',
      text: '이 항목 삭제',
      style: { marginTop: '6px' },
      onclick: async () => {
        const ok = await confirmDialog({
          title: '항목 삭제',
          message: `'${original.title}'을(를) 삭제할까요? 첨부한 사진도 함께 지워집니다.`,
          confirmLabel: '삭제',
          danger: true,
        });
        if (!ok) return;
        await store.deleteItem(original.id);
        toast('삭제했습니다.');
        api.close(null);
      },
    }));
  }
}

/**
 * 디데이의 목표일 편집기.
 *
 * 기본은 목표일 하나뿐이고, '기간으로 관리'를 켜면 시작일과 총 일수가 나옵니다.
 * 두 날짜가 실제 데이터이고 총 일수 칸은 계산기입니다.
 *  - 시작일이나 목표일을 바꾸면 총 일수가 다시 계산돼 보입니다.
 *  - 총 일수를 입력하면 시작일을 기준으로 목표일을 채워 줍니다.
 */
function buildPeriodFields(draft, endInput) {
  const wrap = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } });

  const endLabel = el('label', { text: draft.startDate ? '마감일' : '목표일' });
  wrap.append(el('div', { class: 'field' }, [endLabel, endInput]));

  const toggle = el('span', { class: 'switch', role: 'switch' });
  const toggleRow = el('button', {
    type: 'button',
    class: 'switch-row',
    style: { width: '100%', textAlign: 'left' },
    onclick: () => {
      draft.startDate = draft.startDate ? null : todayKey();
      refresh();
    },
  }, [
    el('div', {}, [
      el('div', { class: 'label', text: '기간으로 관리' }),
      el('div', { class: 'desc', text: '시작일부터 며칠 걸리는지, 지금 몇 일째인지 보여 줍니다.' }),
    ]),
    toggle,
  ]);
  wrap.append(toggleRow);

  const details = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } });
  wrap.append(details);

  const startInput = el('input', { type: 'date' });
  const durInput = el('input', {
    type: 'number', min: '1', max: '99999', inputmode: 'numeric', placeholder: '예: 30',
  });
  const hint = el('div', { class: 'hint' });

  startInput.addEventListener('change', (e) => {
    draft.startDate = e.target.value || null;
    refresh();
  });
  endInput.addEventListener('change', (e) => {
    draft.dueDate = e.target.value || null;
    refresh();
  });

  const applyDuration = (days) => {
    const n = Number(days);
    if (!Number.isFinite(n) || n < 1) return;
    if (!draft.startDate) draft.startDate = todayKey();
    draft.dueDate = endDateFromDuration(draft.startDate, n);
    refresh();
  };
  durInput.addEventListener('change', (e) => applyDuration(e.target.value));

  const durField = el('div', { class: 'field' }, [
    el('label', { text: '총 며칠 걸리나요?' }),
    el('div', { class: 'row' }, [
      durInput,
      el('button', {
        type: 'button',
        class: 'btn',
        text: '마감일 계산',
        style: { flex: '0 0 auto', width: 'auto' },
        onclick: () => applyDuration(durInput.value),
      }),
    ]),
  ]);
  const quick = el('div', { class: 'chip-row' });
  [7, 30, 50, 100, 365].forEach((n) => {
    quick.append(el('button', {
      type: 'button', class: 'chip tap', text: `${n}일`,
      onclick: () => { durInput.value = String(n); applyDuration(n); },
    }));
  });
  durField.append(quick);

  function refresh() {
    const on = !!draft.startDate;
    toggle.setAttribute('aria-checked', String(on));
    endLabel.textContent = on ? '마감일' : '목표일';
    endInput.value = draft.dueDate || '';
    details.replaceChildren();
    if (!on) return;

    startInput.value = draft.startDate;
    const total = draft.dueDate ? daysInclusive(draft.startDate, draft.dueDate) : null;
    durInput.value = total && total > 0 ? String(total) : '';
    hint.replaceChildren(...summaryNodes(draft));
    details.append(
      el('div', { class: 'field' }, [el('label', { text: '시작일' }), startInput]),
      durField,
      hint,
      barToggleRow(draft, refresh),
    );
  }

  refresh();
  return wrap;
}

/** 기간 요약 문구 */
function summaryNodes(draft) {
  if (!draft.dueDate) return [el('span', { text: '마감일을 정해 주세요.' })];
  if (draft.startDate > draft.dueDate) {
    return [el('span', { class: 'warn', text: '\u26a0\ufe0f 마감일이 시작일보다 빠릅니다.' })];
  }
  const p = periodProgress(draft.startDate, draft.dueDate);
  const range = `${formatRange(draft.startDate, draft.dueDate)} \u00b7 총 ${p.total}일`;
  let phase = '';
  if (p.phase === 'before') phase = `시작까지 ${p.untilStart}일 남았습니다.`;
  else if (p.phase === 'after') phase = `${p.sinceEnd}일 전에 끝난 기간입니다.`;
  else phase = `오늘 ${p.elapsed}일째 \u00b7 ${p.remaining}일 남음 (${p.percent}%)`;
  return [el('span', { text: range }), el('br'), el('span', { class: 'strong', text: phase })];
}

/**
 * 기간이 있는 항목을 달력에 어떻게 보일지 고르는 스위치.
 * 꺼도 시작일은 남아 있어 진행률 계산은 그대로입니다.
 */
function barToggleRow(draft, onChange) {
  const sw = el('span', { class: 'switch', role: 'switch',
    'aria-checked': String(draft.showAsBar !== false) });
  return el('button', {
    type: 'button',
    class: 'switch-row',
    style: { width: '100%', textAlign: 'left' },
    onclick: () => { draft.showAsBar = draft.showAsBar === false; onChange(); },
  }, [
    el('div', {}, [
      el('div', { class: 'label', text: '캘린더에 줄로 표시' }),
      el('div', { class: 'desc', text: draft.showAsBar === false
        ? '지금은 마감일에만 점으로 표시됩니다. 기간 계산은 그대로입니다.'
        : '시작일부터 마감일까지 줄로 이어집니다.' }),
    ]),
    sw,
  ]);
}

function field(label, ...controls) {
  return el('div', { class: 'field' }, [el('label', { text: label }), ...controls]);
}

/* ---------------- 폴더 편집 ---------------- */

export async function openFolderEditor(folder = null) {
  const draft = folder
    ? { ...folder }
    : { id: null, name: '', emoji: '📁', color: store.FOLDER_COLORS[0] };

  return openSheet({
    title: folder ? '폴더 수정' : '새 폴더',
    buildBody: ({ body, close }) => {
      const nameInput = el('input', {
        type: 'text',
        value: draft.name,
        placeholder: '폴더 이름',
        maxlength: '40',
        'data-autofocus': '',
        oninput: (e) => { draft.name = e.target.value; },
      });
      body.append(field('이름', nameInput));

      const emojiRow = el('div', { class: 'emoji-row' });
      FOLDER_EMOJIS.forEach((em) => {
        emojiRow.append(el('button', {
          type: 'button',
          class: 'emoji-pick',
          text: em,
          'aria-pressed': String(draft.emoji === em),
          onclick: () => {
            draft.emoji = em;
            [...emojiRow.children].forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === em)));
          },
        }));
      });
      body.append(field('아이콘', emojiRow));

      const colorRow = el('div', { class: 'color-row' });
      store.FOLDER_COLORS.forEach((c) => {
        colorRow.append(el('button', {
          type: 'button',
          class: 'color-dot',
          style: { background: c },
          'aria-pressed': String(draft.color === c),
          'aria-label': '색상 선택',
          onclick: () => {
            draft.color = c;
            [...colorRow.children].forEach((b, i) => b.setAttribute('aria-pressed', String(store.FOLDER_COLORS[i] === c)));
          },
        }));
      });
      body.append(field('색상', colorRow));

      if (folder) {
        body.append(el('button', {
          type: 'button',
          class: 'btn danger',
          text: '폴더 삭제',
          style: { marginTop: '6px' },
          onclick: async () => {
            const items = await store.itemsForFolder(folder.id);
            const ok = await confirmDialog({
              title: '폴더 삭제',
              message: items.length
                ? `'${folder.name}' 폴더를 지웁니다. 안에 있는 ${items.length}개 항목은 '폴더 없음'으로 옮겨집니다.`
                : `'${folder.name}' 폴더를 지울까요?`,
              confirmLabel: '삭제',
            });
            if (!ok) return;
            await store.deleteFolder(folder.id, 'move');
            toast('폴더를 삭제했습니다.');
            close(null);
          },
        }));
      }
    },
    onConfirm: async () => {
      if (!draft.name.trim()) { toast('폴더 이름을 입력해 주세요.'); return false; }
      return store.saveFolder(draft);
    },
  });
}


/* ---------------- 가계부 ---------------- */

/**
 * 지출/수입 입력 시트.
 * 금액 칸에 먼저 포커스를 두어 바로 숫자를 칠 수 있게 합니다.
 */
export async function openExpenseEditor(row = null, defaults = {}) {
  const draft = row ? { ...row } : money.blankExpense(defaults);

  return openSheet({
    title: row ? '내역 수정' : '가계부 입력',
    confirmLabel: '저장',
    buildBody: (api) => buildExpenseForm(api, draft, row),
    onConfirm: async () => {
      if (!draft.amount || draft.amount <= 0) {
        toast('금액을 입력해 주세요.');
        return false;
      }
      return money.save(draft);
    },
  });
}

function buildExpenseForm(api, draft, original) {
  const { body } = api;

  /* 지출 / 수입 */
  const typeSeg = el('div', { class: 'seg' });
  [['expense', '지출'], ['income', '수입']].forEach(([value, label]) => {
    typeSeg.append(el('button', {
      type: 'button',
      text: label,
      'aria-pressed': String(draft.type === value),
      onclick: () => {
        if (draft.type === value) return;
        draft.type = value;
        draft.category = money.categoriesFor(value)[0].value;
        if (value === 'income' && (draft.method === 'credit' || draft.method === 'debit')) {
          draft.method = 'transfer';
        }
        [...typeSeg.children].forEach((b, i) =>
          b.setAttribute('aria-pressed', String(['expense', 'income'][i] === draft.type)));
        renderCategories();
        renderMethods();
        amountInput.classList.toggle('income', draft.type === 'income');
      },
    }));
  });
  body.append(field('종류', typeSeg));

  /* 금액 */
  const amountInput = el('input', {
    type: 'text',
    inputmode: 'numeric',
    class: 'amount-input' + (draft.type === 'income' ? ' income' : ''),
    placeholder: '0',
    'data-autofocus': '',
    value: draft.amount ? money.formatWon(draft.amount).replace('원', '') : '',
    oninput: (e) => {
      const n = money.parseAmount(e.target.value);
      draft.amount = n;
      // 입력하는 동안에도 천 단위 쉼표가 보이게 합니다.
      e.target.value = n ? new Intl.NumberFormat('ko-KR').format(n) : '';
    },
  });
  const amountWrap = el('div', { class: 'amount-row' }, [amountInput, el('span', { class: 'won', text: '원' })]);
  body.append(field('금액', amountWrap));

  /* 빠른 금액 */
  const quick = el('div', { class: 'chip-row' });
  [1000, 5000, 10000, 30000, 50000].forEach((n) => {
    quick.append(el('button', {
      type: 'button', class: 'chip tap', text: `+${new Intl.NumberFormat('ko-KR').format(n)}`,
      onclick: () => {
        draft.amount = (draft.amount || 0) + n;
        amountInput.value = new Intl.NumberFormat('ko-KR').format(draft.amount);
      },
    }));
  });
  quick.append(el('button', {
    type: 'button', class: 'chip tap', text: '지우기',
    onclick: () => { draft.amount = 0; amountInput.value = ''; },
  }));
  body.append(quick);

  /* 날짜 */
  body.append(field('날짜', el('input', {
    type: 'date',
    value: draft.date,
    onchange: (e) => { draft.date = e.target.value || todayKey(); },
  })));

  /* 결제수단 */
  const methodWrap = el('div', { class: 'pick-grid' });
  const methodField = field('결제수단', methodWrap);
  body.append(methodField);

  function renderMethods() {
    methodWrap.replaceChildren();
    const usable = draft.type === 'income'
      ? money.METHODS.filter((m) => m.value === 'cash' || m.value === 'transfer')
      : money.METHODS;
    usable.forEach((m) => {
      methodWrap.append(el('button', {
        type: 'button',
        class: 'pick',
        text: m.label,
        'aria-pressed': String(draft.method === m.value),
        onclick: () => {
          draft.method = m.value;
          [...methodWrap.children].forEach((b) =>
            b.setAttribute('aria-pressed', String(b.textContent === m.label)));
        },
      }));
    });
  }
  renderMethods();

  /* 분류 */
  const catWrap = el('div', { class: 'pick-grid' });
  body.append(field('분류', catWrap));

  function renderCategories() {
    catWrap.replaceChildren();
    money.categoriesFor(draft.type).forEach((c) => {
      catWrap.append(el('button', {
        type: 'button',
        class: 'pick',
        'aria-pressed': String(draft.category === c.value),
        dataset: { value: c.value },
        onclick: () => {
          draft.category = c.value;
          [...catWrap.children].forEach((b) =>
            b.setAttribute('aria-pressed', String(b.dataset.value === c.value)));
        },
      }, [
        el('span', { text: c.emoji }),
        el('span', { text: c.label }),
      ]));
    });
  }
  renderCategories();

  /* 메모 */
  const memo = el('input', {
    type: 'text',
    placeholder: '어디에 썼는지 적어 두세요',
    maxlength: '100',
    value: draft.memo || '',
    oninput: (e) => { draft.memo = e.target.value; },
  });
  body.append(field('메모', memo));

  /* 삭제 */
  if (original) {
    body.append(el('button', {
      type: 'button',
      class: 'btn danger',
      text: '이 내역 삭제',
      style: { marginTop: '6px' },
      onclick: async () => {
        const ok = await confirmDialog({
          title: '내역 삭제',
          message: `${money.formatWon(original.amount)} 내역을 삭제할까요?`,
          confirmLabel: '삭제',
          danger: true,
        });
        if (!ok) return;
        await money.remove(original.id);
        toast('삭제했습니다.');
        api.close(null);
      },
    }));
  }
}
