// Unit 3: print preview and PDF export through acde act and acde inspect.
// The reviewer runs this. The sandbox cannot reach the acde dev socket.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { act, assert, buttonNamed, check, consoleErrors, ensureDev, evaluate, evidencePath, namedRef, root, shot, summary, until } from './acde.mjs'
import { checkPdf, pdfText, strip } from './pdf-check.mjs'

const STRINGS = {
  en: {
    preview: 'Print preview',
    export: 'Export PDF',
    close: 'Close',
    bold: 'Bold',
    input: 'Document text',
    pages: '{count} pages',
    region: 'Print preview',
    pageAlt: 'Page {page} of {pages}',
  },
  zh: {
    preview: '打印预览',
    export: '导出 PDF',
    close: '关闭',
    bold: '加粗',
    input: '文档正文',
    pages: '共 {count} 页',
    region: '打印预览',
    pageAlt: '第 {page} 页，共 {pages} 页',
  },
}

const SENTENCE = '预览句子甲'
const ARG_LIMIT = 100 * 1024
const CHUNK = 48 * 1024
// One layout of basic.docx is hundreds of megabytes. Later opens must not add another.
const MEMORY_SLACK = 16 * 1024 * 1024
const basicDoc = readFileSync(new URL('../../fixtures/basic.docx', import.meta.url)).toString('base64')

const dir = mkdtempSync(join(tmpdir(), 'shell-print-'))
const pdfPath = join(dir, 'basic.pdf')

const pageReady = `(() => {
  const img = document.querySelector('.preview-pages img')
  return !!(img && img.naturalWidth > 0 && img.naturalHeight > 0)
})()`

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

function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (all, key) => (values[key] === undefined ? all : String(values[key])))
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

function inspect(name) {
  try {
    return execFileSync('acde', ['inspect', '--find', name], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    return `${error && error.stdout ? error.stdout : ''}\n${error && error.stderr ? error.stderr : ''}`
  }
}

function buttonListed(name) {
  return inspect(name).split('\n').some((item) => {
    const quoted = item.match(/button "([^"]*)"/)
    return !!(quoted && quoted[1] === name)
  })
}

function namedListed(name) {
  try {
    namedRef(name)
    return true
  } catch {
    return false
  }
}

