import { deflateSync } from 'node:zlib'
// Unit 5: insert a PNG and a JPEG, reject a file that is not one, and save twice.
// Edits go through acde act. Save and reopen go through window.__word.
// Run by the reviewer. This dispatch does not run the script.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, assert, buttonNamed, check, consoleErrors, ensureDev, evaluate, evidencePath, freshPage, namedRef, ref, root, shot, summary, until } from './acde.mjs'

const STRINGS = {
  en: {
    insert: 'Insert picture',
    error: 'This file is not a PNG or JPEG image.',
    input: 'Document text',
    undo: 'Undo',
    se: 'Resize: bottom right',
    east: 'Resize: right',
    kept: 'A picture from the file cannot be moved.',
  },
  zh: {
    insert: '插入图片',
    error: '这个文件不是 PNG 或 JPEG 图片。',
    input: '文档正文',
    undo: '撤销',
    se: '调整大小：右下',
    east: '调整大小：右',
    kept: '文件里的图片不能移动。',
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
const shotFile = evidencePath('images/inserted.png')

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
await freshPage(`!!(window.__word && window.__word.save)`, { label: 'shell' })

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

function markImage(label) {
  const found = evaluate(`(() => {
    document.querySelectorAll('[data-e2e="target"]').forEach((node) => { delete node.dataset.e2e })
    const want = ${JSON.stringify(label)}
    const plain = (node) => (node.getAttribute('aria-label') || '').replaceAll('\\uFFFC', '')
    const para = [...document.querySelectorAll('.blk.p')].find((node) => plain(node) === want && node.getAttribute('aria-hidden') !== 'true' && node.querySelector('img.atom'))
    const img = para && [...para.querySelectorAll('img.atom')].at(-1)
    if (!img) return false
    img.dataset.e2e = 'target'
    img.scrollIntoView({ block: 'center' })
    return true
  })()`)
  assert(found === true, `no picture in ${label}`)
  return ref('img.atom[data-e2e="target"]')
}

function pictureBox(label) {
  return evaluate(`(() => {
    const want = ${JSON.stringify(label)}
    const plain = (node) => (node.getAttribute('aria-label') || '').replaceAll('\\uFFFC', '')
    const para = [...document.querySelectorAll('.blk.p')].find((node) => plain(node) === want && node.getAttribute('aria-hidden') !== 'true' && node.querySelector('img.atom'))
    const img = para && [...para.querySelectorAll('img.atom')].at(-1)
    if (!img) return null
    const rect = img.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  })()`)
}

function historyPast() {
  return evaluate('window.__word.editor.state.history.past.length')
}

// `acde act` has click and drag-to-a-ref. A sized stroke is `acde input`: move, down, move, up.
function pointer(events) {
  execFileSync('acde', ['input', 'folio', JSON.stringify(events)], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function centerOf(selector) {
  const point = evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)})
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  assert(point, `no ${selector}`)
  return point
}

function stroke(selector, dx, dy, { release = true } = {}) {
  const from = centerOf(selector)
  const events = [
    { type: 'move', x: from.x, y: from.y },
    { type: 'down', x: from.x, y: from.y, button: 'left' },
    { type: 'move', x: from.x + dx, y: from.y + dy },
  ]
  if (release) events.push({ type: 'up', x: from.x + dx, y: from.y + dy, button: 'left' })
  pointer(events)
  return { x: from.x + dx, y: from.y + dy }
}

function setZoom(percent) {
  act(ref('#status select.zoom'), 'select', String(percent))
}

// An 80 by 80 px gray PNG (60 pt). The 2 px picture is smaller than one handle, so the pointer checks use this one.
function grayPng(size) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (bytes) => {
    let c = 0xffffffff
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc(body), body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 0, 0, 0, 0], 8)
  const rows = Buffer.alloc((size + 1) * size, 0x99)
  for (let y = 0; y < size; y++) rows[y * (size + 1)] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const bigPath = join(dir, 'big.png')
writeFileSync(bigPath, grayPng(80))

