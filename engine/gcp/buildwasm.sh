#!/usr/bin/env bash
# Build the browser engine (WASM) on a VM and ship the artifacts to GCS.
#
# Rust cannot be built in Cloud Shell: rustup installs into $HOME, a 4.8G
# filesystem carrying live data collection, and it filled it to 78% once.
#
# The artifacts are CHECKED IN because GitHub Pages has no build step, so this
# uploads them to GCS for the caller to commit rather than committing itself --
# a VM holding a write token to the repo is not a trade worth making for a
# 500 KB file.
#
# Metadata: branch, tag (GCS prefix under builds/), max-hours
set -uo pipefail
exec > >(tee -a /var/log/sigil-wasm.log) 2>&1
BUCKET=focus-surfer-494820-g0-sigil
md() { curl -sf -m 10 -H 'Metadata-Flavor: Google' \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }
BRANCH=$(md branch); TAG=$(md tag); MAXH=$(md max-hours)
: "${BRANCH:=main}" "${TAG:=wasm}" "${MAXH:=1}"
echo "=== wasm build $BRANCH ($TAG) $(date -u +%FT%TZ) ==="
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
# binaryen supplies wasm-opt (the ~756K -> ~500K size pass); nodejs runs
# tools/wasm-smoke.js, which loads the freshly built glue in a classic-script
# context the way docs/ does and is the only check that the artifact actually
# runs rather than merely linking.
apt-get -qq install -y build-essential git curl python3 nodejs binaryen >/dev/null 2>&1
W=/opt/sigil; rm -rf $W; mkdir -p $W/out; cd $W
export RUSTUP_HOME=$W/rustup CARGO_HOME=$W/cargo PATH=$W/cargo/bin:$PATH
curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable >/dev/null 2>&1
rustup target add wasm32-unknown-unknown >/dev/null 2>&1

git clone --filter=blob:none --no-checkout --depth=1 --single-branch --branch "$BRANCH" \
  https://github.com/robirahman/sigil.git repo >/dev/null 2>&1 \
  || { echo "FATAL: clone failed"; shutdown -h now; exit 1; }
cd repo && git sparse-checkout init --cone >/dev/null 2>&1
git sparse-checkout set engine tools docs >/dev/null 2>&1
git checkout >/dev/null 2>&1
git log --oneline -1 | tee $W/out/COMMIT.txt

{
  # The CLI must match the wasm-bindgen CRATE version exactly or the generated
  # glue mis-imports at runtime, so take the pin from Cargo.toml rather than
  # hard-coding it here -- two places to bump is one place to forget.
  WANT=$(grep -oP 'wasm-bindgen\s*=\s*.*?=\K[0-9]+\.[0-9]+\.[0-9]+' engine/Cargo.toml | head -1)
  : "${WANT:=0.2.127}"
  echo "### wasm-bindgen-cli $WANT (pinned in engine/Cargo.toml)"
  cargo install wasm-bindgen-cli --version "$WANT" --locked > $W/out/cli.log 2>&1
  echo "CLI_EXIT=$?  $(wasm-bindgen --version 2>&1)"

  echo; echo "### engine/build-wasm.sh"
  ( cd engine && bash build-wasm.sh ) > $W/out/wasm_full.log 2>&1
  echo "WASM_EXIT=$?"
  grep -E '^(error|warning): |^error\[' -A 12 $W/out/wasm_full.log | head -120
  echo "--- last 25 lines ---"; tail -25 $W/out/wasm_full.log

  echo; echo "### artifacts"
  ls -l docs/static/wasm/ || true
  for f in docs/static/wasm/sigil_engine.js docs/static/wasm/sigil_engine_bg.wasm; do
    [ -f "$f" ] && echo "SHA256 $(sha256sum "$f")"
  done

  # SMOKE THE OPTIMISED ARTIFACT, AND FALL BACK IF IT FAILS. `wasm-opt -O2`
  # without explicit feature flags produced a module that linked and then died
  # at init -- "WebAssembly.Table.grow(): failed to grow table by 4" in
  # __wbindgen_init_externref_table -- because wasm-bindgen 0.2.127 emits an
  # externref table and binaryen drops what it is not told to keep. Build-time
  # exit codes were all zero. So the size pass is not trusted: it is verified,
  # and a failure reverts to the unoptimised module rather than shipping.
  echo; echo "### tools/wasm-smoke.js (optimised)"
  SMOKE_EXIT=0
  if [ -f tools/wasm-smoke.js ]; then
    node tools/wasm-smoke.js; SMOKE_EXIT=$?
    echo "SMOKE_EXIT_OPT=$SMOKE_EXIT"
    if [ $SMOKE_EXIT -ne 0 ] && [ -f docs/static/wasm/sigil_engine_bg.wasm.preopt ]; then
      echo "### optimised module FAILED the smoke; reverting to unoptimised"
      mv docs/static/wasm/sigil_engine_bg.wasm.preopt \
         docs/static/wasm/sigil_engine_bg.wasm
      node tools/wasm-smoke.js; SMOKE_EXIT=$?
      echo "SMOKE_EXIT_UNOPT=$SMOKE_EXIT"
      echo "SHIPPING=unoptimised ($(stat -c%s docs/static/wasm/sigil_engine_bg.wasm) bytes)"
    else
      echo "SHIPPING=optimised ($(stat -c%s docs/static/wasm/sigil_engine_bg.wasm) bytes)"
    fi
  else
    echo "(no wasm-smoke.js)"
  fi
  rm -f docs/static/wasm/sigil_engine_bg.wasm.preopt
  echo "SMOKE_EXIT=$SMOKE_EXIT"
  echo; echo "### final artifacts"
  ls -l docs/static/wasm/
  for f in docs/static/wasm/sigil_engine.js docs/static/wasm/sigil_engine_bg.wasm; do
    [ -f "$f" ] && echo "FINAL_SHA256 $(sha256sum "$f")"
  done
} > $W/out/wasm.log 2>&1

tail -60 $W/out/wasm.log
gcs_put "$W/out/wasm.log" "builds/$TAG/wasm.log" || true
gcs_put "$W/out/wasm_full.log" "builds/$TAG/wasm_full.log" || true
gcs_put "$W/out/COMMIT.txt" "builds/$TAG/COMMIT.txt" || true
gcs_put "$W/repo/docs/static/wasm/sigil_engine.js" "builds/$TAG/sigil_engine.js" || true
gcs_put "$W/repo/docs/static/wasm/sigil_engine_bg.wasm" "builds/$TAG/sigil_engine_bg.wasm" || true
gcs_put /var/log/sigil-wasm.log "builds/$TAG/bootstrap.log" || true
shutdown -h now
