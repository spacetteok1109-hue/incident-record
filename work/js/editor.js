/* editor.js — 팀원 · 현장 · 출역 · 가불 입력 시트 */

import { el, openSheet, confirmDialog, toast, pickerSheet } from './ui.js';
import * as store from './store.js';
import { GONGSU_OPTIONS, SITE_COLORS, BANKS } from './store.js';
import { comma, num, todayKey, won, gongsu as fmtGongsu, formatDate } from './util.js';

/* ---------------- 입력 조각 ---------------- */

/**
 * 자식들을 붙입니다. null 은 건너뜁니다.
 * (native append 는 null 을 'null' 이라는 글자로 넣어 버립니다.)
 */
function add(parent, ...nodes) {
  nodes.forEach((n) => { if (n) parent.append(n); });
}

function field(label, node, hint) {
  return el('div', { class: 'field' }, [
    el('label', { text: label }),
    node,
    hint ? el('div', { class: 'hint', text: hint }) : null,
  ]);
}

function textInput(value, opts = {}) {
  return el('input', {
    type: opts.type || 'text',
    value: value ?? '',
    placeholder: opts.placeholder || '',
    inputmode: opts.inputmode,
    maxlength: opts.maxlength,
    'data-autofocus': opts.autofocus || null,
  });
}

/**
 * 금액 칸. 입력하는 동안 자동으로 쉼표를 넣어 줍니다.
 * value 는 항상 숫자로 읽습니다.
 */
function moneyInput(value, { placeholder = '0', autofocus = false } = {}) {
  const input = el('input', {
    type: 'text',
    inputmode: 'numeric',
    value: value ? comma(value) : '',
    placeholder,
    'data-autofocus': autofocus || null,
  });
  input.addEventListener('input', () => {
    const caretAtEnd = input.selectionStart === input.value.length;
    const n = num(input.value);
    const text = input.value.trim() === '' ? '' : comma(n);
    if (text !== input.value) {
      input.value = text;
      if (caretAtEnd) input.setSelectionRange(text.length, text.length);
    }
  });
  return input;
}

/** 금액 빠른 입력 칩 (+1만 · +5만 · +10만 · 지우기) */
function moneyChips(input, steps = [10000, 50000, 100000]) {
  const row = el('div', { class: 'chip-row' });
  steps.forEach((s) => {
    row.append(el('button', {
      type: 'button',
      class: 'chip tap',
      text: `+${s / 10000}만`,
      onclick: () => { input.value = comma(num(input.value) + s); },
    }));
  });
  row.append(el('button', {
    type: 'button',
    class: 'chip tap',
    text: '지우기',
    onclick: () => { input.value = ''; },
  }));
  return row;
}

function switchRow(label, desc, checked, onToggle) {
  const knob = el('span', { class: 'switch', role: 'switch', 'aria-checked': checked ? 'true' : 'false' });
  const row = el('button', {
    type: 'button',
    class: 'switch-row',
    style: { width: '100%', textAlign: 'left' },
    onclick: () => {
      const next = knob.getAttribute('aria-checked') !== 'true';
      knob.setAttribute('aria-checked', next ? 'true' : 'false');
      onToggle(next);
    },
  }, [
    el('div', {}, [
      el('div', { class: 'label', text: label }),
      desc ? el('div', { class: 'desc', text: desc }) : null,
    ]),
    knob,
  ]);
  row.setChecked = (v) => knob.setAttribute('aria-checked', v ? 'true' : 'false');
  return row;
}

/** 하나만 고르는 칩 줄 */
function chipSelect(options, value, onPick) {
  const row = el('div', { class: 'chip-row' });
  const render = (current) => {
    row.textContent = '';
    options.forEach((opt) => {
      const on = String(opt.value) === String(current);
      row.append(el('button', {
        type: 'button',
        class: `chip tap${on ? ' accent' : ''}`,
        text: opt.label,
        onclick: () => { render(opt.value); onPick(opt.value); },
      }));
    });
  };
  render(value);
  return row;
}

function colorRow(value, onPick) {
  const row = el('div', { class: 'color-row' });
  const render = (current) => {
    row.textContent = '';
    SITE_COLORS.forEach((c) => {
      row.append(el('button', {
        type: 'button',
        class: 'color-dot',
        style: { background: c, outline: c === current ? '2px solid var(--text)' : 'none', outlineOffset: '2px' },
        'aria-label': '색 선택',
        onclick: () => { render(c); onPick(c); },
      }));
    });
  };
  render(value);
  return row;
}

