// Hand-written mirror of engine/src/wire.rs. serde JSON is camelCase.
// A Rust test fails when an imported document contains a key this file does not mention.

export type BlockKind = 'p' | 'table' | 'opaque'

export type Imported = {
  body: Block[]
  sections: Section[]
  stories: [string, Block[]][]
  styles: StyleSheet
  lists: [number, ListDef][]
  media: [string, string][]
  fonts: string[]
  runLooks: RunLookEntry[]
  paraLooks: ParaLookEntry[]
}

export type RunLookEntry = {
  para: string
  character?: string | null
  look: RunLook
}

export type ParaLookEntry = {
  style: string
  look: ParaLook
}

export type Block = Para | Table | Opaque

export type Para = {
  kind: 'p'
  src?: number | null
  props: ParaProps
  inlines: Inline[]
  lock?: string | null
  sectionEnd?: number | null
}

export type Inline =
  | { kind: 'text'; text: string; marks: Marks; src?: number | null }
  | { kind: 'atom'; atom: Atom; src?: number | null }

export type Atom =
  | { type: 'image'; media: string; widthPt: number; heightPt: number }
  | { type: 'field'; field: string; display: string }
  | { type: 'pageBreak' }
  | { type: 'columnBreak' }
  | { type: 'opaque'; label: string; display: string; removable: boolean }

export type Marks = {
  bold?: boolean | null
  italic?: boolean | null
  underline?: boolean | null
  strike?: boolean | null
  font?: string | null
  fontEastAsia?: string | null
  sizePt?: number | null
  color?: string | null
  highlight?: string | null
  vertAlign?: string | null
  charStyle?: string | null
  link?: string | null
}

export type ParaProps = {
  style?: string | null
  align?: string | null
  indentLeft?: number | null
  indentRight?: number | null
  firstLine?: number | null
  hanging?: number | null
  firstLineChars?: number | null
  spaceBefore?: number | null
  spaceAfter?: number | null
  line?: LineSpacing | null
  numbering?: [number, number] | null
  keepNext?: boolean | null
  keepLines?: boolean | null
  pageBreakBefore?: boolean | null
  widowControl?: boolean | null
}

export type LineSpacing =
  | { rule: 'auto'; multiple: number }
  | { rule: 'exact'; pt: number }
  | { rule: 'atLeast'; pt: number }

export type Table = {
  kind: 'table'
  src?: number | null
  gridPt: number[]
  rows: Row[]
}

export type Row = {
  src?: number | null
  header: boolean
  cantSplit: boolean
  cells: Cell[]
}

export type Cell = {
  src?: number | null
  span: number
  vMerge?: string | null
  blocks: Block[]
}

export type Opaque = {
  kind: 'opaque'
  src: number
  label: string
  preview: Para[]
  removable: boolean
}

export type Section = {
  src?: number | null
  widthPt: number
  heightPt: number
  marginsPt: number[]
  breakType: string
  titlePage: boolean
  headers: [string, string][]
  footers: [string, string][]
  grid?: [string, number, number | null] | null
}

export type StyleSheet = {
  paragraph: ParaStyle[]
  character: [string, string][]
  defaultParagraph: string
}

export type ParaStyle = {
  id: string
  name: string
  role?: string | null
  next?: string | null
}

export type ListDef = {
  fresh: boolean
  levels: ListLevel[]
}

export type ListLevel = {
  format: string
  text: string
  start: number
  indentLeftPt: number
  hangingPt: number
}

export type RunFonts = {
  ascii: string
  hAnsi: string
  eastAsia: string
  cs: string
  hint?: string | null
}

export type RunLook = {
  fonts: RunFonts
  sizePt: number
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  color: string
  highlight?: string | null
  caps: boolean
  charSpacingPt: number
}

export type ParaIndent = {
  left: number
  right: number
  firstLine: number
  hanging: number
  firstLineChars?: number | null
}

export type ParaSpacing = {
  before: number
  after: number
  line: LineSpacing
  contextual: boolean
}

export type ParaLook = {
  align: string
  indent: ParaIndent
  spacing: ParaSpacing
  numbering: [number, number] | null
  keepNext: boolean
  keepLines: boolean
  pageBreakBefore: boolean
  widowControl: boolean
}

/** A body block in a patch. `{ keep }` is the block import produced; anything else is the full block. */
export type PatchBlock = { keep: number } | Block

/** Bytes for one image key. `write` embeds each key once. */
export type MediaPart = {
  key: string
  fileName: string
  base64: string
}

/** What save sends. Field names match `wire::Patch` (camelCase). */
export type Patch = {
  body: PatchBlock[]
  sections: Section[]
  newLists: [number, ListDef][]
  addedStyles: string[]
  media: MediaPart[]
}
