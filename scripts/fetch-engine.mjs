// Downloads the prebuilt engine of a release into public/engine.wasm and src/engine/pkg/,
// for running the app without a Rust toolchain. `npm run engine` builds the same files from source.
// Usage: node scripts/fetch-engine.mjs [tag]   (default: ENGINE_TAG below)
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// The release whose engine matches this checkout. Raise it when engine/ or the rdocx revision changes.
const ENGINE_TAG = 'v0.1.0'
const REPO = '0x00-Community/folio'
const FILES = [
  ['engine.wasm', 'public/engine.wasm'],
  ['engine.js', 'src/engine/pkg/engine.js'],
  ['engine.d.ts', 'src/engine/pkg/engine.d.ts'],
  ['engine_bg.wasm.d.ts', 'src/engine/pkg/engine_bg.wasm.d.ts'],
]

const tag = process.argv[2] ?? ENGINE_TAG
const root = new URL('..', import.meta.url)
for (const [asset, target] of FILES) {
  const url = `https://github.com/${REPO}/releases/download/${tag}/${asset}`
  const response = await fetch(url)
  if (!response.ok) {
    console.error(`${url}: ${response.status} ${response.statusText}`)
    process.exit(1)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  const path = fileURLToPath(new URL(target, root))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
  console.log(`${target}  ${bytes.byteLength} bytes`)
}
console.log(`engine ${tag} is in place`)
