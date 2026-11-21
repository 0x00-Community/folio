// Pure views of a document. No DOM and no editor: the caller supplies list markers and a page lookup.
import { wordCount } from '../editor/edit.ts'
import { flatText, indexOf } from '../model.ts'
import type { Atom, Block, Doc, Marks, NumId, PageSetup, Paragraph, ParaId, Pos, Table } from '../model.ts'
import { previewParagraph } from './address.ts'
import type {
  BlockView,
  FindMatch,
  HeadingView,
  PageSetupView,
  ParagraphText,
  TextBlock,
  TextMarks,
  TextRunView,
} from './types.ts'

/** 0-based page of a block, or null when the layout has not measured it. Views add one. */
export type PageIndex = (blockId: string) => number | null

const BLOCK_DEFAULT = 200
const BLOCK_MAX = 500
const OUTLINE_MAX = 5000
const HEADING_NAME = /^heading ([1-9])$/i

interface BodyEntry {
  readonly index: number
  readonly section: number
  readonly block: Block
}

interface Structure {
  readonly body: readonly BodyEntry[]
  readonly byId: ReadonlyMap<string, Block>
}

interface HeadingFact {
  readonly id: string
  readonly level: number
  readonly number: string | null
  readonly text: string
  readonly from: number
  readonly to: number
}

const structureCache = new WeakMap<Doc, Structure>()
const outlineCache = new WeakMap<Doc, { markers: ReadonlyMap<ParaId, string>, headings: readonly HeadingFact[] }>()

export interface Summary {
  readonly blocks: number
  readonly words: number
  readonly sections: readonly {
    readonly index: number
    readonly page: PageSetupView
    readonly breakType: 'nextPage' | 'continuous' | 'evenPage' | 'oddPage'
  }[]
  readonly styles: readonly { readonly id: string, readonly name: string, readonly heading: number | null }[]
}

export interface Paged<T> {
  readonly total: number
  readonly from: number
  readonly next: number | null
  readonly blocks: readonly T[]
}

export interface OutlineBody {
  readonly headings: readonly HeadingView[]
  readonly truncated: boolean
}

export interface FindBody {
  readonly matches: readonly FindMatch[]
  readonly truncated: boolean
}

/** Body size, word count, sections, and paragraph styles. Name, dirtiness, and page count come from the host. */
export function documentSummary(doc: Doc): Summary {
  return {
    blocks: doc.body.length,
    words: wordCount(doc),
    sections: doc.sections.map((section, index) => ({
      index,
      breakType: section.breakType,
      page: pageSetupView(section.page),
    })),
    styles: [...doc.styles.paragraph].map(([id, style]) => ({
      id,
      name: style.name,
      heading: headingFromName(style.name),
    })),
  }
}

/** One page of top-level body blocks. `count` defaults to 200 and is capped at 500. */
export function readBlocks(doc: Doc, pageOf: PageIndex, from: number, count: number | undefined): Paged<BlockView> {
  const body = structureOf(doc).body
  const window = sliceWindow(body.length, from, count)
  const blocks: BlockView[] = []
  for (let i = window.start; i < window.end; i++) {
    const entry = body[i]
    if (entry) blocks.push(blockView(doc, entry, pageOf))
  }
  return { total: body.length, from: window.from, next: window.next, blocks }
}

/** One page of top-level body blocks as text. */
export function readText(doc: Doc, markers: ReadonlyMap<ParaId, string>, from: number, count: number | undefined): Paged<TextBlock> {
  const body = structureOf(doc).body
  const window = sliceWindow(body.length, from, count)
  const blocks: TextBlock[] = []
  for (let i = window.start; i < window.end; i++) {
    const entry = body[i]
    if (entry) blocks.push(textBlock(doc, entry.block, markers))
  }
  return { total: body.length, from: window.from, next: window.next, blocks }
}

/**
 * Text for specific ids, in request order. Paragraphs inside cells, opaque blocks, and stories are included.
 * An unknown id is returned as `missing` and nothing else is read.
 */
