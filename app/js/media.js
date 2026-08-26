/* media.js — 사진 업로드, 축소, 저장 (모두 기기 내부에서 처리) */

import * as db from './db.js';

const MAX_EDGE = 1600;     // 원본 저장 시 최대 변
const THUMB_EDGE = 360;    // 목록용 썸네일 최대 변
const JPEG_QUALITY = 0.82;
const THUMB_QUALITY = 0.7;

const urlCache = new Map(); // photoId -> objectURL

async function loadBitmap(file) {
  if (window.createImageBitmap) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* 아래 폴백으로 진행 */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('이미지를 읽을 수 없습니다.'));
      el.src = url;
    });
    return img;
  } finally {
    // 그리기가 끝난 뒤 해제해야 하므로 약간 늦춥니다.
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

function scaledSize(w, h, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

async function drawToBlob(bitmap, maxEdge, quality) {
  const sw = bitmap.width;
  const sh = bitmap.height;
  const { w, h } = scaledSize(sw, sh, maxEdge);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  canvas.width = 0;
  canvas.height = 0;
  return { blob, w, h };
}

/**
 * 파일을 축소해서 IndexedDB에 저장하고 사진 레코드를 돌려줍니다.
 * itemId는 나중에 항목을 저장할 때 attachPhotos()로 연결할 수 있습니다.
 */
export async function addPhoto(file, itemId = null) {
  if (!file || !file.type.startsWith('image/')) {
    throw new Error('이미지 파일만 추가할 수 있습니다.');
  }
  const bitmap = await loadBitmap(file);
  const full = await drawToBlob(bitmap, MAX_EDGE, JPEG_QUALITY);
  const thumb = await drawToBlob(bitmap, THUMB_EDGE, THUMB_QUALITY);
  if (bitmap.close) bitmap.close();
  if (!full.blob) throw new Error('이미지를 변환하지 못했습니다.');

  const photo = {
    id: db.uid(),
    itemId,
    name: file.name || 'photo.jpg',
    type: 'image/jpeg',
    width: full.w,
    height: full.h,
    size: full.blob.size,
    blob: full.blob,
    thumb: thumb.blob || null,
    createdAt: Date.now(),
  };
  await db.put('photos', photo);
  return photo;
}

export async function getPhoto(id) {
  return db.get('photos', id);
}

export async function getPhotos(ids) {
  if (!ids || !ids.length) return [];
  const rows = await Promise.all(ids.map((id) => db.get('photos', id)));
  return rows.filter(Boolean);
}

/** 저장된 사진의 표시용 URL (썸네일 우선) */
export function photoURL(photo, { full = false } = {}) {
  const key = photo.id + (full ? ':full' : ':thumb');
  if (urlCache.has(key)) return urlCache.get(key);
  const blob = full ? photo.blob : (photo.thumb || photo.blob);
  const url = URL.createObjectURL(blob);
  urlCache.set(key, url);
  return url;
}

export function releasePhotoURLs() {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}

export async function attachPhotos(photoIds, itemId) {
  for (const id of photoIds) {
    const p = await db.get('photos', id);
    if (p && p.itemId !== itemId) await db.put('photos', { ...p, itemId });
  }
}

export async function deletePhoto(id) {
  for (const suffix of [':thumb', ':full']) {
    const key = id + suffix;
    if (urlCache.has(key)) {
      URL.revokeObjectURL(urlCache.get(key));
      urlCache.delete(key);
    }
  }
  await db.del('photos', id);
}

/** 항목에 연결되지 않은 채 남은 사진 정리 (편집 중 취소 등) */
export async function purgeOrphanPhotos() {
  const [photos, items] = await Promise.all([db.getAll('photos'), db.getAll('items')]);
  const used = new Set();
  items.forEach((it) => (it.photoIds || []).forEach((id) => used.add(id)));
  let n = 0;
  for (const p of photos) {
    if (!used.has(p.id)) {
      await deletePhoto(p.id);
      n++;
    }
  }
  return n;
}

export async function photoStorageSize() {
  const photos = await db.getAll('photos');
  return photos.reduce((sum, p) => sum + (p.size || (p.blob ? p.blob.size : 0)) + (p.thumb ? p.thumb.size : 0), 0);
}
