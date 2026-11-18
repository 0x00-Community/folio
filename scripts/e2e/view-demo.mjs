import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { root, ensureDev, evaluate, until, shot, consoleErrors, check, assert, summary } from './acde.mjs'

await ensureDev()

// acde dev reloads the page when a project file changes, so the screenshot is copied in after the last check.
const straddleShot = `${mkdtempSync(`${tmpdir()}/view-demo-`)}/straddle.png`

async function loadDemo() {
  try {
    evaluate(`location.hash = '#view-demo'; location.reload()`)
  } catch {
    // Reloading the page aborts the eval.
  }
  return until(`window.__demo && window.__demo.view.layout.complete === true`, {
    timeout: 60000,
    label: 'layout.complete',
  })
}

function snapshot() {
  return evaluate(`({ pages: window.__demo.view.layout.pages.length, ms: window.__viewFirstPageMs, mounted: document.querySelectorAll('.page[data-mounted="1"]').length })`)
}

await loadDemo()
await loadDemo()
const first = snapshot()
await loadDemo()
const second = snapshot()

await check('page count is stable and the first page shows within 1s', async () => {
  console.log(`  first=${JSON.stringify(first)} second=${JSON.stringify(second)}`)
  assert(first.pages === second.pages, `page count ${first.pages} then ${second.pages}`)
  assert(first.pages > 90, `page count ${first.pages}`)
  assert(first.ms < 1000, `first paint ${first.ms.toFixed(1)} ms`)
  assert(second.ms < 1000, `second paint ${second.ms.toFixed(1)} ms`)
})

await check('round trip of 200 positions at zoom 1', async () => {
  evaluate(`window.__demo.view.setZoom(1)`)
  const result = evaluate(`window.__demo.roundTrip(200)`)
  console.log(`  ${JSON.stringify(result)}`)
  assert(result.samples === 200, `samples ${result.samples}`)
  assert(result.miss === 0, `misses ${JSON.stringify(result.examples)}`)
  assert(result.exact >= 190, `exact ${result.exact} equivalent ${result.equivalent}`)
})

await check('round trip of 200 positions at zoom 1.5', async () => {
  evaluate(`window.__demo.view.setZoom(1.5)`)
  const result = evaluate(`window.__demo.roundTrip(200)`)
  evaluate(`window.__demo.view.setZoom(1)`)
  console.log(`  ${JSON.stringify(result)}`)
  assert(result.samples === 200, `samples ${result.samples}`)
  assert(result.miss === 0, `misses ${JSON.stringify(result.examples)}`)
  assert(result.exact >= 190, `exact ${result.exact} equivalent ${result.equivalent}`)
})

await check('lineMove down crosses the page and up returns', async () => {
  const probe = evaluate(`window.__demo.lineProbe()`)
  console.log(`  ${JSON.stringify(probe)}`)
  assert(probe.downPage === probe.fromPage + 1, `pages ${probe.fromPage} -> ${probe.downPage}`)
  assert(probe.dx <= 4, `|x-goalX|=${probe.dx}`)
  assert(probe.back.p === probe.from.p && probe.back.o === probe.from.o, `back ${probe.back.p}@${probe.back.o} from ${probe.from.p}@${probe.from.o}`)
})

let straddle
await check('a straddling paragraph is clipped across two pages', async () => {
  straddle = evaluate(`window.__demo.revealStraddle()`)
  console.log(`  ${JSON.stringify(straddle)}`)
  assert(Math.abs(straddle.nextY0 - straddle.y1) < 0.6, `slice join ${straddle.y1} -> ${straddle.nextY0}`)
  const page = straddle.page
  await until(
    `!!(document.querySelector('.page[data-page="${page}"][data-mounted="1"] .blk') && document.querySelector('.page[data-page="${page + 1}"][data-mounted="1"] .blk'))`,
    { timeout: 8000, label: 'straddle pages mounted' },
  )
  const copies = evaluate(`document.querySelectorAll('.blk[data-id="${straddle.id}"]').length`)
  assert(copies >= 2, `mounted copies ${copies}`)
  shot(straddleShot)
})

await check('editing one paragraph stays under 8ms and moves later pages', async () => {
  evaluate(`document.querySelector('.page-view').scrollTop = 0`)
  await until(
    `window.__demo.view.layout.complete === true && window.__demo.view.layout.pages.length > 90 && (() => { const pages = [...document.querySelectorAll('.page[data-mounted="1"]')].map((el) => Number(el.dataset.page)); return pages.length > 0 && Math.max(...pages) <= 2 })()`,
    { timeout: 60000, label: 'back on the first pages of a complete layout' },
  )
  const bench = evaluate(`window.__demo.editBench()`)
  console.log(`  ${JSON.stringify(bench)}`)
  assert(bench.p95 < 8, `p95 ${bench.p95} ms (max ${bench.max})`)
  assert(bench.after > bench.before, `pages ${bench.before} -> ${bench.after}`)
  assert(bench.laterAfter > bench.laterBefore, `later page ${bench.laterBefore} -> ${bench.laterAfter}`)
})

await check('console has no errors', async () => {
  const errors = consoleErrors()
  assert(errors.length === 0, errors.join('\n'))
})

mkdirSync(`${root}docs/design/evidence/view`, { recursive: true })
copyFileSync(straddleShot, `${root}docs/design/evidence/view/straddle.png`)

summary()
