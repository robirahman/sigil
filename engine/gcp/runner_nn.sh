#!/usr/bin/env bash
# Step 5 (2026-10 plan) network-eval trainer for a GPU VM (Deep Learning VM image,
# PyTorch + CUDA preinstalled). Builds the engine module, preps the Step 3 data
# (or reuses a prepped copy from the bucket), runs the lambda sweep on the game
# split, then the spell-held-out folds at the best lambda, and ships every
# result/net to gs://<bucket>/runs/<run-id>/ as it lands. Shuts itself down.
#
# Metadata: run-id, branch, max-hours, data (gs:// prefix of v2 chunks),
#           prep (gs:// path of a prepped npz to reuse / write), lams, epochs.
set -uo pipefail
exec > >(tee -a /var/log/sigil-nn.log) 2>&1
echo "=== sigil nn runner $(date -u +%FT%TZ) ==="
BUCKET=focus-surfer-494820-g0-sigil
md() { curl -sf -m 10 -H 'Metadata-Flavor: Google' \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }
RUN=$(md run-id); BRANCH=$(md branch); MAXH=$(md max-hours); DATA=$(md data)
PREP=$(md prep); LAMS=$(md lams); EPOCHS=$(md epochs)
DEVICE=$(md device || true); SMOKE=$(md smoke || true)
# Optional: EVALS = prep eval columns (comma list); JOBS = explicit training jobs,
# one per line, `<tag> <nn_eval.py train args...>`, replacing the lambda sweep.
EVALS=$(md evals || true); : "${EVALS:=tfit,tfit_spell,tfit_spell2}"
JOBS=$(md jobs || true)
: "${MAXH:=4}" "${LAMS:=0 0.25 0.5 0.75 1}" "${EPOCHS:=6}" "${DEVICE:=cuda}" "${SMOKE:=0}"
( sleep $((MAXH * 3600)); echo "WATCHDOG"; shutdown -h now ) &
WATCHDOG=$!
DEST=gs://$BUCKET/runs/$RUN
WORK=/opt/sigil; mkdir -p $WORK/out; cd $WORK
( while true; do gcloud storage cp -q /var/log/sigil-nn.log $DEST/live/runner.log 2>/dev/null
    gcloud storage rsync -q -r $WORK/out $DEST/out 2>/dev/null; sleep 120; done ) &
