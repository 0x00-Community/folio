// Unit 5: insert a PNG and a JPEG, reject a file that is not one, and save twice.
// Edits go through acde act. Save and reopen go through window.__word.
// Run by the reviewer. This dispatch does not run the script.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, assert, buttonNamed, check, consoleErrors, ensureDev, evaluate, namedRef, root, shot, summary, until } from './acde.mjs'

const STRINGS = {
  en: {
    insert: 'Insert picture',
    error: 'This file is not a PNG or JPEG image.',
    input: 'Document text',
  },
  zh: {
    insert: '插入图片',
    error: '这个文件不是 PNG 或 JPEG 图片。',
    input: '文档正文',
  },
}

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg=='
const JPEG_B64 = '/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAyAP/bAEMACAoKCwoLDQ0NDQ0NEA8QEBAQEBAQEBAQEBISEhUVFRISEhAQEhIUFBUVFxcXFRUVFRcXGRkZHh4cHCMjJCsrM//EAEwAAQEAAAAAAAAAAAAAAAAAAAAGAQEBAAAAAAAAAAAAAAAAAAAGBxABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAgACAMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIsATX9//9k='

const ARG_LIMIT = 100 * 1024
const CHUNK = 48 * 1024
const HEAD = 'Centered '
const basicDoc = readFileSync(new URL('../../fixtures/basic.docx', import.meta.url)).toString('base64')

const dir = mkdtempSync(join(tmpdir(), 'shell-image-'))
const pngPath = join(dir, 'dot.png')
const jpegPath = join(dir, 'dot.jpg')
const fakePath = join(dir, 'note.png')
writeFileSync(pngPath, Buffer.from(PNG_B64, 'base64'))
writeFileSync(jpegPath, Buffer.from(JPEG_B64, 'base64'))
writeFileSync(fakePath, 'not an image\n')
// acde dev reloads the page when a project file changes. The shot stays outside the project until the checks finish.
const shots = mkdtempSync(join(tmpdir(), 'shell-image-shot-'))
const shotFile = join(shots, 'inserted.png')

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

