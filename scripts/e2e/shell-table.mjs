// Unit 4: insert a table and edit it. Edits go through acde act.
// Save and reopen go through window.__word, as shell-page.mjs does.
// Run by the reviewer. This dispatch only syntax-checks the file.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { act, assert, check, consoleErrors, ensureDev, evaluate, namedRef, root, shot, summary, until } from './acde.mjs'

const STRINGS = {
  en: {
    insert: 'Insert table',
    rows: 'Rows',
    columns: 'Columns',
    rowAbove: 'Insert row above',
    rowBelow: 'Insert row below',
    deleteRow: 'Delete row',
    columnLeft: 'Insert column left',
    columnRight: 'Insert column right',
    deleteColumn: 'Delete column',
    deleteTable: 'Delete table',
    ok: 'OK',
    cancel: 'Cancel',
    input: 'Document text',
  },
  zh: {
    insert: '插入表格',
    rows: '行数',
    columns: '列数',
    rowAbove: '在上方插入行',
    rowBelow: '在下方插入行',
    deleteRow: '删除行',
    columnLeft: '在左侧插入列',
    columnRight: '在右侧插入列',
    deleteColumn: '删除列',
    deleteTable: '删除表格',
    ok: '确定',
    cancel: '取消',
    input: '文档正文',
  },
}

const ARG_LIMIT = 100 * 1024
const CHUNK = 48 * 1024
const HEAD = 'Centered '
const TAIL = 'paragraph.'
const basicDoc = readFileSync(new URL('../../fixtures/basic.docx', import.meta.url)).toString('base64')
const tablesDoc = readFileSync(new URL('../../fixtures/tables.docx', import.meta.url)).toString('base64')
// acde dev reloads the page when a project file changes. The shot stays outside the project until the checks finish.
const shots = mkdtempSync(`${tmpdir()}/shell-table-`)
const shotFile = `${shots}/inserted.png`

let bootToken = ''

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

function names() {
  const lang = evaluate('document.documentElement.lang')
  const table = STRINGS[lang]
  if (!table) throw new Error(`no strings for lang ${JSON.stringify(lang)}`)
  return table
}

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
  return until(`window.__wordReady === true`, { timeout: 60000, label: 'layout complete' })
}