export function readTextByIds(
  doc: Doc,
  markers: ReadonlyMap<ParaId, string>,
  ids: readonly string[],
): { readonly ok: true, readonly blocks: readonly TextBlock[] } | { readonly ok: false, readonly missing: string } {
  const byId = structureOf(doc).byId
  const blocks: TextBlock[] = []
  for (const id of ids) {
    const block = byId.get(id)
    if (!block) return { ok: false, missing: id }
    blocks.push(textBlock(doc, block, markers))
  }
  return { ok: true, blocks }
}

/** Top-level body headings whose style name is `heading 1` through `heading 9`. At most 5000. */
export function readOutline(doc: Doc, markers: ReadonlyMap<ParaId, string>, pageOf: PageIndex): OutlineBody {
  const facts = headingFacts(doc, markers)
  const truncated = facts.length > OUTLINE_MAX
  const kept = truncated ? facts.slice(0, OUTLINE_MAX) : facts
  const headings: HeadingView[] = kept.map((heading) => ({
    id: heading.id,
    level: heading.level,
    number: heading.number,
    text: heading.text,
    page: pageNumber(pageOf(heading.id)),
    from: heading.from,
    to: heading.to,
  }))
  return { headings, truncated }
}

/**
 * Matches inside one paragraph, in body order, including table cells.
 * Header, footer, and opaque-preview paragraphs are skipped: an address there cannot be edited.
 */
export function readFind(
  doc: Doc,
  needle: string,
  from: Pos | null,
  limit: number,
  matchCase: boolean,
): FindBody {
  const index = indexOf(doc)
  const matches: FindMatch[] = []
  let started = from === null
  for (const id of index.ordered) {
    const loc = index.get(id)
    if (loc.story !== 'body') break
    if (previewParagraph(doc, loc)) continue
    let startAt = 0
    if (!started) {
      if (!from || loc.para.id !== from.p) continue
      started = true
      startAt = from.o
    }
    const text = flatText(loc.para)
    let cursor = startAt
    while (cursor <= text.length - needle.length) {
      if (!equalsAt(text, cursor, needle, matchCase)) {
        cursor += 1
        continue
      }
      if (matches.length >= limit) return { matches, truncated: true }
      const end = cursor + needle.length
      matches.push({ para: loc.para.id, start: cursor, end })
      cursor = end
    }
  }
  return { matches, truncated: false }
}

function structureOf(doc: Doc): Structure {
  const cached = structureCache.get(doc)
  if (cached) return cached
  const built = buildStructure(doc)
  structureCache.set(doc, built)
  return built
}

function buildStructure(doc: Doc): Structure {
  const byId = new Map<string, Block>()
  const sections = sectionNumbers(doc.body)
  const body: BodyEntry[] = []
  for (let i = 0; i < doc.body.length; i++) {
    const block = doc.body[i]
    if (!block) continue
    body.push({ index: i, section: sections[i] ?? 0, block })
    indexBlock(block, byId)
  }
  for (const blocks of doc.stories.values()) {
    for (const block of blocks) indexBlock(block, byId)
  }
  return { body, byId }
}

function indexBlock(block: Block, byId: Map<string, Block>): void {
  byId.set(block.id, block)
  if (block.kind === 'table') {
    for (const row of block.rows) {
      for (const cell of row.cells) {
        for (const child of cell.blocks) indexBlock(child, byId)
      }
    }
  } else if (block.kind === 'opaque') {
    for (const para of block.preview) indexBlock(para, byId)
  }
}

function sectionNumbers(body: readonly Block[]): number[] {
  const out: number[] = []
  let section = 0
  for (let i = 0; i < body.length; i++) {
    out.push(section)
    const block = body[i]
    if (block?.kind === 'p' && block.sectionEnd !== null) section = block.sectionEnd + 1
  }
  return out
}

