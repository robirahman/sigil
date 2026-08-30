#!/usr/bin/env bash
# Build the browser engine and drop the committed artifacts into docs/static/wasm/.
#
# GitHub Pages has no build step, so the .wasm and its no-modules glue are
# CHECKED IN. `--target no-modules` because every script in docs/ is a classic
# script and the engine loads inside a classic worker via importScripts —
# an ES-module glue (`--target web`) cannot be loaded there.
#
# After any engine change that ships:
#   1. run this script;
#   2. bump RUST_ENGINE_VERSION in docs/static/scripts/engine/rust-ai.js;
#   3. bump CACHE_VERSION in docs/sw.js and update the ?v= precache entries.
# The version query strings are what make a stale service-worker-cached wasm
# impossible: an old glue+wasm pair is simply never requested again.
set -euo pipefail
cd "$(dirname "$0")"

# The CLI must match the wasm-bindgen crate version EXACTLY (Cargo.toml pins
# =0.2.127) or the generated glue mis-imports at runtime.
WANT=0.2.127
HAVE=$(wasm-bindgen --version 2>/dev/null | awk '{print $2}' || true)
if [ "$HAVE" != "$WANT" ]; then
    echo "wasm-bindgen CLI $WANT required (found: ${HAVE:-none})." >&2
    echo "  cargo install wasm-bindgen-cli --version $WANT --locked" >&2
    exit 1
fi

cargo build --release --target wasm32-unknown-unknown --no-default-features --features wasm

OUT=../docs/static/wasm
mkdir -p "$OUT"
wasm-bindgen --target no-modules --no-typescript \
    --out-dir "$OUT" --out-name sigil_engine \
    target/wasm32-unknown-unknown/release/sigil_engine.wasm

# Optional size pass: ~756 KB -> ~500-600 KB. Skipped silently without binaryen;
# the unoptimised size is acceptable (Pages gzips on the wire).
if command -v wasm-opt >/dev/null 2>&1; then
    wasm-opt -O2 -o "$OUT/sigil_engine_bg.wasm.opt" "$OUT/sigil_engine_bg.wasm"
    mv "$OUT/sigil_engine_bg.wasm.opt" "$OUT/sigil_engine_bg.wasm"
fi

ls -la "$OUT"
echo
echo "Built. Now bump RUST_ENGINE_VERSION (docs/static/scripts/engine/rust-ai.js)"
echo "and CACHE_VERSION + the ?v= precache entries (docs/sw.js), then commit"
echo "docs/static/wasm/sigil_engine.js and sigil_engine_bg.wasm."
