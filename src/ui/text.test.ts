import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  commandTitle,
  fileHandleFromRequest,
  formatChord,
  formatTitle,
  isAbort,
  isDirty,
  statusText,
  styleOptions,
} from './text.ts'
import type { Translate } from './text.ts'

const translate: Translate = (key, values = {}) => {
  const templates: Record<string, string> = {
    'status.page': 'Page {page} of {pages}',
    'status.words': '{words} words',
    'status.zoom': '{zoom}%',
  }
  const text = templates[key] ?? key
  return text.replace(/\{(\w+)\}/g, (all, name: string) => {
    const value = values[name]
    return value === undefined ? all : String(value)
  })
}

test('isDirty compares the document object with the saved snapshot', () => {
  const saved = { body: [] }
  const edited = { body: [] }
  assert.equal(isDirty(saved, null), false, 'no open file')
  assert.equal(isDirty(saved, { saved }), false, 'the snapshot is the document')
  assert.equal(isDirty(edited, { saved }), true, 'a later document object is dirty')
})

test('formatTitle puts the dirty mark before the file name', () => {
  assert.equal(formatTitle('basic.docx', false, 'Word'), 'basic.docx - Word')
  assert.equal(formatTitle('basic.docx', true, 'Word'), '• basic.docx - Word')
  assert.equal(formatTitle('未命名.docx', false, 'Word'), '未命名.docx - Word')
})

test('statusText shows the page, the word count and the zoom percent', () => {
  const final = statusText({ page: 1, pages: 3, pagesFinal: true, words: 12 }, 1, translate)
  assert.equal(final, 'Page 1 of 3 · 12 words · 100%')
  const partial = statusText({ page: 2, pages: 4, pagesFinal: false, words: 0 }, 1.5, translate)
  assert.equal(partial, 'Page 2 of ≥4 · 0 words · 150%')
  const half = statusText({ page: 1, pages: 1, pagesFinal: true, words: 1 }, 0.5, translate)
  assert.equal(half, 'Page 1 of 1 · 1 words · 50%')
})

test('formatChord spells the platform modifier', () => {
  assert.equal(formatChord('mod+b', 'other'), 'Ctrl+B')
  assert.equal(formatChord('mod+b', 'mac'), '⌘B')
  assert.equal(formatChord('mod+shift+z', 'other'), 'Ctrl+Shift+Z')
  assert.equal(formatChord('mod+shift+z', 'mac'), '⌘⇧Z')
  assert.equal(formatChord('mod+y', 'mac'), '⌘Y')
})

test('commandTitle keeps the label when the keymap has no chord', () => {
  assert.equal(commandTitle('Bold', 'mod+b', 'other'), 'Bold (Ctrl+B)')
  assert.equal(commandTitle('加粗', 'mod+b', 'mac'), '加粗 (⌘B)')
  assert.equal(commandTitle('Strikethrough', null, 'other'), 'Strikethrough')
  assert.equal(commandTitle('Strikethrough', '', 'mac'), 'Strikethrough')
})

test('fileHandleFromRequest accepts only an open-file request for a file', () => {
  const file = { kind: 'file', name: 'basic.docx' }
  const directory = { kind: 'directory', name: 'docs' }
  assert.equal(fileHandleFromRequest({ kind: 'open-file', handle: file }), file)
  assert.equal(fileHandleFromRequest({ kind: 'open-file', handle: directory }), null)
  assert.equal(fileHandleFromRequest({ kind: 'open-file' }), null)
  assert.equal(fileHandleFromRequest({ kind: 'open-link', handle: file }), null)
})

test('isAbort recognizes a cancelled picker', () => {
  assert.equal(isAbort({ name: 'AbortError' }), true)
  assert.equal(isAbort({ name: 'NotFoundError' }), false)
  assert.equal(isAbort(null), false)
  assert.equal(isAbort('AbortError'), false)
})

test('styleOptions lists the five roles first and localizes only those', () => {
  const styles = new Map<string, { name: string; role: string | null }>([
    ['Quote', { name: 'Quote', role: null }],
    ['Heading2', { name: 'heading 2', role: 'heading2' }],
    ['Normal', { name: 'Normal', role: 'normal' }],
    ['Alpha', { name: 'Alpha', role: null }],
    ['Title', { name: 'Title', role: 'title' }],
    ['Caption', { name: 'caption', role: 'caption' }],
  ])
  const options = styleOptions(styles, role => `role:${role}`)
  assert.deepEqual(options.map(option => option.id), ['Normal', 'Title', 'Heading2', 'Caption', 'Alpha', 'Quote'])
  assert.deepEqual(options.map(option => option.label), [
    'role:normal',
    'role:title',
    'role:heading2',
    'caption',
    'Alpha',
    'Quote',
  ])
})
