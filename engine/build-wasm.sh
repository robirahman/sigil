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
#
# TWO THINGS THIS GOT WRONG, both found by tools/wasm-smoke.js on a rebuild.
#
# 1. `wasm-opt -O2` alone SILENTLY CORRUPTS the module. wasm-bindgen 0.2.127
#    emits an externref table, and binaryen drops features it was not told to
#    enable, so the output linked fine and then died at INIT with
#    "WebAssembly.Table.grow(): failed to grow table by 4" inside
#    __wbindgen_init_externref_table. Nothing fails at build time; the site
#    just stops loading the engine. The features must be named explicitly.
#
# 2. The pass overwrote the only good copy. Now it writes to a temp file and
#    the caller decides, so a bad optimiser can never destroy a working
#    artifact. Set SKIP_WASM_OPT=1 to bypass the pass entirely.
if [ "${SKIP_WASM_OPT:-0}" != "1" ] && command -v wasm-opt >/dev/null 2>&1; then
    echo "wasm-opt: $(wasm-opt --version 2>&1 | head -1)"
    cp "$OUT/sigil_engine_bg.wasm" "$OUT/sigil_engine_bg.wasm.preopt"
    if wasm-opt -O2 \
         --enable-reference-types --enable-bulk-memory \
         --enable-mutable-globals --enable-nontrapping-float-to-int \
         --enable-sign-ext \
         -o "$OUT/sigil_engine_bg.wasm.opt" \
         "$OUT/sigil_engine_bg.wasm.preopt"; then
        mv "$OUT/sigil_engine_bg.wasm.opt" "$OUT/sigil_engine_bg.wasm"
        echo "wasm-opt applied ($(stat -c%s "$OUT/sigil_engine_bg.wasm.preopt")"\
             "-> $(stat -c%s "$OUT/sigil_engine_bg.wasm") bytes)."
        echo "VERIFY WITH tools/wasm-smoke.js BEFORE COMMITTING: an optimiser"
        echo "that drops a feature fails at init, not at build."
    else
        echo "wasm-opt FAILED; keeping the unoptimised module." >&2
        rm -f "$OUT/sigil_engine_bg.wasm.opt"
    fi
fi

ls -la "$OUT"
echo
echo "Built. Now bump RUST_ENGINE_VERSION (docs/static/scripts/engine/rust-ai.js)"
echo "and CACHE_VERSION + the ?v= precache entries (docs/sw.js), then commit"
echo "docs/static/wasm/sigil_engine.js and sigil_engine_bg.wasm."
