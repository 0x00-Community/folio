import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Block, BlockId, Doc, Paragraph, Pt, Section, StoryKey, StyleId } from '../model.ts'
import { listMarkers } from './derive.ts'
import { apply, deleteBackward, initialState, selectAll, setPageSetup, setSelection, toggleList } from './edit.ts'
import { layoutPlan, pageOfBlock, paginate, type Layout, type Measure } from './pages.ts'
import { cell, makeDoc, opaqueBlock, paragraph, row, table, text } from './testkit.ts'

function pt(n: number): Pt {
  return n as Pt
}

function para(id: string, sectionEnd: number | null = null): Paragraph {
  return {
    kind: 'p',
    id: id as Paragraph['id'],
    src: null,
    props: {},
    inlines: [{ kind: 'text', text: 'x', marks: {}, src: null }],
    lock: null,
    sectionEnd,
  }
}

function sectionBox(pxHeight: number, breakType: Section['breakType'] = 'nextPage'): Section {
  const edge = 0 as Pt
  return {
    src: null,
    page: {
      widthPt: pt((200 * 3) / 4),
      heightPt: pt((pxHeight * 3) / 4),
      margin: { top: edge, right: edge, bottom: edge, left: edge, header: edge, footer: edge, gutter: edge },
    },
    breakType,
    titlePage: false,
    headers: {},
    footers: {},
    grid: null,
  }
}

function docOf(blocks: readonly Block[], sections: readonly Section[], stories?: Map<StoryKey, readonly Block[]>): Doc {
  return {
    body: blocks,
    sections,
    stories: stories ?? new Map(),
    styles: { paragraph: new Map(), character: new Map(), defaultParagraph: 'Normal' as StyleId, added: [] },
    lists: { byNum: new Map() },
    media: { byKey: new Map() },
  }
}

function pm(height: number, lines: number[], extra: Partial<Measure> = {}): Measure {
  return {
    widthPx: 100,
    heightPx: height,
    lineBottoms: extra.lineBottoms ?? Float32Array.from(lines),
    ...(extra.rowBottoms ? { rowBottoms: extra.rowBottoms, cantSplitRows: extra.cantSplitRows } : {}),
    headerRows: extra.headerRows ?? 0,
    spaceBeforePx: extra.spaceBeforePx ?? 0,
    spaceAfterPx: extra.spaceAfterPx ?? 0,
    keepNext: extra.keepNext ?? false,
    keepLines: extra.keepLines ?? false,
    pageBreakBefore: extra.pageBreakBefore ?? false,
    widowControl: extra.widowControl ?? false,
  }
}

function sig(layout: Layout): string[] {
  return layout.pages.map((page) => {
    const body = page.slices
      .map((slice) => `${slice.block}:${slice.y0}-${slice.y1}${slice.repeatHeaderRows ? `/r${slice.repeatHeaderRows}` : ''}`)
      .join('|')
    return body.length > 0 ? body : '-'
  })
}

function pagesFor(layout: Layout, id: string): number[] {
  const pages: number[] = []
  layout.pages.forEach((page, index) => {
    if (page.slices.some((slice) => slice.block === id)) pages.push(index)
  })
  return pages
}

function assertSamePages(actual: Layout, full: Layout, body: readonly Paragraph[]): void {
  assert.equal(actual.pages.length, full.pages.length)
  for (let i = 0; i < full.pages.length; i++) assert.deepEqual(actual.pages[i], full.pages[i])
  for (const block of body) assert.deepEqual(pagesFor(actual, block.id), pagesFor(full, block.id), block.id)
}

function layoutOf(blocks: readonly Paragraph[], measures: Map<string, Measure>, height: number, previous: Layout | null = null, changed: readonly string[] = []): Layout {
  return paginate(
    docOf(blocks, [sectionBox(height)]),
    (block) => measures.get(block.id),
    previous,
    changed.map((id) => id as BlockId),
  )
}

test('blocks flow onto the next page when the next one does not fit', () => {
  const blocks = [para('a'), para('b')]
  const measures = new Map([
    ['a', pm(80, [40, 80])],
    ['b', pm(80, [40, 80])],
  ])
  const layout = layoutOf(blocks, measures, 100)
  assert.equal(layout.complete, true)
  assert.deepEqual(sig(layout), ['a:0-80', 'b:0-80'])
})

