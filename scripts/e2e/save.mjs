// Unit 3: open each fixture, save with no edit, open the bytes again, compare text and marks.
// Run by the reviewer. This file is syntax-checked only in the dispatch.
import { readFileSync } from 'node:fs'
import { ensureDev, evaluate, freshPage, until, check, assert, summary, consoleErrors } from './acde.mjs'

const ARG_LIMIT = 100 * 1024
const CHUNK = 48 * 1024
const FIXTURES = ['basic.docx', 'long.docx', 'preserve.docx']

await ensureDev()
await freshPage(`!!(window.__word && window.__word.save)`, { label: 'save hook' })

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

evaluate(`(() => {
  window.__project = () => {
    const doc = window.__word.editor.state.doc
    function textOf(para) {
      let text = ''
      for (const inline of para.inlines) if (inline.kind === 'text') text += inline.text
      return text
    }
    function runs(para) {
      const out = []
      for (const inline of para.inlines) {
        if (inline.kind === 'atom') {
          out.push({ atom: inline.atom.type })
          continue
        }
        const marks = inline.marks || {}
        const key = JSON.stringify(marks, Object.keys(marks).sort())
        const last = out[out.length - 1]
        if (last && last.text !== undefined && last.key === key) last.text += inline.text
        else out.push({ text: inline.text, marks, key })
      }
      return out.map((run) => {
        const rest = { ...run }
        delete rest.key
        return rest
      })
    }
    function walk(blocks) {
      return blocks.map((block) => {
        if (block.kind === 'p') return { text: textOf(block), runs: runs(block) }
        if (block.kind === 'table') {
          return { kind: 'table', rows: block.rows.map((row) => row.cells.map((cell) => walk(cell.blocks))) }
        }
        return { kind: block.kind, label: block.label, preview: (block.preview || []).map(textOf) }
      })
    }
    return {
      body: walk(doc.body),
      stories: [...doc.stories].map(([key, blocks]) => [key, walk(blocks)]),
    }
  }
  return 1
})()`)

function project() {
  return evaluate(`window.__project()`)
}

function norm(value) {
  if (Array.isArray(value)) return value.map(norm)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = norm(value[key])
    return out
  }
  return value
}

for (const name of FIXTURES) {
  await check(`${name} saves untouched and reopens to the same text and marks`, async () => {
    const base64 = readFileSync(new URL(`../../fixtures/${name}`, import.meta.url)).toString('base64')
    await openDocument(base64, name)
    const opened = evaluate(`window.__wordError || ''`)
    assert(!opened, opened)
    const before = norm(project())
    const saved = evaluate(`window.__word.save()`)
    assert(saved && typeof saved.base64 === 'string' && saved.base64.length > 0, 'save returned no bytes')
    assert(typeof saved.ms === 'number', 'save did not report a time')
    console.log(`  ${name} save ${saved.ms.toFixed(1)} ms`)
    if (name === 'long.docx') assert(saved.ms < 1000, `long.docx save took ${saved.ms.toFixed(1)} ms`)
    await openDocument(saved.base64, name)
    const reopened = evaluate(`window.__wordError || ''`)
    assert(!reopened, reopened)
    const after = norm(project())
    assert(JSON.stringify(after) === JSON.stringify(before), `${name} projection changed`)
  })
}

await check('console has no errors', async () => {
  const errors = consoleErrors()
  assert(errors.length === 0, errors.join('\n'))
})

await summary()
