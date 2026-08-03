#!/usr/bin/env bash
# Local pre-commit / CI helper (no npm).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== node --check =="
find . -name '*.js' \
  ! -path './.git/*' \
  ! -path './lib/vendor/*' \
  ! -path './node_modules/*' \
  -print0 | while IFS= read -r -d '' f; do
  node --check "$f"
done

echo "== unit tests =="
node test/run.js

echo "== refresh AGENTS.md metadata =="
node scripts/update-agents-meta.js

echo "OK"
