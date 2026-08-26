/* editor.js — 항목 편집 시트, 폴더 편집 시트 */

import { el, openSheet, toast, confirmDialog, openViewer } from './ui.js';
import * as store from './store.js';
import * as media from './media.js';
import * as db from './db.js';
import { REPEAT_LABELS, REMIND_OPTIONS, todayKey } from './util.js';

const TYPES = [
  { value: 'task', label: '할 일' },
  { value: 'event', label: '일정' },
  { value: 'dday', label: '디데이' },
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
      onclick: () => {
        draft.type = t.value;
        if (t.value === 'dday') {
          draft.dueTime = null;
          draft.repeat = 'none';
          if (!draft.dueDate) draft.dueDate = todayKey();
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
      dynamic.append(field('목표 날짜', dateInput));
    } else {
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

      const clearRow = el('button', {
        type: 'button',
        class: 'btn-ghost',
        text: draft.dueDate ? '날짜 지우기 (언젠가 할 일로)' : '날짜 없음',
        onclick: () => {
          draft.dueDate = null;
          draft.dueTime = null;
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
