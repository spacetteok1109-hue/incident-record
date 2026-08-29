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

/**
 * 격자 간격과 위치를 실제 실 색에 맞춰 다듬습니다.
 *
 * 번호 칸의 가는 선 대신 숫자 획이 잡히면 격자가 타래 한가운데에 서게 되고,
 * 그러면 칸 하나에 옆 타래 절반씩 담겨 색이 섞입니다. 제자리에 선 격자는
 * 칸 안의 색이 고르고 칸 경계에서 색이 확 바뀌므로, 그 두 가지가 가장
 * 잘 맞는 간격·위치를 찾습니다.
 *
 * @param columns 열마다 미리 구해 둔 Lab 평균 (없는 열은 null)
 */
export function refineFit(columns, period, anchor, width) {
  const measure = (per, phase) => {
    const inset = Math.max(1, Math.round(per * 0.22));
    let within = 0;
    let jump = 0;
    let cells = 0;
    let edges = 0;
    const first = phase - Math.floor(phase / per) * per;
    for (let x = first; x + per <= width; x += per) {
      const a = Math.ceil(x) + inset;
      const b = Math.floor(x + per) - inset;
      if (b - a < 3) continue;
      let L = 0; let A = 0; let B = 0; let n = 0;
      for (let i = a; i < b; i += 1) {
        const v = columns[i];
        if (v) { L += v[0]; A += v[1]; B += v[2]; n += 1; }
      }
      if (n < 3) continue;
      L /= n; A /= n; B /= n;
      let variance = 0;
      for (let i = a; i < b; i += 1) {
        const v = columns[i];
        if (v) variance += (v[0] - L) ** 2 + (v[1] - A) ** 2 + (v[2] - B) ** 2;
      }
      within += variance / n;
      cells += 1;
      // 칸 경계에서는 색이 확 바뀌어야 제자리입니다.
      const left = columns[Math.round(x) - inset];
      const right = columns[Math.round(x) + inset];
      if (left && right) {
        jump += Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
        edges += 1;
      }
    }
    if (cells < 3 || !edges) return Infinity;
    return (within / cells) / (1 + jump / edges);
  };

  let best = { period, anchor, value: Infinity };
  for (let per = period * 0.94; per <= period * 1.06; per += 0.2) {
    for (let step = 0; step < per; step += 1) {
      const value = measure(per, anchor + step);
      if (value < best.value) best = { period: per, anchor: anchor + step, value };
    }
  }
  return Number.isFinite(best.value) ? best : { period, anchor };
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
    for (let x = 0; x < w - step; x += step) {
      const p = (y * w + x) * 4;
      const q = (y * w + x + step) * 4;
      const paper = isPaper(data[p], data[p + 1], data[p + 2], minChroma, minLum);
      // 흰·회색 실은 종이와 색이 비슷합니다. 대신 가닥 그늘 때문에 옆 픽셀과
      // 밝기가 톡톡 튀므로, 그 결을 함께 봐서 실이 깔린 줄을 찾습니다.
      const grain = Math.abs(
        luminance(data[p], data[p + 1], data[p + 2]) - luminance(data[q], data[q + 1], data[q + 2]),
      ) > (opt.grain ?? 7);
      if (!paper || grain) hit += 1;
      n += 1;
    }
    rowFill[y] = n ? hit / n : 0;
  }
  const found = runs(rowFill, opt.rowFill ?? 0.55, Math.round(h * (opt.minBand ?? 0.06)));
  if (!found.length) return empty;
  // 한 장에 실 띠가 여러 줄 들어 있는 카드도 있습니다. 위에서 아래로 차례로 봅니다.
  const bands = opt.allBands === false
    ? [found.reduce((a, b) => ((b.to - b.from) > (a.to - a.from) ? b : a))]
    : found;

  const all = [];
  let lastPeriod = null;
  for (const band of bands) {
    const got = bandHanks(img, band, opt);
    if (got.period) lastPeriod = got.period;
    all.push(...got.hanks.map((hk) => ({ ...hk, band: bands.indexOf(band) })));
  }
  return { hanks: all, band: bands[0], bands, period: lastPeriod };
}

