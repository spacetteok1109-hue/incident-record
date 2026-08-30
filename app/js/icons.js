/* icons.js — 인라인 SVG 아이콘
 *
 * 직접 그린 선 아이콘입니다. 외부 파일을 받아오지 않으므로 라이선스 걱정이 없고,
 * currentColor 를 쓰기 때문에 테마 색을 그대로 따라갑니다.
 * 24x24 격자, 선 굵기 1.75, 끝은 둥글게 — 한 세트로 보이도록 규칙을 맞췄습니다.
 */

const NS = 'http://www.w3.org/2000/svg';

const PATHS = {
  /* 오늘 — 해 */
  today: [
    ['circle', { cx: 12, cy: 12, r: 4 }],
    ['path', { d: 'M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4' }],
  ],
  /* 캘린더 */
  calendar: [
    ['rect', { x: 3, y: 5, width: 18, height: 16, rx: 3 }],
    ['path', { d: 'M8 2.5v4M16 2.5v4M3 10h18' }],
  ],
  /* 폴더 */
  folder: [
    ['path', { d: 'M3.5 7.5a2.5 2.5 0 0 1 2.5-2.5h3.2a1.5 1.5 0 0 1 1.2.6l1.1 1.4H18a2.5 2.5 0 0 1 2.5 2.5v8.5a2.5 2.5 0 0 1-2.5 2.5H6a2.5 2.5 0 0 1-2.5-2.5z' }],
  ],
  /* 디데이 — 과녁 */
  dday: [
    ['circle', { cx: 12, cy: 12, r: 8.5 }],
    ['circle', { cx: 12, cy: 12, r: 4.2 }],
    ['circle', { cx: 12, cy: 12, r: 1, fill: 'currentColor', stroke: 'none' }],
  ],
  /* 설정 — 슬라이더 */
  settings: [
    ['path', { d: 'M4 7h5M13 7h7M4 12h11M19 12h1M4 17h3M11 17h9' }],
    ['circle', { cx: 11, cy: 7, r: 2 }],
    ['circle', { cx: 17, cy: 12, r: 2 }],
    ['circle', { cx: 9, cy: 17, r: 2 }],
  ],
  /* 가계부 — 지갑 */
  wallet: [
    ['path', { d: 'M3.5 8.5a2.5 2.5 0 0 1 2.5-2.5h11.5a2.5 2.5 0 0 1 2.5 2.5v9a2.5 2.5 0 0 1-2.5 2.5H6a2.5 2.5 0 0 1-2.5-2.5z' }],
    ['path', { d: 'M3.5 9.5V7.2a2 2 0 0 1 1.6-2l9.4-1.7' }],
    ['circle', { cx: 16.5, cy: 13, r: 1.25, fill: 'currentColor', stroke: 'none' }],
  ],
  search: [
    ['circle', { cx: 11, cy: 11, r: 6.5 }],
    ['path', { d: 'M20 20l-4.3-4.3' }],
  ],
  plus: [['path', { d: 'M12 5.5v13M5.5 12h13' }]],
  back: [['path', { d: 'M14.5 5.5L8 12l6.5 6.5' }]],
  edit: [['path', { d: 'M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3zM14.5 6.5l3 3' }]],
  /* 오늘로 이동 — 달력 안에 점 */
  jumpToday: [
    ['rect', { x: 3, y: 5, width: 18, height: 16, rx: 3 }],
    ['path', { d: 'M8 2.5v4M16 2.5v4M3 10h18' }],
    ['circle', { cx: 12, cy: 15.5, r: 1.9, fill: 'currentColor', stroke: 'none' }],
  ],
  close: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
  check: [['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]],
  bell: [
    ['path', { d: 'M18 8.5a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5z' }],
    ['path', { d: 'M13.7 19a2 2 0 0 1-3.4 0' }],
  ],
  photo: [
    ['rect', { x: 3, y: 5, width: 18, height: 14, rx: 3 }],
    ['path', { d: 'M3.5 16l4.5-4.5 3.5 3.5 3-3 6 5.5' }],
    ['circle', { cx: 8.5, cy: 9.5, r: 1.4 }],
  ],
  lock: [
    ['rect', { x: 4.5, y: 10, width: 15, height: 10.5, rx: 3 }],
    ['path', { d: 'M8 10V7.5a4 4 0 0 1 8 0V10' }],
  ],
  trash: [
    ['path', { d: 'M4.5 7h15M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12' }],
  ],
};

/**
 * 아이콘 엘리먼트를 만듭니다.
 * @param {string} name PATHS 의 키
 * @param {object} opts size(기본 24), strokeWidth(기본 1.75)
 */
export function icon(name, { size = 24, strokeWidth = 1.75, className = '' } = {}) {
  const spec = PATHS[name];
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', strokeWidth);
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (className) svg.setAttribute('class', className);
  if (!spec) return svg;

  for (const [tag, attrs] of spec) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.append(node);
  }
  return svg;
}

export function hasIcon(name) {
  return Object.prototype.hasOwnProperty.call(PATHS, name);
}
