import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { act, assert, check, consoleErrors, ensureDev, evaluate, namedRef, root, shot, summary, until } from './acde.mjs'

// Strings mirror src/locales. The page's lang, set from ?lang= or the system language, picks the table.
const STRINGS = {
  en: {
    new: 'New',
    open: 'Open',
    undo: 'Undo',
    redo: 'Redo',
    bold: 'Bold',
    italic: 'Italic',
    underline: 'Underline',
    strike: 'Strikethrough',
    style: 'Paragraph style',
    heading1: 'Heading 1',
    alignLeft: 'Align left',
    alignCenter: 'Align center',
    alignRight: 'Align right',
    alignJustify: 'Justify',
    bullet: 'Bulleted list',
    number: 'Numbered list',
    zoom: 'Zoom',
    untitled: 'Untitled.docx',
    statusPage: 'Page {page} of {pages}',
    statusWords: '{words} words',
    statusZoom: '{zoom}%',
  },
  zh: {
    new: '新建',
    open: '打开',
    undo: '撤销',
    redo: '重做',
    bold: '加粗',
    italic: '倾斜',
    underline: '下划线',
    strike: '删除线',
    style: '段落样式',
    heading1: '标题 1',
    alignLeft: '左对齐',
    alignCenter: '居中',
    alignRight: '右对齐',
    alignJustify: '两端对齐',
    bullet: '项目符号',
    number: '编号',
    zoom: '缩放',
    untitled: '未命名.docx',
    statusPage: '第 {page} 页，共 {pages} 页',
    statusWords: '{words} 个字',
    statusZoom: '{zoom}%',
  },
}

const ALIGN = [
  ['left', 'alignLeft'],
  ['center', 'alignCenter'],
  ['right', 'alignRight'],
  ['justify', 'alignJustify'],
]

const MARKS = ['bold', 'italic', 'underline', 'strike']

const ARG_LIMIT = 100 * 1024
const CHUNK = 48 * 1024

const basic = readFileSync(new URL('../../fixtures/basic.docx', import.meta.url)).toString('base64')

mkdirSync(`${root}docs/design/evidence/shell`, { recursive: true })
// acde dev reloads the page when a project file changes. Screenshots stay outside the project until the last check.
const shots = mkdtempSync(`${tmpdir()}/shell-app-`)

function go(search) {
  try {
    evaluate(`location.assign(location.pathname + ${JSON.stringify(search)})`)
  } catch {
    // Reloading the page aborts the eval.
  }
}

// The token has to be visible to until(), so go() cannot hide it. Keep the last search's boot value here.
let bootToken = ''
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

function labeled(name) {
  return evaluate(`(() => {
    const want = ${JSON.stringify(name)}
    const el = [...document.querySelectorAll('button, select')].find((node) => node.getAttribute('aria-label') === want)
    if (!el) return null
    const selected = el.selectedOptions && el.selectedOptions.length ? el.selectedOptions[0].textContent : null
    return {
      tag: el.tagName,
      pressed: el.getAttribute('aria-pressed'),
      disabled: el.disabled === true,
      value: 'value' in el ? el.value : null,
      title: el.getAttribute('title'),
      selected,
    }
  })()`)
}

function selectionFact() {
  return evaluate(`(() => {
    const editor = window.__word.editor
    const sel = editor.state.sel
    if (!sel || sel.kind !== 'text') return { kind: sel ? sel.kind : 'none' }
    const doc = editor.state.doc
    const para = doc.body.find((block) => block.kind === 'p' && block.id === sel.head.p)
    if (!para) return { kind: 'text', missing: true }
    const from = Math.min(sel.anchor.o, sel.head.o)
    const to = Math.max(sel.anchor.o, sel.head.o)
    const same = sel.anchor.p === sel.head.p
    let offset = 0
    const runs = []
    if (same) {
      for (const inline of para.inlines) {
        const chunk = inline.kind === 'text' ? inline.text : '\\uFFFC'
        const start = offset
        const end = offset + chunk.length
        offset = end
        if (inline.kind !== 'text' || end <= from || start >= to) continue
        const marks = inline.marks || {}
        runs.push({
          bold: marks.bold === true,
          italic: marks.italic === true,
          underline: marks.underline === true,
          strike: marks.strike === true,
        })
      }
    }
    const numbering = para.props.numbering || null
    let format = null
    if (numbering) {
      const def = doc.lists.byNum.get(numbering.num)
      const level = def && def.levels[numbering.level]
      format = level ? level.format : null
    }
    return {
      kind: 'text',
      id: para.id,
      same,
      from,
      to,
      runs,
      style: para.props.style || null,
      align: para.props.align || null,
      format,
    }
  })()`)
}

function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (all, name) => (values[name] === undefined ? all : String(values[name])))
}

function bodyText() {
  return evaluate(`(() => {
    const parts = []
    for (const block of window.__word.editor.state.doc.body) {
      if (block.kind !== 'p') continue
      for (const inline of block.inlines) if (inline.kind === 'text') parts.push(inline.text)
    }
    return parts.join('')
  })()`)
}

