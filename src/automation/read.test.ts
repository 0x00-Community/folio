import assert from 'node:assert/strict'
import { test } from 'node:test'
import { wordCount } from '../editor/edit.ts'
import { listMarkers } from '../editor/derive.ts'
import { checkDoc, indexOf } from '../model.ts'
import type { Atom, Block, ListLevel, Marks, StyleSheet } from '../model.ts'
import {
  cell,
  HEADING,
  imageAtom,
  makeDoc,
  NORMAL,
  numId,
  opaqueBlock,
  page,
  paragraph,
  paraLook,
  pt,
  row,
  section,
  storyKey,
  styleId,
  table,
  text,
} from '../editor/testkit.ts'
import { documentSummary, readBlocks, readFind, readOutline, readText, readTextByIds } from './read.ts'
import type { ParagraphText, TextBlock } from './types.ts'

function link(value: string): NonNullable<Marks['link']> {
  return value as NonNullable<Marks['link']>
}

function columnBreak(): Atom {
  return { kind: 'atom', src: null, atom: { type: 'columnBreak' } }
}

function lvl(format: ListLevel['format'], template: string): ListLevel {
  return { format, text: template, start: 1, indentLeft: pt(36), hanging: pt(18) }
}

function styles(): StyleSheet {
  const paragraph = new Map<StyleIdMap, StyleEntry>()
  paragraph.set(NORMAL, { name: 'Normal', role: 'normal', next: null, look: paraLook() })
  paragraph.set(styleId('h1'), { name: 'heading 1', role: 'heading1', next: NORMAL, look: paraLook() })
  paragraph.set(styleId('h2'), { name: 'Heading 2', role: 'heading2', next: NORMAL, look: paraLook() })
  paragraph.set(styleId('h4'), { name: 'HEADING 4', role: null, next: null, look: paraLook() })
  paragraph.set(styleId('custom'), { name: 'Custom', role: 'heading3', next: null, look: paraLook() })
  return { paragraph, character: new Map(), defaultParagraph: NORMAL, added: [] }
}

type StyleIdMap = StyleSheet['paragraph'] extends ReadonlyMap<infer K, unknown> ? K : never
type StyleEntry = StyleSheet['paragraph'] extends ReadonlyMap<unknown, infer V> ? V : never

function merged(blocks: readonly Block[], vMerge: 'restart' | 'continue'): ReturnType<typeof cell> {
  return { src: null, span: 1, vMerge, blocks }
}

function fixture() {
  const num = { num: numId(1) }
  const bullet = { num: numId(2) }
  const doc = makeDoc([
    paragraph('chapter', [text('Chapter')], { style: styleId('h1'), align: 'center', numbering: { ...num, level: 0 } }),
    paragraph('part', [text('Part')], { style: styleId('h2'), numbering: { ...num, level: 1 } }),
    paragraph('bullet', [text('Item')], { numbering: { ...bullet, level: 0 } }),
    paragraph('deep', [text('Deep')], { style: styleId('h4') }),
    paragraph('marks', [
      text('See ', null, { bold: true, underline: false }),
      imageAtom('secret-media'),
      text('pic', null, { italic: true, link: link('secret-link') }),
      fieldAtom('3'),
      pageBreakAtom(),
      columnBreak(),
      opaqueAtom('secret-atom', '§', true),
    ]),
    paragraph('secret', [text('Locked text')], {}, { lock: { reason: 'revisions' } }),
    table('grid', [
      row([
        merged([paragraph('A', [text('Alpha')])], 'restart'),
        cell([paragraph('B', [text('Beta')])]),
      ]),
      row([
        merged([paragraph('v', [text('Merge')])], 'continue'),
        cell([
          table('inner', [row([cell([paragraph('nest', [text('in')])])])]),
          paragraph('C', [text('Cell')]),
        ]),
      ]),
    ], [36, 36]),
    opaqueBlock('box', [paragraph('prev', [text('Shown')], {}, { lock: { reason: 'preview' } })], false),
    paragraph('later', [text('Later')], { style: styleId('h2'), numbering: { ...num, level: 1 } }),
    paragraph('end', [text('End')], { style: styleId('h1'), numbering: { ...num, level: 0 } }),
    paragraph('noted', [text('Note')], { style: styleId('custom') }),
    paragraph('tail', [text('Tail')]),
  ], {
    sections: [section(page())],
    styles: styles(),
    lists: {
      byNum: new Map([
        [numId(1), { fresh: false, levels: [lvl('decimal', '%1.'), lvl('decimal', '%1.%2')] }],
        [numId(2), { fresh: false, levels: [lvl('bullet', '•')] }],
      ]),
    },
    stories: new Map([
      [storyKey('s0/header/default'), [paragraph('run', [text('Running head')])]],
      [storyKey('s0/footer/default'), [paragraph('foot', [text('Footer line')])]],
    ]),
  })
  checkDoc(doc)
  return doc
}