function sliceWindow(total: number, from: number, count: number | undefined): { from: number, next: number | null, start: number, end: number } {
  const size = Math.min(count ?? BLOCK_DEFAULT, BLOCK_MAX)
  if (from >= total || size < 1) return { from, next: null, start: from, end: from }
  const end = Math.min(total, from + size)
  return { from, next: end < total ? end : null, start: from, end }
}

function headingFacts(doc: Doc, markers: ReadonlyMap<ParaId, string>): readonly HeadingFact[] {
  const cached = outlineCache.get(doc)
  if (cached && cached.markers === markers) return cached.headings
  const found: { index: number, id: string, level: number, text: string, number: string | null }[] = []
  doc.body.forEach((block, index) => {
    if (block.kind !== 'p') return
    const level = headingLevel(doc, block)
    if (level === null) return
    found.push({
      index,
      id: block.id,
      level,
      text: flatText(block),
      number: markers.get(block.id) ?? null,
    })
  })
  const last = Math.max(0, doc.body.length - 1)
  const headings: HeadingFact[] = found.map((heading, i) => {
    let to = last
    for (let j = i + 1; j < found.length; j++) {
      const next = found[j]
      if (next && next.level <= heading.level) {
        to = next.index - 1
        break
      }
    }
    return {
      id: heading.id,
      level: heading.level,
      number: heading.number,
      text: heading.text,
      from: heading.index,
      to,
    }
  })
  outlineCache.set(doc, { markers, headings })
  return headings
}

function blockView(doc: Doc, entry: BodyEntry, pageOf: PageIndex): BlockView {
  const page = pageNumber(pageOf(entry.block.id))
  const index = entry.index
  const id = entry.block.id
  const section = entry.section
  if (entry.block.kind === 'p') {
    return {
      index,
      id,
      kind: 'paragraph',
      section,
      page,
      length: flatText(entry.block).length,
      style: styleIdOf(doc, entry.block),
      heading: headingLevel(doc, entry.block),
      locked: entry.block.lock?.reason ?? null,
    }
  }
  if (entry.block.kind === 'table') {
    return { index, id, kind: 'table', section, page, rows: entry.block.rows.length, cols: columnCount(entry.block) }
  }
  return { index, id, kind: 'opaque', section, page, label: entry.block.label }
}

function textBlock(doc: Doc, block: Block, markers: ReadonlyMap<ParaId, string>): TextBlock {
  if (block.kind === 'p') return paragraphText(doc, block, markers)
  if (block.kind === 'table') return tableText(doc, block, markers)
  return { kind: 'opaque', id: block.id, label: block.label, preview: block.preview.map((para) => flatText(para)) }
}

function paragraphText(doc: Doc, para: Paragraph, markers: ReadonlyMap<ParaId, string>): ParagraphText {
  const text = flatText(para)
  const runs: TextRunView[] = []
  let cursor = 0
  for (const inline of para.inlines) {
    if (inline.kind === 'text') {
      const end = cursor + inline.text.length
      runs.push({ start: cursor, end, marks: marksView(inline.marks) })
      cursor = end
      continue
    }
    const end = cursor + 1
    runs.push(atomRun(inline, cursor, end))
    cursor = end
  }
  return {
    kind: 'paragraph',
    id: para.id,
    text,
    runs,
    style: styleIdOf(doc, para),
    align: alignOf(doc, para),
    list: listOf(doc, para, markers),
    locked: para.lock?.reason ?? null,
  }
}

function tableText(doc: Doc, table: Table, markers: ReadonlyMap<ParaId, string>): TextBlock {
  return {
    kind: 'table',
    id: table.id,
    rows: table.rows.map((row) => ({
      cells: row.cells.map((cell) => ({
        span: cell.span,
        vMerge: cell.vMerge,
        blocks: cell.blocks.map((block) => textBlock(doc, block, markers)),
      })),
    })),
  }
}

