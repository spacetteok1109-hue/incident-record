/* crop.js — 잘라내기 · 순서 정렬 · 이어붙이기
   실 색을 지키기 위한 규칙:
   1) 자를 때 크기를 바꾸지 않습니다(1:1 복사).
   2) 부드럽게 하기(보간)를 끕니다.
   3) 저장은 무손실 PNG 로만 합니다. JPEG 은 색이 미세하게 흔들립니다.
   4) 필터·보정·투명도 합성을 전혀 쓰지 않습니다. */

/** 색 관리가 끼어들지 않도록 sRGB 로 고정한 캔버스 */
export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function context2d(canvas, opts = {}) {
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: !!opts.read });
  ctx.imageSmoothingEnabled = false;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  return ctx;
}

/** 원본에서 상자 하나를 1:1 로 떠냅니다. */
export function cropCanvas(source, box) {
  const x = Math.max(0, Math.round(box.x));
  const y = Math.max(0, Math.round(box.y));
  const w = Math.max(1, Math.min(Math.round(box.w), source.width - x));
  const h = Math.max(1, Math.min(Math.round(box.h), source.height - y));
  const c = makeCanvas(w, h);
  const ctx = context2d(c);
  ctx.drawImage(source, x, y, w, h, 0, 0, w, h);
  return c;
}

export function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/* ------------------------------------------------------------------ 정렬 */

/**
 * 상자를 사람이 읽는 순서로 줄 세웁니다.
 *  'reading' 위→아래 줄 단위, 줄 안에서는 왼→오른쪽 (기본)
 *  'column'  왼→오른쪽 칸 단위, 칸 안에서는 위→아래
 *  'top' 위에서 아래로만 / 'left' 왼쪽에서 오른쪽으로만
 *  'manual'  손으로 정한 순서 그대로
 */
export function sortBoxes(boxes, mode) {
  const list = boxes.slice();
  if (mode === 'manual') return list;
  if (mode === 'top') return list.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  if (mode === 'left') return list.sort((a, b) => (a.x - b.x) || (a.y - b.y));

  const vertical = mode === 'column';
  const sizes = list.map((b) => (vertical ? b.w : b.h)).sort((a, b) => a - b);
  const mid = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 1;
  const tol = Math.max(8, mid * 0.6);

  const lanes = [];
  const byMain = list.slice().sort((a, b) => (vertical ? a.x - b.x : a.y - b.y));
  for (const b of byMain) {
    const start = vertical ? b.x : b.y;
    const lane = lanes.find((l) => Math.abs(l.at - start) <= tol);
    if (lane) {
      lane.items.push(b);
      lane.at = (lane.at * (lane.items.length - 1) + start) / lane.items.length;
    } else lanes.push({ at: start, items: [b] });
  }
  lanes.sort((a, b) => a.at - b.at);
  const out = [];
  for (const lane of lanes) {
    lane.items.sort((a, b) => (vertical ? a.y - b.y : a.x - b.x));
    out.push(...lane.items);
  }
  return out;
}

export const SORT_LABELS = {
  reading: '가로줄 순서 (위→아래, 왼→오른쪽)',
  column: '세로줄 순서 (왼→오른쪽, 위→아래)',
  top: '위에서 아래로',
  left: '왼쪽에서 오른쪽으로',
  manual: '내가 정한 순서',
};

/* -------------------------------------------------------------- 이어붙이기 */

/**
 * 잘라낸 조각들을 한 장으로 이어붙입니다.
 * 조각은 절대 늘이거나 줄이지 않고, 남는 자리는 배경색으로 채웁니다.
 * 글자(번호·색코드)는 조각 바깥의 라벨 칸에만 그려서 실 픽셀을 건드리지 않습니다.
 *
 * @param {Array<{canvas:HTMLCanvasElement,label:string,sub:string}>} items
 * @param {object} opt layout('row'|'column'|'grid') gap bg columns label labelH
 */
export function stitch(items, opt) {
  const gap = Math.max(0, Math.round(opt.gap ?? 12));
  const pad = Math.max(0, Math.round(opt.pad ?? gap));
  const showLabel = !!opt.label;
  const labelH = showLabel ? Math.max(18, Math.round(opt.labelH ?? 34)) : 0;
  const cells = items.map((it) => ({
    it, w: it.canvas.width, h: it.canvas.height + labelH,
  }));

  let cols;
  if (opt.layout === 'row') cols = cells.length;
  else if (opt.layout === 'column') cols = 1;
  else cols = Math.max(1, Math.min(opt.columns || Math.ceil(Math.sqrt(cells.length)), cells.length));
  const rows = Math.ceil(cells.length / cols) || 1;

  const colW = new Array(cols).fill(0);
  const rowH = new Array(rows).fill(0);
  cells.forEach((c, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    colW[col] = Math.max(colW[col], c.w);
    rowH[row] = Math.max(rowH[row], c.h);
  });

  const width = pad * 2 + colW.reduce((a, b) => a + b, 0) + gap * (cols - 1);
  const height = pad * 2 + rowH.reduce((a, b) => a + b, 0) + gap * (rows - 1);
  const canvas = makeCanvas(width, height);
  const ctx = context2d(canvas);

  if (opt.bg && opt.bg !== 'transparent') {
    ctx.fillStyle = opt.bg;
    ctx.fillRect(0, 0, width, height);
  }

  const xs = [];
  let acc = pad;
  for (let i = 0; i < cols; i += 1) { xs.push(acc); acc += colW[i] + gap; }
  const ys = [];
  acc = pad;
  for (let i = 0; i < rows; i += 1) { ys.push(acc); acc += rowH[i] + gap; }

  cells.forEach((c, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    // 칸 안에서 가운데 정렬 (크기는 그대로)
    const x = Math.round(xs[col] + (colW[col] - c.w) / 2);
    const y = Math.round(ys[row] + (rowH[row] - c.h) / 2);
    ctx.drawImage(c.it.canvas, x, y);
    if (showLabel) {
      const ly = y + c.it.canvas.height;
      ctx.fillStyle = opt.ink || '#111111';
      const size = Math.max(11, Math.round(labelH * 0.46));
      ctx.font = `600 ${size}px system-ui, -apple-system, "Noto Sans KR", sans-serif`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'center';
      const cx = x + c.it.canvas.width / 2;
      ctx.fillText(c.it.label || '', cx, ly + 3, colW[col]);
      if (c.it.sub) {
        ctx.font = `400 ${Math.max(10, size - 3)}px system-ui, -apple-system, "Noto Sans KR", sans-serif`;
        ctx.globalAlpha = 0.72;
        ctx.fillText(c.it.sub, cx, ly + 5 + size, colW[col]);
        ctx.globalAlpha = 1;
      }
    }
  });

  return canvas;
}