function dateInput(value) {
  return el('input', { type: 'date', value: value || '' });
}

function deleteRow(label, onDelete) {
  return el('button', {
    type: 'button',
    class: 'btn danger',
    text: label,
    style: { width: '100%', marginTop: '18px' },
    onclick: onDelete,
  });
}

/* ---------------- 팀원 ---------------- */

export async function editWorker(id = null) {
  const existing = id ? await store.getWorker(id) : null;
  const draft = existing ? { ...existing } : store.blankWorker();
  const refs = {};

  return openSheet({
    title: existing ? '팀원 정보' : '팀원 추가',
    buildBody: ({ body, close }) => {
      const name = refs.name = textInput(draft.name, { placeholder: '홍길동', autofocus: !existing });
      const birth = refs.birth = textInput(draft.birthYear, { placeholder: '1968', inputmode: 'numeric', maxlength: 4 });
      const phone = refs.phone = textInput(draft.phone, { placeholder: '010-0000-0000', type: 'tel' });
      const wage = refs.wage = moneyInput(draft.dailyWage, { placeholder: '180,000' });
      const carPay = refs.carPay = moneyInput(draft.carPay, { placeholder: '30,000' });
      const bank = refs.bank = textInput(draft.bankName, { placeholder: '농협' });
      const account = refs.account = textInput(draft.bankAccount, { placeholder: '352-0000-0000-00', inputmode: 'numeric' });
      const holder = refs.holder = textInput(draft.bankHolder, { placeholder: '본인과 같으면 비워 두세요' });
      const memo = refs.memo = el('textarea', { rows: 2, placeholder: '기술·자격·특이사항' });
      memo.value = draft.memo || '';

      const carBox = el('div', { class: 'field', style: { display: draft.hasCar ? 'flex' : 'none' } }, [
        el('label', { text: '차량 수당 (하루)' }),
        carPay,
        moneyChips(carPay, [10000, 20000, 30000]),
        el('div', { class: 'hint', text: '자기 차로 나간 날에 일당과 별도로 얹어 줄 금액입니다. 0으로 두면 기록만 됩니다.' }),
      ]);

      const carSwitch = switchRow('자차 있음', '본인 차로 현장에 나갈 수 있는 팀원', draft.hasCar, (on) => {
        draft.hasCar = on;
        carBox.style.display = on ? 'flex' : 'none';
      });

      const activeSwitch = switchRow('활동 중', '끄면 목록에서 숨겨집니다. 지난 기록은 그대로 남습니다.', draft.active !== false, (on) => {
        draft.active = on;
      });

      const bankPick = el('button', {
        type: 'button',
        class: 'btn',
        text: '은행 고르기',
        onclick: async () => {
          const picked = await pickerSheet({
            title: '은행',
            value: bank.value,
            options: BANKS.map((b) => ({ value: b, label: b })),
          });
          if (picked) bank.value = picked;
        },
      });

      add(
        body,
        field('이름', name),
        el('div', { class: 'row' }, [
          field('생년', birth),
          field('연락처', phone),
        ]),
        field('기본 일당', wage, '배정할 때 이 금액이 자동으로 들어갑니다. 그날만 다르게 줄 수도 있습니다.'),
        moneyChips(wage, [10000, 50000, 100000]),
        el('div', { class: 'settings-group', style: { marginTop: '14px' } }, [carSwitch]),
        carBox,
        el('div', { class: 'section-title', style: { marginTop: '18px' }, text: '계좌' }),
        el('div', { class: 'row' }, [
          field('은행', bank),
          el('div', { class: 'field', style: { flex: '0 0 auto', justifyContent: 'flex-end' } }, [bankPick]),
        ]),
        field('계좌번호', account),
        field('예금주', holder),
        el('div', { class: 'section-title', style: { marginTop: '18px' }, text: '기타' }),
        field('메모', memo),
        el('div', { class: 'settings-group', style: { marginTop: '14px' } }, [activeSwitch]),
        existing ? deleteRow('이 팀원 삭제', async () => {
          const ok = await confirmDialog({
            title: '팀원을 삭제할까요?',
            message: `${existing.name} 님의 출역 기록과 가불 기록도 함께 지워집니다. 기록을 남기려면 대신 '활동 중'을 꺼 주세요.`,
            confirmLabel: '삭제',
            danger: true,
          });
          if (!ok) return;
          await store.deleteWorker(existing.id);
          toast('팀원을 삭제했습니다.');
          close('deleted');
        }) : null,
      );
    },
    onConfirm: async () => {
      const saved = await store.saveWorker({
        ...draft,
        name: refs.name.value,
        birthYear: refs.birth.value,
        phone: refs.phone.value,
        dailyWage: num(refs.wage.value),
        carPay: num(refs.carPay.value),
        bankName: refs.bank.value,
        bankAccount: refs.account.value,
        bankHolder: refs.holder.value,
        memo: refs.memo.value,
      });
      toast(existing ? '저장했습니다.' : `${saved.name} 님을 추가했습니다.`);
      return saved;
    },
  });
}