function fieldAtom(display: string): Atom {
  return { kind: 'atom', src: null, atom: { type: 'field', field: 'page', display } }
}

function pageBreakAtom(): Atom {
  return { kind: 'atom', src: null, atom: { type: 'pageBreak' } }
}

function opaqueAtom(label: string, display: string, removable: boolean): Atom {
  return { kind: 'atom', src: null, atom: { type: 'opaque', label, display, removable } }
}

function plain(id: string, value: string, extra: Partial<ParagraphText> = {}): ParagraphText {
  return {
    kind: 'paragraph',
    id,
    text: value,
    runs: [{ start: 0, end: value.length, marks: {} }],
    style: 'normal',
    align: 'left',
    list: null,
    locked: null,
    ...extra,
  }
}

function paraBlock(
  index: number,
  id: string,
  length: number,
  style: string,
  heading: number | null,
  locked: string | null,
) {
  return { index, id, kind: 'paragraph' as const, section: 0, page: 1, length, style, heading, locked }
}

const pageOf = (id: string): number | null => id === 'box' ? null : 0

function assertNoSrc(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoSrc(item)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assert.notEqual(key, 'src')
      assertNoSrc(item)
    }
  }
}

function assertRuns(block: TextBlock): void {
  if (block.kind === 'paragraph') {
    let cursor = 0
    for (const run of block.runs) {
      assert.equal(run.start, cursor)
      assert.ok(run.end >= run.start)
      cursor = run.end
    }
    assert.equal(cursor, block.text.length)
    return
  }
  if (block.kind === 'table') {
    for (const line of block.rows) {
      for (const item of line.cells) {
        for (const child of item.blocks) assertRuns(child)
      }
    }
  }
}

function roundTrip(value: unknown): void {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
  assertNoSrc(value)
}

