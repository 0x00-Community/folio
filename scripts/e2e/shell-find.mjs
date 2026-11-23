// Find and replace. The reviewer runs this. The sandbox cannot reach the acde dev socket.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { act, assert, check, closeFileMenu, consoleErrors, ensureDev, evaluate, fileMenuItem, freshPage, ref, root, summary, until } from './acde.mjs'

const STRINGS = {
  en: {
    find: 'Find',
    replace: 'Replace',
    preview: 'Print preview',
    document: 'Document text',
    none: 'No results',
    replaced: 'Replaced 33',
  },
  zh: {
    find: '查找',
    replace: '替换',
    preview: '打印预览',
    document: '文档正文',
    none: '无结果',
    replaced: '已替换 33 处',
  },
}

const longPath = new URL('../../fixtures/long.docx', import.meta.url)
const bytes = readFileSync(longPath)
const base64 = bytes.toString('base64')

function stage(base64) {
  const chunks = []
  for (let i = 0; i < base64.length; i += 8000) chunks.push(base64.slice(i, i + 8000))
  return `[${chunks.map((part) => JSON.stringify(part)).join(',')}].join('')`
}

function lang() {
  const value = evaluate('document.documentElement.lang')
  return value === 'en' ? 'en' : 'zh'
}

function ui() {
  return STRINGS[lang()]
}

function mod() {
  return evaluate('window.__word.platform') === 'mac' ? 'meta' : 'ctrl'
}

function inputRef() {
  const errors = []
  for (const name of [STRINGS.zh.document, STRINGS.en.document]) {
    try {
      return ref(`[aria-label="${name}"]`)
    } catch (error) {
      errors.push(String(error.message || error))
    }
  }
  throw new Error(errors.join('\n'))
}

function searchRoot() {
  return ref('[role="search"]')
}

function findField() {
  return ref(`[role="search"] input.find-query`)
}

function replaceField() {
  return ref(`[role="search"] input.find-replace-text`)
}

function openDocument() {
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
  return until(`window.__wordReady === true && window.__word.editor.status().pagesFinal === true`, {
    timeout: 60000,
    label: 'layout complete',
  })
}

function call(request) {
  return evaluate(`(async () => await word.call(${JSON.stringify(request)}))()`)
}

function focusDoc() {
  act(inputRef(), 'focus')
}

function fill(target, text) {
  act(target, 'focus')
  act(target, 'key', `${mod()}+a`)
  act(target, 'type', text)
}

function activeLabel() {
  return evaluate(`document.activeElement ? (document.activeElement.getAttribute('aria-label') || '') : ''`)
}

function barOpen() {
  return evaluate(`(() => {
    const bar = document.querySelector('[role="search"]')
    return !!(bar && bar.hidden !== true)
  })()`)
}

function statusText() {
  return evaluate(`document.querySelector('[role="search"] [role="status"]').textContent`)
}

function selection() {
  return evaluate(`(() => {
    const sel = window.__word.editor.state.sel
    if (!sel || sel.kind !== 'text' || sel.anchor.p !== sel.head.p) return null
    return {
      para: sel.anchor.p,
      start: Math.min(sel.anchor.o, sel.head.o),
      end: Math.max(sel.anchor.o, sel.head.o),
    }
  })()`)
}

function historyLength() {
  return evaluate(`window.__word.editor.state.history.past.length`)
}

function sameMatch(left, right) {
  return !!left && !!right && left.para === right.para && left.start === right.start && left.end === right.end
}

await ensureDev()
await freshPage('!!(window.__word && window.__word.editor)', { label: 'editor' })

await check('the Find button and mod+f open the bar, and Escape returns to the document', async () => {
  const labels = ui()
  act(ref(`#toolbar button[aria-label="${labels.find}"]`), 'click')
  await sleep(50)
  assert(barOpen(), 'the Find button did not open the bar')
  assert(activeLabel() === labels.find, `focus is ${activeLabel()}`)
  act(findField(), 'key', 'Escape')
  await sleep(50)
  assert(!barOpen(), 'Escape left the bar open')
  assert(activeLabel() === labels.document, `focus after Escape is ${activeLabel()}`)
  focusDoc()
  act(inputRef(), 'key', `${mod()}+f`)
  await sleep(50)
  assert(barOpen(), 'mod+f did not open the bar')
  assert(activeLabel() === labels.find, `focus after mod+f is ${activeLabel()}`)
  act(findField(), 'key', 'Escape')
})

