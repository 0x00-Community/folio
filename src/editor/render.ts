import { flatText } from '../model.ts'
import type {
  Atom,
  AtomKind,
  Block,
  HighlightName,
  LineSpacing,
  Marks,
  MediaKey,
  Paragraph,
  ParaId,
  ParaLook,
  Pos,
  Pt,
  RunLook,
  Section,
  Table,
} from '../model.ts'

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

export const PT_TO_PX = 4 / 3

const HIGHLIGHT: Record<HighlightName, string> = {
  yellow: '#ffff00',
  green: '#00ff00',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  blue: '#0000ff',
  red: '#ff0000',
  darkBlue: '#000080',
  darkCyan: '#008080',
  darkGreen: '#008000',
  darkMagenta: '#800080',
  darkRed: '#800000',
  darkYellow: '#808000',
  darkGray: '#808080',
  lightGray: '#c0c0c0',
  black: '#000000',
}

function isEastAsian(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x2e80 && cp <= 0x9fff) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7ff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe1f) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x1b000 && cp <= 0x1b16f) ||
    (cp >= 0x1f200 && cp <= 0x1f2ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}

function isComplex(cp: number): boolean {
  return (
    (cp >= 0x0590 && cp <= 0x05ff) ||
    (cp >= 0x0600 && cp <= 0x06ff) ||
    (cp >= 0x0900 && cp <= 0x097f) ||
    (cp >= 0x0e00 && cp <= 0x0e7f)
  )
}

function familyFor(cp: number, look: RunLook): string {
  if (isEastAsian(cp)) return look.fonts.eastAsia
  if (isComplex(cp)) return look.fonts.cs
  if (cp <= 0x7f) return look.fonts.ascii
  return look.fonts.hAnsi
}

/**
 * Split text into segments that each use one font slot, the way Word and rdocx classify characters: CJK ideographs,
 * kana, hangul and full-width forms use the East Asian slot; the rest use ASCII, high ANSI or complex script slots.
 */
export function scriptSegments(text: string, look: RunLook): readonly { text: string; family: string }[] {
  const out: { text: string; family: string }[] = []
  let buf = ''
  let family = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    const next = familyFor(cp, look)
    if (buf.length > 0 && next !== family) {
      out.push({ text: buf, family })
      buf = ''
    }
    family = next
    buf += ch
  }
  if (buf.length > 0) out.push({ text: buf, family })
  return out
}

function px(pt: number): number {
  return pt * PT_TO_PX
}

function readO(el: Element): number {
  const n = Number(el.getAttribute('data-o'))
  return Number.isFinite(n) ? n : 0
}

function blockHasPara(block: Block, id: ParaId): boolean {
  if (block.kind === 'p') return block.id === id
  if (block.kind === 'opaque') return block.preview.some((para) => para.id === id)
  for (const row of block.rows) {
    for (const cell of row.cells) {
      for (const child of cell.blocks) {
        if (blockHasPara(child, id)) return true
      }
    }
  }
  return false
}

function decoFor(block: Block, deco: Decoration | undefined): Decoration | undefined {
  if (!deco) return undefined
  return blockHasPara(block, deco.pos.p) ? deco : undefined
}

function lineHeight(ctx: RenderContext, para: Paragraph, family: string, sizePt: Pt): number {
  const rule = ctx.paraLook(para).spacing.line
  let height = ctx.lineHeightPx(family, sizePt, rule)
  const pitch = ctx.gridPitchPx
  if (pitch !== null && pitch > 0) height = Math.ceil(height / pitch - 1e-9) * pitch
  return height
}

function applyRun(
  span: HTMLElement,
  ctx: RenderContext,
  para: Paragraph,
  look: RunLook,
  family: string,
  marks: Marks,
): void {
  const sizePx = px(look.sizePt)
  span.style.fontFamily = ctx.fontStack(family)
  span.style.fontSize = `${marks.vertAlign ? sizePx * 0.7 : sizePx}px`
  span.style.lineHeight = `${lineHeight(ctx, para, family, look.sizePt)}px`
  span.style.fontWeight = look.bold ? '700' : '400'
  span.style.fontStyle = look.italic ? 'italic' : 'normal'
  const deco = [look.underline || marks.link ? 'underline' : '', look.strike ? 'line-through' : ''].filter((part) => part.length > 0)
  if (deco.length > 0) span.style.textDecoration = deco.join(' ')
  if (marks.link) span.style.color = '#0563c1'
  else if (look.color !== 'auto') span.style.color = `#${look.color}`
  if (look.highlight) span.style.backgroundColor = HIGHLIGHT[look.highlight]
  if (look.caps) span.style.textTransform = 'uppercase'
  if (look.charSpacingPt) span.style.letterSpacing = `${px(look.charSpacingPt)}px`
  if (marks.vertAlign === 'super' || marks.vertAlign === 'sub') span.style.verticalAlign = marks.vertAlign
}

