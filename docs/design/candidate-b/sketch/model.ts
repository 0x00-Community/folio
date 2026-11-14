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
    /** w:firstLineChars in hundredths of a character (200 is the common 首行缩进 2 字符). Read-only until rdocx can set it. */
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

export interface Table {
  readonly kind: 'table'
  readonly id: TableId
  readonly src: TableSrc | null
  readonly props: { readonly style?: StyleId; readonly align?: 'left' | 'center' | 'right'; readonly widthPt?: Pt }
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
  readonly paragraph: ReadonlyMap<StyleId, { readonly name: string; readonly role: StyleRole | null; readonly next: StyleId | null; readonly look: ParaLook }>
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

/** Derived paragraph index, cached per body array identity. O(paragraphs) to rebuild, about 0.3 ms at 100 pages. */
export function indexOf(doc: Doc): DocIndex {
  throw new Error('not implemented')
}

/** The paragraph's flat text: run text, with U+FFFC for each atom. Length is the paragraph's offset range. */
export function flatText(para: Paragraph): string {
  throw new Error('not implemented')
}

export function comparePos(index: DocIndex, a: Pos, b: Pos): -1 | 0 | 1 {
  throw new Error('not implemented')
}

/** Merge adjacent runs with equal src and marks, drop empty runs. Every command that edits inlines ends here. */
export function normalizeInlines(inlines: readonly Inline[]): readonly Inline[] {
  throw new Error('not implemented')
}

/** Which inline covers offset o, and the offset inside it. At a boundary, prefers the inline before (Word's rule). */
export function inlineAt(para: Paragraph, o: number): { index: number; offset: number } {
  throw new Error('not implemented')
}

/** The marks typed text gets at this position: the stored marks if any, else the marks of the run before the caret. */
export function marksAt(para: Paragraph, o: number): { marks: Marks; src: RunSrc | null } {
  throw new Error('not implemented')
}

/** Throws with the first violated invariant (1 to 6 above). Tests and debug builds only. */
export function checkDoc(doc: Doc, baseline?: Doc): void {
  // TODO: walk every story. Check run text, non-decreasing src order per story, normalization, and cells ending in a
  // paragraph. With a baseline doc, also check that locked paragraphs and non-removable atoms are the same objects.
  throw new Error('not implemented')
}

export function newParaId(): ParaId {
  throw new Error('not implemented')
}
