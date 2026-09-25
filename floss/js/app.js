/* app.js — 실 자르기 · 색코드
   사진에서 빨간선(또는 번호)로 표시한 실만 잘라 순서대로 정렬하고,
   책자(색상표)를 고르면 가장 가까운 실 번호를 따로 알려 줍니다.
   사진은 이 기기 밖으로 나가지 않습니다. */

import {
  $, $$, el, toast, confirmSheet, promptSheet, saveFile, copyText, setTheme, getTheme,
} from './ui.js';
import * as db from './db.js';
import { detectRedRegions, ANALYSIS_MAX, overlapRatio } from './detect.js';
import {
  makeCanvas, context2d, cropCanvas, canvasToBlob, sortBoxes, SORT_LABELS, stitch,
} from './crop.js';
import { representativeColor, medianAround } from './sample.js';
import {
  loadPalette, loadCustomList, saveCustomList, parsePaletteText, match, findByCode,
  createCustom, upsertColors, toCsv, BUILTIN,
} from './palette.js';
import { findHanks } from './card.js';
import { rgbToHex, readableInk, deltaEWord } from './color.js';
import * as ocr from './ocr.js';

/* ------------------------------------------------------------------ 상태 */

const DEFAULTS = {
  sortMode: 'reading',
  paletteId: 'dmc',
  detect: {
    strength: 1,
    join: 0.008,
    mode: 'auto',
    pad: 0,
    band: 0.1,
    width: 0.3,
    trim: true,
    side: 'auto',
    ignoreSolid: true,
  },
  find: { dir: 'auto', size: 6 },
  out: {
    layout: 'row', columns: 4, gap: 14, pad: 14, bg: '#ffffff', label: 'both',
  },
  sample: { skipRed: true, skipPaper: true, inset: 0.12 },
};

const state = {
  photos: [],
  current: 0,
  scan: null, // 책자 만들기: 사진에서 찾아 둔 타래들
  palette: null,
  tool: 'view',
  selected: null,
  tab: 'photo',
  ...structuredClone(DEFAULTS),
};

// dirty: 화면이 숨어 있어서 크기를 알 수 없었던 상태. 탭을 열 때 다시 맞춥니다.
const view = { scale: 1, ox: 0, oy: 0, dirty: true };
let stage = null;
let stageCtx = null;
let drawQueued = false;
let nextId = 1;

const photo = () => state.photos[state.current] || null;
const uid = () => `b${nextId++}`;

/* -------------------------------------------------------------- 설정 저장 */

const SETTINGS_KEY = 'floss.settings.v1';

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      sortMode: state.sortMode,
      paletteId: state.paletteId,
      detect: state.detect,
      find: state.find,
      out: state.out,
      sample: state.sample,
    }));
  } catch (e) { /* 저장을 막아 둔 브라우저 */ }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    for (const key of ['sortMode', 'paletteId']) if (s[key]) state[key] = s[key];
    for (const key of ['detect', 'find', 'out', 'sample']) {
      if (s[key] && typeof s[key] === 'object') Object.assign(state[key], s[key]);
    }
  } catch (e) { /* 값이 깨졌으면 기본값 */ }
}

/* -------------------------------------------------------------- 사진 불러오기 */