/* ---------------- 현장 ---------------- */

export async function editSite(id = null) {
  const existing = id ? await store.getSite(id) : null;
  const draft = existing ? { ...existing } : store.blankSite();
  const refs = {};

  return openSheet({
    title: existing ? '현장 정보' : '현장 추가',
    buildBody: ({ body, close }) => {
      const name = refs.name = textInput(draft.name, { placeholder: '○○아파트 신축', autofocus: !existing });
      const address = refs.address = textInput(draft.address, { placeholder: '경기 화성시 ○○로 12' });
      const price = refs.price = moneyInput(draft.unitPrice, { placeholder: '190,000' });
      const client = refs.client = textInput(draft.client, { placeholder: '○○건설 / 김소장' });
      const contact = refs.contact = textInput(draft.contact, { placeholder: '010-0000-0000', type: 'tel' });
      const start = refs.start = dateInput(draft.startDate);
      const end = refs.end = dateInput(draft.endDate);
      const memo = refs.memo = el('textarea', { rows: 2, placeholder: '주차·출입·작업 내용 등' });
      memo.value = draft.memo || '';

      const activeSwitch = switchRow('진행 중', '끄면 목록 아래로 내려갑니다. 기록은 그대로 남습니다.', draft.active !== false, (on) => {
        draft.active = on;
      });

      add(
        body,
        field('현장 이름', name),
        field('주소', address, '지도 앱에서 바로 열 수 있게 저장됩니다.'),
        field('현장 단가', price, '이 현장에서 통상 받는 하루 금액입니다. 배정 화면에 참고로 보여 줍니다.'),
        moneyChips(price, [10000, 50000, 100000]),
        el('div', { class: 'row', style: { marginTop: '14px' } }, [
          field('업체 · 원청', client),
          field('연락처', contact),
        ]),
        el('div', { class: 'row' }, [
          field('시작일', start),
          field('종료일', end),
        ]),
        field('현장 색', colorRow(draft.color, (c) => { draft.color = c; }), '달력에서 이 색 점으로 표시됩니다.'),
        field('메모', memo),
        el('div', { class: 'settings-group', style: { marginTop: '14px' } }, [activeSwitch]),
        existing ? deleteRow('이 현장 삭제', async () => {
          const ok = await confirmDialog({
            title: '현장을 삭제할까요?',
            message: `${existing.name} 의 출역 기록도 함께 지워집니다. 기록을 남기려면 대신 '진행 중'을 꺼 주세요.`,
            confirmLabel: '삭제',
            danger: true,
          });
          if (!ok) return;
          await store.deleteSite(existing.id);
          toast('현장을 삭제했습니다.');
          close('deleted');
        }) : null,
      );
    },
    onConfirm: async () => {
      const saved = await store.saveSite({
        ...draft,
        name: refs.name.value,
        address: refs.address.value,
        unitPrice: num(refs.price.value),
        client: refs.client.value,
        contact: refs.contact.value,
        startDate: refs.start.value,
        endDate: refs.end.value,
        memo: refs.memo.value,
      });
      toast(existing ? '저장했습니다.' : `${saved.name} 현장을 추가했습니다.`);
      return saved;
    },
  });
}

/* ---------------- 배정 (여러 명 한 번에) ---------------- */

/**
 * 하루치 배정 시트.
 * 현장을 고르고, 나갈 팀원을 골라서 한꺼번에 저장합니다.
 */
