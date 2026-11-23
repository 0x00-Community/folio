// The document model: the only source of truth while editing. Immutable values, no DOM, no rdocx types.
//
// Invariants (checked by checkDoc in tests and debug builds):
// 1. Values are never mutated. A transaction shares every untouched node, so identity is the change signal.
// 2. TextRun.text is non-empty and holds no U+FFFC. An Atom occupies exactly one offset.
// 3. Source order: within a story, ParaSrc and RunSrc values appear in non-decreasing pristine order.
// 4. Adjacent TextRuns merge only when src and marks are both equal.
// 5. A locked paragraph, and an atom with removable: false, never change.
// 6. Every Cell.blocks is non-empty and ends with a Paragraph.

// ---- Identities ----------------------------------------------------------------------------------------------------

declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

/** Editor identity. Minted in TypeScript, unique per session, never reused. DOM key, selection anchor, cache key. */
export type ParaId = Brand<string, 'ParaId'>
export type TableId = Brand<string, 'TableId'>
export type OpaqueId = Brand<string, 'OpaqueId'>
export type BlockId = ParaId | TableId | OpaqueId

/**
 * Source identities. Minted by the bridge at import, meaningful only to write.rs. TypeScript may compare them (the
 * bridge mints them in pristine document order, so numeric order is source order) and nothing else.
 * A model node with a src descends from that pristine XML node and inherits its unmodeled XML.
 */
export type ParaSrc = Brand<number, 'ParaSrc'>
export type RunSrc = Brand<number, 'RunSrc'>
export type TableSrc = Brand<number, 'TableSrc'>
export type RowSrc = Brand<number, 'RowSrc'>
export type CellSrc = Brand<number, 'CellSrc'>
export type BlockSrc = ParaSrc | TableSrc | Brand<number, 'OpaqueSrc'>
export type SectionSrc = Brand<number, 'SectionSrc'>

export type StyleId = Brand<string, 'StyleId'>
/** Positive for numbering instances in the pristine document, negative for lists the editor created this session. */
export type NumId = Brand<number, 'NumId'>
export type MediaKey = Brand<string, 'MediaKey'>
export type StoryKey = Brand<string, 'StoryKey'> // e.g. "s0/header/default"
export type Pt = Brand<number, 'Pt'>
export type Hex = Brand<string, 'Hex'> // "FF0000"

// ---- Document ------------------------------------------------------------------------------------------------------

export interface Doc {
  readonly body: readonly Block[]
  /** Section i ends at the body paragraph whose sectionEnd is i. The last section ends at the body's end. */
  readonly sections: readonly Section[]
  /** Header and footer stories. Read-only in the MVP: commands refuse positions inside them. */
  readonly stories: ReadonlyMap<StoryKey, readonly Block[]>
  readonly styles: StyleSheet
  readonly lists: ListTable
  readonly media: MediaTable
}

export type Block = Paragraph | Table | OpaqueBlock

export interface Paragraph {
  readonly kind: 'p'
  readonly id: ParaId
  /**
   * Whose w:pPr and paragraph-level XML this paragraph continues. Enter copies it to both halves. A merge keeps the
   * side whose props survive (see edit.ts mergeSide), falling back to the other side's src when that side's is null.
   */
  readonly src: ParaSrc | null
  readonly props: ParaProps
  readonly inlines: readonly Inline[]
  readonly lock: Lock | null
  /** Non-null when this paragraph's mark carries the w:sectPr that ends section `sectionEnd`. Merging across it is refused. */
  readonly sectionEnd: number | null
}

export type Lock =
  | { readonly reason: 'revisions' } // tracked insertions or deletions inside
  | { readonly reason: 'unbalancedField' } // a field that starts or ends in another paragraph (table of contents lines)
  | { readonly reason: 'preview' } // content shown for an OpaqueBlock

export type Inline = TextRun | Atom

export interface TextRun {
  readonly kind: 'text'
  /** Non-empty. "\t" is a tab, "\n" a line break (w:br). No U+FFFC. */
  readonly text: string
  readonly marks: Marks
  /** The source run whose unmodeled w:rPr this text keeps. Several adjacent pieces may share one src. */
  readonly src: RunSrc | null
}

export interface Atom {
  readonly kind: 'atom'
  readonly atom: AtomKind
  /** The source run that holds this atom. Null for atoms inserted this session. */
  readonly src: RunSrc | null
}

