import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkDoc, flatText } from '../model.ts'
import {
  cell,
  makeDoc,
  opaqueBlock,
  paragraph,
  row,
  storyKey,
  table,
  text,
} from '../editor/testkit.ts'
import { resolveAddress, resolvePlace } from './address.ts'

function doc() {
  const built = makeDoc([
    paragraph('p', [text('Hello')]),
    table('t', [row([cell([paragraph('c', [text('cell')])])])]),
    opaqueBlock('box', [paragraph('prev', [text('Shown')], {}, { lock: { reason: 'preview' } })], true),
  ], {
    stories: new Map([
      [storyKey('s0/header/default'), [paragraph('head', [text('Running')])]],
      [storyKey('s0/footer/default'), [paragraph('foot', [text('Footer')])]],
    ]),
  })
  checkDoc(built)
  return built
}

test('address resolution returns each refusal and accepts end, length, and cells', () => {
  const built = doc()
  const length = flatText(built.body[0] && built.body[0].kind === 'p' ? built.body[0] : paragraph('p', [text('Hello')])).length
  assert.equal(length, 5)

  const missing = resolveAddress(built, { para: 'missing', offset: 0 })
  assert.equal(missing.ok, false)
  if (!missing.ok) {
    assert.equal(missing.error.code, 'unknown-address')
    assert.equal(missing.error.para, 'missing')
    assert.match(missing.error.message, /unknown paragraph missing/)
  }

  const negative = resolveAddress(built, { para: 'p', offset: -1 })
  assert.equal(negative.ok, false)
  if (!negative.ok) {
    assert.equal(negative.error.code, 'out-of-range')
    assert.equal(negative.error.para, 'p')
    assert.match(negative.error.message, /outside 0\.\.5/)
  }

  const past = resolveAddress(built, { para: 'p', offset: 6 })
  assert.equal(past.ok, false)
  if (!past.ok) assert.equal(past.error.code, 'out-of-range')

  const fraction = resolveAddress(built, { para: 'p', offset: 1.5 })
  assert.equal(fraction.ok, false)
  if (!fraction.ok) assert.equal(fraction.error.code, 'bad-request')

  const header = resolveAddress(built, { para: 'head', offset: 0 })
  assert.equal(header.ok, false)
  if (!header.ok) {
    assert.equal(header.error.code, 'read-only-story')
    assert.equal(header.error.para, 'head')
  }

  const footer = resolveAddress(built, { para: 'foot', offset: 0 })
  assert.equal(footer.ok, false)
  if (!footer.ok) {
    assert.equal(footer.error.code, 'read-only-story')
    assert.equal(footer.error.para, 'foot')
  }

  const preview = resolveAddress(built, { para: 'prev', offset: 0 })
  assert.equal(preview.ok, false)
  if (!preview.ok) {
    assert.equal(preview.error.code, 'read-only-story')
    assert.equal(preview.error.para, 'prev')
  }

  const end = resolveAddress(built, { para: 'p', offset: 'end' })
  assert.equal(end.ok, true)
  if (end.ok) assert.deepEqual(end.pos, { p: end.pos.p, o: 5 })

  const atLength = resolveAddress(built, { para: 'p', offset: 5 })
  assert.equal(atLength.ok, true)
  if (atLength.ok) assert.equal(atLength.pos.o, 5)

  const cell = resolveAddress(built, { para: 'c', offset: 1 })
  assert.equal(cell.ok, true)
  if (cell.ok) assert.equal(cell.pos.o, 1)

  const tableId = resolveAddress(built, { para: 't', offset: 0 })
  assert.equal(tableId.ok, false)
  if (!tableId.ok) {
    assert.equal(tableId.error.code, 'unknown-address')
    assert.equal(tableId.error.para, 't')
  }

  const range = resolvePlace(built, {
    anchor: { para: 'p', offset: 1 },
    head: { para: 'missing', offset: 0 },
  })
  assert.equal(range.ok, false)
  if (!range.ok) assert.equal(range.error.code, 'unknown-address')

  const caret = resolvePlace(built, { para: 'c', offset: 'end' })
  assert.equal(caret.ok, true)
  if (caret.ok) {
    assert.equal(caret.selection.kind, 'text')
    if (caret.selection.kind === 'text') assert.equal(caret.selection.head.o, 4)
  }
})