test('read views match the fixture json', () => {
  const doc = fixture()
  const markers = listMarkers(doc)
  const summary = documentSummary(doc)
  assert.equal(summary.words, wordCount(doc))
  assert.equal(summary.words, 18)
  assert.deepEqual(summary, {
    blocks: 12,
    words: 18,
    sections: [{
      index: 0,
      breakType: 'nextPage',
      page: {
        widthPt: 612,
        heightPt: 792,
        margin: { top: 72, right: 72, bottom: 72, left: 72, header: 36, footer: 36, gutter: 0 },
      },
    }],
    styles: [
      { id: 'normal', name: 'Normal', heading: null },
      { id: 'h1', name: 'heading 1', heading: 1 },
      { id: 'h2', name: 'Heading 2', heading: 2 },
      { id: 'h4', name: 'HEADING 4', heading: 4 },
      { id: 'custom', name: 'Custom', heading: null },
    ],
  })

  const blocks = readBlocks(doc, pageOf, 0, 20)
  assert.deepEqual(blocks, {
    total: 12,
    from: 0,
    next: null,
    blocks: [
      paraBlock(0, 'chapter', 7, 'h1', 1, null),
      paraBlock(1, 'part', 4, 'h2', 2, null),
      paraBlock(2, 'bullet', 4, 'normal', null, null),
      paraBlock(3, 'deep', 4, 'h4', 4, null),
      paraBlock(4, 'marks', 12, 'normal', null, null),
      paraBlock(5, 'secret', 11, 'normal', null, 'revisions'),
      { index: 6, id: 'grid', kind: 'table', section: 0, page: 1, rows: 2, cols: 2 },
      { index: 7, id: 'box', kind: 'opaque', section: 0, page: null, label: 'sdt' },
      paraBlock(8, 'later', 5, 'h2', 2, null),
      paraBlock(9, 'end', 3, 'h1', 1, null),
      paraBlock(10, 'noted', 4, 'custom', null, null),
      paraBlock(11, 'tail', 4, 'normal', null, null),
    ],
  })

  const marksText = 'See \uFFFCpic\uFFFC\uFFFC\uFFFC\uFFFC'
  const textView = readText(doc, markers, 0, 20)
  assert.deepEqual(textView.blocks, [
    plain('chapter', 'Chapter', { style: 'h1', align: 'center', list: { level: 0, marker: '1.' } }),
    plain('part', 'Part', { style: 'h2', list: { level: 1, marker: '1.1' } }),
    plain('bullet', 'Item', { list: { level: 0, marker: '•' } }),
    plain('deep', 'Deep', { style: 'h4' }),
    {
      kind: 'paragraph',
      id: 'marks',
      text: marksText,
      runs: [
        { start: 0, end: 4, marks: { bold: true, underline: false } },
        { start: 4, end: 5, atom: 'image', widthPt: 72, heightPt: 72 },
        { start: 5, end: 8, marks: { italic: true, link: true } },
        { start: 8, end: 9, atom: 'field', display: '3' },
        { start: 9, end: 10, atom: 'pageBreak' },
        { start: 10, end: 11, atom: 'columnBreak' },
        { start: 11, end: 12, atom: 'opaque', display: '§' },
      ],
      style: 'normal',
      align: 'left',
      list: null,
      locked: null,
    },
    plain('secret', 'Locked text', { locked: 'revisions' }),
    {
      kind: 'table',
      id: 'grid',
      rows: [
        {
          cells: [
            { span: 1, vMerge: 'restart', blocks: [plain('A', 'Alpha')] },
            { span: 1, vMerge: null, blocks: [plain('B', 'Beta')] },
          ],
        },
        {
          cells: [
            { span: 1, vMerge: 'continue', blocks: [plain('v', 'Merge')] },
            {
              span: 1,
              vMerge: null,
              blocks: [
                {
                  kind: 'table',
                  id: 'inner',
                  rows: [{ cells: [{ span: 1, vMerge: null, blocks: [plain('nest', 'in')] }] }],
                },
                plain('C', 'Cell'),
              ],
            },
          ],
        },
      ],
    },
    { kind: 'opaque', id: 'box', label: 'sdt', preview: ['Shown'] },
    plain('later', 'Later', { style: 'h2', list: { level: 1, marker: '1.2' } }),
    plain('end', 'End', { style: 'h1', list: { level: 0, marker: '2.' } }),
    plain('noted', 'Note', { style: 'custom' }),
    plain('tail', 'Tail'),
  ])
  const dumped = JSON.stringify(textView)
  assert.equal(dumped.includes('secret-link'), false)
  assert.equal(dumped.includes('secret-media'), false)
  assert.equal(dumped.includes('secret-atom'), false)

  const outline = readOutline(doc, markers, pageOf)
  assert.equal(outline.truncated, false)
  assert.deepEqual(outline.headings, [
    { id: 'chapter', level: 1, number: '1.', text: 'Chapter', page: 1, from: 0, to: 8 },
    { id: 'part', level: 2, number: '1.1', text: 'Part', page: 1, from: 1, to: 7 },
    { id: 'deep', level: 4, number: null, text: 'Deep', page: 1, from: 3, to: 7 },
    { id: 'later', level: 2, number: '1.2', text: 'Later', page: 1, from: 8, to: 8 },
    { id: 'end', level: 1, number: '2.', text: 'End', page: 1, from: 9, to: 11 },
  ])

  const found = readFind(doc, 'part', null, 100, false)
  assert.deepEqual(found, { matches: [{ para: 'part', start: 0, end: 4 }], truncated: false })
  assert.deepEqual(readFind(doc, 'part', null, 100, true), { matches: [], truncated: false })
  assert.deepEqual(readFind(doc, 'Running', null, 100, false).matches, [])
  assert.deepEqual(readFind(doc, 'Shown', null, 100, false).matches, [])
  assert.deepEqual(readFind(doc, 'Footer', null, 100, false).matches, [])
  assert.deepEqual(readFind(doc, 'in', null, 100, true), { matches: [{ para: 'nest', start: 0, end: 2 }], truncated: false })

  const named = readTextByIds(doc, markers, ['run', 'prev', 'box', 'nest', 'tail', 'tail'])
  assert.equal(named.ok, true)
  if (named.ok) {
    assert.deepEqual(named.blocks, [
      plain('run', 'Running head'),
      plain('prev', 'Shown', { locked: 'preview' }),
      { kind: 'opaque', id: 'box', label: 'sdt', preview: ['Shown'] },
      plain('nest', 'in'),
      plain('tail', 'Tail'),
      plain('tail', 'Tail'),
    ])
  }
  const missing = readTextByIds(doc, markers, ['tail', 'nope'])
  assert.deepEqual(missing, { ok: false, missing: 'nope' })
  assert.deepEqual(readTextByIds(doc, markers, []), { ok: true, blocks: [] })

  roundTrip(summary)
  roundTrip(blocks)
  roundTrip(textView)
  roundTrip(outline)
  roundTrip(found)
  if (named.ok) roundTrip(named.blocks)
})

