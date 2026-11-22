import { readFileSync } from 'node:fs'
import { assert, check, consoleErrors, ensureDev, evaluate, evidencePath, freshPage, shot, summary, until } from './acde.mjs'

// acde eval puts the expression on the command line. A long fixture is staged on the page instead.
const ARG_LIMIT = 100 * 1024
const CHUNK = 48 * 1024

const basic = readFileSync(new URL('../../fixtures/basic.docx', import.meta.url)).toString('base64')
const long = readFileSync(new URL('../../fixtures/long.docx', import.meta.url)).toString('base64')

await ensureDev()
await freshPage(`!!(window.__word && window.__word.editor)`, { label: 'editor' })

function stage(base64) {
  if (base64.length <= ARG_LIMIT) return JSON.stringify(base64)
  evaluate(`(() => { window.__openB64 = ''; return 1 })()`)
  for (let i = 0; i < base64.length; i += CHUNK) {
    const piece = JSON.stringify(base64.slice(i, i + CHUNK))
    evaluate(`(() => { window.__openB64 += ${piece}; return 1 })()`)
  }
  return 'window.__openB64'
}

function openDocument(base64) {
  const expr = stage(base64)
  evaluate(`(() => {
    window.__wordReady = false
    window.__wordError = ''
    try {
      Promise.resolve(window.__word.openBytes(${expr})).then(
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
  return until(`window.__wordReady === true`, { timeout: 60000, label: 'layout complete' })
}

function opened() {
  return evaluate(`({
    error: window.__wordError,
    pages: window.__word.editor.status().pages,
    pagesFinal: window.__word.editor.status().pagesFinal,
  })`)
}

function firstBlock() {
  return evaluate(`(() => {
    const block = document.querySelector('.page[data-page="0"] .page-body .shift > .blk')
    const para = window.__word.editor.state.doc.body[0]
    const text = para && para.kind === 'p'
      ? para.inlines.map((inline) => inline.kind === 'text' ? inline.text : '\\uFFFC').join('')
      : ''
    const children = block ? [...block.children] : []
    return {
      label: block ? block.getAttribute('aria-label') : null,
      text,
      id: block ? block.dataset.id : null,
      paraId: para ? para.id : null,
      kind: para ? para.kind : null,
      hidden: block ? block.getAttribute('aria-hidden') : null,
      children: children.length,
      hiddenChildren: children.filter((el) => el.getAttribute('aria-hidden') === 'true').length,
    }
  })()`)
}

async function openTwice(name, base64) {
  await openDocument(base64)
  const first = opened()
  await openDocument(base64)
  const second = opened()
  console.log(`  ${name} first=${JSON.stringify(first)} second=${JSON.stringify(second)}`)
  assert(!first.error, String(first.error))
  assert(!second.error, String(second.error))
  assert(first.pagesFinal === true && second.pagesFinal === true, 'layout is not final')
  assert(first.pages > 0, `page count ${first.pages}`)
  assert(first.pages === second.pages, `page count ${first.pages} then ${second.pages}`)
  const block = firstBlock()
  console.log(`  ${name} block=${JSON.stringify(block)}`)
  assert(block.kind === 'p', `first block ${block.kind}`)
  assert(block.id === block.paraId, `id ${block.id} model ${block.paraId}`)
  assert(block.label === block.text, `aria-label ${JSON.stringify(block.label)} flat ${JSON.stringify(block.text)}`)
  assert(block.hidden !== 'true', 'the first copy is hidden')
  assert(block.children > 0 && block.hiddenChildren === block.children, `hidden children ${block.hiddenChildren}/${block.children}`)
}

await check('basic.docx opens twice with a stable page count', async () => {
  await openTwice('basic', basic)
})
evaluate(`(() => { const view = document.querySelector('.page-view'); if (view) view.scrollTop = 0; return 1 })()`)
shot(evidencePath('shell/basic-page1.png'))

await check('long.docx opens twice with a stable page count', async () => {
  await openTwice('long', long)
})
evaluate(`(() => { const view = document.querySelector('.page-view'); if (view) view.scrollTop = 0; return 1 })()`)
shot(evidencePath('shell/long-page1.png'))

await check('console has no errors', async () => {
  const errors = consoleErrors()
  assert(errors.length === 0, errors.join('\n'))
})

await summary()