export async function assignSheet({ dateKey = todayKey(), siteId = '' } = {}) {
  const [workers, sites, sameDay] = await Promise.all([
    store.getWorkers({ includeInactive: false }),
    store.getSites({ includeInactive: false }),
    store.worksOfDate(dateKey),
  ]);

  if (!sites.length) {
    toast('현장을 먼저 등록해 주세요.');
    return null;
  }
  if (!workers.length) {
    toast('팀원을 먼저 등록해 주세요.');
    return null;
  }

  const state = {
    dateKey,
    siteId: siteId || sites[0].id,
    picks: new Map(),   // workerId -> { wage, gongsu, carUsed, carPay }
  };

  return openSheet({
    title: '현장 배정',
    confirmLabel: '배정하기',
    buildBody: ({ body, setConfirmEnabled }) => {
      setConfirmEnabled(false);

      const date = dateInput(state.dateKey);
      const summary = el('div', { class: 'notice' });
      const listWrap = el('div', { class: 'card-list', style: { marginTop: '10px' } });

      const siteChips = el('div', { class: 'chip-row' });

      const currentSite = () => sites.find((s) => s.id === state.siteId);

      function refreshSummary() {
        const n = state.picks.size;
        let total = 0;
        for (const [, v] of state.picks) {
          total += num(v.wage) * num(v.gongsu) + (v.carUsed ? num(v.carPay) : 0);
        }
        summary.textContent = '';
        summary.append(
          el('span', { class: 'ico', text: '🧾' }),
          el('span', { text: n ? `${n}명 · 오늘 나갈 일당 합계 ${won(total)}` : '나갈 팀원을 골라 주세요.' }),
        );
        setConfirmEnabled(n > 0);
      }

      function renderSites() {
        siteChips.textContent = '';
        sites.forEach((s) => {
          const on = s.id === state.siteId;
          siteChips.append(el('button', {
            type: 'button',
            class: `chip tap${on ? ' accent' : ''}`,
            onclick: () => { state.siteId = s.id; renderSites(); renderWorkers(); },
          }, [
            el('span', { class: 'color-dot', style: { background: s.color, width: '9px', height: '9px' } }),
            el('span', { text: s.name }),
          ]));
        });
        const site = currentSite();
        siteHint.textContent = site && site.unitPrice
          ? `${site.name} 단가 ${won(site.unitPrice)}${site.address ? ' · ' + site.address : ''}`
          : (site && site.address ? site.address : '');
      }

      const siteHint = el('div', { class: 'hint' });

      function renderWorkers() {
        listWrap.textContent = '';
        const already = new Set(
          sameDay.filter((w) => w.siteId === state.siteId).map((w) => w.workerId),
        );
        const elsewhere = new Map(
          sameDay.filter((w) => w.siteId !== state.siteId)
            .map((w) => [w.workerId, sites.find((s) => s.id === w.siteId)?.name || '다른 현장']),
        );

        workers.forEach((w) => {
          const picked = state.picks.get(w.id);
          const isDone = already.has(w.id);

          const detail = el('div', { style: { display: picked ? 'block' : 'none', marginTop: '10px' } });

          const head = el('button', {
            type: 'button',
            class: 'switch-row',
            style: { width: '100%', textAlign: 'left' },
            disabled: isDone || null,
            onclick: () => {
              if (isDone) return;
              if (state.picks.has(w.id)) state.picks.delete(w.id);
              else {
                const site = currentSite();
                state.picks.set(w.id, {
                  wage: num(w.dailyWage) || num(site?.unitPrice) || 0,
                  gongsu: 1,
                  carUsed: !!w.hasCar,
                  carPay: num(w.carPay),
                });
              }
              renderWorkers();
            },
          }, [
            el('div', { class: 'grow' }, [
              el('div', { class: 'label' }, [
                el('span', { text: w.name }),
                w.hasCar ? el('span', { class: 'chip', style: { marginLeft: '6px' }, text: '🚗 자차' }) : null,
                isDone ? el('span', { class: 'chip ok', style: { marginLeft: '6px' }, text: '배정됨' }) : null,
                elsewhere.has(w.id) ? el('span', { class: 'chip warn', style: { marginLeft: '6px' }, text: elsewhere.get(w.id) }) : null,
              ]),
              el('div', { class: 'desc', text: w.dailyWage ? `일당 ${won(w.dailyWage)}` : '일당 미등록' }),
            ]),
            el('span', { class: 'switch', role: 'switch', 'aria-checked': picked ? 'true' : 'false' }),
          ]);

          if (picked) {
            const wage = moneyInput(picked.wage);
            wage.addEventListener('input', () => { picked.wage = num(wage.value); refreshSummary(); });

            const carPay = moneyInput(picked.carPay);
            carPay.addEventListener('input', () => { picked.carPay = num(carPay.value); refreshSummary(); });

            const carBox = el('div', { class: 'field', style: { display: picked.carUsed ? 'flex' : 'none', marginTop: '8px' } }, [
              el('label', { text: '차량 수당' }), carPay,
            ]);

            detail.append(
              field('이 날 일당', wage),
              el('div', { class: 'field', style: { marginTop: '10px' } }, [
                el('label', { text: '공수' }),
                chipSelect(
                  GONGSU_OPTIONS.map((g) => ({ value: g, label: `${fmtGongsu(g)}공수` })),
                  picked.gongsu,
                  (v) => { picked.gongsu = num(v); refreshSummary(); },
                ),
              ]),
              el('div', { class: 'settings-group', style: { marginTop: '10px' } }, [
                switchRow('자기 차로 운행', '차량 수당을 따로 얹어 줍니다.', picked.carUsed, (on) => {
                  picked.carUsed = on;
                  carBox.style.display = on ? 'flex' : 'none';
                  refreshSummary();
                }),
              ]),
              carBox,
            );
          }

          listWrap.append(el('div', {
            class: 'item',
            style: isDone ? { opacity: '0.55' } : {},
          }, [el('div', { class: 'item-body', style: { width: '100%' } }, [head, detail])]));
        });

        refreshSummary();
      }

      date.addEventListener('change', async () => {
        state.dateKey = date.value || todayKey();
        const fresh = await store.worksOfDate(state.dateKey);
        sameDay.length = 0;
        sameDay.push(...fresh);
        renderWorkers();
      });

      add(
        body,
        field('날짜', date),
        el('div', { class: 'field', style: { marginTop: '14px' } }, [
          el('label', { text: '현장' }), siteChips, siteHint,
        ]),
        el('div', { class: 'section-title', style: { marginTop: '18px' }, text: '나갈 팀원' }),
        summary,
        listWrap,
      );

      renderSites();
      renderWorkers();
    },
    onConfirm: async () => {
      const rows = [...state.picks.entries()].map(([workerId, v]) => ({
        dateKey: state.dateKey,
        siteId: state.siteId,
        workerId,
        wage: num(v.wage),
        gongsu: num(v.gongsu),
        carUsed: !!v.carUsed,
        carPay: num(v.carPay),
      }));
      if (!rows.length) throw new Error('나갈 팀원을 골라 주세요.');
      await store.saveWorks(rows);
      toast(`${formatDate(state.dateKey)} · ${rows.length}명 배정했습니다.`);
      return rows;
    },
  });
}

