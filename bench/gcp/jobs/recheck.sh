#!/usr/bin/env bash
# Re-check stored mate certificates ($IN/<first arg>, a glob of JSON lists or
# JSONL files of records with 'cert', e.g. 'm4_work*.jsonl') with the current Rust and JS checkers
# (bench/tools/recheck_certs.py): Rust for every record, JS for every record
# whose stored check failed plus a deterministic sample of the rest.
#   args: <records glob> [js_sample=0.05]
set -uo pipefail
cd "$(dirname "$0")/../../.."
JSS=${2:-0.05}
python3 bench/tools/recheck_certs.py $IN/$1 --tool $BIN/cert_tool --out $OUT/recheck.jsonl \
  --workers ${WORKERS:-$(nproc)} --js-failed --js-sample "$JSS" > $OUT/recheck.log 2>&1
tail -3 $OUT/recheck.log
echo "recheck done"
