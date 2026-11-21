import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BorderEdge, BorderLine, CellBorders, Pt, RunLook, Section, Table, TableBorders } from '../model.ts'
import { cell, paragraph, pt, row, table, text, hex } from './testkit.ts'
import { cellBoxShadow, cellEdges, pageBoxStyle, paintedCellEdges, scriptSegments } from './render.ts'

const look = {
  fonts: { ascii: 'Times', hAnsi: 'TimesHigh', eastAsia: 'SimSun', cs: 'Naskh' },
  sizePt: 10.5 as Pt,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  color: 'auto',
  caps: false,
  charSpacingPt: 0 as Pt,
} satisfies RunLook

test('scriptSegments gives CJK the east Asia font and Latin the ASCII font', () => {
  const segments = scriptSegments('Hello世界', look)
  assert.deepEqual(segments, [
    { text: 'Hello', family: 'Times' },
    { text: '世界', family: 'SimSun' },
  ])
})

test('scriptSegments keeps fullwidth forms on the east Asia font and high ANSI on hAnsi', () => {
  const segments = scriptSegments('A１é', look)
  assert.equal(segments.map((segment) => segment.text).join(''), 'A１é')
  assert.equal(segments[0]?.family, 'Times')
  assert.equal(segments[1]?.family, 'SimSun')
  assert.equal(segments[2]?.family, 'TimesHigh')
})

test('pageBoxStyle converts points to px at 4/3', () => {
  const section = {
    src: null,
    page: {
      widthPt: 75 as Pt,
      heightPt: 150 as Pt,
      margin: {
        top: 15 as Pt,
        right: 7.5 as Pt,
        bottom: 15 as Pt,
        left: 7.5 as Pt,
        header: 0 as Pt,
        footer: 0 as Pt,
        gutter: 0 as Pt,
      },
    },
    breakType: 'nextPage',
    titlePage: false,
    headers: {},
    footers: {},
    grid: null,
  } satisfies Section
  const box = pageBoxStyle(section)
  assert.equal(box.page.width, '100px')
  assert.equal(box.page.height, '200px')
  assert.equal(box.content.left, '10px')
  assert.equal(box.content.top, '20px')
})

function edge(width: number, color: string, style: BorderLine['style'] = 'single'): BorderLine {
  return { style, widthPt: pt(width), color: hex(color) }
}

function all(line: BorderEdge): TableBorders {
  return { top: line, left: line, bottom: line, right: line, insideH: line, insideV: line }
}

function square(borders: TableBorders | undefined, cellBorders?: CellBorders): Table {
  const cellAt = (id: string, borders?: CellBorders) => {
    const made = cell([paragraph(id, [text(id)])])
    return borders === undefined ? made : { ...made, borders }
  }
  const built = table('t', [
    row([cellAt('a', cellBorders), cellAt('b')]),
    row([cellAt('c'), cellAt('d')]),
  ], [100, 100])
  return borders === undefined ? built : { ...built, props: { borders } }
}

function everyEdge(made: Table, line: BorderEdge): void {
  for (let r = 0; r < made.rows.length; r++) {
    for (let c = 0; c < (made.rows[r]?.cells.length ?? 0); c++) {
      assert.deepEqual(cellEdges(made, r, c), { top: line, left: line, bottom: line, right: line }, `${r},${c}`)
    }
  }
}

function sides(shadow: string): string[] {
  if (shadow === 'none') return []
  const found: string[] = []
  for (const part of shadow.split(', ')) {
    const nums = [...part.matchAll(/-?[\d.]+px/g)].map((match) => Number(match[0].replace('px', '')))
    const x = nums[0] ?? 0
    const y = nums[1] ?? 0
    if (Math.abs(x) < 0.001 && y > 0) found.push('top')
    else if (Math.abs(y) < 0.001 && x > 0) found.push('left')
    else if (Math.abs(x) < 0.001 && y < 0) found.push('bottom')
    else if (Math.abs(y) < 0.001 && x < 0) found.push('right')
  }
  return found
}

test('the four table shapes resolve the edges the file gives them', () => {
  const plain = square(undefined)
  everyEdge(plain, null)
  assert.equal(cellBoxShadow(paintedCellEdges(plain, 0, 0)), 'none', 'a table with no borders draws none')

  const direct = edge(1, 'FF0000')
  everyEdge(square(all(direct)), direct)

  const grid = edge(0.5, '000000')
  everyEdge(square(all(grid)), grid)

  const blue = edge(1.5, '0000FF')
  const over = square(all(blue), { right: null })
  assert.deepEqual(cellEdges(over, 0, 0), { top: blue, left: blue, bottom: blue, right: null })
  assert.deepEqual(cellEdges(over, 0, 1), { top: blue, left: blue, bottom: blue, right: blue })
  assert.deepEqual(cellEdges(over, 1, 0).right, blue)
  assert.deepEqual(cellEdges(over, 1, 1).bottom, blue)
})