test('outline level 2 stops before the next level 1 or 2', () => {
  const doc = fixture()
  const outline = readOutline(doc, listMarkers(doc), pageOf)
  const part = outline.headings.find((heading) => heading.id === 'part')
  const later = outline.headings.find((heading) => heading.id === 'later')
  assert.ok(part)
  assert.ok(later)
  assert.equal(part.level, 2)
  assert.equal(part.to, 7)
  assert.equal(later.from, part.to + 1)
  assert.equal(outline.headings.some((heading) => heading.id === 'noted'), false)
})

test('paging visits each block once for counts 1 through 7', () => {
  const doc = fixture()
  const ids = doc.body.map((block) => block.id)
  for (let count = 1; count <= 7; count++) {
    const seen: string[] = []
    let from = 0
    for (let guard = 0; guard < 40; guard++) {
      const page = readBlocks(doc, pageOf, from, count)
      assert.equal(page.from, from)
      assert.ok(page.blocks.length <= count)
      for (const block of page.blocks) seen.push(block.id)
      if (page.next === null) {
        assert.equal(page.blocks.length, ids.length - from)
        break
      }
      assert.equal(page.next, from + page.blocks.length)
      from = page.next
    }
    assert.deepEqual(seen, ids)
  }
})

test('runs cover every paragraph without gaps', () => {
  const doc = fixture()
  const markers = listMarkers(doc)
  const ids: string[] = []
  const walk = (blocks: readonly Block[]): void => {
    for (const block of blocks) {
      if (block.kind === 'p') ids.push(block.id)
      else if (block.kind === 'table') {
        for (const line of block.rows) {
          for (const item of line.cells) walk(item.blocks)
        }
      } else {
        for (const para of block.preview) ids.push(para.id)
      }
    }
  }
  walk(doc.body)
  for (const blocks of doc.stories.values()) walk(blocks)
  const named = readTextByIds(doc, markers, ids)
  assert.equal(named.ok, true)
  if (!named.ok) return
  assert.equal(named.blocks.length, ids.length)
  for (const block of named.blocks) assertRuns(block)
  for (const block of readText(doc, markers, 0, 20).blocks) assertRuns(block)
})

test('responses round-trip through json and carry no src', () => {
  const doc = fixture()
  const markers = listMarkers(doc)
  const page = (id: string) => id === 'box' ? null : 0
  const values = [
    documentSummary(doc),
    readBlocks(doc, page, 0, 20),
    readText(doc, markers, 0, 20),
    readOutline(doc, markers, page),
    readFind(doc, 'in', null, 100, false),
  ]
  for (const value of values) roundTrip(value)
  const fractional = readBlocks(doc, () => 1.5, 0, 1)
  assert.equal(fractional.blocks[0]?.page, null)
  assert.equal(readBlocks(doc, () => -1, 0, 1).blocks[0]?.page, null)
  assert.equal(readBlocks(doc, () => 2, 0, 1).blocks[0]?.page, 3)
})

test('heading level comes from the style name', () => {
  const doc = fixture()
  const outline = readOutline(doc, listMarkers(doc), pageOf)
  const deep = outline.headings.find((heading) => heading.id === 'deep')
  assert.ok(deep)
  assert.equal(deep.level, 4)
  assert.equal(deep.number, null)
  const summary = documentSummary(doc)
  assert.equal(summary.styles.find((style) => style.id === 'custom')?.heading, null)
  assert.equal(summary.styles.find((style) => style.id === 'h4')?.heading, 4)
})