test('a paragraph splits on line bottoms', () => {
  const measures = new Map([['a', pm(80, [20, 40, 60, 80])]])
  assert.deepEqual(sig(layoutOf([para('a')], measures, 50)), ['a:0-40', 'a:40-80'])
})

test('space after that does not fit is clipped instead of opening an empty continuation', () => {
  const measures = new Map([['a', pm(100, [40, 80])]])
  assert.deepEqual(sig(layoutOf([para('a')], measures, 90)), ['a:0-80'])
})

test('widow control pulls the last line back so a page does not start with one line', () => {
  const measures = new Map([['a', pm(100, [20, 40, 60, 80, 100], { widowControl: true })]])
  assert.deepEqual(sig(layoutOf([para('a')], measures, 90)), ['a:0-60', 'a:60-100'])
})

test('orphan control moves a paragraph when only its first line would fit', () => {
  const measures = new Map([
    ['a', pm(70, [70])],
    ['b', pm(80, [20, 40, 60, 80], { widowControl: true })],
  ])
  assert.deepEqual(sig(layoutOf([para('a'), para('b')], measures, 100)), ['a:0-70', 'b:0-80'])
})

test('without widow control a single line may stay at the bottom', () => {
  const measures = new Map([
    ['a', pm(70, [70])],
    ['b', pm(80, [20, 40, 60, 80])],
  ])
  assert.deepEqual(sig(layoutOf([para('a'), para('b')], measures, 100)), ['a:0-70|b:0-20', 'b:20-80'])
})

test('space before is kept on the first page and suppressed after a soft break', () => {
  const only = new Map([['b', pm(40, [25, 40], { spaceBeforePx: 10 })]])
  assert.equal(sig(layoutOf([para('b')], only, 100))[0], 'b:0-40')
  const measures = new Map([
    ['a', pm(80, [80])],
    ['b', pm(40, [25, 40], { spaceBeforePx: 10 })],
  ])
  assert.deepEqual(sig(layoutOf([para('a'), para('b')], measures, 100)), ['a:0-80', 'b:10-40'])
})

test('pageBreakBefore starts a new page and keeps space before', () => {
  const measures = new Map([
    ['a', pm(40, [40])],
    ['b', pm(30, [20, 30], { pageBreakBefore: true, spaceBeforePx: 10 })],
  ])
  assert.deepEqual(sig(layoutOf([para('a'), para('b')], measures, 100)), ['a:0-40', 'b:0-30'])
})

test('keepNext moves a chain that fits on an empty page but not in the remaining space', () => {
  const measures = new Map([
    ['a', pm(50, [50])],
    ['b', pm(40, [40], { keepNext: true })],
    ['c', pm(40, [40])],
  ])
  assert.deepEqual(sig(layoutOf([para('a'), para('b'), para('c')], measures, 100)), ['a:0-50', 'b:0-40|c:0-40'])
})

test('keepLines moves a paragraph that would otherwise split', () => {
  const measures = new Map([
    ['a', pm(50, [50])],
    ['b', pm(80, [40, 80], { keepLines: true })],
  ])
  assert.deepEqual(sig(layoutOf([para('a'), para('b')], measures, 100)), ['a:0-50', 'b:0-80'])
})

test('keepLines still splits a paragraph taller than a page', () => {
  const measures = new Map([['a', pm(80, [40, 80], { keepLines: true })]])
  assert.deepEqual(sig(layoutOf([para('a')], measures, 50)), ['a:0-40', 'a:40-80'])
})

test('table rows do not split and header rows repeat on the continuation', () => {
  const measures = new Map([['t', pm(120, [], { rowBottoms: Float32Array.from([30, 60, 90, 120]), headerRows: 1 })]])
  assert.deepEqual(sig(layoutOf([para('t')], measures, 70)), ['t:0-60', 't:60-90/r1', 't:90-120/r1'])
})