function inspect(name) {
  try {
    return execFileSync('acde', ['inspect', '--find', name], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    return `${error && error.stdout ? error.stdout : ''}\n${error && error.stderr ? error.stderr : ''}`
  }
}

function buttonRef(name, dialog) {
  const line = inspect(name).split('\n').find((item) => {
    const quoted = item.match(/button "([^"]*)"/)
    if (!quoted || quoted[1] !== name) return false
    const inDialog = item.includes(' in dialog ')
    return dialog ? inDialog : !inDialog
  })
  if (!line) throw new Error(`no ${dialog ? 'dialog ' : ''}button ${JSON.stringify(name)}`)
  const match = line.match(/\[(w\d+\.[\w.]+)\]/)
  if (!match) throw new Error(line)
  return match[1]
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

function focusSink() {
  const sink = inputRef()
  act(sink, 'focus')
  return sink
}

function dirty() {
  return evaluate(`document.title.startsWith('• ')`)
}

function dialogOpen() {
  return evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]')
    if (!dialog) return false
    const backdrop = dialog.closest('.unsaved')
    return !!(backdrop && backdrop.hidden !== true)
  })()`)
}

async function dialogClosed() {
  await until(`document.querySelector('.unsaved') && document.querySelector('.unsaved').hidden === true`, { label: 'dialog closed' })
}

async function openInsertDialog() {
  act(buttonRef(ui.insert, false), 'click')
  await until(`(() => {
    const dialog = document.querySelector('[role="dialog"]')
    if (!dialog) return false
    const backdrop = dialog.closest('.unsaved')
    return backdrop && backdrop.hidden !== true
  })()`, { label: 'insert table dialog' })
}

function replaceField(name, value) {
  const field = namedRef(name)
  act(field, 'focus')
  act(field, 'key', `${mod}+a`)
  act(field, 'type', value)
}

function controlState(name) {
  return evaluate(`(() => {
    const want = ${JSON.stringify(name)}
    const el = [...document.querySelectorAll('button, input')].find((node) => node.getAttribute('aria-label') === want)
    if (!el) return null
    return { disabled: el.disabled === true, invalid: el.getAttribute('aria-invalid') }
  })()`)
}

function okDisabled() {
  return evaluate(`(() => {
    const want = ${JSON.stringify(ui.ok)}
    const dialog = document.querySelector('[role="dialog"]')
    if (!dialog) return null
    const button = [...dialog.querySelectorAll('button')].find((node) => node.textContent === want)
    return button ? button.disabled === true : null
  })()`)
}

function bodyProjection() {
  return evaluate(`(() => {
    const doc = window.__word.editor.state.doc
    function cellTexts(blocks) {
      const out = []
      for (const block of blocks) {
        if (block.kind === 'p') {
          let text = ''
          for (const inline of block.inlines) if (inline.kind === 'text') text += inline.text
          out.push(text)
        } else if (block.kind === 'table') out.push({ nested: true })
      }
      return out
    }
    function project(table) {
      return {
        columns: table.grid.length,
        rows: table.rows.map((row) => row.cells.map((cell) => ({
          span: cell.span,
          vMerge: cell.vMerge,
          text: cellTexts(cell.blocks),
        }))),
      }
    }
    const body = []
    for (const block of doc.body) {
      if (block.kind === 'p') {
        let text = ''
        for (const inline of block.inlines) if (inline.kind === 'text') text += inline.text
        body.push({ kind: 'p', text })
      } else if (block.kind === 'table') body.push({ kind: 'table', table: project(block) })
      else body.push({ kind: block.kind })
    }
    return body
  })()`)
}

function caretPlace() {
  return evaluate(`(() => {
    const state = window.__word.editor.state
    if (!state || state.sel.kind !== 'text') return null
    const id = state.sel.head.p
    function textOf(para) {
      let text = ''
      for (const inline of para.inlines) if (inline.kind === 'text') text += inline.text
      return text
    }
    function find(blocks, address) {
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i]
        if (block.kind === 'p' && block.id === id) return { address, o: state.sel.head.o, text: textOf(block) }
        if (block.kind !== 'table') continue
        for (let r = 0; r < block.rows.length; r++) {
          const row = block.rows[r]
          for (let c = 0; c < row.cells.length; c++) {
            const hit = find(row.cells[c].blocks, address.concat([{ index: i, row: r, cell: c }]))
            if (hit) return hit
          }
        }
      }
      return null
    }
    return find(state.doc.body, [])
  })()`)
}

function sizeOf(table) {
  if (!table) return null
  return { rows: table.rows.length, columns: table.columns }
}

function tableBetween(body, before, after) {
  for (let i = 1; i < body.length - 1; i++) {
    const prev = body[i - 1]
    const next = body[i + 1]
    if (body[i].kind === 'table' && prev.kind === 'p' && next.kind === 'p' && prev.text === before && next.text === after) {
      return body[i].table
    }
  }
  return null
}

function tableContaining(body, text) {
  const found = body.find((block) => block.kind === 'table' && block.table.rows.some((row) => (
    row.some((cell) => cell.text.some((part) => part.includes(text)))
  )))
  return found ? found.table : null
}

function sameJson(actual, expected, label) {
  const got = JSON.stringify(actual)
  const want = JSON.stringify(expected)
  assert(got === want, `${label}\n${got}\n${want}`)
}

function scrollTo(label) {
  evaluate(`(() => {
    const want = ${JSON.stringify(label)}
    const el = [...document.querySelectorAll('.blk.p')].find((node) => node.getAttribute('aria-label') === want && node.getAttribute('aria-hidden') !== 'true')
    if (el) el.scrollIntoView({ block: 'center' })
    return !!el
  })()`)
}

async function openBasic() {
  await openDocument(basicDoc, 'basic.docx')
  const error = evaluate(`window.__wordError || ''`)
  assert(!error, error)
  await until(`window.__word.editor.status().pagesFinal === true`, { timeout: 60000, label: 'pagination finished' })
}

await ensureDev()
const token = `table-${Date.now()}`
goTracked(`?boot=${token}`)
await until(
  `new URLSearchParams(location.search).get('boot') === ${JSON.stringify(bootToken)} && !!(window.__word && window.__word.save)`,
  { timeout: 60000, label: 'shell' },
)

const ui = names()
const platform = evaluate('window.__word.platform')
assert(platform === 'mac' || platform === 'other', `platform ${platform}`)
const mod = platform === 'mac' ? 'meta' : 'ctrl'

await check('an out-of-range size disables confirm and Escape leaves the document clean', async () => {
  await openBasic()
  assert(dirty() === false, 'a fresh open is clean')
  const before = bodyProjection()
  const insert = controlState(ui.insert)
  const row = controlState(ui.rowAbove)
  const column = controlState(ui.columnLeft)
  const remove = controlState(ui.deleteTable)
  assert(insert && insert.disabled === false, `insert ${JSON.stringify(insert)}`)
  assert(row && row.disabled === true, `row tool ${JSON.stringify(row)}`)
  assert(column && column.disabled === true, `column tool ${JSON.stringify(column)}`)
  assert(remove && remove.disabled === true, `delete table ${JSON.stringify(remove)}`)
  await openInsertDialog()
  replaceField(ui.rows, '21')
  replaceField(ui.columns, '11')
  const rows = controlState(ui.rows)
  const cols = controlState(ui.columns)
  assert(rows && rows.invalid === 'true', `rows ${JSON.stringify(rows)}`)
  assert(cols && cols.invalid === 'true', `columns ${JSON.stringify(cols)}`)
  assert(okDisabled() === true, 'confirm stays disabled')
  act(namedRef(ui.rows), 'key', 'escape')
  await dialogClosed()
  assert(dialogOpen() === false, 'Escape closed the dialog')
  sameJson(bodyProjection(), before, 'escape changed the document')
  assert(dirty() === false, 'Escape dirtied the document')
})

await check('the table basic.docx already has round-trips a row insert', async () => {
  scrollTo('Apples')
  act(namedRef('Apples'), 'click')
  const inside = controlState(ui.insert)
  const row = controlState(ui.rowBelow)
  const column = controlState(ui.columnRight)
  const remove = controlState(ui.deleteTable)
  assert(inside && inside.disabled === true, `insert inside a table ${JSON.stringify(inside)}`)
  assert(row && row.disabled === false, `row tool in a table ${JSON.stringify(row)}`)
  assert(column && column.disabled === false, `column tool in a table ${JSON.stringify(column)}`)
  assert(remove && remove.disabled === false, `delete table in a table ${JSON.stringify(remove)}`)
  const had = tableContaining(bodyProjection(), 'Apples')
  assert(had && had.rows.length === 3 && had.columns === 3, `fixture table ${JSON.stringify(had)}`)
  act(buttonRef(ui.rowBelow, false), 'click')
  focusSink()
  act(inputRef(), 'type', 'Berry')
  const edited = tableContaining(bodyProjection(), 'Berry')
  assert(edited && edited.rows.length === 4, `after insert row ${JSON.stringify(edited)}`)
  const saved = evaluate('window.__word.save()')
  assert(saved && typeof saved.base64 === 'string' && saved.base64.length > 0, 'save returned no bytes')
  await openBasicBytes(saved.base64, 'basic-table.docx')
  sameJson(tableContaining(bodyProjection(), 'Berry'), edited, 'reopened fixture table')
})

await check('a 2 by 3 table inserted in a paragraph round-trips with its tools', async () => {
  await openBasic()
  scrollTo('Centered paragraph.')
  act(namedRef('Centered paragraph.'), 'click')
  const sink = focusSink()
  act(sink, 'key', 'home')
  for (let i = 0; i < HEAD.length; i++) act(sink, 'key', 'arrowright')
  const placed = caretPlace()
  assert(placed && placed.text === 'Centered paragraph.' && placed.o === HEAD.length, `caret ${JSON.stringify(placed)}`)
  await openInsertDialog()
  replaceField(ui.rows, '2')
  replaceField(ui.columns, '3')
  const rows = controlState(ui.rows)
  const cols = controlState(ui.columns)
  assert(rows && rows.invalid === null, `rows ${JSON.stringify(rows)}`)
  assert(cols && cols.invalid === null, `columns ${JSON.stringify(cols)}`)
  assert(okDisabled() === false, 'confirm is enabled')
  act(buttonRef(ui.ok, true), 'click')
  await until(`(() => {
    const body = window.__word.editor.state.doc.body
    return body.some((block, index) => {
      if (block.kind !== 'table' || block.rows.length !== 2 || block.grid.length !== 3) return false
      const prev = body[index - 1]
      const next = body[index + 1]
      const text = (para) => para && para.kind === 'p' ? para.inlines.map((inline) => inline.kind === 'text' ? inline.text : '').join('') : ''
      return text(prev) === ${JSON.stringify(HEAD)} && text(next) === ${JSON.stringify(TAIL)}
    })
  })()`, { label: 'inserted table' })
  await dialogClosed()
  const place = caretPlace()
  assert(place && place.o === 0 && place.text === '' && place.address.length === 1, `first cell ${JSON.stringify(place)}`)
  assert(place.address[0].row === 0 && place.address[0].cell === 0, `cell ${JSON.stringify(place.address)}`)
  const around = bodyProjection()
  const beforeTable = around[place.address[0].index - 1]
  const afterTable = around[place.address[0].index + 1]
  assert(beforeTable && afterTable && beforeTable.text === HEAD && afterTable.text === TAIL, `halves ${JSON.stringify([beforeTable, afterTable])}`)
  const typing = focusSink()
  const words = ['one', 'two', 'three', 'four', 'five', 'six']
  for (let i = 0; i < words.length; i++) {
    act(typing, 'type', words[i])
    act(typing, 'key', 'tab')
  }
  act(typing, 'type', 'seven')
  const shape = tableBetween(bodyProjection(), HEAD, TAIL)
  assert(shape && shape.rows.length === 3 && shape.columns === 3, `after tab ${JSON.stringify(shape)}`)
  const tools = [
    [ui.rowAbove, 'rows', 1],
    [ui.rowBelow, 'rows', 1],
    [ui.deleteRow, 'rows', -1],
    [ui.columnLeft, 'columns', 1],
    [ui.columnRight, 'columns', 1],
    [ui.deleteColumn, 'columns', -1],
  ]
  for (const [name, key, delta] of tools) {
    const before = sizeOf(tableBetween(bodyProjection(), HEAD, TAIL))
    act(buttonRef(name, false), 'click')
    const after = sizeOf(tableBetween(bodyProjection(), HEAD, TAIL))
    assert(before && after && after[key] === before[key] + delta, `${name} ${key} ${before && before[key]} -> ${after && after[key]}`)
  }
  const edited = tableBetween(bodyProjection(), HEAD, TAIL)
  assert(edited, 'the inserted table is still between the halves')
  scrollTo(HEAD)
  shot(shotFile)
  const saved = evaluate('window.__word.save()')
  assert(saved && typeof saved.base64 === 'string' && saved.base64.length > 0, 'save returned no bytes')
  await openBasicBytes(saved.base64, 'basic-inserted.docx')
  const reopened = bodyProjection()
  sameJson(tableBetween(reopened, HEAD, TAIL), edited, 'reopened inserted table')
  assert(tableBetween(reopened, HEAD, TAIL), 'the halves still surround the table')
})

await check('deleting the inserted table round-trips', async () => {
  scrollTo('four')
  act(namedRef('four'), 'click')
  act(buttonRef(ui.deleteTable, false), 'click')
  const gone = bodyProjection()
  assert(tableBetween(gone, HEAD, TAIL) === null, 'the table is gone')
  assert(adjacent(gone, HEAD, TAIL), `halves ${JSON.stringify(gone.filter((block) => block.kind === 'p').map((block) => block.text))}`)
  const saved = evaluate('window.__word.save()')
  assert(saved && typeof saved.base64 === 'string' && saved.base64.length > 0, 'save returned no bytes')
  await openBasicBytes(saved.base64, 'basic-deleted.docx')
  const reopened = bodyProjection()
  assert(tableBetween(reopened, HEAD, TAIL) === null, 'reopen still has no inserted table')
  assert(adjacent(reopened, HEAD, TAIL), 'the halves stay adjacent')
  assert(tableContaining(reopened, 'Apples'), 'the fixture table stays')
})

const RED = { style: 'single', widthPt: 1, color: 'FF0000' }
const BLACK = { style: 'single', widthPt: 0.5, color: '000000' }
const BLUE = { style: 'single', widthPt: 1.5, color: '0000FF' }
const SIX = (edge) => ({ top: edge, left: edge, bottom: edge, right: edge, insideH: edge, insideV: edge })

function shadowParts(value) {
  if (!value || value === 'none') return []
  const parts = []
  const re = /rgba?\([^)]+\)\s+(-?[\d.]+)px\s+(-?[\d.]+)px/g
  let match = re.exec(value)
  while (match) {
    const color = match[0].slice(0, match[0].indexOf(')') + 1)
    const x = Number(match[1])
    const y = Number(match[2])
    let side = ''
    if (y > 0.05 && Math.abs(x) < 0.05) side = 'top'
    else if (y < -0.05 && Math.abs(x) < 0.05) side = 'bottom'
    else if (x > 0.05 && Math.abs(y) < 0.05) side = 'left'
    else if (x < -0.05 && Math.abs(y) < 0.05) side = 'right'
    parts.push({ color, side })
    match = re.exec(value)
  }
  return parts
}

function tableRecord(heading) {
  return evaluate(`(() => {
    const want = ${JSON.stringify(heading)}
    function textOf(para) {
      return para.inlines.map((inline) => inline.kind === 'text' ? inline.text : '').join('')
    }
    const blocks = window.__word.editor.state.doc.body
    for (let i = 0; i < blocks.length - 1; i++) {
      const block = blocks[i]
      if (block.kind !== 'p' || textOf(block) !== want) continue
      const table = blocks[i + 1]
      if (!table || table.kind !== 'table') return null
      const cell = table.rows[0] && table.rows[0].cells[0]
      return {
        borders: table.props.borders || null,
        cell: cell && cell.borders ? cell.borders : null,
      }
    }
    return null
  })()`)
}

function firstCellShadow(heading) {
  return evaluate(`(() => {
    const want = ${JSON.stringify(heading)}
    const blocks = [...document.querySelectorAll('.blk')].filter((el) => !el.closest('.repeat-head') && el.getAttribute('aria-hidden') !== 'true')
    for (let i = 0; i < blocks.length - 1; i++) {
      const block = blocks[i]
      if (!block.classList.contains('p') || block.getAttribute('aria-label') !== want) continue
      const next = blocks[i + 1]
      if (!next || !next.classList.contains('t')) return ''
      const cell = next.querySelector('td')
      return cell ? getComputedStyle(cell).boxShadow : ''
    }
    return ''
  })()`)
}

function rightEdgeOf(heading) {
  return evaluate(`(() => {
    const want = ${JSON.stringify(heading)}
    const blocks = [...document.querySelectorAll('.blk')].filter((el) => !el.closest('.repeat-head') && el.getAttribute('aria-hidden') !== 'true')
    for (let i = 0; i < blocks.length - 1; i++) {
      const block = blocks[i]
      if (!block.classList.contains('p') || block.getAttribute('aria-label') !== want) continue
      const next = blocks[i + 1]
      if (!next || !next.classList.contains('t')) return null
      const body = next.closest('.page-body')
      const cells = next.querySelectorAll('tr:first-child td')
      const last = cells[cells.length - 1]
      if (!body || !last) return null
      return {
        overflow: last.getBoundingClientRect().right - body.getBoundingClientRect().right,
        shadow: getComputedStyle(last).boxShadow,
      }
    }
    return null
  })()`)
}

await check('tables.docx draws each file\'s borders, and an inserted table keeps them', async () => {
  await openDocument(tablesDoc, 'tables.docx')
  const error = evaluate(`window.__wordError || ''`)
  assert(!error, error)
  await until(`window.__word.editor.status().pagesFinal === true`, { timeout: 60000, label: 'tables.docx pagination' })
  const cases = [
    ['No borders', null, null, []],
    ['Direct borders', SIX(RED), null, ['top', 'left', 'bottom', 'right']],
    ['Table Grid', SIX(BLACK), null, ['top', 'left', 'bottom', 'right']],
    // The cell's right edge is nil. Null is no line, so the table's blue edge shows on that side.
    ['Cell override', SIX(BLUE), { right: null }, ['top', 'left', 'bottom', 'right']],
  ]
  for (const [heading, borders, cell, wantSides] of cases) {
    const record = tableRecord(heading)
    sameJson(record && record.borders, borders, `${heading} table borders`)
    sameJson(record && record.cell, cell, `${heading} cell borders`)
    const parts = shadowParts(firstCellShadow(heading))
    const got = parts.map((part) => part.side).filter(Boolean).sort()
    sameJson(got, wantSides.slice().sort(), `${heading} shadow`)
    if (borders) {
      const color = parts[0] && parts[0].color
      const channel = borders.top.color === 'FF0000' ? '255, 0, 0' : borders.top.color === '0000FF' ? '0, 0, 255' : '0, 0, 0'
      assert(color && color.includes(channel), `${heading} color ${color}`)
    }
  }
  const edge = rightEdgeOf('Direct borders')
  assert(edge && edge.overflow <= 0.5, `full-width right edge ${JSON.stringify(edge)}`)
  assert(shadowParts(edge.shadow).some((part) => part.side === 'right'), `right line ${edge && edge.shadow}`)

  scrollTo('Insert here.')
  act(namedRef('Insert here.'), 'click')
  const sink = focusSink()
  act(sink, 'key', 'home')
  for (let i = 0; i < 'Insert '.length; i++) act(sink, 'key', 'arrowright')
  const placed = caretPlace()
  assert(placed && placed.text === 'Insert here.' && placed.o === 'Insert '.length, `caret ${JSON.stringify(placed)}`)
  await openInsertDialog()
  replaceField(ui.rows, '2')
  replaceField(ui.columns, '2')
  act(buttonRef(ui.ok, true), 'click')
  await until(`(() => {
    const body = window.__word.editor.state.doc.body
    function textOf(para) {
      return para && para.kind === 'p' ? para.inlines.map((inline) => inline.kind === 'text' ? inline.text : '').join('') : ''
    }
    return body.some((block, index) => block.kind === 'table' && block.rows.length === 2 && block.grid.length === 2 && textOf(body[index - 1]) === 'Insert ' && textOf(body[index + 1]) === 'here.')
  })()`, { label: 'inserted bordered table' })
  await dialogClosed()
  const inserted = tableBetween(bodyProjection(), 'Insert ', 'here.')
  assert(inserted, 'the new table sits in the paragraph')
  const model = evaluate(`(() => {
    const body = window.__word.editor.state.doc.body
    function textOf(para) {
      return para.kind === 'p' ? para.inlines.map((inline) => inline.kind === 'text' ? inline.text : '').join('') : ''
    }
    for (let i = 1; i < body.length - 1; i++) {
      if (body[i].kind === 'table' && textOf(body[i - 1]) === 'Insert ' && textOf(body[i + 1]) === 'here.') return body[i].props.borders || null
    }
    return null
  })()`)
  sameJson(model, SIX(BLACK), 'inserted table borders')
  const saved = evaluate('window.__word.save()')
  assert(saved && typeof saved.base64 === 'string' && saved.base64.length > 0, 'save returned no bytes')
  await openDocument(saved.base64, 'tables-inserted.docx')
  const reopenedError = evaluate(`window.__wordError || ''`)
  assert(!reopenedError, reopenedError)
  await until(`window.__word.editor.status().pagesFinal === true`, { timeout: 60000, label: 'reopened inserted table' })
  const again = evaluate(`(() => {
    const body = window.__word.editor.state.doc.body
    function textOf(para) {
      return para.kind === 'p' ? para.inlines.map((inline) => inline.kind === 'text' ? inline.text : '').join('') : ''
    }
    for (let i = 1; i < body.length - 1; i++) {
      if (body[i].kind === 'table' && textOf(body[i - 1]) === 'Insert ' && textOf(body[i + 1]) === 'here.') return body[i].props.borders || null
    }
    return null
  })()`)
  sameJson(again, SIX(BLACK), 'reopened inserted table borders')
  const painted = shadowParts(firstCellShadow('Insert '))
  sameJson(painted.map((part) => part.side).filter(Boolean).sort(), ['bottom', 'left', 'right', 'top'], 'reopened shadow')
})

await check('a tall row continues across pages and stays reachable', async () => {
  await openBasic()
  const lines = Array.from({ length: 120 }, (_, index) => `n${index}`).join('\n')
  const built = evaluate(`(async () => {
    const body = window.__word.editor.state.doc.body
    const first = body.find((block) => block.kind === 'p')
    if (!first) return { ok: false, step: 'no paragraph' }
    const selected = await word.call({ op: 'select', at: { para: first.id, offset: 0 } })
    if (!selected || selected.ok !== true) return { ok: false, step: 'select', code: selected && selected.code }
    const inserted = await word.call({ op: 'insertTable', rows: 1, cols: 1 })
    if (!inserted || inserted.ok !== true) return { ok: false, step: 'insertTable', code: inserted && inserted.code }
    const typed = await word.call({ op: 'insertText', text: ${JSON.stringify(lines)} })
    if (!typed || typed.ok !== true) return { ok: false, step: 'insertText', code: typed && typed.code }
    return { ok: true }
  })()`)
  assert(built && built.ok === true, `build tall row failed at ${built && built.step} ${built && built.code || ''}`)
  await until(`window.__word.editor.status().pagesFinal === true`, { timeout: 60000, label: 'tall row pagination' })
  const laid = evaluate(`(() => {
    const editor = window.__word.editor
    function textOf(para) {
      let text = ''
      for (const inline of para.inlines) if (inline.kind === 'text') text += inline.text
      return text
    }
    let table = null
    for (const block of editor.state.doc.body) {
      if (block.kind !== 'table') continue
      const cell = block.rows[0] && block.rows[0].cells[0]
      const firstPara = cell && cell.blocks.find((child) => child.kind === 'p')
      if (firstPara && textOf(firstPara) === 'n0') table = block
    }
    if (!table) return { error: 'missing table' }
    const paras = []
    for (const child of table.rows[0].cells[0].blocks) {
      if (child.kind === 'p') paras.push({ id: child.id, text: textOf(child) })
    }
    let pages = 0
    for (const page of editor.view.layout.pages) {
      if (page.slices.some((slice) => slice.block === table.id)) pages += 1
    }
    const clipped = []
    for (const page of document.querySelectorAll('.page')) {
      if (page.dataset.mounted !== '1') continue
      const body = page.querySelector('.page-body')
      if (body && body.scrollHeight > body.clientHeight + 1) clipped.push(body.scrollHeight - body.clientHeight)
    }
    let boundary = null
    for (let i = 0; i < paras.length - 1; i++) {
      const left = editor.view.pageOf({ p: paras[i].id, o: paras[i].text.length })
      const right = editor.view.pageOf({ p: paras[i + 1].id, o: 0 })
      if (right === left + 1) {
        boundary = { from: paras[i].id, to: paras[i + 1].id, fromLength: paras[i].text.length }
        break
      }
    }
    return { pages, paras: paras.length, clipped, boundary, target: paras[99] || null }
  })()`)
  assert(laid && !laid.error, laid && laid.error)
  assert(laid.paras === 120, `paragraphs ${laid.paras}`)
  assert(laid.pages >= 3, `table pages ${laid.pages}`)
  assert(laid.clipped.length === 0, `page body clips ${JSON.stringify(laid.clipped)}`)
  assert(laid.boundary, 'no page boundary between cell paragraphs')
  const from = laid.boundary.from
  const to = laid.boundary.to
  const selectedEnd = evaluate(`(async () => word.call({ op: 'select', at: { para: ${JSON.stringify(from)}, offset: 'end' } }))()`)
  assert(selectedEnd && selectedEnd.ok === true, `select end ${selectedEnd && selectedEnd.code || ''}`)
  const sink = focusSink()
  act(sink, 'key', 'down')
  const landed = evaluate(`(() => {
    const sel = window.__word.editor.state.sel
    return sel && sel.kind === 'text' ? sel.head.p : null
  })()`)
  assert(landed === to, `arrow down landed in ${landed}`)
  act(sink, 'key', 'up')
  const back = evaluate(`(() => {
    const sel = window.__word.editor.state.sel
    return sel && sel.kind === 'text' ? { p: sel.head.p, o: sel.head.o } : null
  })()`)
  assert(back && back.p === from && back.o === laid.boundary.fromLength, `arrow up landed at ${JSON.stringify(back)}`)
  const target = laid.target
  assert(target && target.text === 'n99', `100th paragraph ${target && target.text}`)
  const selectedTarget = evaluate(`(async () => word.call({ op: 'select', at: { para: ${JSON.stringify(target.id)}, offset: 0 } }))()`)
  assert(selectedTarget && selectedTarget.ok === true, `select 100th ${selectedTarget && selectedTarget.code || ''}`)
  const caret = evaluate(`(() => {
    const mark = document.querySelector('.caret')
    const page = mark && mark.closest('.page')
    const body = page && page.querySelector('.page-body')
    if (!mark || !body) return null
    const cr = mark.getBoundingClientRect()
    const br = body.getBoundingClientRect()
    return cr.top >= br.top - 1 && cr.bottom <= br.bottom + 1 && cr.left >= br.left - 1 && cr.right <= br.right + 1
  })()`)
  assert(caret === true, 'caret is outside its page body')
  const typing = focusSink()
  act(typing, 'type', 'Q')
  const typed = evaluate(`(() => {
    const sel = window.__word.editor.state.sel
    if (!sel || sel.kind !== 'text') return null
    function textOf(para) {
      let text = ''
      for (const inline of para.inlines) if (inline.kind === 'text') text += inline.text
      return text
    }
    function find(blocks) {
      for (const block of blocks) {
        if (block.kind === 'p' && block.id === sel.head.p) return textOf(block)
        if (block.kind !== 'table') continue
        for (const row of block.rows) {
          for (const cell of row.cells) {
            const hit = find(cell.blocks)
            if (hit !== null) return hit
          }
        }
      }
      return null
    }
    return find(window.__word.editor.state.doc.body)
  })()`)
  assert(typed === 'Qn99', `typed ${JSON.stringify(typed)}`)
})

await check('console has no errors', async () => {
  const errors = consoleErrors()
  assert(errors.length === 0, errors.join('\n'))
})

mkdirSync(`${root}docs/design/evidence/tables`, { recursive: true })
if (existsSync(shotFile)) copyFileSync(shotFile, `${root}docs/design/evidence/tables/inserted.png`)

summary()

function adjacent(body, before, after) {
  for (let i = 0; i < body.length - 1; i++) {
    const left = body[i]
    const right = body[i + 1]
    if (left.kind === 'p' && right.kind === 'p' && left.text === before && right.text === after) return true
  }
  return false
}

async function openBasicBytes(base64, name) {
  await openDocument(base64, name)
  const error = evaluate(`window.__wordError || ''`)
  assert(!error, error)
  await until(`window.__word.editor.status().pagesFinal === true`, { timeout: 60000, label: 'pagination finished' })
}