function firstLinePx(ctx: RenderContext, para: Paragraph, look: ParaLook): number {
  if (look.indent.firstLineChars) {
    const run = ctx.look(para, {})
    return (look.indent.firstLineChars / 100) * px(run.sizePt)
  }
  return px(look.indent.firstLine)
}

function applyParaBox(el: HTMLElement, ctx: RenderContext, para: Paragraph): ParaLook {
  const look = ctx.paraLook(para)
  const before = px(look.spacing.before)
  const after = px(look.spacing.after)
  const left = px(look.indent.left)
  const hanging = px(look.indent.hanging)
  const right = px(look.indent.right)
  const marker = ctx.marker(para.id)
  el.style.paddingTop = `${before}px`
  el.style.paddingBottom = `${after}px`
  el.style.paddingRight = `${right}px`
  if (marker && hanging > 0) {
    el.style.paddingLeft = `${left}px`
    el.style.textIndent = '0'
  } else {
    el.style.paddingLeft = `${left + hanging}px`
    el.style.textIndent = `${firstLinePx(ctx, para, look) - hanging}px`
  }
  if (look.align === 'distribute') {
    el.style.textAlign = 'justify'
    el.style.textAlignLast = 'justify'
  } else {
    el.style.textAlign = look.align
  }
  el.dataset.keepNext = look.keepNext ? '1' : '0'
  el.dataset.keepLines = look.keepLines ? '1' : '0'
  el.dataset.pageBreakBefore = look.pageBreakBefore ? '1' : '0'
  el.dataset.widow = look.widowControl ? '1' : '0'
  el.dataset.spaceBefore = String(before)
  el.dataset.spaceAfter = String(after)
  return look
}

function fieldLabel(atom: Extract<AtomKind, { type: 'field' }>, ctx: RenderContext): string {
  if (atom.field === 'page' && ctx.pageField) return String(ctx.pageField.page)
  if (atom.field === 'numPages' && ctx.pageField) return String(ctx.pageField.pages)
  return atom.display
}

function renderAtom(atom: Atom, offset: number, ctx: RenderContext, para: Paragraph): HTMLElement {
  const kind = atom.atom
  if (kind.type === 'image') {
    const img = document.createElement('img')
    img.className = 'atom'
    img.dataset.o = String(offset)
    img.dataset.atom = 'image'
    img.alt = ''
    img.draggable = false
    img.src = ctx.imageUrl(kind.media)
    img.style.width = `${px(kind.widthPt)}px`
    img.style.height = `${px(kind.heightPt)}px`
    return img
  }
  const span = document.createElement('span')
  span.className = 'atom'
  span.dataset.o = String(offset)
  span.dataset.atom = kind.type
  span.contentEditable = 'false'
  if (kind.type === 'field') {
    span.classList.add('field')
    span.textContent = fieldLabel(kind, ctx)
  } else if (kind.type === 'opaque') {
    span.classList.add('opaque-atom')
    span.textContent = kind.display.length > 0 ? kind.display : kind.label
  } else {
    span.classList.add('break')
    span.textContent = '\u200b'
  }
  if (kind.type !== 'pageBreak' && kind.type !== 'columnBreak') {
    const look = ctx.look(para, {})
    applyRun(span, ctx, para, look, look.fonts.eastAsia, {})
  }
  return span
}

interface TextPiece {
  readonly kind: 'text'
  readonly text: string
  readonly o: number
  readonly look: RunLook
  readonly family: string
  readonly marks: Marks
}

interface AtomPiece {
  readonly kind: 'atom'
  readonly o: number
  readonly atom: Atom
}

type Piece = TextPiece | AtomPiece

function piecesOf(para: Paragraph, ctx: RenderContext): Piece[] {
  const pieces: Piece[] = []
  let o = 0
  for (const inline of para.inlines) {
    if (inline.kind === 'text') {
      const look = ctx.look(para, inline.marks)
      for (const seg of scriptSegments(inline.text, look)) {
        pieces.push({ kind: 'text', text: seg.text, o, look, family: seg.family, marks: inline.marks })
        o += seg.text.length
      }
    } else {
      pieces.push({ kind: 'atom', o, atom: inline })
      o += 1
    }
  }
  return pieces
}