test('an unmeasured block stops pagination and a later chunk continues', () => {
  const blocks = [para('a'), para('b'), para('c')]
  const measures = new Map<string, Measure>([
    ['a', pm(80, [80])],
  ])
  const first = layoutOf(blocks, measures, 100)
  assert.equal(first.complete, false)
  assert.deepEqual(sig(first), ['a:0-80'])
  measures.set('b', pm(80, [80]))
  const second = layoutOf(blocks, measures, 100, first, ['b'])
  assert.equal(second.complete, false)
  assert.deepEqual(sig(second), ['a:0-80', 'b:0-80'])
  measures.set('c', pm(80, [80]))
  const third = layoutOf(blocks, measures, 100, second, ['c'])
  assert.equal(third.complete, true)
  assert.deepEqual(sig(third), ['a:0-80', 'b:0-80', 'c:0-80'])
})

test('an unchanged tail page is reused after an edit that does not move it', () => {
  const blocks = [para('a'), para('b'), para('c'), para('d')]
  const measures = new Map([
    ['a', pm(100, [100])],
    ['b', pm(40, [40])],
    ['c', pm(40, [40])],
    ['d', pm(40, [40])],
  ])
  const full = layoutOf(blocks, measures, 100)
  assert.deepEqual(sig(full), ['a:0-100', 'b:0-40|c:0-40', 'd:0-40'])
  const again = layoutOf(blocks, measures, 100, full, ['b'])
  assert.deepEqual(sig(again), sig(full))
  assert.equal(again.pages[2], full.pages[2])
})

test('a taller block pushes the following blocks onto later pages', () => {
  const blocks = [para('a'), para('b'), para('c'), para('d')]
  const measures = new Map<string, Measure>([
    ['a', pm(100, [100])],
    ['b', pm(40, [40])],
    ['c', pm(40, [40])],
    ['d', pm(40, [40])],
  ])
  const full = layoutOf(blocks, measures, 100)
  measures.set('b', pm(80, [80]))
  const again = layoutOf(blocks, measures, 100, full, ['b'])
  assert.deepEqual(sig(again), ['a:0-100', 'b:0-80', 'c:0-40|d:0-40'])
})

test('deleting a block pulls the next block onto the previous page', () => {
  const a = para('a')
  const c = para('c')
  const measures = new Map([
    ['a', pm(60, [60])],
    ['b', pm(50, [50])],
    ['c', pm(30, [30])],
  ])
  const first = layoutOf([a, para('b'), c], measures, 100)
  assert.deepEqual(sig(first), ['a:0-60', 'b:0-50|c:0-30'])
  const second = layoutOf([a, c], measures, 100, first, ['c'])
  assert.deepEqual(sig(second), ['a:0-60|c:0-30'])
})

test('an odd-page section break inserts a blank page', () => {
  const first = sectionBox(100)
  const second = sectionBox(100, 'oddPage')
  const measures = new Map([
    ['a', pm(40, [40])],
    ['b', pm(40, [40])],
  ])
  const layout = paginate(
    docOf([para('a', 0), para('b')], [first, second]),
    (block) => measures.get(block.id),
    null,
    [],
  )
  assert.deepEqual(sig(layout), ['a:0-40', '-', 'b:0-40'])
  assert.deepEqual(
    layout.pages.map((page) => page.section),
    [0, 1, 1],
  )
})

test('a continuous section with the same paper stays on the page', () => {
  const measures = new Map([
    ['a', pm(40, [40])],
    ['b', pm(40, [40])],
  ])
  const layout = paginate(
    docOf([para('a', 0), para('b')], [sectionBox(100), sectionBox(100, 'continuous')]),
    (block) => measures.get(block.id),
    null,
    [],
  )
  assert.deepEqual(sig(layout), ['a:0-40|b:0-40'])
  assert.equal(layout.pages[0]?.section, 0)
})

test('a header taller than the top margin pushes the body down', () => {
  const edge = 0 as Pt
  const section: Section = {
    src: null,
    page: {
      widthPt: pt((200 * 3) / 4),
      heightPt: pt((200 * 3) / 4),
      margin: { top: pt(30), right: edge, bottom: pt(30), left: edge, header: pt(7.5), footer: edge, gutter: edge },
    },
    breakType: 'nextPage',
    titlePage: false,
    headers: { default: 's0/header/default' as StoryKey },
    footers: {},
    grid: null,
  }
  const header = para('h')
  const body = para('a')
  const measures = new Map([
    ['h', pm(80, [80])],
    ['a', pm(50, [50])],
  ])
  const layout = paginate(
    docOf([body], [section], new Map([['s0/header/default' as StoryKey, [header]]])),
    (block) => measures.get(block.id),
    null,
    [],
  )
  assert.equal(layout.pages[0]?.bodyTopPx, 90)
  assert.deepEqual(sig(layout), ['a:0-50'])
})

