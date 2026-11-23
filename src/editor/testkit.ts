import {
  changeIndentLevel,
  deleteBackward,
  deleteColumns,
  deleteForward,
  deleteRows,
  deleteSelection,
  deleteTable,
  insertColumn,
  insertImage,
  insertLineBreak,
  insertPageBreak,
  insertRow,
  insertTable,
  insertText,
  move,
  moveAtom,
  resizeImage,
  selectAll,
  selectAround,
  setAlign,
  clearMarks,
  setIndent,
  setLineSpacing,
  setMark,
  setParaFormat,
  setSpacing,
  setPageSetup,
  setParaStyle,
  setSelection,
  splitParagraph,
  toggleList,
  toggleMark,
} from './edit.ts'
import type { Command } from './edit.ts'
import { flatText, indexOf } from '../model.ts'
import type {
  Atom,
  Block,
  BlockSrc,
  Cell,
  Doc,
  Hex,
  Inline,
  LineSpacing,
  ListTable,
  Lock,
  Marks,
  MediaKey,
  MediaTable,
  NumId,
  OpaqueBlock,
  OpaqueId,
  PageSetup,
  ParaId,
  ParaLoc,
  ParaLook,
  ParaProps,
  ParaSrc,
  Paragraph,
  Pt,
  Row,
  RunSrc,
  Section,
  Selection,
  StoryKey,
  StyleId,
  StyleSheet,
  Table,
  TableId,
  TextRun,
} from '../model.ts'

export const NORMAL: StyleId = 'normal' as StyleId
export const HEADING: StyleId = 'heading1' as StyleId

export function pt(value: number): Pt {
  return value as Pt
}

export function hex(value: string): Hex {
  return value as Hex
}

export function paraId(value: string): ParaId {
  return value as ParaId
}

export function runSrc(value: number): RunSrc {
  return value as RunSrc
}

export function paraSrc(value: number): ParaSrc {
  return value as ParaSrc
}

export function styleId(value: string): StyleId {
  return value as StyleId
}

export function numId(value: number): NumId {
  return value as NumId
}

export function mediaKey(value: string): MediaKey {
  return value as MediaKey
}

export function tableId(value: string): TableId {
  return value as TableId
}

export function opaqueId(value: string): OpaqueId {
  return value as OpaqueId
}

export function storyKey(value: string): StoryKey {
  return value as StoryKey
}

export function text(value: string, src: number | null = null, marks: Marks = {}): TextRun {
  return { kind: 'text', text: value, src: src === null ? null : runSrc(src), marks }
}

export function imageAtom(key: string, width = 72, height = 72, src: number | null = null): Atom {
  return {
    kind: 'atom',
    src: src === null ? null : runSrc(src),
    atom: { type: 'image', media: mediaKey(key), widthPt: pt(width), heightPt: pt(height) },
  }
}

export function pageBreakAtom(src: number | null = null): Atom {
  return { kind: 'atom', src: src === null ? null : runSrc(src), atom: { type: 'pageBreak' } }
}

export function opaqueAtom(label: string, display: string, removable: boolean, src: number | null = null): Atom {
  return {
    kind: 'atom',
    src: src === null ? null : runSrc(src),
    atom: { type: 'opaque', label, display, removable },
  }
}

export function fieldAtom(display: string, field: 'page' | 'numPages' | 'other' = 'page', src: number | null = null): Atom {
  return {
    kind: 'atom',
    src: src === null ? null : runSrc(src),
    atom: { type: 'field', field, display },
  }
}

export function paragraph(
  id: string,
  inlines: readonly Inline[],
  props: ParaProps = {},
  extra: { src?: number | null, lock?: Lock | null, sectionEnd?: number | null } = {},
): Paragraph {
  return {
    kind: 'p',
    id: paraId(id),
    src: extra.src === undefined || extra.src === null ? null : paraSrc(extra.src),
    props,
    inlines,
    lock: extra.lock ?? null,
    sectionEnd: extra.sectionEnd ?? null,
  }
}

export function cell(blocks: readonly Block[], span = 1): Cell {
  return { src: null, span, vMerge: null, blocks }
}

export function row(cells: readonly Cell[]): Row {
  return { src: null, props: {}, cells }
}

export function table(id: string, rows: readonly Row[], columns?: readonly number[]): Table {
  const widths = columns ?? rows[0]?.cells.map(() => 72) ?? [72]
  return { kind: 'table', id: tableId(id), src: null, props: {}, grid: widths.map(pt), rows }
}

