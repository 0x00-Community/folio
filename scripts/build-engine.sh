#!/bin/sh
# Builds the rdocx engine to WebAssembly: src/engine/pkg/ (JS glue, types) and public/engine.wasm.
# Release strips the name and producers sections. Set WORD_ENGINE_NAMES=1 to keep them for profiling.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
profile=${1:-release}
cd "$root/engine"
if [ "$profile" = release ]; then
  cargo build --release --target wasm32-unknown-unknown
else
  cargo build --target wasm32-unknown-unknown
fi
if [ "$profile" = release ] && [ "${WORD_ENGINE_NAMES:-}" != 1 ]; then
  wasm-bindgen --target web --remove-name-section --remove-producers-section \
    --out-dir "$root/src/engine/pkg" --out-name engine \
    "$root/engine/target/wasm32-unknown-unknown/$profile/rdocx_word_engine.wasm"
else
  wasm-bindgen --target web --out-dir "$root/src/engine/pkg" --out-name engine \
    "$root/engine/target/wasm32-unknown-unknown/$profile/rdocx_word_engine.wasm"
fi
mv "$root/src/engine/pkg/engine_bg.wasm" "$root/public/engine.wasm"
ls -la "$root/public/engine.wasm"