function margined(paperPx: number, marginPx: number): Section {
  const edge = (px: number): Pt => pt((px * 3) / 4)
  return {
    src: null,
    page: {
      widthPt: edge(600),
      heightPt: edge(paperPx),
      margin: {
        top: edge(marginPx),
        right: edge(marginPx),
        bottom: edge(marginPx),
        left: edge(marginPx),
        header: edge(0),
        footer: edge(0),
        gutter: edge(0),
      },
    },
    breakType: 'nextPage',
    titlePage: false,
    headers: {},
    footers: {},
    grid: null,
  }
}

test('setPageSetup with narrower margins changes the page count of a long document', () => {
  const blocks = Array.from({ length: 24 }, (_, index) => para(`p${index}`))
  const measures = new Map<string, Measure>(blocks.map((block) => [block.id, pm(100, [100])]))
  const measure = (block: Block): Measure | undefined => measures.get(block.id)
  const doc = docOf(blocks, [margined(900, 300)])
  const first = paginate(doc, measure, null, [])
  assert.equal(first.pages.length, 8, 'tall margins hold three blocks on a page')
  const state = initialState(doc)
  const narrow = margined(900, 50).page
  const tr = setPageSetup(0, narrow)(state)
  assert.ok(tr, 'setPageSetup applies')
  const next = apply(state, tr, 0).doc
  assert.equal(next.body, doc.body, 'page setup does not replace a block')
  const second = paginate(next, measure, first, [])
  assert.equal(second.pages.length, 3, 'narrower margins fit more blocks on a page')
  const plan = layoutPlan(doc, next, new Map(), new Map())
  assert.equal(plan.remeasure.length, blocks.length, 'the section page change invalidates every block measure')
})

test('changing nothing but titlePage measures no block again', () => {
  const blocks = [para('a'), para('b'), para('c')]
  const measures = new Map<string, Measure>(blocks.map((block) => [block.id, pm(40, [40])]))
  let calls = 0
  const measure = (block: Block): Measure | undefined => {
    calls += 1
    return measures.get(block.id)
  }
  const section = margined(400, 40)
  const doc = docOf(blocks, [section])
  const first = paginate(doc, measure, null, [])
  const seen = calls
  assert.ok(seen > 0, 'the first layout measures the blocks')
  const titled: Section = { ...section, titlePage: true }
  const next = docOf(blocks, [titled])
  const second = paginate(next, measure, first, [])
  assert.equal(calls, seen, 'titlePage does not measure a block again')
  assert.equal(second.pages.length, first.pages.length)
  assert.deepEqual(sig(second), sig(first))
  const plan = layoutPlan(doc, next, new Map(), new Map())
  assert.deepEqual(plan.remeasure, [], 'titlePage leaves measures in place')
})

test('deleting the first numbered item changes the marker painted for the third', () => {
  const a = paragraph('a', [text('one')])
  const b = paragraph('b', [text('two')])
  const c = paragraph('c', [text('three')])
  let state = initialState(makeDoc([a, b, c]))
  const all = selectAll(state)
  assert.ok(all, 'select all applies')
  state = apply(state, all, 0)
  const listed = toggleList('decimal')(state)
  assert.ok(listed, 'the three paragraphs become one list')
  state = apply(state, listed, 0)
  assert.equal(listMarkers(state.doc).get(c.id), '3.')
  const caret = setSelection({ kind: 'text', anchor: { p: a.id, o: 0 }, head: { p: a.id, o: 0 } })(state)
  assert.ok(caret, 'the caret moves to the first item')
  state = apply(state, caret, 0)
  const cleared = deleteBackward('char')(state)
  assert.ok(cleared, 'backspace at the start of a list item leaves the list')
  const next = apply(state, cleared, 0)
  const third = next.doc.body[2]
  assert.equal(third, state.doc.body[2], 'the third paragraph object is unchanged')
  assert.equal(listMarkers(next.doc).get(c.id), '2.', 'the third item is renumbered')
  const plan = layoutPlan(state.doc, next.doc, listMarkers(state.doc), listMarkers(next.doc))
  assert.ok(plan.paint.includes(c.id), 'the third item is painted again')
  assert.ok(!plan.remeasure.includes(c.id), 'a marker change does not remeasure the paragraph')
})

