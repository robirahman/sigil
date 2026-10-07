#!/usr/bin/env bash
# Round 2 (2026-10): retrain the Step 4 generator policy on one VM (startup script).
# Builds the branch, samples self-play chunks from GCS, extracts policy examples
# through the Rust expansions (policy_train.py extract), trains from zero and
# warm-started from the shipped weights, gates both against the shipped weights
# on held-out chunks (gate0) and on the Step 1 suites (bench_suites.py, shipped
# v25 config: nnue_spell + SHIPPED_POLICY), ships everything to
# gs://…/runs/<run-id>/ and shuts down.
#
#   gcloud compute instances create sigil-r2d-train ... \
#     --metadata=run-id=<id>,branch=r2-data-policy,max-hours=4,data=<gs prefix>[;<gs prefix>],ntrain=1500,ngate=60 \
#     --metadata-from-file=startup-script=engine/gcp/r2_policy.sh
#
# `data`: one or more chunk prefixes (each holding *.npz), ';'-separated; train
# and gate files are drawn from them with a fixed seed, disjoint by file (and so
# by game: a chunk holds whole games).
set -uo pipefail
exec > >(tee -a /var/log/sigil-r2p.log) 2>&1
BUCKET=focus-surfer-494820-g0-sigil
md() { curl -sf -m 10 -H 'Metadata-Flavor: Google' \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }
RUN=$(md run-id); BRANCH=$(md branch); MAXH=$(md max-hours); DATA=$(md data)
NTRAIN=$(md ntrain); NGATE=$(md ngate)
: "${RUN:=r2p-unknown}" "${BRANCH:=r2-data-policy}" "${MAXH:=4}" "${NTRAIN:=1500}" "${NGATE:=60}"
( sleep $((MAXH * 3600)); echo "WATCHDOG"; shutdown -h now ) &
WATCHDOG=$!
gcs_put() {
  local tok; tok=$(curl -sf -m 15 -H 'Metadata-Flavor: Google' \
    http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])') || return 1
  curl -sf -m 300 -X POST -H "Authorization: Bearer $tok" \
    -H "Content-Type: application/octet-stream" --data-binary "@$1" \
    "https://storage.googleapis.com/upload/storage/v1/b/$BUCKET/o?uploadType=media&name=$(python3 -c "
import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$2")" >/dev/null
}
export DEBIAN_FRONTEND=noninteractive
apt-get -qq update; apt-get -qq install -y build-essential curl git python3-venv >/dev/null 2>&1
W=/opt/r2p; mkdir -p $W/out $W/data/train $W/data/gate; cd $W
export RUSTUP_HOME=$W/rustup CARGO_HOME=$W/cargo PATH=$W/cargo/bin:$PATH
curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable >/dev/null 2>&1
git clone --filter=blob:none --no-checkout --depth=1 --single-branch --branch "$BRANCH" \
  https://github.com/robirahman/sigil.git repo >/dev/null 2>&1 || { echo clone failed; shutdown -h now; }
cd repo && git sparse-checkout init --cone && git sparse-checkout set engine ai && git checkout >/dev/null 2>&1
git log --oneline -1 > $W/out/COMMIT.txt
python3 -m venv $W/venv
$W/venv/bin/pip -q install --upgrade pip
$W/venv/bin/pip -q install numpy
# Debian 12's venv pip is too old for torch's build deps off the CPU-only index
# alone (no flit_core there): upgrade pip and keep PyPI as the fallback index.
$W/venv/bin/pip -q install torch --index-url https://download.pytorch.org/whl/cpu \
  --extra-index-url https://pypi.org/simple
$W/venv/bin/python -c 'import torch; print("torch", torch.__version__)' \
  || { echo "FATAL: torch"; gcs_put /var/log/sigil-r2p.log "runs/$RUN/FAILED.log"; shutdown -h now; exit 1; }
cd engine && cargo build --release 2>&1 | tail -1
mkdir -p $W/py; cp target/release/libsigil_engine.so $W/py/sigil_engine.so
( while true; do for f in $W/out/*; do [ -f "$f" ] && gcs_put "$f" "runs/$RUN/$(basename "$f")" || true; done; sleep 120; done ) &
UP=$!
N=$(nproc)
PY="env PYTHONPATH=$W/py $W/venv/bin/python"
T=$W/repo/engine/harness/policy_train.py

# --- sample chunk files (fixed seed), disjoint train / gate -------------------
: > $W/all.txt
IFS=';' read -ra PREFIXES <<< "$DATA"
for p in "${PREFIXES[@]}"; do gcloud storage ls "${p%/}/*.npz" >> $W/all.txt 2>/dev/null; done
echo "chunks listed: $(wc -l < $W/all.txt)"
$W/venv/bin/python - "$W/all.txt" "$NTRAIN" "$NGATE" "$W" <<'EOF'
import random, sys
paths = [l.strip() for l in open(sys.argv[1]) if l.strip()]
random.Random(25).shuffle(paths)
nt, ng, w = int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
open(f'{w}/gate.txt', 'w').write('\n'.join(paths[:ng]) + '\n')
open(f'{w}/train.txt', 'w').write('\n'.join(paths[ng:ng + nt]) + '\n')
EOF
cp $W/train.txt $W/gate.txt $W/out/
gcloud storage cp -q -I $W/data/train/ < $W/train.txt
gcloud storage cp -q -I $W/data/gate/ < $W/gate.txt
echo "train files $(ls $W/data/train | wc -l), gate files $(ls $W/data/gate | wc -l)"

# --- extract, train, gate0 -------------------------------------------------------
$PY $T extract $W/ex.npz $W/data/train/*.npz --workers $N > $W/out/extract.log 2>&1
$PY $T train $W/ex.npz $W/out/w_zero.npy --init zero > $W/out/train_zero.log 2>&1
$PY $T train $W/ex.npz $W/out/w_warm.npy --init compiled > $W/out/train_warm.log 2>&1
for w in compiled $W/out/w_zero.npy $W/out/w_warm.npy; do
  tag=$(basename "$w" .npy)
  $PY $T gate0 "$w" $W/data/gate/*.npz --n 6000 --workers $N --out $W/out/gate0_$tag.json \
    > $W/out/gate0_$tag.log 2>&1
done

# --- Step 1 suites at the shipped v25 search config ------------------------------
SUITES=$(md suites); : "${SUITES:=1}"
cd $W/repo
[ "$SUITES" = 1 ] && \
P96="call=set_policy(True,96)"
$PY engine/harness/bench_suites.py --nodes 50000,300000,1500000 \
  --cover 6,10,12,24,40,96,500 --workers $N \
  --config "shipped:eval=nnue_spell;$P96" \
  --config "zero:eval=nnue_spell;$P96;weights=$W/out/w_zero.npy" \
  --config "warm:eval=nnue_spell;$P96;weights=$W/out/w_warm.npy" \
  --json $W/out/suites.json > $W/out/suites.log 2>&1

kill $UP 2>/dev/null
for f in $W/out/*; do gcs_put "$f" "runs/$RUN/$(basename "$f")" || true; done
echo "DONE $(date -u +%FT%TZ)" > $W/out/COMPLETE; gcs_put $W/out/COMPLETE "runs/$RUN/COMPLETE"
gcs_put /var/log/sigil-r2p.log "runs/$RUN/bootstrap.log" || true
kill $WATCHDOG 2>/dev/null; shutdown -h now