function marksView(marks: Marks): TextMarks {
  const out: TextMarks = {}
  if (marks.bold !== undefined) out.bold = marks.bold
  if (marks.italic !== undefined) out.italic = marks.italic
  if (marks.underline !== undefined) out.underline = marks.underline
  if (marks.strike !== undefined) out.strike = marks.strike
  if (marks.font !== undefined) out.font = marks.font
  if (marks.fontEastAsia !== undefined) out.fontEastAsia = marks.fontEastAsia
  if (marks.sizePt !== undefined) out.sizePt = marks.sizePt
  if (marks.color !== undefined) out.color = marks.color
  if (marks.highlight !== undefined) out.highlight = marks.highlight
  if (marks.vertAlign !== undefined) out.vertAlign = marks.vertAlign
  if (marks.charStyle !== undefined) out.charStyle = marks.charStyle
  if (marks.link !== undefined) out.link = true
  return out
}

function atomRun(inline: Atom, start: number, end: number): TextRunView {
  const atom = inline.atom
  if (atom.type === 'field') return { start, end, atom: 'field', display: atom.display }
  if (atom.type === 'opaque') return { start, end, atom: 'opaque', display: atom.display }
  if (atom.type === 'image') return { start, end, atom: 'image' }
  if (atom.type === 'pageBreak') return { start, end, atom: 'pageBreak' }
  return { start, end, atom: 'columnBreak' }
}

function listOf(doc: Doc, para: Paragraph, markers: ReadonlyMap<ParaId, string>): { level: number, marker: string } | null {
  const marker = markers.get(para.id)
  if (marker === undefined) return null
  const numbering = numberingOf(doc, para)
  if (!numbering) return null
  return { level: numbering.level, marker }
}

function numberingOf(doc: Doc, para: Paragraph): { num: NumId, level: number } | null {
  if (para.props.numbering === null) return null
  if (para.props.numbering !== undefined) return para.props.numbering
  const style = para.props.style ?? doc.styles.defaultParagraph
  for (const [key, entry] of doc.styles.paragraph) {
    if (key === style) return entry.look.numbering
  }
  return null
}

function styleIdOf(doc: Doc, para: Paragraph): string {
  return para.props.style ?? doc.styles.defaultParagraph
}

function alignOf(doc: Doc, para: Paragraph): ParagraphText['align'] {
  if (para.props.align) return para.props.align
  const style = styleIdOf(doc, para)
  for (const [key, entry] of doc.styles.paragraph) {
    if (key === style) return entry.look.align
  }
  return 'left'
}

function headingLevel(doc: Doc, para: Paragraph): number | null {
  const id = styleIdOf(doc, para)
  for (const [key, style] of doc.styles.paragraph) {
    if (key === id) return headingFromName(style.name)
  }
  return null
}

function headingFromName(name: string): number | null {
  const match = HEADING_NAME.exec(name.trim())
  const digits = match?.[1]
  if (!digits) return null
  const level = Number(digits)
  return level >= 1 && level <= 9 ? level : null
}

function columnCount(table: Table): number {
  if (table.grid.length > 0) return table.grid.length
  let max = 0
  for (const row of table.rows) {
    let count = 0
    for (const cell of row.cells) count += cell.span
    if (count > max) max = count
  }
  return max
}

function pageNumber(index: number | null): number | null {
  if (index === null || !Number.isInteger(index) || index < 0) return null
  return index + 1
}

function pageSetupView(page: PageSetup): PageSetupView {
  return {
    widthPt: page.widthPt,
    heightPt: page.heightPt,
    margin: {
      top: page.margin.top,
      right: page.margin.right,
      bottom: page.margin.bottom,
      left: page.margin.left,
      header: page.margin.header,
      footer: page.margin.footer,
      gutter: page.margin.gutter,
    },
  }
}

function equalsAt(text: string, offset: number, needle: string, matchCase: boolean): boolean {
  if (needle.length === 0 || offset + needle.length > text.length) return false
  const slice = text.slice(offset, offset + needle.length)
  if (matchCase) return slice === needle
  // A case fold that changes UTF-16 length compares unequal and the match is missed.
  return slice.toLowerCase() === needle.toLowerCase()
}