test('a paragraph taller than a page splits on a line bottom inside the body', () => {
  const linePx = 19.32
  const lines = Array.from({ length: 55 }, (_, index) => (index + 1) * linePx)
  const textPx = 1043
  const paddingPx = 10.67
  const body = 864
  const layout = layoutOf([para('a')], new Map([['a', pm(textPx + paddingPx, lines)]]), body)
  assert.equal(layout.complete, true)
  const first = layout.pages[0]?.slices[0]
  const next = layout.pages[1]?.slices[0]
  assert.ok(first && next, 'the paragraph occupies two pages')
  assert.ok(first.y1 <= body, 'page 0 ends at or under the body')
  const bottoms = Float32Array.from(lines)
  assert.ok(Array.from(bottoms).some((bottom) => bottom === first.y1), 'page 0 ends on a line bottom')
  assert.equal(next.y0, first.y1, 'page 1 starts at that line')
})

function fivePages(): { blocks: Paragraph[], measures: Map<string, Measure> } {
  const blocks = [para('a'), para('b'), para('c'), para('d'), para('e')]
  const measures = new Map(blocks.map((block) => [block.id, pm(100, [100])]))
  return { blocks, measures }
}

test('a block inserted after an unchanged block on page 1 is placed on that page or the next', () => {
  const { blocks, measures } = fivePages()
  const previous = layoutOf(blocks, measures, 100)
  assert.ok(previous.pages.length >= 3, 'the document covers at least three pages')
  assert.deepEqual(pagesFor(previous, 'b'), [1], 'b is the block on page 1')
  const inserted = para('n')
  measures.set(inserted.id, pm(100, [100]))
  const a = blocks[0]
  const b = blocks[1]
  const c = blocks[2]
  const d = blocks[3]
  const e = blocks[4]
  assert.ok(a && b && c && d && e)
  const next = [a, b, inserted, c, d, e]
  const again = layoutOf(next, measures, 100, previous, [inserted.id])
  const full = layoutOf(next, measures, 100)
  const placed = pagesFor(again, inserted.id)
  assert.ok(placed.some((page) => page === 1 || page === 2), `the new block is on page 1 or 2, got ${placed.join(',')}`)
  assertSamePages(again, full, next)
})

test('a block inserted after an unchanged block on a middle page is placed on that page or the next', () => {
  const { blocks, measures } = fivePages()
  const previous = layoutOf(blocks, measures, 100)
  assert.ok(previous.pages.length >= 5, 'a middle page is neither the first nor the last')
  assert.deepEqual(pagesFor(previous, 'c'), [2], 'c is the block on the middle page')
  const inserted = para('n')
  measures.set(inserted.id, pm(100, [100]))
  const a = blocks[0]
  const b = blocks[1]
  const c = blocks[2]
  const d = blocks[3]
  const e = blocks[4]
  assert.ok(a && b && c && d && e)
  const next = [a, b, c, inserted, d, e]
  const again = layoutOf(next, measures, 100, previous, [inserted.id])
  const full = layoutOf(next, measures, 100)
  const placed = pagesFor(again, inserted.id)
  assert.ok(placed.some((page) => page === 2 || page === 3), `the new block is on page 2 or 3, got ${placed.join(',')}`)
  assertSamePages(again, full, next)
})

test('a block inserted at the start of the body is placed on the first page or the next', () => {
  const { blocks, measures } = fivePages()
  const previous = layoutOf(blocks, measures, 100)
  assert.ok(previous.pages.length >= 3)
  const inserted = para('n')
  measures.set(inserted.id, pm(100, [100]))
  const next = [inserted, ...blocks]
  const again = layoutOf(next, measures, 100, previous, [inserted.id])
  const full = layoutOf(next, measures, 100)
  const placed = pagesFor(again, inserted.id)
  assert.ok(placed.some((page) => page === 0 || page === 1), `the new block is on page 0 or 1, got ${placed.join(',')}`)
  assertSamePages(again, full, next)
})

