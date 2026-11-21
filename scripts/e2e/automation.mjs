// Unit 3: operate the open document through window.word.
// The reviewer runs this. The sandbox cannot reach the acde dev socket.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { act, assert, buttonNamed, check, consoleErrors, ensureDev, evaluate, root, summary, until } from './acde.mjs'

const STRINGS = {
  en: { preview: 'Print preview', close: 'Close', cancel: 'Cancel' },
  zh: { preview: '打印预览', close: '关闭', cancel: '取消' },
}

// 2 by 2 PNG. The same bytes shell-image.mjs inserts through the toolbar.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg=='
const PHRASE = 'Centered paragraph.'
const MARK = 'AUTO'
const SENTENCE = '这是自动化写入的一句中文。'
const CELL = '单元格甲'
const ARG_LIMIT = 100 * 1024
const CHUNK = 48 * 1024
const CALL_BUDGET_MS = 50

const basicDoc = readFileSync(new URL('../../fixtures/basic.docx', import.meta.url)).toString('base64')
const longDoc = readFileSync(new URL('../../fixtures/long.docx', import.meta.url)).toString('base64')

// Flat text of fixtures/basic.docx, in body order. A drawing and a page break each count as one.
const NORMAL = 'Normal'
function paragraphSpec(length, heading, style) {
  return { kind: 'paragraph', length, heading, style }
}
const EXPECTED_BLOCKS = [
  paragraphSpec(16, null, 'Title'),
  paragraphSpec(8, 1, 'Heading1'),
  paragraphSpec(72, null, NORMAL),
  paragraphSpec(19, null, NORMAL),
  paragraphSpec(24, null, NORMAL),
  paragraphSpec(135, null, NORMAL),
  paragraphSpec(5, 2, 'Heading2'),
  paragraphSpec(12, null, NORMAL),
  paragraphSpec(13, null, NORMAL),
  paragraphSpec(13, null, NORMAL),
  paragraphSpec(8, null, NORMAL),
  paragraphSpec(8, null, NORMAL),
  paragraphSpec(10, null, NORMAL),
  paragraphSpec(5, 2, 'Heading2'),
  { kind: 'table', rows: 3, cols: 3 },
  paragraphSpec(7, 2, 'Heading2'),
  paragraphSpec(1, null, NORMAL),
  paragraphSpec(1, null, NORMAL),
  paragraphSpec(8, 1, 'Heading1'),
  paragraphSpec(57, null, NORMAL),
  paragraphSpec(24, null, NORMAL),
  ...Array.from({ length: 9 }, () => paragraphSpec(86, null, NORMAL)),
  ...Array.from({ length: 3 }, () => paragraphSpec(87, null, NORMAL)),
]
const EXPECTED_HEADINGS = [
  { text: 'Overview', level: 1 },
  { text: 'Lists', level: 2 },
  { text: 'Table', level: 2 },
  { text: 'Picture', level: 2 },
  { text: '第二章 中文内容', level: 1 },
]

let bootToken = ''
let lastMs = 0
let basicOk = false

function go(search) {
  try {
    evaluate(`location.assign(location.pathname + ${JSON.stringify(search)})`)
  } catch {
    // Reloading the page aborts the eval.
  }
}

function goTracked(search) {
  const match = search.match(/(?:^|[?&])boot=([^&]+)/)
  bootToken = match ? decodeURIComponent(match[1]) : ''
  go(search)
}

// An eval argument is about 100 KiB. Past that, the bytes are appended in the page.
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
  return until('window.__wordReady === true', { timeout: 120000, label: `open ${name || 'document'}` })
}

async function openFixture(base64, name) {
  await openDocument(base64, name)
  const error = evaluate('window.__wordError || ""')
  assert(!error, error)
  await waitPagesFinal()
}

// acde eval awaits a promise and prints the value as JSON. The timer stays in the page,
// so the number excludes the CLI. The payload is concatenated, not interpolated.
function call(request) {
  const payload = JSON.stringify(request)
  const expression = '(async () => { const started = performance.now(); const response = await word.call('
    + payload
    + '); return { ms: performance.now() - started, response } })()'
  const timed = evaluate(expression)
  if (!timed || typeof timed.ms !== 'number' || !timed.response || typeof timed.response !== 'object') {
    throw new Error(`word.call returned ${JSON.stringify(timed)}`)
  }
  lastMs = timed.ms
  return timed.response
}

