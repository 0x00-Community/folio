// Where blocks are on screen. Owns measurement, pagination, page mounting with virtualization, caret and selection
// painting, hit testing, and line motion. Pagination itself is a pure function over measures, so it is unit-tested
// without a DOM; PageView is the thin DOM side.
import type { Doc, Block, BlockId, Pos, Selection, StoryKey, Section } from '../model'
import type { RenderContext, Decoration } from './render'

// ---- Measurement -----------------------------------------------------------------------------------------------------

/** What pagination needs to know about one block at one content width. Cached per block object (WeakMap). */
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

/** Reads a mounted or hidden block element: offsetHeight, plus line bottoms grouped from Range.getClientRects(). */
export function measureElement(el: HTMLElement, zoom: number): Measure {
  throw new Error('not implemented')
}

// ---- Pagination (pure) -----------------------------------------------------------------------------------------------

/** A vertical part of one body block on one page. y0 and y1 are px offsets into the block's own box. */
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

/**
 * Word's block-level page rules over cached measures: pageBreakBefore, keepNext chains (capped at one page),
 * keepLines, widow and orphan control, section breaks, rows that cannot split, header rows, and space-before
 * suppression at the top of a page after a soft break.
 *
 * Incremental: with `previous` and `changed`, starts at the page holding the first changed block and stops at the first
 * page whose start (block, y0) equals the previous layout's page start at the same index, reusing the rest.
 */
export function paginate(
  doc: Doc,
  measure: (block: Block, section: Section) => Measure | undefined,
  previous: Layout | null,
  changed: readonly BlockId[],
): Layout {
  throw new Error('not implemented')
}

// ---- DOM side --------------------------------------------------------------------------------------------------------

export interface CaretRect {
  readonly page: number
  readonly x: number
  readonly top: number
  readonly height: number
}

/**
 * Owns the pages container. Mounts the visible pages plus one on each side (IntersectionObserver); every other page
 * is an empty box of its exact size, so scroll geometry is exact without contents. All coordinates it returns are
 * page-container px at 100 percent zoom; zoom is a transform on the container, and this class divides it out.
 */
export class PageView {
  constructor(host: HTMLElement, ctx: () => RenderContext) {
    throw new Error('not implemented')
  }

  /** Full rebuild: measure every block in chunks of about 200 per task, mount pages as they fill. */
  show(doc: Doc): void {
    throw new Error('not implemented')
  }

  /**
   * After a transaction. Finds changed blocks by identity, re-renders their mounted copies, re-measures them,
   * repaginates incrementally, and moves slices between mounted pages. Unmounted pages only get new slice lists.
   */
  update(previous: Doc, next: Doc): void {
    throw new Error('not implemented')
  }

  /** IME preedit. Re-renders and re-measures one block without touching the measure cache. */
  decorate(deco: Decoration | null): void {
    throw new Error('not implemented')
  }

  get layout(): Layout {
    throw new Error('not implemented')
  }

  // ---- Geometry. Each mounts the page it needs first, so motion across unmounted pages works. ----

  caretRect(pos: Pos): CaretRect {
    throw new Error('not implemented')
  }

  /**
   * Click and drag. Clamps (x, y) into the nearest slice's visible box on that page, then calls
   * document.caretPositionFromPoint and maps the DOM point with render.posFromDom.
   */
  posAtPoint(clientX: number, clientY: number): Pos | null {
    throw new Error('not implemented')
  }

  /**
   * Up and Down. Finds the next line box below or above the caret's (crossing slices and pages), then hit-tests at
   * goalX on that line's middle. Returns the goal to keep for the next vertical move.
   */
  lineMove(pos: Pos, direction: 'up' | 'down', goalX: number | null): { pos: Pos; goalX: number } {
    throw new Error('not implemented')
  }

  /** PageUp and PageDown: scrolls one viewport and hit-tests at the same viewport offset and goalX. */
  pageMove(pos: Pos, direction: 'up' | 'down', goalX: number | null): { pos: Pos; goalX: number } {
    throw new Error('not implemented')
  }

  /** Home and End: the first or last offset on the caret's visual line. */
  lineEdge(pos: Pos, edge: 'start' | 'end'): Pos {
    throw new Error('not implemented')
  }

  /** Draws the caret div and selection rects in per-page overlays, clipped to slice boxes. Moves the input sink. */
  paint(sel: Selection, sink: HTMLTextAreaElement): void {
    throw new Error('not implemented')
  }

  scrollIntoView(pos: Pos): void {
    throw new Error('not implemented')
  }

  /** Changes the container transform only. Measures and pagination stay valid. */
  setZoom(zoom: number): void {
    throw new Error('not implemented')
  }

  /** Page index (0-based) holding a position, from the layout, without touching the DOM. */
  pageOf(pos: Pos): number {
    throw new Error('not implemented')
  }

  destroy(): void {
    throw new Error('not implemented')
  }
}
