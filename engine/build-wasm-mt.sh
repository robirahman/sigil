#!/usr/bin/env bash
# Threaded browser engine (2026-10-12): the native parallel root on rayon's pool
# of Web Workers over SHARED wasm memory (wasm-bindgen-rayon). Built alongside the
# single-threaded engine (build-wasm.sh), never instead of it: the page only
# loads this one when it is cross-origin isolated (SharedArrayBuffer available).
#
# Needs a nightly toolchain with rust-src (std is rebuilt with +atomics) and the
# wasm-bindgen CLI pinned like build-wasm.sh. `--target web`: rayon's workers are
# module workers, so the glue is an ES module (loaded by a module worker).
set -euo pipefail
cd "$(dirname "$0")"
WANT=0.2.127
HAVE=$(wasm-bindgen --version 2>/dev/null | awk '{print $2}' || true)
[ "$HAVE" = "$WANT" ] || { echo "wasm-bindgen CLI $WANT required (found: ${HAVE:-none})" >&2; exit 1; }
NIGHTLY=${NIGHTLY:-nightly-2026-09-15}
RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals -C link-arg=--shared-memory -C link-arg=--import-memory -C link-arg=--max-memory=1073741824 -C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base" \
  cargo +$NIGHTLY build --release --target wasm32-unknown-unknown --no-default-features \
  --features wasm-threads -Z build-std=panic_abort,std
OUT=${WASM_OUT:-../docs/static/wasm-mt}
mkdir -p "$OUT"
wasm-bindgen --target web --no-typescript --out-dir "$OUT" --out-name sigil_engine_mt \
  target/wasm32-unknown-unknown/release/sigil_engine.wasm
if command -v wasm-opt >/dev/null; then
  wasm-opt -O3 --enable-threads --enable-bulk-memory "$OUT/sigil_engine_mt_bg.wasm" -o "$OUT/sigil_engine_mt_bg.wasm"
fi
ls -la "$OUT"
