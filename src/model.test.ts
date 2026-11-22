import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  INDEX_CACHE_LIMIT,
  checkDoc,
  comparePos,
  flatText,
  indexOf,
  inlineAt,
  marksAt,
  newParaId,
  normalizeInlines,
  type DocIndex,
} from './model.ts'
import {
  cell,
  hex,
  imageAtom,
  makeDoc,
  opaqueAtom,
  paraId,
  paragraph,
  pt,
  row,
  runSrc,
  storyKey,
  table,
  text,
} from './editor/testkit.ts'

test('flatText writes one U+FFFC per atom and caches the string', () => {
  const para = paragraph('p', [text('a😀'), imageAtom('k'), text('b')])
  const value = flatText(para)
  assert.equal(value, 'a😀\uFFFCb', 'atoms occupy one offset')
  assert.equal(value.length, 5, 'the emoji stays two UTF-16 units')
  assert.equal(flatText(para), value, 'flat text is cached on the paragraph')
})

test('normalizeInlines merges equal neighbors, drops empties, and keeps the array when nothing changes', () => {
  const kept = [text('ab', 1)]
  assert.equal(normalizeInlines(kept), kept, 'an already normal run list is the same array')
  const merged = normalizeInlines([text('a', 1, { bold: true }), text('b', 1, { bold: true })])
  const run = merged[0]
  assert.ok(run && run.kind === 'text')
  assert.equal(run.text, 'ab', 'equal src and marks merge')
  assert.equal(normalizeInlines([text('a', 1), text('b', 2)]).length, 2, 'different src stays split')
  assert.equal(normalizeInlines([text('a', 1, { bold: true }), text('b', 1)]).length, 2, 'different marks stay split')
  const atom = imageAtom('k')
  const around = normalizeInlines([text('a', 1), atom, text('b', 1)])
  assert.equal(around.length, 3, 'an atom blocks a merge')
  assert.equal(around[1], atom, 'the atom object is kept')
  assert.equal(normalizeInlines([text('', 1), text('a', 1)]).length, 1, 'empty runs are dropped')
})

test('inlineAt prefers the inline before a boundary', () => {
  const para = paragraph('p', [text('ab'), text('cd', null, { bold: true })])
  assert.deepEqual(inlineAt(para, 0), { index: 0, offset: 0 }, 'offset 0 is the first inline')
  assert.deepEqual(inlineAt(para, 2), { index: 0, offset: 2 }, 'the boundary belongs to the run before it')
  assert.deepEqual(inlineAt(para, 3), { index: 1, offset: 1 }, 'an offset inside the second run')
  assert.deepEqual(inlineAt(para, 99), { index: 1, offset: 2 }, 'past the end stays on the last inline')
  assert.deepEqual(inlineAt(paragraph('e', []), 0), { index: 0, offset: 0 }, 'an empty paragraph has no inline')
})

test('marksAt reads the run at the caret and drops src after an atom', () => {
  const para = paragraph('p', [
    text('ab', 1, { bold: true }),
    opaqueAtom('x', 'x', true, 2),
    text('cd', 3, { italic: true }),
  ])
  const start = marksAt(para, 0)
  assert.equal(start.src, runSrc(1), 'offset 0 extends the first run')
  assert.equal(start.marks.bold, true, 'offset 0 takes the first run marks')
  const after = marksAt(para, 3)
  assert.equal(after.src, null, 'the caret after an atom does not reuse an earlier run src')
  assert.equal(after.marks.bold, true, 'marks after an atom come from the nearest text before it')
  const beforeAtom = marksAt(para, 2)
  assert.equal(beforeAtom.src, runSrc(1), 'the boundary before an atom extends the run before it')
  const leading = marksAt(paragraph('q', [opaqueAtom('x', 'x', true, 1), text('cd', 2, { italic: true })]), 0)
  assert.equal(leading.src, null, 'a caret on a leading atom has no text src')
  assert.equal(leading.marks.italic, true, 'a caret on a leading atom takes the following text marks')
  const empty = marksAt(paragraph('e', []), 0)
  assert.deepEqual(empty.marks, {}, 'an empty paragraph has no marks')
  assert.equal(empty.src, null, 'an empty paragraph has no run src')
})

test('comparePos orders by paragraph then offset', () => {
  const a = paragraph('a', [text('ab')])
  const b = paragraph('b', [text('cd')])
  const index = indexOf(makeDoc([a, b]))
  assert.equal(comparePos(index, { p: a.id, o: 1 }, { p: a.id, o: 0 }), 1, 'a later offset is greater')
  assert.equal(comparePos(index, { p: a.id, o: 1 }, { p: b.id, o: 0 }), -1, 'an earlier paragraph is less')
  assert.equal(comparePos(index, { p: a.id, o: 1 }, { p: a.id, o: 1 }), 0, 'the same position compares equal')
})

test('indexOf is cached on the body array and rejects an unknown id', () => {
  const body = [paragraph('p', [text('hi')])]
  const first = indexOf(makeDoc(body))
  assert.equal(indexOf(makeDoc(body)), first, 'the same body array reuses the index')
  assert.notEqual(indexOf(makeDoc([paragraph('q', [text('yo')])])), first, 'a new body builds a new index')
  assert.throws(() => first.get(paraId('missing')), /unknown paragraph/, 'an unknown id throws')
})

