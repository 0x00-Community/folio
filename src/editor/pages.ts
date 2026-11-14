import type {
  Block,
  BlockId,
  Doc,
  Paragraph,
  ParaId,
  Pos,
  Section,
  Selection,
  StoryKey,
  Table,
} from '../model.ts'
import {
  blockElements,
  domPoint,
  flatText,
  pageBoxStyle,
  posFromDom,
  PT_TO_PX,
  rangeIn,
  renderBlock,
} from './render.ts'
import type { Decoration, RenderContext } from './render.ts'

const EPS = 0.51
const STACK_PAD = 16
const PAGE_GAP = 16

export interface Measure {
  readonly widthPx: number
  readonly heightPx: number
  /** Bottom of each line, relative to the block's top, padding included. Paragraphs only. */
  readonly lineBottoms: Float32Array
  /** Bottom of each row. Tables only. */
  readonly rowBottoms?: Float32Array
  readonly headerRows: number
  readonly cantSplitRows?: Uint8Array
  readonly spaceBeforePx: number
  readonly spaceAfterPx: number
  readonly keepNext: boolean
  readonly keepLines: boolean
  readonly pageBreakBefore: boolean
  readonly widowControl: boolean
}

interface LineRect {
  top: number
  bottom: number
  left: number
  right: number
  anchor: number
}

function groupLineRects(rects: readonly DOMRect[]): LineRect[] {
  const usable = rects.filter((rect) => rect.width > 0.4 && rect.height > 0.4)
  usable.sort((a, b) => a.top - b.top || a.left - b.left)
  const lines: LineRect[] = []
  for (const rect of usable) {
    const last = lines[lines.length - 1]
    // Classify by the fragment's top. Growing last.bottom would let one tall rect swallow every line below it.
    if (last && rect.top < last.anchor + 8) {
      last.top = Math.min(last.top, rect.top)
      last.bottom = Math.max(last.bottom, rect.bottom)
      last.left = Math.min(last.left, rect.left)
      last.right = Math.max(last.right, rect.right)
    } else {
      lines.push({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, anchor: rect.top })
    }
  }
  return lines
}

function contentLineRects(el: HTMLElement): LineRect[] {
  const kids = [...el.children].filter((child) => child instanceof HTMLElement && !child.classList.contains('marker'))
  const first = kids[0]
  const last = kids[kids.length - 1]
  if (!(first instanceof HTMLElement) || !(last instanceof HTMLElement)) {
    const range = document.createRange()
    range.selectNodeContents(el)
    return groupLineRects([...range.getClientRects()])
  }
  const range = document.createRange()
  range.setStartBefore(first)
  range.setEndAfter(last)
  return groupLineRects([...range.getClientRects()])
}

/** Reads a mounted or hidden block element: offsetHeight, plus line bottoms grouped from Range.getClientRects(). */
export function measureElement(el: HTMLElement, zoom: number): Measure {
  const z = zoom > 0 ? zoom : 1
  const box = el.getBoundingClientRect()
  const style = getComputedStyle(el)
  const spaceBeforePx = parseFloat(style.paddingTop) || 0
  const spaceAfterPx = parseFloat(style.paddingBottom) || 0
  const lines = el.classList.contains('t') ? [] : contentLineRects(el)
  const lineBottoms = new Float32Array(lines.length)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    lineBottoms[i] = (line.bottom - box.top) / z
  }
  for (let i = 1; i < lineBottoms.length; i++) {
    const prev = lineBottoms[i - 1] ?? 0
    if ((lineBottoms[i] ?? 0) < prev + 0.5) lineBottoms[i] = prev + 0.5
  }
  let rowBottoms: Float32Array | undefined
  let cantSplitRows: Uint8Array | undefined
  const table = el.querySelector(':scope > table')
  if (table instanceof HTMLTableElement && table.rows.length > 0) {
    rowBottoms = new Float32Array(table.rows.length)
    cantSplitRows = new Uint8Array(table.rows.length)
    for (let i = 0; i < table.rows.length; i++) {
      const row = table.rows[i]
      if (!row) continue
      let bottom = 0
      for (const cell of row.cells) bottom = Math.max(bottom, cell.getBoundingClientRect().bottom - box.top)
      rowBottoms[i] = bottom / z
      cantSplitRows[i] = 1
    }
    for (let i = 1; i < rowBottoms.length; i++) {
      const prev = rowBottoms[i - 1] ?? 0
      if ((rowBottoms[i] ?? 0) < prev + 0.5) rowBottoms[i] = prev + 0.5
    }
  }
  const lastLine = lineBottoms.length > 0 ? (lineBottoms[lineBottoms.length - 1] ?? 0) : 0
  const lastRow = rowBottoms && rowBottoms.length > 0 ? (rowBottoms[rowBottoms.length - 1] ?? 0) : 0
  const headerRows = Number(el.dataset.headerRows ?? '0')
  return {
    widthPx: el.offsetWidth || box.width / z,
    heightPx: Math.max(box.height / z, lastLine, lastRow),
    lineBottoms,
    ...(rowBottoms ? { rowBottoms, cantSplitRows } : {}),
    headerRows: Number.isFinite(headerRows) ? headerRows : 0,
    spaceBeforePx,
    spaceAfterPx,
    keepNext: el.dataset.keepNext === '1',
    keepLines: el.dataset.keepLines === '1',
    pageBreakBefore: el.dataset.pageBreakBefore === '1',
    widowControl: el.dataset.widow === '1',
  }
}

export interface Slice {
  readonly block: BlockId
  readonly y0: number
  readonly y1: number
  /** Header rows to repeat at the top of a table continuation. */
  readonly repeatHeaderRows: number
}

export interface Page {
  readonly section: number
  readonly slices: readonly Slice[]
  readonly header: StoryKey | null
  readonly footer: StoryKey | null
  /** Body top in px from the page top: the top margin, or lower when the header is taller than the space it has. */
  readonly bodyTopPx: number
}

export interface Layout {
  readonly pages: readonly Page[]
  /** False while blocks after `pages` are still unmeasured (the first chunks of a large open). */
  readonly complete: boolean
}

type MeasureFn = (block: Block, section: Section) => Measure | undefined

interface Frame {
  paperWidth: number
  paperHeight: number
  contentWidth: number
  contentLeft: number
  bodyTop: number
  bodyHeight: number
  header: StoryKey | null
  footer: StoryKey | null
  headerTop: number
  footerBottom: number
}

function headerKey(section: Section, pageNumber: number): StoryKey | null {
  if (pageNumber === 1 && section.titlePage && section.headers.first) return section.headers.first
  if (pageNumber % 2 === 0 && section.headers.even) return section.headers.even
  return section.headers.default ?? null
}

function footerKey(section: Section, pageNumber: number): StoryKey | null {
  if (pageNumber === 1 && section.titlePage && section.footers.first) return section.footers.first
  if (pageNumber % 2 === 0 && section.footers.even) return section.footers.even
  return section.footers.default ?? null
}

function storyHeight(doc: Doc, key: StoryKey | null, section: Section, measure: MeasureFn): number {
  if (!key) return 0
  const blocks = doc.stories.get(key)
  if (!blocks) return 0
  let height = 0
  for (const block of blocks) {
    const measured = measure(block, section)
    if (!measured) return 0
    height += measured.heightPx
  }
  return height
}

function pageFrame(doc: Doc, section: Section, pageNumber: number, measure: MeasureFn): Frame {
  const page = section.page
  const margin = page.margin
  const paperWidth = page.widthPt * PT_TO_PX
  const paperHeight = page.heightPt * PT_TO_PX
  const contentLeft = (margin.left + margin.gutter) * PT_TO_PX
  const contentWidth = Math.max(0, paperWidth - contentLeft - margin.right * PT_TO_PX)
  const marginTop = margin.top * PT_TO_PX
  const marginBottom = margin.bottom * PT_TO_PX
  const headerTop = margin.header * PT_TO_PX
  const footerBottom = margin.footer * PT_TO_PX
  const header = headerKey(section, pageNumber)
  const footer = footerKey(section, pageNumber)
  const headerH = storyHeight(doc, header, section, measure)
  const footerH = storyHeight(doc, footer, section, measure)
  const bodyTop = Math.max(marginTop, headerTop + headerH)
  const bodyBottom = paperHeight - Math.max(marginBottom, footerBottom + footerH)
  return {
    paperWidth,
    paperHeight,
    contentWidth,
    contentLeft,
    bodyTop,
    bodyHeight: Math.max(1, bodyBottom - bodyTop),
    header,
    footer,
    headerTop,
    footerBottom,
  }
}

function contentWidthOf(section: Section): number {
  const margin = section.page.margin
  return Math.max(0, (section.page.widthPt - margin.left - margin.gutter - margin.right) * PT_TO_PX)
}

function sectionIndexes(body: readonly Block[]): number[] {
  const out = new Array<number>(body.length)
  let section = 0
  for (let i = 0; i < body.length; i++) {
    out[i] = section
    const block = body[i]
    if (block?.kind === 'p' && block.sectionEnd !== null) section = block.sectionEnd + 1
  }
  return out
}

