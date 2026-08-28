/* detect.js — 사진에서 빨간선을 찾아 자를 영역을 계산합니다.
   원본 픽셀은 읽기만 하고 절대 고치지 않습니다. */

import { isRedPixel } from './color.js';

/** 분석은 작은 사본에서 하고, 결과 좌표만 원본 크기로 되돌립니다. */
export const ANALYSIS_MAX = 1400;

/**
 * 빨간 픽셀 지도를 만듭니다.
 * @returns {Uint8Array} 0/1 마스크
 */
export function buildRedMask(imageData, strength) {
  const { data, width: w, height: h } = imageData;
  const mask = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < mask.length; i += 1, p += 4) {
    if (data[p + 3] < 32) continue;
    if (isRedPixel(data[p], data[p + 1], data[p + 2], strength)) mask[i] = 1;
  }
  return mask;
}

/** 끊긴 선을 이어 붙이기 위해 마스크를 조금 부풀립니다(가로·세로 분리 처리). */
export function dilate(mask, w, h, radius) {
  if (radius <= 0) return mask;
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    let run = -1;
    for (let x = 0; x < w; x += 1) {
      if (mask[row + x]) run = x;
      if (run >= 0 && x - run <= radius) tmp[row + x] = 1;
    }
    run = -1;
    for (let x = w - 1; x >= 0; x -= 1) {
      if (mask[row + x]) run = x;
      if (run >= 0 && run - x <= radius) tmp[row + x] = 1;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x += 1) {
    let run = -1;
    for (let y = 0; y < h; y += 1) {
      if (tmp[y * w + x]) run = y;
      if (run >= 0 && y - run <= radius) out[y * w + x] = 1;
    }
    run = -1;
    for (let y = h - 1; y >= 0; y -= 1) {
      if (tmp[y * w + x]) run = y;
      if (run >= 0 && run - y <= radius) out[y * w + x] = 1;
    }
  }
  return out;
}

/** 이어진 빨간 덩어리를 하나씩 찾아냅니다. */
export function findBlobs(mask, w, h, minPixels) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const blobs = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    let top = 0;
    stack[top] = start;
    top += 1;
    seen[start] = 1;
    let count = 0;
    let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
    while (top > 0) {
      top -= 1;
      const idx = stack[top];
      const x = idx % w;
      const y = (idx - x) / w;
      count += 1;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = ny * w + nx;
          if (mask[n] && !seen[n]) {
            seen[n] = 1;
            stack[top] = n;
            top += 1;
          }
        }
      }
    }
    if (count >= minPixels) {
      blobs.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, pixels: count });
    }
  }
  return blobs;
}

/**
 * 덩어리 모양을 보고 어떤 표시인지 짐작합니다.
 *  - 'frame' : 네모/동그라미로 둘러친 표시  → 안쪽을 자릅니다
 *  - 'line'  : 길쭉한 줄                    → 줄 옆 띠를 자릅니다
 *  - 'mark'  : 작은 점·체크 표시            → 표시 둘레를 자릅니다
 */
export function classifyBlob(blob, w, h) {
  const fill = blob.pixels / (blob.w * blob.h);
  const long = Math.max(blob.w, blob.h);
  const short = Math.min(blob.w, blob.h);
  const bigEnough = blob.w >= w * 0.06 && blob.h >= h * 0.04;
  if (bigEnough && fill < 0.45) return 'frame';
  if (long >= short * 3.5 && long >= Math.min(w, h) * 0.08) return 'line';
  return 'mark';
}

/** 선 굵기를 대충 추정합니다(둘레 대비 픽셀 수). */
export function strokeWidth(blob) {
  const perimeter = 2 * (blob.w + blob.h);
  return Math.max(1, Math.min(Math.round(blob.pixels / Math.max(1, perimeter)), Math.min(blob.w, blob.h) / 3));
}

