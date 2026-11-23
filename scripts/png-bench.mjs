// Release-wasm page PNG timings. One JSON line on stdout per document and dpi.
// Usage: node scripts/png-bench.mjs [doc.docx ...] family=path ...
// With no document, fixtures/basic.docx and fixtures/long.docx are measured.
// WORD_TEST_DOC, when set, is measured too and reported as "private".
// A .ttc or .otc is one extracted face, the same upright face resolveFont would pick.
// family=path files are the catalog. Only the faces printFonts selects are added,
// one buffer at a time.
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { aliasChain, isPrintBoldKey, printFonts } from '../src/fonts.ts'
import { printFontRequest } from '../src/engine/engine.ts'
import { initSync, Session } from '../src/engine/pkg/engine.js'
import { extractFace, readFaces, readFontFile } from '../server/fonts.ts'

const root = new URL('..', import.meta.url)
const DPIS = [96, 144]

const args = process.argv.slice(2)
const docs = []
const pairSpecs = []
for (const arg of args) {
  if (arg.includes('=')) pairSpecs.push(arg)
  else docs.push(arg)
}
if (docs.length === 0) {
  docs.push(fileURLToPath(new URL('fixtures/basic.docx', root)))
  docs.push(fileURLToPath(new URL('fixtures/long.docx', root)))
}
const extraDoc = process.env.WORD_TEST_DOC
if (typeof extraDoc === 'string' && extraDoc !== '' && !docs.some((doc) => resolve(doc) === resolve(extraDoc))) {
  docs.push(extraDoc)
}

const wasmFile = readFileSync(new URL('public/engine.wasm', root))
initSync({ module: wasmFile })

const pairs = pairSpecs.map(parsePair)
const catalog = pairs.map((pair, index) => catalogFace(pair, index))

for (const doc of docs) {
  const docPath = isAbsolute(doc) ? doc : resolve(doc)
  measure(docPath, catalog)
}

function measure(docPath, catalog) {
  const docBytes = new Uint8Array(readFileSync(docPath))
  const session = Session.open(docBytes)
  const importedJson = session.import()
  const request = printFontRequest(importedJson)
  const plan = printFonts(request.families, catalog, request.han)
  for (const planned of plan.faces) {
    const spec = catalog[Number(planned.id)]
    let bytes = faceBytes(spec.family, spec.path)
    session.add_font(planned.family, bytes)
    bytes = null
  }
  for (const [requested, loaded] of plan.aliases) session.add_font_alias(requested, loaded)

  const imported = JSON.parse(importedJson)
  const layout = session.print_layout(keepPatch(imported))
  const pages = layout.page_count()
  if (pages === 0) throw new Error(`no pages in ${docPath}`)
  for (const dpi of DPIS) {
    const times = []
    const sizes = []
    for (let page = 0; page < pages; page++) {
      const started = performance.now()
      const png = layout.page_png(page, dpi)
      times.push(performance.now() - started)
      sizes.push(png.byteLength)
    }
    console.log(
      JSON.stringify({
        doc: docName(docPath),
        dpi,
        pages,
        meanMs: round(mean(times)),
        medianMs: round(median(times)),
        maxMs: round(max(times)),
        meanKB: round(mean(sizes) / 1024),
      }),
    )
  }
  layout.free()
  session.free()
}

function catalogFace(pair, index) {
  const bold = isPrintBoldKey(pair.family)
  const family = bold ? pair.family.replace(/ Bold$/, '') : pair.family
  return {
    id: String(index),
    families: [family],
    bold,
    italic: false,
    cjk: true,
    truetype: true,
    weight: bold ? 700 : 400,
    path: pair.path,
    family: pair.family,
  }
}

function parsePair(spec) {
  const at = spec.indexOf('=')
  if (at <= 0 || at === spec.length - 1) throw new Error(`expected family=path, got ${spec}`)
  return { family: spec.slice(0, at), path: spec.slice(at + 1) }
}

function faceBytes(family, path) {
  const bytes = readFontFile(path)
  const ext = extname(path).toLowerCase()
  if (ext !== '.ttc' && ext !== '.otc') return bytes
  const faces = readFaces((offset, length) => bytes.subarray(offset, offset + length))
  for (const name of aliasChain(family)) {
    const key = name.toLowerCase()
    const matches = faces.filter((face) => face.families.some((item) => item.toLowerCase() === key))
    const face = matches.find((item) => !item.bold && !item.italic) ?? matches[0]
    if (face) return extractFace(bytes, face.faceIndex)
  }
  throw new Error(`no face for ${family} in ${path}`)
}

function keepPatch(imported) {
  const body = imported.body.map((block) => {
    if (typeof block.src !== 'number') throw new Error('imported block has no src')
    return { keep: block.src }
  })
  return JSON.stringify({
    body,
    sections: imported.sections,
    newLists: [],
    addedStyles: [],
    media: [],
  })
}

function docName(path) {
  const extra = process.env.WORD_TEST_DOC
  if (typeof extra === 'string' && extra !== '' && resolve(path) === resolve(extra)) return 'private'
  return basename(path)
}

function mean(values) {
  let sum = 0
  for (const value of values) sum += value
  return sum / values.length
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

function max(values) {
  let best = values[0]
  for (const value of values) if (value > best) best = value
  return best
}

function round(value) {
  return Math.round(value * 10) / 10
}
