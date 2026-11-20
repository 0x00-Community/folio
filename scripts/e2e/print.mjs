// Unit 2: print layout through window.__word.printLayout.
// Records font, layout, pdf and page_png times, boot time, and wasm memory.
// Writes the PDF and runs the unit 1 poppler checks. The reviewer runs this; the sandbox cannot reach acde.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureDev, evaluate, until, consoleErrors, check, assert, summary } from './acde.mjs'

const ARG_LIMIT = 100 * 1024
const CHUNK = 48 * 1024
const POPPLER = '/opt/homebrew/bin'
const LIMIT_MS = 3000
const FIXTURES = ['basic.docx', 'long.docx']

await ensureDev()
try {
  evaluate(`location.hash = ''; location.reload()`)
} catch {
  // Reloading the page aborts the eval.
}
await until(`!!(window.__word && window.__word.printLayout)`, { timeout: 60000, label: 'print hook' })

function stage(base64) {
  if (base64.length <= ARG_LIMIT) return JSON.stringify(base64)
  evaluate(`(() => { window.__openB64 = ''; return 1 })()`)
  for (let i = 0; i < base64.length; i += CHUNK) {
    const piece = JSON.stringify(base64.slice(i, i + CHUNK))
    evaluate(`(() => { window.__openB64 += ${piece}; return 1 })()`)
  }
  return 'window.__openB64'
}

function openDocument(base64, name) {
  const expr = stage(base64)
  const nameArg = name ? `, ${JSON.stringify(name)}` : ''
  evaluate(`(() => {
    window.__wordReady = false
    window.__wordError = ''
    try {
      Promise.resolve(window.__word.openBytes(${expr}${nameArg})).then(
        () => { window.__wordReady = true },
        (error) => {
          window.__wordError = String(error && error.message || error)
          window.__wordReady = true
        },
      )
    } catch (error) {
      window.__wordError = String(error && error.message || error)
      window.__wordReady = true
    }
    return 1
  })()`)
  return until(`window.__wordReady === true`, { timeout: 120000, label: 'layout complete' })
}

function bodyParagraphs() {
  return evaluate(`(() => {
    const doc = window.__word.editor.state.doc
    const out = []
    function textOf(para) {
      let text = ''
      for (const inline of para.inlines) if (inline.kind === 'text') text += inline.text
      return text
    }
    function walk(blocks) {
      for (const block of blocks) {
        if (block.kind === 'p') out.push(textOf(block))
        else if (block.kind === 'table') {
          for (const row of block.rows) for (const cell of row.cells) walk(cell.blocks)
        } else walk(block.preview)
      }
    }
    walk(doc.body)
    return out
  })()`)
}

function runPrint() {
  evaluate(`(() => {
    window.__print = null
    window.__printError = ''
    Promise.resolve(window.__word.printLayout()).then(
      (result) => { window.__print = result },
      (error) => {
        window.__printError = String(error && error.message || error)
        window.__print = { failed: true }
      },
    )
    return 1
  })()`)
  return until(`window.__print !== null`, { timeout: 180000, label: 'print layout' })
}

function takePrint() {
  const error = evaluate(`window.__printError || ''`)
  assert(!error, String(error || ''))
  // The PDF base64 is read in slices. One eval of a long document's PDF can exceed what the CLI returns.
  evaluate(`(() => {
    const result = window.__print || {}
    window.__pdf = typeof result.pdfBase64 === 'string' ? result.pdfBase64 : ''
    const meta = {}
    for (const key of Object.keys(result)) meta[key] = key === 'pdfBase64' ? window.__pdf.length : result[key]
    window.__printMeta = meta
    return 1
  })()`)
  const meta = evaluate(`window.__printMeta`)
  assert(meta && meta.failed !== true && meta.pdfBase64 > 0, 'print returned no pdf')
  meta.pdfBase64 = readStaged(meta.pdfBase64)
  return meta
}

function readStaged(length) {
  let out = ''
  for (let i = 0; i < length; i += CHUNK) {
    const end = Math.min(length, i + CHUNK)
    const piece = evaluate(`window.__pdf.slice(${i}, ${end})`)
    assert(typeof piece === 'string' && piece.length === end - i, 'pdf chunk')
    out += piece
  }
  return out
}

function assertFast(result) {
  const times = [
    ['boot', result.bootMs],
    ['font', result.fontMs],
    ['layout', result.layoutMs],
    ['pdf', result.pdfMs],
    ['png', result.pngMs],
  ]
  for (const [name, ms] of times) {
    assert(typeof ms === 'number', `${name} time is missing`)
    assert(ms <= LIMIT_MS, `${name} took ${ms.toFixed(1)} ms`)
  }
}

function logMeasure(label, result) {
  const heap = evaluate(`(() => {
    const memory = performance.memory
    if (!memory) return null
    return { used: memory.usedJSHeapSize, total: memory.totalJSHeapSize }
  })()`)
  const heapText = heap ? ` heap ${heap.used}/${heap.total}` : ' heap n/a'
  console.log(
    `  ${label} boot ${result.bootMs.toFixed(1)} font ${result.fontMs.toFixed(1)} layout ${result.layoutMs.toFixed(1)} pdf ${result.pdfMs.toFixed(1)} png ${result.pngMs.toFixed(1)} ms pages ${result.pages} wasm ${result.memoryBefore} -> ${result.memoryAfter}${heapText}`,
  )
}

