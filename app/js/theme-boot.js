/* 저장해 둔 테마를 스타일보다 먼저 적용해 첫 화면이 깜빡이지 않게 합니다.
   CSP 에서 인라인 스크립트를 막으므로 별도 파일로 둡니다. */
try {
  var t = localStorage.getItem('theme') || 'auto';
  if (t === 'auto') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
} catch (e) { /* 저장을 막아 둔 브라우저 */ }