/* ---------------- 출역 기록 하나 고치기 ---------------- */

export async function editWork(id) {
  const work = await store.getWork(id);
  if (!work) return null;
  const [workers, sites] = await Promise.all([store.getWorkers(), store.getSites()]);
  const draft = { ...work };
  const refs = {};

  return openSheet({
    title: '출역 기록',
    buildBody: ({ body, close }) => {
      const date = refs.date = dateInput(draft.dateKey);
      const wage = refs.wage = moneyInput(draft.wage);
      const carPay = refs.carPay = moneyInput(draft.carPay);
      const memo = refs.memo = el('textarea', { rows: 2, placeholder: '작업 내용 · 특이사항' });
      memo.value = draft.memo || '';

      const carBox = el('div', { class: 'field', style: { display: draft.carUsed ? 'flex' : 'none', marginTop: '8px' } }, [
        el('label', { text: '차량 수당' }), carPay,
      ]);

      const totalLine = el('div', { class: 'notice' });
      const refresh = () => {
        const t = num(wage.value) * num(draft.gongsu) + (draft.carUsed ? num(carPay.value) : 0);
        totalLine.textContent = '';
        totalLine.append(el('span', { class: 'ico', text: '💰' }), el('span', { text: `이 날 지급액 ${won(t)}` }));
      };
      wage.addEventListener('input', refresh);
      carPay.addEventListener('input', refresh);

      add(
        body,
        field('날짜', date),
        el('div', { class: 'field', style: { marginTop: '14px' } }, [
          el('label', { text: '현장' }),
          chipSelect(sites.map((s) => ({ value: s.id, label: s.name })), draft.siteId, (v) => { draft.siteId = v; }),
        ]),
        el('div', { class: 'field', style: { marginTop: '14px' } }, [
          el('label', { text: '팀원' }),
          chipSelect(workers.map((w) => ({ value: w.id, label: w.name })), draft.workerId, (v) => { draft.workerId = v; }),
        ]),
        field('일당', wage),
        el('div', { class: 'field', style: { marginTop: '10px' } }, [
          el('label', { text: '공수' }),
          chipSelect(
            GONGSU_OPTIONS.map((g) => ({ value: g, label: `${fmtGongsu(g)}공수` })),
            draft.gongsu,
            (v) => { draft.gongsu = num(v); refresh(); },
          ),
        ]),
        el('div', { class: 'settings-group', style: { marginTop: '14px' } }, [
          switchRow('자기 차로 운행', null, draft.carUsed, (on) => {
            draft.carUsed = on;
            carBox.style.display = on ? 'flex' : 'none';
            refresh();
          }),
          switchRow('지급 완료', '돈을 건넨 기록입니다.', draft.paid, (on) => { draft.paid = on; }),
        ]),
        carBox,
        totalLine,
        field('메모', memo),
        deleteRow('이 기록 삭제', async () => {
          const ok = await confirmDialog({ title: '기록을 삭제할까요?', message: '이 출역 기록만 지워집니다.', confirmLabel: '삭제', danger: true });
          if (!ok) return;
          await store.deleteWork(id);
          toast('기록을 삭제했습니다.');
          close('deleted');
        }),
      );
      refresh();
    },
    onConfirm: async () => {
      const saved = await store.saveWork({
        ...draft,
        dateKey: refs.date.value || draft.dateKey,
        wage: num(refs.wage.value),
        carPay: num(refs.carPay.value),
        memo: refs.memo.value,
      });
      toast('저장했습니다.');
      return saved;
    },
  });
}

