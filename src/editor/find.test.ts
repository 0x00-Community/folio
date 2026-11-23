import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkDoc, indexOf } from '../model.ts'
import type { ParaId, Pos } from '../model.ts'
import { findMatches, followingMatch, matchFrom, matchUntil } from './find.ts'
import type { TextMatch } from './find.ts'
import {
  cell,
  imageAtom,
  makeDoc,
  opaqueBlock,
  paragraph,
  row,
  storyKey,
  table,
  text,
} from './testkit.ts'

const INSENSITIVE = { matchCase: false, wholeWord: false }
const SENSITIVE = { matchCase: true, wholeWord: false }
const WHOLE = { matchCase: false, wholeWord: true }

function pos(id: ParaId, o: number): Pos {
  return { p: id, o }
}

function at(matches: readonly TextMatch[], index: number): TextMatch {
  const match = matches[index]
  assert.ok(match, `match ${index}`)
  return match
}

test('find matches case, whole words, atoms, paragraph ends, and table cells', () => {
  const doc = makeDoc([
    paragraph('a', [text('Part one')]),
    paragraph('b', [text('a'), imageAtom('pic'), text('b')]),
    paragraph('c', [text('aaa')]),
    table('t', [row([cell([paragraph('cell', [text('inside')])])])]),
    paragraph('d', [text('end')]),
    opaqueBlock('box', [paragraph('prev', [text('Shown preview')])], false),
  ], {
    stories: new Map([
      [storyKey('s0/header/default'), [paragraph('head', [text('Running head')])]],
      [storyKey('s0/footer/default'), [paragraph('foot', [text('Footer line')])]],
    ]),
  })
  checkDoc(doc)
  assert.deepEqual(findMatches(doc, 'part', INSENSITIVE).map(hit => hit.para), ['a'])
  assert.deepEqual(findMatches(doc, 'part', SENSITIVE), [])
  assert.deepEqual(findMatches(doc, 'ab', INSENSITIVE), [], 'a match cannot cross an atom')
  assert.deepEqual(findMatches(doc, 'b', INSENSITIVE).map(hit => [hit.para, hit.start, hit.end]), [['b', 2, 3]])
  assert.deepEqual(findMatches(doc, 'aa', INSENSITIVE), [{ para: 'c' as ParaId, start: 0, end: 2 }])
  assert.deepEqual(findMatches(doc, 'oneend', INSENSITIVE), [], 'a match cannot cross a paragraph end')
  assert.deepEqual(findMatches(doc, 'inside', INSENSITIVE).map(hit => hit.para), ['cell'])
  assert.deepEqual(findMatches(doc, 'Running', INSENSITIVE), [])
  assert.deepEqual(findMatches(doc, 'Footer', INSENSITIVE), [])
  assert.deepEqual(findMatches(doc, 'Shown', INSENSITIVE), [])
  assert.deepEqual(findMatches(doc, '', INSENSITIVE), [])
  assert.deepEqual(findMatches(doc, 'hell', WHOLE), [])
  assert.equal(findMatches(doc, 'one', WHOLE).length, 1)
  const han = makeDoc([paragraph('h', [text('你好世界')])])
  assert.deepEqual(findMatches(han, '你好', WHOLE).map(hit => [hit.start, hit.end]), [[0, 2]])
  assert.deepEqual(findMatches(han, '你', WHOLE), [])
  assert.equal(findMatches(han, '你', INSENSITIVE).length, 1)
})

test('case folding keeps original UTF-16 offsets, including surrogates and length-changing folds', () => {
  const dotted = makeDoc([paragraph('p', [text('aİb')])])
  assert.deepEqual(
    findMatches(dotted, 'b', INSENSITIVE).map(hit => [hit.start, hit.end]),
    [[2, 3]],
    'İ lowercases to two units, and b stays at offset 2',
  )
  const emoji = makeDoc([paragraph('p', [text('a😀b')])])
  assert.equal('a😀b'.length, 4)
  assert.deepEqual(findMatches(emoji, 'b', INSENSITIVE).map(hit => [hit.start, hit.end]), [[3, 4]])
  const sharp = makeDoc([paragraph('p', [text('aßb')])])
  assert.deepEqual(findMatches(sharp, 'ss', INSENSITIVE), [])
  assert.deepEqual(findMatches(sharp, 'ß', INSENSITIVE).map(hit => [hit.start, hit.end]), [[1, 2]])
  assert.deepEqual(findMatches(sharp, 'B', INSENSITIVE).map(hit => hit.start), [2])
})

test('next and previous wrap', () => {
  const doc = makeDoc([
    paragraph('a', [text('one two')]),
    paragraph('b', [text('two')]),
    paragraph('c', [text('two')]),
  ])
  const matches = findMatches(doc, 'two', INSENSITIVE)
  assert.equal(matches.length, 3)
  const a = indexOf(doc).get('a' as ParaId)
  assert.equal(matchFrom(doc, matches, pos(a.para.id, 0)), 0)
  assert.equal(matchFrom(doc, matches, pos(a.para.id, at(matches, 0).end)), 1)
  assert.equal(matchFrom(doc, matches, pos('c' as ParaId, at(matches, 2).end)), -1)
  assert.equal(matchUntil(doc, matches, pos(a.para.id, at(matches, 0).start)), -1)
  assert.equal(matchUntil(doc, matches, pos('b' as ParaId, at(matches, 1).start)), 0)
  const wrappedNext = matchFrom(doc, matches, pos('c' as ParaId, at(matches, 2).end))
  assert.equal(wrappedNext < 0 ? 0 : wrappedNext, 0)
  const wrappedPrev = matchUntil(doc, matches, pos(a.para.id, at(matches, 0).start))
  assert.equal(wrappedPrev < 0 ? matches.length - 1 : wrappedPrev, 2)
  const shifted = followingMatch(matches, 0, 'two-two')
  assert.ok(shifted)
  assert.equal(shifted.para, matches[1]?.para)
  assert.equal(followingMatch(matches, 2, 'x')?.para, matches[0]?.para)
  assert.equal(followingMatch([at(matches, 0)], 0, 'x'), null)
})

test('a 3000 paragraph search stays under 8 ms', () => {
  const blocks = []
  for (let i = 0; i < 3000; i++) {
    const value = i % 7 === 0 ? 'alpha beta alpha' : 'gamma delta epsilon'
    blocks.push(paragraph(`p${i}`, [text(value)]))
  }
  const doc = makeDoc(blocks)
  checkDoc(doc)
  findMatches(doc, 'alpha', INSENSITIVE)
  const started = performance.now()
  const found = findMatches(doc, 'alpha', INSENSITIVE)
  const elapsed = performance.now() - started
  const expected = Math.ceil(3000 / 7) * 2
  assert.equal(found.length, expected)
  assert.ok(elapsed < 8, `search took ${elapsed.toFixed(2)} ms`)
  const wordStarted = performance.now()
  const words = findMatches(doc, 'alpha', WHOLE)
  const wordElapsed = performance.now() - wordStarted
  assert.equal(words.length, expected)
  assert.ok(wordElapsed < 8, `whole-word search took ${wordElapsed.toFixed(2)} ms`)
  console.log(`find 3000 paragraphs: ${elapsed.toFixed(2)} ms, whole word ${wordElapsed.toFixed(2)} ms`)
})
