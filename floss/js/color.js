/* color.js — 색 변환과 색 거리 계산 (화면과 무관한 순수 계산) */

/** '#RRGGBB' -> [r,g,b] */
export function hexToRgb(hex) {
  const m = String(hex).trim().replace('#', '');
  const s = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

export function rgbToHex(r, g, b) {
  const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

/* sRGB -> 선형 RGB */
function toLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** sRGB -> CIE Lab (D65 기준) */
export function rgbToLab(r, g, b) {
  const R = toLinear(r);
  const G = toLinear(g);
  const B = toLinear(b);
  // sRGB -> XYZ (D65)
  let x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  let y = (R * 0.2126729 + G * 0.7151522 + B * 0.0721750) / 1.0;
  let z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / 1.08883;
  const f = (t) => (t > 0.008856451679 ? Math.cbrt(t) : t * 7.787037037 + 16 / 116);
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** Lab -> sRGB (미리보기용) */
export function labToRgb(L, a, bb) {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - bb / 200;
  const inv = (t) => (t ** 3 > 0.008856451679 ? t ** 3 : (t - 16 / 116) / 7.787037037);
  const x = inv(fx) * 0.95047;
  const y = inv(fy);
  const z = inv(fz) * 1.08883;
  let R = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
  let G = x * -0.9692660 + y * 1.8760108 + z * 0.0415560;
  let B = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;
  const enc = (c) => {
    const v = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  };
  R = enc(R); G = enc(G); B = enc(B);
  return [R, G, B];
}

const DEG = Math.PI / 180;

/**
 * CIEDE2000 색 차이. 사람이 느끼는 "얼마나 다른가"에 가장 가까운 값입니다.
 * 1 이하면 거의 구분 못 하고, 2~3이면 나란히 두어야 겨우 보이는 차이입니다.
 */
export function deltaE2000(lab1, lab2) {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const ap1 = a1 * (1 + G);
  const ap2 = a2 * (1 + G);
  const Cp1 = Math.hypot(ap1, b1);
  const Cp2 = Math.hypot(ap2, b2);
  const hp1 = Cp1 === 0 ? 0 : (Math.atan2(b1, ap1) / DEG + 360) % 360;
  const hp2 = Cp2 === 0 ? 0 : (Math.atan2(b2, ap2) / DEG + 360) % 360;

  const dL = L2 - L1;
  const dC = Cp2 - Cp1;
  let dhp = 0;
  if (Cp1 * Cp2 !== 0) {
    dhp = hp2 - hp1;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dhp / 2) * DEG);

  const Lb = (L1 + L2) / 2;
  const Cpb = (Cp1 + Cp2) / 2;
  let hpb;
  if (Cp1 * Cp2 === 0) hpb = hp1 + hp2;
  else if (Math.abs(hp1 - hp2) <= 180) hpb = (hp1 + hp2) / 2;
  else hpb = (hp1 + hp2 + (hp1 + hp2 < 360 ? 360 : -360)) / 2;

  const T = 1
    - 0.17 * Math.cos((hpb - 30) * DEG)
    + 0.24 * Math.cos(2 * hpb * DEG)
    + 0.32 * Math.cos((3 * hpb + 6) * DEG)
    - 0.20 * Math.cos((4 * hpb - 63) * DEG);
  const dTheta = 30 * Math.exp(-(((hpb - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cpb ** 7 / (Cpb ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
  const Sc = 1 + 0.045 * Cpb;
  const Sh = 1 + 0.015 * Cpb * T;
  const Rt = -Math.sin(2 * dTheta * DEG) * Rc;

  return Math.sqrt(
    (dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh),
  );
}

/** 사람이 읽기 쉬운 차이 설명 */
export function deltaEWord(de) {
  if (de < 1) return '거의 같음';
  if (de < 2) return '아주 비슷';
  if (de < 3.5) return '비슷';
  if (de < 6) return '조금 다름';
  if (de < 12) return '꽤 다름';
  return '많이 다름';
}

/** 글자를 배경 위에 얹을 때 검정/흰색 중 어느 쪽이 읽기 쉬운지 */
export function readableInk(r, g, b) {
  const lum = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  return lum > 0.4 ? '#000000' : '#ffffff';
}

/**
 * 빨간선 판정.
 *
 * 분홍·살구·자주 실과 빨간 펜 자국을 가르는 기준입니다. 실제 색상표 사진을 재 보면
 *   빨간 펜  (253, 89, 88) — 빨강이 아주 밝고, 초록·파랑이 뚝 떨어집니다
 *   살구 실  (235,161,160) — 빨강은 밝지만 초록·파랑도 함께 높습니다(탁함)
 *   진분홍 실(127, 57, 55) — 선명하지만 전체가 어둡습니다
 * 그래서 "빨강이 밝고, 선명하고, 초록·파랑과 크게 벌어진" 세 가지를 함께 봅니다.
 *
 * @param strength 1이 기본. 낮추면 옅은 표시까지 잡고, 높이면 진한 빨강만 잡습니다.
 */
export function isRedPixel(r, g, b, strength = 1) {
  const mx = Math.max(r, g, b);
  if (r !== mx) return false; // 빨강이 가장 센 색이어야 합니다
  const sat = mx ? (mx - Math.min(r, g, b)) / mx : 0;
  return (
    r >= 120 + 65 * strength
    && sat >= 0.30 + 0.25 * strength
    && r - Math.max(g, b) >= 40 + 50 * strength
  );
}

/** 색이 얼마나 짙은지(0~255). 흰 종이는 0에 가깝습니다. */
export function chroma(r, g, b) {
  return Math.max(r, g, b) - Math.min(r, g, b);
}
