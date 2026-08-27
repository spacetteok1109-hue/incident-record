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
  await setMeta('lock', { salt, hash, iterations: ITERATIONS, autoLockMin: 5, createdAt: Date.now() });
  return true;
}

export async function verify(pin) {
  const cfg = await getConfig();
  if (!cfg || !cfg.hash) return true;
  const hash = await derive(pin, cfg.salt, cfg.iterations || ITERATIONS);
  // 길이가 같은 문자열끼리 상수 시간 비교
  if (hash.length !== cfg.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ cfg.hash.charCodeAt(i);
  return diff === 0;
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
