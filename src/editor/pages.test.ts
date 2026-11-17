import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Block, BlockId, Doc, Paragraph, Pt, Section, StoryKey, StyleId } from '../model.ts'
import { paginate, type Layout, type Measure } from './pages.ts'

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
