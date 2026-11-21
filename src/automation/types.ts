// JSON shapes for `window.word`. A caller that holds only a response can write the next request.
// This file imports nothing: no model object, source identity, or function appears in these types.

/** A caret in one paragraph. `offset` counts UTF-16 code units of the paragraph's flat text, and each atom counts as one. `'end'` is that length. */
export interface Address {
  /** Paragraph id from a previous response. Ids survive edits that do not remove the paragraph. */
  para: string
  /** UTF-16 offset into the paragraph, or `'end'`. */
  offset: number | 'end'
}

/** A text selection. `anchor` is where it started and `head` is where it ends. */
export interface Range {
  /** The selection's anchor. */
  anchor: Address
  /** The selection's focus. */
  head: Address
}

/** An address selects a caret. A range selects the text between two addresses. */
export type Place = Address | Range

/** The selection after a call. Offsets are numbers, never `'end'`. */
export type SelectionView =
  | {
    /** A text selection. */
    kind: 'text'
    /** Anchor address with a numeric offset. */
    anchor: { para: string, offset: number }
    /** Head address with a numeric offset. */
    head: { para: string, offset: number }
  }
  | {
    /** A rectangular cell selection. */
    kind: 'cells'
    /** Table id. */
    table: string
    /** One corner of the rectangle. `row` and `cell` are zero-based. */
    anchor: { row: number, cell: number }
    /** The opposite corner. */
    head: { row: number, cell: number }
  }

/** Page size and margins in points, the same fields as the document's page setup. */
export interface PageSetupView {
  /** Page width in points. */
  widthPt: number
  /** Page height in points. */
  heightPt: number
  /** Page margins in points. */
  margin: {
    /** Top margin in points. */
    top: number
    /** Right margin in points. */
    right: number
    /** Bottom margin in points. */
    bottom: number
    /** Left margin in points. */
    left: number
    /** Header distance in points. */
    header: number
    /** Footer distance in points. */
    footer: number
    /** Gutter in points. */
    gutter: number
  }
}

/** Why a call was refused. `para` is set when the refusal is about one paragraph or block id. */
export type ErrorCode =
  | 'bad-request'
  | 'unknown-op'
  | 'unsupported-version'
  | 'unknown-address'
  | 'out-of-range'
  | 'locked'
  | 'read-only-story'
  | 'busy'
  | 'refused'

export interface Refusal {
  /** The call did not change the document. */
  ok: false
  /** Machine-readable cause. */
  error: {
    /** Closed set of reasons. */
    code: ErrorCode
    /** Names the field for `bad-request` and the op for `refused`. */
    message: string
    /** Paragraph or block id the refusal is about. */
    para?: string
  }
}

/** Direct run marks. `link` is `true` when the text is inside a hyperlink; the link identity is not included. */
export interface TextMarks {
  /** Bold, when set directly on the run. */
  bold?: boolean
  /** Italic, when set directly on the run. */
  italic?: boolean
  /** Underline, when set directly on the run. */
  underline?: boolean
  /** Strikethrough, when set directly on the run. */
  strike?: boolean
  /** Font family written to every font slot. */
  font?: string
  /** East Asian font slot. */
  fontEastAsia?: string
  /** Font size in points. */
  sizePt?: number
  /** Hex color `RRGGBB` without a leading `#`. */
  color?: string
  /** Highlight name. */
  highlight?: string
  /** Superscript or subscript. */
  vertAlign?: 'super' | 'sub'
  /** Character style id. */
  charStyle?: string
  /** True when this text is inside a hyperlink. */
  link?: true
}

/** One slice of a paragraph's flat text. Slices meet at their edges and cover `text` exactly. */
export type TextRunView =
  | {
    /** Inclusive UTF-16 start. */
    start: number
    /** Exclusive UTF-16 end. */
    end: number
    /** Direct marks on this slice. */
    marks: TextMarks
  }
  | {
    /** Inclusive UTF-16 start. An atom occupies one unit. */
    start: number
    /** Exclusive UTF-16 end. */
    end: number
    /** What the U+FFFC in `text` stands for. */
    atom: 'image' | 'field' | 'pageBreak' | 'columnBreak' | 'opaque'
    /** Field result or opaque label text. Omitted for images and breaks. */
    display?: string
  }

/** A paragraph's text, marks, style, and list marker. */
export interface ParagraphText {
  /** This block is a paragraph. */
  kind: 'paragraph'
  /** Paragraph id. */
  id: string
  /** Flat text. Each atom is U+FFFC. */
  text: string
  /** Slices that cover `text` in order with no gap or overlap. */
  runs: TextRunView[]
  /** Style id, or the document default when the paragraph does not name one. */
  style: string
  /** The paragraph's own alignment, or the alignment of `style`, or `left`. */
  align: 'left' | 'center' | 'right' | 'justify' | 'distribute'
  /** List level and marker text, or null when the paragraph is not in a list. */
  list: { level: number, marker: string } | null
  /** Lock reason (`revisions`, `unbalancedField`, `preview`), or null. */
  locked: string | null
}

