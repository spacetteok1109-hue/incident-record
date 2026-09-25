/* ocr.js — 사진 속 실 번호(글자)를 읽어 위치를 알려 줍니다.
   글자 인식 라이브러리는 처음 쓸 때만 인터넷에서 받아 옵니다(그 뒤로는 브라우저가 기억).
   못 받아 오면 조용히 실패하고, 번호는 손으로 적어 넣으면 됩니다. */

const SOURCES = [
  {
    lib: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
    worker: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
    core: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.0',
  },
  {
    lib: 'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js',
    worker: 'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/worker.min.js',
    core: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.0',
  },
];
const LANG = 'https://tessdata.projectnaptha.com/4.0.0';

let workerPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`불러오기 실패: ${src}`));
    document.head.append(s);
  });
}

export function isReady() {
  return !!workerPromise;
}

/** 글자 인식기를 준비합니다(처음 한 번만 시간이 걸립니다). */
export function ensureEngine(onProgress) {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    let lastError = null;
    for (const src of SOURCES) {
      try {
        if (!window.Tesseract) await loadScript(src.lib);
        const worker = await window.Tesseract.createWorker('eng', 1, {
          workerPath: src.worker,
          corePath: src.core,
          langPath: LANG,
          logger: (m) => {
            if (onProgress && typeof m.progress === 'number') onProgress(m.status, m.progress);
          },
        });
        await worker.setParameters({
          tessedit_char_whitelist: '0123456789Bblancwhite',
          preserve_interword_spaces: '1',
        });
        return worker;
      } catch (e) {
        lastError = e;
      }
    }
    workerPromise = null;
    throw lastError || new Error('글자 인식기를 준비하지 못했습니다.');
  })();
  return workerPromise;
}

function collectWords(data) {
  if (Array.isArray(data.words) && data.words.length) return data.words;
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.words) out.push(...n.words);
      walk(n.paragraphs || n.lines || n.blocks);
    }
  };
  walk(data.blocks);
  return out;
}

/**
 * 사진에서 글자를 모두 읽어 위치와 함께 돌려줍니다.
 * @returns {Promise<Array<{text:string, x:number, y:number, w:number, h:number, confidence:number}>>}
 */
export async function readWords(canvas, onProgress) {
  const worker = await ensureEngine(onProgress);
  const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true });
  return collectWords(data)
    .map((wd) => {
      const b = wd.bbox || {};
      return {
        text: String(wd.text || '').trim(),
        x: b.x0 ?? 0,
        y: b.y0 ?? 0,
        w: (b.x1 ?? 0) - (b.x0 ?? 0),
        h: (b.y1 ?? 0) - (b.y0 ?? 0),
        confidence: wd.confidence ?? 0,
      };
    })
    .filter((wd) => wd.text && wd.w > 0 && wd.h > 0);
}

/** 찾는 번호/표시와 같은 글자만 골라냅니다. */
export function pickMatches(words, query) {
  const key = normalize(query);
  if (!key) return [];
  const exact = words.filter((wd) => normalize(wd.text) === key);
  if (exact.length) return exact;
  return words.filter((wd) => normalize(wd.text).includes(key));
}

export function normalize(text) {
  return String(text).toLowerCase().replace(/[^0-9a-z]/g, '');
}