/** 사진을 그릴 수 있는 형태로 풉니다. 브라우저가 옵션을 모르면 차례로 물러섭니다. */
async function decodeImage(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (e) { /* 옵션을 모르는 브라우저 */ }
  try {
    return await createImageBitmap(blob);
  } catch (e) { /* createImageBitmap 자체가 없는 경우 */ }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

async function addFiles(files) {
  const list = Array.from(files).filter((f) => f.type.startsWith('image/'));
  if (!list.length) {
    toast('사진 파일이 아닙니다.', 'bad');
    return;
  }
  for (const file of list) {
    try {
      const bitmap = await decodeImage(file);
      state.photos.push({
        id: `p${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
        name: file.name || '사진',
        blob: file,
        bitmap,
        boxes: [],
        words: null,
      });
    } catch (e) {
      toast(`${file.name || '사진'} 을 열지 못했습니다.`, 'bad');
    }
  }
  state.current = state.photos.length - 1;
  fitView();
  renderAll();
  persist();
  if (state.photos.length) goTab('cut');
}

function removePhoto(index) {
  const p = state.photos[index];
  if (!p) return;
  if (p.bitmap && p.bitmap.close) p.bitmap.close();
  state.photos.splice(index, 1);
  state.current = Math.max(0, Math.min(state.current, state.photos.length - 1));
  fitView();
  renderAll();
  persist();
}

/* ------------------------------------------------------------------ 화면 */

function fitView() {
  const p = photo();
  if (!p || !stage) return;
  const cw = stage.clientWidth || 0;
  const ch = stage.clientHeight || 0;
  if (cw < 8 || ch < 8) { view.dirty = true; return; } // 아직 화면에 나오지 않았습니다
  const s = Math.min(cw / p.bitmap.width, ch / p.bitmap.height);
  view.scale = s;
  view.ox = (cw - p.bitmap.width * s) / 2;
  view.oy = (ch - p.bitmap.height * s) / 2;
  view.dirty = false;
  requestDraw();
}

function toImage(px, py) {
  return { x: (px - view.ox) / view.scale, y: (py - view.oy) / view.scale };
}

function toScreen(x, y) {
  return { x: x * view.scale + view.ox, y: y * view.scale + view.oy };
}

function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    drawStage();
  });
}

function resizeStage() {
  if (!stage) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const w = Math.max(1, Math.round(stage.clientWidth * dpr));
  const h = Math.max(1, Math.round(stage.clientHeight * dpr));
  if (stage.width !== w || stage.height !== h) {
    stage.width = w;
    stage.height = h;
  }
  stageCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  requestDraw();
}

function drawStage() {
  if (!stage || !stageCtx) return;
  const cw = stage.clientWidth;
  const ch = stage.clientHeight;
  stageCtx.clearRect(0, 0, cw, ch);
  const p = photo();
  $('#stage-empty').hidden = !!p;
  if (!p) return;

  stageCtx.imageSmoothingEnabled = true; // 화면에 보여 줄 때만. 저장은 원본 그대로입니다.
  stageCtx.drawImage(
    p.bitmap, view.ox, view.oy,
    p.bitmap.width * view.scale, p.bitmap.height * view.scale,
  );

  const ordered = orderedBoxes(p);
  ordered.forEach((b, i) => {
    const a = toScreen(b.x, b.y);
    const w = b.w * view.scale;
    const h = b.h * view.scale;
    const on = state.selected === b.id;

    stageCtx.lineWidth = on ? 3 : 2;
    stageCtx.strokeStyle = on ? '#ffd54a' : '#3ddc84';
    stageCtx.setLineDash(on ? [] : [7, 5]);
    stageCtx.strokeRect(a.x + 0.5, a.y + 0.5, w, h);
    stageCtx.setLineDash([]);

    // 순서 번호
    const badge = String(i + 1);
    stageCtx.font = '700 13px system-ui, sans-serif';
    const tw = stageCtx.measureText(badge).width + 12;
    stageCtx.fillStyle = on ? '#ffd54a' : '#3ddc84';
    stageCtx.fillRect(a.x, a.y - 20, tw, 20);
    stageCtx.fillStyle = '#08130d';
    stageCtx.textBaseline = 'middle';
    stageCtx.textAlign = 'center';
    stageCtx.fillText(badge, a.x + tw / 2, a.y - 10);

    if (b.label) {
      stageCtx.font = '600 12px system-ui, sans-serif';
      const lw = stageCtx.measureText(b.label).width + 10;
      stageCtx.fillStyle = 'rgba(0,0,0,.66)';
      stageCtx.fillRect(a.x + tw + 3, a.y - 20, lw, 20);
      stageCtx.fillStyle = '#fff';
      stageCtx.fillText(b.label, a.x + tw + 3 + lw / 2, a.y - 10);
    }

    if (on) {
      stageCtx.fillStyle = '#ffd54a';
      for (const [hx, hy] of corners(a.x, a.y, w, h)) {
        stageCtx.fillRect(hx - 7, hy - 7, 14, 14);
      }
    }
  });
}

function corners(x, y, w, h) {
  return [[x, y], [x + w, y], [x, y + h], [x + w, y + h]];
}

/* --------------------------------------------------------- 손가락/마우스 조작 */

const pointers = new Map();
let drag = null;
let pinch = null;

function boxAt(ix, iy) {
  const p = photo();
  if (!p) return null;
  const list = orderedBoxes(p).slice().reverse();
  return list.find((b) => ix >= b.x && ix <= b.x + b.w && iy >= b.y && iy <= b.y + b.h) || null;
}

function handleAt(px, py) {
  const p = photo();
  if (!p || !state.selected) return null;
  const b = p.boxes.find((v) => v.id === state.selected);
  if (!b) return null;
  const a = toScreen(b.x, b.y);
  const w = b.w * view.scale;
  const h = b.h * view.scale;
  const names = ['nw', 'ne', 'sw', 'se'];
  const pts = corners(a.x, a.y, w, h);
  for (let i = 0; i < pts.length; i += 1) {
    if (Math.hypot(px - pts[i][0], py - pts[i][1]) <= 18) return { box: b, corner: names[i] };
  }
  return null;
}

function bindStage() {
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (pointers.size === 2) {
      const [a, b] = Array.from(pointers.values());
      pinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
        scale: view.scale,
        ox: view.ox,
        oy: view.oy,
      };
      drag = null;
      return;
    }
    if (pointers.size > 2) return;

    const hit = handleAt(e.offsetX, e.offsetY);
    const img = toImage(e.offsetX, e.offsetY);
    if (hit) {
      drag = { kind: 'resize', box: hit.box, corner: hit.corner, start: img, orig: { ...hit.box } };
      return;
    }
    const b = boxAt(img.x, img.y);
    if (b) {
      state.selected = b.id;
      drag = { kind: 'move', box: b, start: img, orig: { ...b } };
      renderPieces();
      requestDraw();
      return;
    }
    if (state.tool === 'draw' && photo()) {
      const nb = {
        id: uid(), x: Math.round(img.x), y: Math.round(img.y), w: 1, h: 1, kind: 'manual', label: '',
      };
      photo().boxes.push(nb);
      state.selected = nb.id;
      drag = { kind: 'create', box: nb, start: img };
      requestDraw();
      return;
    }
    state.selected = null;
    drag = { kind: 'pan', sx: e.offsetX, sy: e.offsetY, ox: view.ox, oy: view.oy };
    renderPieces();
    requestDraw();
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });

    if (pinch && pointers.size >= 2) {
      const [a, b] = Array.from(pointers.values());
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const factor = dist / (pinch.dist || 1);
      const scale = Math.max(0.05, Math.min(24, pinch.scale * factor));
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      view.ox = cx - ((pinch.cx - pinch.ox) / pinch.scale) * scale;
      view.oy = cy - ((pinch.cy - pinch.oy) / pinch.scale) * scale;
      view.scale = scale;
      requestDraw();
      return;
    }
    if (!drag) return;
    const img = toImage(e.offsetX, e.offsetY);

    if (drag.kind === 'pan') {
      view.ox = drag.ox + (e.offsetX - drag.sx);
      view.oy = drag.oy + (e.offsetY - drag.sy);
      requestDraw();
      return;
    }
    if (drag.kind === 'create') {
      const b = drag.box;
      b.x = Math.round(Math.min(drag.start.x, img.x));
      b.y = Math.round(Math.min(drag.start.y, img.y));
      b.w = Math.max(1, Math.round(Math.abs(img.x - drag.start.x)));
      b.h = Math.max(1, Math.round(Math.abs(img.y - drag.start.y)));
      clampBox(b);
      requestDraw();
      return;
    }
    if (drag.kind === 'move') {
      const b = drag.box;
      b.x = Math.round(drag.orig.x + (img.x - drag.start.x));
      b.y = Math.round(drag.orig.y + (img.y - drag.start.y));
      clampBox(b);
      requestDraw();
      return;
    }
    if (drag.kind === 'resize') {
      const b = drag.box;
      const o = drag.orig;
      let x0 = o.x;
      let y0 = o.y;
      let x1 = o.x + o.w;
      let y1 = o.y + o.h;
      if (drag.corner.includes('n')) y0 = img.y;
      if (drag.corner.includes('s')) y1 = img.y;
      if (drag.corner.includes('w')) x0 = img.x;
      if (drag.corner.includes('e')) x1 = img.x;
      b.x = Math.round(Math.min(x0, x1));
      b.y = Math.round(Math.min(y0, y1));
      b.w = Math.max(2, Math.round(Math.abs(x1 - x0)));
      b.h = Math.max(2, Math.round(Math.abs(y1 - y0)));
      clampBox(b);
      requestDraw();
    }
  });

  const finish = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!drag) return;
    if (drag.kind === 'create' && (drag.box.w < 6 || drag.box.h < 6)) {
      const p = photo();
      p.boxes = p.boxes.filter((b) => b.id !== drag.box.id);
      state.selected = null;
    } else if (drag.kind !== 'pan') {
      invalidate(drag.box);
      resort();
    }
    drag = null;
    renderPieces();
    requestDraw();
    persist();
  };
  stage.addEventListener('pointerup', finish);
  stage.addEventListener('pointercancel', finish);

  stage.addEventListener('wheel', (e) => {
    if (!photo()) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0016);
    const scale = Math.max(0.05, Math.min(24, view.scale * factor));
    view.ox = e.offsetX - ((e.offsetX - view.ox) / view.scale) * scale;
    view.oy = e.offsetY - ((e.offsetY - view.oy) / view.scale) * scale;
    view.scale = scale;
    requestDraw();
  }, { passive: false });
}

function clampBox(b) {
  const p = photo();
  if (!p) return;
  b.w = Math.min(b.w, p.bitmap.width);
  b.h = Math.min(b.h, p.bitmap.height);
  b.x = Math.max(0, Math.min(b.x, p.bitmap.width - b.w));
  b.y = Math.max(0, Math.min(b.y, p.bitmap.height - b.h));
}

/** 상자를 고치면 뽑아 둔 색·추천 번호는 무효가 됩니다. */
function invalidate(box) {
  if (!box) return;
  delete box.rgb;
  delete box.matches;
  delete box.picked;
}

/* ------------------------------------------------------------ 빨간선 찾기 */

function analysisImageData(p) {
  const scale = Math.min(1, ANALYSIS_MAX / Math.max(p.bitmap.width, p.bitmap.height));
  const w = Math.max(1, Math.round(p.bitmap.width * scale));
  const h = Math.max(1, Math.round(p.bitmap.height * scale));
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(p.bitmap, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h), scale };
}

function detect() {
  const p = photo();
  if (!p) {
    toast('사진을 먼저 불러오세요.', 'bad');
    return;
  }
  const { data, scale } = analysisImageData(p);
  const found = detectRedRegions(data, scale, state.detect);
  if (!found.length) {
    toast('빨간선을 찾지 못했습니다. 민감도를 낮춰 보세요.', 'bad');
    return;
  }
  // 이미 있는 상자와 크게 겹치면 새로 만들지 않습니다.
  let added = 0;
  for (const f of found) {
    if (p.boxes.some((b) => overlapRatio(b, f) > 0.6)) continue;
    p.boxes.push({ ...f, id: uid(), label: '' });
    added += 1;
  }
  resort();
  renderAll();
  persist();
  toast(added ? `${added}군데 찾았습니다.` : '새로 찾은 곳이 없습니다.');
}

/* ------------------------------------------------------- 번호·표시로 찾기 */

async function findByNumber() {
  const p = photo();
  const query = $('#q-code').value.trim();
  if (!p) { toast('사진을 먼저 불러오세요.', 'bad'); return; }
  if (!query) { toast('찾을 번호나 표시를 적어 주세요.', 'bad'); return; }

  const help = $('#find-help');

  // 1) 책자에 있는 번호라면 곧바로 그 색으로 찾습니다. 인터넷도 필요 없고 제일 정확합니다.
  const palette = await ensurePalette();
  const known = palette && findByCode(palette, query);
  if (known) {
    help.textContent = `${palette.name} 의 ${query} 번 색으로 찾는 중…`;
    const message = await findInPhoto(known);
    help.textContent = message || `${palette.name} 의 ${query} 번을 찾았지만, 사진에서 견줄 조각이 없습니다.`;
    return;
  }

  // 2) 책자에 없으면 사진에 적힌 글자를 읽어 봅니다.
  help.textContent = '책자에 없는 번호라 사진 속 글자를 읽어 봅니다… (처음 한 번은 시간이 걸립니다)';

  let words = p.words;
  if (!words) {
    try {
      const scale = Math.min(1, 2000 / Math.max(p.bitmap.width, p.bitmap.height));
      const c = makeCanvas(p.bitmap.width * scale, p.bitmap.height * scale);
      context2d(c).drawImage(p.bitmap, 0, 0, c.width, c.height);
      const raw = await ocr.readWords(c, (status, prog) => {
        help.textContent = `글자 읽는 중… ${status} ${Math.round(prog * 100)}%`;
      });
      words = raw.map((wd) => ({
        ...wd, x: wd.x / scale, y: wd.y / scale, w: wd.w / scale, h: wd.h / scale,
      }));
      p.words = words;
    } catch (e) {
      words = null;
    }
  }

  const hits = words ? ocr.pickMatches(words, query) : [];
  if (hits.length) {
    let added = 0;
    for (const wd of hits) {
      const box = boxForWord(p, wd, query);
      if (!box) continue;
      if (p.boxes.some((b) => overlapRatio(b, box) > 0.6)) {
        const same = p.boxes.find((b) => overlapRatio(b, box) > 0.6);
        if (same && !same.label) same.label = query;
        continue;
      }
      p.boxes.push(box);
      added += 1;
    }
    resort();
    renderAll();
    persist();
    help.textContent = added
      ? `'${query}' 을(를) ${added}군데 찾아 잘랐습니다.`
      : `'${query}' 은(는) 이미 잡혀 있는 자리입니다.`;
    return;
  }

  help.textContent = words
    ? `'${query}' 이라는 글자를 사진에서 찾지 못했습니다. 직접 그리기로 잡거나, 책자에 이 번호를 넣어 주세요.`
    : `'${query}' 은(는) ${palette ? palette.name : '고른 책자'} 에 없고, 사진 속 글자도 읽지 못했습니다. `
      + '책자 화면에서 카드 사진으로 번호를 채워 두면 인터넷 없이도 바로 찾습니다.';
}

/** 숫자 위치를 기준으로 실이 있을 자리를 잡습니다. */
function boxForWord(p, wd, label) {
  const unit = Math.max(10, wd.h);
  const reach = unit * state.find.size;
  const marked = p.boxes.find((b) => b.kind !== 'manual'
    && wd.x + wd.w / 2 >= b.x - unit && wd.x + wd.w / 2 <= b.x + b.w + unit
    && wd.y + wd.h / 2 >= b.y - unit && wd.y + wd.h / 2 <= b.y + b.h + unit);
  if (marked) {
    if (!marked.label) marked.label = label;
    return null; // 이미 빨간선으로 잡아 둔 자리입니다.
  }

  const dir = state.find.dir === 'auto' ? guessDirection(p, wd, reach) : state.find.dir;
  const cx = wd.x + wd.w / 2;
  const cy = wd.y + wd.h / 2;
  let box;
  if (dir === 'up') box = { x: cx - reach / 2, y: wd.y - reach, w: reach, h: reach - unit * 0.4 };
  else if (dir === 'down') box = { x: cx - reach / 2, y: wd.y + wd.h + unit * 0.4, w: reach, h: reach };
  else if (dir === 'left') box = { x: wd.x - reach, y: cy - reach / 2, w: reach - unit * 0.4, h: reach };
  else if (dir === 'right') box = { x: wd.x + wd.w + unit * 0.4, y: cy - reach / 2, w: reach, h: reach };
  else box = { x: cx - reach / 2, y: cy - reach / 2, w: reach, h: reach };

  const out = {
    id: uid(),
    x: Math.round(Math.max(0, box.x)),
    y: Math.round(Math.max(0, box.y)),
    w: Math.round(box.w),
    h: Math.round(box.h),
    kind: 'number',
    label,
  };
  clampBox(out);
  return out;
}

/** 숫자 둘레에서 색이 가장 짙은 쪽을 실이 있는 방향으로 봅니다. */
function guessDirection(p, wd, reach) {
  const probe = (x, y, w, h) => {
    const rect = {
      x: Math.max(0, Math.round(x)),
      y: Math.max(0, Math.round(y)),
      w: Math.max(4, Math.round(w)),
      h: Math.max(4, Math.round(h)),
    };
    if (rect.x >= p.bitmap.width || rect.y >= p.bitmap.height) return -1;
    rect.w = Math.min(rect.w, p.bitmap.width - rect.x);
    rect.h = Math.min(rect.h, p.bitmap.height - rect.y);
    const img = readRegion(p, rect, 60);
    if (!img) return -1;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      const r = img.data[i];
      const g = img.data[i + 1];
      const b = img.data[i + 2];
      sum += Math.max(r, g, b) - Math.min(r, g, b);
      n += 1;
    }
    return n ? sum / n : -1;
  };
  const cx = wd.x + wd.w / 2;
  const cy = wd.y + wd.h / 2;
  const scores = {
    up: probe(cx - reach / 2, wd.y - reach, reach, reach * 0.9),
    down: probe(cx - reach / 2, wd.y + wd.h, reach, reach * 0.9),
    left: probe(wd.x - reach, cy - reach / 2, reach * 0.9, reach),
    right: probe(wd.x + wd.w, cy - reach / 2, reach * 0.9, reach),
  };
  return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
}

/* ---------------------------------------------------------------- 조각 목록 */

function orderedBoxes(p) {
  return p.boxes;
}

function resort() {
  for (const p of state.photos) p.boxes = sortBoxes(p.boxes, state.sortMode);
}

function allPieces() {
  const out = [];
  for (const p of state.photos) {
    for (const b of orderedBoxes(p)) out.push({ photo: p, box: b, index: out.length });
  }
  return out;
}

/** 원본에서 상자 영역의 픽셀을 읽습니다(최대 변 maxSide 로 줄여서). */
function readRegion(p, box, maxSide = 240) {
  const w = Math.max(1, Math.min(Math.round(box.w), p.bitmap.width - Math.round(box.x)));
  const h = Math.max(1, Math.min(Math.round(box.h), p.bitmap.height - Math.round(box.y)));
  if (w < 1 || h < 1) return null;
  const s = Math.min(1, maxSide / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * s));
  const ch = Math.max(1, Math.round(h * s));
  const c = makeCanvas(cw, ch);
  const ctx = c.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(p.bitmap, Math.round(box.x), Math.round(box.y), w, h, 0, 0, cw, ch);
  return ctx.getImageData(0, 0, cw, ch);
}

async function ensurePalette() {
  if (state.palette && state.palette.id === state.paletteId) return state.palette;
  try {
    const p = await loadPalette(state.paletteId);
    state.palette = { ...p, id: state.paletteId };
    return state.palette;
  } catch (e) {
    toast('색상표를 불러오지 못했습니다.', 'bad');
    return null;
  }
}

async function analyzeColors(opt = {}) {
  const palette = await ensurePalette();
  const pieces = allPieces();
  if (!pieces.length) {
    if (!opt.quiet) toast('먼저 자를 곳을 잡아 주세요.', 'bad');
    return;
  }
  for (const pc of pieces) {
    if (pc.box.rgb && pc.box.matches && pc.box.paletteId === state.paletteId) continue;
    if (!pc.box.rgb) {
      const img = readRegion(pc.photo, pc.box, 200);
      const rep = img ? representativeColor(img, state.sample) : null;
      if (!rep) continue;
      pc.box.rgb = rep.rgb;
      pc.box.coverage = rep.coverage;
    }
    if (palette) {
      pc.box.matches = match(pc.box.rgb, palette, 3);
      pc.box.paletteId = state.paletteId;
    }
  }
  renderPieces();
  renderExport();
  persist();
  if (!opt.quiet) toast('색코드를 뽑았습니다.');
}

function renderPieces() {
  const wrap = $('#piece-list');
  const pieces = allPieces();
  $('#piece-count').textContent = pieces.length ? `${pieces.length}조각` : '아직 없음';
  wrap.textContent = '';
  if (!pieces.length) {
    wrap.append(el('div', { class: 'empty' }, [
      el('span', { class: 'big', text: '✂️' }),
      el('p', { text: '자르기 화면에서 빨간선을 찾거나, 직접 그려 주세요.' }),
    ]));
    return;
  }

  pieces.forEach((pc, i) => {
    const { box } = pc;
    const thumb = makeCanvas(1, 1);
    const src = cropCanvas(pc.photo.bitmap, box);
    const s = Math.min(1, 132 / Math.max(src.width, src.height));
    thumb.width = Math.max(1, Math.round(src.width * s));
    thumb.height = Math.max(1, Math.round(src.height * s));
    const tctx = thumb.getContext('2d');
    tctx.imageSmoothingEnabled = true;
    tctx.drawImage(src, 0, 0, thumb.width, thumb.height);
    thumb.className = 'thumb';

    const hex = box.rgb ? rgbToHex(...box.rgb) : null;
    const chips = (box.matches || []).map((m, mi) => el('button', {
      class: `chip${mi === 0 ? ' best' : ''}`,
      type: 'button',
      title: `${m.name} · 차이 ΔE ${m.de.toFixed(1)} (${deltaEWord(m.de)})`,
      onclick: () => {
        box.label = m.code;
        renderPieces();
        requestDraw();
        persist();
      },
    }, [
      el('span', { class: 'chip-dot', style: { background: m.hex } }),
      el('b', { text: m.code }),
      el('small', { text: `ΔE ${m.de.toFixed(1)}` }),
    ]));

    const card = el('div', { class: `piece${state.selected === box.id ? ' on' : ''}` }, [
      el('div', {
        class: 'piece-thumb',
        onclick: () => {
          state.current = state.photos.indexOf(pc.photo);
          state.selected = box.id;
          goTab('cut');
          fitView();
          renderPieces();
        },
      }, [thumb, el('span', { class: 'piece-no', text: String(i + 1) })]),
      el('div', { class: 'piece-body' }, [
        el('div', { class: 'row tight' }, [
          el('input', {
            class: 'label-input',
            value: box.label || '',
            placeholder: '번호·이름 (예: 310)',
            oninput: (e) => { box.label = e.target.value; requestDraw(); },
            onchange: () => persist(),
          }),
        ]),
        hex ? el('div', { class: 'row tight swatch-row' }, [
          el('span', { class: 'swatch', style: { background: hex, color: readableInk(...box.rgb) }, text: hex }),
          el('button', {
            class: 'mini', type: 'button', text: '스포이드',
            title: '실 한가운데를 눌러 그 자리 색을 그대로 씁니다',
            onclick: () => startEyedrop(pc),
          }),
        ]) : el('p', { class: 'muted small', text: '“색코드 뽑기”를 누르면 색을 읽습니다.' }),
        chips.length ? el('div', { class: 'chips' }, chips) : null,
        box.matches && box.matches[0]
          ? el('p', { class: 'muted small' }, [
            '가장 가까운 색 ',
            el('b', { text: box.matches[0].code }),
            ` · ${box.matches[0].hex} · ΔE ${box.matches[0].de.toFixed(1)} (${deltaEWord(box.matches[0].de)})`,
          ])
          : null,
        box.matches && box.matches[0] && box.matches[0].de > 6
          ? el('p', {
            class: 'muted small',
            text: '이 책자에는 이만큼 비슷한 색이 없습니다. 다른 책자를 넣어 보세요.',
          })
          : null,
        el('div', { class: 'row tight actions' }, [
          el('button', { class: 'mini', type: 'button', text: '↑', title: '앞으로', onclick: () => movePiece(pc, -1) }),
          el('button', { class: 'mini', type: 'button', text: '↓', title: '뒤로', onclick: () => movePiece(pc, 1) }),
          el('button', { class: 'mini', type: 'button', text: '저장', onclick: () => savePiece(pc, i) }),
          el('button', { class: 'mini danger', type: 'button', text: '삭제', onclick: () => removePiece(pc) }),
        ]),
      ]),
    ]);
    wrap.append(card);
  });
}

function movePiece(pc, delta) {
  const list = pc.photo.boxes;
  const i = list.indexOf(pc.box);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return;
  list.splice(j, 0, list.splice(i, 1)[0]);
  state.sortMode = 'manual';
  $('#sort-mode').value = 'manual';
  saveSettings();
  renderPieces();
  requestDraw();
  persist();
}

function removePiece(pc) {
  pc.photo.boxes = pc.photo.boxes.filter((b) => b.id !== pc.box.id);
  if (state.selected === pc.box.id) state.selected = null;
  renderAll();
  persist();
}

let eyedrop = null;
function startEyedrop(pc) {
  eyedrop = pc;
  state.current = state.photos.indexOf(pc.photo);
  state.selected = pc.box.id;
  goTab('cut');
  fitView();
  toast('실 한가운데를 눌러 주세요.');
  const once = (e) => {
    stage.removeEventListener('click', once);
    if (!eyedrop) return;
    const img = toImage(e.offsetX, e.offsetY);
    const region = readRegion(pc.photo, {
      x: img.x - 4, y: img.y - 4, w: 9, h: 9,
    }, 9);
    if (region) {
      pc.box.rgb = medianAround(region, region.width / 2, region.height / 2, 1);
      delete pc.box.matches;
      analyzeColors({ quiet: true });
      toast(`색을 ${rgbToHex(...pc.box.rgb)} 로 잡았습니다.`);
    }
    eyedrop = null;
  };
  stage.addEventListener('click', once);
}


/* ------------------------------------------------------------------ 책자 */

function renderBookSelect() {
  fillPaletteOptions($('#book-sel'));
  renderPaletteSelect();
}

async function renderBook() {
  renderBookSelect();
  const palette = await ensurePalette();
  const info = $('#book-info');
  if (!palette) { info.textContent = '색상표를 불러오지 못했습니다.'; return; }
  const builtin = BUILTIN.find((b) => b.id === state.paletteId);
  info.textContent = builtin
    ? `${palette.name} · ${palette.colors.length}색. 앱에 처음부터 들어 있는 책자라 지울 수 없습니다.${builtin.id === 'ginkgo' ? ' 카드 사진에서 읽어 낸 값이라 실물과 조금 다를 수 있습니다.' : ''}`
    : `${palette.name} · ${palette.colors.length}색. 이 브라우저 안에만 저장됩니다. CSV 로 내보내 두면 안전합니다.`;
  renderBookColors();
}

function renderBookColors() {
  const wrap = $('#book-colors');
  wrap.textContent = '';
  const palette = state.palette;
  if (!palette) return;
  const q = $('#book-filter').value.trim().toLowerCase();
  const list = palette.colors
    .filter((c) => !q || c.code.toLowerCase().includes(q) || (c.name || '').toLowerCase().includes(q))
    .slice(0, 400);
  if (!list.length) {
    wrap.append(el('p', { class: 'muted small', text: q ? '찾는 번호가 없습니다.' : '아직 색이 없습니다. 아래에서 사진으로 채워 보세요.' }));
    return;
  }
  for (const c of list) {
    wrap.append(el('div', { class: 'swatch-cell', title: `${c.code} ${c.name || ''} ${c.hex}` }, [
      el('div', { class: 'fill', style: { background: c.hex } }),
      el('b', { text: c.code }),
      el('small', { text: c.hex }),
    ]));
  }
}

/** 번호를 적으면 그 실을 보여 줍니다. 사진이 있으면 사진 속 자리도 찾아 줍니다. */
async function lookupCode() {
  const box = $('#book-result');
  box.textContent = '';
  const code = $('#book-q').value.trim();
  if (!code) return;
  const palette = await ensurePalette();
  if (!palette) return;
  const found = findByCode(palette, code);
  if (!found) {
    box.append(el('p', { class: 'muted small', text: `${palette.name} 에 ${code} 번이 없습니다. 아래에서 카드 사진으로 채워 넣어 주세요.` }));
    return;
  }
  box.append(el('div', { class: 'found' }, [
    el('div', { class: 'fill', style: { background: found.hex } }),
    el('div', { class: 'grow' }, [
      el('b', { text: `${found.code}${found.name ? ` · ${found.name}` : ''}` }),
      el('p', { class: 'muted small', text: `${found.hex}${found.ko ? ` · ${found.ko}` : ''} · ${palette.name}` }),
    ]),
    photo() ? el('button', {
      class: 'mini', type: 'button', text: '사진에서 찾기', onclick: () => findInPhoto(found),
    }) : null,
  ]));
}

/** 책자 색과 가장 비슷한 실을 지금 사진에서 찾아 잘라 둡니다. */
async function findInPhoto(color) {
  const p = photo();
  if (!p) return null;
  if (!p.boxes.length) detect();
  await analyzeColors({ quiet: true });
  const pieces = allPieces().filter((pc) => pc.box.rgb);
  if (!pieces.length) {
    toast('사진에서 자를 곳을 먼저 잡아 주세요.', 'bad');
    return null;
  }
  let best = null;
  for (const pc of pieces) {
    const de = match(pc.box.rgb, { colors: [color] }, 1)[0].de;
    if (!best || de < best.de) best = { pc, de };
  }
  state.current = state.photos.indexOf(best.pc.photo);
  state.selected = best.pc.box.id;
  if (!best.pc.box.label) best.pc.box.label = color.code;
  renderAll();
  goTab('cut');
  const message = `${color.code} 와 가장 비슷한 조각을 골랐습니다 (${best.pc.index + 1}번, 차이 ΔE ${best.de.toFixed(1)}).`;
  toast(message);
  return message;
}

/** 카드 사진에서 실타래를 모두 찾습니다. */
function scanHanks() {
  const p = photo();
  if (!p) { toast('카드 사진을 먼저 불러오세요.', 'bad'); return; }
  const { data, scale } = analysisImageData(p);
  const found = findHanks(data, { bottom: 'band' });
  if (!found.hanks.length) {
    $('#book-scan-info').textContent = '타래를 찾지 못했습니다.';
    toast('타래를 찾지 못했습니다. 번호 줄과 실이 함께 나오게 찍어 주세요.', 'bad');
    return;
  }
  state.scan = {
    photo: p,
    items: found.hanks.map((hk) => ({
      box: {
        x: Math.round(hk.x / scale),
        y: Math.round(hk.y / scale),
        w: Math.round(hk.w / scale),
        h: Math.round(hk.h / scale),
      },
      code: '',
      rgb: null,
    })),
  };
  for (const item of state.scan.items) {
    const img = readRegion(p, item.box, 160);
    const rep = img ? representativeColor(img, state.sample) : null;
    item.rgb = rep ? rep.rgb : null;
  }
  $('#book-scan-info').textContent = `${state.scan.items.length}개 찾음`;
  $('#book-add').disabled = false;
  renderHanks();
  applyPastedCodes();
}

function renderHanks() {
  const wrap = $('#book-hanks');
  wrap.textContent = '';
  if (!state.scan) return;
  state.scan.items.forEach((item, i) => {
    // 타래는 아주 길쭉하므로 위쪽만 보여 줍니다(색을 확인하기에는 충분합니다).
    const shown = {
      ...item.box,
      h: Math.max(8, Math.min(item.box.h, Math.round(item.box.w * 1.5))),
    };
    const src = cropCanvas(state.scan.photo.bitmap, shown);
    const c = makeCanvas(72, Math.max(24, Math.round((72 * src.height) / src.width)));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(src, 0, 0, c.width, c.height);
    wrap.append(el('div', { class: 'hank' }, [
      c,
      el('div', { class: 'dot', style: { background: item.rgb ? rgbToHex(...item.rgb) : 'transparent' } }),
      el('input', {
        value: item.code,
        placeholder: `${i + 1}번`,
        oninput: (e) => { item.code = e.target.value.trim(); },
      }),
    ]));
  });
}

/** 붙여넣은 번호를 왼쪽부터 차례로 나눠 줍니다. */
function applyPastedCodes() {
  if (!state.scan) return;
  const codes = $('#book-codes').value.split(/[\s,、·]+/).map((v) => v.trim()).filter(Boolean);
  if (!codes.length) return;
  state.scan.items.forEach((item, i) => { item.code = codes[i] || ''; });
  renderHanks();
  const extra = codes.length - state.scan.items.length;
  $('#book-scan-info').textContent = extra === 0
    ? `${state.scan.items.length}개 · 번호도 ${codes.length}개, 딱 맞습니다`
    : `${state.scan.items.length}개 · 번호는 ${codes.length}개 (${extra > 0 ? `${extra}개 남음` : `${-extra}개 모자람`})`;
}

async function addScanToBook() {
  if (!state.scan) return;
  if (BUILTIN.some((b) => b.id === state.paletteId)) {
    toast('처음부터 들어 있는 책자에는 넣을 수 없습니다. 새 책자를 만들어 주세요.', 'bad');
    return;
  }
  const colors = state.scan.items
    .filter((item) => item.code && item.rgb)
    .map((item) => ({ code: item.code, name: '', hex: rgbToHex(...item.rgb) }));
  if (!colors.length) {
    toast('번호를 적은 타래가 없습니다.', 'bad');
    return;
  }
  const result = upsertColors(state.paletteId, colors);
  state.palette = null;
  await renderBook();
  saveSettings();
  toast(`${result.added}개 넣고 ${result.updated}개 고쳤습니다.`);
}

/* ------------------------------------------------------------------ 내보내기 */

function safeName(text) {
  return String(text || '').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40);
}

async function savePiece(pc, index) {
  const canvas = cropCanvas(pc.photo.bitmap, pc.box);
  const blob = await canvasToBlob(canvas);
  const n = String(index + 1).padStart(2, '0');
  return saveFile(blob, `${n}${pc.box.label ? `_${safeName(pc.box.label)}` : ''}.png`);
}

async function saveAllPieces() {
  const pieces = allPieces();
  if (!pieces.length) { toast('저장할 조각이 없습니다.', 'bad'); return; }
  toast(`${pieces.length}장을 한 장씩 저장합니다…`);
  let saved = 0;
  for (let i = 0; i < pieces.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await savePiece(pieces[i], i);
    if (result === 'declined') { toast('저장을 멈췄습니다.'); return; }
    if (result === 'saved') saved += 1;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 260));
  }
  toast(`${saved}장을 저장했습니다.`);
}

function buildSheet() {
  const pieces = allPieces();
  if (!pieces.length) return null;
  const items = pieces.map((pc, i) => {
    const canvas = cropCanvas(pc.photo.bitmap, pc.box);
    const code = pc.box.matches && pc.box.matches[0] ? pc.box.matches[0].code : '';
    let label = '';
    let sub = '';
    if (state.out.label === 'order') label = `${i + 1}`;
    else if (state.out.label === 'name') label = pc.box.label || `${i + 1}`;
    else if (state.out.label === 'code') label = code || pc.box.label || `${i + 1}`;
    else if (state.out.label === 'both') {
      label = pc.box.label || `${i + 1}`;
      sub = code && code !== pc.box.label ? `≈ ${code}` : '';
    }
    return { canvas, label, sub };
  });
  const dark = ['#000000', '#111111', 'transparent'].includes(state.out.bg);
  return stitch(items, {
    layout: state.out.layout,
    columns: Number(state.out.columns) || 4,
    gap: Number(state.out.gap) || 0,
    pad: Number(state.out.gap) || 0,
    bg: state.out.bg,
    label: state.out.label !== 'none',
    labelH: state.out.label === 'both' ? 44 : 30,
    ink: dark ? '#f2f4f8' : '#14181f',
  });
}

let previewUrl = null;

async function renderExport() {
  const holder = $('#sheet-preview');
  holder.textContent = '';
  const pieces = allPieces();
  $('#out-count').textContent = pieces.length ? `${pieces.length}조각` : '조각 없음';
  if (!pieces.length) {
    holder.append(el('p', { class: 'muted', text: '자른 조각이 없습니다.' }));
    return;
  }
  const sheet = buildSheet();
  if (!sheet) return;
  const note = el('p', {
    class: 'muted small',
    text: `이어붙인 크기 ${sheet.width} × ${sheet.height} 픽셀 · 그림을 길게 눌러도 저장됩니다.`,
  });
  // 캔버스 대신 그림으로 보여 주면 길게 눌러 저장할 수 있습니다. 픽셀은 그대로입니다.
  const blob = await canvasToBlob(sheet);
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(blob);
  holder.textContent = '';
  holder.append(el('img', {
    class: 'sheet-canvas',
    src: previewUrl,
    alt: '이어붙인 실 조각 미리보기',
    width: sheet.width,
    height: sheet.height,
  }), note);
}

async function saveSheet() {
  const sheet = buildSheet();
  if (!sheet) { toast('조각이 없습니다.', 'bad'); return; }
  const blob = await canvasToBlob(sheet);
  const result = await saveFile(blob, `실_정렬_${new Date().toISOString().slice(0, 10)}.png`);
  if (result === 'failed') toast('저장하지 못했습니다. 미리보기를 길게 눌러 저장해 보세요.', 'bad');
}

function codeTable() {
  const pieces = allPieces();
  const name = state.palette ? state.palette.name : '';
  const head = ['순서', '내가 적은 번호', '사진에서 읽은 색', `${name} 1순위`, '이름', 'ΔE', '2순위', '3순위'];
  const rows = pieces.map((pc, i) => {
    const m = pc.box.matches || [];
    return [
      i + 1,
      pc.box.label || '',
      pc.box.rgb ? rgbToHex(...pc.box.rgb) : '',
      m[0] ? m[0].code : '',
      m[0] ? m[0].name : '',
      m[0] ? m[0].de.toFixed(2) : '',
      m[1] ? `${m[1].code} (ΔE ${m[1].de.toFixed(1)})` : '',
      m[2] ? `${m[2].code} (ΔE ${m[2].de.toFixed(1)})` : '',
    ];
  });
  return { head, rows };
}

function tableToCsv() {
  const { head, rows } = codeTable();
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  return [head, ...rows].map((r) => r.map(q).join(',')).join('\r\n');
}

function tableToText() {
  const { rows } = codeTable();
  return rows
    .map((r) => `${r[0]}. ${r[1] || '-'}  ${r[2]}  →  ${r[3] || '?'} ${r[4] || ''}`.trim())
    .join('\n');
}

/* ------------------------------------------------------------- 책자(색상표) */

function fillPaletteOptions(sel) {
  sel.textContent = '';
  for (const b of BUILTIN) sel.append(el('option', { value: b.id, text: `${b.name} · ${b.count}색` }));
  for (const p of loadCustomList()) {
    sel.append(el('option', { value: p.id, text: `${p.name} · ${p.colors.length}색` }));
  }
  sel.value = state.paletteId;
  if (sel.value !== state.paletteId) {
    state.paletteId = BUILTIN[0].id;
    sel.value = state.paletteId;
  }
}

function renderPaletteSelect() {
  fillPaletteOptions($('#palette-sel'));
}

async function addPalette(file) {
  try {
    const text = await file.text();
    const parsed = parsePaletteText(text, file.name.replace(/\.[^.]+$/, ''));
    const list = loadCustomList();
    const id = `c${Date.now().toString(36)}`;
    list.push({ id, name: parsed.name, colors: parsed.colors });
    saveCustomList(list);
    state.paletteId = id;
    state.palette = null;
    renderPaletteSelect();
    saveSettings();
    for (const p of state.photos) for (const b of p.boxes) delete b.matches;
    await analyzeColors({ quiet: true });
    toast(`${parsed.name} 색상표 ${parsed.colors.length}색을 넣었습니다.`);
  } catch (e) {
    toast(e.message || '색상표를 읽지 못했습니다.', 'bad');
  }
}

/* ------------------------------------------------------------------ 저장·복원 */

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    if (!$('#opt-remember').checked) {
      await db.del('session');
      return;
    }
    await db.set('session', {
      photos: state.photos.map((p) => ({
        id: p.id, name: p.name, blob: p.blob, boxes: p.boxes,
      })),
      current: state.current,
    });
  }, 500);
}

async function restore() {
  const saved = await db.get('session');
  if (!saved || !Array.isArray(saved.photos) || !saved.photos.length) return;
  for (const sp of saved.photos) {
    try {
      const bitmap = await decodeImage(sp.blob);
      state.photos.push({
        id: sp.id, name: sp.name, blob: sp.blob, bitmap, boxes: sp.boxes || [], words: null,
      });
    } catch (e) { /* 못 여는 사진은 건너뜁니다 */ }
  }
  state.current = Math.min(saved.current || 0, Math.max(0, state.photos.length - 1));
  let maxId = 0;
  for (const p of state.photos) {
    for (const b of p.boxes) {
      const n = Number(String(b.id).replace('b', ''));
      if (Number.isFinite(n)) maxId = Math.max(maxId, n);
    }
  }
  nextId = maxId + 1;
}

/* ------------------------------------------------------------------ 화면 묶기 */

function renderPhotos() {
  const strip = $('#photo-strip');
  strip.textContent = '';
  strip.hidden = state.photos.length < 1;
  state.photos.forEach((p, i) => {
    const c = makeCanvas(56, 56);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    const s = Math.min(56 / p.bitmap.width, 56 / p.bitmap.height);
    const w = p.bitmap.width * s;
    const h = p.bitmap.height * s;
    ctx.drawImage(p.bitmap, (56 - w) / 2, (56 - h) / 2, w, h);
    strip.append(el('button', {
      class: `photo-chip${i === state.current ? ' on' : ''}`,
      type: 'button',
      title: p.name,
      onclick: () => {
        state.current = i;
        state.selected = null;
        fitView();
        renderAll();
      },
    }, [c, el('span', { class: 'badge', text: String(p.boxes.length) })]));
  });

  const list = $('#photo-list');
  list.textContent = '';
  state.photos.forEach((p, i) => {
    list.append(el('div', { class: 'row photo-row' }, [
      el('span', { class: 'grow', text: `${i + 1}. ${p.name}` }),
      el('span', { class: 'muted small', text: `${p.bitmap.width}×${p.bitmap.height}` }),
      el('button', {
        class: 'mini danger',
        type: 'button',
        text: '빼기',
        onclick: async () => {
          if (await confirmSheet('이 사진을 뺄까요?', '잡아 둔 자르기 상자도 함께 사라집니다.', '빼기')) removePhoto(i);
        },
      }),
    ]));
  });
  $('#photo-empty').hidden = state.photos.length > 0;
}

function renderAll() {
  renderPhotos();
  renderPieces();
  renderExport();
  requestDraw();
  const p = photo();
  $('#subtitle').textContent = p
    ? `${p.bitmap.width}×${p.bitmap.height} · ${p.boxes.length}군데`
    : '사진을 불러오세요';
}

function goTab(tab) {
  state.tab = tab;
  for (const pane of $$('.pane')) pane.hidden = pane.dataset.pane !== tab;
  for (const btn of $$('.tabbar button')) btn.classList.toggle('on', btn.dataset.tab === tab);
  if (tab === 'cut') {
    requestAnimationFrame(() => {
      resizeStage();
      if (!photo()) return;
      if (view.dirty) fitView();
      requestDraw();
    });
  }
  if (tab === 'out') renderExport();
  if (tab === 'book') renderBook();
}

/* ------------------------------------------------------------------ 시작 */

function bindControls() {
  $('#file-input').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('#camera-input').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });

  const drop = $('#drop');
  for (const ev of ['dragenter', 'dragover']) {
    document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  }
  for (const ev of ['dragleave', 'drop']) {
    document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  }
  document.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
  document.addEventListener('paste', (e) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length) addFiles(files);
  });

  for (const btn of $$('.tabbar button')) btn.addEventListener('click', () => goTab(btn.dataset.tab));
  for (const btn of $$('.seg button')) {
    btn.addEventListener('click', () => {
      state.tool = btn.dataset.tool;
      for (const b of $$('.seg button')) b.classList.toggle('on', b === btn);
      stage.classList.toggle('drawing', state.tool === 'draw');
    });
  }

  $('#btn-detect').addEventListener('click', detect);
  $('#btn-fit').addEventListener('click', fitView);
  $('#btn-clear').addEventListener('click', async () => {
    const p = photo();
    if (!p || !p.boxes.length) return;
    if (await confirmSheet('이 사진의 상자를 모두 지울까요?', null, '지우기')) {
      p.boxes = [];
      state.selected = null;
      renderAll();
      persist();
    }
  });
  $('#btn-find').addEventListener('click', findByNumber);
  $('#q-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') findByNumber(); });

  bindNumber('#s-strength', state.detect, 'strength', '#v-strength', (v) => v.toFixed(1));
  bindNumber('#s-join', state.detect, 'join', '#v-join', (v) => `${(v * 100).toFixed(1)}%`);
  bindNumber('#s-pad', state.detect, 'pad', '#v-pad', (v) => `${Math.round(v * 100)}%`);
  bindNumber('#s-band', state.detect, 'band', '#v-band', (v) => `${Math.round(v * 100)}%`);
  bindNumber('#s-width', state.detect, 'width', '#v-width', (v) => `${Math.round(v * 100)}%`);
  bindSelect('#s-mode', state.detect, 'mode');
  bindSelect('#s-side', state.detect, 'side');
  bindCheck('#s-solid', state.detect, 'ignoreSolid');
  bindCheck('#s-trim', state.detect, 'trim');
  bindSelect('#f-dir', state.find, 'dir');
  bindNumber('#f-size', state.find, 'size', '#v-size', (v) => `${v.toFixed(1)}배`);

  $('#sort-mode').addEventListener('change', (e) => {
    state.sortMode = e.target.value;
    resort();
    saveSettings();
    renderAll();
    persist();
  });
  $('#palette-sel').addEventListener('change', async (e) => {
    state.paletteId = e.target.value;
    state.palette = null;
    saveSettings();
    for (const p of state.photos) for (const b of p.boxes) delete b.matches;
    renderBookSelect();
    await analyzeColors({ quiet: true });
  });
  $('#palette-file').addEventListener('change', (e) => {
    if (e.target.files[0]) addPalette(e.target.files[0]);
    e.target.value = '';
  });
  $('#btn-analyze').addEventListener('click', () => analyzeColors());
  $('#btn-palette-del').addEventListener('click', async () => {
    if (BUILTIN.some((b) => b.id === state.paletteId)) { toast('처음부터 들어 있는 책자는 지울 수 없습니다.'); return; }
    if (!await confirmSheet('이 색상표를 지울까요?', null, '지우기')) return;
    saveCustomList(loadCustomList().filter((p) => p.id !== state.paletteId));
    state.paletteId = 'dmc';
    state.palette = null;
    renderPaletteSelect();
    saveSettings();
    await analyzeColors({ quiet: true });
  });

  for (const key of ['layout', 'columns', 'gap', 'label', 'bg']) {
    const node = $(`#o-${key}`);
    node.addEventListener('input', () => {
      state.out[key] = node.type === 'range' || node.type === 'number' ? Number(node.value) : node.value;
      if (key === 'gap') $('#v-gap').textContent = `${state.out.gap}px`;
      saveSettings();
      renderExport();
    });
  }
  $('#btn-save-all').addEventListener('click', saveAllPieces);
  $('#btn-save-sheet').addEventListener('click', saveSheet);
  $('#btn-copy-csv').addEventListener('click', async () => {
    toast(await copyText(tableToCsv()) ? 'CSV 를 복사했습니다.' : '복사하지 못했습니다.', '');
  });
  $('#btn-copy-text').addEventListener('click', async () => {
    toast(await copyText(tableToText()) ? '목록을 복사했습니다.' : '복사하지 못했습니다.', '');
  });
  $('#btn-save-csv').addEventListener('click', async () => {
    const blob = new Blob(['﻿', tableToCsv()], { type: 'text/csv;charset=utf-8' });
    if (await saveFile(blob, '실_색코드.csv') === 'failed') toast('저장하지 못했습니다.', 'bad');
  });

  $('#book-find').addEventListener('click', lookupCode);
  $('#book-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') lookupCode(); });
  $('#book-sel').addEventListener('change', async (e) => {
    state.paletteId = e.target.value;
    state.palette = null;
    saveSettings();
    for (const p of state.photos) for (const b of p.boxes) delete b.matches;
    await renderBook();
    await analyzeColors({ quiet: true });
  });
  $('#book-new').addEventListener('click', async () => {
    const name = await promptSheet('새 책자 이름', '예: 앨리스(亚丽丝), 은행나무(银杏)', '앨리스');
    if (!name) return;
    state.paletteId = createCustom(name);
    state.palette = null;
    saveSettings();
    await renderBook();
    toast(`${name} 책자를 만들었습니다. 카드 사진으로 채워 보세요.`);
  });
  $('#book-file').addEventListener('change', (e) => {
    if (e.target.files[0]) addPalette(e.target.files[0]).then(renderBook);
    e.target.value = '';
  });
  $('#book-csv').addEventListener('click', async () => {
    const palette = await ensurePalette();
    if (!palette) return;
    const blob = new Blob(['\ufeff', toCsv(palette)], { type: 'text/csv;charset=utf-8' });
    if (await saveFile(blob, `${safeName(palette.name) || '책자'}.csv`) === 'failed') toast('저장하지 못했습니다.', 'bad');
  });
  $('#book-del').addEventListener('click', async () => {
    if (BUILTIN.some((b) => b.id === state.paletteId)) { toast('처음부터 들어 있는 책자는 지울 수 없습니다.'); return; }
    if (!await confirmSheet('이 책자를 지울까요?', '넣어 둔 색이 모두 사라집니다.', '지우기')) return;
    saveCustomList(loadCustomList().filter((p) => p.id !== state.paletteId));
    state.paletteId = 'dmc';
    state.palette = null;
    saveSettings();
    await renderBook();
  });
  $('#book-scan').addEventListener('click', scanHanks);
  $('#book-add').addEventListener('click', addScanToBook);
  $('#book-codes').addEventListener('input', applyPastedCodes);
  $('#book-filter').addEventListener('input', renderBookColors);

  $('#opt-remember').addEventListener('change', (e) => {
    try { localStorage.setItem('floss.remember', e.target.checked ? '1' : '0'); } catch (err) { /* 저장 막힘 */ }
    persist();
  });
  $('#btn-reset').addEventListener('click', async () => {
    if (!await confirmSheet('처음 상태로 되돌릴까요?', '불러온 사진과 자른 상자가 모두 사라집니다.', '되돌리기')) return;
    for (const p of state.photos) if (p.bitmap && p.bitmap.close) p.bitmap.close();
    state.photos = [];
    state.current = 0;
    state.selected = null;
    await db.del('session');
    renderAll();
    goTab('photo');
  });

  $('#btn-theme').addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(getTheme()) + 1) % order.length];
    setTheme(next);
    $('#btn-theme').textContent = next === 'auto' ? '🌗' : (next === 'light' ? '☀️' : '🌙');
  });

  window.addEventListener('resize', () => {
    resizeStage();
    if (state.tab === 'cut') requestDraw();
  });
}

