// Release-wasm print timings. One JSON line on stdout per document.
// Usage: node scripts/print-bench.mjs [doc.docx ...] family=path ...
// With no document, fixtures/basic.docx and fixtures/long.docx are measured.
// WORD_TEST_DOC, when set, is measured too, in its own engine instance.
// A .ttc or .otc is one extracted face, the same upright face resolveFont would pick.
// family=path files are the catalog. Only the faces printFonts selects are added,
// one buffer at a time. When the document is WORD_TEST_DOC and WORD_TEST_REF_PDF
// is set, the line also has refPages and the LCS ratio of the reference text.
// WORD_BENCH_PDF, when set, is the path the PDF bytes are written to.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { aliasChain, isPrintBoldKey, printFonts } from '../src/fonts.ts'
import { printFontRequest } from '../src/engine/engine.ts'
import { initSync, Session } from '../src/engine/pkg/engine.js'
import { extractFace, readFaces, readFontFile } from '../server/fonts.ts'

const POPPLER = '/opt/homebrew/bin'
const root = new URL('..', import.meta.url)
const STAGES = ['baseline', 'afterFonts', 'afterLayout', 'afterPdf', 'afterPng']

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
if (process.env.WORD_BENCH_CHILD !== '1' && docs.length > 1) {
  for (const doc of docs) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), doc, ...pairSpecs], {
      env: { ...process.env, WORD_BENCH_CHILD: '1' },
      encoding: 'utf8',
    })
    if (child.stdout) process.stdout.write(child.stdout)
    if (child.stderr) process.stderr.write(child.stderr)
    if (child.status !== 0) process.exit(child.status ?? 1)
  }
  process.exit(0)
}

const docPath = isAbsolute(docs[0]) ? docs[0] : resolve(docs[0])
const pairs = pairSpecs.map(parsePair)

const wasmFile = readFileSync(new URL('public/engine.wasm', root))
const instantiateStarted = performance.now()
const wasm = initSync({ module: wasmFile })
const instantiateMs = elapsed(instantiateStarted)

const docBytes = new Uint8Array(readFileSync(docPath))
const openStarted = performance.now()
const session = Session.open(docBytes)
const openMs = elapsed(openStarted)
const importedJson = session.import()
const request = printFontRequest(importedJson)
const catalog = pairs.map((pair, index) => catalogFace(pair, index))
const plan = printFonts(request.families, catalog, request.han)

const memory = { baseline: wasmBytes(wasm) }
let fontBytes = 0
const faces = []
for (const planned of plan.faces) {
  const spec = catalog[Number(planned.id)]
  let bytes = faceBytes(spec.family, spec.path)
  session.add_font(planned.family, bytes)
  fontBytes += bytes.byteLength
  faces.push({ family: planned.family, bytes: bytes.byteLength })
  bytes = null
}
for (const [requested, loaded] of plan.aliases) session.add_font_alias(requested, loaded)
memory.afterFonts = wasmBytes(wasm)

const imported = JSON.parse(importedJson)
const patch = keepPatch(imported)
const layoutStarted = performance.now()
const layout = session.print_layout(patch)
const layoutMs = elapsed(layoutStarted)
const pages = layout.page_count()
memory.afterLayout = wasmBytes(wasm)

const pdfStarted = performance.now()
const pdf = layout.pdf()
const pdfMs = elapsed(pdfStarted)
memory.afterPdf = wasmBytes(wasm)

const pngStarted = performance.now()
const png = layout.page_png(0, 144)
const pngMs = elapsed(pngStarted)
memory.afterPng = wasmBytes(wasm)

const line = {
  instantiateMs: round(instantiateMs),
  openMs: round(openMs),
  layoutMs: round(layoutMs),
  pages,
  pdfMs: round(pdfMs),
  pdfBytes: pdf.byteLength,
  pngMs: round(pngMs),
  pngBytes: png.byteLength,
  fontBytes,
  faceBytes: fontBytes,
  faces,
  memoryBefore: memory.baseline,
  memoryAfter: memory.afterPng,
  memory,
}
reportStages(basename(docPath), memory, fontBytes)
if (process.env.WORD_BENCH_PDF) writeFileSync(process.env.WORD_BENCH_PDF, pdf)

const reference = referenceRatio(docPath, pdf)
if (reference) {
  line.refPages = reference.refPages
  line.lcs = reference.lcs
}

layout.free()
session.free()
console.log(JSON.stringify(line))

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

function reportStages(label, stages, faceBytes) {
  let previous = stages.baseline
  const parts = []
  for (const stage of STAGES) {
    const value = stages[stage]
    const growth = value - previous
    const times = faceBytes === 0 ? 0 : growth / faceBytes
    parts.push(`${stage} ${value} (+${growth}, ${times.toFixed(2)}x)`)
    previous = value
  }
  console.error(`${label} ${parts.join(' ')} faceBytes ${faceBytes}`)
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

function referenceRatio(opened, pdfBytes) {
  const docEnv = process.env.WORD_TEST_DOC
  const refEnv = process.env.WORD_TEST_REF_PDF
  if (!docEnv) return null
  if (resolve(docEnv) !== opened) return null
  if (!refEnv) {
    console.error('skip reference: WORD_TEST_REF_PDF is unset')
    return null
  }
  const dir = mkdtempSync(join(tmpdir(), 'rdocx-print-bench-'))
  const exported = join(dir, 'exported.pdf')
  try {
    writeFileSync(exported, pdfBytes)
    if (process.env.WORD_BENCH_OUT) writeFileSync(process.env.WORD_BENCH_OUT, pdfBytes)
    const refPages = pdfPageCount(refEnv)
    const refText = stripSpace(poppler('pdftotext', ['-enc', 'UTF-8', refEnv, '-']))
    const outText = stripSpace(poppler('pdftotext', ['-enc', 'UTF-8', exported, '-']))
    const matched = refText.length === 0 ? refText.length : lcsLength(refText, outText)
    const lcs = refText.length === 0 ? 1 : matched / refText.length
    return { refPages, lcs: Math.round(lcs * 10000) / 10000 }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function pdfPageCount(path) {
  const info = poppler('pdfinfo', [path])
  const line = info.split('\n').find((item) => item.startsWith('Pages:'))
  if (!line) throw new Error('pdfinfo did not report Pages')
  const pages = Number(line.slice('Pages:'.length).trim())
  if (!Number.isFinite(pages)) throw new Error('pdfinfo Pages is not a number')
  return pages
}

function poppler(tool, args) {
  return execFileSync(join(POPPLER, tool), args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function stripSpace(text) {
  return text.replace(/\s+/g, '')
}

function lcsLength(reference, exported) {
  const left = codes(reference)
  const right = codes(exported)
  const width = right.length
  let prev = new Uint32Array(width + 1)
  let curr = new Uint32Array(width + 1)
  for (let i = 1; i <= left.length; i++) {
    const code = left[i - 1]
    for (let j = 1; j <= width; j++) {
      if (code === right[j - 1]) curr[j] = (prev[j - 1] ?? 0) + 1
      else {
        const up = prev[j] ?? 0
        const across = curr[j - 1] ?? 0
        curr[j] = up > across ? up : across
      }
    }
    const swap = prev
    prev = curr
    curr = swap
    curr.fill(0)
  }
  return prev[width] ?? 0
}

function codes(text) {
  const out = new Uint16Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i)
  return out
}

function wasmBytes(exports) {
  return exports.memory.buffer.byteLength
}

function elapsed(started) {
  return performance.now() - started
}

function round(ms) {
  return Math.round(ms * 10) / 10
}