function chooseSave(path) {
  execFileSync('acde', ['choose', 'save', path], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function scrollTo(label) {
  evaluate(`(() => {
    const want = ${JSON.stringify(label)}
    const el = [...document.querySelectorAll('.blk.p')].find((node) => node.getAttribute('aria-label') === want && node.getAttribute('aria-hidden') !== 'true')
    if (el) el.scrollIntoView({ block: 'center' })
    return !!el
  })()`)
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

function caret() {
  return evaluate(`(() => {
    const sel = window.__word.editor.state.sel
    if (!sel || sel.kind !== 'text') return null
    return { p: sel.head.p, o: sel.head.o, ap: sel.anchor.p, ao: sel.anchor.o }
  })()`)
}

function previewInfo() {
  return evaluate(`(() => {
    const region = document.querySelector('.preview')
    const count = document.querySelector('.preview-count')
    const img = document.querySelector('.preview-pages img')
    let fonts = []
    try { fonts = JSON.parse(region && region.dataset.fonts || '[]') } catch { fonts = [] }
    const toolbar = document.querySelector('#toolbar')
    const pages = document.querySelector('#pages')
    return {
      hidden: !region || region.hidden === true,
      name: region ? region.getAttribute('aria-label') : '',
      count: count ? count.textContent : '',
      pages: region && region.dataset.pages ? Number(region.dataset.pages) : 0,
      shells: document.querySelectorAll('.preview-page').length,
      alt: img ? img.alt : '',
      naturalWidth: img ? img.naturalWidth : 0,
      naturalHeight: img ? img.naturalHeight : 0,
      cssWidth: img ? img.offsetWidth : 0,
      fonts,
      toolbarHidden: !!(toolbar && toolbar.hidden),
      pagesHidden: !!(pages && pages.hidden),
    }
  })()`)
}

async function waitForFile(path) {
  const end = Date.now() + 30000
  while (Date.now() < end) {
    if (existsSync(path) && readFileSync(path).length > 8) return
    await sleep(150)
  }
  throw new Error(`pdf was not written to ${path}`)
}

async function openBasic() {
  await openDocument(basicDoc, 'basic.docx')
  const error = evaluate(`window.__wordError || ''`)
  assert(!error, error)
  await until(`window.__word.editor.status().pagesFinal === true`, { timeout: 60000, label: 'pagination finished' })
}

await ensureDev()
const token = `print-${Date.now()}`
goTracked(`?boot=${token}`)
await until(
  `new URLSearchParams(location.search).get('boot') === ${JSON.stringify(bootToken)} && !!(window.__word && window.__word.memoryBytes)`,
  { timeout: 60000, label: 'shell' },
)

const ui = names()

await check('the preview shows its own pages and hides the editor', async () => {
  await openBasic()
  scrollTo('Centered paragraph.')
  act(namedRef('Centered paragraph.'), 'click')
  const sink = focusSink()
  act(sink, 'key', 'home')
  act(sink, 'type', SENTENCE)
  await until(`(() => {
    const doc = window.__word.editor.state.doc
    function visit(blocks) {
      for (const block of blocks) {
        if (block.kind === 'p') {
          let text = ''
          for (const inline of block.inlines) if (inline.kind === 'text') text += inline.text
          if (text.includes(${JSON.stringify(SENTENCE)})) return true
        } else if (block.kind === 'table') {
          for (const row of block.rows) for (const cell of row.cells) if (visit(cell.blocks)) return true
        }
      }
      return false
    }
    return visit(doc.body)
  })()`, { label: 'typed sentence' })

  const beforeCaret = caret()
  const scrollBefore = evaluate(`(() => {
    const view = document.querySelector('.page-view')
    if (!view) return 0
    view.scrollTop = 120
    return view.scrollTop
  })()`)
  const title = evaluate('document.title')
  assert(String(title).startsWith('• '), `expected a dirty title, got ${title}`)
  const paragraphs = bodyParagraphs()
  assert(paragraphs.some((text) => String(text).includes(SENTENCE)), 'the sentence is not in a body paragraph')

  act(buttonNamed(ui.preview), 'click')
  await until(pageReady, { timeout: 90000, label: 'first page image' })
  const info = previewInfo()
  assert(info.hidden === false && info.name === ui.region, `region ${JSON.stringify(info)}`)
  assert(info.pages > 0 && info.shells === info.pages, `page count ${JSON.stringify(info)}`)
  assert(info.count === fill(ui.pages, { count: info.pages }), `bar ${info.count}`)
  assert(info.alt === fill(ui.pageAlt, { page: 1, pages: info.pages }), `alt ${info.alt}`)
  assert(info.naturalWidth > 0 && info.naturalHeight > 0, `natural size ${info.naturalWidth}x${info.naturalHeight}`)
  assert(info.cssWidth > 0, 'the image has no css width')
  assert(info.toolbarHidden === true && info.pagesHidden === true, 'the editor is still shown')
  assert(buttonListed(ui.bold) === false, 'the editing toolbar is still reachable')
  assert(buttonListed(ui.preview) === false, 'the preview button is still reachable')
  assert(namedListed('Right aligned paragraph.') === false, 'the page view is still reachable')
  assert(namedListed(ui.input) === false, 'the document text box is still reachable')
  assert(buttonListed(ui.export) === true && buttonListed(ui.close) === true, 'the preview controls are missing')

  chooseSave(pdfPath)
  act(buttonNamed(ui.export), 'click')
  await waitForFile(pdfPath)
  await until(`(() => {
    const region = document.querySelector('.preview')
    const button = [...document.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === ${JSON.stringify(ui.export)})
    return !!(region && region.hidden !== true && button && button.disabled !== true)
  })()`, { timeout: 20000, label: 'export settled' })
  assert(evaluate('document.title') === title, 'export changed the title')
  checkPdf(pdfPath, { pages: info.pages, fonts: info.fonts }, paragraphs, false)
  assert(pdfText(pdfPath).includes(strip(SENTENCE)), 'the pdf is missing the typed sentence')

  act(buttonNamed(ui.close), 'key', 'escape')
  await until(`(() => {
    const region = document.querySelector('.preview')
    const toolbar = document.querySelector('#toolbar')
    return !!(region && region.hidden === true && toolbar && toolbar.hidden !== true)
  })()`, { timeout: 15000, label: 'preview closed' })
  assert(JSON.stringify(caret()) === JSON.stringify(beforeCaret), `caret ${JSON.stringify(caret())} was ${JSON.stringify(beforeCaret)}`)
  if (scrollBefore > 0) {
    await until(`(() => {
      const view = document.querySelector('.page-view')
      return !!(view && Math.abs(view.scrollTop - ${scrollBefore}) < 2)
    })()`, { timeout: 3000, label: 'scroll restored' })
  }
  assert(evaluate('document.title') === title, 'closing changed the title')
  const after = focusSink()
  act(after, 'type', 'Z')
  await until(`(() => {
    function visit(blocks) {
      for (const block of blocks) {
        if (block.kind === 'p') {
          let text = ''
          for (const inline of block.inlines) if (inline.kind === 'text') text += inline.text
          if (text.includes('Z')) return true
        } else if (block.kind === 'table') {
          for (const row of block.rows) for (const cell of row.cells) if (visit(cell.blocks)) return true
        }
      }
      return false
    }
    return visit(window.__word.editor.state.doc.body)
  })()`, { label: 'typing after close' })
})

await check('opening the preview five times does not grow wasm by another layout', async () => {
  const before = evaluate('window.__word.memoryBytes()')
  let afterFirst = before
  for (let i = 0; i < 5; i++) {
    act(buttonNamed(ui.preview), 'click')
    await until(pageReady, { timeout: 90000, label: `preview ${i + 1}` })
    act(buttonNamed(ui.close), 'click')
    await until(`(() => {
      const region = document.querySelector('.preview')
      const toolbar = document.querySelector('#toolbar')
      return !!(region && region.hidden === true && toolbar && toolbar.hidden !== true)
    })()`, { timeout: 15000, label: `closed ${i + 1}` })
    if (i === 0) afterFirst = evaluate('window.__word.memoryBytes()')
  }
  const after = evaluate('window.__word.memoryBytes()')
  const grown = after - afterFirst
  console.log(`  wasm before ${before} after first ${afterFirst} after five ${after}`)
  assert(grown <= MEMORY_SLACK, `wasm grew ${grown} bytes after the first of five previews`)
})

async function showLocale(lang) {
  const boot = `print-${lang}-${Date.now()}`
  goTracked(`?lang=${lang}&boot=${boot}`)
  await until(
    `new URLSearchParams(location.search).get('boot') === ${JSON.stringify(boot)} && document.documentElement.lang === ${JSON.stringify(lang)} && !!(window.__word && window.__word.editor)`,
    { timeout: 60000, label: `locale ${lang}` },
  )
  await openBasic()
  act(buttonNamed(STRINGS[lang].preview), 'click')
  await until(pageReady, { timeout: 90000, label: `${lang} preview` })
  shot(evidencePath(`print/preview-${lang}.png`))
}

await check('screenshot of the preview in zh', async () => {
  await showLocale('zh')
})

await check('screenshot of the preview in en', async () => {
  await showLocale('en')
})

await check('console has no errors', async () => {
  const errors = consoleErrors()
  assert(errors.length === 0, errors.join('\n'))
})

await summary()
