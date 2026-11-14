// What one block looks like in the DOM, and the mapping between DOM points and Pos. The only module that knows the span
// structure below; pages.ts and input.ts go through these functions and never read data-* attributes themselves.
//
// DOM contract for a paragraph (one per mounted copy; a paragraph that straddles a page break is mounted twice):
//
//   <div class="blk p" data-id="p12" style="padding-top/bottom: spacing; text-align; text-indent; padding-left/right">
//     <span class="marker" contenteditable="false">1.</span>   list marker, not part of the flat text
//     <span data-o="0" style="font-family: 'Times New Roman'; font-size: 16px; line-height: 20.8px">Hello </span>
//     <span data-o="6" style="font-family: 宋体, SimSun, 'Songti SC'; ...">世界</span>   one span per run and script segment
//     <img data-o="8" class="atom">                               an atom covers offsets 8..9
//     <span data-o="9" class="preedit">ni</span>                 IME decoration, never counted in offsets
//   </div>
//
// Each text span holds exactly one text node whose characters are flat-text offsets data-o.. data-o+length.
// An empty paragraph holds one span data-o="0" with U+200B, sized by the paragraph mark's look, so it has a line box.
// Tables are <div class="blk t"><table> with each cell's blocks rendered by the same function.
// Paragraph spacing is padding, never margin, so CSS margin collapsing cannot change heights.

import type { Block, Paragraph, Pos, ParaId, Marks, RunLook, ParaLook, MediaKey, StyleId, LineSpacing, Pt, Section } from '../model'

/** View-only decorations. Rendered, never stored, never measured into the cache. */
export type Decoration = { readonly kind: 'preedit'; readonly pos: Pos; readonly text: string }

export interface RenderContext {
  /** Resolved look for a run: rdocx's (paragraph style, character style) look overlaid with direct marks. Cached. */
  look(para: Paragraph, marks: Marks): RunLook
  paraLook(para: Paragraph): ParaLook
  /** CSS font-family stack for a family name, from fonts.ts's alias table. */
  fontStack(family: string): string
  /** Word line height of one line of this font at this size, from the font file's OS/2 and hhea metrics (backend). */
  lineHeightPx(family: string, sizePt: Pt, rule: LineSpacing): number
  /** List marker text for a paragraph, derived from document order. Null when not in a list. */
  marker(id: ParaId): string | null
  imageUrl(key: MediaKey): string
  /** Section grid line pitch in px, or null. Line heights snap up to a multiple of it. */
  gridPitchPx: number | null
  /** Text inside page-number fields, set per page by pages.ts for header and footer stories. */
  pageField?: { page: number; pages: number }
}

/** Render one block. Pure in its inputs; pages.ts caches the result per block object and clones it to mount. */
export function renderBlock(block: Block, ctx: RenderContext, deco?: Decoration): HTMLElement {
  // TODO: paragraph: segment each TextRun by script (scriptSegments), one span each; atoms as <img> or
  // contenteditable=false spans with their display text; tabs stay "\t" under white-space: pre-wrap with
  // tab-size from the default tab stop; line-height set per span from ctx.lineHeightPx, snapped to the grid pitch.
  // table: <table> with colgroup from grid, rowspan from vMerge runs, each cell's blocks via renderBlock.
  // opaque: its preview paragraphs, inside a frame labelled with block.label.
  throw new Error('not implemented')
}

/**
 * Split text into segments that each use one font slot, the way Word and rdocx classify characters: CJK ideographs,
 * kana, hangul and full-width forms use the East Asian slot; the rest use ASCII, high ANSI or complex script slots.
 */
export function scriptSegments(text: string, look: RunLook): readonly { text: string; family: string }[] {
  throw new Error('not implemented')
}

/** The DOM point inside a rendered block element (one mounted copy) for a flat-text offset. */
export function domPoint(blockEl: HTMLElement, o: number): { node: Node; offset: number } {
  throw new Error('not implemented')
}

/** A DOM Range over [from, to) in one rendered paragraph element; collapsed when from === to. */
export function rangeIn(blockEl: HTMLElement, from: number, to: number): Range {
  throw new Error('not implemented')
}

/**
 * Map a DOM point (from caretPositionFromPoint) back to a model position. Null when the point is outside any editable
 * paragraph (a list marker resolves to offset 0, an atom to the nearer side, a U+200B placeholder to 0).
 */
export function posFromDom(node: Node, offset: number): Pos | null {
  throw new Error('not implemented')
}

/** The element of block `id` inside a mounted container. Pages may hold two copies; pages.ts picks by geometry. */
export function blockElements(root: ParentNode, id: ParaId | string): readonly HTMLElement[] {
  throw new Error('not implemented')
}

/** CSS for a section's page box and content box, in px at 100 percent zoom (1pt = 4/3 px). */
export function pageBoxStyle(section: Section): { page: Partial<CSSStyleDeclaration>; content: Partial<CSSStyleDeclaration> } {
  throw new Error('not implemented')
}

export const PT_TO_PX = 4 / 3

export type { StyleId }