/** A table, with the text view of every block in its cells. */
export interface TableText {
  /** This block is a table. */
  kind: 'table'
  /** Table id. */
  id: string
  /** Rows in order. */
  rows: {
    /** Cells in order. A horizontally merged cell appears once, with `span` greater than 1. */
    cells: {
      /** How many grid columns this cell covers. */
      span: number
      /** Vertical merge role, or null when the cell is not merged vertically. */
      vMerge: 'restart' | 'continue' | null
      /** Blocks inside the cell, in order. A cell ends with a paragraph. */
      blocks: TextBlock[]
    }[]
  }[]
}

/** An opaque block. Its preview paragraphs are strings, not editable blocks. */
export interface OpaqueText {
  /** This block is opaque. */
  kind: 'opaque'
  /** Opaque block id. */
  id: string
  /** Short label stored on the block. */
  label: string
  /** Flat text of each preview paragraph. */
  preview: string[]
}

/** One block in a `text` response. */
export type TextBlock = ParagraphText | TableText | OpaqueText

/** A top-level body block in a `blocks` response. `page` is 1-based, or null when layout has not reached the block. */
export type BlockView =
  | {
    /** Zero-based index in the body. */
    index: number
    /** Block id. */
    id: string
    /** This block is a paragraph. */
    kind: 'paragraph'
    /** Section index that contains the block. */
    section: number
    /** 1-based page, or null when the layout has not measured the block. */
    page: number | null
    /** Flat-text length. Each atom counts as one. */
    length: number
    /** Style id, or the document default when the paragraph does not name one. */
    style: string
    /** Heading level 1–9 from the style's name, or null. */
    heading: number | null
    /** Lock reason, or null. */
    locked: string | null
  }
  | {
    /** Zero-based index in the body. */
    index: number
    /** Block id. */
    id: string
    /** This block is a table. */
    kind: 'table'
    /** Section index that contains the block. */
    section: number
    /** 1-based page, or null when the layout has not measured the block. */
    page: number | null
    /** Number of rows. */
    rows: number
    /** Number of grid columns. */
    cols: number
  }
  | {
    /** Zero-based index in the body. */
    index: number
    /** Block id. */
    id: string
    /** This block is opaque. */
    kind: 'opaque'
    /** Section index that contains the block. */
    section: number
    /** 1-based page, or null when the layout has not measured the block. */
    page: number | null
    /** Short label stored on the block. */
    label: string
  }

/** One outline entry. `from` and `to` are body block indexes and `to` is inclusive. */
export interface HeadingView {
  /** Paragraph id. */
  id: string
  /** Heading level from 1 to 9. */
  level: number
  /** List marker text, or null when the heading is not numbered. */
  number: string | null
  /** Flat text of the heading paragraph. */
  text: string
  /** 1-based page, or null when the layout has not measured the heading. */
  page: number | null
  /** Body index of the heading itself. */
  from: number
  /** Body index of the last block before the next heading of the same or a higher level, or the last body block. */
  to: number
}

/** A match that lies entirely inside one paragraph. */
export interface FindMatch {
  /** Paragraph id. */
  para: string
  /** Inclusive UTF-16 start. */
  start: number
  /** Exclusive UTF-16 end. */
  end: number
}

/** What an edit did. `created` and `removed` are paragraph, table, and opaque ids, cells included. */
export interface EditOk {
  /** The edit was applied. */
  ok: true
  /** Advances by one when the document object changes and returns to 0 when another file is loaded. */
  rev: number
  /** Selection after the edit. */
  selection: SelectionView
  /** Ids that appeared, in document order. */
  created: string[]
  /** Ids that disappeared, in their previous document order. */
  removed: string[]
}

export interface InfoResponse {
  /** The read succeeded. */
  ok: true
  /** Advances by one when the document object changes and returns to 0 when another file is loaded. */
  rev: number
  /** File name shown for the open document. */
  name: string
  /** True when the document differs from the last save. */
  dirty: boolean
  /** Page count from the editing view. */
  pages: number
  /** False while a large document is still being measured. */
  pagesFinal: boolean
  /** Word count of the body, including cells and opaque previews. */
  words: number
  /** Number of top-level body blocks. */
  blocks: number
  /** Sections in order. */
  sections: {
    /** Zero-based section index. */
    index: number
    /** Page setup in points. */
    page: PageSetupView
    /** How the section starts. */
    breakType: 'nextPage' | 'continuous' | 'evenPage' | 'oddPage'
  }[]
  /** Paragraph styles. `heading` comes from the style name, not from its role. */
  styles: {
    /** Style id to pass to `setStyle`. */
    id: string
    /** Style name. A heading's name is `heading 1` through `heading 9` in any letter case. */
    name: string
    /** Heading level, or null when the name is not a heading. */
    heading: number | null
  }[]
}