/** 띠 하나 안에서 타래를 나눕니다. */
function bandHanks(img, band, opt) {
  const { data, width: w, height: h } = img;
  const minChroma = opt.minChroma ?? 18;
  const minLum = opt.minLum ?? 150;
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
  if (fit) {
    fit = refineGrid(fit, from, tolerance);
    fit = { ...fit, ...refineFit(smooth, fit.period, fit.anchor, w) };
  }

  let edges;
  if (fit) {
    edges = gridLines(fit, w);
  } else {
    // 격자를 못 찾으면 색이 바뀌는 자리를 그대로 경계로 씁니다.
    edges = [0, ...hueCandidates, w];
  }
  edges = edges.filter((x, i, a) => x > -2 && x < w + 2 && (i === 0 || x - a[i - 1] > 4));

  /* 5) 칸마다 타래 상자 만들기. 실이 거의 없는 칸은 버립니다. */
  // 번호칸이 아예 없으면 카드가 아니라 배경입니다.
  if (headerTo - headerFrom <= 16) return { hanks: [], period: null };
  {
    let paper = 0;
    let n = 0;
    for (let y = headerFrom; y < headerTo; y += 2) {
      for (let x = 0; x < w; x += 4) {
        const p = (y * w + x) * 4;
        if (isPaper(data[p], data[p + 1], data[p + 2], 40, 140)) paper += 1;
        n += 1;
      }
    }
    if (n && paper / n < 0.3) return { hanks: [], period: null };
  }

  // 칸 위쪽이 번호가 적힌 흰 종이인지 봅니다. 카드 밖(배경)에는 종이가 없습니다.
  const headerPaper = (x0, x1) => {
    if (headerTo - headerFrom <= 8) return 1;
    let hit = 0;
    let n = 0;
    for (let y = headerFrom; y < headerTo; y += 2) {
      for (let x = Math.max(0, x0); x < Math.min(w, x1); x += 2) {
        const p = (y * w + x) * 4;
        if (isPaper(data[p], data[p + 1], data[p + 2], 40, 140)) hit += 1;
        n += 1;
      }
    }
    return n ? hit / n : 0;
  };

  // 그 칸 위에 번호가 실제로 찍혀 있는지 (여백 칸에는 글자가 없습니다)
  const headerInk = (x0, x1) => {
    let ink = 0;
    let n = 0;
    for (let y = headerFrom; y < headerTo; y += 1) {
      for (let x = Math.max(0, x0); x < Math.min(w, x1); x += 1) {
        const p = (y * w + x) * 4;
        if (luminance(data[p], data[p + 1], data[p + 2]) < 110) ink += 1;
        n += 1;
      }
    }
    return n ? ink / n : 0;
  };

  const bandBottom = Math.min(h, band.to + Math.round((band.to - band.from) * 0.2));
  const bottom = opt.bottom === 'band' ? bandBottom : h;
  const cells = [];
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
    cells.push({
      index: i,
      x: x0 + 1,
      y: band.from,
      w: x1 - x0 - 2,
      h: Math.max(4, bottom - band.from),
      filled: n ? hit / n : 0,
      paper: headerPaper(x0, x1),
      ink: headerInk(x0, x1),
    });
  }

  // 실이 실제로 깔려 있는 가로 구간. 흰 실도 놓치지 않도록 얼룩덜룩함까지 함께 봅니다.
  const threadCol = new Float32Array(w);
  for (let x = 0; x < w; x += 1) {
    let hit = 0;
    let n = 0;
    let sum = 0;
    let sumSq = 0;
    for (let y = band.from; y < dense; y += 2) {
      const p = (y * w + x) * 4;
      if (!isPaper(data[p], data[p + 1], data[p + 2], minChroma, minLum)) hit += 1;
      const l = luminance(data[p], data[p + 1], data[p + 2]);
      sum += l; sumSq += l * l; n += 1;
    }
    if (!n) continue;
    const rough = Math.sqrt(Math.max(0, sumSq / n - (sum / n) ** 2));
    threadCol[x] = (hit / n >= 0.35 || rough >= (opt.rough ?? 10)) ? 1 : 0;
  }
  const threadRuns = runs(threadCol, 1, Math.max(4, Math.round(w * 0.01)));
  const threadSpan = threadRuns.length
    ? threadRuns.reduce((a, b) => ((b.to - b.from) > (a.to - a.from) ? b : a))
    : null;

  // 칸 수를 알려 준 경우: 실이 깔린 구간과 가장 잘 겹치는 자리로 그만큼 잘라 씁니다.
  const want = Number(opt.cells) || 0;

  // 격자를 못 찾았거나 칸이 모자라면, 실이 깔린 구간을 그냥 칸 수만큼 똑같이 나눕니다.
  if (want >= 2 && cells.length < want && threadSpan) {
    const width = (threadSpan.to - threadSpan.from) / want;
    if (width >= 6) {
      const made = [];
      for (let i = 0; i < want; i += 1) {
        const x0 = Math.round(threadSpan.from + i * width);
        const x1 = Math.round(threadSpan.from + (i + 1) * width);
        made.push({
          index: i,
          x: x0 + 1,
          y: band.from,
          w: Math.max(2, x1 - x0 - 2),
          h: Math.max(4, bottom - band.from),
          filled: 1,
          paper: 1,
          ink: 0,
          evenly: true,
        });
      }
      return { hanks: made, period: Math.round(width) };
    }
  }

  if (want >= 2 && cells.length >= want) {
    let best = null;
    // 카드 위에 있어야 한다는 조건을 조금씩 풀면서, 되는 선에서 가장 좋은 자리를 찾습니다.
    for (const minPaper of [0.5, 0.3, 0]) {
      for (let i = 0; i + want <= cells.length; i += 1) {
        const window = cells.slice(i, i + want);
        if (window[want - 1].index - window[0].index !== want - 1) continue;
        if (window.some((c) => c.paper < minPaper)) continue;
        const w0 = window[0].x;
        const w1 = window[want - 1].x + window[want - 1].w;
        let score = window.reduce((a, c) => a + c.ink, 0);
        if (threadSpan) {
          const overlap = Math.max(0, Math.min(w1, threadSpan.to) - Math.max(w0, threadSpan.from));
          const spread = Math.max(w1, threadSpan.to) - Math.min(w0, threadSpan.from);
          score = (overlap / Math.max(1, spread)) * 10 + score;
        }
        if (!best || score > best.score) best = { score, window };
      }
      if (best) break;
    }
    if (best) return { hanks: best.window, period: fit ? Math.round(fit.period) : null };
  }

  const hanks = cells.filter((c) => c.paper >= 0.45 && (c.filled >= 0.35 || c.ink >= 0.02));
  if (hanks.length > 2) {
    // 띄엄띄엄 떨어진 헛 칸은 버리고, 죽 이어진 무리만 남깁니다.
    let best = { at: 0, len: 1 };
    let at = 0;
    for (let k = 1; k <= hanks.length; k += 1) {
      const linked = k < hanks.length && hanks[k].index === hanks[k - 1].index + 1;
      if (!linked) {
        if (k - at > best.len) best = { at, len: k - at };
        at = k;
      }
    }
    return { hanks: hanks.slice(best.at, best.at + best.len), period: fit ? Math.round(fit.period) : null };
  }
  return { hanks, period: fit ? Math.round(fit.period) : null };
}
