#!/usr/bin/env bash
# Build one branch, run the Rust test suite, run a caller-supplied Python smoke
# test against the freshly built bindings, ship everything to GCS, shut down.
#
# Rust CANNOT be built in Cloud Shell: `rustup` installs into $HOME, a 4.8G
# filesystem carrying Robi's live data collection, and it filled it to 78% once.
# RUSTUP_HOME / CARGO_HOME below are the entire reason this runs on a VM.
#
# The smoke test arrives as the `smoke-py` metadata attribute rather than being
# baked in, so verifying a new branch needs no new copy of this script. An earlier
# version WAS a one-off copy per campaign, lived only in Cloud Shell scratch, and
# was lost to a container recycle.
#
# Metadata: branch, tag (GCS prefix under builds/), max-hours, smoke-py (optional)
set -uo pipefail
exec > >(tee -a /var/log/sigil-build.log) 2>&1
BUCKET=focus-surfer-494820-g0-sigil
md() { curl -sf -m 10 -H 'Metadata-Flavor: Google' \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }
BRANCH=$(md branch); TAG=$(md tag); MAXH=$(md max-hours)
: "${BRANCH:=main}" "${TAG:=build}" "${MAXH:=1}"
echo "=== build $BRANCH ($TAG) $(date -u +%FT%TZ) ==="
( sleep $((MAXH * 3600)); echo "WATCHDOG"; shutdown -h now ) &

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
apt-get -qq update
apt-get -qq install -y build-essential git python3-venv >/dev/null 2>&1
W=/opt/sigil; rm -rf $W; mkdir -p $W/out; cd $W
export RUSTUP_HOME=$W/rustup CARGO_HOME=$W/cargo PATH=$W/cargo/bin:$PATH
curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable >/dev/null 2>&1
git clone --filter=blob:none --no-checkout --depth=1 --single-branch --branch "$BRANCH" \
  https://github.com/robirahman/sigil.git repo >/dev/null 2>&1 \
  || { echo "FATAL: clone failed"; shutdown -h now; exit 1; }
cd repo && git sparse-checkout init --cone >/dev/null 2>&1
git sparse-checkout set engine tools ai notation.py simboard.py >/dev/null 2>&1
git checkout >/dev/null 2>&1
git log --oneline -1 | tee $W/out/COMMIT.txt
cd $W/repo/engine

md smoke-py > $W/smoke.py 2>/dev/null || true
{
  echo "### cargo build --release"
  cargo build --release 2>&1 | tail -30
  echo "BUILD_EXIT=${PIPESTATUS[0]}"
  echo; echo "### cargo test --release"
  cargo test --release 2>&1 | tail -45
  echo "TEST_EXIT=${PIPESTATUS[0]}"
  echo; echo "### python smoke"
  python3 -m venv $W/venv
  $W/venv/bin/pip -q install maturin numpy 2>&1 | tail -1
  VIRTUAL_ENV=$W/venv $W/venv/bin/maturin develop --release 2>&1 | tail -3
  if [ -s $W/smoke.py ]; then
    ( cd $W/repo && $W/venv/bin/python $W/smoke.py ); echo "SMOKE_EXIT=$?"
  else
    echo "(no smoke-py supplied)"; echo "SMOKE_EXIT=0"
  fi
} > $W/out/build.log 2>&1

tail -70 $W/out/build.log
gcs_put "$W/out/build.log" "builds/$TAG/build.log" || true
gcs_put "$W/out/COMMIT.txt" "builds/$TAG/COMMIT.txt" || true
gcs_put /var/log/sigil-build.log "builds/$TAG/bootstrap.log" || true
shutdown -h now