export interface BlocksResponse {
  /** The read succeeded. */
  ok: true
  /** Advances by one when the document object changes and returns to 0 when another file is loaded. */
  rev: number
  /** Number of top-level body blocks. */
  total: number
  /** Body index of `blocks[0]`, or the requested start when the page is empty. */
  from: number
  /** Body index of the next page, or null when this page reaches the end. */
  next: number | null
  /** One page of top-level body blocks. */
  blocks: BlockView[]
}

export interface TextResponse {
  /** The read succeeded. */
  ok: true
  /** Advances by one when the document object changes and returns to 0 when another file is loaded. */
  rev: number
  /** For a page, the body block count. For `ids`, the number of blocks returned. */
  total: number
  /** Body index of the page, or 0 when the request named ids. */
  from: number
  /** Next page index, or null at the end and for an `ids` request. */
  next: number | null
  /** The requested blocks. */
  blocks: TextBlock[]
}

export interface OutlineResponse {
  /** The read succeeded. */
  ok: true
  /** Advances by one when the document object changes and returns to 0 when another file is loaded. */
  rev: number
  /** Top-level body headings, at most 5000. */
  headings: HeadingView[]
  /** True when the document has more than 5000 headings. */
  truncated: boolean
}

export interface FindResponse {
  /** The read succeeded. */
  ok: true
  /** Advances by one when the document object changes and returns to 0 when another file is loaded. */
  rev: number
  /** Matches in document order. */
  matches: FindMatch[]
  /** True when more matches exist than `limit` allows. */
  truncated: boolean
}

export interface SelectionResponse {
  /** The read succeeded. */
  ok: true
  /** Advances by one when the document object changes and returns to 0 when another file is loaded. */
  rev: number
  /** The editor's current selection. */
  selection: SelectionView
}

export interface HitTestResponse {
  /** The read succeeded. */
  ok: true
  /** Advances by one when the document object changes and returns to 0 when another file is loaded. */
  rev: number
  /** The address under the point, or null when the point misses the pages. */
  at: { para: string, offset: number } | null
}

export type ReadResponse =
  | InfoResponse
  | BlocksResponse
  | TextResponse
  | OutlineResponse
  | FindResponse
  | SelectionResponse
  | HitTestResponse

export type Response = ReadResponse | EditOk | Refusal

/** Reads. They do not change the document, including while the editor is busy. */
export type ReadRequest =
  | { op: 'info' }
  | { op: 'selection' }
  | {
    /** Page through top-level body blocks. */
    op: 'blocks'
    /** Body index to start at. Defaults to 0. */
    from?: number
    /** Page size. Defaults to 200 and is capped at 500. */
    count?: number
  }
  | {
    /** Page through top-level body blocks as text. */
    op: 'text'
    /** Body index to start at. Defaults to 0. */
    from?: number
    /** Page size. Defaults to 200 and is capped at 500. */
    count?: number
  }
  | {
    /** Text for these paragraph, table, or opaque ids, at most 500, in this order. */
    op: 'text'
    /** Ids to read. */
    ids: string[]
  }
  | { op: 'outline' }
  | {
    /** Find `text` inside single paragraphs, in document order, including table cells. */
    op: 'find'
    /** The text to find. An empty string is `bad-request`. */
    text: string
    /** Start at this address. Matches that start earlier are skipped. */
    from?: Address
    /** Maximum matches. Defaults to 100 and is capped at 1000. */
    limit?: number
    /** When false or omitted, letter case is ignored. */
    matchCase?: boolean
  }
  | {
    /** Map a window point to an address. This is the only view-dependent read. */
    op: 'hitTest'
    /** Viewport x in CSS pixels. */
    clientX: number
    /** Viewport y in CSS pixels. */
    clientY: number
  }

/**
 * Edits. Each one runs through the editor's commands, so undo and save see it.
 * `at` sets the selection first. If the op is refused, the selection is left as it was.
 */
