/* sample.js — 잘라낸 조각에서 "실 색"이 무엇인지 뽑아냅니다.
   여기서 계산한 값은 색코드를 찾는 데에만 쓰고, 사진 픽셀은 건드리지 않습니다. */

import { rgbToLab, labToRgb, isRedPixel } from './color.js';

/**
 * 조각의 대표색을 고릅니다.
 * 방법: 빨간선·종이 흰 여백을 뺀 뒤 Lab 공간에서 가장 두꺼운 색 덩어리를 찾아
 *       그 덩어리의 평균을 씁니다. 얼룩이나 그림자에 잘 흔들리지 않습니다.
 *
 * @param {ImageData} img
 * @param {object} opt  {skipRed:boolean, skipPaper:boolean, inset:number(0~0.45)}
 * @returns {{rgb:number[], coverage:number, used:number}|null}
 */
export function representativeColor(img, opt = {}) {
  const skipRed = opt.skipRed !== false;
  const skipPaper = opt.skipPaper !== false;
  const inset = Math.min(0.45, Math.max(0, opt.inset ?? 0.12));

  const { data, width: w, height: h } = img;
  const x0 = Math.floor(w * inset);
  const x1 = Math.max(x0 + 1, Math.ceil(w * (1 - inset)));
  const y0 = Math.floor(h * inset);
  const y1 = Math.max(y0 + 1, Math.ceil(h * (1 - inset)));
  const step = Math.max(1, Math.round(Math.sqrt(((x1 - x0) * (y1 - y0)) / 24000)));

  const collect = (dropPaper) => {
    const pts = [];
    for (let y = y0; y < y1; y += step) {
      for (let x = x0; x < x1; x += step) {
        const p = (y * w + x) * 4;
        if (data[p + 3] < 128) continue;
        const r = data[p];
        const g = data[p + 1];
        const b = data[p + 2];
        if (skipRed && isRedPixel(r, g, b, 1)) continue;
        const lab = rgbToLab(r, g, b);
        if (dropPaper) {
          const chroma = Math.hypot(lab[1], lab[2]);
          if (lab[0] > 90 && chroma < 7) continue; // 하얀 종이
          if (lab[0] < 8 && chroma < 7) continue; // 새까만 그림자
        }
        pts.push(lab);
      }
    }
    return pts;
  };

  let pts = collect(skipPaper);
  const total = Math.ceil((x1 - x0) / step) * Math.ceil((y1 - y0) / step);
  // 흰 실·검은 실이라면 종이로 오해한 것이므로 되돌립니다.
  if (skipPaper && pts.length < total * 0.15) pts = collect(false);
  if (!pts.length) return null;

  // 실타래는 가닥 사이에 그늘이 지고 겉면은 반들거립니다. 그 양끝을 걷어 내고
  // 사람이 보는 "실 겉면" 밝기대만 남깁니다. (밝기 순서로 자르므로 진한 실도 그대로 진합니다.)
  if (opt.trimShade !== false && pts.length > 40) {
    const sorted = pts.slice().sort((a, b) => a[0] - b[0]);
    const lo = sorted[Math.floor(sorted.length * 0.45)][0];
    const hi = sorted[Math.floor(sorted.length * 0.92)][0];
    const lit = pts.filter((lab) => lab[0] >= lo && lab[0] <= hi);
    if (lit.length >= 20) pts = lit;
  }

  // Lab 공간을 격자로 나눠 가장 붐비는 칸을 찾습니다.
  const BL = 6;
  const BA = 8;
  const bins = new Map();
  for (const lab of pts) {
    const key = `${Math.round(lab[0] / BL)}|${Math.round(lab[1] / BA)}|${Math.round(lab[2] / BA)}`;
    const bin = bins.get(key);
    if (bin) bin.push(lab);
    else bins.set(key, [lab]);
  }
  let best = null;
  for (const bin of bins.values()) if (!best || bin.length > best.length) best = bin;

  // 가장 붐비는 칸 주변까지 모아 평균을 냅니다.
  const center = mean(best);
  const near = pts.filter((lab) => Math.abs(lab[0] - center[0]) <= BL
    && Math.abs(lab[1] - center[1]) <= BA * 1.5
    && Math.abs(lab[2] - center[2]) <= BA * 1.5);
  const avg = mean(near.length ? near : best);
  return {
    rgb: labToRgb(avg[0], avg[1], avg[2]),
    coverage: near.length / pts.length,
    used: pts.length,
  };
}

function mean(list) {
  let L = 0; let a = 0; let b = 0;
  for (const v of list) { L += v[0]; a += v[1]; b += v[2]; }
  return [L / list.length, a / list.length, b / list.length];
}

/** 스포이드: 그 자리 픽셀 색을 그대로 (보정 없이) 읽습니다. */
export function pixelAt(img, x, y) {
  const px = Math.max(0, Math.min(img.width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(img.height - 1, Math.round(y)));
  const p = (py * img.width + px) * 4;
  return [img.data[p], img.data[p + 1], img.data[p + 2]];
}

/** 스포이드(넓게): 주변 사각형의 중앙값. 사진 노이즈를 피하고 싶을 때 씁니다. */
export function medianAround(img, x, y, radius = 2) {
  const rs = []; const gs = []; const bs = [];
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const [r, g, b] = pixelAt(img, x + dx, y + dy);
      rs.push(r); gs.push(g); bs.push(b);
    }
  }
  const mid = (arr) => { arr.sort((a, b) => a - b); return arr[Math.floor(arr.length / 2)]; };
  return [mid(rs), mid(gs), mid(bs)];
}
