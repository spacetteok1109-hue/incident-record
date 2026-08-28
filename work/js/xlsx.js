/*
 * xlsx.js — 엑셀 파일(.xlsx) 만들기
 *
 * 라이브러리 없이 만듭니다. .xlsx 는 XML 몇 장을 zip 으로 묶은 것이라,
 * 여기서 압축하지 않는(stored) zip 을 직접 씁니다. 파일이 조금 커지는 대신
 * 코드가 단순하고 브라우저 지원 걱정이 없습니다.
 */

/* ---------------- zip ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 압축하지 않는 zip 을 만듭니다. files = [{ name, text }] */
function zip(files) {
  const enc = new TextEncoder();
  const entries = files.map((f) => ({
    nameBytes: enc.encode(f.name),
    data: enc.encode(f.text),
  }));
  entries.forEach((e) => { e.crc = crc32(e.data); });

  const LOCAL = 30;
  const CENTRAL = 46;
  const EOCD = 22;
  const total = entries.reduce(
    (n, e) => n + LOCAL + e.nameBytes.length + e.data.length + CENTRAL + e.nameBytes.length,
    EOCD,
  );

  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  let off = 0;
  const u16 = (v) => { view.setUint16(off, v, true); off += 2; };
  const u32 = (v) => { view.setUint32(off, v >>> 0, true); off += 4; };
  const raw = (b) => { buf.set(b, off); off += b.length; };

  entries.forEach((e) => {
    e.offset = off;
    u32(0x04034b50);
    u16(20);            // 필요한 버전
    u16(0x0800);        // 파일 이름이 UTF-8
    u16(0);             // 압축 안 함
    u16(0); u16(0);     // 수정 시각 (쓰지 않음)
    u32(e.crc);
    u32(e.data.length);
    u32(e.data.length);
    u16(e.nameBytes.length);
    u16(0);
    raw(e.nameBytes);
    raw(e.data);
  });

  const centralStart = off;
  entries.forEach((e) => {
    u32(0x02014b50);
    u16(20); u16(20);
    u16(0x0800);
    u16(0);
    u16(0); u16(0);
    u32(e.crc);
    u32(e.data.length);
    u32(e.data.length);
    u16(e.nameBytes.length);
    u16(0); u16(0); u16(0); u16(0);
    u32(0);
    u32(e.offset);
    raw(e.nameBytes);
  });

  // 중앙 디렉터리 크기는 EOCD 를 쓰기 전에 재 둡니다.
  const centralSize = off - centralStart;
  u32(0x06054b50);
  u16(0); u16(0);
  u16(entries.length); u16(entries.length);
  u32(centralSize);
  u32(centralStart);
  u16(0);

  return new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/* ---------------- 시트 XML ---------------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c]));
}

/** 0 -> 'A', 25 -> 'Z', 26 -> 'AA' */
function colName(i) {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/**
 * 셀 하나. 숫자는 숫자로, 나머지는 글자로 넣습니다.
 * 금액 칸(s=2)은 1,234 처럼 쉼표가 찍히게 서식을 줍니다.
 */
function cell(ref, value, { header = false, money = false } = {}) {
  if (header) return `<c r="${ref}" s="1" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"${money ? ' s="2"' : ''}><v>${value}</v></c>`;
  }
  if (value === '' || value === null || value === undefined) return '';
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

/**
 * rows[0] 은 머리글로 봅니다.
 * moneyCols 에 든 열 번호는 금액 서식으로 찍습니다.
 */
function sheetXml(rows, { moneyCols = [], widths = [] } = {}) {
  const body = rows.map((row, r) => {
    const cells = row.map((v, c) =>
      cell(`${colName(c)}${r + 1}`, v, { header: r === 0, money: moneyCols.includes(c) }),
    ).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');

  const cols = widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';

  return `${XML_HEAD}<worksheet xmlns="${NS}">`
    + '<sheetViews><sheetView workbookViewId="0">'
    + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
    + '</sheetView></sheetViews>'
    + '<sheetFormatPr defaultRowHeight="16.5"/>'
    + cols
    + `<sheetData>${body}</sheetData></worksheet>`;
}

const STYLES = `${XML_HEAD}<styleSheet xmlns="${NS}">`
  + '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0"/></numFmts>'
  + '<fonts count="2">'
  + '<font><sz val="11"/><color theme="1"/><name val="맑은 고딕"/></font>'
  + '<font><b/><sz val="11"/><color theme="1"/><name val="맑은 고딕"/></font>'
  + '</fonts>'
  + '<fills count="3">'
  + '<fill><patternFill patternType="none"/></fill>'
  + '<fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFE9EDF5"/><bgColor indexed="64"/></patternFill></fill>'
  + '</fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="3">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
  + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '</cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';

/**
 * 엑셀 파일을 만듭니다.
 * sheets = [{ name, rows, moneyCols, widths }]
 */
export function buildXlsx(sheets) {
  const files = [];

  files.push({
    name: '[Content_Types].xml',
    text: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '</Types>',
  });

  files.push({
    name: '_rels/.rels',
    text: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/>`
      + '</Relationships>',
  });

  files.push({
    name: 'xl/workbook.xml',
    text: `${XML_HEAD}<workbook xmlns="${NS}" xmlns:r="${REL_NS}"><sheets>`
      + sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
      + '</sheets></workbook>',
  });

  files.push({
    name: 'xl/_rels/workbook.xml.rels',
    text: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${sheets.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/>`
      + '</Relationships>',
  });

  files.push({ name: 'xl/styles.xml', text: STYLES });

  sheets.forEach((s, i) => {
    files.push({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      text: sheetXml(s.rows, { moneyCols: s.moneyCols, widths: s.widths }),
    });
  });

  return zip(files);
}