export type AtomKind =
  | { readonly type: 'image'; readonly media: MediaKey; readonly widthPt: Pt; readonly heightPt: Pt }
  | { readonly type: 'field'; readonly field: 'page' | 'numPages' | 'other'; readonly display: string }
  | { readonly type: 'pageBreak' }
  | { readonly type: 'columnBreak' }
  /** Footnote and comment references, equations, symbols, inline content controls, unknown run children. */
  | { readonly type: 'opaque'; readonly label: string; readonly display: string; readonly removable: boolean }

/** Direct run formatting only. Undefined means "inherit from the styles", and write-back clears the direct value. */
export interface Marks {
  readonly bold?: boolean
  readonly italic?: boolean
  readonly underline?: boolean
  readonly strike?: boolean
  /** All four font slots, as rdocx's set_font writes them. */
  readonly font?: string
  /** The East Asian slot alone, as set_slot_font(EastAsia) writes it. */
  readonly fontEastAsia?: string
  readonly sizePt?: Pt
  readonly color?: Hex
  readonly highlight?: HighlightName
  readonly vertAlign?: 'super' | 'sub'
  readonly charStyle?: StyleId
  /** Present on text inside a hyperlink. Read-only in the MVP. */
  readonly link?: Brand<string, 'LinkKey'>
}

export type HighlightName = 'yellow' | 'green' | 'cyan' | 'magenta' | 'blue' | 'red' | 'darkBlue' | 'darkCyan' | 'darkGreen' | 'darkMagenta' | 'darkRed' | 'darkYellow' | 'darkGray' | 'lightGray' | 'black'

export interface ParaProps {
  readonly style?: StyleId
  readonly align?: 'left' | 'center' | 'right' | 'justify' | 'distribute'
  readonly indent?: {
    readonly left?: Pt
    readonly right?: Pt
    readonly firstLine?: Pt
    readonly hanging?: Pt
    /** w:firstLineChars in hundredths of a character (200 is the common 首行缩进 2 字符). */
    readonly firstLineChars?: number
  }
  readonly spacing?: { readonly before?: Pt; readonly after?: Pt; readonly line?: LineSpacing }
  /** null means "explicitly no list" (numId 0), overriding a style's numbering. */
  readonly numbering?: { readonly num: NumId; readonly level: number } | null
  readonly keepNext?: boolean
  readonly keepLines?: boolean
  readonly pageBreakBefore?: boolean
  readonly widowControl?: boolean
}

export type LineSpacing =
  | { readonly rule: 'auto'; readonly multiple: number }
  | { readonly rule: 'exact'; readonly pt: Pt }
  | { readonly rule: 'atLeast'; readonly pt: Pt }

export type BorderStyleName = 'single' | 'double' | 'dashed' | 'dotted'

export interface BorderLine {
  readonly style: BorderStyleName
  readonly widthPt: Pt
  readonly color: Hex
}

/** A line, or null when the file says that edge has no line (`nil`). A cell edge of `none` is omitted. */
export type BorderEdge = BorderLine | null

export interface TableBorders {
  readonly top: BorderEdge
  readonly left: BorderEdge
  readonly bottom: BorderEdge
  readonly right: BorderEdge
  readonly insideH: BorderEdge
  readonly insideV: BorderEdge
}

/**
 * A key is present only when the cell's `w:tcBorders` names that edge.
 * Null is no line. A missing key does not override the table.
 */
export interface CellBorders {
  readonly top?: BorderEdge
  readonly left?: BorderEdge
  readonly bottom?: BorderEdge
  readonly right?: BorderEdge
}

/** A missing edge does not override the table. The view's default applies only when both omit it. */
export interface CellMargins {
  readonly top?: Pt
  readonly right?: Pt
  readonly bottom?: Pt
  readonly left?: Pt
}

export interface Table {
  readonly kind: 'table'
  readonly id: TableId
  readonly src: TableSrc | null
  readonly props: {
    readonly style?: StyleId
    readonly align?: 'left' | 'center' | 'right'
    readonly widthPt?: Pt
    readonly borders?: TableBorders
    readonly margins?: CellMargins
  }
  readonly grid: readonly Pt[]
  readonly rows: readonly Row[]
}

