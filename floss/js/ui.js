/* ui.js — 화면을 다루는 자잘한 도구들 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

let toastTimer = null;
export function toast(message, kind = '') {
  let box = $('#toast');
  if (!box) {
    box = el('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(box);
  }
  box.textContent = message;
  box.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.className = 'toast'; }, 2600);
}

/** 예/아니오 물어보기 */
export function confirmSheet(title, body, okLabel = '네') {
  return new Promise((resolve) => {
    const close = (v) => { wrap.remove(); resolve(v); };
    const wrap = el('div', { class: 'sheet-wrap', onclick: (e) => { if (e.target === wrap) close(false); } }, [
      el('div', { class: 'sheet' }, [
        el('h2', { text: title }),
        body ? el('p', { class: 'muted', text: body }) : null,
        el('div', { class: 'sheet-actions' }, [
          el('button', { class: 'btn', type: 'button', onclick: () => close(false), text: '취소' }),
          el('button', { class: 'btn primary', type: 'button', onclick: () => close(true), text: okLabel }),
        ]),
      ]),
    ]);
    document.body.append(wrap);
  });
}

/** 글자 하나 물어보기 */
export function promptSheet(title, hint, placeholder = '') {
  return new Promise((resolve) => {
    const input = el('input', { placeholder, value: '' });
    const close = (v) => { wrap.remove(); resolve(v); };
    const ok = () => close(input.value.trim() || null);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
    const wrap = el('div', { class: 'sheet-wrap', onclick: (e) => { if (e.target === wrap) close(null); } }, [
      el('div', { class: 'sheet' }, [
        el('h2', { text: title }),
        hint ? el('p', { class: 'muted small', text: hint }) : null,
        input,
        el('div', { class: 'sheet-actions' }, [
          el('button', { class: 'btn', type: 'button', onclick: () => close(null), text: '취소' }),
          el('button', { class: 'btn primary', type: 'button', onclick: ok, text: '만들기' }),
        ]),
      ]),
    ]);
    document.body.append(wrap);
    setTimeout(() => input.focus(), 30);
  });
}

/** 파일 하나 내려받기 (보통 브라우저) */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

let downloadsCap;
async function getDownloads() {
  if (downloadsCap !== undefined) return downloadsCap;
  downloadsCap = null;
  try {
    if (globalThis.claude && typeof globalThis.claude.use === 'function') {
      downloadsCap = await globalThis.claude.use('downloads');
    }
  } catch (e) { /* 이 화면에서는 쓸 수 없습니다 */ }
  return downloadsCap;
}

/**
 * 파일을 사용자에게 건네줍니다.
 * 한 장짜리 페이지로 열려 있을 때는 그 쪽 저장 창을 쓰고,
 * 보통 브라우저에서는 그냥 내려받습니다.
 * @returns {Promise<'saved'|'declined'|'failed'>}
 */
export async function saveFile(blob, filename) {
  const cap = await getDownloads();
  if (cap) {
    try {
      await cap.save({ filename, data: blob });
      return 'saved';
    } catch (e) {
      return e && e.code === 'declined' ? 'declined' : 'failed';
    }
  }
  try {
    downloadBlob(blob, filename);
    return 'saved';
  } catch (e) {
    return 'failed';
  }
}

/** 클립보드에 글자 넣기 (안 되면 false) */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = el('textarea', { style: { position: 'fixed', opacity: '0' } });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e2) {
      return false;
    }
  }
}

/**
 * 'auto' 는 아무 표시도 남기지 않아, 기기 설정(또는 이 페이지를 띄운 쪽의 설정)을
 * 그대로 따르게 합니다.
 */
export function setTheme(theme) {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('theme', theme); } catch (e) { /* 저장 막힘 */ }
}

export function getTheme() {
  try { return localStorage.getItem('theme') || 'auto'; } catch (e) { return 'auto'; }
}
