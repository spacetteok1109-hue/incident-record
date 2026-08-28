/* build-standalone.mjs — 앱 전체를 파일 하나(standalone.html)로 묶습니다.
 *
 *   node floss/build-standalone.mjs
 *
 * 스타일·스크립트·색상표를 모두 페이지 안에 넣어, 파일 하나만 열면 그대로 돌아갑니다.
 * 준비물은 Node 뿐이고 설치할 것은 없습니다.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// 서로를 부르는 순서대로. 뒤쪽 모듈이 앞쪽 모듈을 씁니다.
const MODULES = ['color', 'detect', 'crop', 'sample', 'palette', 'ocr', 'ui', 'db', 'app'];

/** `import { a, b as c } from './x.js'` 같은 줄을 찾아 어떤 모듈을 쓰는지 알아냅니다. */
function parseImports(code) {
  const uses = [];
  const body = code.replace(
    /^import\s+([\s\S]*?)\s+from\s+'\.\/([a-z]+)\.js';\s*$/gm,
    (_, what, from) => {
      const star = what.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (star) {
        uses.push(`const ${star[1]} = __m.${from};`);
        return '';
      }
      const names = what.replace(/[{}]/g, '').split(',').map((n) => n.trim()).filter(Boolean)
        .map((n) => {
          const as = n.split(/\s+as\s+/);
          return as.length === 2 ? `${as[0]}: ${as[1]}` : n;
        });
      uses.push(`const { ${names.join(', ')} } = __m.${from};`);
      return '';
    },
  );
  return { uses, body };
}

/** `export` 를 떼어 내고, 밖으로 내보내던 이름을 모아 둡니다. */
function parseExports(code) {
  const names = [];
  const body = code.replace(
    /^export\s+(async\s+function|function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm,
    (_, kind, name) => {
      names.push(name);
      return `${kind} ${name}`;
    },
  );
  if (/^export\s/m.test(body)) {
    throw new Error(`아직 처리하지 못한 export 가 남아 있습니다:\n${body.match(/^export\s.*$/m)[0]}`);
  }
  return { names, body };
}

const chunks = MODULES.map((name) => {
  const source = read(`js/${name}.js`);
  const { uses, body } = parseImports(source);
  const { names, body: stripped } = parseExports(body);
  return `__m.${name} = (function () {
${uses.map((u) => `  ${u}`).join('\n')}
${stripped}
  return { ${names.join(', ')} };
})();`;
});

const html = read('index.html');
const css = read('css/style.css');
const dmc = JSON.parse(read('data/dmc.json'));

const script = `<script type="module">
/* 실 자르기 · 색코드 — 한 파일짜리 판.
   floss/ 폴더의 원본에서 build-standalone.mjs 로 만들어 냅니다. 여기서 직접 고치지 마세요. */
globalThis.__FLOSS_STANDALONE__ = true;
globalThis.__FLOSS_DATA__ = { dmc: ${JSON.stringify(dmc)} };
const __m = {};
${chunks.join('\n\n')}
</script>`;

const out = html
  // 바깥 파일을 부르는 자리들을 페이지 안 내용으로 바꿉니다.
  .replace(/^\s*<link rel="manifest"[^>]*>\n/m, '')
  .replace(/^\s*<link rel="apple-touch-icon"[^>]*>\n/m, '')
  .replace(/^\s*<link rel="icon"[^>]*>\n/m, '')
  // 함수로 바꿔 넣습니다. 문자열로 넘기면 내용 속 '$$' 가 '$' 로 줄어듭니다.
  .replace('<link rel="stylesheet" href="./css/style.css" />', () => `<style>\n${css}\n  </style>`)
  .replace('<script type="module" src="./js/app.js"></script>', () => script);

if (out.includes('./js/') || out.includes('./css/')) {
  throw new Error('아직 바깥 파일을 부르는 자리가 남아 있습니다.');
}

writeFileSync(join(ROOT, 'standalone.html'), out);
const kb = (Buffer.byteLength(out) / 1024).toFixed(0);
console.log(`standalone.html 을 만들었습니다 · ${kb} KB · 색 ${dmc.colors.length}개 포함`);

// --artifact <경로> 를 주면 문서 뼈대(<html>·<head>·<body>)를 뺀 판도 만듭니다.
// 페이지 뼈대를 대신 씌워 주는 곳에 올릴 때 씁니다.
const flag = process.argv.indexOf('--artifact');
if (flag > -1 && process.argv[flag + 1]) {
  const pick = (re, what) => {
    const m = out.match(re);
    if (!m) throw new Error(`${what} 을(를) 찾지 못했습니다.`);
    return m[0];
  };
  const title = pick(/<title>[\s\S]*?<\/title>/, '제목');
  const style = pick(/<style>[\s\S]*?<\/style>/, '스타일');
  const boot = pick(/<script>[\s\S]*?<\/script>/, '테마 준비 스크립트');
  const body = pick(/<body>([\s\S]*)<\/body>/, '본문')
    .replace(/^<body>\n?/, '')
    .replace(/<\/body>$/, '');
  const page = `${title}\n${style}\n${boot}\n${body}`;
  writeFileSync(process.argv[flag + 1], page);
  console.log(`${process.argv[flag + 1]} 도 만들었습니다 · ${(Buffer.byteLength(page) / 1024).toFixed(0)} KB`);
}