function chooseOpen(path) {
  try {
    execFileSync('acde', ['choose', 'open', path], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const stderr = error && error.stderr ? String(error.stderr) : ''
    throw new Error(`acde choose open failed: ${stderr || error.message}`)
  }
}

function scrollTo(label) {
  evaluate(`(() => {
    const want = ${JSON.stringify(label)}
    const el = [...document.querySelectorAll('.blk.p')].find((node) => node.getAttribute('aria-label') === want && node.getAttribute('aria-hidden') !== 'true')
    if (el) el.scrollIntoView({ block: 'center' })
    return !!el
  })()`)
}

function images() {
  return evaluate(`(() => {
    function visit(blocks, out) {
      for (const block of blocks) {
        if (block.kind === 'p') {
          let text = ''
          for (const inline of block.inlines) if (inline.kind === 'text') text += inline.text
          for (const inline of block.inlines) {
            if (inline.kind === 'atom' && inline.atom.type === 'image') {
              out.push({
                text,
                media: inline.atom.media,
                widthPt: inline.atom.widthPt,
                heightPt: inline.atom.heightPt,
                src: inline.src,
              })
            }
          }
        } else if (block.kind === 'table') {
          for (const row of block.rows) for (const cell of row.cells) visit(cell.blocks, out)
        }
      }
    }
    const out = []
    visit(window.__word.editor.state.doc.body, out)
    return out
  })()`)
}

function near(got, want) {
  return Math.abs(got - want) < 0.05
}

function errorBand() {
  return evaluate(`(() => {
    const el = document.querySelector('#open-error')
    if (!el) return null
    return { hidden: el.hidden === true, text: el.textContent || '' }
  })()`)
}

function buttonDisabled(name) {
  return evaluate(`(() => {
    const want = ${JSON.stringify(name)}
    const el = [...document.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === want)
    return el ? el.disabled === true : null
  })()`)
}

async function readBytes(key) {
  evaluate(`(() => {
    window.__imgDone = false
    window.__imgB64 = ''
    const url = window.__word.editor.source.imageUrl(${JSON.stringify(key)})
    fetch(url).then((response) => response.arrayBuffer()).then((buffer) => {
      const bytes = new Uint8Array(buffer)
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      window.__imgB64 = btoa(binary)
      window.__imgDone = true
    }, (error) => {
      window.__imgB64 = String(error && error.message || error)
      window.__imgDone = true
    })
    return 1
  })()`)
  await until('window.__imgDone === true', { label: 'image bytes' })
  return evaluate('window.__imgB64')
}

async function openBasic() {
  await openDocument(basicDoc, 'basic.docx')
  const error = evaluate(`window.__wordError || ''`)
  assert(!error, error)
  await until(`window.__word.editor.status().pagesFinal === true`, { timeout: 60000, label: 'pagination finished' })
}

await ensureDev()
const token = `image-${Date.now()}`
goTracked(`?boot=${token}`)
await until(
  `new URLSearchParams(location.search).get('boot') === ${JSON.stringify(bootToken)} && !!(window.__word && window.__word.save)`,
  { timeout: 60000, label: 'shell' },
)

const ui = names()

await check('a PNG lands in a body paragraph and a JPEG lands in a cell', async () => {
  await openBasic()
  const before = images()
  scrollTo('Centered paragraph.')
  act(namedRef('Centered paragraph.'), 'click')
  const sink = focusSink()
  act(sink, 'key', 'home')
  for (let i = 0; i < HEAD.length; i++) act(sink, 'key', 'arrowright')
  chooseOpen(pngPath)
  act(buttonNamed(ui.insert), 'click')
  await until(`(() => [...document.querySelectorAll('img')].some((img) => img.naturalWidth === 2))()`, { timeout: 15000, label: 'png painted' })
  const png = images().find((image) => image.text === 'Centered paragraph.' && near(image.widthPt, 1.5))
  assert(png && near(png.heightPt, 1.5) && png.src === null, `png ${JSON.stringify(png)}`)

  scrollTo('Apples')
  act(namedRef('Apples'), 'click')
  assert(buttonDisabled(ui.insert) === false, 'insert picture stays enabled in a cell')
  chooseOpen(jpegPath)
  act(buttonNamed(ui.insert), 'click')
  await until(`(() => {
    const body = window.__word.editor.state.doc.body
    function visit(blocks) {
      for (const block of blocks) {
        if (block.kind === 'p') {
          let text = ''
          for (const inline of block.inlines) if (inline.kind === 'text') text += inline.text
          if (text.includes('Apples') && block.inlines.some((inline) => inline.kind === 'atom' && inline.atom.type === 'image' && Math.abs(inline.atom.widthPt - 6) < 0.05)) return true
        } else if (block.kind === 'table') {
          for (const row of block.rows) for (const cell of row.cells) if (visit(cell.blocks)) return true
        }
      }
      return false
    }
    return visit(body)
  })()`, { label: 'jpeg in the cell' })
  const jpeg = images().find((image) => image.text.includes('Apples') && near(image.widthPt, 6))
  assert(jpeg && near(jpeg.heightPt, 6), `jpeg ${JSON.stringify(jpeg)}`)
  scrollTo('Centered paragraph.')
  shot(shotFile)
})

await check('a text file renamed to png shows the error and changes nothing', async () => {
  const before = images()
  chooseOpen(fakePath)
  act(buttonNamed(ui.insert), 'click')
  await until(`(() => {
    const el = document.querySelector('#open-error')
    return !!(el && el.hidden !== true && el.textContent === ${JSON.stringify(ui.error)})
  })()`, { label: 'image error' })
  const band = errorBand()
  assert(band && band.hidden === false && band.text === ui.error, `band ${JSON.stringify(band)}`)
  assert(JSON.stringify(images()) === JSON.stringify(before), 'the bad file changed the document')
})

await check('save and reopen keeps both images, and a later save still succeeds', async () => {
  const saved = evaluate('window.__word.save()')
  assert(saved && typeof saved.base64 === 'string' && saved.base64.length > 0, 'save returned no bytes')
  await openDocument(saved.base64, 'basic-images.docx')
  const error = evaluate(`window.__wordError || ''`)
  assert(!error, error)
  await until(`window.__word.editor.status().pagesFinal === true`, { timeout: 60000, label: 'pagination finished' })
  const png = images().find((image) => image.text === 'Centered paragraph.' && near(image.widthPt, 1.5))
  const jpeg = images().find((image) => image.text.includes('Apples') && near(image.widthPt, 6))
  assert(png && near(png.heightPt, 1.5) && png.src !== null, `reopened png ${JSON.stringify(png)}`)
  assert(jpeg && near(jpeg.heightPt, 6) && jpeg.src !== null, `reopened jpeg ${JSON.stringify(jpeg)}`)
  assert(await readBytes(png.media) === PNG_B64, 'png bytes changed')
  assert(await readBytes(jpeg.media) === JPEG_B64, 'jpeg bytes changed')

  scrollTo('Right aligned paragraph.')
  act(namedRef('Right aligned paragraph.'), 'click')
  focusSink()
  act(inputRef(), 'type', 'Q')
  const second = evaluate('window.__word.save()')
  assert(second && typeof second.base64 === 'string' && second.base64.length > 0, 'second save returned no bytes')
})

await check('console has no errors', async () => {
  const errors = consoleErrors()
  assert(errors.length === 0, errors.join('\n'))
})

mkdirSync(`${root}docs/design/evidence/images`, { recursive: true })
if (existsSync(shotFile)) copyFileSync(shotFile, `${root}docs/design/evidence/images/inserted.png`)

summary()
