/*
 * export.js — 기기에 저장하는 내보내기
 *
 *   · 엑셀(.xlsx)  전체 기록을 시트 5장으로
 *   · 정산서       인쇄하거나 PDF로 저장할 수 있는 문서
 *   · CSV          그 달 정산표만 간단히
 *
 * 어느 것도 서버로 보내지 않습니다. 만들어진 파일은 기기에 저장되거나
 * 공유 시트를 통해 사용자가 직접 고른 앱으로 넘어갑니다.
 */

import * as db from './db.js';
import * as store from './store.js';
import { el, toast } from './ui.js';
import {
  WEEKDAYS, fromDateKey, todayKey, num, comma, won, formatMonth, formatDate,
  formatDateShort, gongsu as fmtGongsu,
} from './util.js';
import { buildXlsx } from './xlsx.js';

/* ==========================================================
   파일 저장 (공유 시트 → 다운로드 순서로 시도)
   ========================================================== */

export async function saveFile(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });

  // 휴대전화에서는 공유 시트가 가장 편합니다. (파일 앱 · 카톡 · 메일 등)
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
      // 공유가 막혀 있으면 아래 다운로드로 넘어갑니다.
    }
  }

  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
  return 'downloaded';
}

function savedMessage(how, filename) {
  if (how === 'cancelled') return null;
  if (how === 'shared') return `${filename} 을 보냈습니다.`;
  return `${filename} 을 저장했습니다.`;
}

/* ==========================================================
   엑셀 (전체 기록)
   ========================================================== */

function yn(v) { return v ? 'O' : ''; }

function dayName(dateKey) {
  const d = fromDateKey(dateKey);
  return d ? WEEKDAYS[d.getDay()] : '';
}

/** 엑셀에 넣을 시트 5장을 만듭니다. */
export async function buildSheets() {
  const [workers, sites, months, balances] = await Promise.all([
    store.getWorkers(), store.getSites(), store.activeMonths(), store.advanceBalances(),
  ]);
  const workerName = (id) => workers.find((w) => w.id === id)?.name || '(삭제됨)';
  const siteName = (id) => sites.find((s) => s.id === id)?.name || '(삭제됨)';

  const 팀원 = [
    ['이름', '생년', '연락처', '일당', '자차', '차량수당', '은행', '계좌번호', '예금주', '가불잔액', '상태', '메모'],
    ...workers.map((w) => [
      w.name, w.birthYear || '', w.phone || '', num(w.dailyWage), yn(w.hasCar), num(w.carPay),
      w.bankName || '', w.bankAccount || '', w.bankHolder || '',
      num(balances[w.id] || 0), w.active === false ? '숨김' : '활동', w.memo || '',
    ]),
  ];

  const 현장 = [
    ['현장명', '주소', '단가', '업체·원청', '연락처', '시작일', '종료일', '상태', '메모'],
    ...sites.map((s) => [
      s.name, s.address || '', num(s.unitPrice), s.client || '', s.contact || '',
      s.startDate || '', s.endDate || '', s.active === false ? '종료' : '진행', s.memo || '',
    ]),
  ];

  const works = (await db.getAll('works')).slice()
    .sort((a, b) => (a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0));
  const 출역 = [
    ['날짜', '요일', '현장', '팀원', '일당', '공수', '일당합계', '자차', '차량수당', '지급액', '지급완료', '메모'],
    ...works.map((w) => [
      w.dateKey, dayName(w.dateKey), siteName(w.siteId), workerName(w.workerId),
      num(w.wage), num(w.gongsu), store.workWagePart(w),
      yn(w.carUsed), store.workCarPart(w), store.workTotal(w),
      yn(w.paid), w.memo || '',
    ]),
  ];

  const advances = (await db.getAll('advances')).slice()
    .sort((a, b) => (a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0));
  const 가불 = [
    ['날짜', '팀원', '구분', '금액', '메모'],
    ...advances.map((a) => [
      a.dateKey, workerName(a.workerId), a.kind === 'repay' ? '상환' : '가불', num(a.amount), a.memo || '',
    ]),
  ];

  const 월정산 = [['월', '팀원', '출역일수', '공수', '일당합계', '차량수당', '총액', '가불', '상환', '실지급', '가불잔액']];
  for (const m of months.slice().sort()) {
    const rep = await store.monthlyReport(m);
    rep.byWorker.forEach((r) => {
      월정산.push([formatMonth(m), r.name, r.days, r.gongsu, r.wagePay, r.carPay, r.total,
        r.advance, r.repay, r.net, r.balance]);
    });
    if (rep.byWorker.length) {
      const t = rep.totals;
      월정산.push([formatMonth(m), '합계', t.days, t.gongsu, t.wagePay, t.carPay, t.total,
        t.advance, t.repay, t.net, '']);
    }
  }

  return [
    { name: '팀원', rows: 팀원, moneyCols: [3, 5, 9], widths: [12, 8, 15, 11, 6, 10, 10, 20, 10, 11, 7, 24] },
    { name: '현장', rows: 현장, moneyCols: [2], widths: [18, 28, 11, 14, 15, 12, 12, 7, 24] },
    { name: '출역', rows: 출역, moneyCols: [4, 6, 8, 9], widths: [12, 6, 18, 12, 11, 7, 11, 6, 10, 11, 9, 20] },
    { name: '가불', rows: 가불, moneyCols: [3], widths: [12, 12, 8, 12, 24] },
    { name: '월정산', rows: 월정산, moneyCols: [4, 5, 6, 7, 8, 9, 10], widths: [13, 12, 10, 7, 12, 11, 12, 11, 11, 12, 11] },
  ];
}