function chooseOpen(path) {
  try {
    execFileSync('acde', ['choose', 'open', path], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const stderr = error && error.stderr ? String(error.stderr) : ''
    throw new Error(`acde choose open failed: ${stderr || error.message}`)
  }
}

function requireControl(name, tag) {
  const ref = namedRef(name)
  const info = labeled(name)
  assert(info, `no control labeled ${JSON.stringify(name)}`)
  assert(info.tag === tag, `${name} is ${info.tag}`)
  return { ref, info }
}

await ensureDev()
// A reload is async: the old page still has an editor until the new document commits. The boot token is only on the new URL.
goTracked(`?boot=shell-${Date.now()}`)
await until(
  `new URLSearchParams(location.search).get('boot') === ${JSON.stringify(bootToken)} && !!(window.__word && window.__word.editor)`,
  { timeout: 60000, label: 'shell' },
)

const ui = names()

await check('basic.docx opens with a clean title', async () => {
  await openDocument(basic, 'basic.docx')
  const opened = evaluate(`({ error: window.__wordError || '', title: document.title })`)
  assert(!opened.error, opened.error)
  assert(!opened.title.includes('•'), `title ${opened.title}`)
  assert(opened.title.includes('basic.docx'), `title ${opened.title}`)
  evaluate(`(() => { const view = document.querySelector('.page-view'); if (view) view.scrollTop = 0; return 1 })()`)
})

await check('every toolbar control is found by its accessible name', async () => {
  const buttons = [
    'new', 'open', 'undo', 'redo', 'bold', 'italic', 'underline', 'strike',
    'alignLeft', 'alignCenter', 'alignRight', 'alignJustify', 'bullet', 'number',
  ]
  for (const key of buttons) requireControl(ui[key], 'BUTTON')
  requireControl(ui.style, 'SELECT')
  requireControl(ui.zoom, 'SELECT')
  const bold = labeled(ui.bold)
  const italic = labeled(ui.italic)
  const underline = labeled(ui.underline)
  const undo = labeled(ui.undo)
  const redo = labeled(ui.redo)
  assert(bold.title && (bold.title.includes('Ctrl+B') || bold.title.includes('⌘B')), `bold title ${bold.title}`)
  assert(italic.title && (italic.title.includes('Ctrl+I') || italic.title.includes('⌘I')), `italic title ${italic.title}`)
  assert(underline.title && (underline.title.includes('Ctrl+U') || underline.title.includes('⌘U')), `underline title ${underline.title}`)
  assert(undo.title && (undo.title.includes('Ctrl+Z') || undo.title.includes('⌘Z')), `undo title ${undo.title}`)
  assert(redo.title && (redo.title.includes('Ctrl+Y') || redo.title.includes('⌘Y')), `redo title ${redo.title}`)
  assert(labeled(ui.strike).title === null, 'strike has no keymap chord')
  assert(labeled(ui.new).title === null, 'new has no keymap chord')
})

await check('bold, italic, underline and strike toggle on a selected word', async () => {
  act(namedRef('Quarterly report'), 'double')
  const selected = selectionFact()
  console.log(`  selection ${JSON.stringify(selected)}`)
  assert(selected.kind === 'text' && selected.same && selected.from < selected.to, `selection ${JSON.stringify(selected)}`)
  for (const mark of MARKS) {
    act(namedRef(ui[mark]), 'click')
    let fact = selectionFact()
    let button = labeled(ui[mark])
    assert(button.pressed === 'true', `${mark} pressed ${button.pressed}`)
    assert(fact.id === selected.id && fact.from < fact.to, `${mark} lost the selection ${JSON.stringify(fact)}`)
    assert(fact.runs.length > 0 && fact.runs.every((run) => run[mark] === true), `${mark} on ${JSON.stringify(fact.runs)}`)
    act(namedRef(ui[mark]), 'click')
    fact = selectionFact()
    button = labeled(ui[mark])
    assert(button.pressed === 'false', `${mark} pressed ${button.pressed}`)
    assert(fact.runs.length > 0 && fact.runs.every((run) => run[mark] !== true), `${mark} off ${JSON.stringify(fact.runs)}`)
  }
})

await check('paragraph style and alignment follow the toolbar', async () => {
  act(namedRef(ui.style), 'select', 'Heading1')
  const styled = selectionFact()
  const style = labeled(ui.style)
  console.log(`  style ${JSON.stringify(styled)} shown ${JSON.stringify(style)}`)
  assert(styled.style === 'Heading1', `model style ${styled.style}`)
  assert(style.value === 'Heading1', `select value ${style.value}`)
  assert(style.selected === ui.heading1, `shown ${style.selected}`)
  for (const [align, key] of ALIGN) {
    act(namedRef(ui[key]), 'click')
    const fact = selectionFact()
    assert(fact.align === align, `${align} model ${fact.align}`)
    assert(labeled(ui[key]).pressed === 'true', `${align} pressed`)
    for (const [, other] of ALIGN) {
      if (other === key) continue
      assert(labeled(ui[other]).pressed === 'false', `${other} still pressed`)
    }
  }
})

await check('bullet list and numbered list set the paragraph numbering', async () => {
  act(namedRef(ui.bullet), 'click')
  const bulleted = selectionFact()
  console.log(`  bullet ${JSON.stringify(bulleted)}`)
  assert(bulleted.format === 'bullet', `format ${bulleted.format}`)
  assert(labeled(ui.bullet).pressed === 'true', 'bullet not pressed')
  assert(labeled(ui.number).pressed === 'false', 'number pressed during a bullet list')
  act(namedRef(ui.number), 'click')
  const numbered = selectionFact()
  console.log(`  number ${JSON.stringify(numbered)}`)
  assert(numbered.format === 'decimal', `format ${numbered.format}`)
  assert(labeled(ui.number).pressed === 'true', 'number not pressed')
  assert(labeled(ui.bullet).pressed === 'false', 'bullet stayed pressed')
})

await check('undo reverts the last change and enables redo', async () => {
  assert(labeled(ui.redo).disabled === true, 'redo is enabled before undo')
  act(namedRef(ui.undo), 'click')
  const undone = selectionFact()
  console.log(`  undone ${JSON.stringify(undone)}`)
  assert(undone.format === 'bullet', `format after undo ${undone.format}`)
  assert(labeled(ui.redo).disabled === false, 'redo stayed disabled')
  assert(labeled(ui.undo).disabled === false, 'undo disabled while earlier edits remain')
})

await check('the status bar shows the page count and the word count', async () => {
  const reported = evaluate(`window.__word.editor.status()`)
  const text = evaluate(`document.querySelector('[role="status"]').textContent`)
  const zoom = labeled(ui.zoom)
  const pages = reported.pagesFinal ? String(reported.pages) : `≥${reported.pages}`
  console.log(`  status ${JSON.stringify(text)} reported ${JSON.stringify(reported)}`)
  assert(typeof text === 'string' && text.length > 0, 'empty status')
  assert(text.includes(fill(ui.statusPage, { page: reported.page, pages })), `page phrase missing in ${text}`)
  assert(text.includes(fill(ui.statusWords, { words: reported.words })), `word phrase missing in ${text}`)
  assert(text.includes(fill(ui.statusZoom, { zoom: zoom.value })), `zoom phrase missing in ${text}`)
})

await check('the window title carries the dirty mark after an edit', async () => {
  const title = evaluate('document.title')
  console.log(`  title ${JSON.stringify(title)}`)
  assert(title.startsWith('• '), `title ${title}`)
  assert(title.includes('basic.docx'), `title ${title}`)
})

await check('new document clears the file and the dirty mark', async () => {
  act(namedRef(ui.new), 'click')
  const title = evaluate('document.title')
  const text = bodyText()
  console.log(`  new title ${JSON.stringify(title)} text ${JSON.stringify(text)}`)
  assert(title.includes(ui.untitled), `title ${title}`)
  assert(!title.includes('•'), `title ${title}`)
  assert(text === '', `new document text ${JSON.stringify(text)}`)
})

await check('open by picker loads the chosen document', async () => {
  chooseOpen(`${root}fixtures/basic.docx`)
  act(namedRef(ui.open), 'click')
  await until(`(() => {
    const body = window.__word && window.__word.editor && window.__word.editor.state.doc.body
    if (!body) return false
    return body.some((block) => block.kind === 'p' && block.inlines.some((inline) => inline.kind === 'text' && inline.text.includes('Quarterly report')))
  })()`, { timeout: 20000, label: 'picked file' })
  const title = evaluate('document.title')
  assert(title.includes('basic.docx'), `title ${title}`)
  assert(!title.includes('•'), `title ${title}`)
})

await check('console has no errors', async () => {
  const errors = consoleErrors()
  assert(errors.length === 0, errors.join('\n'))
})

async function showLocale(lang) {
  const token = `${lang}-${Date.now()}`
  goTracked(`?lang=${lang}&boot=${token}`)
  await until(
    `new URLSearchParams(location.search).get('boot') === ${JSON.stringify(token)} && document.documentElement.lang === ${JSON.stringify(lang)} && !!(window.__word && window.__word.editor)`,
    { timeout: 60000, label: `locale ${lang}` },
  )
  await openDocument(basic, 'basic.docx')
  evaluate(`(() => { const view = document.querySelector('.page-view'); if (view) view.scrollTop = 0; return 1 })()`)
}

await check('screenshot of the window in zh', async () => {
  await showLocale('zh')
  shot(`${shots}/window-zh.png`)
})

await check('screenshot of the window in en', async () => {
  await showLocale('en')
  shot(`${shots}/window-en.png`)
})

for (const name of ['window-zh.png', 'window-en.png']) {
  const from = `${shots}/${name}`
  if (!existsSync(from)) continue
  copyFileSync(from, `${root}docs/design/evidence/shell/${name}`)
}

summary()