function samePaper(a: Section, b: Section): boolean {
  return (
    a.page.widthPt === b.page.widthPt &&
    a.page.heightPt === b.page.heightPt &&
    a.page.margin.top === b.page.margin.top &&
    a.page.margin.bottom === b.page.margin.bottom &&
    a.page.margin.left === b.page.margin.left &&
    a.page.margin.right === b.page.margin.right
  )
}

interface Placed {
  slice: Slice
  consumed: number
  continueY: number | null
}

function fit(
  block: BlockId,
  y0: number,
  y1: number,
  repeatHeaderRows: number,
  consumed: number,
  continueY: number | null,
): Placed {
  const end = Math.max(y1, y0)
  return {
    slice: { block, y0, y1: end, repeatHeaderRows },
    consumed: Math.max(0, consumed),
    continueY,
  }
}

function placeLines(
  id: BlockId,
  m: Measure,
  y0: number,
  available: number,
  atTop: boolean,
  suppress: boolean,
  pageBody: number,
): Placed | null {
  const bottoms = m.lineBottoms
  const n = bottoms.length
  let start = y0
  if (suppress && start <= EPS && m.spaceBeforePx > 0) start = Math.min(m.spaceBeforePx, Math.max(0, m.heightPx - 0.01))
  if (m.keepLines && !atTop && start <= EPS && m.heightPx - start <= pageBody + EPS && m.heightPx - start > available + EPS) {
    return null
  }
  if (m.heightPx - start <= available + EPS) return fit(id, start, m.heightPx, 0, m.heightPx - start, null)

  let first = 0
  while (first < n && (bottoms[first] ?? 0) <= start + EPS) first += 1
  if (first >= n) {
    if (atTop || m.heightPx - start <= available + EPS) return fit(id, start, m.heightPx, 0, Math.max(0, m.heightPx - start), null)
    return null
  }
  let last = first - 1
  for (let i = first; i < n; i++) {
    if ((bottoms[i] ?? 0) - start <= available + EPS) last = i
    else break
  }
  if (last < first) {
    if (!atTop) return null
    last = first
  }
  const atStart = start <= m.spaceBeforePx + EPS
  let count = last - first + 1
  if (m.widowControl && atStart && count < 2 && n - first >= 2 && !atTop) return null
  const after = n - (last + 1)
  if (m.widowControl && after === 1 && count >= 2) {
    last -= 1
    count -= 1
    if (count < 1) {
      if (!atTop) return null
      last += 1
    }
  }
  const end = bottoms[last] ?? start
  if (last >= n - 1) return fit(id, start, end, 0, Math.max(0, end - start), null)
  if (end <= start + 0.25) return atTop ? fit(id, start, m.heightPx, 0, Math.max(0, m.heightPx - start), null) : null
  return fit(id, start, end, 0, end - start, end)
}

function placeTable(
  id: BlockId,
  m: Measure,
  y0: number,
  available: number,
  atTop: boolean,
  suppress: boolean,
): Placed | null {
  const rows = m.rowBottoms
  if (!rows || rows.length === 0) return null
  const n = rows.length
  const headerRows = Math.min(m.headerRows, n)
  const headerBottom = headerRows > 0 ? (rows[headerRows - 1] ?? 0) : 0
  let start = y0
  if (suppress && start <= EPS && m.spaceBeforePx > 0) start = Math.min(m.spaceBeforePx, Math.max(0, m.heightPx - 0.01))
  const continuation = headerRows > 0 && start >= headerBottom - EPS && start > EPS
  const repeat = continuation ? headerRows : 0
  const repeatH = continuation ? headerBottom : 0
  const whole = repeatH + (m.heightPx - start)
  if (whole <= available + EPS) return fit(id, start, m.heightPx, repeat, whole, null)

  let first = 0
  while (first < n && (rows[first] ?? 0) <= start + EPS) first += 1
  if (first >= n) {
    if (atTop || whole <= available + EPS) return fit(id, start, m.heightPx, repeat, Math.max(0, m.heightPx - start), null)
    return null
  }
  let last = first - 1
  for (let i = first; i < n; i++) {
    const visual = repeatH + ((rows[i] ?? 0) - start)
    if (visual <= available + EPS) last = i
    else break
  }
  if (last < first) {
    if (!atTop) return null
    last = first
  }
  if (headerRows > 0 && last === headerRows - 1 && n > headerRows && first < headerRows) {
    if (!atTop) return null
    last = Math.min(n - 1, headerRows)
  }
  const end = rows[last] ?? start
  const consumed = repeatH + (end - start)
  if (last >= n - 1) {
    if (whole <= available + EPS) return fit(id, start, m.heightPx, repeat, whole, null)
    return fit(id, start, end, repeat, consumed, null)
  }
  if (end <= start + 0.25) return atTop ? fit(id, start, end + 1, repeat, consumed + 1, end + 1) : null
  return fit(id, start, end, repeat, consumed, end)
}

function placeAtomic(id: BlockId, m: Measure, y0: number, available: number, atTop: boolean, suppress: boolean): Placed | null {
  let start = y0
  if (suppress && start <= EPS && m.spaceBeforePx > 0) start = Math.min(m.spaceBeforePx, m.heightPx)
  const consumed = m.heightPx - start
  if (consumed <= available + EPS || atTop) return fit(id, start, m.heightPx, 0, Math.max(0, consumed), null)
  return null
}

function placeBlock(
  id: BlockId,
  m: Measure,
  y0: number,
  available: number,
  atTop: boolean,
  suppress: boolean,
  pageBody: number,
): Placed | null {
  if (m.rowBottoms && m.rowBottoms.length > 0) return placeTable(id, m, y0, available, atTop, suppress)
  if (m.lineBottoms.length > 0) return placeLines(id, m, y0, available, atTop, suppress, pageBody)
  return placeAtomic(id, m, y0, available, atTop, suppress)
}

function chainFit(
  body: readonly Block[],
  sectionOf: readonly number[],
  index: number,
  measure: MeasureFn,
  doc: Doc,
  pageBody: number,
): { here: number; fresh: number } | null {
  let here = 0
  let fresh = 0
  for (let i = index, guard = 0; i < body.length && guard < 40; i++, guard++) {
    if (i > index && (sectionOf[i] ?? 0) !== (sectionOf[index] ?? 0)) break
    const block = body[i]
    const section = doc.sections[sectionOf[i] ?? 0] ?? doc.sections[0]
    if (!block || !section) return null
    const measured = measure(block, section)
    if (!measured) return null
    if (i > index && measured.pageBreakBefore) break
    here += measured.heightPx
    fresh += i === index ? Math.max(0, measured.heightPx - measured.spaceBeforePx) : measured.heightPx
    if (!measured.keepNext || fresh > pageBody) break
  }
  return { here, fresh }
}

class PageBuilder {
  used = 0
  readonly slices: Slice[] = []
  readonly sectionIndex: number
  readonly bodyHeight: number
  readonly bodyTop: number
  readonly header: StoryKey | null
  readonly footer: StoryKey | null
  readonly softTop: boolean

  constructor(
    sectionIndex: number,
    bodyHeight: number,
    bodyTop: number,
    header: StoryKey | null,
    footer: StoryKey | null,
    softTop: boolean,
  ) {
    this.sectionIndex = sectionIndex
    this.bodyHeight = bodyHeight
    this.bodyTop = bodyTop
    this.header = header
    this.footer = footer
    this.softTop = softTop
  }

  remaining(): number {
    return Math.max(0, this.bodyHeight - this.used)
  }

  add(placed: Placed): void {
    this.slices.push(placed.slice)
    this.used += placed.consumed
  }

  toPage(): Page {
    return {
      section: this.sectionIndex,
      slices: this.slices,
      header: this.header,
      footer: this.footer,
      bodyTopPx: this.bodyTop,
    }
  }
}

function openBuilder(doc: Doc, section: Section, sectionIndex: number, pageNumber: number, measure: MeasureFn, softTop: boolean): PageBuilder {
  const frame = pageFrame(doc, section, pageNumber, measure)
  return new PageBuilder(sectionIndex, frame.bodyHeight, frame.bodyTop, frame.header, frame.footer, softTop)
}

function blankPage(doc: Doc, section: Section, sectionIndex: number, pageNumber: number, measure: MeasureFn): Page {
  const frame = pageFrame(doc, section, pageNumber, measure)
  return { section: sectionIndex, slices: [], header: frame.header, footer: frame.footer, bodyTopPx: frame.bodyTop }
}

interface Cursor {
  index: number
  y0: number
}

function pageContaining(layout: Layout, id: BlockId): number {
  for (let i = 0; i < layout.pages.length; i++) {
    if (layout.pages[i]?.slices.some((slice) => slice.block === id)) return i
  }
  return -1
}

function changedAhead(body: readonly Block[], index: number, changed: ReadonlySet<BlockId>): boolean {
  if (changed.size === 0) return false
  for (let i = index; i < body.length; i++) {
    const block = body[i]
    if (block && changed.has(block.id)) return true
  }
  return false
}

