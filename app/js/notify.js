/* notify.js — 일정 알림
 *
 * 알림은 서버 없이 기기 안에서만 처리합니다.
 * - 앱이 열려 있는 동안: 정확한 시각에 타이머로 알림을 띄웁니다.
 * - 앱이 닫혀 있는 동안: 브라우저가 지원하면 주기적 백그라운드 동기화
 *   (periodicSync)로 확인하고, 지원하지 않으면 앱을 다시 열었을 때
 *   놓친 알림을 모아서 보여 줍니다.
 */

import * as store from './store.js';
import { formatTime, relativeDateLabel } from './util.js';

const TICK_MS = 30000;      // 주기 점검 간격
const GRACE_MS = 60000;     // 이 시간 안에 올 알림은 바로 처리
let tickTimer = null;
let exactTimer = null;
let missedHandler = null;

export function permission() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

/** iOS는 홈 화면에 추가한 뒤에만 알림을 허용합니다. */
export function needsInstallForNotifications() {
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return isIOS && !isStandalone();
}

export async function requestPermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  try {
    const result = await Notification.requestPermission();
    if (result === 'granted') {
      await registerPeriodicSync();
      await store.getItems();
      scheduleNext();
    }
    return result;
  } catch {
    return Notification.permission;
  }
}

async function registerPeriodicSync() {
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (!reg || !('periodicSync' in reg)) return false;
    const status = await navigator.permissions?.query({ name: 'periodic-background-sync' });
    if (status && status.state !== 'granted') return false;
    await reg.periodicSync.register('check-reminders', { minInterval: 15 * 60 * 1000 });
    return true;
  } catch {
    return false;
  }
}

async function show(item) {
  const when = item.dueTime ? `${relativeDateLabel(item.dueDate)} ${formatTime(item.dueTime)}` : relativeDateLabel(item.dueDate);
  const folder = await store.getFolder(item.folderId);
  const body = [when, item.memo ? item.memo.slice(0, 80) : ''].filter(Boolean).join(' · ');
  const options = {
    body,
    tag: 'item-' + item.id,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: { itemId: item.id, url: './index.html?item=' + encodeURIComponent(item.id) },
    requireInteraction: false,
    silent: false,
  };
  const title = (folder ? `${folder.emoji} ` : '') + item.title;

  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg && reg.showNotification) {
      await reg.showNotification(title, options);
      return true;
    }
  } catch {
    /* 아래 폴백 */
  }
  try {
    // eslint-disable-next-line no-new
    new Notification(title, options);
    return true;
  } catch {
    return false;
  }
}

/** 지금 시점에 알려야 할 항목을 찾아 알림을 띄웁니다. */
export async function checkDue() {
  store.invalidate();
  const items = await store.getItems();
  const now = Date.now();
  const due = items.filter((it) =>
    !it.done && it.remindAt && !it.notifiedAt && it.remindAt <= now + GRACE_MS);

  if (!due.length) return [];

  const canNotify = permission() === 'granted';
  for (const it of due) {
    if (canNotify) await show(it);
    await store.markNotified(it.id);
  }
  // 알림 권한이 없으면 앱 안에서 배너로 알려 줍니다.
  if (!canNotify && missedHandler) missedHandler(due);
  return due;
}

/** 가장 가까운 알림 시각에 정확히 맞춰 타이머를 겁니다. */
async function scheduleNext() {
  clearTimeout(exactTimer);
  const items = await store.getItems();
  const now = Date.now();
  const next = items
    .filter((it) => !it.done && it.remindAt && !it.notifiedAt && it.remindAt > now)
    .sort((a, b) => a.remindAt - b.remindAt)[0];
  if (!next) return;
  const delay = Math.min(next.remindAt - now + 500, 6 * 3600000);
  exactTimer = setTimeout(async () => {
    await checkDue();
    scheduleNext();
  }, Math.max(delay, 250));
}

async function tick() {
  await checkDue();
  await scheduleNext();
}

/**
 * 알림 스케줄러를 시작합니다.
 * onMissed(items)는 알림 권한이 없거나 앱이 꺼져 있어 놓친 알림을
 * 앱 안에서 보여 주고 싶을 때 호출됩니다.
 */
export function start({ onMissed } = {}) {
  missedHandler = onMissed || null;
  stop();
  tickTimer = setInterval(tick, TICK_MS);
  tick();
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
  store.subscribe(() => scheduleNext());
  if (permission() === 'granted') registerPeriodicSync();
}

function onVisible() {
  if (document.visibilityState === 'visible') tick();
}

export function stop() {
  clearInterval(tickTimer);
  clearTimeout(exactTimer);
  tickTimer = null;
  exactTimer = null;
  document.removeEventListener('visibilitychange', onVisible);
  window.removeEventListener('focus', onVisible);
}

/** 설정 화면의 '테스트 알림' */
export async function testNotification() {
  if (permission() !== 'granted') return false;
  const options = {
    body: '알림이 이렇게 표시됩니다.',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: 'test-notification',
  };
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg && reg.showNotification) {
      await reg.showNotification('테스트 알림 🔔', options);
      return true;
    }
    new Notification('테스트 알림 🔔', options);
    return true;
  } catch {
    return false;
  }
}
