/* card.js — 색상표(실 카드) 사진에서 타래를 통째로 찾아냅니다.
   번호가 한 줄로 적혀 있고 그 아래로 실타래가 나란히 늘어진 사진을 다룹니다.
   여기서 찾은 자리로 책자(색상표)를 만듭니다.

   타래끼리 딱 붙어 있어 빈틈이 없는 사진이 많아서, 빈틈 대신
   "번호 칸의 세로선"과 "실 색이 바뀌는 자리"를 모아 규칙적인 격자를 맞춥니다. */

import { chroma, rgbToLab } from './color.js';

function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 종이(카드 바탕)인지. 색기가 거의 없고 밝으면 종이로 봅니다. */
function isPaper(r, g, b, minChroma, minLum) {
  return chroma(r, g, b) < minChroma && luminance(r, g, b) >= minLum;
}

/** 값이 기준을 넘는 구간을 모읍니다. */
function runs(values, threshold, minLength) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= values.length; i += 1) {
    const on = i < values.length && values[i] >= threshold;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      if (i - start >= minLength) out.push({ from: start, to: i });
      start = -1;
    }
  }
  return out;
}

/** 봉우리(주변보다 높은 자리)를 골라냅니다. 가까운 것끼리는 가장 센 것만 남깁니다. */
function peaks(values, minValue, minGap) {
  const found = [];
  for (let i = 1; i < values.length - 1; i += 1) {
    if (values[i] >= minValue && values[i] >= values[i - 1] && values[i] > values[i + 1]) {
      found.push({ x: i, v: values[i] });
    }
  }
  const kept = [];
  for (const p of found.sort((a, b) => b.v - a.v)) {
    if (!kept.some((q) => Math.abs(q.x - p.x) < minGap)) kept.push(p);
  }
  return kept.sort((a, b) => a.x - b.x).map((p) => p.x);
}

/**
 * 후보 자리들을 가장 잘 설명하는 "일정한 간격의 격자"를 찾습니다.
 * 카드의 번호 칸은 폭이 같으므로, 몇 군데만 제대로 잡혀도 나머지를 채울 수 있습니다.
 *
 * 잘게 쪼갠 격자가 이기지 않도록, 후보를 얼마나 맞혔는지(recall)와
 * 그은 선이 헛되지 않았는지(precision)를 함께 봅니다.
 */
export function fitGrid(candidates, width, minPeriod, maxPeriod) {
  if (candidates.length < 3) return null;

  const periods = new Set();
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const p = Math.round(candidates[j] - candidates[i]);
      if (p >= minPeriod && p <= maxPeriod) periods.add(p);
    }
  }
  if (!periods.size) return null;

  const tolerance = Math.max(3, width * 0.006);
  const scored = [];
  for (const period of periods) {
    let best = null;
    for (const anchor of candidates) {
      let matched = 0;
      let error = 0;
      for (const x of candidates) {
        const k = Math.round((x - anchor) / period);
        const off = Math.abs(x - (anchor + k * period));
        if (off <= tolerance) { matched += 1; error += off; }
      }
      let lines = 0;
      let usedLines = 0;
      const first = anchor - Math.floor(anchor / period) * period;
      for (let x = first; x <= width; x += period) {
        lines += 1;
        if (candidates.some((cx) => Math.abs(cx - x) <= tolerance)) usedLines += 1;
      }
      if (lines < 2 || !matched) continue;
      const recall = matched / candidates.length;
      const precision = usedLines / lines;
      const f1 = (2 * recall * precision) / (recall + precision) - (error / matched) / (tolerance * 40);
      if (!best || f1 > best.f1) best = { period, anchor, hits: matched, precision, f1 };
    }
    if (best) scored.push(best);
  }
  if (!scored.length) return null;

  return scored.sort((a, b) => b.f1 - a.f1)[0];
}

/**
 * 잡힌 선들에 맞춰 격자를 한 번 더 다듬습니다.
 * 사진이 살짝 기울어 칸 폭이 조금씩 달라도 전체 오차가 가장 작은 격자를 찾습니다.
 */