await check('the bar stays one row and Print preview stays in the File menu', async () => {
  const labels = ui()
  const budget = evaluate(`(() => {
    const bar = document.querySelector('#toolbar')
    const end = bar.querySelector('.group.end')
    const prev = end.previousElementSibling
    const box = bar.getBoundingClientRect()
    return {
      height: box.height,
      width: box.width,
      spare: end.getBoundingClientRect().left - prev.getBoundingClientRect().right,
      preview: document.querySelector('#toolbar button[aria-label="${labels.preview}"]') !== null,
    }
  })()`)
  console.log(`toolbar ${budget.width}x${budget.height}, spare ${budget.spare}px`)
  assert(budget.height < 56, `toolbar wrapped: height ${budget.height} (spare ${budget.spare}px at ${budget.width})`)
  assert(budget.preview === false, 'Print preview is still a toolbar button')
  fileMenuItem(labels.preview)
  closeFileMenu()
})

await check('opening the bar does not move the document', async () => {
  await openDocument()
  const errors = evaluate('window.__wordError')
  assert(!errors, errors)
  const before = evaluate(`document.querySelector('#pages .page .blk').getBoundingClientRect().top`)
  act(ref(`#toolbar button[aria-label="${ui().find}"]`), 'click')
  await sleep(50)
  const after = evaluate(`document.querySelector('#pages .page .blk').getBoundingClientRect().top`)
  assert(Math.abs(before - after) <= 1, `block moved from ${before} to ${after}`)
})

await check('Chapter finds 34 matches and next and previous wrap', async () => {
  const labels = ui()
  fill(findField(), 'Chapter')
  await until(`document.querySelector('[role="search"] [role="status"]').textContent.endsWith('/34')`, {
    timeout: 4000,
    label: 'count 1/34',
  })
  const found = await call({ op: 'find', text: 'Chapter', limit: 100 })
  assert(found.ok === true && found.matches.length === 34 && found.truncated === false, JSON.stringify(found))
  assert(sameMatch(selection(), found.matches[0]), `selection ${JSON.stringify(selection())}`)
  assert(activeLabel() === labels.find, 'typing stole focus from the find field')
  act(ref('[role="search"] button.find-next'), 'click')
  await sleep(80)
  assert(sameMatch(selection(), found.matches[1]), 'next did not move to the second match')
  act(ref('[role="search"] button.find-prev'), 'click')
  await sleep(80)
  assert(sameMatch(selection(), found.matches[0]), 'previous did not return to the first match')
  act(ref('[role="search"] button.find-prev'), 'click')
  await sleep(80)
  assert(sameMatch(selection(), found.matches[33]), 'previous did not wrap to the last match')
  act(findField(), 'key', 'Enter')
  await sleep(80)
  assert(sameMatch(selection(), found.matches[0]), 'Enter did not wrap to the first match')
})

await check('match case and whole word change the count', async () => {
  const labels = ui()
  fill(findField(), 'chapter')
  act(ref('[role="search"] button.find-case'), 'click')
  await until(`document.querySelector('[role="search"] [role="status"]').textContent === ${JSON.stringify(labels.none)}`, {
    timeout: 4000,
    label: 'no results for chapter',
  })
  const strict = await call({ op: 'find', text: 'chapter', matchCase: true, limit: 10 })
  assert(strict.ok === true && strict.matches.length === 0, JSON.stringify(strict))
  act(ref('[role="search"] button.find-case'), 'click')
  await until(`document.querySelector('[role="search"] [role="status"]').textContent.endsWith('/34')`, {
    timeout: 4000,
    label: 'case off restores Chapter',
  })
  fill(findField(), 'qui')
  act(ref('[role="search"] button.find-word'), 'click')
  await until(`document.querySelector('[role="search"] [role="status"]').textContent === ${JSON.stringify(labels.none)}`, {
    timeout: 4000,
    label: 'qui is not a whole word',
  })
  const whole = await call({ op: 'find', text: 'qui', wholeWord: true, limit: 10 })
  assert(whole.ok === true && whole.matches.length === 0, JSON.stringify(whole))
  act(ref('[role="search"] button.find-word'), 'click')
  await until(`document.querySelector('[role="search"] [role="status"]').textContent !== ${JSON.stringify(labels.none)}`, {
    timeout: 4000,
    label: 'qui matches inside quick',
  })
  const loose = await call({ op: 'find', text: 'qui', limit: 10 })
  assert(loose.ok === true && loose.matches.length > 0, JSON.stringify(loose))
})

