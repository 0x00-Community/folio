// Unit 2: print layout through window.__word.printLayout.
// Records font, layout, pdf and page_png times, boot time, and wasm memory.
// Writes the PDF and runs the unit 1 poppler checks. The reviewer runs this; the sandbox cannot reach acde.
import { readFileSync } from 'node:fs'
import { ensureDev, evaluate, freshPage, until, consoleErrors, check, assert, summary } from './acde.mjs'
import { checkPdf, lcsRatio, pdfPages, poppler, strip, withPdf } from './pdf-check.mjs'

const ARG_LIMIT = 100 * 1024
const CHUNK = 48 * 1024
const LIMIT_MS = 3000
const FIXTURES = ['basic.docx', 'long.docx']

await ensureDev()
await freshPage(`!!(window.__word && window.__word.printLayout)`, { label: 'print hook' })

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
  const memory = result.memory
  const faceBytes = typeof result.faceBytes === 'number' ? result.faceBytes : 0
  let stageText = ` faceBytes ${faceBytes}`
  if (memory) {
    const order = ['baseline', 'afterFonts', 'afterLayout', 'afterPdf', 'afterPng']
    let previous = memory.baseline
    const parts = []
    for (const stage of order) {
      const value = memory[stage]
      const growth = value - previous
      const times = faceBytes === 0 ? 0 : growth / faceBytes
      parts.push(`${stage} ${value} (+${growth}, ${times.toFixed(2)}x)`)
      previous = value
    }
    stageText = ` ${parts.join(' ')}${stageText}`
  }
  console.log(
    `  ${label} boot ${result.bootMs.toFixed(1)} font ${result.fontMs.toFixed(1)} layout ${result.layoutMs.toFixed(1)} pdf ${result.pdfMs.toFixed(1)} png ${result.pngMs.toFixed(1)} ms pages ${result.pages} wasm ${result.memoryBefore} -> ${result.memoryAfter}${stageText}${heapText}`,
  )
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
      // Word's own PDF of this document lacks 26 characters.
      checkPdf(path, result, paragraphs, true, 30)
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

await summary()
