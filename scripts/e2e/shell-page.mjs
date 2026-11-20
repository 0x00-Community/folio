// Unit 2: page setup. Open long.docx, set margins of 144 pt, then A4 landscape.
// Edits go through acde act. Save is the one call the brief makes through window.__word.save.
// Run by the reviewer. This dispatch only syntax-checks the file.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { act, assert, check, consoleErrors, ensureDev, evaluate, namedRef, ref, root, summary, until } from './acde.mjs'

const STRINGS = {
  en: {
    pageSetup: 'Page setup',
    paper: 'Paper size',
    landscape: 'Landscape',
    ok: 'OK',
    cancel: 'Cancel',
    typed: '2',
    probe: '3',
    margins: {
      top: 'Top margin (in)',
      right: 'Right margin (in)',
      bottom: 'Bottom margin (in)',
      left: 'Left margin (in)',
    },
  },
  zh: {
    pageSetup: '页面设置',
    paper: '纸张大小',
    landscape: '横向',
    ok: '确定',
    cancel: '取消',
    typed: '5.08',
    probe: '8',
    margins: {
      top: '上边距（厘米）',
      right: '右边距（厘米）',
      bottom: '下边距（厘米）',
      left: '左边距（厘米）',
    },
  },
}

const ARG_LIMIT = 100 * 1024
const CHUNK = 48 * 1024
const longDoc = readFileSync(new URL('../../fixtures/long.docx', import.meta.url)).toString('base64')

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

function sectionPage() {
  return evaluate(`(() => {
    const page = window.__word.editor.state.doc.sections[0].page
    return {
      widthPt: page.widthPt,
      heightPt: page.heightPt,
      top: page.margin.top,
      right: page.margin.right,
      bottom: page.margin.bottom,
      left: page.margin.left,
      header: page.margin.header,
      footer: page.margin.footer,
      gutter: page.margin.gutter,
    }
  })()`)
}

function samePage(actual, expected, label) {
  for (const key of Object.keys(expected)) {
    const got = actual[key]
    const want = expected[key]
    assert(typeof got === 'number' && Math.abs(got - want) < 0.05, `${label} ${key} ${got} vs ${want}`)
  }
}

function statusText() {
  return String(evaluate(`document.querySelector('#status') ? document.querySelector('#status').textContent : ''`))
}

function pageCount() {
  const text = statusText()
  assert(!text.includes('≥'), `pagination not finished: ${text}`)
  const match = text.match(/(?:of |共 )(\d+)/)
  assert(match, `status ${text}`)
  return Number(match[1])
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

async function openPageDialog() {
  act(buttonRef(ui.pageSetup, false), 'click')
  await until(`(() => {
    const dialog = document.querySelector('[role="dialog"]')
    if (!dialog) return false
    const backdrop = dialog.closest('.unsaved')
    return backdrop && backdrop.hidden !== true
  })()`, { label: 'page setup dialog' })
}

async function dialogClosed() {
  await until(`document.querySelector('.unsaved') && document.querySelector('.unsaved').hidden === true`, { label: 'dialog closed' })
}

function replaceField(name, value) {
  const field = namedRef(name)
  act(field, 'focus')
  act(field, 'key', `${mod}+a`)
  act(field, 'type', value)
}

await ensureDev()
const token = `page-${Date.now()}`
goTracked(`?boot=${token}`)
await until(
  `new URLSearchParams(location.search).get('boot') === ${JSON.stringify(bootToken)} && !!(window.__word && window.__word.save)`,
  { timeout: 60000, label: 'shell' },
)

const ui = names()
const platform = evaluate('window.__word.platform')
assert(platform === 'mac' || platform === 'other', `platform ${platform}`)
const mod = platform === 'mac' ? 'meta' : 'ctrl'

await check('Escape and Cancel leave the document unchanged and clean', async () => {
  await openDocument(longDoc, 'long.docx')
  const opened = evaluate(`window.__wordError || ''`)
  assert(!opened, opened)
  assert(dirty() === false, 'a fresh open is clean')
  await until(`window.__word.editor.status().pagesFinal === true`, { timeout: 60000, label: 'pagination finished' })
  const before = sectionPage()
  const count = pageCount()
  assert(count >= 1, `pages ${count}`)
  await openPageDialog()
  replaceField(ui.margins.top, ui.probe)
  act(namedRef(ui.margins.top), 'key', 'escape')
  await dialogClosed()
  assert(dialogOpen() === false, 'Escape closed the dialog')
  samePage(sectionPage(), before, 'escape')
  assert(dirty() === false, 'Escape did not dirty the document')
  await openPageDialog()
  replaceField(ui.margins.top, ui.probe)
  act(buttonRef(ui.cancel, true), 'click')
  await dialogClosed()
  samePage(sectionPage(), before, 'cancel')
  assert(dirty() === false, 'Cancel did not dirty the document')
})

await check('margins of 144 pt raise the page count', async () => {
  const before = pageCount()
  await openPageDialog()
  for (const name of [ui.margins.top, ui.margins.right, ui.margins.bottom, ui.margins.left]) {
    replaceField(name, ui.typed)
  }
  act(buttonRef(ui.ok, true), 'click')
  await until(`(() => {
    const text = document.querySelector('#status') ? document.querySelector('#status').textContent : ''
    if (String(text).includes('≥')) return false
    const match = String(text).match(/(?:of |共 )(\\d+)/)
    return match && Number(match[1]) > ${before}
  })()`, { timeout: 20000, label: 'page count rises' })
  await dialogClosed()
  const ms = evaluate('window.__word.pageSetupMs()')
  console.log(`pageSetupMs ${ms}`)
  assert(typeof ms === 'number' && ms > 0, `pageSetupMs ${ms}`)
  assert(pageCount() > before, `pages ${pageCount()} from ${before}`)
})

await check('A4 landscape makes the first page wider than tall', async () => {
  await openPageDialog()
  act(ref('[role="dialog"] select'), 'select', 'A4')
  act(namedRef(ui.landscape), 'click')
  act(buttonRef(ui.ok, true), 'click')
  await until(`(() => {
    const page = document.querySelector('.page')
    if (!page) return false
    const rect = page.getBoundingClientRect()
    return rect.width > rect.height && rect.height > 0
  })()`, { label: 'landscape page box' })
  await dialogClosed()
  const box = evaluate(`(() => {
    const page = document.querySelector('.page')
    const rect = page.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  })()`)
  assert(box.width > box.height, `page box ${box.width} x ${box.height}`)
})

await check('saving and reopening keeps the page setup', async () => {
  const before = sectionPage()
  assert(before.widthPt > before.heightPt, `model ${before.widthPt} x ${before.heightPt}`)
  const saved = evaluate('window.__word.save()')
  assert(saved && typeof saved.base64 === 'string' && saved.base64.length > 0, 'save returned no bytes')
  await openDocument(saved.base64, 'long-page.docx')
  const error = evaluate(`window.__wordError || ''`)
  assert(!error, error)
  samePage(sectionPage(), before, 'reopened')
})

await check('console has no errors', async () => {
  const errors = consoleErrors()
  assert(errors.length === 0, errors.join('\n'))
})

summary()
