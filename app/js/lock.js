/* lock.js — 화면 잠금(PIN)
 *
 * PIN은 그대로 저장하지 않고 PBKDF2(SHA-256) 해시만 기기에 저장합니다.
 * 다른 사람이 기기를 잠깐 만졌을 때 앱 내용을 못 보게 하는 용도이며,
 * 저장된 데이터 자체를 암호화하지는 않습니다.
 */

import { getMeta, setMeta, del } from './db.js';

const ITERATIONS = 210000;

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBuf(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}

async function derive(pin, saltHex, iterations = ITERATIONS) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBuf(saltHex), iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return bufToHex(bits);
}

export async function getConfig() {
  return getMeta('lock', null);
}

export async function isEnabled() {
  const cfg = await getConfig();
  return !!(cfg && cfg.hash);
}

export async function setPin(pin) {
  if (!/^\d{4,10}$/.test(pin)) throw new Error('PIN은 숫자 4~10자리여야 합니다.');
  const salt = bufToHex(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await derive(pin, salt);
  await setMeta('lock', {
    salt, hash, iterations: ITERATIONS, autoLockMin: 5,
    // 자리 수를 적어 둬야 다 쳤을 때 한 번만 확인해 볼 수 있습니다.
    // 이 값을 볼 수 있는 사람은 이미 salt·hash 도 볼 수 있으므로 더 잃을 것이 없습니다.
    len: pin.length,
    fails: 0, lastFailAt: 0, createdAt: Date.now(),
  });
  return true;
}

/* 틀린 횟수가 쌓이면 다음 시도까지 기다리게 합니다.
   4자리 PIN은 경우의 수가 1만 개뿐이라, 막지 않으면 기기를 가진 사람이
   차례대로 넣어 볼 수 있습니다. */
const LOCKOUT_AFTER = 5;          // 이 횟수부터 기다리게 합니다
const LOCKOUT_STEP_MS = 15000;    // 한 번 더 틀릴 때마다 15초씩
const LOCKOUT_MAX_MS = 10 * 60 * 1000;

function waitMsFor(fails) {
  if (fails < LOCKOUT_AFTER) return 0;
  return Math.min(LOCKOUT_MAX_MS, (fails - LOCKOUT_AFTER + 1) * LOCKOUT_STEP_MS);
}

/** 지금 PIN을 넣을 수 있는지. 못 넣으면 남은 밀리초를 돌려줍니다. */
export async function lockoutRemainingMs() {
  const cfg = await getConfig();
  if (!cfg) return 0;
  const fails = Number(cfg.fails) || 0;
  const last = Number(cfg.lastFailAt) || 0;
  const left = waitMsFor(fails) - (Date.now() - last);
  return left > 0 ? left : 0;
}

export async function verify(pin) {
  const cfg = await getConfig();
  if (!cfg || !cfg.hash) return true;
  if (await lockoutRemainingMs() > 0) return false;

  const hash = await derive(pin, cfg.salt, cfg.iterations || ITERATIONS);
  // 길이가 같은 문자열끼리 상수 시간 비교
  let ok = hash.length === cfg.hash.length;
  if (ok) {
    let diff = 0;
    for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ cfg.hash.charCodeAt(i);
    ok = diff === 0;
  }

  const fresh = await getConfig();
  if (ok) {
    if (fresh && fresh.fails) await setMeta('lock', { ...fresh, fails: 0, lastFailAt: 0 });
  } else {
    await setMeta('lock', {
      ...fresh,
      fails: (Number(fresh?.fails) || 0) + 1,
      lastFailAt: Date.now(),
    });
  }
  return ok;
}

/** 저장해 둔 PIN 자리 수. 예전에 만들어 모르면 null. */
export async function pinLength() {
  const cfg = await getConfig();
  const n = Number(cfg?.len);
  return Number.isInteger(n) && n >= 4 && n <= 10 ? n : null;
}

export async function disable(pin) {
  if (!(await verify(pin))) return false;
  await del('meta', 'lock');
  return true;
}

export async function setAutoLockMinutes(min) {
  const cfg = await getConfig();
  if (!cfg) return;
  await setMeta('lock', { ...cfg, autoLockMin: Number(min) });
}

export async function autoLockMinutes() {
  const cfg = await getConfig();
  return cfg && cfg.autoLockMin != null ? Number(cfg.autoLockMin) : 5;
}