function cursorFromPage(previous: Layout, body: readonly Block[], pageIndex: number): { pageIndex: number; cursor: Cursor; soft: boolean } {
  const first = previous.pages[pageIndex]?.slices[0]
  if (first) {
    const idx = body.findIndex((block) => block.id === first.block)
    if (idx >= 0) return { pageIndex, cursor: { index: idx, y0: first.y0 }, soft: false }
  }
  let index = 0
  const prev = pageIndex > 0 ? previous.pages[pageIndex - 1] : undefined
  const last = prev?.slices[prev.slices.length - 1]
  if (last) {
    const idx = body.findIndex((block) => block.id === last.block)
    if (idx >= 0) index = idx + 1
  }
  return { pageIndex, cursor: { index: Math.min(index, body.length), y0: 0 }, soft: true }
}

function restart(previous: Layout, body: readonly Block[], changed: ReadonlySet<BlockId>): { pageIndex: number; cursor: Cursor; soft: boolean } {
  if (changed.size === 0) return cursorFromPage(previous, body, Math.max(0, previous.pages.length - 1))
  let earliest = -1
  for (let i = 0; i < body.length; i++) {
    const block = body[i]
    if (block && changed.has(block.id)) {
      earliest = i
      break
    }
  }
  if (earliest < 0) return cursorFromPage(previous, body, Math.max(0, previous.pages.length - 1))
  let pageIndex = pageContaining(previous, body[earliest]?.id ?? ('' as BlockId))
  if (pageIndex < 0) pageIndex = Math.max(0, previous.pages.length - 1)
  else if (pageIndex > 0) pageIndex -= 1
  return cursorFromPage(previous, body, pageIndex)
}

function tryReuse(
  previous: Layout | null,
  pageIndex: number,
  body: readonly Block[],
  cursor: Cursor,
  changed: ReadonlySet<BlockId>,
  sectionOf: readonly number[],
): readonly Page[] | null {
  if (!previous) return null
  if (!previous.complete && pageIndex >= previous.pages.length - 1) return null
  if (pageIndex >= previous.pages.length) return null
  if (changedAhead(body, cursor.index, changed)) return null
  const prev = previous.pages[pageIndex]
  const first = prev?.slices[0]
  const block = body[cursor.index]
  if (!prev || !first || !block) return null
  if (first.block !== block.id || Math.abs(first.y0 - cursor.y0) > 0.25) return null
  if (prev.section !== (sectionOf[cursor.index] ?? 0)) return null
  return previous.pages.slice(pageIndex)
}

function wantsBlank(breakType: 'evenPage' | 'oddPage', pageNumber: number): boolean {
  const even = pageNumber % 2 === 0
  return breakType === 'evenPage' ? !even : even
}

/**
 * Word's block-level page rules over cached measures: pageBreakBefore, keepNext chains (capped at one page),
 * keepLines, widow and orphan control, section breaks, rows that cannot split, header rows, and space-before
 * suppression at the top of a page after a soft break.
 *
 * Incremental: with `previous` and `changed`, starts at the page holding the first changed block and stops at the first
 * page whose start (block, y0) equals the previous layout's page start at the same index, reusing the rest.
 */
export function paginate(doc: Doc, measure: MeasureFn, previous: Layout | null, changed: readonly BlockId[]): Layout {
  const body = doc.body
  const sectionOf = sectionIndexes(body)
  const changedSet = new Set(changed)
  if (body.length === 0) {
    const section = doc.sections[0]
    if (!section) return { pages: [], complete: true }
    return { pages: [blankPage(doc, section, 0, 1, measure)], complete: true }
  }
  if (previous && changed.length === 0 && previous.complete) return previous

  const pages: Page[] = []
  let cursor: Cursor = { index: 0, y0: 0 }
  let softNext = false
  if (previous && previous.pages.length > 0) {
    const start = restart(previous, body, changedSet)
    for (let i = 0; i < start.pageIndex; i++) {
      const page = previous.pages[i]
      if (page) pages.push(page)
    }
    cursor = start.cursor
    softNext = start.soft
  }

  let pending: PageBuilder | null = null
  let guard = 0
  const maxGuard = body.length * 6 + 8
  while (cursor.index < body.length && guard < maxGuard) {
    guard += 1
    if (!pending) {
      const reused = tryReuse(previous, pages.length, body, cursor, changedSet, sectionOf)
      if (reused) {
        for (const page of reused) pages.push(page)
        return { pages, complete: previous?.complete ?? true }
      }
    }

    const index = cursor.index
    const block = body[index]
    const sectionIndex = sectionOf[index] ?? 0
    const section = doc.sections[sectionIndex] ?? doc.sections[0]
    if (!block || !section) break

    if (cursor.y0 === 0 && index > 0 && sectionIndex !== (sectionOf[index - 1] ?? 0)) {
      const prevSection = doc.sections[sectionOf[index - 1] ?? 0]
      const continuous = section.breakType === 'continuous' && prevSection !== undefined && samePaper(prevSection, section)
      if (!(continuous && pending && pending.slices.length > 0)) {
        if (pending && pending.slices.length > 0) pages.push(pending.toPage())
        pending = null
        softNext = false
        if (section.breakType === 'evenPage' || section.breakType === 'oddPage') {
          const number = pages.length + 1
          if (wantsBlank(section.breakType, number)) pages.push(blankPage(doc, section, sectionIndex, number, measure))
        }
      }
    }

    const measured = measure(block, section)
    if (!measured) {
      if (pending && pending.slices.length > 0) pages.push(pending.toPage())
      return { pages, complete: false }
    }

    if (!pending) {
      pending = openBuilder(doc, section, sectionIndex, pages.length + 1, measure, softNext)
      softNext = false
    }

    if (cursor.y0 === 0 && measured.pageBreakBefore && pending.slices.length > 0) {
      pages.push(pending.toPage())
      pending = openBuilder(doc, section, sectionIndex, pages.length + 1, measure, false)
    }

    const atTop = pending.slices.length === 0
    if (!atTop && cursor.y0 === 0 && measured.keepNext) {
      const chain = chainFit(body, sectionOf, index, measure, doc, pending.bodyHeight)
      if (chain && chain.fresh <= pending.bodyHeight + EPS && chain.here > pending.remaining() + EPS) {
        pages.push(pending.toPage())
        pending = null
        softNext = true
        continue
      }
    }

    const suppress = pending.softTop && atTop && cursor.y0 === 0
    let placed = placeBlock(block.id, measured, cursor.y0, pending.remaining(), atTop, suppress, pending.bodyHeight)
    if (!placed) {
      if (!atTop) {
        pages.push(pending.toPage())
        pending = null
        softNext = true
        continue
      }
      placed = fit(block.id, cursor.y0, measured.heightPx, 0, measured.heightPx, null)
    }
    pending.add(placed)
    if (placed.continueY === null || placed.continueY <= cursor.y0 + 0.25) {
      cursor = { index: index + 1, y0: 0 }
    } else {
      cursor = { index, y0: placed.continueY }
      pages.push(pending.toPage())
      pending = null
      softNext = true
    }
  }

  if (pending && pending.slices.length > 0) pages.push(pending.toPage())
  if (pages.length === 0) {
    const section = doc.sections[0]
    if (section) pages.push(blankPage(doc, section, 0, 1, measure))
  }
  return { pages, complete: cursor.index >= body.length && guard < maxGuard }
}

export interface CaretRect {
  readonly page: number
  readonly x: number
  readonly top: number
  readonly height: number
}

interface Place {
  para: Paragraph
  owner: Block
  row: number
  order: number
}

interface LineBox {
  page: number
  left: number
  right: number
  top: number
  bottom: number
  globalMid: number
  paraId: string
}

function containsId(block: Block, id: string): boolean {
  if (block.id === id) return true
  if (block.kind === 'p') return false
  if (block.kind === 'opaque') return block.preview.some((para) => para.id === id)
  for (const row of block.rows) {
    for (const cell of row.cells) {
      for (const child of cell.blocks) {
        if (containsId(child, id)) return true
      }
    }
  }
  return false
}

function assignStyle(el: HTMLElement, prop: 'width' | 'height' | 'top' | 'left', value: string): void {
  if (el.style[prop] !== value) el.style[prop] = value
}

function caretFromPoint(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (px: number, py: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (px: number, py: number) => Range | null
  }
  const pos = doc.caretPositionFromPoint?.(x, y)
  if (pos) return { node: pos.offsetNode, offset: pos.offset }
  const range = doc.caretRangeFromPoint?.(x, y)
  if (!range) return null
  return { node: range.startContainer, offset: range.startOffset }
}

function diffIds(prev: readonly Block[], next: readonly Block[]): BlockId[] {
  const ids: BlockId[] = []
  const limit = Math.max(prev.length, next.length)
  for (let i = 0; i < limit; i++) {
    if (prev[i] !== next[i]) {
      const block = next[i] ?? (i > 0 ? next[i - 1] : undefined)
      if (block && !ids.includes(block.id)) ids.push(block.id)
    }
  }
  return ids
}

