/* ui.js — 공통 UI 조각 (토스트, 시트, 확인창) */

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c === null || c === undefined || c === false) return;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  });
  return node;
}

/* ---------------- 토스트 ---------------- */

let toastWrap = null;

export function toast(message, { action, onAction, duration = 3200 } = {}) {
  if (!toastWrap) {
    toastWrap = el('div', { class: 'toast-wrap' });
    document.body.append(toastWrap);
  }
  const node = el('div', { class: 'toast' }, [el('span', { text: message })]);
  if (action) {
    node.append(el('button', {
      type: 'button',
      text: action,
      onclick: () => { node.remove(); onAction && onAction(); },
    }));
  }
  toastWrap.append(node);
  const t = setTimeout(() => node.remove(), duration);
  node.addEventListener('click', (e) => {
    if (e.target.tagName !== 'BUTTON') { clearTimeout(t); node.remove(); }
  });
  return node;
}

/* ---------------- 바텀 시트 ---------------- */

const sheetStack = [];

/**
 * 바텀 시트를 엽니다.
 * build(api)는 본문 내용을 만들고, api.close()로 닫습니다.
 */
export function openSheet({ title, buildBody, confirmLabel = '저장', onConfirm, cancelLabel = '취소', showConfirm = true }) {
  const backdrop = el('div', { class: 'sheet-backdrop' });
  const sheet = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const body = el('div', { class: 'sheet-body' });

  const api = {
    close: (result) => close(result),
    setConfirmEnabled: (on) => { confirmBtn.disabled = !on; },
    body,
  };

  let resolveFn;
  const promise = new Promise((res) => { resolveFn = res; });

  const cancelBtn = el('button', { type: 'button', text: cancelLabel, onclick: () => close(null) });
  const confirmBtn = el('button', { type: 'button', class: 'primary', text: confirmLabel });
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    try {
      const result = await onConfirm?.(api);
      if (result !== false) close(result === undefined ? true : result);
      else confirmBtn.disabled = false;
    } catch (err) {
      console.error(err);
      toast(err.message || '저장하지 못했습니다.');
      confirmBtn.disabled = false;
    }
  });

  const head = el('div', { class: 'sheet-head' }, [
    cancelBtn,
    el('h2', { text: title }),
    showConfirm ? confirmBtn : el('span', { style: { minWidth: '60px' } }),
  ]);

  sheet.append(head, body);
  backdrop.append(sheet);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(null); });
  document.body.append(backdrop);
  document.body.style.overflow = 'hidden';
  sheetStack.push(close);

  buildBody(api);

  // 첫 입력에 자동으로 포커스 (모바일에서 키보드가 바로 뜨도록)
  const first = body.querySelector('input[data-autofocus], textarea[data-autofocus]');
  if (first) setTimeout(() => first.focus(), 60);

  function close(result) {
    const i = sheetStack.indexOf(close);
    if (i === -1) return;
    sheetStack.splice(i, 1);
    backdrop.remove();
    if (!sheetStack.length) document.body.style.overflow = '';
    resolveFn(result);
  }

  return promise;
}

export function closeTopSheet() {
  const close = sheetStack[sheetStack.length - 1];
  if (close) { close(null); return true; }
  return false;
}

/* ---------------- 확인창 ---------------- */

export function confirmDialog({ title, message, confirmLabel = '확인', danger = false }) {
  return openSheet({
    title,
    confirmLabel,
    buildBody: ({ body }) => {
      body.append(el('p', { text: message, style: { margin: '4px 0 8px', fontSize: '14.5px', lineHeight: '1.55' } }));
      if (danger) {
        body.append(el('div', { class: 'notice warn' }, [
          el('span', { class: 'ico', text: '⚠️' }),
          el('span', { text: '이 작업은 되돌릴 수 없습니다.' }),
        ]));
      }
    },
    onConfirm: () => true,
  }).then((r) => r === true);
}

/* ---------------- 선택 목록 ---------------- */

export function pickerSheet({ title, options, value }) {
  return openSheet({
    title,
    showConfirm: false,
    buildBody: ({ body, close }) => {
      const group = el('div', { class: 'settings-group' });
      options.forEach((opt) => {
        group.append(el('button', {
          type: 'button',
          class: 'settings-row',
          onclick: () => close(opt.value),
        }, [
          opt.emoji ? el('span', { text: opt.emoji, style: { fontSize: '19px' } }) : null,
          el('div', { class: 'grow' }, [
            el('div', { class: 'label', text: opt.label }),
            opt.desc ? el('div', { class: 'desc', text: opt.desc }) : null,
          ]),
          el('span', { class: 'value', text: String(opt.value) === String(value) ? '✓' : '' }),
        ]));
      });
      body.append(group);
    },
  });
}

/* ---------------- 사진 뷰어 ---------------- */

export function openViewer(src) {
  const v = el('div', { class: 'viewer' }, [
    el('img', { src, alt: '첨부 사진' }),
    el('button', { type: 'button', class: 'close', text: '✕', 'aria-label': '닫기' }),
  ]);
  v.addEventListener('click', () => v.remove());
  document.body.append(v);
}

/* ---------------- 스와이프 없이 쓰는 롱프레스 ---------------- */

export function onLongPress(node, handler, ms = 500) {
  let timer = null;
  let moved = false;
  const start = (e) => {
    moved = false;
    timer = setTimeout(() => { if (!moved) handler(e); }, ms);
  };
  const cancel = () => { clearTimeout(timer); };
  node.addEventListener('touchstart', start, { passive: true });
  node.addEventListener('touchmove', () => { moved = true; cancel(); }, { passive: true });
  node.addEventListener('touchend', cancel);
  node.addEventListener('touchcancel', cancel);
  node.addEventListener('contextmenu', (e) => { e.preventDefault(); handler(e); });
}