export function refineGrid(fit, candidates, tolerance) {
  const points = [];
  for (const x of candidates) {
    const k = Math.round((x - fit.anchor) / fit.period);
    if (Math.abs(x - (fit.anchor + k * fit.period)) <= tolerance) points.push([k, x]);
  }
  if (points.length < 3) return fit;
  const n = points.length;
  const sk = points.reduce((a, [k]) => a + k, 0);
  const sx = points.reduce((a, [, x]) => a + x, 0);
  const skk = points.reduce((a, [k]) => a + k * k, 0);
  const skx = points.reduce((a, [k, x]) => a + k * x, 0);
  const den = n * skk - sk * sk;
  if (!den) return fit;
  const period = (n * skx - sk * sx) / den;
  const anchor = (sx - period * sk) / n;
  if (!Number.isFinite(period) || period <= 0) return fit;
  return { ...fit, period, anchor };
}

/** 격자를 사진 폭 전체로 늘려 칸 경계 목록을 만듭니다. */
function gridLines(fit, width) {
  const out = [];
  const first = fit.anchor - Math.ceil(fit.anchor / fit.period) * fit.period;
  for (let x = first; x <= width + fit.period * 0.5; x += fit.period) out.push(Math.round(x));
  return out;
}

/**
 * 사진에서 실타래를 모두 찾습니다.
 *
 * @param {ImageData} img
 * @param {object} opt minChroma, minLum, rowFill, bottom('band'|'edge')
 * @returns {{hanks:Array<{x,y,w,h,filled:number}>, band:{from,to}|null, period:number|null}}
 */