export interface Row {
  readonly src: RowSrc | null
  readonly props: { readonly heightPt?: Pt; readonly heightRule?: 'atLeast' | 'exact'; readonly header?: boolean; readonly cantSplit?: boolean }
  readonly cells: readonly Cell[]
}

export interface Cell {
  readonly src: CellSrc | null
  readonly span: number
  readonly vMerge: 'restart' | 'continue' | null
  readonly widthPt?: Pt
  readonly shading?: Hex
  readonly vAlign?: 'top' | 'center' | 'bottom'
  readonly borders?: CellBorders
  readonly margins?: CellMargins
  readonly blocks: readonly Block[]
}

/** A block content control or preserved XML. Rendered from preview; removable only when it holds no comment anchors. */
export interface OpaqueBlock {
  readonly kind: 'opaque'
  readonly id: OpaqueId
  readonly src: BlockSrc
  readonly label: string
  readonly preview: readonly Paragraph[]
  readonly removable: boolean
}

export interface Section {
  readonly src: SectionSrc | null
  readonly page: PageSetup
  readonly breakType: 'nextPage' | 'continuous' | 'evenPage' | 'oddPage'
  readonly titlePage: boolean
  readonly headers: { readonly default?: StoryKey; readonly first?: StoryKey; readonly even?: StoryKey }
  readonly footers: { readonly default?: StoryKey; readonly first?: StoryKey; readonly even?: StoryKey }
  /** w:docGrid. linePitch snaps line heights up to a multiple; very common in Chinese government documents. */
  readonly grid: { readonly type: 'lines' | 'linesAndChars' | 'snapToChars'; readonly linePitch: Pt; readonly charSpace?: number } | null
}

export interface PageSetup {
  readonly widthPt: Pt
  readonly heightPt: Pt
  readonly margin: { readonly top: Pt; readonly right: Pt; readonly bottom: Pt; readonly left: Pt; readonly header: Pt; readonly footer: Pt; readonly gutter: Pt }
}

// ---- Styles, lists, media: tables the bridge fills at import ------------------------------------------------------

/** The resolved look of text: what rdocx's cascade gives for a (paragraph style, character style) pair. */
export interface RunLook {
  readonly fonts: { readonly ascii: string; readonly hAnsi: string; readonly eastAsia: string; readonly cs: string; readonly hint?: 'eastAsia' | 'cs' }
  readonly sizePt: Pt
  readonly bold: boolean
  readonly italic: boolean
  readonly underline: boolean
  readonly strike: boolean
  readonly color: Hex | 'auto'
  readonly highlight?: HighlightName
  readonly caps: boolean
  readonly charSpacingPt: Pt
}

export interface ParaLook {
  readonly align: NonNullable<ParaProps['align']>
  readonly indent: Required<NonNullable<ParaProps['indent']>>
  readonly spacing: { readonly before: Pt; readonly after: Pt; readonly line: LineSpacing; readonly contextual: boolean }
  readonly numbering: { readonly num: NumId; readonly level: number } | null
  readonly keepNext: boolean
  readonly keepLines: boolean
  readonly pageBreakBefore: boolean
  readonly widowControl: boolean
}

export interface StyleSheet {
  readonly paragraph: ReadonlyMap<StyleId, { readonly name: string; readonly role: StyleRole | null; readonly next: StyleId | null; readonly basedOn?: StyleId | null; readonly look: ParaLook }>
  readonly character: ReadonlyMap<StyleId, { readonly name: string }>
  readonly defaultParagraph: StyleId
  /** Built-in styles the editor applied but the pristine document lacks. write.rs adds each with add_style. */
  readonly added: readonly StyleRole[]
}

/** The roles the style dropdown offers first, matched by w:name ("heading 1"), which Word keeps English in every locale. */
export type StyleRole = 'normal' | 'title' | 'heading1' | 'heading2' | 'heading3'

export interface ListTable {
  readonly byNum: ReadonlyMap<NumId, ListDef>
}

export interface ListDef {
  /** Created this session: write.rs calls add_list_definition and maps the negative NumId to the real one. */
  readonly fresh: boolean
  readonly levels: readonly ListLevel[]
}

export interface ListLevel {
  readonly format: 'bullet' | 'decimal' | 'chineseCounting' | 'ideographTraditional' | 'decimalEnclosedCircle' | 'lowerLetter' | 'upperLetter' | 'lowerRoman' | 'upperRoman' | 'none'
  /** w:lvlText, e.g. "%1." or "（%1）". */
  readonly text: string
  readonly start: number
  readonly indentLeft: Pt
  readonly hanging: Pt
  readonly font?: string
}