function extractHeader(blockEl: HTMLElement, rows: number): HTMLTableElement | null {
  const source = blockEl.querySelector(':scope > table')
  if (!(source instanceof HTMLTableElement)) return null
  const copy = document.createElement('table')
  copy.className = 'repeat-head'
  copy.style.width = source.style.width
  const cols = source.querySelector('colgroup')
  if (cols) copy.append(cols.cloneNode(true))
  const body = document.createElement('tbody')
  for (let i = 0; i < rows && i < source.rows.length; i++) {
    const row = source.rows[i]
    if (row) body.append(row.cloneNode(true))
  }
  copy.append(body)
  return copy
}

function caretClientTop(el: HTMLElement, offset: number): number {
  const point = domPoint(el, offset)
  const range = document.createRange()
  range.setStart(point.node, point.offset)
  range.collapse(true)
  const rect = range.getClientRects()[0]
  return rect ? rect.top : el.getBoundingClientRect().bottom
}

function startsFromElement(el: HTMLElement, bottoms: Float32Array, length: number): Uint32Array {
  const starts = new Uint32Array(bottoms.length)
  const origin = el.getBoundingClientRect().top
  let prev = 0
  for (let line = 1; line < bottoms.length; line++) {
    const target = origin + (bottoms[line - 1] ?? 0)
    let lo = prev
    let hi = length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (caretClientTop(el, mid) < target - 0.75) lo = mid + 1
      else hi = mid
    }
    starts[line] = lo
    prev = lo
  }
  return starts
}

/**
 * Owns the pages container. Mounts the visible pages plus one on each side (IntersectionObserver); every other page
 * is an empty box of its exact size, so scroll geometry is exact without contents. All coordinates it returns are
 * page-container px at 100 percent zoom; zoom is a transform on the container, and this class divides it out.
 */
export class PageView {
  private doc: Doc | null = null
  private ctx: () => RenderContext
  private host: HTMLElement
  private sizer: HTMLElement | null = null
  private stack: HTMLElement | null = null
  private measureHost: HTMLElement | null = null
  private observer: IntersectionObserver | null = null
  private pageEls: HTMLElement[] = []
  private measures = new WeakMap<Block, Measure>()
  private lineStartCache = new WeakMap<Block, Uint32Array>()
  private _layout: Layout = { pages: [], complete: false }
  private zoom = 1
  private cursor = 0
  private chunk = 0
  private dead = false
  private intersecting = new Set<number>()
  private mountedSig = new Map<number, string>()
  private syncQueued = false
  private watch = 0
  private seenScroll = -1
  private seenHeight = -1
  private indexMap: Map<string, Place> | null = null
  private indexDoc: Doc | null = null
  private changedIds: Set<BlockId> | null = null
  private deco: Decoration | null = null
  private decoMeasure: Measure | null = null
  private decoOwner: Block | null = null
  private sink: HTMLTextAreaElement | null = null
  private lastPaint: { sel: Selection; sink: HTMLTextAreaElement } | null = null

  constructor(host: HTMLElement, ctx: () => RenderContext) {
    this.host = host
    this.ctx = ctx
  }

  get layout(): Layout {
    return this._layout
  }

  /** Full rebuild: measure every block in chunks of about 200 per task, mount pages as they fill. */
  show(doc: Doc): void {
    this.cancelChunk()
    this.doc = doc
    this.measures = new WeakMap()
    this.lineStartCache = new WeakMap()
    this.indexDoc = null
    this.indexMap = null
    this.deco = null
    this.decoMeasure = null
    this.decoOwner = null
    this._layout = { pages: [], complete: false }
    this.cursor = 0
    this.dead = false
    this.ensureChrome()
    this.resetPages()
    this.measureStories()
    this.pump()
  }

  /**
   * After a transaction. Finds changed blocks by identity, re-renders their mounted copies, re-measures them,
   * repaginates incrementally, and moves slices between mounted pages. Unmounted pages only get new slice lists.
   */
  update(previous: Doc, next: Doc): void {
    this.cancelChunk()
    const changed = diffIds(previous.body, next.body)
    this.doc = next
    this.indexDoc = null
    this.indexMap = null
    this.deco = null
    this.decoMeasure = null
    this.decoOwner = null
    for (const id of changed) {
      const located = this.locateOwner(id)
      if (located) this.measureOne(located.block, located.section)
    }
    this._layout = paginate(next, (block) => this.measures.get(block), this._layout, changed)
    this.changedIds = new Set(changed)
    this.syncPages()
    this.changedIds = null
    if (this.lastPaint) this.paintNow(this.lastPaint.sel, this.lastPaint.sink)
  }

  /** IME preedit. Re-renders and re-measures one block without touching the measure cache. */
  decorate(deco: Decoration | null): void {
    if (!this.doc) return
    const previousId = this.deco?.pos.p
    this.deco = deco
    const id = deco?.pos.p ?? previousId
    if (!id) return
    const located = this.locateOwner(id)
    if (!located) return
    if (deco) {
      const el = renderBlock(located.block, this.ctxFor(1), deco)
      el.style.width = `${contentWidthOf(located.section)}px`
      this.measureHost?.replaceChildren(el)
      this.decoMeasure = measureElement(el, 1)
      this.decoOwner = located.block
      this.measureHost?.replaceChildren()
    } else {
      this.decoMeasure = null
      this.decoOwner = null
    }
    this._layout = paginate(this.doc, (block) => this.measureFor(block), this._layout, [located.block.id])
    this.changedIds = new Set([located.block.id])
    this.syncPages()
    this.changedIds = null
    if (this.lastPaint) this.paintNow(this.lastPaint.sel, this.lastPaint.sink)
  }

  caretRect(pos: Pos): CaretRect {
    const pageCount = this._layout.pages.length
    const pageIndex = pageCount === 0 ? 0 : Math.min(this.pageOf(pos), pageCount - 1)
    this.mountPage(pageIndex)
    const pageEl = this.pageEls[pageIndex]
    if (!pageEl) return { page: pageIndex, x: 0, top: 0, height: 16 }
    const paraEl = this.paraElement(pageEl, pos)
    const origin = pageEl.getBoundingClientRect()
    const z = this.zoom
    if (!paraEl) return { page: pageIndex, x: 0, top: 0, height: 16 }
    const range = rangeIn(paraEl, pos.o, pos.o)
    const slice = paraEl.closest('.slice')
    const sliceRect = slice instanceof HTMLElement ? slice.getBoundingClientRect() : null
    const rects = [...range.getClientRects()].filter((rect) => rect.height > 0)
    const rect =
      rects.find((item) => !sliceRect || (item.bottom > sliceRect.top + 0.5 && item.top < sliceRect.bottom - 0.5)) ??
      rects[0]
    if (!rect) {
      const box = paraEl.getBoundingClientRect()
      return { page: pageIndex, x: (box.left - origin.left) / z, top: (box.top - origin.top) / z, height: 16 }
    }
    return {
      page: pageIndex,
      x: (rect.left - origin.left) / z,
      top: (rect.top - origin.top) / z,
      height: Math.max(rect.height / z, 1),
    }
  }

  /**
   * Click and drag. Clamps (x, y) into the nearest slice's visible box on that page, then calls
   * document.caretPositionFromPoint and maps the DOM point with render.posFromDom.
   */
  posAtPoint(clientX: number, clientY: number): Pos | null {
    return this.withHits(() => {
      const pageIndex = this.pageIndexAt(clientX, clientY)
      if (pageIndex < 0) return null
      this.mountPage(pageIndex)
      const pageEl = this.pageEls[pageIndex]
      if (!pageEl) return null
      const slices = [...pageEl.querySelectorAll<HTMLElement>('.slice')]
      if (slices.length === 0) return null
      let best: { rect: DOMRect; dist: number } | null = null
      for (const slice of slices) {
        const rect = slice.getBoundingClientRect()
        const dx = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0
        const dy = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0
        const dist = dx * dx + dy * dy
        if (!best || dist < best.dist) best = { rect, dist }
      }
      if (!best) return null
      let x = clientX
      let y = clientY
      if (best.dist > 0) {
        x = Math.min(Math.max(clientX, best.rect.left + 1), Math.max(best.rect.left + 1, best.rect.right - 1))
        y = Math.min(Math.max(clientY, best.rect.top + 1), Math.max(best.rect.top + 1, best.rect.bottom - 1))
      }
      const hit = caretFromPoint(x, y) ?? caretFromPoint(x, y + 1) ?? caretFromPoint(x + 0.5, y)
      if (!hit) return null
      const pos = posFromDom(hit.node, hit.offset)
      if (!pos) return null
      return this.adjustAtom(hit.node, pos, x)
    })
  }