/* ---------------- 가불 ---------------- */

export async function editAdvance({ workerId = '', id = null } = {}) {
  const workers = await store.getWorkers();
  const existing = id ? (await store.advancesOf(workerId)).find((a) => a.id === id) : null;
  const draft = existing ? { ...existing } : store.blankAdvance({ workerId, dateKey: todayKey() });
  const refs = {};

  return openSheet({
    title: existing ? '가불 기록' : '가불 · 상환 입력',
    buildBody: ({ body, close }) => {
      const date = refs.date = dateInput(draft.dateKey);
      const amount = refs.amount = moneyInput(draft.amount, { autofocus: !existing });
      const memo = refs.memo = el('textarea', { rows: 2, placeholder: '현금 / 계좌이체 등' });
      memo.value = draft.memo || '';

      const kindSeg = el('div', { class: 'seg' });
      const renderKind = () => {
        kindSeg.textContent = '';
        [['advance', '가불 (내가 줌)'], ['repay', '상환 (돌려받음)']].forEach(([v, label]) => {
          kindSeg.append(el('button', {
            type: 'button',
            text: label,
            'aria-pressed': draft.kind === v ? 'true' : 'false',
            onclick: () => { draft.kind = v; renderKind(); },
          }));
        });
      };
      renderKind();

      add(
        body,
        el('div', { class: 'field' }, [
          el('label', { text: '팀원' }),
          chipSelect(workers.map((w) => ({ value: w.id, label: w.name })), draft.workerId, (v) => { draft.workerId = v; }),
        ]),
        el('div', { class: 'field', style: { marginTop: '14px' } }, [
          el('label', { text: '구분' }), kindSeg,
        ]),
        el('div', { class: 'row', style: { marginTop: '14px' } }, [
          field('날짜', date),
        ]),
        field('금액', amount),
        moneyChips(amount, [50000, 100000, 500000]),
        field('메모', memo),
        existing ? deleteRow('이 기록 삭제', async () => {
          const ok = await confirmDialog({ title: '기록을 삭제할까요?', message: '가불 잔액이 다시 계산됩니다.', confirmLabel: '삭제', danger: true });
          if (!ok) return;
          await store.deleteAdvance(existing.id);
          toast('삭제했습니다.');
          close('deleted');
        }) : null,
      );
    },
    onConfirm: async () => {
      const saved = await store.saveAdvance({
        ...draft,
        dateKey: refs.date.value || todayKey(),
        amount: num(refs.amount.value),
        memo: refs.memo.value,
      });
      toast(saved.kind === 'repay' ? '상환을 기록했습니다.' : '가불을 기록했습니다.');
      return saved;
    },
  });
}
