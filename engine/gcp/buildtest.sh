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
# nodejs and docs/static/scripts are for ai/replay_bridge.py: slim game records
# store INPUT TOKENS, and the only sanctioned replayer is the browser engine's
# reconstructGameLog, run under node. There is deliberately no Python port.
apt-get -qq install -y build-essential git python3-venv nodejs >/dev/null 2>&1
W=/opt/sigil; rm -rf $W; mkdir -p $W/out; cd $W
export RUSTUP_HOME=$W/rustup CARGO_HOME=$W/cargo PATH=$W/cargo/bin:$PATH
curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable >/dev/null 2>&1
git clone --filter=blob:none --no-checkout --depth=1 --single-branch --branch "$BRANCH" \
  https://github.com/robirahman/sigil.git repo >/dev/null 2>&1 \
  || { echo "FATAL: clone failed"; shutdown -h now; exit 1; }
cd repo && git sparse-checkout init --cone >/dev/null 2>&1
git sparse-checkout set engine tools ai docs/static/scripts notation.py simboard.py >/dev/null 2>&1
git checkout >/dev/null 2>&1
git log --oneline -1 | tee $W/out/COMMIT.txt
node --version 2>/dev/null | sed 's/^/node /' || echo 'node MISSING'
cd $W/repo/engine

md smoke-py > $W/smoke.py 2>/dev/null || true
{
  # Keep the FULL compiler output and report EVERY error, not a tail of it.
  # `tail -30` once truncated a 5-error build to 1 visible error and cost a
  # whole VM round-trip to find the rest: cargo prints errors first and the
  # summary last, so a tail shows the summary and hides the causes.
  echo "### cargo build --release"
  cargo build --release > $W/out/build_full.log 2>&1
  echo "BUILD_EXIT=$?"
  grep -E '^(error|warning): |^error\[' -A 12 $W/out/build_full.log | head -250
  echo "--- last 20 lines ---"; tail -20 $W/out/build_full.log
  echo; echo "### cargo test --release"
  cargo test --release > $W/out/test_full.log 2>&1
  echo "TEST_EXIT=$?"
  grep -E '^(error|warning): |^error\[|^test .* FAILED|^failures:|panicked at' -A 12 \
    $W/out/test_full.log | head -250
  echo "--- test summary ---"; grep -E 'test result:' $W/out/test_full.log
  echo; echo "### python smoke"
  # Upload build+test BEFORE the smoke runs. The first version uploaded only
  # after all three stages, so a smoke test that outran the watchdog took the
  # cargo results down with it -- one guard-fix pass searched 435 positions at
  # depth 6 (~17 s each) and lost a clean build and 84 passing tests to the
  # 1-hour cap. The smoke's own log is appended by the final upload.
  gcs_put "$W/out/build_full.log" "builds/$TAG/build_full.log" || true
  gcs_put "$W/out/test_full.log" "builds/$TAG/test_full.log" || true
  python3 -m venv $W/venv
  $W/venv/bin/pip -q install maturin numpy 2>&1 | tail -1
  VIRTUAL_ENV=$W/venv $W/venv/bin/maturin develop --release 2>&1 | tail -3
  if [ -s $W/smoke.py ]; then
    # Cap the smoke so it cannot eat the watchdog: a smoke test is a gate, not
    # a campaign. `smoke-max-min` metadata overrides the 20-minute default.
    SMOKE_MIN=$(md smoke-max-min); : "${SMOKE_MIN:=20}"
    ( cd $W/repo && timeout $((SMOKE_MIN * 60)) $W/venv/bin/python $W/smoke.py )
    SX=$?; echo "SMOKE_EXIT=$SX"
    [ $SX -eq 124 ] && echo "SMOKE TIMED OUT after ${SMOKE_MIN}m -- the gate did not run"
  else
    echo "(no smoke-py supplied)"; echo "SMOKE_EXIT=0"
  fi
} > $W/out/build.log 2>&1

tail -70 $W/out/build.log
gcs_put "$W/out/build.log" "builds/$TAG/build.log" || true
gcs_put "$W/out/build_full.log" "builds/$TAG/build_full.log" || true
gcs_put "$W/out/test_full.log" "builds/$TAG/test_full.log" || true
gcs_put "$W/out/COMMIT.txt" "builds/$TAG/COMMIT.txt" || true
gcs_put /var/log/sigil-build.log "builds/$TAG/bootstrap.log" || true
shutdown -h now