function poppler(tool, args) {
  return execFileSync(join(POPPLER, tool), args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function listedFonts(output) {
  const lines = output.split('\n').filter((line) => line.trim() !== '')
  const header = lines[0] || ''
  const embAt = header.indexOf('emb')
  assert(embAt >= 0, 'pdffonts has no emb column')
  const fonts = []
  for (const line of lines.slice(2)) {
    const name = line.trim().split(/\s+/)[0]
    if (!name || /^-+$/.test(name)) continue
    const emb = (line.slice(embAt).trim().split(/\s+/)[0] || '')
    fonts.push({ name, embedded: emb === 'yes' })
  }
  return fonts
}

function pdfPages(path) {
  const info = poppler('pdfinfo', [path])
  const line = info.split('\n').find((item) => item.startsWith('Pages:'))
  assert(line, 'pdfinfo has no Pages line')
  return Number(line.slice('Pages:'.length).trim())
}

function strip(text) {
  return text.replace(/\s+/g, '')
}

function readable(text) {
  return ['rdocx-acdefixtureheader', 'rdocx-acdefixturefooter'].reduce(
    (out, token) => out.split(token).join(''),
    strip(text),
  )
}

function missingPart(haystack, parts) {
  let rest = haystack
  for (const part of parts) {
    const token = strip(part)
    if (!token) continue
    const at = rest.indexOf(token)
    if (at < 0) return token
    rest = rest.slice(at + token.length)
  }
  return null
}

function familyPrefix(family) {
  const prefix = family.replace(/[^A-Za-z0-9-]/g, '')
  return prefix || 'Font'
}

function checkPdf(path, result, paragraphs, quiet) {
  const fonts = listedFonts(poppler('pdffonts', [path]))
  assert(fonts.length > 0, 'pdffonts listed no fonts')
  assert(fonts.every((font) => font.embedded), 'a font is not embedded')
  const cjk = (result.fonts || []).filter((font) => /[^\x00-\x7f]|Songti|Kaiti|Heiti|Fangsong|STSong/i.test(font.family))
  assert(cjk.length > 0, 'layout used no CJK face')
  assert(cjk.every((font) => font.embedded), 'a CJK face is not embedded')
  const named = fonts.some((font) => cjk.some((face) => font.name.startsWith(familyPrefix(face.family))))
  assert(named, `no font name starts with ${cjk.map((face) => familyPrefix(face.family)).join(', ')}`)
  assert(pdfPages(path) === result.pages, `pdfinfo pages differ from the layout (${result.pages})`)
  const text = readable(poppler('pdftotext', ['-enc', 'UTF-8', path, '-']))
  const missing = missingPart(text, paragraphs)
  const detail = missing !== null && !quiet ? `missing ${missing.slice(0, 40)}` : 'exported text does not contain the document text in order'
  assert(missing === null, detail)
}

function withPdf(base64, run) {
  const dir = mkdtempSync(join(tmpdir(), 'rdocx-print-e2e-'))
  const path = join(dir, 'out.pdf')
  try {
    writeFileSync(path, Buffer.from(base64, 'base64'))
    return run(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function lcsRatio(reference, exported) {
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
  const matched = prev[width] ?? 0
  return left.length === 0 ? 1 : matched / left.length
}

function codes(text) {
  const out = new Uint16Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i)
  return out
}

for (const name of FIXTURES) {
  await check(`${name} prints within 3 s and passes the poppler checks`, async () => {
    const base64 = readFileSync(new URL(`../../fixtures/${name}`, import.meta.url)).toString('base64')
    await openDocument(base64, name)
    const opened = evaluate(`window.__wordError || ''`)
    assert(!opened, opened)
    const paragraphs = bodyParagraphs()
    await runPrint()
    const result = takePrint()
    assert(result.pages > 0, 'no pages')
    assert(result.pngBytes > 0, 'no page png')
    assertFast(result)
    logMeasure(name, result)
    withPdf(result.pdfBase64, (path) => checkPdf(path, result, paragraphs, false))
  })
}

const realDoc = process.env.WORD_TEST_DOC
const realPdf = process.env.WORD_TEST_REF_PDF
if (!realDoc || !realPdf) {
  console.log('skip reference: WORD_TEST_DOC or WORD_TEST_REF_PDF is unset')
} else {
  await check('reference document prints and passes the poppler checks', async () => {
    const base64 = readFileSync(realDoc).toString('base64')
    await openDocument(base64)
    const opened = evaluate(`window.__wordError || ''`)
    assert(!opened, opened)
    const paragraphs = bodyParagraphs()
    await runPrint()
    const result = takePrint()
    assertFast(result)
    logMeasure('reference', result)
    withPdf(result.pdfBase64, (path) => {
      checkPdf(path, result, paragraphs, true)
      const refPages = pdfPages(realPdf)
      const refText = strip(poppler('pdftotext', ['-enc', 'UTF-8', realPdf, '-']))
      const outText = strip(poppler('pdftotext', ['-enc', 'UTF-8', path, '-']))
      const lcs = lcsRatio(refText, outText)
      console.log(`  reference pages ${refPages} export pages ${result.pages} lcs ${lcs.toFixed(4)}`)
    })
  })
}

await check('console has no errors', async () => {
  const errors = consoleErrors()
  assert(errors.length === 0, errors.join('\n'))
})

summary()