function bindNumber(sel, target, key, valueSel, format) {
  const node = $(sel);
  node.value = target[key];
  const show = () => { if (valueSel) $(valueSel).textContent = format(Number(node.value)); };
  show();
  node.addEventListener('input', () => {
    target[key] = Number(node.value);
    show();
    saveSettings();
  });
}

function bindCheck(sel, target, key) {
  const node = $(sel);
  node.checked = !!target[key];
  node.addEventListener('change', () => {
    target[key] = node.checked;
    saveSettings();
  });
}

function bindSelect(sel, target, key) {
  const node = $(sel);
  node.value = target[key];
  node.addEventListener('change', () => {
    target[key] = node.value;
    saveSettings();
  });
}

function fillSortSelect() {
  const sel = $('#sort-mode');
  sel.textContent = '';
  for (const [value, text] of Object.entries(SORT_LABELS)) sel.append(el('option', { value, text }));
  sel.value = state.sortMode;
}

async function main() {
  loadSettings();
  setTheme(getTheme());
  $('#btn-theme').textContent = getTheme() === 'auto' ? '🌗' : (getTheme() === 'light' ? '☀️' : '🌙');

  stage = $('#stage');
  stageCtx = stage.getContext('2d');

  fillSortSelect();
  renderPaletteSelect();
  bindControls();
  bindStage();

  let remember = true;
  try { remember = localStorage.getItem('floss.remember') !== '0'; } catch (e) { /* 막힘 */ }
  $('#opt-remember').checked = remember;

  for (const key of ['layout', 'columns', 'gap', 'label', 'bg']) $(`#o-${key}`).value = state.out[key];
  $('#v-gap').textContent = `${state.out.gap}px`;

  if (remember) await restore();
  resizeStage();
  fitView();
  renderAll();
  goTab(state.photos.length ? 'cut' : 'photo');

  ensurePalette();

  if ('serviceWorker' in navigator && !globalThis.__FLOSS_STANDALONE__) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* 오프라인 기능만 빠집니다 */ });
  }
}

main();