function appendText(parent: HTMLElement, ctx: RenderContext, para: Paragraph, piece: TextPiece): void {
  const span = document.createElement('span')
  span.dataset.o = String(piece.o)
  span.textContent = piece.text
  applyRun(span, ctx, para, piece.look, piece.family, piece.marks)
  parent.append(span)
}

function appendPreedit(parent: HTMLElement, ctx: RenderContext, para: Paragraph, deco: Decoration): void {
  const span = document.createElement('span')
  span.className = 'preedit'
  span.dataset.o = String(deco.pos.o)
  span.textContent = deco.text
  const look = ctx.look(para, {})
  applyRun(span, ctx, para, look, isMostlyEastAsian(deco.text) ? look.fonts.eastAsia : look.fonts.ascii, {})
  parent.append(span)
}

function isMostlyEastAsian(text: string): boolean {
  for (const ch of text) {
    if (isEastAsian(ch.codePointAt(0) ?? 0)) return true
  }
  return false
}

function renderParagraph(para: Paragraph, ctx: RenderContext, deco: Decoration | undefined): HTMLElement {
  const el = document.createElement('div')
  el.className = 'blk p'
  el.dataset.id = para.id
  const look = applyParaBox(el, ctx, para)
  const marker = ctx.marker(para.id)
  if (marker) {
    const span = document.createElement('span')
    span.className = 'marker'
    span.contentEditable = 'false'
    span.textContent = marker
    const left = px(look.indent.left)
    const hanging = px(look.indent.hanging)
    span.style.left = `${Math.max(0, left - hanging)}px`
    span.style.top = `${px(look.spacing.before)}px`
    if (hanging > 0) span.style.width = `${hanging}px`
    const run = ctx.look(para, {})
    applyRun(span, ctx, para, run, run.fonts.eastAsia, {})
    el.append(span)
  }
  const active = deco && deco.pos.p === para.id ? deco : undefined
  const pieces = piecesOf(para, ctx)
  if (pieces.length === 0) {
    const span = document.createElement('span')
    span.dataset.o = '0'
    span.textContent = '\u200b'
    const run = ctx.look(para, {})
    applyRun(span, ctx, para, run, run.fonts.eastAsia, {})
    if (active && active.pos.o === 0) appendPreedit(el, ctx, para, active)
    el.append(span)
    return finishParagraph(el, para)
  }
  let preeditDone = false
  const emitPreedit = (at: number): void => {
    if (!active || preeditDone || active.pos.o !== at) return
    appendPreedit(el, ctx, para, active)
    preeditDone = true
  }
  for (const piece of pieces) {
    if (piece.kind === 'atom') {
      emitPreedit(piece.o)
      el.append(renderAtom(piece.atom, piece.o, ctx, para))
      continue
    }
    const end = piece.o + piece.text.length
    if (active && !preeditDone && active.pos.o > piece.o && active.pos.o < end) {
      const cut = active.pos.o - piece.o
      appendText(el, ctx, para, { ...piece, text: piece.text.slice(0, cut) })
      appendPreedit(el, ctx, para, active)
      preeditDone = true
      appendText(el, ctx, para, { ...piece, text: piece.text.slice(cut), o: active.pos.o })
      continue
    }
    emitPreedit(piece.o)
    appendText(el, ctx, para, piece)
  }
  if (active && !preeditDone) appendPreedit(el, ctx, para, active)
  return finishParagraph(el, para)
}

function finishParagraph(el: HTMLElement, para: Paragraph): HTMLElement {
  // One accessible name for the whole paragraph. Hidden children stop a span per run from being read as its own line.
  el.setAttribute('aria-label', flatText(para))
  for (const child of el.children) child.setAttribute('aria-hidden', 'true')
  return el
}

function rowspanAt(table: Table, rowIndex: number, col: number): number {
  let span = 1
  for (let r = rowIndex + 1; r < table.rows.length; r++) {
    const row = table.rows[r]
    if (!row) break
    let cursor = 0
    let found = false
    for (const cell of row.cells) {
      if (cursor === col) {
        if (cell.vMerge !== 'continue') return span
        found = true
        span += 1
        break
      }
      cursor += cell.span
    }
    if (!found) break
  }
  return span
}