function must(response, label) {
  if (!response || response.ok !== true) throw new Error(`${label}: ${JSON.stringify(response)}`)
  return response
}

const pagesFinalExpr = 'word.call('
  + JSON.stringify({ op: 'info' })
  + ').then((info) => !!(info && info.ok === true && info.pagesFinal === true))'

function waitPagesFinal() {
  return until(pagesFinalExpr, { timeout: 120000, label: 'pages final' })
}

function readPaged(op) {
  const blocks = []
  const times = []
  let from = 0
  let total = null
  for (let guard = 0; guard < 10000; guard += 1) {
    const page = must(call({ op, from, count: 500 }), `${op} from ${from}`)
    times.push(lastMs)
    if (total === null) total = page.total
    else if (page.total !== total) throw new Error(`${op} total changed from ${total} to ${page.total}`)
    if (!Array.isArray(page.blocks)) throw new Error(`${op} returned no blocks`)
    for (const block of page.blocks) blocks.push(block)
    if (page.next === null) {
      if (blocks.length !== total) throw new Error(`${op} read ${blocks.length} of ${total}`)
      return { blocks, times }
    }
    if (typeof page.next !== 'number' || page.next <= from) {
      throw new Error(`${op} next ${JSON.stringify(page.next)} did not advance from ${from}`)
    }
    from = page.next
  }
  throw new Error(`${op} did not finish`)
}

function assertBlocks(blocks) {
  assert(blocks.length === EXPECTED_BLOCKS.length, `body blocks ${blocks.length}, expected ${EXPECTED_BLOCKS.length}`)
  blocks.forEach((block, index) => {
    const want = EXPECTED_BLOCKS[index]
    assert(block.index === index, `block ${index} index ${block.index}`)
    assert(block.kind === want.kind, `block ${index} kind ${block.kind}`)
    assert(typeof block.page === 'number' && block.page >= 1, `block ${index} page ${block.page}`)
    if (want.kind === 'paragraph') {
      assert(block.length === want.length, `block ${index} length ${block.length}, expected ${want.length}`)
      assert(block.heading === want.heading, `block ${index} heading ${block.heading}`)
      assert(block.style === want.style, `block ${index} style ${block.style}`)
    } else {
      assert(block.rows === want.rows && block.cols === want.cols, `block ${index} is ${block.rows} by ${block.cols}`)
    }
  })
}

function assertOutline(outline, blocks) {
  assert(outline.truncated === false, 'outline truncated')
  assert(outline.headings.length === EXPECTED_HEADINGS.length, `headings ${outline.headings.length}`)
  outline.headings.forEach((heading, index) => {
    const want = EXPECTED_HEADINGS[index]
    assert(heading.text === want.text, `heading ${index} text ${JSON.stringify(heading.text)}`)
    assert(heading.level === want.level, `heading ${index} level ${heading.level}`)
    assert(typeof heading.page === 'number' && heading.page >= 1, `heading ${index} page ${heading.page}`)
    const block = blocks[heading.from]
    assert(block && block.id === heading.id, `heading ${index} is not block ${heading.from}`)
  })
  const overview = outline.headings[0]
  const lists = outline.headings[1]
  const table = outline.headings[2]
  const picture = outline.headings[3]
  const chapter = outline.headings[4]
  assert(lists.to === table.from - 1, `Lists runs to ${lists.to}, Table starts at ${table.from}`)
  assert(overview.to === chapter.from - 1, `Overview runs to ${overview.to}, the next chapter starts at ${chapter.from}`)
  assert(picture.to === chapter.from - 1, `Picture runs to ${picture.to}`)
}

function assertEqualJson(actual, expected, label) {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left === right) return
  let at = 0
  const n = Math.min(left.length, right.length)
  while (at < n && left[at] === right[at]) at += 1
  const slice = left.slice(Math.max(0, at - 40), at + 40)
  throw new Error(`${label}: ${left.length} chars vs ${right.length}, first difference at ${at}: ${JSON.stringify(slice)}`)
}