export async function exportWorkbook() {
  const sheets = await buildSheets();
  const rows = sheets.reduce((n, s) => n + s.rows.length - 1, 0);
  if (!rows) { toast('내보낼 기록이 없습니다.'); return; }
  const filename = `현장관리_${todayKey()}.xlsx`;
  const how = await saveFile(buildXlsx(sheets), filename);
  const msg = savedMessage(how, filename);
  if (msg) toast(msg);
}

/* ==========================================================
   CSV (그 달 정산표)
   ========================================================== */

function toCsv(rows) {
  const body = rows.map((r) => r.map((c) => {
    const s = String(c ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n');
  // 엑셀에서 한글이 깨지지 않도록 BOM 을 붙입니다.
  return new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8' });
}

export async function exportMonthCsv(rep) {
  const rows = [['이름', '출역일수', '공수', '일당합계', '차량수당', '총액', '가불', '상환', '실지급', '가불잔액']];
  rep.byWorker.forEach((r) => {
    rows.push([r.name, r.days, r.gongsu, r.wagePay, r.carPay, r.total, r.advance, r.repay, r.net, r.balance]);
  });
  const t = rep.totals;
  rows.push(['합계', t.days, t.gongsu, t.wagePay, t.carPay, t.total, t.advance, t.repay, t.net, '']);

  const filename = `정산_${rep.month}.csv`;
  const how = await saveFile(toCsv(rows), filename);
  const msg = savedMessage(how, filename);
  if (msg) toast(msg);
}

/* ==========================================================
   정산서 문서 (인쇄 · PDF 저장)
   ========================================================== */

function docTable(head, rows, { align = [], foot = null } = {}) {
  const cell = (tag, v, i) => el(tag, { class: align[i] === 'r' ? 'r' : align[i] === 'c' ? 'c' : '', text: String(v ?? '') });
  const table = el('table', { class: 'doc-tbl' }, [
    el('thead', {}, [el('tr', {}, head.map((h, i) => cell('th', h, i)))]),
    el('tbody', {}, rows.map((r) => el('tr', {}, r.map((v, i) => cell('td', v, i))))),
  ]);
  if (foot) table.append(el('tfoot', {}, [el('tr', {}, foot.map((v, i) => cell('td', v, i)))]));
  // 좁은 화면에서는 표만 가로로 밀리게 감싸 둡니다. 인쇄할 때는 그대로 펴집니다.
  return el('div', { class: 'doc-tbl-wrap' }, [table]);
}

/** 한 달 전체 정산서 */
async function monthStatement(mKey) {
  const rep = await store.monthlyReport(mKey);
  const workers = await store.getWorkers();
  const workerById = new Map(workers.map((w) => [w.id, w]));
  const t = rep.totals;

  const doc = el('article', { class: 'doc' });
  doc.append(
    el('header', { class: 'doc-head' }, [
      el('h1', { text: `${formatMonth(mKey)} 현장 정산서` }),
      el('div', { class: 'doc-meta', text: `작성일 ${formatDate(todayKey(), { withYear: true })} · 팀원 ${t.workerCount}명 · 현장 ${t.siteCount}곳 · 나간 날 ${t.workDays}일` }),
    ]),
  );

  doc.append(
    el('div', { class: 'doc-sum' }, [
      el('div', {}, [el('b', { text: won(t.total) }), el('span', { text: '총액' })]),
      el('div', {}, [el('b', { text: won(t.advance) }), el('span', { text: '가불' })]),
      el('div', { class: 'hi' }, [el('b', { text: won(t.net) }), el('span', { text: '실지급액' })]),
    ]),
  );

  doc.append(el('h2', { text: '팀원별' }));
  doc.append(docTable(
    ['이름', '출역', '공수', '일당 합계', '차량 수당', '총액', '가불', '상환', '실지급'],
    rep.byWorker.map((r) => [
      r.name, `${r.days}일`, fmtGongsu(r.gongsu), comma(r.wagePay),
      r.carPay ? comma(r.carPay) : '-', comma(r.total),
      r.advance ? comma(r.advance) : '-', r.repay ? comma(r.repay) : '-', comma(r.net),
    ]),
    {
      align: ['', 'c', 'c', 'r', 'r', 'r', 'r', 'r', 'r'],
      foot: ['합계', `${t.days}일`, fmtGongsu(t.gongsu), comma(t.wagePay),
        t.carPay ? comma(t.carPay) : '-', comma(t.total),
        t.advance ? comma(t.advance) : '-', t.repay ? comma(t.repay) : '-', comma(t.net)],
    },
  ));

  if (rep.bySite.length) {
    doc.append(el('h2', { text: '현장별' }));
    doc.append(docTable(
      ['현장', '투입', '인원', '나간 일당'],
      rep.bySite.map((r) => [r.name, `${r.days}명일`, `${r.headcount}명`, comma(r.total)]),
      { align: ['', 'c', 'c', 'r'] },
    ));
  }

  const payRows = rep.byWorker
    .filter((r) => r.net !== 0 && r.worker)
    .map((r) => {
      const w = workerById.get(r.workerId);
      const acct = w && w.bankAccount ? `${w.bankName || ''} ${w.bankAccount}`.trim() : '-';
      return [r.name, acct, w?.bankHolder || '', comma(r.net)];
    });
  if (payRows.length) {
    doc.append(el('h2', { text: '입금 계좌' }));
    doc.append(docTable(['이름', '계좌', '예금주', '실지급'], payRows, { align: ['', '', '', 'r'] }));
  }

  doc.append(el('p', { class: 'doc-note', text: '실지급액 = 일당 합계 + 차량 수당 − 그 달 가불 + 상환' }));
  return { doc, filename: `정산서_${mKey}` };
}

/** 팀원 한 사람의 명세서 */
async function workerStatement(mKey, workerId) {
  const rep = await store.monthlyReport(mKey);
  const row = rep.byWorker.find((r) => r.workerId === workerId);
  if (!row) return null;
  const worker = await store.getWorker(workerId);
  const sites = await store.getSites();
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const works = (await store.worksOfMonth(mKey))
    .filter((w) => w.workerId === workerId)
    .sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1));

  const doc = el('article', { class: 'doc' });
  doc.append(el('header', { class: 'doc-head' }, [
    el('h1', { text: `${row.name} · ${formatMonth(mKey)} 급여 명세서` }),
    el('div', { class: 'doc-meta', text: `작성일 ${formatDate(todayKey(), { withYear: true })}${worker?.bankAccount ? ` · ${worker.bankName || ''} ${worker.bankAccount}` : ''}` }),
  ]));

  doc.append(el('div', { class: 'doc-sum' }, [
    el('div', {}, [el('b', { text: `${row.days}일` }), el('span', { text: `출역 (${fmtGongsu(row.gongsu)}공수)` })]),
    el('div', {}, [el('b', { text: won(row.total) }), el('span', { text: '총액' })]),
    el('div', { class: 'hi' }, [el('b', { text: won(row.net) }), el('span', { text: '실지급액' })]),
  ]));

  doc.append(el('h2', { text: '날짜별 내역' }));
  doc.append(docTable(
    ['날짜', '현장', '일당', '공수', '자차', '지급액'],
    works.map((w) => [
      formatDateShort(w.dateKey),
      siteById.get(w.siteId)?.name || '(삭제됨)',
      comma(w.wage), fmtGongsu(w.gongsu),
      w.carUsed ? comma(store.workCarPart(w)) : '-',
      comma(store.workTotal(w)),
    ]),
    {
      align: ['c', '', 'r', 'c', 'r', 'r'],
      foot: ['합계', `${row.days}일`, '', fmtGongsu(row.gongsu), row.carPay ? comma(row.carPay) : '-', comma(row.total)],
    },
  ));

  const calc = [['일당 합계', comma(row.wagePay)]];
  if (row.carPay) calc.push(['차량 수당', comma(row.carPay)]);
  calc.push(['총액', comma(row.total)]);
  if (row.advance) calc.push(['가불 (미리 받은 돈)', `−${comma(row.advance)}`]);
  if (row.repay) calc.push(['상환 (돌려준 돈)', `+${comma(row.repay)}`]);
  calc.push(['실지급액', comma(row.net)]);

  doc.append(el('h2', { text: '정산' }));
  doc.append(docTable(['항목', '금액'], calc.slice(0, -1), {
    align: ['', 'r'],
    foot: calc[calc.length - 1],
  }));

  if (row.balance) {
    doc.append(el('p', { class: 'doc-note', text: `이 달 이후로 남은 가불 잔액: ${won(row.balance)}` }));
  }
  return { doc, filename: `명세서_${row.name}_${mKey}` };
}

/**
 * 문서를 화면 가득 띄웁니다.
 * '인쇄' 를 누르면 브라우저 인쇄 창이 열리고, 거기서 PDF 로 저장할 수 있습니다.
 */
export async function openStatement({ month, workerId = null }) {
  const built = workerId ? await workerStatement(month, workerId) : await monthStatement(month);
  if (!built) { toast('이 달에는 기록이 없습니다.'); return; }

  const view = el('div', { class: 'doc-view', id: 'print-doc' });
  const close = () => {
    view.remove();
    document.body.style.overflow = '';
  };

  view.append(
    el('div', { class: 'doc-bar' }, [
      el('button', { type: 'button', text: '닫기', onclick: close }),
      el('span', { class: 'sp' }),
      el('button', {
        type: 'button',
        class: 'primary',
        text: '인쇄 · PDF 저장',
        onclick: () => window.print(),
      }),
    ]),
    el('div', { class: 'doc-scroll' }, [built.doc]),
  );

  document.body.append(view);
  document.body.style.overflow = 'hidden';
  view.scrollTop = 0;
}