/** 네모 안의 평균 채도(색이 얼마나 짙은지). 종이 여백은 0 에 가깝습니다. */
export function regionChroma(imageData, rect) {
  const { data, width: w, height: h } = imageData;
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(w, Math.round(rect.x + rect.w));
  const y1 = Math.min(h, Math.round(rect.y + rect.h));
  if (x1 <= x0 || y1 <= y0) return -1;
  const step = Math.max(1, Math.round(Math.sqrt(((x1 - x0) * (y1 - y0)) / 3000)));
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const p = (y * w + x) * 4;
      const r = data[p];
      const g = data[p + 1];
      const b = data[p + 2];
      if (isRedPixel(r, g, b, 1)) continue; // 표시해 둔 빨간선은 빼고 봅니다
      sum += Math.max(r, g, b) - Math.min(r, g, b);
      n += 1;
    }
  }
  return n ? sum / n : -1;
}

function clampBox(b, w, h) {
  const x = Math.max(0, Math.round(b.x));
  const y = Math.max(0, Math.round(b.y));
  const x2 = Math.min(w, Math.round(b.x + b.w));
  const y2 = Math.min(h, Math.round(b.y + b.h));
  return { x, y, w: Math.max(1, x2 - x), h: Math.max(1, y2 - y) };
}

/**
 * 덩어리 하나를 자를 상자로 바꿉니다.
 * @param {object} opt
 *   mode    'auto' | 'inside' | 'outside' | 'band'
 *   pad     여백 비율(상자 크기 기준, 0.0~0.5)
 *   band    띠 두께 비율(짧은 변 기준)
 *   side    'both' | 'before' | 'after'  (띠를 선의 어느 쪽에 둘지)
 */
export function blobToBox(blob, w, h, opt) {
  const kind = opt.mode === 'auto' ? classifyBlob(blob, w, h) : opt.mode;
  const t = strokeWidth(blob);

  if (kind === 'frame' || kind === 'inside') {
    // 빨간 테두리 안쪽만. 선 굵기 + 1px 만큼 더 들어가서 빨강이 섞이지 않게 합니다.
    const inset = t + 1 + Math.round(Math.min(blob.w, blob.h) * opt.pad * 0.5);
    return clampBox({
      x: blob.x + inset, y: blob.y + inset, w: blob.w - inset * 2, h: blob.h - inset * 2,
    }, w, h);
  }

  if (kind === 'line' || kind === 'band') {
    const horizontal = blob.w >= blob.h;
    const thickness = Math.max(12, Math.round(Math.min(w, h) * opt.band));
    const grow = Math.round((horizontal ? blob.w : blob.h) * opt.pad);
    const side = opt.side === 'auto' ? pickSide(blob, horizontal, thickness, t, w, h, opt) : opt.side;
    if (horizontal) {
      const cy = blob.y + blob.h / 2;
      let top = cy - thickness / 2;
      let height = thickness;
      if (side === 'before') { top = blob.y - t - thickness; height = thickness; }
      if (side === 'after') { top = blob.y + blob.h + t; height = thickness; }
      return clampBox({ x: blob.x - grow, y: top, w: blob.w + grow * 2, h: height }, w, h);
    }
    const cx = blob.x + blob.w / 2;
    let left = cx - thickness / 2;
    if (side === 'before') left = blob.x - t - thickness;
    if (side === 'after') left = blob.x + blob.w + t;
    return clampBox({ x: left, y: blob.y - grow, w: thickness, h: blob.h + grow * 2 }, w, h);
  }

  // 작은 표시: 표시를 둘러싼 넉넉한 네모
  const grow = Math.max(8, Math.round(Math.max(blob.w, blob.h) * (0.5 + opt.pad)));
  return clampBox({
    x: blob.x - grow, y: blob.y - grow, w: blob.w + grow * 2, h: blob.h + grow * 2,
  }, w, h);
}