export interface MediaTable {
  readonly byKey: ReadonlyMap<MediaKey, { readonly contentType: string; readonly origin: 'pristine' | 'added' }>
}

// ---- Positions and selection ---------------------------------------------------------------------------------------

/** A caret position: a UTF-16 offset into the paragraph's flat text, where each atom counts one. */
export interface Pos {
  readonly p: ParaId
  readonly o: number
}

export interface CellAddr {
  readonly row: number
  readonly cell: number
}

export type Selection =
  | { readonly kind: 'text'; readonly anchor: Pos; readonly head: Pos }
  | { readonly kind: 'cells'; readonly table: TableId; readonly anchor: CellAddr; readonly head: CellAddr }

/** Where a paragraph lives. Derived from the doc, never stored. */
export interface ParaLoc {
  readonly story: 'body' | StoryKey
  /** Indexes from the story root: [block] for body paragraphs, [block, row, cell, block, ...] inside tables. */
  readonly path: readonly number[]
  /** Document order across all body paragraphs, for comparing positions. */
  readonly order: number
  readonly para: Paragraph
}

export interface DocIndex {
  get(id: ParaId): ParaLoc
  /** Paragraphs in document order, cells included. */
  readonly ordered: readonly ParaId[]
}

// ---- Pure helpers --------------------------------------------------------------------------------------------------

const MARK_KEYS = [
  'bold', 'italic', 'underline', 'strike', 'font', 'fontEastAsia', 'sizePt', 'color', 'highlight', 'vertAlign', 'charStyle', 'link',
] as const satisfies readonly (keyof Marks)[]

const textCache = new WeakMap<Paragraph, string>()
let idCounter = 1

// Two slots are the undo/redo pair. The third keeps that pair when a command indexes one
// intermediate body, the cleared selection, before the next keystroke indexes the result.
export const INDEX_CACHE_LIMIT = 3

interface IndexEntry {
  readonly body: readonly Block[]
  readonly index: DocIndex
}

const indexCache: IndexEntry[] = []

/** Paragraph index of the most recently used bodies. Past INDEX_CACHE_LIMIT the least recently used is dropped, so a body the undo history still holds is rebuilt on its next use. O(paragraphs), about 0.3 ms at 100 pages. */
export function indexOf(doc: Doc): DocIndex {
  for (let i = 0; i < indexCache.length; i++) {
    const entry = indexCache[i]
    if (!entry || entry.body !== doc.body) continue
    if (i !== 0) {
      indexCache.splice(i, 1)
      indexCache.unshift(entry)
    }
    return entry.index
  }
  const built = buildIndex(doc)
  indexCache.unshift({ body: doc.body, index: built })
  if (indexCache.length > INDEX_CACHE_LIMIT) indexCache.pop()
  return built
}

/** The paragraph's flat text: run text, with U+FFFC for each atom. Length is the paragraph's offset range. */
export function flatText(para: Paragraph): string {
  const cached = textCache.get(para)
  if (cached !== undefined) return cached
  let text = ''
  for (const inline of para.inlines) text += inline.kind === 'text' ? inline.text : '\uFFFC'
  textCache.set(para, text)
  return text
}

export function comparePos(index: DocIndex, a: Pos, b: Pos): -1 | 0 | 1 {
  const left = index.get(a.p)
  const right = index.get(b.p)
  if (left.order < right.order) return -1
  if (left.order > right.order) return 1
  if (a.o < b.o) return -1
  if (a.o > b.o) return 1
  return 0
}

/** Merge adjacent runs with equal src and marks, drop empty runs. Every command that edits inlines ends here. */
export function normalizeInlines(inlines: readonly Inline[]): readonly Inline[] {
  const out: Inline[] = []
  let changed = false
  for (const inline of inlines) {
    if (inline.kind === 'atom') {
      out.push(inline)
      continue
    }
    if (inline.text.length === 0) {
      changed = true
      continue
    }
    const prev = out[out.length - 1]
    if (prev && prev.kind === 'text' && prev.src === inline.src && marksEqual(prev.marks, inline.marks)) {
      out[out.length - 1] = { ...prev, text: prev.text + inline.text }
      changed = true
      continue
    }
    out.push(inline)
  }
  if (!changed && out.length === inlines.length) return inlines
  return out
}

