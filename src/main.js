/// <reference types="@dopame/acde-api/app" />
import { window as appWindow } from 'acde:window'
import { t, translate } from './i18n.js'

translate()

const paper = document.querySelector('#paper')
const fileInput = document.querySelector('#file')
let current = null
let dirty = false

function setStatus(text) {
  document.querySelector('#status').textContent = text
}

function setDirty(value) {
  dirty = value
  document.querySelector('#dirty').hidden = !value
}

function paragraphText(paragraph) {
  return paragraph.value.replace(/\u00a0/g, ' ')
}

function fit(paragraph) {
  paragraph.style.height = 'auto'
  paragraph.style.height = `${paragraph.scrollHeight}px`
}

function wordCount() {
  const count = [...paper.querySelectorAll('textarea')]
    .map((paragraph) => paragraphText(paragraph).trim())
    .filter(Boolean)
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length
  document.querySelector('#words').textContent = t('words', { count })
}

function focusParagraph(paragraph, atEnd = true) {
  current = paragraph
  paragraph.focus()
  const pos = atEnd ? paragraph.value.length : 0
  paragraph.setSelectionRange(pos, pos)
  fit(paragraph)
  reflectRibbon()
}

function reflectRibbon() {
  const heading = current?.dataset.heading || '0'
  for (const button of document.querySelectorAll('[data-heading]')) {
    button.setAttribute('aria-pressed', String(button.dataset.heading === heading))
  }
  document.querySelector('#bold').setAttribute('aria-pressed', String(current?.dataset.bold === '1'))
  document.querySelector('#italic').setAttribute('aria-pressed', String(current?.dataset.italic === '1'))
}

function makeParagraph(item) {
  const paragraph = document.createElement('textarea')
  paragraph.rows = 1
  paragraph.dataset.origin = item && Number.isInteger(item.index) ? String(item.index) : ''
  paragraph.dataset.heading = String(item?.heading || 0)
  paragraph.dataset.bold = item?.bold ? '1' : '0'
  paragraph.dataset.italic = item?.italic ? '1' : '0'
  paragraph.value = item?.text || ''
  return paragraph
}

function render(model) {
  document.querySelector('#doc-name').textContent = model.name || 'Document.docx'
  appWindow.setTitle(`${model.name || 'Document'} — Word`)
  paper.replaceChildren(...(model.paragraphs?.length ? model.paragraphs : [{ text: '' }]).map(makeParagraph))
  for (const paragraph of paper.querySelectorAll('textarea')) fit(paragraph)
  wordCount()
  focusParagraph(paper.querySelector('textarea'))
}

function edits() {
  return [...paper.querySelectorAll('textarea')].map((paragraph) => ({
    index: paragraph.dataset.origin === '' ? null : Number(paragraph.dataset.origin),
    text: paragraphText(paragraph),
    heading: Number(paragraph.dataset.heading || 0),
    bold: paragraph.dataset.bold === '1',
    italic: paragraph.dataset.italic === '1',
  }))
}

async function readError(response) {
  try {
    const body = await response.json()
    return body.error || t('failed')
  } catch {
    return t('failed')
  }
}

async function createDocument() {
  setStatus(t('working'))
  const response = await fetch('/api/new', { method: 'POST' })
  if (!response.ok) {
    setStatus(await readError(response))
    return
  }
  render(await response.json())
  setDirty(false)
  setStatus(t('created'))
}

async function openBytes(bytes, name) {
  setStatus(t('working'))
  const response = await fetch('/api/open', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent(name),
    },
    body: bytes,
  })
  if (!response.ok) {
    setStatus(await readError(response))
    return
  }
  render(await response.json())
  setDirty(false)
  setStatus(t('opened', { name }))
}