test('removing a block from page 1 whose neighbors are unchanged matches a layout from scratch', () => {
  const a = para('a')
  const b = para('b')
  const c = para('c')
  const d = para('d')
  const measures = new Map<string, Measure>([
    [a.id, pm(60, [60])],
    [b.id, pm(100, [100])],
    [c.id, pm(30, [30])],
    [d.id, pm(100, [100])],
  ])
  const previous = layoutOf([a, b, c, d], measures, 100)
  assert.ok(previous.pages.length >= 3, 'the document covers at least three pages')
  assert.deepEqual(pagesFor(previous, b.id), [1], 'b is the block removed from page 1')
  const next = [a, c, d]
  assert.equal(next[0], a, 'the previous neighbor keeps its object')
  assert.equal(next[1], c, 'the following neighbor keeps its object')
  const again = layoutOf(next, measures, 100, previous, [c.id, d.id])
  const full = layoutOf(next, measures, 100)
  assert.equal(pagesFor(again, b.id).length, 0, 'the removed block is on no page')
  assertSamePages(again, full, next)
})

test('removing a block that spans pages drops every slice of it', () => {
  const a = para('a')
  const b = para('b')
  const c = para('c')
  const measures = new Map<string, Measure>([
    [a.id, pm(100, [100])],
    [b.id, pm(250, [100, 200, 250])],
    [c.id, pm(100, [100])],
  ])
  const previous = layoutOf([a, b, c], measures, 100)
  assert.ok(previous.pages.length >= 3)
  const bPages = pagesFor(previous, b.id)
  assert.ok(bPages.includes(1) && bPages.length >= 2, 'b starts on page 1 and continues')
  const next = [a, c]
  assert.equal(next[0], a)
  assert.equal(next[1], c)
  const again = layoutOf(next, measures, 100, previous, [c.id])
  const full = layoutOf(next, measures, 100)
  assert.equal(pagesFor(again, b.id).length, 0, 'no page keeps a slice of the removed block')
  assertSamePages(again, full, next)
})

test('pageOfBlock is the page of the first slice, or null when the layout has not placed the id', () => {
  const body = para('p')
  const inner = para('in-cell')
  const grid = table('t', [row([cell([inner])])])
  const box = opaqueBlock('o', [para('preview')], true)
  const later = para('later')
  const measures = new Map<string, Measure>([
    [body.id, pm(80, [80])],
    [grid.id, pm(80, [], { rowBottoms: Float32Array.from([80]) })],
    [box.id, pm(80, [80])],
  ])
  const blocks = [body, grid, box, later]
  const doc = docOf(blocks, [sectionBox(100)])
  const incomplete = paginate(doc, (block) => measures.get(block.id), null, [])
  assert.equal(incomplete.complete, false)
  assert.equal(incomplete.pages.length, 3, sig(incomplete).join(' / '))
  assert.equal(pageOfBlock(incomplete, body.id), 0, 'the paragraph is on the first page')
  assert.equal(pageOfBlock(incomplete, grid.id), 1, 'the table is on the second page')
  assert.equal(pageOfBlock(incomplete, box.id), 2, 'the opaque block is on the third page')
  assert.equal(pageOfBlock(incomplete, later.id), null, 'a block past the measured part is unplaced')
  assert.equal(pageOfBlock(incomplete, inner.id), null, 'a cell paragraph is not its own slice')
  assert.equal(pageOfBlock(incomplete, 'missing'), null)

  measures.set(later.id, pm(80, [80]))
  const complete = paginate(doc, (block) => measures.get(block.id), incomplete, [later.id])
  assert.equal(complete.complete, true)
  assert.equal(pageOfBlock(complete, later.id), 3)
  assert.equal(pageOfBlock(complete, inner.id), null)

  const split = layoutOf([para('s')], new Map([['s', pm(80, [40, 80])]]), 50)
  assert.deepEqual(sig(split), ['s:0-40', 's:40-80'])
  assert.equal(pageOfBlock(split, 's'), 0, 'a block that continues answers the page of its first slice')
})
