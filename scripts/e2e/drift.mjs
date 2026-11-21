// Prints the drift report for the open document. Records numbers only.
// A low share is a measurement, not a failure. The sandbox cannot reach acde.
import { readFileSync } from 'node:fs'
import { heightDrift } from '../../src/editor/drift.ts'
import { ensureDev, evaluate, until, check, assert, summary } from './acde.mjs'

const ARG_LIMIT = 100 * 1024
const CHUNK = 48 * 1024
const FIXTURES = ['basic.docx', 'long.docx']

await ensureDev()
try {
  evaluate(`location.hash = ''; location.reload()`)
} catch {
  // Reloading the page aborts the eval.
}
await until(`!!(window.__word && window.__word.drift)`, { timeout: 60000, label: 'drift hook' })

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

function runDrift() {
  evaluate(`(() => {
    window.__drift = null
    window.__driftError = ''
    Promise.resolve(window.__word.drift()).then(
      (result) => { window.__drift = result },
      (error) => {
        window.__driftError = String(error && error.message || error)
        window.__drift = { failed: true }
      },
    )
    return 1
  })()`)
  return until(`window.__drift !== null`, { timeout: 180000, label: 'drift' })
}

function takeDrift() {
  const error = evaluate(`window.__driftError || ''`)
  assert(!error, String(error || ''))
  const report = evaluate(`window.__drift`)
  assert(report && report.failed !== true, 'drift returned no report')
  assert(typeof report.blocks === 'number', 'blocks')
  assert(typeof report.samePage === 'number', 'samePage')
  assert(typeof report.share === 'number', 'share')
  assert(report.firstDiff === null || typeof report.firstDiff === 'number', 'firstDiff')
  assert(typeof report.editPages === 'number', 'editPages')
  assert(typeof report.printPages === 'number', 'printPages')
  assert(Array.isArray(report.byPage), 'byPage')
  return report
}

function printReport(label, report) {
  const diff = report.firstDiff === null ? 'null' : String(report.firstDiff)
  console.log(
    `${label} blocks ${report.blocks} share ${report.share} firstDiff ${diff} editPages ${report.editPages} printPages ${report.printPages}`,
  )
  for (const row of report.byPage.slice(0, 10)) {
    console.log(`  page ${row.page} blocks ${row.blocks} same ${row.same}`)
  }
}

function runHeights() {
  evaluate(`(() => {
    window.__heights = null
    window.__heightsError = ''
    const edit = window.__word.blockHeights()
    Promise.resolve(window.__word.printHeights()).then(
      (print) => { window.__heights = { edit, print } },
      (error) => {
        window.__heightsError = String(error && error.message || error)
        window.__heights = { failed: true }
      },
    )
    return 1
  })()`)
  return until(`window.__heights !== null`, { timeout: 180000, label: 'heights' })
}

function takeHeights() {
  const error = evaluate(`window.__heightsError || ''`)
  assert(!error, String(error || ''))
  const raw = evaluate(`window.__heights`)
  assert(raw && raw.failed !== true, 'heights returned nothing')
  assert(Array.isArray(raw.edit), 'edit heights')
  assert(Array.isArray(raw.print), 'print heights')
  return heightDrift(raw.edit, raw.print)
}

function roundPt(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'null'
  return (Math.round(value * 100) / 100).toFixed(2)
}

function printHeights(label, report) {
  let edit = 0
  let print = 0
  let editN = 0
  let printN = 0
  for (const row of report.blocks) {
    if (typeof row.editPt === 'number') {
      edit += row.editPt
      editN += 1
    }
    if (typeof row.printPt === 'number') {
      print += row.printPt
      printN += 1
    }
  }
  console.log(`${label} height editPt ${roundPt(edit)} n ${editN} printPt ${roundPt(print)} n ${printN}`)
  for (const kind of report.byKind) {
    const n = report.blocks.filter((row) => row.kind === kind.kind && row.delta !== null).length
    console.log(`  ${kind.kind} n ${n} delta ${roundPt(kind.delta)}`)
  }
  for (const row of report.largest) {
    console.log(
      `  largest ${row.index} ${row.kind} edit ${roundPt(row.editPt)} print ${roundPt(row.printPt)} delta ${roundPt(row.delta)}`,
    )
  }
}

async function measure(label, base64, name) {
  await openDocument(base64, name)
  const opened = evaluate(`window.__wordError || ''`)
  assert(!opened, opened)
  await runDrift()
  printReport(label, takeDrift())
  await runHeights()
  printHeights(label, takeHeights())
}

for (const name of FIXTURES) {
  await check(name, async () => {
    const base64 = readFileSync(new URL(`../../fixtures/${name}`, import.meta.url)).toString('base64')
    await measure(name, base64, name)
  })
}

const privateDoc = process.env.WORD_TEST_DOC
if (!privateDoc) {
  console.log('skip WORD_TEST_DOC: unset')
} else {
  await check('WORD_TEST_DOC', async () => {
    const base64 = readFileSync(privateDoc).toString('base64')
    await measure('WORD_TEST_DOC', base64)
  })
}

summary()