async function saveDocument() {
  setStatus(t('working'))
  const response = await fetch('/api/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(edits()),
  })
  if (!response.ok) {
    setStatus(await readError(response))
    return false
  }
  const model = await response.json()
  const paragraphs = [...paper.querySelectorAll('textarea')]
  model.paragraphs?.forEach((item, index) => {
    if (paragraphs[index]) paragraphs[index].dataset.origin = String(item.index)
  })
  document.querySelector('#doc-name').textContent = model.name
  wordCount()
  setDirty(false)
  setStatus(t('saved'))
  return true
}

async function pickFile() {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [
          {
            description: 'DOCX',
            accept: {
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
            },
          },
        ],
      })
      const file = await handle.getFile()
      await openBytes(await file.arrayBuffer(), file.name)
      return
    } catch (error) {
      if (error?.name === 'AbortError') return
    }
  }
  fileInput.click()
}

async function exportPdf() {
  if (dirty && !(await saveDocument())) return
  setStatus(t('exporting'))
  const response = await fetch('/api/export?format=pdf')
  if (!response.ok) {
    setStatus(await readError(response))
    return
  }
  const blob = await response.blob()
  const name = `${document.querySelector('#doc-name').textContent.replace(/\.docx$/i, '')}.pdf`
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: name })
      const writable = await handle.createWritable()
      await writable.write(blob)
      await writable.close()
      setStatus(t('saved'))
      return
    } catch (error) {
      if (error?.name === 'AbortError') {
        setStatus(t('ready'))
        return
      }
    }
  }
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = name
  link.click()
  URL.revokeObjectURL(link.href)
  setStatus(t('saved'))
}

document.querySelector('#new').addEventListener('click', () => {
  createDocument()
})
document.querySelector('#open').addEventListener('click', () => {
  pickFile()
})
document.querySelector('#save').addEventListener('click', () => {
  saveDocument()
})
document.querySelector('#pdf').addEventListener('click', () => {
  exportPdf()
})
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0]
  if (!file) return
  await openBytes(await file.arrayBuffer(), file.name)
  fileInput.value = ''
})

for (const button of document.querySelectorAll('[data-heading]')) {
  button.addEventListener('click', () => {
    if (!current) return
    current.dataset.heading = button.dataset.heading
    reflectRibbon()
    setDirty(true)
    current.focus()
  })
}

document.querySelector('#bold').addEventListener('click', () => {
  if (!current) return
  current.dataset.bold = current.dataset.bold === '1' ? '0' : '1'
  reflectRibbon()
  setDirty(true)
  current.focus()
})

document.querySelector('#italic').addEventListener('click', () => {
  if (!current) return
  current.dataset.italic = current.dataset.italic === '1' ? '0' : '1'
  reflectRibbon()
  setDirty(true)
  current.focus()
})

paper.addEventListener('focusin', (event) => {
  const paragraph = event.target.closest?.('textarea')
  if (!paragraph) return
  current = paragraph
  reflectRibbon()
})

paper.addEventListener('input', (event) => {
  if (event.target.matches?.('textarea')) fit(event.target)
  setDirty(true)
  wordCount()
})

paper.addEventListener('keydown', (event) => {
  const paragraph = event.target.closest?.('textarea')
  if (!paragraph) return
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    const next = makeParagraph(null)
    paragraph.after(next)
    focusParagraph(next, false)
    setDirty(true)
  }
  if (event.key === 'Backspace' && paragraphText(paragraph) === '' && paper.querySelectorAll('textarea').length > 1) {
    event.preventDefault()
    const previous = paragraph.previousElementSibling
    paragraph.remove()
    if (previous) focusParagraph(previous)
    setDirty(true)
    wordCount()
  }
})

paper.addEventListener('mousedown', (event) => {
  if (event.target !== paper) return
  const last = paper.querySelector('textarea:last-child')
  if (last) focusParagraph(last)
})

appWindow.on('request', async (request) => {
  if (request.kind !== 'open-file') return
  const file = await request.handle.getFile()
  await openBytes(await file.arrayBuffer(), file.name)
})

try {
  const health = await (await fetch('/api/health')).json()
  if (!health.ok) setStatus(health.error || t('missing'))
  else await createDocument()
} catch {
  setStatus(t('missing'))
}
