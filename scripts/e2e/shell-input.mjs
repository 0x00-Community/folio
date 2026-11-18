import { readFileSync } from 'node:fs'
import { act, assert, check, consoleErrors, ensureDev, evaluate, namedRef, summary, until } from './acde.mjs'

// acde eval puts the expression on the command line. A long fixture is staged on the page instead.
const ARG_LIMIT = 100 * 1024
const CHUNK = 48 * 1024

const basic = readFileSync(new URL('../../fixtures/basic.docx', import.meta.url)).toString('base64')
const long = readFileSync(new URL('../../fixtures/long.docx', import.meta.url)).toString('base64')

await ensureDev()

try {
  evaluate(`location.hash = ''; location.reload()`)
} catch {
  // Reloading the page aborts the eval.
}
await until(`!!(window.__word && window.__word.editor)`, { timeout: 60000, label: 'editor' })

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

function readModel() {
  return evaluate(`(() => {
    const editor = window.__word.editor
    const sel = editor.state.sel
    const paras = []
    for (const block of editor.state.doc.body) {
      if (block.kind !== 'p') continue
      let text = ''
      const runs = []
      for (const inline of block.inlines) {
        if (inline.kind !== 'text') {
          text += '\\uFFFC'
          continue
        }
        text += inline.text
        runs.push({ text: inline.text, bold: inline.marks.bold === true })
      }
      paras.push({ id: block.id, text, runs })
    }
    const caret = sel.kind === 'text' ? { p: sel.head.p, o: sel.head.o } : null
    return {
      error: window.__wordError || '',
      paras,
      caret,
      pagesFinal: editor.status().pagesFinal,
    }
  })()`)
}

function paraById(model, id) {
  return model.paras.find((para) => para.id === id)
}

function inputRef() {
  const errors = []
  for (const name of ['Document text', '文档正文']) {
    try {
      return namedRef(name)
    } catch (error) {
      errors.push(String(error.message || error))
    }
  }
  throw new Error(errors.join('\n'))
}

function caretOf(model) {
  assert(model.caret, `no caret: ${JSON.stringify(model)}`)
  return model.caret
}

await openDocument(basic)
evaluate(`(() => { const view = document.querySelector('.page-view'); if (view) view.scrollTop = 0; return 1 })()`)

const platform = evaluate(`window.__word.platform`)
assert(platform === 'mac' || platform === 'other', `platform ${platform}`)
const mod = platform === 'mac' ? 'meta' : 'ctrl'

let sink = inputRef()
act(sink, 'focus')
act(namedRef('Quarterly report'), 'click')
// placeSink moves the textarea onto the caret's page. Take the ref again in case the move minted a new one,
// and focus it so the following act type/key hits the sink if the click moved focus.
sink = inputRef()
act(sink, 'focus')

let before = readModel()
assert(!before.error, before.error)
const origin = caretOf(before)
const originPara = paraById(before, origin.p)
assert(originPara, `missing paragraph ${origin.p}`)
assert(originPara.text.includes('Quarterly report'), `clicked ${JSON.stringify(originPara.text)}`)

await check('typing English inserts at the caret', async () => {
  act(sink, 'type', 'Hello')
  const model = readModel()
  const para = paraById(model, origin.p)
  assert(para, `missing paragraph ${origin.p}`)
  const expected = originPara.text.slice(0, origin.o) + 'Hello' + originPara.text.slice(origin.o)
  assert(para.text === expected, `text ${JSON.stringify(para.text)} expected ${JSON.stringify(expected)}`)
  before = model
})

await check('typing Chinese inserts at the caret', async () => {
  const caret = caretOf(before)
  const paraBefore = paraById(before, caret.p)
  assert(paraBefore, `missing paragraph ${caret.p}`)
  act(sink, 'type', '中文输入')
  const model = readModel()
  const para = paraById(model, caret.p)
  assert(para, `missing paragraph ${caret.p}`)
  const expected = paraBefore.text.slice(0, caret.o) + '中文输入' + paraBefore.text.slice(caret.o)
  assert(para.text === expected, `text ${JSON.stringify(para.text)} expected ${JSON.stringify(expected)}`)
  before = model
})

let splitFrom
await check('enter splits the paragraph at the caret', async () => {
  splitFrom = before
  const caret = caretOf(splitFrom)
  const paraBefore = paraById(splitFrom, caret.p)
  assert(paraBefore, `missing paragraph ${caret.p}`)
  const count = splitFrom.paras.length
  act(sink, 'key', 'enter')
  const model = readModel()
  assert(model.paras.length === count + 1, `paragraphs ${count} -> ${model.paras.length}`)
  const head = paraById(model, caret.p)
  const headIndex = model.paras.findIndex((para) => para.id === caret.p)
  const next = model.paras[headIndex + 1]
  assert(head, `missing head ${caret.p}`)
  assert(next, 'enter did not add a following paragraph')
  assert(head.text === paraBefore.text.slice(0, caret.o), `head ${JSON.stringify(head.text)}`)
  assert(next.text === paraBefore.text.slice(caret.o), `tail ${JSON.stringify(next.text)}`)
  const after = caretOf(model)
  assert(after.p === next.id && after.o === 0, `caret ${after.p}@${after.o}`)
  before = model
})

await check('backspace at the new paragraph joins it with the previous one', async () => {
  const caret = caretOf(splitFrom)
  const paraBefore = paraById(splitFrom, caret.p)
  assert(paraBefore, `missing paragraph ${caret.p}`)
  act(sink, 'key', 'backspace')
  const model = readModel()
  assert(model.paras.length === splitFrom.paras.length, `paragraphs ${model.paras.length} vs ${splitFrom.paras.length}`)
  const para = paraById(model, caret.p)
  assert(para, `missing joined paragraph ${caret.p}`)
  assert(para.text === paraBefore.text, `joined ${JSON.stringify(para.text)}`)
  const after = caretOf(model)
  assert(after.p === caret.p && after.o === caret.o, `caret ${after.p}@${after.o} expected ${caret.p}@${caret.o}`)
  before = model
})