export function findHanks(img, opt = {}) {
  const { data, width: w, height: h } = img;
  const minChroma = opt.minChroma ?? 18;
  const minLum = opt.minLum ?? 150;
  const empty = { hanks: [], band: null, period: null };

  /* 1) 실이 깔린 가로 띠 찾기 */
  const step = Math.max(1, Math.round(w / 400));
  const rowFill = new Float32Array(h);
  for (let y = 0; y < h; y += 1) {
    let hit = 0;
    let n = 0;
    for (let x = 0; x < w; x += step) {
      const p = (y * w + x) * 4;
      if (!isPaper(data[p], data[p + 1], data[p + 2], minChroma, minLum)) hit += 1;
      n += 1;
    }
    rowFill[y] = n ? hit / n : 0;
  }
  const bands = runs(rowFill, opt.rowFill ?? 0.55, Math.round(h * 0.06));
  if (!bands.length) return empty;
  const band = bands.reduce((a, b) => ((b.to - b.from) > (a.to - a.from) ? b : a));
  const dense = Math.min(band.to, band.from + Math.max(30, Math.round((band.to - band.from) * 0.45)));

  /* 2) 번호 칸의 세로선 찾기.
     숫자 획도 어둡지만 짧습니다. 세로로 길게 이어지는 것만 표 선으로 봅니다. */
  const headerFrom = Math.max(0, band.from - Math.round((band.to - band.from) * 0.45));
  const headerTo = Math.max(headerFrom + 8, band.from - 2);
  const lineCandidates = [];
  if (headerTo - headerFrom > 16) {
    const rowMean = new Float32Array(headerTo - headerFrom);
    for (let y = headerFrom; y < headerTo; y += 1) {
      let s = 0;
      let n = 0;
      for (let x = 0; x < w; x += 2) {
        const p = (y * w + x) * 4;
        s += luminance(data[p], data[p + 1], data[p + 2]);
        n += 1;
      }
      rowMean[y - headerFrom] = n ? s / n : 255;
    }
    const rows = headerTo - headerFrom;
    const inkFrac = new Float32Array(w);
    for (let x = 0; x < w; x += 1) {
      let n = 0;
      for (let y = headerFrom; y < headerTo; y += 1) {
        const p = (y * w + x) * 4;
        if (luminance(data[p], data[p + 1], data[p + 2]) < rowMean[y - headerFrom] - 35) n += 1;
      }
      inkFrac[x] = n / rows;
    }
    lineCandidates.push(...peaks(inkFrac, opt.ruleInk ?? 0.55, Math.max(8, Math.round(w * 0.012))));
  }

  /* 3) 실 색이 바뀌는 자리 */
  const labs = [];
  for (let x = 0; x < w; x += 1) {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = band.from; y < dense; y += 2) {
      const p = (y * w + x) * 4;
      if (isPaper(data[p], data[p + 1], data[p + 2], minChroma, minLum)) continue;
      r += data[p]; g += data[p + 1]; b += data[p + 2]; n += 1;
    }
    labs.push(n ? rgbToLab(r / n, g / n, b / n) : null);
  }
  const smooth = labs.map((_, i) => {
    let L = 0; let A = 0; let B = 0; let n = 0;
    for (let k = -3; k <= 3; k += 1) {
      const v = labs[i + k];
      if (v) { L += v[0]; A += v[1]; B += v[2]; n += 1; }
    }
    return n ? [L / n, A / n, B / n] : null;
  });
  const reach = Math.max(4, Math.round(w * 0.006));
  const hueStep = new Float32Array(w);
  for (let x = 0; x < w; x += 1) {
    const a = smooth[x - reach];
    const b = smooth[x + reach];
    // 밝기(그늘)는 빼고 색조·선명도 변화만 봅니다. 타래 가운데의 하이라이트에 속지 않으려고요.
    hueStep[x] = a && b ? Math.hypot(a[1] - b[1], a[2] - b[2]) : 0;
  }
  const hueCandidates = peaks(hueStep, 2.5, Math.max(10, Math.round(w * 0.02)));

  /* 4) 격자 맞추기.
     번호 칸의 표 세로선은 간격이 일정해서 가장 믿을 만합니다.
     표가 없는 사진이면 실 색이 바뀌는 자리로 대신합니다. */
  const minPeriod = Math.max(12, w * 0.02);
  const maxPeriod = w * 0.4;
  const tolerance = Math.max(3, w * 0.006);
  const rules = lineCandidates.slice().sort((a, b) => a - b);
  let fit = rules.length >= 4 ? fitGrid(rules, w, minPeriod, maxPeriod) : null;
  let from = rules;
  if (!fit || fit.precision < 0.5 || fit.hits < 4) {
    const alt = fitGrid(hueCandidates, w, minPeriod, maxPeriod);
    if (alt && (!fit || alt.f1 > fit.f1)) { fit = alt; from = hueCandidates; }
  }
  if (fit) fit = refineGrid(fit, from, tolerance);

  let edges;
  if (fit) {
    edges = gridLines(fit, w);
  } else {
    // 격자를 못 찾으면 색이 바뀌는 자리를 그대로 경계로 씁니다.
    edges = [0, ...hueCandidates, w];
  }
  edges = edges.filter((x, i, a) => x > -2 && x < w + 2 && (i === 0 || x - a[i - 1] > 4));

  /* 5) 칸마다 타래 상자 만들기. 실이 거의 없는 칸은 버립니다. */
  const bottom = opt.bottom === 'band'
    ? Math.min(h, band.to + Math.round((band.to - band.from) * 0.2))
    : h;
  const hanks = [];
  for (let i = 0; i < edges.length - 1; i += 1) {
    const x0 = Math.max(0, edges[i]);
    const x1 = Math.min(w, edges[i + 1]);
    if (x1 - x0 < Math.max(8, w * 0.015)) continue;
    let hit = 0;
    let n = 0;
    for (let y = band.from; y < dense; y += 2) {
      for (let x = x0 + 1; x < x1 - 1; x += 2) {
        const p = (y * w + x) * 4;
        if (!isPaper(data[p], data[p + 1], data[p + 2], minChroma, minLum)) hit += 1;
        n += 1;
      }
    }
    const filled = n ? hit / n : 0;
    if (filled < 0.5) continue;
    hanks.push({
      x: x0 + 1, y: band.from, w: x1 - x0 - 2, h: Math.max(4, bottom - band.from), filled,
    });
  }
  return { hanks, band, period: fit ? Math.round(fit.period) : null };
}