function stripIds(value) {
  if (Array.isArray(value)) return value.map(stripIds)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) {
      if (key === 'id') continue
      out[key] = stripIds(value[key])
    }
    return out
  }
  return value
}

function inspect(name) {
  try {
    return execFileSync('acde', ['inspect', '--find', name], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    return `${error && error.stdout ? error.stdout : ''}\n${error && error.stderr ? error.stderr : ''}`
  }
}

function buttonInEitherLocale(key) {
  const errors = []
  for (const lang of ['en', 'zh']) {
    const name = STRINGS[lang][key]
    try {
      return buttonNamed(name)
    } catch (error) {
      errors.push(String(error.message || error))
    }
  }
  throw new Error(errors.join('\n'))
}

async function shows(name) {
  const end = Date.now() + 5000
  let last = ''
  while (Date.now() < end) {
    last = inspect(name)
    if (last.includes(name)) return
    await sleep(150)
  }
  throw new Error(`inspect did not show ${JSON.stringify(name)}: ${last.trim()}`)
}

const previewHiddenExpr = `(() => {
  const region = document.querySelector('.preview')
  const toolbar = document.querySelector('#toolbar')
  return !!(region && region.hidden === true && toolbar && toolbar.hidden !== true)
})()`

const pageReady = `(() => {
  const img = document.querySelector('.preview-pages img')
  return !!(img && img.naturalWidth > 0 && img.naturalHeight > 0)
})()`

async function closePreview() {
  if (evaluate(previewHiddenExpr) === true) return
  const errors = []
  for (const key of ['close', 'cancel']) {
    try {
      act(buttonInEitherLocale(key), 'click')
      await until(previewHiddenExpr, { timeout: 20000, label: 'preview closed' })
      return
    } catch (error) {
      errors.push(String(error.message || error))
    }
  }
  throw new Error(errors.join('\n'))
}

function headingStyle(info, level) {
  const name = `heading ${level}`
  const found = info.styles.find((style) => typeof style.name === 'string' && style.name.trim().toLowerCase() === name)
  assert(found, `no ${name} in ${JSON.stringify(info.styles)}`)
  return found.id
}

function atomsOf(block) {
  if (!block || block.kind !== 'paragraph' || !Array.isArray(block.runs)) return []
  return block.runs.filter((run) => run.atom).map((run) => run.atom)
}

await ensureDev()
const token = `auto-${Date.now()}`
goTracked(`?boot=${token}`)
await until(
  `new URLSearchParams(location.search).get('boot') === ${JSON.stringify(bootToken)} && !!(window.word && window.word.version === 1 && window.__word && window.__word.openBytes)`,
  { timeout: 60000, label: 'shell' },
)

await check('basic.docx reads and edits go through word.call', async () => {
  await openFixture(basicDoc, 'basic.docx')
  const info = must(call({ op: 'info' }), 'info')
  assert(info.name === 'basic.docx', `name ${info.name}`)
  assert(info.dirty === false, 'a freshly opened file is dirty')
  assert(info.pagesFinal === true, 'pages are not final')
  assert(info.blocks === EXPECTED_BLOCKS.length, `info.blocks ${info.blocks}`)
  assert(typeof info.pages === 'number' && info.pages >= 2, `pages ${info.pages}`)
  const heading2 = headingStyle(info, 2)

  const outline = must(call({ op: 'outline' }), 'outline')
  const blocks = readPaged('blocks').blocks
  assertBlocks(blocks)
  assertOutline(outline, blocks)
  const firstText = readPaged('text').blocks
  const end = blocks[outline.headings[0].to]
  assert(end && end.kind === 'paragraph', `the first heading ends on ${end && end.kind}`)

  let edits = 0
  const created = []
  function edit(request) {
    const response = must(call(request), request.op || 'edit')
    edits += 1
    if (Array.isArray(response.created)) {
      for (const id of response.created) created.push(id)
    }
    return response
  }

  const found = must(call({ op: 'find', text: PHRASE, limit: 1 }), 'find')
  assert(found.matches.length === 1, `matches ${found.matches.length}`)
  const match = found.matches[0]
  edit({ op: 'insertText', text: MARK, at: { para: match.para, offset: match.start } })
  const undone = must(call({ op: 'undo' }), 'undo the find insert')
  assert(undone.ok === true, 'undo refused')
  assertEqualJson(readPaged('text').blocks, firstText, 'one undo did not restore the text view')
  const extra = call({ op: 'undo' })
  if (extra.ok !== false || !extra.error || extra.error.code !== 'refused') {
    throw new Error(`insertText at the find match was not exactly one undo: ${JSON.stringify(extra)}`)
  }
  must(call({ op: 'redo' }), 'redo the find insert')

  edit({ op: 'enter', at: { para: end.id, offset: 'end' } })
  edit({ op: 'insertText', text: SENTENCE })
  edit({ op: 'setStyle', style: heading2 })
  const table = edit({ op: 'insertTable', rows: 2, cols: 3 })
  const tableText = must(call({ op: 'text', ids: table.created }), 'table ids')
  const cell = tableText.blocks.find((block) => block.kind === 'paragraph')
  assert(cell, `insertTable created ${JSON.stringify(table.created)}`)
  edit({ op: 'insertText', text: CELL, at: { para: cell.id, offset: 'end' } })
  edit({ op: 'pageBreak' })
  edit({ op: 'insertImage', base64: PNG_B64, contentType: 'image/png' })

  await waitPagesFinal()
  const made = must(call({ op: 'text', ids: created }), 'created ids')
  const sentence = made.blocks.find((block) => block.kind === 'paragraph' && block.text === SENTENCE)
  assert(sentence, 'the created blocks do not contain the sentence')
  assert(sentence.style === heading2, `sentence style ${sentence.style}`)
  const filled = made.blocks.find((block) => block.kind === 'paragraph' && typeof block.text === 'string' && block.text.startsWith(CELL))
  assert(filled, 'the created blocks do not contain the cell text')
  assert(filled.text === `${CELL}\uFFFC\uFFFC`, `cell text ${JSON.stringify(filled.text)}`)
  assertEqualJson(atomsOf(filled), ['pageBreak', 'image'], 'cell atoms')
  const grid = made.blocks.find((block) => block.kind === 'table')
  assert(grid && grid.rows.length === 2, 'the created table does not have 2 rows')
  assert(grid.rows.every((row) => Array.isArray(row.cells) && row.cells.length === 3), 'the created table does not have 3 columns')

  const after = must(call({ op: 'outline' }), 'outline after edits')
  const added = after.headings.find((heading) => heading.text === SENTENCE)
  assert(added, 'the outline has no new heading')
  assert(added.level === 2, `new heading level ${added.level}`)
  assert(typeof added.page === 'number' && added.page >= 1, `new heading page ${added.page}`)

  const edited = readPaged('text').blocks
  let steps = 0
  let current = edited
  while (JSON.stringify(current) !== JSON.stringify(firstText)) {
    if (steps >= edits) {
      throw new Error(`undo did not restore the first text view after ${steps} (bound ${edits})`)
    }
    const response = call({ op: 'undo' })
    if (!response.ok) {
      throw new Error(`undo ${steps + 1} refused after ${steps} undos (bound ${edits}): ${JSON.stringify(response)}`)
    }
    steps += 1
    current = readPaged('text').blocks
  }
  const clean = must(call({ op: 'info' }), 'info after undo')
  assert(clean.dirty === false, 'undo did not return to the saved document')
  for (let i = 0; i < steps; i += 1) {
    const response = call({ op: 'redo' })
    if (!response.ok) throw new Error(`redo ${i + 1} of ${steps} refused: ${JSON.stringify(response)}`)
  }
  assertEqualJson(readPaged('text').blocks, edited, 'redo did not restore the edited text')
  // The edited document is what the preview check reads. Set this before save so a save
  // failure still leaves that document open for the later checks.
  basicOk = true

  const beforeSave = stripIds(edited)
  const saved = evaluate('window.__word.save()')
  assert(saved && typeof saved.base64 === 'string' && saved.base64.length > 0, 'save returned no bytes')
  await openFixture(saved.base64, 'basic.docx')
  const reloaded = stripIds(readPaged('text').blocks)
  assertEqualJson(reloaded, beforeSave, 'the reloaded text view differs')
})

await check('the typed sentence is in the window, and an edit during preview is busy', async () => {
  assert(basicOk, 'the edit script did not finish')
  const located = must(call({ op: 'find', text: SENTENCE, limit: 1 }), 'find sentence')
  assert(located.matches.length === 1, `sentence matches ${located.matches.length}`)
  const hit = located.matches[0]
  // select scrolls that page into the DOM. The preview hides #pages, so the name is
  // looked up while the editor is showing.
  must(call({ op: 'select', at: { para: hit.para, offset: hit.start } }), 'select sentence')
  await shows(SENTENCE)

  act(buttonInEitherLocale('preview'), 'click')
  await until(pageReady, { timeout: 90000, label: 'preview page' })
  const before = must(call({ op: 'find', text: SENTENCE, limit: 1 }), 'find during preview')
  assert(before.matches.length === 1, `sentence matches during preview ${before.matches.length}`)
  const refused = call({ op: 'insertText', text: 'X', at: { para: before.matches[0].para, offset: 'end' } })
  assert(refused.ok === false && refused.error && refused.error.code === 'busy', JSON.stringify(refused))
  assert(String(refused.error.message).includes('preview'), refused.error.message)
  const during = must(call({ op: 'outline' }), 'outline during preview')
  const heading = during.headings.find((item) => item.text === SENTENCE)
  assert(heading, 'outline during preview lost the sentence')
  const after = must(call({ op: 'find', text: SENTENCE, limit: 1 }), 'find after the refused edit')
  assert(after.matches.length === 1 && after.matches[0].end === before.matches[0].end, 'the refused edit changed the sentence')
  await closePreview()
})

await check('long.docx pages are final and no read call exceeds 50 ms', async () => {
  assert(basicOk, 'the edit script did not finish')
  await closePreview()
  await openFixture(longDoc, 'long.docx')
  const info = must(call({ op: 'info' }), 'long info')
  assert(info.name === 'long.docx', `name ${info.name}`)
  assert(info.pagesFinal === true, 'long.docx pages are not final')

  const outline = must(call({ op: 'outline' }), 'long outline')
  const outlineMs = lastMs
  const blocks = readPaged('blocks')
  const text = readPaged('text')
  const blocksMs = blocks.times[0]
  const textMs = text.times.reduce((sum, ms) => sum + ms, 0)
  console.log(`  outline ${outlineMs.toFixed(1)} ms`)
  console.log(`  blocks 500 ${Number(blocksMs).toFixed(1)} ms`)
  console.log(`  text walk ${textMs.toFixed(1)} ms (${text.times.length} calls)`)

  assert(outline.ok === true, 'outline was refused')
  assert(typeof blocksMs === 'number', 'the blocks walk made no call')
  assert(outlineMs <= CALL_BUDGET_MS, `outline took ${outlineMs} ms`)
  blocks.times.forEach((ms, index) => {
    assert(ms <= CALL_BUDGET_MS, `blocks call ${index} took ${ms} ms`)
  })
  text.times.forEach((ms, index) => {
    assert(ms <= CALL_BUDGET_MS, `text call ${index} took ${ms} ms`)
  })
  assert(blocks.blocks.length === info.blocks, `blocks ${blocks.blocks.length} info.blocks ${info.blocks}`)
  assert(text.blocks.length === blocks.blocks.length, `text ${text.blocks.length} blocks ${blocks.blocks.length}`)
  blocks.blocks.forEach((block) => {
    assert(typeof block.page === 'number' && block.page >= 1, `block ${block.index} page ${block.page}`)
  })
})

await check('the app is left on basic.docx with the preview closed', async () => {
  await closePreview()
  await openFixture(basicDoc, 'basic.docx')
  const info = must(call({ op: 'info' }), 'final info')
  assert(info.name === 'basic.docx', `name ${info.name}`)
  assert(evaluate(previewHiddenExpr) === true, 'the preview is still open')
})

await check('console has no errors', async () => {
  const errors = consoleErrors()
  assert(errors.length === 0, errors.join('\n'))
})

summary()