/** Which inline covers offset o, and the offset inside it. At a boundary, prefers the inline before (Word's rule). */
export function inlineAt(para: Paragraph, o: number): { index: number; offset: number } {
  const inlines = para.inlines
  if (inlines.length === 0) return { index: 0, offset: 0 }
  if (o <= 0) return { index: 0, offset: 0 }
  let cursor = 0
  for (let i = 0; i < inlines.length; i++) {
    const inline = inlines[i]
    if (!inline) break
    const len = inline.kind === 'text' ? inline.text.length : 1
    const next = cursor + len
    if (o <= next) return { index: i, offset: o - cursor }
    cursor = next
  }
  const last = inlines.length - 1
  const tail = inlines[last]
  const tailLen = tail?.kind === 'text' ? tail.text.length : 1
  return { index: last, offset: tailLen }
}

/**
 * Marks and run src typed text inherits at `o`.
 * Stored marks are applied by the caller: this is the run before the caret (the run after, at offset 0).
 * An atom has no text src to extend, so the src is null and marks come from the nearest text run.
 */
export function marksAt(para: Paragraph, o: number): { marks: Marks; src: RunSrc | null } {
  if (para.inlines.length === 0) return { marks: {}, src: null }
  const at = inlineAt(para, o)
  const inline = para.inlines[at.index]
  if (inline?.kind === 'text') return { marks: inline.marks, src: inline.src }
  if (at.offset > 0) {
    for (let i = at.index - 1; i >= 0; i--) {
      const prev = para.inlines[i]
      if (prev?.kind === 'text') return { marks: prev.marks, src: null }
    }
  }
  for (let i = at.index + 1; i < para.inlines.length; i++) {
    const next = para.inlines[i]
    if (next?.kind === 'text') return { marks: next.marks, src: null }
  }
  for (let i = at.index - 1; i >= 0; i--) {
    const prev = para.inlines[i]
    if (prev?.kind === 'text') return { marks: prev.marks, src: null }
  }
  return { marks: {}, src: null }
}

/** Throws with the first violated invariant (1 to 6 above). Tests and debug builds only. */
export function checkDoc(doc: Doc, baseline?: Doc): void {
  const seen = new Set<ParaId>()
  checkStory(doc.body, seen)
  for (const blocks of doc.stories.values()) checkStory(blocks, seen)
  if (!baseline) return
  const lockedNow = collectLocked(doc)
  const lockedBase = collectLocked(baseline)
  if (!sameRefs(lockedBase, lockedNow)) throw new Error('invariant 5: locked paragraph changed')
  const atomsNow = collectFixedAtoms(doc)
  const atomsBase = collectFixedAtoms(baseline)
  if (!sameRefs(atomsBase, atomsNow)) throw new Error('invariant 5: non-removable atom changed')
}

export function newParaId(): ParaId {
  return `id-${idCounter++}` as ParaId
}

function marksEqual(a: Marks, b: Marks): boolean {
  for (const key of MARK_KEYS) {
    if (a[key] !== b[key]) return false
  }
  return true
}

function buildIndex(doc: Doc): DocIndex {
  const byId = new Map<ParaId, ParaLoc>()
  const ordered: ParaId[] = []
  let order = 0
  const visitPara = (para: Paragraph, story: 'body' | StoryKey, path: number[]): void => {
    if (byId.has(para.id)) throw new Error(`duplicate paragraph id ${para.id}`)
    const loc: ParaLoc = { story, path, order, para }
    order += 1
    byId.set(para.id, loc)
    ordered.push(para.id)
  }
  const visitBlocks = (blocks: readonly Block[], story: 'body' | StoryKey, prefix: number[]): void => {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]
      if (!block) continue
      const path = prefix.concat(i)
      if (block.kind === 'p') visitPara(block, story, path)
      else if (block.kind === 'table') {
        for (let r = 0; r < block.rows.length; r++) {
          const row = block.rows[r]
          if (!row) continue
          for (let c = 0; c < row.cells.length; c++) {
            const cell = row.cells[c]
            if (!cell) continue
            visitBlocks(cell.blocks, story, path.concat(r, c))
          }
        }
      } else {
        for (let p = 0; p < block.preview.length; p++) {
          const para = block.preview[p]
          if (para) visitPara(para, story, path.concat(p))
        }
      }
    }
  }
  visitBlocks(doc.body, 'body', [])
  for (const [key, blocks] of doc.stories) visitBlocks(blocks, key, [])
  return {
    get(id: ParaId): ParaLoc {
      const loc = byId.get(id)
      if (!loc) throw new Error(`unknown paragraph ${id}`)
      return loc
    },
    ordered,
  }
}