export function opaqueBlock(id: string, preview: readonly Paragraph[], removable: boolean, src = 1): OpaqueBlock {
  return { kind: 'opaque', id: opaqueId(id), src: src as BlockSrc, label: 'sdt', preview, removable }
}

export function paraLook(numbering: ParaLook['numbering'] = null): ParaLook {
  const zero = pt(0)
  return {
    align: 'left',
    indent: { left: zero, right: zero, firstLine: zero, hanging: zero, firstLineChars: 0 },
    spacing: { before: zero, after: zero, line: { rule: 'auto', multiple: 1 }, contextual: false },
    numbering,
    keepNext: false,
    keepLines: false,
    pageBreakBefore: false,
    widowControl: true,
  }
}

export function stylesheet(): StyleSheet {
  const paragraph = new Map<StyleId, { name: string, role: 'normal' | 'heading1' | null, next: StyleId | null, look: ParaLook }>()
  paragraph.set(NORMAL, { name: 'Normal', role: 'normal', next: null, look: paraLook() })
  paragraph.set(HEADING, { name: 'heading 1', role: 'heading1', next: NORMAL, look: paraLook() })
  return { paragraph, character: new Map(), defaultParagraph: NORMAL, added: [] }
}

export function page(width = 612, height = 792): PageSetup {
  return {
    widthPt: pt(width),
    heightPt: pt(height),
    margin: { top: pt(72), right: pt(72), bottom: pt(72), left: pt(72), header: pt(36), footer: pt(36), gutter: pt(0) },
  }
}

export function section(setup: PageSetup = page()): Section {
  return { src: null, page: setup, breakType: 'nextPage', titlePage: false, headers: {}, footers: {}, grid: null }
}