function renderTable(table: Table, ctx: RenderContext, deco: Decoration | undefined): HTMLElement {
  const el = document.createElement('div')
  el.className = 'blk t'
  el.dataset.id = table.id
  el.dataset.keepNext = '0'
  el.dataset.keepLines = '0'
  el.dataset.pageBreakBefore = '0'
  el.dataset.widow = '0'
  el.dataset.spaceBefore = '0'
  el.dataset.spaceAfter = '0'
  const tableEl = document.createElement('table')
  const cols = document.createElement('colgroup')
  let sum = 0
  for (const width of table.grid) {
    const col = document.createElement('col')
    const widthPx = px(width)
    sum += widthPx
    col.style.width = `${widthPx}px`
    cols.append(col)
  }
  tableEl.style.width = `${sum}px`
  tableEl.append(cols)
  const body = document.createElement('tbody')
  let headerRows = 0
  let headerOpen = true
  for (let r = 0; r < table.rows.length; r++) {
    const row = table.rows[r]
    if (!row) continue
    if (headerOpen && row.props.header) headerRows += 1
    else headerOpen = false
    const tr = document.createElement('tr')
    if (row.props.header) tr.dataset.header = '1'
    tr.dataset.cantSplit = '1'
    if (row.props.heightPt) tr.style.height = `${px(row.props.heightPt)}px`
    let col = 0
    for (const cell of row.cells) {
      if (cell.vMerge === 'continue') {
        col += cell.span
        continue
      }
      const td = document.createElement('td')
      if (cell.span > 1) td.colSpan = cell.span
      const rows = cell.vMerge === 'restart' ? rowspanAt(table, r, col) : 1
      if (rows > 1) td.rowSpan = rows
      if (cell.shading) td.style.backgroundColor = `#${cell.shading}`
      if (cell.vAlign === 'center') td.style.verticalAlign = 'middle'
      else if (cell.vAlign) td.style.verticalAlign = cell.vAlign
      for (const child of cell.blocks) td.append(renderBlock(child, ctx, decoFor(child, deco)))
      tr.append(td)
      col += cell.span
    }
    body.append(tr)
  }
  tableEl.append(body)
  el.dataset.headerRows = String(headerRows)
  el.append(tableEl)
  return el
}

function renderOpaque(block: Extract<Block, { kind: 'opaque' }>, ctx: RenderContext, deco: Decoration | undefined): HTMLElement {
  const el = document.createElement('div')
  el.className = 'blk o'
  el.dataset.id = block.id
  el.dataset.keepNext = '0'
  el.dataset.keepLines = '0'
  el.dataset.pageBreakBefore = '0'
  el.dataset.widow = '0'
  el.dataset.spaceBefore = '0'
  el.dataset.spaceAfter = '0'
  const label = document.createElement('div')
  label.className = 'opaque-label'
  label.textContent = block.label
  el.append(label)
  for (const para of block.preview) el.append(renderBlock(para, ctx, decoFor(para, deco)))
  return el
}

/** Render one block. Pure in its inputs; pages.ts caches the result per block object and clones it to mount. */
export function renderBlock(block: Block, ctx: RenderContext, deco?: Decoration): HTMLElement {
  if (block.kind === 'p') return renderParagraph(block, ctx, deco)
  if (block.kind === 'table') return renderTable(block, ctx, deco)
  return renderOpaque(block, ctx, deco)
}

function slots(blockEl: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = []
  for (const child of blockEl.children) {
    if (!(child instanceof HTMLElement)) continue
    if (!child.hasAttribute('data-o')) continue
    if (child.classList.contains('preedit') || child.classList.contains('marker')) continue
    out.push(child)
  }
  return out
}

function pointBefore(el: Element): { node: Node; offset: number } {
  const parent = el.parentNode
  if (!parent) return { node: el, offset: 0 }
  return { node: parent, offset: childIndex(parent, el) }
}

function pointAfter(el: Element): { node: Node; offset: number } {
  const parent = el.parentNode
  if (!parent) return { node: el, offset: 0 }
  return { node: parent, offset: childIndex(parent, el) + 1 }
}

function childIndex(parent: Node, el: Element): number {
  for (let i = 0; i < parent.childNodes.length; i++) {
    if (parent.childNodes[i] === el) return i
  }
  return 0
}

/** The DOM point inside a rendered block element (one mounted copy) for a flat-text offset. */
export function domPoint(blockEl: HTMLElement, o: number): { node: Node; offset: number } {
  const spanList = slots(blockEl)
  if (spanList.length === 0) return { node: blockEl, offset: 0 }
  for (let i = 0; i < spanList.length; i++) {
    const span = spanList[i]
    if (!span) continue
    const start = readO(span)
    if (span.classList.contains('atom')) {
      if (o <= start) return pointBefore(span)
      if (o === start + 1) {
        const next = spanList[i + 1]
        if (next && readO(next) === o) continue
        return pointAfter(span)
      }
      continue
    }
    const text = span.firstChild
    if (!(text instanceof Text)) continue
    if (text.data === '\u200b') {
      if (o <= start) return { node: text, offset: 0 }
      continue
    }
    if (o < start + text.length) return { node: text, offset: Math.max(0, o - start) }
    if (o === start + text.length) {
      const next = spanList[i + 1]
      if (next && readO(next) <= o) continue
      return { node: text, offset: text.length }
    }
  }
  const last = spanList[spanList.length - 1]
  if (!last) return { node: blockEl, offset: 0 }
  if (last.classList.contains('atom')) return pointAfter(last)
  const text = last.firstChild
  if (text instanceof Text && text.data !== '\u200b') return { node: text, offset: text.length }
  if (text instanceof Text) return { node: text, offset: 0 }
  return pointAfter(last)
}