await check('a click selects a picture and the handles track zoom', async () => {
  await openBasic()
  scrollTo('Centered paragraph.')
  act(namedRef('Centered paragraph.'), 'click')
  focusSink()
  chooseOpen(bigPath)
  act(buttonNamed(ui.insert), 'click')
  await until(`(() => [...document.querySelectorAll('img.atom')].some((img) => img.naturalWidth === 80))()`, { label: 'png for handles' })
  const image = markImage('Centered paragraph.')
  act(image, 'click')
  const handles = evaluate(`document.querySelectorAll('.image-handle').length`)
  assert(handles === 8, `handles ${handles}`)
  namedRef(ui.se)
  namedRef(ui.east)
  for (const percent of [50, 100, 200]) {
    setZoom(percent)
    const hit = evaluate(`(() => {
      const handle = document.querySelector('.image-handle[data-handle="se"]')
      if (!handle) return null
      const rect = handle.getBoundingClientRect()
      return { width: rect.width, height: rect.height }
    })()`)
    assert(hit && Math.abs(hit.width - 14) <= 1.5 && Math.abs(hit.height - 14) <= 1.5, `zoom ${percent} hit ${JSON.stringify(hit)}`)
  }
  setZoom(100)
  act(namedRef('Right aligned paragraph.'), 'click')
  const gone = evaluate(`document.querySelectorAll('.image-handle').length`)
  assert(gone === 0, `handles stayed ${gone}`)
})

await check('dragging a handle resizes, escape cancels, and undo restores', async () => {
  const image = markImage('Centered paragraph.')
  act(image, 'click')
  const before = historyPast()
  stroke('.image-handle[data-handle="se"]', 20, 20)
  const box = pictureBox('Centered paragraph.')
  assert(box && Math.abs(box.width - 100) <= 1 && Math.abs(box.height - 100) <= 1, `corner box ${JSON.stringify(box)}`)
  const sized = images().find((item) => item.text === 'Centered paragraph.' && item.src === null)
  assert(sized && Math.abs(sized.widthPt - 75) <= 0.75 && Math.abs(sized.heightPt - 75) <= 0.75, `corner model ${JSON.stringify(sized)}`)
  assert(Math.abs(sized.widthPt - sized.heightPt) <= 0.05, 'the corner keeps the ratio')
  assert(historyPast() === before + 1, `undo entries ${historyPast()} vs ${before}`)
  act(namedRef(ui.undo), 'click')
  const restored = images().find((item) => item.text === 'Centered paragraph.' && item.src === null)
  assert(restored && near(restored.widthPt, 60) && near(restored.heightPt, 60), `undo ${JSON.stringify(restored)}`)

  act(markImage('Centered paragraph.'), 'click')
  stroke('.image-handle[data-handle="e"]', 16, 4)
  const side = images().find((item) => item.text === 'Centered paragraph.' && item.src === null)
  assert(side && Math.abs(side.widthPt - 72) <= 0.75 && near(side.heightPt, 60), `side ${JSON.stringify(side)}`)
  act(namedRef(ui.undo), 'click')

  const held = historyPast()
  act(markImage('Centered paragraph.'), 'click')
  const heldAt = stroke('.image-handle[data-handle="e"]', 12, 0, { release: false })
  pointer([{ type: 'keydown', key: 'Escape' }, { type: 'keyup', key: 'Escape' }, { type: 'up', x: heldAt.x, y: heldAt.y, button: 'left' }])
  const escaped = images().find((item) => item.text === 'Centered paragraph.' && item.src === null)
  assert(escaped && near(escaped.widthPt, 60) && near(escaped.heightPt, 60), `escape ${JSON.stringify(escaped)}`)
  assert(historyPast() === held, 'escape added an undo entry')
})

await check('dragging a picture moves it, and undo puts it back', async () => {
  const image = markImage('Centered paragraph.')
  act(image, 'click')
  // Resize first, so the move carries a size that is not the natural one.
  stroke('.image-handle[data-handle="se"]', 20, 20)
  markImage('Centered paragraph.')
  const delta = evaluate(`(() => {
    const img = document.querySelector('img.atom[data-e2e="target"]')
    const para = [...document.querySelectorAll('.blk.p')].find((node) => node.getAttribute('aria-label') === 'Right aligned paragraph.' && node.getAttribute('aria-hidden') !== 'true')
    if (!img || !para) return null
    const a = img.getBoundingClientRect()
    const b = para.getBoundingClientRect()
    return {
      dx: Math.round(b.right - 8 - (a.left + a.width / 2)),
      dy: Math.round(b.top + Math.min(12, b.height / 2) - (a.top + a.height / 2)),
    }
  })()`)
  assert(delta && (Math.abs(delta.dx) > 4 || Math.abs(delta.dy) > 4), `delta ${JSON.stringify(delta)}`)
  stroke('img.atom[data-e2e="target"]', delta.dx, delta.dy)
  const moved = images().find((item) => item.text === 'Right aligned paragraph.' && item.src === null)
  assert(moved && Math.abs(moved.widthPt - 75) <= 0.75, `moved ${JSON.stringify(images())}`)
  assert(!images().some((item) => item.text === 'Centered paragraph.' && item.src === null), 'the picture also stayed behind')
  act(namedRef(ui.undo), 'click')
  const back = images().find((item) => item.text === 'Centered paragraph.' && item.src === null)
  assert(back && Math.abs(back.widthPt - 75) <= 0.75, `undo move ${JSON.stringify(images())}`)
  act(namedRef(ui.undo), 'click')
  const original = images().find((item) => item.text === 'Centered paragraph.' && item.src === null)
  assert(original && near(original.widthPt, 60), `size undo ${JSON.stringify(original)}`)
})

