#!/usr/bin/env bash
# The Verification Gate — run before EVERY delivery. Syntax checks lie;
# this runs what the platform runs.
set -u
FAIL=0

echo "== 1/5 unit tests =="
npx vitest run || FAIL=1

echo "== 2/5 esbuild bundle sweep (functions, exactly as Netlify bundles them) =="
for f in netlify/functions/*.mjs; do
  out=$(npx esbuild "$f" --bundle --platform=node --format=esm \
        --external:@netlify/blobs --outfile=/dev/null 2>&1)
  if echo "$out" | grep -qi "error"; then
    echo "BUNDLE FAIL: $f"
    echo "$out" | head -20
    FAIL=1
  else
    echo "ok: $f"
  fi
done

echo "== 3/5 smoke (planted problems) =="
npm run --silent smoke || FAIL=1

echo "== 4/5 frontend build =="
npm run --silent build || FAIL=1

echo "== 5/5 e2e (desktop + 390x844) =="
npx playwright test || FAIL=1

if [ "$FAIL" -ne 0 ]; then echo "GATE: FAILED"; exit 1; fi
echo "GATE: ALL CLEAN"