await check('mounted pages tint matches, and closing clears them', async () => {
  fill(findField(), 'Chapter')
  await until(`document.querySelectorAll('.page[data-mounted="1"] .find-hit').length > 0`, {
    timeout: 4000,
    label: 'tints',
  })
  const current = evaluate(`document.querySelectorAll('.page[data-mounted="1"] .find-hit.current').length`)
  assert(current >= 1, 'the current match has no stronger tint')
  act(findField(), 'key', 'Escape')
  await sleep(50)
  const left = evaluate(`document.querySelectorAll('.find-hit').length`)
  assert(left === 0, `closing left ${left} tints`)
})

await check('Replace changes one match and Replace All is one undo entry', async () => {
  const labels = ui()
  focusDoc()
  act(inputRef(), 'key', `${mod()}+f`)
  await sleep(50)
  fill(findField(), 'Chapter')
  await until(`document.querySelector('[role="search"] [role="status"]').textContent.endsWith('/34')`, {
    timeout: 4000,
    label: 'count before replace',
  })
  act(ref('[role="search"] button.find-toggle'), 'click')
  fill(replaceField(), 'ChapX')
  const before = historyLength()
  act(ref('[role="search"] button.find-replace'), 'click')
  await until(`(async () => {
    const found = await word.call({ op: 'find', text: 'Chapter', limit: 100 })
    return found.matches.length === 33
  })()`, { timeout: 4000, label: 'one Chapter replaced' })
  assert(historyLength() === before + 1, 'Replace did not make one undo entry')
  act(ref('[role="search"] button.find-all'), 'click')
  await until(`document.querySelector('[role="search"] [role="status"]').textContent === ${JSON.stringify(labels.replaced)}`, {
    timeout: 4000,
    label: 'replaced 33',
  })
  const gone = await call({ op: 'find', text: 'Chapter', limit: 10 })
  assert(gone.ok === true && gone.matches.length === 0, JSON.stringify(gone))
  assert(historyLength() === before + 2, 'Replace All did not make exactly one more undo entry')
  focusDoc()
  act(inputRef(), 'key', `${mod()}+z`)
  await until(`(async () => {
    const found = await word.call({ op: 'find', text: 'Chapter', limit: 100 })
    return found.matches.length === 33
  })()`, { timeout: 4000, label: 'undo Replace All' })
  act(inputRef(), 'key', `${mod()}+z`)
  await until(`(async () => {
    const found = await word.call({ op: 'find', text: 'Chapter', limit: 100 })
    return found.matches.length === 34
  })()`, { timeout: 4000, label: 'undo the single Replace' })
})

await check('a word with no match shows the no results state', async () => {
  const labels = ui()
  act(ref(`#toolbar button[aria-label="${labels.find}"]`), 'click')
  fill(findField(), 'zzzznotaword')
  await until(`document.querySelector('[role="search"] [role="status"]').textContent === ${JSON.stringify(labels.none)}`, {
    timeout: 4000,
    label: 'no results',
  })
  const invalid = evaluate(`document.querySelector('[role="search"] input.find-query').getAttribute('aria-invalid')`)
  assert(invalid === 'true', `aria-invalid is ${invalid}`)
})

await check('replaced text survives save and reopen', async () => {
  fill(findField(), 'Chapter')
  await until(`document.querySelector('[role="search"] [role="status"]').textContent.endsWith('/34')`, {
    timeout: 4000,
    label: 'Chapter before save',
  })
  fill(replaceField(), 'ChapX')
  act(ref('[role="search"] button.find-replace'), 'click')
  await until(`(async () => {
    const found = await word.call({ op: 'find', text: 'ChapX', limit: 10 })
    return found.matches.length === 1
  })()`, { timeout: 4000, label: 'ChapX before save' })
  // __word.save answers { base64 }, as the other scripts read it.
  const written = evaluate('window.__word.save()')
  const saved = written && typeof written.base64 === 'string' ? written.base64 : ''
  assert(saved.length > 100, `save returned no document: ${JSON.stringify(written).slice(0, 200)}`)
  const expr = stage(saved)
  evaluate(`(() => {
    window.__wordReady = false
    Promise.resolve(window.__word.openBytes(${expr})).then(
      () => { window.__wordReady = true },
      (error) => {
        window.__wordError = String(error && error.message || error)
        window.__wordReady = true
      },
    )
    return 1
  })()`)
  await until(`window.__wordReady === true && window.__word.editor.status().pagesFinal === true`, {
    timeout: 60000,
    label: 'reopen',
  })
  const found = await call({ op: 'find', text: 'ChapX', limit: 10 })
  assert(found.ok === true && found.matches.length === 1, JSON.stringify(found))
})

const errors = await consoleErrors()
if (errors.length) console.log(`console: ${errors.length}`)
await summary()