test('a line shared by two cells is drawn once', () => {
  const line = edge(0.5, '000000')
  const made = square(all(line))
  assert.deepEqual(paintedCellEdges(made, 0, 0).right, line, 'the left cell paints the shared vertical line')
  assert.equal(paintedCellEdges(made, 0, 1).left, null, 'the right cell does not paint it again')
  assert.deepEqual(cellEdges(made, 0, 1).left, line, 'the right cell still resolves the line')
  assert.deepEqual(paintedCellEdges(made, 0, 0).bottom, line, 'the upper cell paints the shared horizontal line')
  assert.equal(paintedCellEdges(made, 1, 0).top, null, 'the lower cell does not paint it again')
  const left = sides(cellBoxShadow(paintedCellEdges(made, 0, 0)))
  const right = sides(cellBoxShadow(paintedCellEdges(made, 0, 1)))
  assert.deepEqual(left, ['top', 'left', 'bottom', 'right'])
  assert.deepEqual(right, ['top', 'bottom', 'right'])

  const over = square(all(line), { right: null })
  assert.equal(cellEdges(over, 0, 0).right, null, 'the cell still says its own right edge is none')
  assert.deepEqual(paintedCellEdges(over, 0, 0).right, line, 'the neighbour keeps the line between the cells')
  assert.equal(paintedCellEdges(over, 0, 1).left, null, 'the right cell does not paint it again')
  assert.ok(sides(cellBoxShadow(paintedCellEdges(over, 0, 0))).includes('right'))
  assert.ok(!sides(cellBoxShadow(paintedCellEdges(over, 0, 1))).includes('left'))
})

function boxed(id: string, borders?: CellBorders) {
  const made = cell([paragraph(id, [text(id)])])
  return borders === undefined ? made : { ...made, borders }
}

test('a shared line uses both facing edges', () => {
  const line = edge(1, '00AA00')
  const named = table('t', [
    row([boxed('a'), boxed('b', { left: line })]),
  ], [100, 100])
  assert.deepEqual(paintedCellEdges(named, 0, 0).right, line, 'a left edge named in column 1 is drawn')
  assert.equal(paintedCellEdges(named, 0, 1).left, null, 'the cell that names it does not paint it again')
  assert.ok(sides(cellBoxShadow(paintedCellEdges(named, 0, 0))).includes('right'))
  assert.equal(cellBoxShadow(paintedCellEdges(named, 0, 1)), 'none')

  const namedTop = table('t', [
    row([boxed('c')]),
    row([boxed('d', { top: line })]),
  ], [100])
  assert.deepEqual(paintedCellEdges(namedTop, 0, 0).bottom, line, 'a top edge named below row 0 is drawn')
  assert.equal(paintedCellEdges(namedTop, 1, 0).top, null)

  const kept = table('t', [
    row([boxed('e', { right: line }), boxed('f', { left: null })]),
  ], [100, 100])
  assert.deepEqual(paintedCellEdges(kept, 0, 0).right, line, 'one line and one none draws the line')

  const neither = table('t', [
    row([boxed('g', { right: null, bottom: null }), boxed('h', { left: null })]),
    row([boxed('i', { top: null }), boxed('j')]),
  ], [100, 100])
  const cleared = { ...neither, props: { borders: all(line) } }
  assert.equal(paintedCellEdges(cleared, 0, 0).right, null, 'two facing edges that are both none draw no line')
  assert.equal(paintedCellEdges(cleared, 0, 1).left, null)
  assert.equal(paintedCellEdges(cleared, 0, 0).bottom, null, 'a bottom of none and a top of none draw no line')

  const red = edge(2, 'FF0000')
  const blue = edge(0.5, '0000FF')
  const differ = table('t', [
    row([boxed('k', { right: red }), boxed('l', { left: blue })]),
  ], [100, 100])
  assert.deepEqual(paintedCellEdges(differ, 0, 0).right, blue, 'the later stroke is the right neighbour')
  const differRow = table('t', [
    row([boxed('m', { bottom: red })]),
    row([boxed('n', { top: blue })]),
  ], [100])
  assert.deepEqual(paintedCellEdges(differRow, 0, 0).bottom, blue, 'the later stroke is the lower neighbour')
  assert.equal(paintedCellEdges(differRow, 1, 0).top, null, 'the lower cell does not paint it again')

  const across = table('t', [
    row([cell([paragraph('o', [text('o')])], 2)]),
    row([boxed('p', { top: red }), boxed('q', { top: blue })]),
  ], [100, 100])
  assert.deepEqual(paintedCellEdges(across, 0, 0).bottom, red, 'several cells along one edge use the first')
  const down = table('t', [
    row([
      { ...cell([paragraph('r', [text('r')])]), vMerge: 'restart' },
      boxed('s', { left: red }),
    ]),
    row([
      { ...cell([paragraph('u', [text('u')])]), vMerge: 'continue' },
      boxed('v', { left: blue }),
    ]),
  ], [100, 100])
  assert.deepEqual(paintedCellEdges(down, 0, 0).right, red, 'several cells down one edge use the first')
  assert.equal(paintedCellEdges(down, 0, 1).left, null, 'the spanning cell paints that line once')
})
