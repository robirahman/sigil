#!/usr/bin/env bash
# Round 3 (2026-10-07): retrain the generator policy on one VM (startup script),
# derived from r2_policy.sh. Builds the branch, samples self-play chunks from GCS
# per dataset, extracts policy examples (policy_train.py extract, with
# exploration-better examples, `xbetter`), trains two warm starts from the shipped
# weights -- unweighted, and with the blind-spot loss weights (`wargs`) -- both
# with the competitive share of the training weight held at >= `comp-share`
# (competitive majority, Robi's directive), gates all against the shipped weights
# on held-out chunks (gate0, with cast / non-default slices) and on the guest
# suite (guest_policy_rank.py), ships to gs://…/runs/<run-id>/ and shuts down.
#
#   gcloud compute instances create sigil-r3d-train ... \
#     --metadata=run-id=<id>,branch=r3-data,max-hours=5,data=<prefix>|<ntrain>|<ngate>;<prefix>|<ntrain> \
#     --metadata-from-file=startup-script=engine/gcp/r3_policy.sh
#
# Chunk names do not collide across datasets (shard offsets differ per round).
set -uo pipefail
exec > >(tee -a /var/log/sigil-r3p.log) 2>&1
BUCKET=focus-surfer-494820-g0-sigil
md() { curl -sf -m 10 -H 'Metadata-Flavor: Google' \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }
RUN=$(md run-id); BRANCH=$(md branch); MAXH=$(md max-hours); DATA=$(md data)
NTRAIN=$(md ntrain); NGATE=$(md ngate)
: "${RUN:=r3p-unknown}" "${BRANCH:=r3-data}" "${MAXH:=4}" "${NTRAIN:=1500}" "${NGATE:=60}"
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
  || { echo "FATAL: torch"; gcs_put /var/log/sigil-r3p.log "runs/$RUN/FAILED.log"; shutdown -h now; exit 1; }
cd engine && cargo build --release 2>&1 | tail -1
mkdir -p $W/py; cp target/release/libsigil_engine.so $W/py/sigil_engine.so
( while true; do for f in $W/out/*; do [ -f "$f" ] && gcs_put "$f" "runs/$RUN/$(basename "$f")" || true; done; sleep 120; done ) &
UP=$!
N=$(nproc)
PY="env PYTHONPATH=$W/py $W/venv/bin/python"
T=$W/repo/engine/harness/policy_train.py

# --- sample chunk files (fixed seed) ---------------------------------------------
# `data` = "<gs prefix>:<n train files>[:<n gate files>];..." -- per-prefix counts so
# the mix can be held competitive-majority; gate files only from prefixes that ask.
: > $W/train.txt; : > $W/gate.txt
IFS=';' read -ra SPECS <<< "$DATA"
for spec in "${SPECS[@]}"; do
  IFS='|' read -r pre nt ng <<< "$spec"
  gcloud storage ls "${pre%/}/*.npz" > $W/list.txt 2>/dev/null
  echo "$pre: $(wc -l < $W/list.txt) chunks listed"
  $W/venv/bin/python - "$W/list.txt" "$nt" "${ng:-0}" "$W" <<'EOF'
import random, sys
paths = [l.strip() for l in open(sys.argv[1]) if l.strip()]
random.Random(27).shuffle(paths)
nt, ng, w = int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
open(f'{w}/gate.txt', 'a').write(''.join(p + '\n' for p in paths[:ng]))
open(f'{w}/train.txt', 'a').write(''.join(p + '\n' for p in paths[ng:ng + nt]))
EOF
done
cp $W/train.txt $W/gate.txt $W/out/
# chunk basenames are unique across rounds (shard offsets differ)
mkdir -p $W/data/train $W/data/gate
gcloud storage cp -q -I $W/data/train/ < $W/train.txt 2>&1 | tail -2
gcloud storage cp -q -I $W/data/gate/ < $W/gate.txt 2>&1 | tail -2
echo "train files $(ls $W/data/train | wc -l) (listed $(wc -l < $W/train.txt)), gate files $(ls $W/data/gate | wc -l)"

# --- extract, train, gate0 -------------------------------------------------------
XB=$(md xbetter); : "${XB:=1}"
WARGS=$(md wargs); : "${WARGS:=--w-cast 2 --w-dashcast 3 --w-nondef 2 --w-xb 4}"
CSHARE=$(md comp-share); : "${CSHARE:=0.6}"
$PY $T extract $W/ex.npz $W/data/train/*.npz --workers $N --xbetter $XB > $W/out/extract.log 2>&1
gcs_put $W/out/extract.log "runs/$RUN/extract.log"
$PY $T train $W/ex.npz $W/out/w_warm.npy --init compiled --comp-share $CSHARE > $W/out/train_warm.log 2>&1
$PY $T train $W/ex.npz $W/out/w_wtd.npy --init compiled --comp-share $CSHARE $WARGS > $W/out/train_wtd.log 2>&1
for w in compiled $W/out/w_warm.npy $W/out/w_wtd.npy; do
  tag=$(basename "$w" .npy)
  $PY $T gate0 "$w" $W/data/gate/*.npz --n 8000 --workers $N --xbetter $XB --out $W/out/gate0_$tag.json \
    > $W/out/gate0_$tag.log 2>&1
done
cd $W/repo
$PY engine/harness/guest_policy_rank.py compiled $W/out/w_warm.npy $W/out/w_wtd.npy \
  --json $W/out/guest_rank.json > $W/out/guest_rank.log 2>&1

kill $UP 2>/dev/null
for f in $W/out/*; do gcs_put "$f" "runs/$RUN/$(basename "$f")" || true; done
echo "DONE $(date -u +%FT%TZ)" > $W/out/COMPLETE; gcs_put $W/out/COMPLETE "runs/$RUN/COMPLETE"
gcs_put /var/log/sigil-r3p.log "runs/$RUN/bootstrap.log" || true
kill $WATCHDOG 2>/dev/null; shutdown -h now
