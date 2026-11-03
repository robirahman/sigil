#!/usr/bin/env bash
# CHECKLIST §1 differential test on a VM: tools/rules-diff.py over $IN/<positions file>
# (first job argument), Rust full rules vs the browser's interactive controller.
set -uo pipefail
cd "$(dirname "$0")/../../.."
python3 tools/rules-diff.py --rust $BIN/rules_children "$IN/$1" --jobs ${WORKERS:-$(nproc)} \
  --out $OUT/diff.jsonl --max-children 60000 > $OUT/diff.log 2>&1
tail -1 $OUT/diff.log