export type EditRequest = { at?: Place } & (
  | {
    /** Move the selection to `at`. Selecting what is already selected answers `ok`. */
    op: 'select'
    /** The caret or range to select. */
    at: Place
  }
  | {
    /** Select a rectangle of cells. */
    op: 'selectCells'
    /** Table id. */
    table: string
    /** One corner. `row` and `cell` are zero-based. */
    anchor: { row: number, cell: number }
    /** The opposite corner. */
    head: { row: number, cell: number }
  }
  | { op: 'selectAll' }
  | {
    /**
     * Text passed to `insertText` unchanged.
     * A "\n" splits the paragraph, and the new paragraph keeps the current style.
     * It does not apply the style's next style; `enter` does that.
     * A "\t" stays in the paragraph as a tab character. It does not move to another cell or change a list level.
     */
    op: 'insertText'
    /** The text to insert. Longer than 1,000,000 UTF-16 units is `bad-request`. */
    text: string
  }
  | {
    /** Split the paragraph, as Enter does. At the end of a style that names a next style, the new paragraph takes that style. */
    op: 'enter'
  }
  | {
    /** Insert a line break inside the paragraph (U+000A). The paragraph stays one block. */
    op: 'lineBreak'
  }
  | {
    /** Insert a page-break atom at the caret. */
    op: 'pageBreak'
  }
  | {
    /**
     * Without `direction`, delete the selection. A collapsed selection changes nothing and the op is refused.
     * With `direction`, delete backward or forward. `unit` defaults to a character.
     */
    op: 'delete'
    /** Omit to delete the selection. */
    direction?: 'backward' | 'forward'
    /** Used with `direction`. Defaults to `char`. */
    unit?: 'char' | 'word'
  }
  | {
    /** Toggle a character mark on the selection, or store it at a collapsed caret. */
    op: 'toggleMark'
    /** The mark to toggle. */
    mark: 'bold' | 'italic' | 'underline' | 'strike'
  }
  | {
    /**
     * Set one character property `setMark` accepts: `font`, `fontEastAsia`, `sizePt`, `color`, `highlight`, or `vertAlign`.
     * `null` clears it. A mark outside that set is `bad-request`.
     */
    op: 'setMark'
    /** Which property to set. */
    mark: string
    /** The new value, or null to clear it. The accepted type depends on `mark`. */
    value: string | number | boolean | null
  }
  | {
    /** Apply a paragraph style by id, from `info.styles` or a built-in role id the editor can add. */
    op: 'setStyle'
    /** Style id, not the style's display name. */
    style: string
  }
  | {
    /** Set the paragraph alignment. */
    op: 'setAlign'
    /** Alignment. */
    align: 'left' | 'center' | 'right' | 'justify' | 'distribute'
  }
  | {
    /** Merge paragraph indents, in points. An omitted edge is left unchanged, including a stored first-line character indent. */
    op: 'setIndent'
    /** Left indent in points. */
    left?: number
    /** Right indent in points. */
    right?: number
    /** First-line indent in points. */
    firstLine?: number
    /** Hanging indent in points. */
    hanging?: number
  }
  | {
    /**
     * Set line spacing. For `auto`, `value` is a multiple of single spacing (1 is single).
     * For `exact` and `atLeast`, `value` is points.
     */
    op: 'setLineSpacing'
    /** Spacing rule. */
    rule: 'auto' | 'exact' | 'atLeast'
    /** Multiple for `auto`, or points for `exact` and `atLeast`. */
    value: number
  }
  | {
    /** Raise or lower the list level. Outside a list, one step is 36 points of left indent. */
    op: 'indentLevel'
    /** `1` indents and `-1` outdents. */
    delta: 1 | -1
  }
  | {
    /** Turn a bullet or decimal list on, or off when every touched paragraph already has that kind. */
    op: 'toggleList'
    /** List kind. */
    list: 'bullet' | 'decimal'
  }
  | {
    /** Insert a table at the caret. More than 500 rows or 63 columns is `bad-request`. */
    op: 'insertTable'
    /** Row count, at least 1. */
    rows: number
    /** Column count, at least 1. */
    cols: number
  }
  | {
    /** Insert a row beside the row that holds the selection. */
    op: 'insertRow'
    /** Which side of the current row. */
    where: 'above' | 'below'
  }
  | { op: 'deleteRows' }
  | {
    /** Insert a column beside the column that holds the selection. */
    op: 'insertColumn'
    /** Which side of the current column. */
    where: 'left' | 'right'
  }
  | { op: 'deleteColumns' }
  | {
    /** Delete `table`, or the table that holds the selection when `table` is omitted. */
    op: 'deleteTable'
    /** Table id. Omit to delete the table around the selection. */
    table?: string
  }
  | {
    /** Decode `base64` and insert it as an image. The content type must be `image/png` or `image/jpeg`. */
    op: 'insertImage'
    /** Standard base64, without a data-URL prefix. */
    base64: string
    /** Image MIME type. */
    contentType: string
  }
  | {
    /** Replace one section's page setup. */
    op: 'setPageSetup'
    /** Zero-based section index. */
    section: number
    /** The new page setup, in points. */
    page: PageSetupView
  }
  | { op: 'undo' }
  | { op: 'redo' }
)

/** A request. Omit `v` or pass 1. Any other `v` is `unsupported-version`. */
export type Request = { v?: 1 } & (ReadRequest | EditRequest)
