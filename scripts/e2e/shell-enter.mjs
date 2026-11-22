import { readFileSync } from 'node:fs'
import { act, assert, check, consoleErrors, ensureDev, evaluate, freshPage, namedRef, root, summary, until } from './acde.mjs'

// The caret after Enter, and after a second Enter on the empty paragraph the first one made.

function inputRef() {
  const errors = []
  for (const name of ['Document text', '文档正文']) {
    try {
      return namedRef(name)
    } catch (error) {
      errors.push(String(error.message || error))
    }
  }
  throw new Error(errors.join('; '))
}

function caretFact() {
  return evaluate(`(() => {
    const editor = window.__word.editor
    const sel = editor.state.sel
    const body = editor.state.doc.body
    const index = body.findIndex((block) => block.id === sel.head.p)
    const caret = document.querySelector('.caret')
    const box = caret ? caret.getBoundingClientRect() : null
    const page = caret ? caret.closest('.page').getBoundingClientRect() : null
    const el = [...document.querySelectorAll('.page[data-mounted="1"] .page-body .blk')].find((node) => node.dataset.id === sel.head.p)
    const para = el ? el.getBoundingClientRect() : null
    return {
      paragraphs: body.length,
      index,
      offset: sel.head.o,
      caret: box && page ? { x: Math.round(box.left - page.left), y: Math.round(box.top - page.top), h: Math.round(box.height) } : null,
      para: para && page ? { x: Math.round(para.left - page.left), y: Math.round(para.top - page.top), h: Math.round(para.height) } : null,
    }
  })()`)
}

function assertCaretInParagraph(fact, label) {
  assert(fact.caret && fact.para, `${label}: no caret or paragraph ${JSON.stringify(fact)}`)
  assert(
    fact.caret.y >= fact.para.y - 1 && fact.caret.y < fact.para.y + Math.max(fact.para.h, 1) + 1,
    `${label}: caret y ${fact.caret.y} is outside its paragraph at ${fact.para.y}+${fact.para.h} ${JSON.stringify(fact)}`,
  )
  assert(fact.caret.x >= fact.para.x - 1, `${label}: caret x ${fact.caret.x} is left of its paragraph at ${fact.para.x}`)
}

async function frames() {
  evaluate(`(() => { window.__enterFrames = 0; requestAnimationFrame(() => requestAnimationFrame(() => { window.__enterFrames = 1 })); return 1 })()`)
  await until(`window.__enterFrames === 1`, { timeout: 5000, label: 'two frames' })
}

await ensureDev()
await freshPage(`!!(window.__word && window.__word.editor)`, { label: 'shell' })

await check('the caret follows one Enter and then a second Enter', async () => {
  const sink = inputRef()
  act(sink, 'focus')
  act(sink, 'type', 'first line')
  act(sink, 'key', 'enter')
  await frames()
  const one = caretFact()
  console.log(`  one enter ${JSON.stringify(one)}`)
  assert(one.paragraphs === 2 && one.index === 1 && one.offset === 0, `model after one Enter ${JSON.stringify(one)}`)
  assertCaretInParagraph(one, 'one Enter')
  act(sink, 'key', 'enter')
  await frames()
  const two = caretFact()
  console.log(`  two enters ${JSON.stringify(two)}`)
  assert(two.paragraphs === 3 && two.index === 2 && two.offset === 0, `model after two Enters ${JSON.stringify(two)}`)
  assertCaretInParagraph(two, 'two Enters')
  assert(two.caret.y > one.caret.y, `the caret did not move down: ${one.caret.y} then ${two.caret.y}`)
  act(sink, 'type', 'third')
  await frames()
  const typed = caretFact()
  console.log(`  typed ${JSON.stringify(typed)}`)
  assert(typed.index === 2 && typed.offset === 5, `typing after two Enters ${JSON.stringify(typed)}`)
  assertCaretInParagraph(typed, 'typing')
})

await check('Enter at the end of a paragraph on the first of two pages shows the new paragraph', async () => {
  const base64 = readFileSync(`${root}/fixtures/basic.docx`).toString('base64')
  evaluate(`(() => {
    window.__enterOpen = 0
    Promise.resolve(window.__word.openBytes(${JSON.stringify(base64)}, 'basic.docx')).then(() => { window.__enterOpen = 1 })
    return 1
  })()`)
  await until(`window.__enterOpen === 1 && window.__word.editor.status().pagesFinal === true`, { timeout: 60000, label: 'basic.docx laid out' })
  assert(evaluate(`window.__word.editor.view.layout.pages.length`) >= 2, 'basic.docx has two pages')
  act(namedRef('Right aligned paragraph.'), 'click')
  const sink = inputRef()
  act(sink, 'focus')
  act(sink, 'key', 'end')
  await frames()
  const before = caretFact()
  assertCaretInParagraph(before, 'before Enter')
  act(sink, 'key', 'enter')
  await frames()
  const one = caretFact()
  console.log(`  one enter ${JSON.stringify(one)}`)
  assert(one.paragraphs === before.paragraphs + 1 && one.index === before.index + 1, `model after one Enter ${JSON.stringify(one)}`)
  assertCaretInParagraph(one, 'one Enter')
  assert(one.caret.y > before.caret.y, `the caret did not move down: ${before.caret.y} then ${one.caret.y}`)
  act(sink, 'key', 'enter')
  await frames()
  const two = caretFact()
  console.log(`  two enters ${JSON.stringify(two)}`)
  assertCaretInParagraph(two, 'two Enters')
  assert(two.caret.y > one.caret.y, `the caret did not move down: ${one.caret.y} then ${two.caret.y}`)
  act(sink, 'type', '新段落')
  await frames()
  const typed = caretFact()
  assert(typed.index === two.index && typed.offset === 3, `typing after two Enters ${JSON.stringify(typed)}`)
  assertCaretInParagraph(typed, 'typing')
})

await check('console has no errors', async () => {
  const errors = consoleErrors()
  assert(errors.length === 0, errors.join('\n'))
})

await summary()