/** 줄 양옆 중 색이 더 짙은 쪽(=실이 있는 쪽)을 고릅니다. */
function pickSide(blob, horizontal, thickness, t, w, h, opt) {
  if (!opt.pixels) return 'both';
  const rectFor = (which) => {
    if (horizontal) {
      const top = which === 'before' ? blob.y - t - thickness : blob.y + blob.h + t;
      return { x: blob.x, y: top, w: blob.w, h: thickness };
    }
    const left = which === 'before' ? blob.x - t - thickness : blob.x + blob.w + t;
    return { x: left, y: blob.y, w: thickness, h: blob.h };
  };
  const before = regionChroma(opt.pixels, rectFor('before'));
  const after = regionChroma(opt.pixels, rectFor('after'));
  const middle = regionChroma(opt.pixels, horizontal
    ? { x: blob.x, y: blob.y + blob.h / 2 - thickness / 2, w: blob.w, h: thickness }
    : { x: blob.x + blob.w / 2 - thickness / 2, y: blob.y, w: thickness, h: blob.h });
  const best = Math.max(before, after, middle);
  if (best <= 0) return 'both';
  if (best === middle) return 'both';
  return best === before ? 'before' : 'after';
}

/** 거의 같은 자리에 겹쳐 잡힌 상자를 하나로 합칩니다. */
export function dedupe(boxes, tolerance = 0.6) {
  const out = [];
  for (const b of boxes) {
    const hit = out.find((o) => overlapRatio(o, b) > tolerance);
    if (hit) {
      const x = Math.min(hit.x, b.x);
      const y = Math.min(hit.y, b.y);
      hit.w = Math.max(hit.x + hit.w, b.x + b.w) - x;
      hit.h = Math.max(hit.y + hit.h, b.y + b.h) - y;
      hit.x = x;
      hit.y = y;
    } else out.push({ ...b });
  }
  return out;
}

/** 네모 안에 든 원래 빨간 픽셀 수 */
function countInside(mask, w, h, box) {
  const x0 = Math.max(0, box.x);
  const y0 = Math.max(0, box.y);
  const x1 = Math.min(w, box.x + box.w);
  const y1 = Math.min(h, box.y + box.h);
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    const row = y * w;
    for (let x = x0; x < x1; x += 1) if (mask[row + x]) n += 1;
  }
  return Math.max(1, n);
}

export function overlapRatio(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x || y2 <= y) return 0;
  const inter = (x2 - x) * (y2 - y);
  return inter / Math.min(a.w * a.h, b.w * b.h);
}

/**
 * 사진 전체에서 빨간선을 찾아 자를 상자 목록을 돌려줍니다.
 * @param {ImageData} imageData 분석용(축소) 픽셀
 * @param {number} scale 원본 대비 축소 비율 (원본좌표 = 분석좌표 / scale)
 */
export function detectRedRegions(imageData, scale, opt) {
  const { width: w, height: h } = imageData;
  const raw = buildRedMask(imageData, opt.strength);
  const radius = Math.max(1, Math.round(Math.min(w, h) * opt.join));
  const mask = dilate(raw, w, h, radius);
  const minPixels = Math.max(24, Math.round(w * h * 0.00004));
  const blobs = findBlobs(mask, w, h, minPixels)
    .filter((b) => Math.hypot(b.w, b.h) >= Math.hypot(w, h) * 0.02);

  const minSide = Math.min(w, h);
  const thickLimit = Math.max(5, minSide * 0.022);
  const withPixels = { ...opt, pixels: imageData };

  const boxes = blobs.map((b) => {
    // 부풀린 만큼 되돌려서 원래 선 위치로 맞춥니다.
    // 굵기는 부풀리기 전(raw) 픽셀 수로 재야 실제 선 굵기가 나옵니다.
    const tight = {
      x: b.x + radius,
      y: b.y + radius,
      w: Math.max(1, b.w - radius * 2),
      h: Math.max(1, b.h - radius * 2),
      pixels: countInside(raw, w, h, b),
    };
    if (opt.ignoreSolid !== false && strokeWidth(tight) > thickLimit) return null;
    const box = blobToBox(tight, w, h, withPixels);
    return {
      x: Math.round(box.x / scale),
      y: Math.round(box.y / scale),
      w: Math.max(2, Math.round(box.w / scale)),
      h: Math.max(2, Math.round(box.h / scale)),
      kind: opt.mode === 'auto' ? classifyBlob(tight, w, h) : opt.mode,
    };
  }).filter(Boolean);
  return dedupe(boxes);
}