  /**
   * Up and Down. Finds the next line box below or above the caret's (crossing slices and pages), then hit-tests at
   * goalX on that line's middle. Returns the goal to keep for the next vertical move.
   */
  lineMove(pos: Pos, direction: 'up' | 'down', goalX: number | null): { pos: Pos; goalX: number } {
    const caret = this.caretRect(pos)
    const goal = goalX ?? caret.x
    const neighbor = direction === 'down' ? caret.page + 1 : caret.page - 1
    this.mountPage(caret.page)
    if (neighbor >= 0 && neighbor < this._layout.pages.length) this.mountPage(neighbor)
    const lines = this.collectLines(neighbor >= 0 && neighbor < this._layout.pages.length ? [caret.page, neighbor] : [caret.page])
    const current = this.pickCurrent(lines, caret.page, caret.x, caret.top + caret.height / 2)
    if (!current) return { pos, goalX: goal }
    const next = this.pickNext(lines, current, direction, goal)
    if (!next) return { pos, goalX: goal }
    return { pos: this.posOnLine(next, goal) ?? pos, goalX: goal }
  }

  /** PageUp and PageDown: scrolls one viewport and hit-tests at the same viewport offset and goalX. */
  pageMove(pos: Pos, direction: 'up' | 'down', goalX: number | null): { pos: Pos; goalX: number } {
    const caret = this.caretRect(pos)
    const goal = goalX ?? caret.x
    const pageEl = this.pageEls[caret.page]
    if (!pageEl) return { pos, goalX: goal }
    const host = this.host.getBoundingClientRect()
    const origin = pageEl.getBoundingClientRect()
    const offset = origin.top + (caret.top + caret.height / 2) * this.zoom - host.top
    const clientX = origin.left + goal * this.zoom
    this.host.scrollTop += this.host.clientHeight * (direction === 'down' ? 1 : -1)
    const y = this.host.getBoundingClientRect().top + offset
    const pageIndex = this.pageIndexAt(clientX, y)
    if (pageIndex >= 0) this.mountPage(pageIndex)
    return { pos: this.posAtPoint(clientX, y) ?? pos, goalX: goal }
  }

  /** Home and End: the first or last offset on the caret's visual line. */
  lineEdge(pos: Pos, edge: 'start' | 'end'): Pos {
    const caret = this.caretRect(pos)
    const line = this.pickCurrent(this.collectLines([caret.page]), caret.page, caret.x, caret.top + caret.height / 2)
    if (!line) return pos
    const place = this.index().get(line.paraId)
    if (!place) return pos
    const length = flatText(place.para).length
    const mid = (line.top + line.bottom) / 2
    const probe = this.posAtLocal(line.page, edge === 'start' ? line.left + 1 : Math.max(line.left + 1, line.right - 1), mid)
    if (!probe || probe.p !== place.para.id) return pos
    const on = (offset: number): boolean => {
      const next = this.caretRect({ p: place.para.id, o: offset })
      const y = next.top + next.height / 2
      return next.page === line.page && y >= line.top - 3 && y <= line.bottom + 3
    }
    let o = probe.o
    let steps = 0
    if (edge === 'start') {
      while (o > 0 && steps < 200 && on(o - 1)) {
        o -= 1
        steps += 1
      }
    } else {
      while (o < length && steps < 200 && on(o + 1)) {
        o += 1
        steps += 1
      }
    }
    return { p: place.para.id, o }
  }

  /** Draws the caret div and selection rects in per-page overlays, clipped to slice boxes. Moves the input sink. */
  paint(sel: Selection, sink: HTMLTextAreaElement): void {
    this.sink = sink
    this.lastPaint = { sel, sink }
    this.paintNow(sel, sink)
  }

  scrollIntoView(pos: Pos): void {
    const caret = this.caretRect(pos)
    const pageEl = this.pageEls[caret.page]
    if (!pageEl) return
    const origin = pageEl.getBoundingClientRect()
    const host = this.host.getBoundingClientRect()
    const top = origin.top + caret.top * this.zoom
    const bottom = top + caret.height * this.zoom
    if (top < host.top) this.host.scrollTop -= host.top - top + 8
    else if (bottom > host.bottom) this.host.scrollTop += bottom - host.bottom + 8
  }

  /** Changes the container transform only. Measures and pagination stay valid. */
  setZoom(zoom: number): void {
    if (!(zoom > 0)) return
    this.zoom = zoom
    this.updateSizer()
    this.syncFromGeometry()
  }

  /** Page index (0-based) holding a position, from the layout, without touching the DOM. */
  pageOf(pos: Pos): number {
    const place = this.index().get(pos.p)
    if (!place) return 0
    const spots = this.spots(place.owner.id)
    const first = spots[0]
    if (!first) return 0
    if (spots.length === 1) return first.page
    let y = 0
    if (place.owner.kind === 'table') y = this.rowMiddle(place.owner, place.row)
    else if (place.owner.kind === 'p') y = this.yForOffset(place.owner, pos.o)
    const hit = spots.find((spot) => y >= spot.slice.y0 - 0.5 && y < spot.slice.y1 - 0.01)
    return hit?.page ?? spots[spots.length - 1]?.page ?? 0
  }

  destroy(): void {
    this.dead = true
    this.cancelChunk()
    this.observer?.disconnect()
    this.observer = null
    if (this.watch !== 0) cancelAnimationFrame(this.watch)
    this.watch = 0
    this.pageEls = []
    this.mountedSig.clear()
    this.intersecting.clear()
    this.host.replaceChildren()
    this.host.classList.remove('page-view')
    this.doc = null
  }

  private measureFor(block: Block): Measure | undefined {
    if (this.decoOwner === block && this.decoMeasure) return this.decoMeasure
    return this.measures.get(block)
  }

  private pump(): void {
    if (this.dead || !this.doc) return
    const body = this.doc.body
    const end = Math.min(body.length, this.cursor + 200)
    const sections = sectionIndexes(body)
    const batch: { block: Block; section: Section }[] = []
    for (let i = this.cursor; i < end; i++) {
      const block = body[i]
      const section = this.doc.sections[sections[i] ?? 0] ?? this.doc.sections[0]
      if (block && section) batch.push({ block, section })
    }
    this.measureBatch(batch)
    const changed = batch.map((item) => item.block.id)
    const previous = this._layout.pages.length > 0 ? this._layout : null
    this._layout = paginate(this.doc, (block) => this.measures.get(block), previous, previous ? changed : [])
    this.cursor = end
    this.syncPages()
    if (this.cursor < body.length) this.chunk = requestAnimationFrame(() => this.pump())
  }

  private measureStories(): void {
    if (!this.doc) return
    const section = this.doc.sections[0]
    if (!section) return
    const batch: { block: Block; section: Section }[] = []
    for (const blocks of this.doc.stories.values()) {
      for (const block of blocks) batch.push({ block, section })
    }
    this.measureBatch(batch)
  }

  private measureBatch(items: readonly { block: Block; section: Section }[]): void {
    const host = this.measureHost
    if (!host) return
    const pending: { block: Block; el: HTMLElement }[] = []
    const frag = document.createDocumentFragment()
    for (const item of items) {
      if (this.measures.has(item.block)) continue
      const el = renderBlock(item.block, this.ctxFor(1))
      el.style.width = `${contentWidthOf(item.section)}px`
      frag.append(el)
      pending.push({ block: item.block, el })
    }
    if (pending.length === 0) return
    host.append(frag)
    for (const item of pending) this.measures.set(item.block, measureElement(item.el, 1))
    host.replaceChildren()
  }

  private measureOne(block: Block, section: Section): void {
    this.measureBatch([{ block, section }])
  }

  private ensureChrome(): void {
    if (this.stack?.isConnected) return
    this.host.classList.add('page-view')
    const sizer = document.createElement('div')
    sizer.className = 'page-sizer'
    const stack = document.createElement('div')
    stack.className = 'page-stack'
    const measureHost = document.createElement('div')
    measureHost.className = 'measure-host'
    sizer.append(stack)
    this.host.replaceChildren(sizer, measureHost)
    this.sizer = sizer
    this.stack = stack
    this.measureHost = measureHost
    this.observer = new IntersectionObserver((entries) => this.onIntersect(entries), { root: this.host })
    this.startWatch()
  }

  private resetPages(): void {
    this.observer?.disconnect()
    this.pageEls = []
    this.mountedSig.clear()
    this.intersecting.clear()
    this.stack?.replaceChildren()
    this.observer = new IntersectionObserver((entries) => this.onIntersect(entries), { root: this.host })
  }

  private cancelChunk(): void {
    if (this.chunk !== 0) cancelAnimationFrame(this.chunk)
    this.chunk = 0
  }

  private startWatch(): void {
    if (this.watch !== 0) return
    const tick = (): void => {
      if (this.dead) return
      const top = this.host.scrollTop
      const height = this.host.clientHeight
      if (top !== this.seenScroll || height !== this.seenHeight) {
        this.seenScroll = top
        this.seenHeight = height
        this.syncFromGeometry()
      }
      this.watch = requestAnimationFrame(tick)
    }
    this.watch = requestAnimationFrame(tick)
  }

