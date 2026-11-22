// Release-wasm open and untouched-save timings. One JSON line on stdout per document.
// Usage: node scripts/open-save-bench.mjs [doc.docx ...]
// With no document, the four fixtures are measured.
// WORD_TEST_DOC, when set, is measured too and reported as "private".
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEngine, documentPatch, parseImported, toDoc } from '../src/engine/engine.ts'
import { initSync, Session } from '../src/engine/pkg/engine.js'

const root = new URL('..', import.meta.url)
const args = process.argv.slice(2)
const docs = args.length === 0
  ? ['fixtures/basic.docx', 'fixtures/long.docx', 'fixtures/preserve.docx', 'fixtures/tables.docx'].map((name) =>
      fileURLToPath(new URL(name, root)),
    )
  : args.map((arg) => resolve(arg))
const extraDoc = process.env.WORD_TEST_DOC
if (typeof extraDoc === 'string' && extraDoc !== '' && !docs.some((doc) => resolve(doc) === resolve(extraDoc))) {
  docs.push(extraDoc)
}

const wasmFile = readFileSync(new URL('public/engine.wasm', root))
const wasm = initSync({ module: wasmFile })

for (const path of docs) {
  const bytes = new Uint8Array(readFileSync(path))
  const [session, openMs] = ms(() => Session.open(bytes))
  const [json] = ms(() => session.import())
  const [parsed] = ms(() => JSON.parse(json))
  const [imported] = ms(() => parseImported(parsed))
  ms(() => toDoc(imported))
  session.free()
  const engine = createEngine()
  const [opened, wholeOpenMs] = ms(() => engine.open(bytes))
  const [patch] = ms(() => documentPatch(opened.source, opened.doc))
  JSON.stringify(patch)
  const saveKeepMs = []
  let saved
  for (let i = 0; i < 3; i++) {
    const [out, saveMs] = ms(() => opened.source.save(opened.doc))
    saved = out
    saveKeepMs.push(saveMs)
  }
  ms(() => opened.source.fontsUsed(opened.doc))
  const line = {
    doc: docName(path),
    openMs,
    saveKeepMs,
    wholeOpenMs,
    memMB: +(wasm.memory.buffer.byteLength / 1048576).toFixed(1),
  }
  if (!saved || saved.byteLength === 0) throw new Error(`empty save for ${line.doc}`)
  opened.source.free()
  console.log(JSON.stringify(line))
}

function docName(path) {
  const extra = process.env.WORD_TEST_DOC
  if (typeof extra === 'string' && extra !== '' && resolve(path) === resolve(extra)) return 'private'
  return basename(path)
}

function ms(fn) {
  const started = performance.now()
  const value = fn()
  return [value, +(performance.now() - started).toFixed(2)]
}
