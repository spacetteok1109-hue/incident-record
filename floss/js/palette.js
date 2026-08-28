/* palette.js — 실 책자(색상표) 관리와 가장 가까운 색 찾기 */

import {
  hexToRgb, rgbToLab, deltaE2000, rgbToHex,
} from './color.js';

const CUSTOM_KEY = 'floss.palettes.v1';

/** 색 목록에 Lab 값을 미리 계산해 붙여 둡니다(비교를 빠르게 하려고). */
function prepare(palette) {
  const colors = palette.colors
    .map((c) => {
      const rgb = hexToRgb(c.hex);
      if (!rgb) return null;
      return {
        code: String(c.code).trim(),
        name: c.name || '',
        family: c.family || '',
        ko: c.ko || '',
        hex: rgbToHex(rgb[0], rgb[1], rgb[2]),
        rgb,
        lab: rgbToLab(rgb[0], rgb[1], rgb[2]),
      };
    })
    .filter(Boolean);
  return { ...palette, colors };
}

const cache = new Map();

export async function loadBuiltin(id = 'dmc') {
  if (cache.has(id)) return cache.get(id);
  const res = await fetch(`./data/${id}.json`, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`색상표를 불러오지 못했습니다 (${res.status})`);
  const p = prepare(await res.json());
  cache.set(id, p);
  return p;
}

export function loadCustomList() {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

export function saveCustomList(list) {
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
  cache.clear();
}

export async function loadPalette(id) {
  const custom = loadCustomList().find((p) => p.id === id);
  if (custom) {
    if (!cache.has(id)) cache.set(id, prepare(custom));
    return cache.get(id);
  }
  return loadBuiltin(id);
}

/**
 * 색상표 파일을 읽어 들입니다.
 * CSV: 번호,이름,색코드  (머리글 줄이 있어도 알아서 건너뜁니다)
 * JSON: {name, colors:[{code,name,hex}]} 또는 [{code,name,hex}]
 */
export function parsePaletteText(text, fallbackName) {
  const trimmed = text.trim();
  let name = fallbackName;
  let rows = [];

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const data = JSON.parse(trimmed);
    const arr = Array.isArray(data) ? data : data.colors;
    if (!Array.isArray(arr)) throw new Error('colors 목록을 찾지 못했습니다.');
    if (!Array.isArray(data) && data.name) name = data.name;
    rows = arr.map((c) => ({
      code: c.code ?? c.number ?? c.no ?? '',
      name: c.name ?? c.description ?? '',
      hex: c.hex ?? c.color ?? c.rgb ?? '',
    }));
  } else {
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
    for (const line of lines) {
      const cells = splitCsvLine(line);
      if (cells.length < 2) continue;

      // 색을 적은 칸 찾기. '001' 같은 번호를 색으로 오해하지 않도록 까다롭게 봅니다.
      const hexIndexes = cells
        .map((c, i) => (isHexCell(c) ? i : -1))
        .filter((i) => i >= 0);
      if (hexIndexes.length) {
        const hi = hexIndexes[hexIndexes.length - 1]; // 보통 마지막 칸이 색입니다
        const rest = cells.filter((c, i) => i !== hi);
        rows.push({ code: rest[0] || '', name: rest.slice(1).join(' ').trim(), hex: cells[hi] });
        continue;
      }

      // 색을 R,G,B 세 칸으로 적은 색상표도 받아 줍니다.
      const nums = cells
        .map((c, i) => ({ i, v: Number(c) }))
        .filter((o) => c0to255(o.v));
      if (nums.length >= 3) {
        const [r, g, b] = nums.slice(-3);
        const used = new Set([r.i, g.i, b.i]);
        const rest = cells.filter((c, i) => !used.has(i));
        rows.push({
          code: rest[0] || '',
          name: rest.slice(1).join(' ').trim(),
          hex: rgbToHex(r.v, g.v, b.v),
        });
      }
      // 그 밖의 줄(머리글 등)은 조용히 건너뜁니다.
    }
  }

  const colors = rows
    .map((r) => {
      const rgb = hexToRgb(r.hex);
      if (!rgb) return null;
      const code = String(r.code).trim();
      if (!code) return null;
      return { code, name: String(r.name || '').trim(), hex: rgbToHex(...rgb) };
    })
    .filter(Boolean);

  if (!colors.length) throw new Error('색을 하나도 읽지 못했습니다. 번호와 색코드(#RRGGBB)가 들어 있는지 확인해 주세요.');
  return { name: name || '내 색상표', colors };
}

/** '#1A2B3C' 또는 '1A2B3C' 처럼 진짜 색으로 보이는 칸인지 */
function isHexCell(cell) {
  return /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$|^[0-9a-fA-F]{6}$/.test(String(cell).trim())
    && hexToRgb(cell) !== null;
}

function c0to255(v) {
  return Number.isFinite(v) && v >= 0 && v <= 255 && Number.isInteger(v);
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === '\t' || ch === ';') { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out.filter((c) => c !== '');
}

/** 색 하나에 가장 가까운 실 번호를 가까운 순서로 돌려줍니다. */
export function match(rgb, palette, topN = 3) {
  const lab = rgbToLab(rgb[0], rgb[1], rgb[2]);
  const scored = palette.colors.map((c) => ({ color: c, de: deltaE2000(lab, c.lab) }));
  scored.sort((a, b) => a.de - b.de);
  return scored.slice(0, topN).map((s) => ({
    code: s.color.code,
    name: s.color.name,
    ko: s.color.ko,
    hex: s.color.hex,
    de: s.de,
  }));
}

/** 번호로 색 찾기 (예: '310', 'b5200') */
export function findByCode(palette, code) {
  const key = String(code).trim().toLowerCase();
  return palette.colors.find((c) => c.code.toLowerCase() === key) || null;
}