let shared: Range | null = null

/**
 * The one Range every measurement reuses. acdert updates each live Range on every DOM mutation and collects them
 * late, so a Range per measurement makes each keystroke slower with every document opened. Read it before the next
 * call takes it.
 */
export function scratchRange(): Range {
  shared ??= document.createRange()
  return shared
}

/**
 * The shared Range set over [from, to) in one rendered paragraph element; collapsed when from === to. Read it before
 * the next call takes it.
 */
export function rangeIn(blockEl: HTMLElement, from: number, to: number): Range {
  const start = domPoint(blockEl, Math.min(from, to))
  const end = domPoint(blockEl, Math.max(from, to))
  const range = scratchRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  return range
}

/**
 * Map a DOM point (from caretPositionFromPoint) back to a model position. Null when the point is outside any editable
 * paragraph (a list marker resolves to offset 0, an atom to the nearer side, a U+200B placeholder to 0).
 */
export function posFromDom(node: Node, offset: number): Pos | null {
  const start = node instanceof Element ? node : node.parentElement
  if (!start) return null
  const para = start.closest('.blk.p')
  if (!(para instanceof HTMLElement)) return null
  const id = para.dataset.id
  if (!id) return null
  const p = id as ParaId
  if (start.closest('.marker')) return { p, o: 0 }
  const preedit = start.closest('.preedit')
  if (preedit instanceof HTMLElement && para.contains(preedit)) return { p, o: readO(preedit) }
  const atom = start.closest('.atom')
  if (atom instanceof HTMLElement && para.contains(atom)) return atomSide(atom, node, offset, p)

  if (node instanceof Text) {
    const host = node.parentElement
    if (!(host instanceof HTMLElement) || !para.contains(host)) return { p, o: 0 }
    if (host.classList.contains('marker')) return { p, o: 0 }
    if (node.data === '\u200b') return { p, o: readO(host) }
    const base = readO(host)
    const within = Math.max(0, Math.min(offset, node.data.length))
    return { p, o: base + within }
  }

  if (node instanceof Element && para.contains(node)) {
    const child = node.childNodes[offset]
    if (child instanceof Element && child.classList.contains('atom')) return { p, o: readO(child) }
    if (child instanceof Text) return posFromDom(child, 0)
    if (offset > 0) {
      const prev = node.childNodes[offset - 1]
      if (prev instanceof Element && prev.classList.contains('atom')) return { p, o: readO(prev) + 1 }
      if (prev instanceof Text) return posFromDom(prev, prev.data.length)
    }
    return { p, o: 0 }
  }
  return { p, o: 0 }
}

function atomSide(atom: HTMLElement, node: Node, offset: number, p: ParaId): Pos {
  const base = readO(atom)
  const parent = atom.parentNode
  if (node === parent && parent) {
    const index = childIndex(parent, atom)
    return { p, o: offset > index ? base + 1 : base }
  }
  return { p, o: base }
}

/** The element of block `id` inside a mounted container. Pages may hold two copies; pages.ts picks by geometry. */
export function blockElements(root: ParentNode, id: string): readonly HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(`.blk[data-id="${CSS.escape(id)}"]`)]
}

/** CSS for a section's page box and content box, in px at 100 percent zoom (1pt = 4/3 px). */
export function pageBoxStyle(section: Section): { page: Partial<CSSStyleDeclaration>; content: Partial<CSSStyleDeclaration> } {
  const page = section.page
  const margin = page.margin
  const width = px(page.widthPt)
  const height = px(page.heightPt)
  const left = px(margin.left + margin.gutter)
  const right = px(margin.right)
  const top = px(margin.top)
  const bottom = px(margin.bottom)
  return {
    page: {
      boxSizing: 'border-box',
      position: 'relative',
      width: `${width}px`,
      height: `${height}px`,
    },
    content: {
      boxSizing: 'border-box',
      position: 'absolute',
      top: `${top}px`,
      right: `${right}px`,
      bottom: `${bottom}px`,
      left: `${left}px`,
    },
  }
}