test('section index advances after sectionEnd', () => {
  const doc = makeDoc([
    paragraph('a', [text('A')], {}, { sectionEnd: 0 }),
    paragraph('b', [text('B')]),
  ], { sections: [section(), section()] })
  const blocks = readBlocks(doc, () => 0, 0, 10)
  assert.equal(blocks.blocks[0]?.section, 0)
  assert.equal(blocks.blocks[1]?.section, 1)
})

test('find skips headers, footers, and previews', () => {
  const doc = fixture()
  assert.deepEqual(readFind(doc, 'Running', null, 100, false).matches, [])
  assert.deepEqual(readFind(doc, 'Footer', null, 100, false).matches, [])
  assert.deepEqual(readFind(doc, 'Shown', null, 100, false).matches, [])
  const nest = indexOf(doc).ordered.find((id) => id === 'nest')
  assert.ok(nest)
  assert.deepEqual(readFind(doc, 'in', { p: nest, o: 0 }, 100, true).matches, [
    { para: 'nest', start: 0, end: 2 },
  ])
  const many = makeDoc(Array.from({ length: 1001 }, (_, index) => paragraph(`f${index}`, [text('x')])))
  const capped = readFind(many, 'x', null, 1000, false)
  assert.equal(capped.matches.length, 1000)
  assert.equal(capped.truncated, true)
  assert.equal(capped.matches[0]?.para, 'f0')
})

test('outline keeps at most 5000 headings', () => {
  const body = Array.from({ length: 5001 }, (_, index) => paragraph(`h${index}`, [text('H')], { style: HEADING }))
  const doc = makeDoc(body)
  const outline = readOutline(doc, listMarkers(doc), () => 0)
  assert.equal(outline.truncated, true)
  assert.equal(outline.headings.length, 5000)
  assert.equal(outline.headings[4999]?.id, 'h4999')
  assert.equal(outline.headings[4999]?.from, 4999)
  assert.equal(outline.headings[4999]?.to, 4999)
  assert.equal(outline.headings[0]?.to, 0)
})

test('a paragraph with no style uses the default style alignment', () => {
  const look = paraLook()
  const doc = makeDoc([
    paragraph('bare', [text('Hello')]),
  ], {
    styles: {
      paragraph: new Map([[NORMAL, { name: 'Normal', role: 'normal', next: null, look: { ...look, align: 'center' } }]]),
      character: new Map(),
      defaultParagraph: NORMAL,
      added: [],
    },
  })
  checkDoc(doc)
  const view = readText(doc, listMarkers(doc), 0, 1)
  assert.deepEqual(view.blocks, [{
    kind: 'paragraph',
    id: 'bare',
    text: 'Hello',
    runs: [{ start: 0, end: 5, marks: {} }],
    style: 'normal',
    align: 'center',
    list: null,
    locked: null,
  }])
})

test('blocks and text cap count at 500', () => {
  const body = Array.from({ length: 501 }, (_, index) => paragraph(`b${index}`, [text('x')]))
  const doc = makeDoc(body)
  const blocks = readBlocks(doc, () => 0, 0, 10000)
  assert.equal(blocks.total, 501)
  assert.equal(blocks.blocks.length, 500)
  assert.equal(blocks.next, 500)
  const rest = readBlocks(doc, () => 0, 500, 10000)
  assert.equal(rest.blocks.length, 1)
  assert.equal(rest.next, null)
  const textPage = readText(doc, listMarkers(doc), 0, 10000)
  assert.equal(textPage.blocks.length, 500)
  assert.equal(textPage.next, 500)
  const past = readBlocks(doc, () => 0, 501, 10)
  assert.deepEqual(past.blocks, [])
  assert.equal(past.next, null)
  assert.equal(past.from, 501)
  const wider = makeDoc(Array.from({ length: 201 }, (_, index) => paragraph(`n${index}`, [text('x')])))
  const first = readBlocks(wider, () => 0, 0, undefined)
  assert.equal(first.blocks.length, 200)
  assert.equal(first.next, 200)
  assert.equal(first.total, 201)
})