export function makeDoc(body: readonly Block[], extras: {
  sections?: readonly Section[]
  stories?: ReadonlyMap<StoryKey, readonly Block[]>
  styles?: StyleSheet
  lists?: ListTable
  media?: MediaTable
} = {}): Doc {
  return {
    body,
    sections: extras.sections ?? [section()],
    stories: extras.stories ?? new Map(),
    styles: extras.styles ?? stylesheet(),
    lists: extras.lists ?? { byNum: new Map() },
    media: extras.media ?? { byKey: new Map() },
  }
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface GeneratedCommand {
  readonly label: string
  readonly command: Command
}

const SAMPLES = ['你好世界', 'hello', 'a😀b', 'word', '甲乙丙', 'x y', '👨‍👩‍👧‍👦z'] as const

export function randomDoc(rng: () => number): Doc {
  let n = 1
  let serial = 1
  const mint = (): number => n++
  const id = (): string => `d${serial++}`
  const blocks: Block[] = [randomParagraph(rng, mint, id, true)]
  const before = Math.floor(rng() * 3)
  for (let i = 0; i < before; i++) blocks.push(randomParagraph(rng, mint, id, false))
  blocks.push(randomParagraph(rng, mint, id, false, { reason: 'revisions' }))
  blocks.push(randomTable(rng, mint, id))
  const after = 1 + Math.floor(rng() * 2)
  for (let i = 0; i < after; i++) blocks.push(randomParagraph(rng, mint, id, false))
  return makeDoc(blocks)
}

function randomParagraph(
  rng: () => number,
  mint: () => number,
  id: () => string,
  fixedAtom: boolean,
  lock: Lock | null = null,
): Paragraph {
  const src = paraSrc(mint())
  const inlines: Inline[] = []
  if (fixedAtom) inlines.push(opaqueAtom('eq', '∫', false, mint()))
  const count = 1 + Math.floor(rng() * 3)
  for (let i = 0; i < count; i++) {
    const kind = rng()
    if (kind < 0.15) inlines.push(imageAtom('img', 20, 20, mint()))
    else if (kind < 0.25) inlines.push(pageBreakAtom(mint()))
    else if (kind < 0.35) inlines.push(opaqueAtom('sym', '§', true, mint()))
    else {
      const sample = SAMPLES[Math.floor(rng() * SAMPLES.length)] ?? 'x'
      const marks: Marks = {}
      if (rng() < 0.5) inlines.push(text(sample, mint(), { ...marks, bold: true }))
      else if (rng() < 0.5) inlines.push(text(sample, mint(), { italic: true }))
      else inlines.push(text(sample, mint(), marks))
    }
  }
  const props: ParaProps = rng() < 0.25 ? { style: HEADING } : {}
  return { kind: 'p', id: paraId(id()), src, props, inlines, lock, sectionEnd: null }
}

function randomTable(rng: () => number, mint: () => number, id: () => string): Table {
  const rowsN = 1 + Math.floor(rng() * 2)
  const colsN = 1 + Math.floor(rng() * 2)
  const rows: Row[] = []
  for (let r = 0; r < rowsN; r++) {
    const cells: Cell[] = []
    for (let c = 0; c < colsN; c++) cells.push(cell([randomParagraph(rng, mint, id, false)]))
    rows.push(row(cells))
  }
  return table(id(), rows, Array.from({ length: colsN }, () => 72))
}

export function randomCommand(rng: () => number, state: { doc: Doc, sel: Selection }): GeneratedCommand {
  const locs = bodyLocs(state.doc)
  const loc = locs[Math.floor(rng() * locs.length)]
  if (!loc) return generated('selectAll', selectAll)
  const other = locs[Math.floor(rng() * locs.length)] ?? loc
  const anchor = { p: loc.para.id, o: offset(rng, loc.para) }
  const head = { p: other.para.id, o: offset(rng, other.para) }
  const tables = tablesIn(state.doc.body)
  const table = tables[Math.floor(rng() * tables.length)]
  const kind = Math.floor(rng() * 37)
  switch (kind) {
    case 0: return generated('insertText', insertText(sampleText(rng)))
    case 1: return generated('insertLineBreak', insertLineBreak)
    case 2: return generated('insertPageBreak', insertPageBreak)
    case 3: return generated('splitParagraph', splitParagraph)
    case 4: return generated('deleteBackward char', deleteBackward('char'))
    case 5: return generated('deleteBackward word', deleteBackward('word'))
    case 6: return generated('deleteForward char', deleteForward('char'))
    case 7: return generated('deleteForward word', deleteForward('word'))
    case 8: return generated('deleteSelection', deleteSelection)
    case 9: return generated('toggleMark', toggleMark(pick(rng, ['bold', 'italic', 'underline', 'strike'] as const)))
    case 10: return generated('setMark', setMark(randomMark(rng)))
    case 11: return generated('setParaStyle', setParaStyle(pick(rng, [NORMAL, HEADING, styleId('heading2'), styleId('custom')])))
    case 12: return generated('setAlign', setAlign(pick(rng, ['left', 'center', 'right', 'justify'] as const)))
    case 13: return generated('setLineSpacing', setLineSpacing(randomSpacing(rng)))
    case 14: return generated('setIndent', setIndent(rng() < 0.5 ? { left: pt(36) } : { firstLine: pt(12) }))
    case 15: return generated('changeIndentLevel', changeIndentLevel(rng() < 0.5 ? 1 : -1))
    case 16: return generated('toggleList', toggleList(rng() < 0.5 ? 'bullet' : 'decimal'))
    case 17: return generated('insertTable', insertTable(1 + Math.floor(rng() * 3), Math.floor(rng() * 3)))
    case 18: return generated('insertRow', insertRow(rng() < 0.5 ? 'above' : 'below'))
    case 19: return generated('deleteRows', deleteRows())
    case 20: return generated('insertColumn', insertColumn(rng() < 0.5 ? 'left' : 'right'))
    case 21: return generated('deleteColumns', deleteColumns())
    case 22: return generated('deleteTable', deleteTable(table?.id ?? tableId('missing')))
    case 23: return generated('insertImage', insertImage({
      key: mediaKey(rng() < 0.5 ? 'pic' : 'other'),
      contentType: rng() < 0.5 ? 'image/png' : 'image/jpeg',
      widthPx: rng() < 0.5 ? 200 : 1000,
      heightPx: 500,
    }))
    case 24: return generated('setPageSetup', setPageSetup(rng() < 0.8 ? 0 : 3, page(600 + Math.floor(rng() * 40))))
    case 25: return generated('move', move(
      rng() < 0.5 ? 'backward' : 'forward',
      pick(rng, ['char', 'word', 'paragraph', 'document'] as const),
      rng() < 0.3,
    ))
    case 26: return generated('selectAll', selectAll)
    case 27: return generated('selectAround', selectAround(anchor, rng() < 0.5 ? 'word' : 'paragraph'))
    case 28: return generated('setSelection', setSelection({ kind: 'text', anchor, head }))
    case 29: return generated('setCaret', setSelection({ kind: 'text', anchor, head: anchor }))
    case 30: return generated('resizeImage', resizeImage(imagePos(loc.para, false) ?? anchor, rng() < 0.15 ? 2 : 16 + Math.floor(rng() * 40), rng() < 0.15 ? 2 : 16 + Math.floor(rng() * 40)))
    case 31: return generated('moveAtom', moveAtom(imagePos(loc.para, true) ?? anchor, head))
    case 32: return generated('clearMarks', clearMarks)
    case 33: return generated('setSpacing', setSpacing(rng() < 0.5 ? { before: pt(12) } : { after: pt(0) }))
    case 34: return generated('setParaFormat', setParaFormat({
      align: pick(rng, ['left', 'center', 'right', 'justify'] as const),
      indent: { left: pt(18), firstLine: pt(12), hanging: null },
      spacing: { before: pt(6), after: pt(6), line: randomSpacing(rng) },
    }))
    default: {
      if (!table || table.rows.length === 0) return generated('setSelection', setSelection({ kind: 'text', anchor, head }))
      const rowA = Math.floor(rng() * table.rows.length)
      const rowB = Math.floor(rng() * table.rows.length)
      const cellsA = table.rows[rowA]?.cells.length ?? 1
      const cellsB = table.rows[rowB]?.cells.length ?? 1
      return generated('selectCells', setSelection({
        kind: 'cells',
        table: table.id,
        anchor: { row: rowA, cell: Math.floor(rng() * cellsA) },
        head: { row: rowB, cell: Math.floor(rng() * cellsB) },
      }))
    }
  }
}

function generated(label: string, command: Command): GeneratedCommand {
  return { label, command }
}

function sampleText(rng: () => number): string {
  const chunks = ['a', '你', '好', '😀', ' ', 'x y', '甲', '\n', 'bc', '', '👨‍👩‍👧‍👦', 'Hello']
  const count = 1 + Math.floor(rng() * 3)
  let text = ''
  for (let i = 0; i < count; i++) text += chunks[Math.floor(rng() * chunks.length)] ?? 'a'
  return text
}

function randomMark(rng: () => number): Parameters<typeof setMark>[0] {
  const which = Math.floor(rng() * 6)
  const clear = rng() < 0.2
  if (which === 0) return { mark: 'font', value: clear ? undefined : 'Songti' }
  if (which === 1) return { mark: 'fontEastAsia', value: clear ? undefined : '宋体' }
  if (which === 2) return { mark: 'sizePt', value: clear ? undefined : pt(pick(rng, [12, 14, 16])) }
  if (which === 3) return { mark: 'color', value: clear ? undefined : hex('FF0000') }
  if (which === 4) return { mark: 'highlight', value: clear ? undefined : 'yellow' }
  return { mark: 'vertAlign', value: clear ? undefined : (rng() < 0.5 ? 'super' : 'sub') }
}

function randomSpacing(rng: () => number): LineSpacing {
  const which = Math.floor(rng() * 3)
  if (which === 0) return { rule: 'auto', multiple: rng() < 0.5 ? 1 : 1.5 }
  if (which === 1) return { rule: 'exact', pt: pt(16) }
  return { rule: 'atLeast', pt: pt(14) }
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)]
  if (item === undefined) throw new Error('empty pick')
  return item
}

function offset(rng: () => number, para: Paragraph): number {
  return Math.floor(rng() * (flatText(para).length + 1))
}

function imagePos(para: Paragraph, fresh: boolean): { p: ParaId, o: number } | null {
  let cursor = 0
  let any: { p: ParaId, o: number } | null = null
  for (const inline of para.inlines) {
    if (inline.kind === 'atom' && inline.atom.type === 'image') {
      const pos = { p: para.id, o: cursor }
      if (!fresh || inline.src === null) return pos
      any = pos
    }
    cursor += inline.kind === 'text' ? inline.text.length : 1
  }
  return any
}

function bodyLocs(doc: Doc): ParaLoc[] {
  const index = indexOf(doc)
  const out: ParaLoc[] = []
  for (const id of index.ordered) {
    const loc = index.get(id)
    if (loc.story !== 'body') break
    out.push(loc)
  }
  return out
}

function tablesIn(blocks: readonly Block[], out: Table[] = []): Table[] {
  for (const block of blocks) {
    if (block.kind !== 'table') continue
    out.push(block)
    for (const entry of block.rows) for (const item of entry.cells) tablesIn(item.blocks, out)
  }
  return out
}