  private onIntersect(_entries: IntersectionObserverEntry[]): void {
    // acdert reports the first observation, then nothing when the scroll root moves. startWatch covers that.
    if (this.syncQueued) return
    this.syncQueued = true
    requestAnimationFrame(() => {
      this.syncQueued = false
      if (!this.dead) this.syncFromGeometry()
    })
  }

  private syncFromGeometry(): void {
    const host = this.host.getBoundingClientRect()
    const n = this.pageEls.length
    const next = new Set<number>()
    let lo = 0
    let hi = n - 1
    let first = n
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const el = this.pageEls[mid]
      if (!el) break
      if (el.getBoundingClientRect().bottom <= host.top + 0.5) lo = mid + 1
      else {
        first = mid
        hi = mid - 1
      }
    }
    for (let i = first; i < n; i++) {
      const el = this.pageEls[i]
      if (!el) continue
      const rect = el.getBoundingClientRect()
      if (rect.top >= host.bottom - 0.5) break
      if (rect.bottom > host.top && rect.right > host.left && rect.left < host.right) next.add(i)
    }
    this.intersecting = next
    this.applyWindow()
  }

  private syncPages(): void {
    this.ensureShells()
    this.updateSizer()
    this.syncFromGeometry()
  }

  private ensureShells(): void {
    const stack = this.stack
    const pages = this._layout.pages
    if (!stack || !this.doc) return
    while (this.pageEls.length > pages.length) {
      const el = this.pageEls.pop()
      if (!el) continue
      this.observer?.unobserve(el)
      this.intersecting.delete(Number(el.dataset.page))
      this.mountedSig.delete(Number(el.dataset.page))
      el.remove()
    }
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i]
      if (!page) continue
      let el = this.pageEls[i]
      if (!el) {
        el = document.createElement('div')
        el.className = 'page'
        el.dataset.page = String(i)
        el.dataset.mounted = '0'
        const header = document.createElement('div')
        header.className = 'page-header'
        const body = document.createElement('div')
        body.className = 'page-body'
        const footer = document.createElement('div')
        footer.className = 'page-footer'
        const overlay = document.createElement('div')
        overlay.className = 'overlay'
        const num = document.createElement('div')
        num.className = 'page-num'
        el.append(header, body, footer, overlay, num)
        stack.append(el)
        this.pageEls.push(el)
        this.observer?.observe(el)
      }
      const section = this.doc.sections[page.section] ?? this.doc.sections[0]
      if (!section) continue
      const box = pageBoxStyle(section)
      assignStyle(el, 'width', box.page.width ?? '')
      assignStyle(el, 'height', box.page.height ?? '')
      const label = el.querySelector('.page-num')
      const number = String(i + 1)
      if (label && label.textContent !== number) label.textContent = number
      const frame = pageFrame(this.doc, section, i + 1, (block) => this.measures.get(block))
      const body = el.querySelector('.page-body')
      if (body instanceof HTMLElement) {
        assignStyle(body, 'top', `${page.bodyTopPx}px`)
        assignStyle(body, 'left', `${frame.contentLeft}px`)
        assignStyle(body, 'width', `${frame.contentWidth}px`)
        assignStyle(body, 'height', `${frame.bodyHeight}px`)
      }
    }
  }

  private applyWindow(): void {
    const n = this._layout.pages.length
    if (n === 0) return
    let from = 0
    let to = Math.min(1, n - 1)
    if (this.intersecting.size === 0 && this.mountedSig.size > 0) return
    if (this.intersecting.size > 0) {
      let min = n
      let max = -1
      for (const index of this.intersecting) {
        if (index < 0 || index >= n) continue
        if (index < min) min = index
        if (index > max) max = index
      }
      if (max >= 0) {
        from = Math.max(0, min - 1)
        to = Math.min(n - 1, max + 1)
      }
    }
    for (let i = 0; i < this.pageEls.length; i++) {
      if (i >= from && i <= to) {
        if (this.mountedSig.has(i)) this.refreshPage(i)
        else this.fillPage(i)
      } else if (this.mountedSig.has(i)) this.clearPage(i)
    }
  }

  private updateSizer(): void {
    const sizer = this.sizer
    const stack = this.stack
    if (!sizer || !stack) return
    const width = Math.max(1, this.maxPaper())
    const height = this.stackHeight()
    assignStyle(sizer, 'width', `${width * this.zoom}px`)
    assignStyle(sizer, 'height', `${height * this.zoom}px`)
    assignStyle(stack, 'width', `${width}px`)
    const transform = this.zoom === 1 ? '' : `scale(${this.zoom})`
    if (stack.style.transform !== transform) stack.style.transform = transform
  }

  private stackHeight(): number {
    let height = STACK_PAD
    for (let i = 0; i < this._layout.pages.length; i++) height += this.paperPx(i) + PAGE_GAP
    return height
  }

  private paperPx(i: number): number {
    const page = this._layout.pages[i]
    const section = page && this.doc ? (this.doc.sections[page.section] ?? this.doc.sections[0]) : undefined
    return section ? section.page.heightPt * PT_TO_PX : 0
  }

  private maxPaper(): number {
    let width = 0
    if (!this.doc) return 0
    for (const page of this._layout.pages) {
      const section = this.doc.sections[page.section] ?? this.doc.sections[0]
      if (section) width = Math.max(width, section.page.widthPt * PT_TO_PX)
    }
    return width
  }

  private pageOffsets(): number[] {
    const offsets: number[] = []
    let y = STACK_PAD
    for (let i = 0; i < this._layout.pages.length; i++) {
      offsets.push(y)
      y += this.paperPx(i) + PAGE_GAP
    }
    return offsets
  }

  private signature(page: Page): string {
    let text = `${page.section}:${page.bodyTopPx}:`
    for (const slice of page.slices) text += `${slice.block}@${slice.y0},${slice.y1},${slice.repeatHeaderRows};`
    return text
  }

  private mountPage(i: number): void {
    if (i < 0 || i >= this._layout.pages.length) return
    this.ensureShells()
    if (this.mountedSig.has(i)) this.refreshPage(i)
    else this.fillPage(i)
  }

  private fillPage(i: number): void {
    const page = this._layout.pages[i]
    const el = this.pageEls[i]
    const doc = this.doc
    if (!page || !el || !doc) return
    const section = doc.sections[page.section] ?? doc.sections[0]
    if (!section) return
    const frame = pageFrame(doc, section, i + 1, (block) => this.measures.get(block))
    this.fillStory(el.querySelector('.page-header'), frame.header, frame, 'header', i)
    this.fillStory(el.querySelector('.page-footer'), frame.footer, frame, 'footer', i)
    const body = el.querySelector('.page-body')
    if (!(body instanceof HTMLElement)) return
    body.replaceChildren()
    const ctx = this.ctxFor(i + 1)
    for (const slice of page.slices) {
      const located = this.locateOwner(slice.block)
      if (!located) continue
      const measured = this.measures.get(located.block)
      const blockEl = renderBlock(located.block, ctx, this.decoFor(located.block))
      const headerH =
        slice.repeatHeaderRows > 0 && measured?.rowBottoms ? (measured.rowBottoms[slice.repeatHeaderRows - 1] ?? 0) : 0
      const wrap = document.createElement('div')
      wrap.className = 'slice'
      wrap.dataset.block = slice.block
      wrap.dataset.y0 = String(slice.y0)
      wrap.dataset.y1 = String(slice.y1)
      wrap.style.height = `${headerH + (slice.y1 - slice.y0)}px`
      if (slice.repeatHeaderRows > 0 && located.block.kind === 'table') {
        const head = extractHeader(blockEl, slice.repeatHeaderRows)
        if (head) wrap.append(head)
      }
      const clip = document.createElement('div')
      clip.className = 'clip'
      clip.style.height = `${slice.y1 - slice.y0}px`
      const shift = document.createElement('div')
      shift.className = 'shift'
      shift.style.transform = `translateY(${-slice.y0}px)`
      shift.append(blockEl)
      clip.append(shift)
      wrap.append(clip)
      body.append(wrap)
    }
    el.dataset.mounted = '1'
    this.mountedSig.set(i, this.signature(page))
  }

  private fillStory(
    host: Element | null,
    key: StoryKey | null,
    frame: Frame,
    edge: 'header' | 'footer',
    pageIndex: number,
  ): void {
    if (!(host instanceof HTMLElement) || !this.doc) return
    host.replaceChildren()
    if (!key) return
    const blocks = this.doc.stories.get(key)
    if (!blocks) return
    host.style.left = `${frame.contentLeft}px`
    host.style.width = `${frame.contentWidth}px`
    if (edge === 'header') host.style.top = `${frame.headerTop}px`
    else host.style.bottom = `${frame.footerBottom}px`
    const ctx = this.ctxFor(pageIndex + 1)
    for (const block of blocks) host.append(renderBlock(block, ctx))
  }

  private refreshPage(i: number): void {
    const page = this._layout.pages[i]
    const el = this.pageEls[i]
    if (!page || !el) return
    const next = this.signature(page)
    if (this.mountedSig.get(i) !== next) {
      this.fillPage(i)
      return
    }
    if (!this.changedIds) return
    let touches = false
    for (const slice of page.slices) {
      if (this.changedIds.has(slice.block)) touches = true
    }
    if (!touches) return
    const ctx = this.ctxFor(i + 1)
    for (const id of this.changedIds) {
      const located = this.locateOwner(id)
      if (!located) continue
      for (const node of blockElements(el, id)) {
        if (node.closest('.repeat-head')) continue
        node.replaceWith(renderBlock(located.block, ctx, this.decoFor(located.block)))
      }
    }
  }

  private clearPage(i: number): void {
    const el = this.pageEls[i]
    if (!el) return
    el.querySelector('.page-body')?.replaceChildren()
    el.querySelector('.page-header')?.replaceChildren()
    el.querySelector('.page-footer')?.replaceChildren()
    el.querySelector('.overlay')?.replaceChildren()
    delete el.dataset.mounted
    el.dataset.mounted = '0'
    this.mountedSig.delete(i)
  }

  private ctxFor(pageNumber: number): RenderContext {
    const base = this.ctx()
    return { ...base, pageField: { page: pageNumber, pages: Math.max(this._layout.pages.length, pageNumber) } }
  }

  private decoFor(block: Block): Decoration | undefined {
    if (!this.deco) return undefined
    return containsId(block, this.deco.pos.p) ? this.deco : undefined
  }

  private index(): Map<string, Place> {
    if (this.indexDoc === this.doc && this.indexMap) return this.indexMap
    const map = new Map<string, Place>()
    let order = 0
    const walk = (block: Block, owner: Block, row: number): void => {
      if (block.kind === 'p') {
        map.set(block.id, { para: block, owner, row, order })
        order += 1
        return
      }
      if (block.kind === 'table') {
        block.rows.forEach((tableRow, rowIndex) => {
          for (const cell of tableRow.cells) {
            for (const child of cell.blocks) walk(child, block, rowIndex)
          }
        })
        return
      }
      for (const para of block.preview) walk(para, block, 0)
    }
    if (this.doc) {
      for (const block of this.doc.body) walk(block, block, 0)
      for (const blocks of this.doc.stories.values()) {
        for (const block of blocks) walk(block, block, 0)
      }
    }
    this.indexMap = map
    this.indexDoc = this.doc
    return map
  }

  private locateOwner(id: string): { block: Block; section: Section } | null {
    if (!this.doc) return null
    const sections = sectionIndexes(this.doc.body)
    for (let i = 0; i < this.doc.body.length; i++) {
      const block = this.doc.body[i]
      if (!block || !containsId(block, id)) continue
      const section = this.doc.sections[sections[i] ?? 0] ?? this.doc.sections[0]
      if (!section) return null
      return { block, section }
    }
    const section = this.doc.sections[0]
    if (!section) return null
    for (const blocks of this.doc.stories.values()) {
      for (const block of blocks) {
        if (containsId(block, id)) return { block, section }
      }
    }
    return null
  }

  private spots(id: BlockId): { page: number; slice: Slice }[] {
    const out: { page: number; slice: Slice }[] = []
    this._layout.pages.forEach((page, pageIndex) => {
      for (const slice of page.slices) {
        if (slice.block === id) out.push({ page: pageIndex, slice })
      }
    })
    return out
  }

  private rowMiddle(table: Table, row: number): number {
    const bottoms = this.measures.get(table)?.rowBottoms
    if (!bottoms || bottoms.length === 0) return 0
    const top = row <= 0 ? 0 : (bottoms[row - 1] ?? 0)
    const bottom = bottoms[row] ?? top
    return (top + bottom) / 2
  }

  private yForOffset(para: Paragraph, offset: number): number {
    const measured = this.measures.get(para)
    if (!measured || measured.lineBottoms.length === 0) return 0
    const starts = this.lineStarts(para)
    let line = 0
    if (starts) {
      for (let i = 0; i < starts.length; i++) {
        if ((starts[i] ?? 0) <= offset) line = i
      }
    }
    const bottom = measured.lineBottoms[line] ?? measured.heightPx
    const prev = line === 0 ? 0 : (measured.lineBottoms[line - 1] ?? 0)
    return (prev + bottom) / 2
  }

  private lineStarts(para: Paragraph): Uint32Array | null {
    const cached = this.lineStartCache.get(para)
    if (cached) return cached
    const measured = this.measures.get(para)
    const located = this.locateOwner(para.id)
    const host = this.measureHost
    if (!measured || measured.lineBottoms.length === 0 || !located || !host) return null
    const el = renderBlock(para, this.ctxFor(1))
    el.style.width = `${contentWidthOf(located.section)}px`
    host.replaceChildren(el)
    const starts = startsFromElement(el, measured.lineBottoms, flatText(para).length)
    this.lineStartCache.set(para, starts)
    host.replaceChildren()
    return starts
  }

  private paraElement(pageEl: HTMLElement, pos: Pos): HTMLElement | null {
    const all = blockElements(pageEl, pos.p).filter((el) => el.classList.contains('p') && !el.closest('.repeat-head'))
    const only = all[0]
    if (!only) return null
    if (all.length === 1) return only
    const place = this.index().get(pos.p)
    let y = 0
    if (place?.owner.kind === 'p') y = this.yForOffset(place.owner, pos.o)
    else if (place?.owner.kind === 'table') y = this.rowMiddle(place.owner, place.row)
    for (const el of all) {
      const slice = el.closest('.slice')
      if (!(slice instanceof HTMLElement)) continue
      const y0 = Number(slice.dataset.y0)
      const y1 = Number(slice.dataset.y1)
      if (y >= y0 - 0.5 && y < y1 + 0.5) return el
    }
    return only
  }

  private pageIndexAt(clientX: number, clientY: number): number {
    let best = -1
    let bestDist = Infinity
    for (let i = 0; i < this.pageEls.length; i++) {
      const el = this.pageEls[i]
      if (!el) continue
      const rect = el.getBoundingClientRect()
      const dx = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0
      const dy = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0
      const dist = dx * dx + dy * dy
      if (dist < bestDist) {
        bestDist = dist
        best = i
      }
    }
    return best
  }

  private adjustAtom(node: Node, pos: Pos, clientX: number): Pos {
    const el = node instanceof Element ? node : node.parentElement
    const atom = el?.closest('.atom')
    if (!(atom instanceof HTMLElement)) return pos
    const base = Number(atom.dataset.o)
    if (!Number.isFinite(base)) return pos
    const rect = atom.getBoundingClientRect()
    return { p: pos.p, o: clientX > (rect.left + rect.right) / 2 ? base + 1 : base }
  }

  private withHits<T>(fn: () => T): T {
    const hidden: HTMLElement[] = []
    const hide = (el: Element | null | undefined): void => {
      if (el instanceof HTMLElement && el.style.visibility !== 'hidden') {
        el.style.visibility = 'hidden'
        hidden.push(el)
      }
    }
    if (this.sink || this.lastPaint) {
      hide(this.sink)
      for (const page of this.pageEls) hide(page.querySelector('.overlay'))
    }
    try {
      return fn()
    } finally {
      for (const el of hidden) el.style.visibility = ''
    }
  }

  private posAtLocal(pageIndex: number, x: number, y: number): Pos | null {
    const pageEl = this.pageEls[pageIndex]
    if (!pageEl) return null
    const origin = pageEl.getBoundingClientRect()
    return this.posAtPoint(origin.left + x * this.zoom, origin.top + y * this.zoom)
  }

  private collectLines(indexes: readonly number[]): LineBox[] {
    const offsets = this.pageOffsets()
    const lines: LineBox[] = []
    const z = this.zoom
    for (const pageIndex of indexes) {
      const pageEl = this.pageEls[pageIndex]
      if (!pageEl || pageEl.dataset.mounted !== '1') continue
      const origin = pageEl.getBoundingClientRect()
      const base = offsets[pageIndex] ?? 0
      for (const para of pageEl.querySelectorAll<HTMLElement>('.blk.p')) {
        if (para.closest('.repeat-head')) continue
        const id = para.dataset.id
        if (!id) continue
        const clip = para.closest('.clip') ?? para.closest('.slice')
        const clipRect = clip instanceof HTMLElement ? clip.getBoundingClientRect() : null
        const rects: DOMRect[] = []
        for (const child of para.children) {
          if (!(child instanceof HTMLElement) || child.classList.contains('marker')) continue
          const range = document.createRange()
          range.selectNodeContents(child)
          rects.push(...range.getClientRects())
        }
        for (const line of groupLineRects(rects)) {
          const visTop = clipRect ? Math.max(line.top, clipRect.top) : line.top
          const visBottom = clipRect ? Math.min(line.bottom, clipRect.bottom) : line.bottom
          if (visBottom - visTop < 8) continue
          const top = (visTop - origin.top) / z
          const bottom = (visBottom - origin.top) / z
          lines.push({
            page: pageIndex,
            left: (line.left - origin.left) / z,
            right: (line.right - origin.left) / z,
            top,
            bottom,
            globalMid: base + (top + bottom) / 2,
            paraId: id,
          })
        }
      }
    }
    return lines
  }

  private pickCurrent(lines: readonly LineBox[], page: number, x: number, y: number): LineBox | null {
    let best: LineBox | null = null
    let bestDist = Infinity
    for (const line of lines) {
      if (line.page !== page) continue
      const inside = y >= line.top - 2 && y <= line.bottom + 2 && x >= line.left - 8 && x <= line.right + 8
      const dy = y < line.top ? line.top - y : y > line.bottom ? y - line.bottom : 0
      const dx = x < line.left ? line.left - x : x > line.right ? x - line.right : 0
      const dist = inside ? 0 : dx * dx + dy * dy
      if (dist < bestDist) {
        bestDist = dist
        best = line
      }
    }
    return best
  }

  private pickNext(lines: readonly LineBox[], current: LineBox, direction: 'up' | 'down', goal: number): LineBox | null {
    const forward = direction === 'down'
    const candidates = lines.filter((line) => {
      if (line === current) return false
      return forward ? line.globalMid > current.globalMid + 4 : line.globalMid < current.globalMid - 4
    })
    if (candidates.length === 0) return null
    const containing = candidates.filter((line) => goal >= line.left - 16 && goal <= line.right + 16)
    const pool = containing.length > 0 ? containing : candidates
    pool.sort((a, b) => Math.abs(a.globalMid - current.globalMid) - Math.abs(b.globalMid - current.globalMid))
    return pool[0] ?? null
  }

  private posOnLine(line: LineBox, goalX: number): Pos | null {
    const place = this.index().get(line.paraId)
    if (!place) return null
    const id = place.para.id
    const length = flatText(place.para).length
    const caretAt = (offset: number): CaretRect => this.caretRect({ p: id, o: offset })
    const onLine = (offset: number): boolean => {
      if (offset < 0 || offset > length) return false
      const caret = caretAt(offset)
      const y = caret.top + caret.height / 2
      return caret.page === line.page && y >= line.top - 3 && y <= line.bottom + 3
    }
    const beforeLine = (offset: number): boolean => {
      const caret = caretAt(offset)
      const y = caret.top + caret.height / 2
      return caret.page < line.page || (caret.page === line.page && y < line.top - 3)
    }
    let lo = 0
    let hi = length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (beforeLine(mid)) lo = mid + 1
      else hi = mid
    }
    let seed = onLine(lo) ? lo : lo > 0 && onLine(lo - 1) ? lo - 1 : -1
    if (seed < 0) {
      const midY = (line.top + line.bottom) / 2
      const x = Math.min(Math.max(goalX, line.left + 0.5), Math.max(line.left + 0.5, line.right - 0.5))
      const direct = this.posAtLocal(line.page, x, midY)
      if (!direct || direct.p !== id) return null
      seed = direct.o
    }
    let left = seed
    let right = seed
    while (left > 0 && onLine(left - 1)) left -= 1
    while (right < length && onLine(right + 1)) right += 1
    let best = seed
    let bestDist = Math.abs(caretAt(seed).x - goalX)
    while (left <= right) {
      const mid = (left + right) >> 1
      const x = caretAt(mid).x
      const dist = Math.abs(x - goalX)
      if (dist < bestDist) {
        bestDist = dist
        best = mid
      }
      if (x < goalX - 0.25) left = mid + 1
      else right = mid - 1
    }
    return { p: id, o: best }
  }

  private paintNow(sel: Selection, sink: HTMLTextAreaElement): void {
    for (const el of this.pageEls) el.querySelector('.overlay')?.replaceChildren()
    if (sel.kind === 'cells') {
      this.paintCells(sel, sink)
      return
    }
    const head = this.caretRect(sel.head)
    this.drawCaret(head)
    this.placeSink(head, sink)
    if (sel.anchor.p !== sel.head.p || sel.anchor.o !== sel.head.o) this.drawSelection(sel.anchor, sel.head)
  }

  private drawCaret(caret: CaretRect): void {
    const overlay = this.pageEls[caret.page]?.querySelector('.overlay')
    if (!(overlay instanceof HTMLElement)) return
    const mark = document.createElement('div')
    mark.className = 'caret'
    mark.style.left = `${caret.x}px`
    mark.style.top = `${caret.top}px`
    mark.style.height = `${caret.height}px`
    overlay.append(mark)
  }

  private placeSink(caret: CaretRect, sink: HTMLTextAreaElement): void {
    const page = this.pageEls[caret.page]
    if (!page) return
    if (sink.parentElement !== page) page.append(sink)
    sink.classList.add('ime-sink')
    sink.style.left = `${caret.x}px`
    sink.style.top = `${caret.top}px`
    sink.style.height = `${Math.max(caret.height, 16)}px`
    sink.style.width = '1px'
  }

  private drawSelection(anchor: Pos, head: Pos): void {
    const index = this.index()
    const a = index.get(anchor.p)
    const b = index.get(head.p)
    if (!a || !b) return
    const reverse = a.order > b.order || (a.order === b.order && anchor.o > head.o)
    const start = reverse ? head : anchor
    const end = reverse ? anchor : head
    const startPlace = index.get(start.p)
    const endPlace = index.get(end.p)
    if (!startPlace || !endPlace) return
    for (const place of index.values()) {
      if (place.order < startPlace.order || place.order > endPlace.order) continue
      const from = place.para.id === start.p ? start.o : 0
      const to = place.para.id === end.p ? end.o : flatText(place.para).length
      if (from === to) continue
      for (let i = 0; i < this.pageEls.length; i++) {
        const pageEl = this.pageEls[i]
        if (!pageEl || pageEl.dataset.mounted !== '1') continue
        const paraEl = [...blockElements(pageEl, place.para.id)].find((el) => el.classList.contains('p') && !el.closest('.repeat-head'))
        if (!(paraEl instanceof HTMLElement)) continue
        const range = rangeIn(paraEl, from, to)
        const origin = pageEl.getBoundingClientRect()
        const slice = paraEl.closest('.slice')
        const sliceRect = slice instanceof HTMLElement ? slice.getBoundingClientRect() : null
        const overlay = pageEl.querySelector('.overlay')
        if (!(overlay instanceof HTMLElement)) continue
        for (const rect of range.getClientRects()) {
          if (rect.width < 0.5 || rect.height < 0.5) continue
          let left = rect.left
          let top = rect.top
          let right = rect.right
          let bottom = rect.bottom
          if (sliceRect) {
            left = Math.max(left, sliceRect.left)
            top = Math.max(top, sliceRect.top)
            right = Math.min(right, sliceRect.right)
            bottom = Math.min(bottom, sliceRect.bottom)
          }
          if (right - left < 0.5 || bottom - top < 0.5) continue
          const mark = document.createElement('div')
          mark.className = 'sel'
          const z = this.zoom
          mark.style.left = `${(left - origin.left) / z}px`
          mark.style.top = `${(top - origin.top) / z}px`
          mark.style.width = `${(right - left) / z}px`
          mark.style.height = `${(bottom - top) / z}px`
          overlay.append(mark)
        }
      }
    }
  }

  private paintCells(sel: Extract<Selection, { kind: 'cells' }>, sink: HTMLTextAreaElement): void {
    const doc = this.doc
    if (!doc) return
    const table = doc.body.find((block) => block.kind === 'table' && block.id === sel.table)
    if (!table || table.kind !== 'table') return
    const r0 = Math.min(sel.anchor.row, sel.head.row)
    const r1 = Math.max(sel.anchor.row, sel.head.row)
    const c0 = Math.min(sel.anchor.cell, sel.head.cell)
    const c1 = Math.max(sel.anchor.cell, sel.head.cell)
    const row = table.rows[r0]
    const cell = row?.cells[c0]
    const para = cell?.blocks.find((block) => block.kind === 'p')
    if (para && para.kind === 'p') {
      const caret = this.caretRect({ p: para.id, o: 0 })
      this.placeSink(caret, sink)
    }
    for (const pageEl of this.pageEls) {
      if (pageEl.dataset.mounted !== '1') continue
      const tableEl = pageEl.querySelector(`.blk.t[data-id="${CSS.escape(sel.table)}"] table`)
      if (!(tableEl instanceof HTMLTableElement)) continue
      const origin = pageEl.getBoundingClientRect()
      const overlay = pageEl.querySelector('.overlay')
      if (!(overlay instanceof HTMLElement)) continue
      for (let r = r0; r <= r1; r++) {
        const tr = tableEl.rows[r]
        if (!tr) continue
        for (let c = c0; c <= c1 && c < tr.cells.length; c++) {
          const td = tr.cells[c]
          if (!td) continue
          const rect = td.getBoundingClientRect()
          const mark = document.createElement('div')
          mark.className = 'cell-sel'
          const z = this.zoom
          mark.style.left = `${(rect.left - origin.left) / z}px`
          mark.style.top = `${(rect.top - origin.top) / z}px`
          mark.style.width = `${rect.width / z}px`
          mark.style.height = `${rect.height / z}px`
          overlay.append(mark)
        }
      }
    }
  }
}