await check('left then right leaves the caret, and the next character lands there', async () => {
  const caret = caretOf(before)
  const paraBefore = paraById(before, caret.p)
  assert(paraBefore, `missing paragraph ${caret.p}`)
  act(sink, 'key', 'left')
  act(sink, 'key', 'right')
  const moved = readModel()
  const back = caretOf(moved)
  assert(back.p === caret.p && back.o === caret.o, `after arrows ${back.p}@${back.o} expected ${caret.p}@${caret.o}`)
  act(sink, 'type', 'Q')
  const model = readModel()
  const para = paraById(model, caret.p)
  assert(para, `missing paragraph ${caret.p}`)
  const expected = paraBefore.text.slice(0, caret.o) + 'Q' + paraBefore.text.slice(caret.o)
  assert(para.text === expected, `text ${JSON.stringify(para.text)}`)
  const after = caretOf(model)
  assert(after.o === caret.o + 1, `offset ${after.o} expected ${caret.o + 1}`)
  before = model
})

await check('arrow down twice then up twice returns to the same position', async () => {
  const caret = caretOf(before)
  act(sink, 'key', 'down')
  act(sink, 'key', 'down')
  act(sink, 'key', 'up')
  act(sink, 'key', 'up')
  const model = readModel()
  const after = caretOf(model)
  assert(after.p === caret.p && after.o === caret.o, `position ${after.p}@${after.o} expected ${caret.p}@${caret.o}`)
  before = model
})

await check('the platform bold chord marks only the text typed after it', async () => {
  const caret = caretOf(before)
  const paraBefore = paraById(before, caret.p)
  assert(paraBefore, `missing paragraph ${caret.p}`)
  act(sink, 'key', `${mod}+b`)
  act(sink, 'type', 'Bold')
  const model = readModel()
  const para = paraById(model, caret.p)
  assert(para, `missing paragraph ${caret.p}`)
  const expected = paraBefore.text.slice(0, caret.o) + 'Bold' + paraBefore.text.slice(caret.o)
  assert(para.text === expected, `text ${JSON.stringify(para.text)}`)
  let cursor = 0
  let boldRun = null
  let previous = null
  for (const run of para.runs) {
    if (cursor === caret.o) {
      boldRun = run
      break
    }
    previous = run
    cursor += run.text.length
  }
  assert(boldRun && boldRun.bold === true && boldRun.text.startsWith('Bold'), `run ${JSON.stringify(boldRun)}`)
  if (previous) assert(previous.bold !== true, `text before is bold: ${JSON.stringify(previous)}`)
  before = model
})

await check('undo removes the bold text and redo puts it back', async () => {
  act(sink, 'key', `${mod}+z`)
  const undone = readModel()
  assert(undone.paras.every((para) => !para.text.includes('Bold')), `still present: ${JSON.stringify(undone.paras.map((para) => para.text))}`)
  const redo = platform === 'mac' ? 'meta+shift+z' : 'ctrl+y'
  act(sink, 'key', redo)
  const redone = readModel()
  const back = redone.paras.some((para) => para.text.includes('Bold'))
  assert(back, `redo lost Bold: ${JSON.stringify(redone.paras.map((para) => para.text))}`)
})

await check('console has no errors', async () => {
  const errors = consoleErrors()
  assert(errors.length === 0, errors.join('\n'))
})

await check('a keystroke on long.docx stays under 8ms at p95', async () => {
  await openDocument(long)
  const placed = evaluate(`(() => {
    const editor = window.__word.editor
    const paras = editor.state.doc.body.filter((block) => block.kind === 'p')
    const para = paras[Math.floor(paras.length / 2)]
    if (!para) return { error: 'no paragraph' }
    let length = 0
    for (const inline of para.inlines) length += inline.kind === 'text' ? inline.text.length : 1
    const pos = { p: para.id, o: Math.min(40, length) }
    editor.run(window.__word.setSelection({ kind: 'text', anchor: pos, head: pos }))
    window.__benchPara = para.id
    return { id: para.id }
  })()`)
  assert(!placed.error, String(placed.error))
  // Typing happens in a paragraph the user can see. The jump above scrolls there, and the pages mount on the next frame.
  await until(`!!document.querySelector('.page[data-mounted="1"] .blk[data-id="' + window.__benchPara + '"]')`, {
    timeout: 8000,
    label: 'caret paragraph mounted',
  })
  const bench = evaluate(`(() => {
    const editor = window.__word.editor
    const para = { id: window.__benchPara }
    const times = []
    for (let i = 0; i < 100; i++) {
      const started = performance.now()
      editor.run(window.__word.insertText('x'))
      times.push(performance.now() - started)
    }
    times.sort((a, b) => a - b)
    const index = Math.ceil(0.95 * times.length) - 1
    return {
      p95: times[index] ?? 0,
      max: times[times.length - 1] ?? 0,
      samples: times.length,
      id: para.id,
      pages: editor.status().pages,
    }
  })()`)
  console.log(`  ${JSON.stringify(bench)}`)
  assert(!bench.error, String(bench.error))
  assert(bench.samples === 100, `samples ${bench.samples}`)
  assert(bench.p95 < 8, `p95 ${bench.p95} ms (max ${bench.max})`)
})

await check('console has no errors after the long document', async () => {
  const errors = consoleErrors()
  assert(errors.length === 0, errors.join('\n'))
})

summary()