interface SrcCursor {
  para: number | null
  run: number | null
}

function checkStory(blocks: readonly Block[], seen: Set<ParaId>): void {
  const cursor: SrcCursor = { para: null, run: null }
  checkBlocks(blocks, cursor, seen)
}

function checkBlocks(blocks: readonly Block[], cursor: SrcCursor, seen: Set<ParaId>): void {
  for (const block of blocks) {
    if (block.kind === 'p') checkParagraph(block, cursor, seen)
    else if (block.kind === 'table') {
      for (const row of block.rows) {
        for (const cell of row.cells) {
          if (cell.blocks.length === 0) throw new Error('invariant 6: empty cell')
          const last = cell.blocks[cell.blocks.length - 1]
          if (!last || last.kind !== 'p') throw new Error('invariant 6: cell does not end with a paragraph')
          checkBlocks(cell.blocks, cursor, seen)
        }
      }
    } else {
      for (const para of block.preview) checkParagraph(para, cursor, seen)
    }
  }
}

function checkParagraph(para: Paragraph, cursor: SrcCursor, seen: Set<ParaId>): void {
  if (seen.has(para.id)) throw new Error(`duplicate paragraph id ${para.id}`)
  seen.add(para.id)
  if (para.src !== null) {
    if (cursor.para !== null && para.src < cursor.para) throw new Error('invariant 3: paragraph src order')
    cursor.para = para.src
  }
  let prev: TextRun | null = null
  for (const inline of para.inlines) {
    if (inline.kind === 'atom') {
      prev = null
      if (inline.src !== null) {
        if (cursor.run !== null && inline.src < cursor.run) throw new Error('invariant 3: run src order')
        cursor.run = inline.src
      }
      continue
    }
    if (inline.text.length === 0) throw new Error('invariant 2: empty text run')
    if (inline.text.includes('\uFFFC')) throw new Error('invariant 2: text run contains U+FFFC')
    if (prev && prev.src === inline.src && marksEqual(prev.marks, inline.marks)) {
      throw new Error('invariant 4: adjacent text runs must be merged')
    }
    if (inline.src !== null) {
      if (cursor.run !== null && inline.src < cursor.run) throw new Error('invariant 3: run src order')
      cursor.run = inline.src
    }
    prev = inline
  }
}

function collectLocked(doc: Doc): Paragraph[] {
  const out: Paragraph[] = []
  const walk = (blocks: readonly Block[]): void => {
    for (const block of blocks) {
      if (block.kind === 'p') {
        if (block.lock) out.push(block)
      } else if (block.kind === 'table') {
        for (const row of block.rows) for (const cell of row.cells) walk(cell.blocks)
      } else {
        for (const para of block.preview) if (para.lock) out.push(para)
      }
    }
  }
  walk(doc.body)
  for (const blocks of doc.stories.values()) walk(blocks)
  return out
}

function collectFixedAtoms(doc: Doc): Atom[] {
  const out: Atom[] = []
  const walkPara = (para: Paragraph): void => {
    for (const inline of para.inlines) {
      if (inline.kind === 'atom' && inline.atom.type === 'opaque' && !inline.atom.removable) out.push(inline)
    }
  }
  const walk = (blocks: readonly Block[]): void => {
    for (const block of blocks) {
      if (block.kind === 'p') walkPara(block)
      else if (block.kind === 'table') {
        for (const row of block.rows) for (const cell of row.cells) walk(cell.blocks)
      } else {
        for (const para of block.preview) walkPara(para)
      }
    }
  }
  walk(doc.body)
  for (const blocks of doc.stories.values()) walk(blocks)
  return out
}

function sameRefs<T extends object>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false
  const counts = new Map<T, number>()
  for (const item of a) counts.set(item, (counts.get(item) ?? 0) + 1)
  for (const item of b) {
    const count = counts.get(item)
    if (count === undefined) return false
    if (count === 1) counts.delete(item)
    else counts.set(item, count - 1)
  }
  return counts.size === 0
}
