#!/usr/bin/env bash
# 전부 돌립니다. 정적 서버는 알아서 띄우고 끕니다.
set -u
cd "$(dirname "$0")/.."

PORT="${PORT:-8099}"
python3 -m http.server "$PORT" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
until curl -sf -o /dev/null "http://127.0.0.1:$PORT/app/index.html"; do sleep 0.3; done

fail=0
for f in tests/unit-*.mjs tests/browser-*.mjs; do
  echo "── $f"
  node "$f" || fail=1
done

echo
[ "$fail" = 0 ] && echo "전부 통과" || echo "실패한 묶음이 있습니다"
exit $fail
