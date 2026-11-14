#!/bin/sh
# Builds the rdocx engine to WebAssembly: src/engine/pkg/ (JS glue, types) and public/engine.wasm.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
profile=${1:-release}
cd "$root/engine"
if [ "$profile" = release ]; then
  cargo build --release --target wasm32-unknown-unknown
else
  cargo build --target wasm32-unknown-unknown
fi
wasm-bindgen --target web --out-dir "$root/src/engine/pkg" --out-name engine \
  "$root/engine/target/wasm32-unknown-unknown/$profile/rdocx_word_engine.wasm"
mv "$root/src/engine/pkg/engine_bg.wasm" "$root/public/engine.wasm"
ls -la "$root/public/engine.wasm"