UPLOADER=$!
fail() { echo "FATAL: $*"; gcloud storage cp -q /var/log/sigil-nn.log $DEST/FAILED.log; shutdown -h now; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get -qq update; apt-get -qq install -y build-essential git curl >/dev/null 2>&1
export RUSTUP_HOME=$WORK/rustup CARGO_HOME=$WORK/cargo PATH=$WORK/cargo/bin:$PATH
curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable >/dev/null 2>&1
git clone --depth=1 --single-branch --branch "$BRANCH" https://github.com/robirahman/sigil.git repo \
  >/dev/null 2>&1 || fail "clone"
echo "repo at $(git -C repo log --oneline -1)" | tee $WORK/out/COMMIT.txt

PY=""
for p in /opt/conda/bin/python /usr/bin/python3 /opt/python/bin/python3; do
  [ -x "$p" ] && "$p" -c 'import torch' 2>/dev/null && { PY=$p; break; }
done
[ -n "$PY" ] || fail "no python with torch"
# The Deep Learning VM's python carries torch but not ensurepip (no python3.X-venv),
# so a bare `python -m venv` fails there: the first trainer died on exactly that.
mkvenv() {
  rm -rf $WORK/venv
  $PY -m venv --system-site-packages $WORK/venv 2>&1 | tail -2
  $WORK/venv/bin/python -m pip --version >/dev/null 2>&1 \
    && $WORK/venv/bin/python -c 'import torch' 2>/dev/null
}
if ! mkvenv; then
  PYV=$($PY -c 'import sys; print("%d.%d" % sys.version_info[:2])')
  echo "venv failed; installing python3-venv python$PYV-venv"
  apt-get -qq install -y python3-venv "python$PYV-venv" >/dev/null 2>&1
  mkvenv || fail venv
fi
echo "venv ok ($PY, $($WORK/venv/bin/python -c 'import torch; print("torch", torch.__version__)'))"
$WORK/venv/bin/pip -q install maturin numpy scipy 2>&1 | tail -1
cd $WORK/repo/engine && VIRTUAL_ENV=$WORK/venv $WORK/venv/bin/maturin develop --release 2>&1 | tail -1
$WORK/venv/bin/python -c 'import sigil_engine, torch; print("engine ok; cuda", torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else "")' \
  || fail "engine/torch import"
if [ "$DEVICE" = cuda ]; then
  $WORK/venv/bin/python -c 'import torch, sys; sys.exit(0 if torch.cuda.is_available() else 1)' \
    || fail "device=cuda but torch sees no GPU"
fi
NN="$WORK/venv/bin/python $WORK/repo/engine/harness/nn_eval.py"

if [ "$SMOKE" = 1 ]; then
  # Bootstrap smoke (cheap CPU VM, same image): everything up to one tiny training
  # run on a handful of chunks, then COMPLETE. Never writes the shared PREP path.
  mkdir -p $WORK/data
  gcloud storage ls "$DATA/" | head -8 > $WORK/smoke_list.txt
  gcloud storage cp -q $(cat $WORK/smoke_list.txt) $WORK/data/ || fail "smoke data"
  $NN prep $WORK/data $WORK/prep.npz --workers $(nproc) --evals "$EVALS" || fail "smoke prep"
  $NN train $WORK/prep.npz $WORK/out/smoke --lam 0.5 --epochs 1 --split game --device "$DEVICE" \
    --batch 256 > $WORK/out/smoke.log 2>&1 || fail "smoke train"
  tail -1 $WORK/out/smoke.log
  gcloud storage rsync -q -r $WORK/out $DEST/out
  echo "SMOKE OK $(date -u +%FT%TZ)" > $WORK/COMPLETE
  gcloud storage cp -q $WORK/COMPLETE $DEST/COMPLETE
  gcloud storage cp -q /var/log/sigil-nn.log $DEST/runner.log
  shutdown -h now; exit 0
fi

if gcloud storage cp -q "$PREP" $WORK/prep.npz 2>/dev/null; then
  echo "reusing prepped data $PREP"
else
  mkdir -p $WORK/data
  gcloud storage cp -q -r "$DATA/*" $WORK/data/ || fail "data download"
  echo "downloaded $(ls $WORK/data | wc -l) chunks"
  $NN prep $WORK/data $WORK/prep.npz --workers $(nproc) --evals "$EVALS" \
    || fail prep
  gcloud storage cp -q $WORK/prep.npz "$PREP"
  rm -rf $WORK/data
fi

if [ "$JOBS" = prep-only ]; then
  # Prep on a wide CPU VM (the GPU VM has 12 vCPUs), then train elsewhere.
  echo "prep-only: $PREP"; JOBS=""; LAMS=""; SKIP_FOLDS=1
elif [ -n "$JOBS" ]; then
  while read -r TAG ARGS; do
    [ -n "$TAG" ] || continue
    $NN train $WORK/prep.npz $WORK/out/$TAG $ARGS --epochs $EPOCHS --device "$DEVICE" \
      > $WORK/out/$TAG.log 2>&1 || echo "train $TAG failed"
    echo "$TAG: $(tail -1 $WORK/out/$TAG.log | cut -c1-300)"
    gcloud storage rsync -q -r $WORK/out $DEST/out 2>/dev/null
  done <<< "$JOBS"
  LAMS=""
fi
for L in $LAMS; do
  $NN train $WORK/prep.npz $WORK/out/game_l$L --lam $L --epochs $EPOCHS --split game --device "$DEVICE" \
    > $WORK/out/game_l$L.log 2>&1 || echo "train lam=$L failed"
  tail -1 $WORK/out/game_l$L.log
done
if [ -z "$JOBS" ] && [ -z "${SKIP_FOLDS:-}" ]; then
BEST=$($WORK/venv/bin/python - "$WORK/out" <<'EOF'
import json, glob, sys
r = []
for f in glob.glob(sys.argv[1] + '/game_l*/result.json'):
    j = json.load(open(f)); r.append((j['net_quant']['outcome_ll'], j['lam']))
print(min(r)[1] if r else 0.5)
EOF
)
echo "best lambda on held-out outcome log-loss: $BEST" | tee $WORK/out/BEST.txt
for F in fold0 fold1 fold2; do
  $NN train $WORK/prep.npz $WORK/out/${F}_l$BEST --lam $BEST --epochs $EPOCHS --split $F --device "$DEVICE" \
    > $WORK/out/${F}.log 2>&1 || echo "train $F failed"
  tail -1 $WORK/out/${F}.log
done
$NN train $WORK/prep.npz $WORK/out/game_l${BEST}_h256 --lam $BEST --epochs $EPOCHS --split game \
  --device "$DEVICE" --hidden 256 > $WORK/out/game_h256.log 2>&1 || echo "h256 failed"
tail -1 $WORK/out/game_h256.log
fi

kill $UPLOADER 2>/dev/null
gcloud storage rsync -q -r $WORK/out $DEST/out
echo "DONE $(date -u +%FT%TZ)" > $WORK/COMPLETE
gcloud storage cp -q $WORK/COMPLETE $DEST/COMPLETE
gcloud storage cp -q /var/log/sigil-nn.log $DEST/runner.log
kill $WATCHDOG 2>/dev/null
shutdown -h now