await check('an inserted picture keeps a resize and a move across save', async () => {
  const image = markImage('Centered paragraph.')
  act(image, 'click')
  stroke('.image-handle[data-handle="se"]', 20, 20)
  markImage('Centered paragraph.')
  const delta = evaluate(`(() => {
    const img = document.querySelector('img.atom[data-e2e="target"]')
    const para = [...document.querySelectorAll('.blk.p')].find((node) => node.getAttribute('aria-label') === 'Right aligned paragraph.' && node.getAttribute('aria-hidden') !== 'true')
    if (!img || !para) return null
    const a = img.getBoundingClientRect()
    const b = para.getBoundingClientRect()
    return {
      dx: Math.round(b.right - 8 - (a.left + a.width / 2)),
      dy: Math.round(b.top + Math.min(12, b.height / 2) - (a.top + a.height / 2)),
    }
  })()`)
  stroke('img.atom[data-e2e="target"]', delta.dx, delta.dy)
  const saved = evaluate('window.__word.save()')
  assert(saved && typeof saved.base64 === 'string' && saved.base64.length > 0, 'save returned no bytes')
  await openDocument(saved.base64, 'moved-image.docx')
  assert(!evaluate(`window.__wordError || ''`), evaluate(`window.__wordError || ''`))
  await until(`window.__word.editor.status().pagesFinal === true`, { timeout: 60000, label: 'pagination finished' })
  const found = images().find((item) => item.text === 'Right aligned paragraph.')
  assert(found && Math.abs(found.widthPt - 75) <= 0.75 && Math.abs(found.heightPt - 75) <= 0.75 && found.src !== null, `reopened ${JSON.stringify(found)}`)
})

await check('the picture in basic.docx resizes across save and cannot be moved', async () => {
  await openBasic()
  const marked = evaluate(`(() => {
    const img = document.querySelector('img.atom')
    if (!img) return false
    img.dataset.e2e = 'target'
    img.scrollIntoView({ block: 'center' })
    return true
  })()`)
  assert(marked === true, 'basic.docx has no picture')
  const image = ref('img.atom[data-e2e="target"]')
  act(image, 'click')
  stroke('.image-handle[data-handle="se"]', 20, 20)
  const sized = images().find((item) => near(item.widthPt, 162) || Math.abs(item.widthPt - 162) <= 0.75)
  assert(sized && Math.abs(sized.widthPt - 162) <= 0.75 && Math.abs(sized.heightPt - 81) <= 0.75, `file resize ${JSON.stringify(images())}`)
  const saved = evaluate('window.__word.save()')
  assert(saved && typeof saved.base64 === 'string', 'save returned no bytes')
  await openDocument(saved.base64, 'resized-basic.docx')
  await until(`window.__word.editor.status().pagesFinal === true`, { timeout: 60000, label: 'pagination finished' })
  const reopened = images().find((item) => Math.abs(item.widthPt - 162) <= 0.75)
  assert(reopened && Math.abs(reopened.heightPt - 81) <= 0.75, `reopened file picture ${JSON.stringify(images())}`)
  const again = evaluate(`(() => {
    const img = document.querySelector('img.atom')
    if (!img) return false
    img.dataset.e2e = 'target'
    img.scrollIntoView({ block: 'center' })
    return true
  })()`)
  assert(again === true, 'the reopened picture is not painted')
  const heldAt = stroke('img.atom[data-e2e="target"]', 40, 40, { release: false })
  const status = await until(
    `(document.querySelector('.status-text')?.textContent || '').includes(${JSON.stringify(ui.kept)})`,
    { label: 'file picture cannot move' },
  )
  assert(status, 'the status line did not say the picture stays')
  pointer([{ type: 'up', x: heldAt.x, y: heldAt.y, button: 'left' }])
  const stayed = images()
  assert(stayed.length === 1 && Math.abs(stayed[0].widthPt - 162) <= 0.75, `move changed the file picture ${JSON.stringify(stayed)}`)
})

await check('console has no errors', async () => {
  const errors = consoleErrors()
  assert(errors.length === 0, errors.join('\n'))
})

await summary()