test('newParaId mints distinct ids', () => {
  const first = newParaId()
  const second = newParaId()
  assert.notEqual(first, second, 'ids are never reused')
})

test('checkDoc accepts table and cell borders', () => {
  const line = { style: 'single' as const, widthPt: pt(0.5), color: hex('000000') }
  const borders = { top: line, left: line, bottom: line, right: line, insideH: line, insideV: line }
  const plain = table('t', [row([cell([paragraph('a', [text('a')])])])])
  const bordered = {
    ...plain,
    props: { borders },
    rows: plain.rows.map((entry, index) => index === 0
      ? { ...entry, cells: entry.cells.map((item, cellIndex) => cellIndex === 0 ? { ...item, borders: { right: null } } : item) }
      : entry),
  }
  checkDoc(makeDoc([bordered]))
  checkDoc(makeDoc([plain]))
})

test('checkDoc accepts a table, a locked paragraph, and a story with its own src cursor', () => {
  const atom = opaqueAtom('eq', '∫', false, 2)
  const doc = makeDoc([
    paragraph('a', [atom, text('hi', 3)], {}, { src: 1, lock: { reason: 'revisions' } }),
    table('t', [row([cell([paragraph('c', [text('cell', 5)], {}, { src: 4 })])])]),
  ], {
    stories: new Map([[storyKey('s0/header/default'), [paragraph('s', [text('head', 1)], {}, { src: 1 })]]]),
  })
  checkDoc(doc)
  checkDoc(doc, doc)
  const shared = makeDoc([paragraph('q', [atom], {}, { src: 9 })])
  checkDoc(shared, makeDoc([paragraph('a', [atom], {}, { src: 1 })]))
})

test('checkDoc reports broken text, source order, merge, cell, and baseline invariants', () => {
  assert.throws(() => checkDoc(makeDoc([paragraph('p', [text('', 1)])])), /invariant 2: empty text run/)
  assert.throws(() => checkDoc(makeDoc([paragraph('p', [text('a\uFFFCb', 1)])])), /invariant 2: text run contains U\+FFFC/)
  assert.throws(() => checkDoc(makeDoc([
    paragraph('a', [text('a', 1)], {}, { src: 3 }),
    paragraph('b', [text('b', 2)], {}, { src: 2 }),
  ])), /invariant 3: paragraph src order/)
  assert.throws(() => checkDoc(makeDoc([
    paragraph('a', [text('a', 2), text('b', 1, { bold: true })], {}, { src: 3 }),
  ])), /invariant 3: run src order/)
  assert.throws(() => checkDoc(makeDoc([paragraph('a', [text('a', 1), text('b', 1)])])), /invariant 4: adjacent text runs must be merged/)
  assert.throws(() => checkDoc(makeDoc([table('t', [row([cell([])])])])), /invariant 6: empty cell/)
  assert.throws(() => checkDoc(makeDoc([
    table('t', [row([cell([table('inner', [row([cell([paragraph('p', [text('a')])])])])])])]),
  ])), /invariant 6: cell does not end with a paragraph/)
  assert.throws(() => checkDoc(makeDoc([
    paragraph('p', [text('a')]),
    paragraph('p', [text('b')]),
  ])), /duplicate paragraph id/)

  const locked = paragraph('p', [text('a', 1)], {}, { src: 2, lock: { reason: 'unbalancedField' } })
  assert.throws(() => checkDoc(makeDoc([{ ...locked }]), makeDoc([locked])), /invariant 5: locked paragraph changed/)
  const fixed = opaqueAtom('eq', '∫', false, 1)
  const base = makeDoc([paragraph('p', [fixed], {}, { src: 2 })])
  assert.throws(() => checkDoc(makeDoc([paragraph('p', [{ ...fixed }], {}, { src: 2 })]), base), /invariant 5: non-removable atom changed/)
  const removable = opaqueAtom('eq', '∫', true, 1)
  checkDoc(
    makeDoc([paragraph('p', [opaqueAtom('eq', '∫', true, 1)], {}, { src: 2 })]),
    makeDoc([paragraph('p', [removable], {}, { src: 2 })]),
  )
})

function indexShape(index: DocIndex): unknown[] {
  return index.ordered.map((id) => {
    const loc = index.get(id)
    return { story: loc.story, path: loc.path, order: loc.order, para: loc.para }
  })
}

test('indexOf keeps the most recent bodies and rebuilds one that fell out', () => {
  const doc = makeDoc([paragraph('a', [text('one')]), paragraph('b', [text('two')])])
  const first = indexOf(doc)
  assert.equal(indexOf(doc), first, 'the same document reuses the index')
  for (let i = 0; i < INDEX_CACHE_LIMIT + 1; i++) {
    indexOf(makeDoc([paragraph(`q${i}`, [text('x')])]))
  }
  const again = indexOf(doc)
  assert.notEqual(again, first, 'a body past the cache bound is indexed again')
  assert.deepEqual(indexShape(again), indexShape(first), 'the rebuilt index matches')

  const leftDoc = makeDoc([paragraph('l', [text('left')])])
  const rightDoc = makeDoc([paragraph('r', [text('right')])])
  const left = indexOf(leftDoc)
  const right = indexOf(rightDoc)
  for (let i = 0; i < 8; i++) {
    const turn = i % 2 === 0 ? leftDoc : rightDoc
    assert.equal(indexOf(turn), i % 2 === 0 ? left : right, `turn ${i} reuses the index`)
  }
})
