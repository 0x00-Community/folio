// One icon family: an 18px box, artwork on a 16-unit grid with 1 unit of margin,
// 1.5px strokes on half-pixel centers so horizontal and vertical strokes stay crisp.
const SVG_NS = 'http://www.w3.org/2000/svg'

export type IconName =
  | 'doc'
  | 'folder'
  | 'undo'
  | 'redo'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'align-left'
  | 'align-center'
  | 'align-right'
  | 'align-justify'
  | 'list-bullet'
  | 'list-number'
  | 'indent-decrease'
  | 'indent-increase'
  | 'save'
  | 'save-as'
  | 'page-setup'
  | 'table'
  | 'image'
  | 'table-row-above'
  | 'table-row-below'
  | 'table-row-delete'
  | 'table-col-left'
  | 'table-col-right'
  | 'table-col-delete'
  | 'table-delete'
  | 'print'
  | 'search'
  | 'close'
  | 'chevron'
  | 'zoom-out'
  | 'zoom-in'
  | 'font-color'
  | 'highlight'
  | 'check'
  | 'more'
  | 'line-spacing'

type MarkIcon = 'bold' | 'italic' | 'underline' | 'strike' | 'font-color'

const MARK: Record<Exclude<MarkIcon, 'font-color'>, string> = { bold: 'B', italic: 'I', underline: 'U', strike: 'S' }

const STROKE = '1.5'
const FAINT = 0.6

export function icon(name: IconName): SVGSVGElement | HTMLSpanElement {
  if (name === 'font-color') return fontColorGlyph()
  if (name === 'highlight') return highlightGlyph()
  if (name === 'bold' || name === 'italic' || name === 'underline' || name === 'strike') return glyph(name)
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 18 18')
  svg.setAttribute('width', '18')
  svg.setAttribute('height', '18')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('fill', 'none')
  draw(name, svg)
  return svg
}

function glyph(kind: Exclude<MarkIcon, 'font-color'>): HTMLSpanElement {
  const el = document.createElement('span')
  el.className = `glyph ${kind}`
  el.setAttribute('aria-hidden', 'true')
  el.textContent = MARK[kind]
  return el
}

function fontColorGlyph(): HTMLSpanElement {
  const el = document.createElement('span')
  el.className = 'glyph color'
  el.setAttribute('aria-hidden', 'true')
  el.append(document.createTextNode('A'))
  const bar = document.createElement('span')
  bar.className = 'bar'
  el.append(bar)
  return el
}

function highlightGlyph(): HTMLSpanElement {
  const el = document.createElement('span')
  el.className = 'glyph color'
  el.setAttribute('aria-hidden', 'true')
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 18 14')
  svg.setAttribute('width', '18')
  svg.setAttribute('height', '14')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('fill', 'none')
  drawMarker(svg)
  const bar = document.createElement('span')
  bar.className = 'bar'
  el.append(svg, bar)
  return el
}

function draw(name: Exclude<IconName, MarkIcon | 'highlight'>, svg: SVGSVGElement): void {
  switch (name) {
    case 'doc':
      return drawDoc(svg)
    case 'folder':
      return drawFolder(svg)
    case 'undo':
      return drawUndo(svg)
    case 'redo':
      return drawRedo(svg)
    case 'align-left':
      return align(svg, 'left')
    case 'align-center':
      return align(svg, 'center')
    case 'align-right':
      return align(svg, 'right')
    case 'align-justify':
      return align(svg, 'justify')
    case 'list-bullet':
      return listBullet(svg)
    case 'list-number':
      return listNumber(svg)
    case 'indent-decrease':
      return indentIcon(svg, 'decrease')
    case 'indent-increase':
      return indentIcon(svg, 'increase')
    case 'save':
      return drawSave(svg)
    case 'save-as':
      return drawSaveAs(svg)
    case 'page-setup':
      return drawPageSetup(svg)
    case 'table':
      return drawTable(svg)
    case 'image':
      return drawImage(svg)
    case 'table-row-above':
      return drawTableRow(svg, 'above')
    case 'table-row-below':
      return drawTableRow(svg, 'below')
    case 'table-row-delete':
      return drawTableRow(svg, 'delete')
    case 'table-col-left':
      return drawTableColumn(svg, 'left')
    case 'table-col-right':
      return drawTableColumn(svg, 'right')
    case 'table-col-delete':
      return drawTableColumn(svg, 'delete')
    case 'table-delete':
      return drawTableDelete(svg)
    case 'print':
      return drawPrint(svg)
    case 'search':
      return drawSearch(svg)
    case 'close':
      return drawClose(svg)
    case 'chevron':
      return drawChevron(svg)
    case 'zoom-out':
      return drawZoomOut(svg)
    case 'zoom-in':
      return drawZoomIn(svg)
    case 'check':
      return drawCheck(svg)
    case 'more':
      return drawMore(svg)
    case 'line-spacing':
      return drawLineSpacing(svg)
    default: {
      const unexpected: never = name
      throw new Error(`unknown icon ${unexpected}`)
    }
  }
}

function drawDoc(svg: SVGSVGElement): void {
  path(svg, 'M5.5 2.5 H11.5 L14.5 5.5 V15.5 H5.5 Z')
  path(svg, 'M11.5 2.5 V5.5 H14.5')
}

function drawFolder(svg: SVGSVGElement): void {
  path(svg, 'M2.5 6.5 V4.5 H7.5 L9.5 6.5 H15.5 V14.5 H2.5 Z')
}

function drawSave(svg: SVGSVGElement): void {
  path(svg, 'M4.5 2.5 H11.5 L15.5 6.5 V15.5 H4.5 Z')
  path(svg, 'M7.5 2.5 V6.5 H11.5')
  path(svg, 'M7.5 15.5 V10.5 H12.5 V15.5')
}

function drawSaveAs(svg: SVGSVGElement): void {
  path(svg, 'M2.5 3.5 H7.5 L10.5 6.5 V13.5 H2.5 Z')
  path(svg, 'M4.5 3.5 V6.5 H7.5')
  path(svg, 'M4.5 13.5 V10.5 H8.5 V13.5')
  path(svg, 'M12.5 8.5 L15.5 11.5')
  path(svg, 'M13.5 11.5 H15.5 V9.5')
}

function drawPageSetup(svg: SVGSVGElement): void {
  path(svg, 'M4.5 2.5 H13.5 V15.5 H4.5 Z')
  path(svg, 'M6.5 6.5 H11.5')
  path(svg, 'M6.5 9.5 H11.5')
  path(svg, 'M6.5 12.5 H9.5')
}

function drawTable(svg: SVGSVGElement): void {
  gridAt(svg, 3.5, 3.5, 4, 1)
}

function drawImage(svg: SVGSVGElement): void {
  path(svg, 'M3.5 4.5 H14.5 V13.5 H3.5 Z')
  path(svg, 'M3.5 11.5 L6.5 8.5 L9.5 11.5 L11.5 9.5 L14.5 12.5')
  dot(svg, 6.5, 7.5)
}

function drawPrint(svg: SVGSVGElement): void {
  path(svg, 'M6.5 2.5 H11.5 V6.5 H6.5 Z')
  path(svg, 'M3.5 6.5 H14.5 V12.5 H3.5 Z')
  path(svg, 'M6.5 11.5 H11.5 V15.5 H6.5 Z')
  path(svg, 'M5.5 9.5 H7.5')
}

function drawSearch(svg: SVGSVGElement): void {
  path(svg, 'M7.5 4 A3.5 3.5 0 1 0 7.51 4')
  path(svg, 'M10 10 L14.5 14.5')
}

function drawClose(svg: SVGSVGElement): void {
  path(svg, 'M5.5 5.5 L12.5 12.5')
  path(svg, 'M12.5 5.5 L5.5 12.5')
}

function drawChevron(svg: SVGSVGElement): void {
  path(svg, 'M6.5 7.5 L9.5 10.5 L12.5 7.5')
}

function drawZoomOut(svg: SVGSVGElement): void {
  path(svg, 'M4.5 9.5 H13.5')
}

function drawZoomIn(svg: SVGSVGElement): void {
  path(svg, 'M4.5 9.5 H13.5')
  path(svg, 'M9.5 4.5 V13.5')
}

function drawMarker(svg: SVGSVGElement): void {
  path(svg, 'M12.5 1.5 L16.5 4.5 L9.5 11.5 L5.5 8.5 Z')
  path(svg, 'M9.5 4.5 L13.5 7.5')
  path(svg, 'M5.5 8.5 L3.5 11.5 L8.5 12.5 L9.5 11.5')
}

function drawCheck(svg: SVGSVGElement): void {
  path(svg, 'M4.5 9.5 L7.5 12.5')
  path(svg, 'M7.5 12.5 L13.5 5.5')
}

function drawMore(svg: SVGSVGElement): void {
  dot(svg, 4.5, 9.5)
  dot(svg, 9, 9.5)
  dot(svg, 13.5, 9.5)
}

function drawLineSpacing(svg: SVGSVGElement): void {
  path(svg, 'M4.5 3.5 V6.5')
  path(svg, 'M3.5 5 L4.5 3.5 L5.5 5')
  path(svg, 'M4.5 14.5 V11.5')
  path(svg, 'M3.5 13 L4.5 14.5 L5.5 13')
  hline(svg, 8.5, 14.5, 5.5)
  hline(svg, 8.5, 14.5, 9.5)
  hline(svg, 8.5, 14.5, 13.5)
}

function drawUndo(svg: SVGSVGElement): void {
  path(svg, 'M7.5 6.5 L4.5 9.5 L7.5 12.5')
  path(svg, 'M4.5 9.5 H11 C14.5 9.5 14.5 15.5 10.5 15.5 H8.5')
}

function drawRedo(svg: SVGSVGElement): void {
  path(svg, 'M10.5 6.5 L13.5 9.5 L10.5 12.5')
  path(svg, 'M13.5 9.5 H7 C3.5 9.5 3.5 15.5 7.5 15.5 H9.5')
}

const ROW_Y = [5.5, 9.5, 13.5] as const
const LINE_RIGHT = 14.5
const LINE_LEFT = 8.5

function align(svg: SVGSVGElement, mode: 'left' | 'center' | 'right' | 'justify'): void {
  const full: readonly [number, number] = [3.5, LINE_RIGHT]
  const short: readonly [number, number] = mode === 'left'
    ? [3.5, 10.5]
    : mode === 'center'
      ? [5.5, 12.5]
      : mode === 'right'
        ? [7.5, LINE_RIGHT]
        : full
  for (const y of ROW_Y) {
    const span = y === 9.5 && mode !== 'justify' ? short : full
    hline(svg, span[0], span[1], y)
  }
}

function listBullet(svg: SVGSVGElement): void {
  for (const y of ROW_Y) {
    dot(svg, 4.5, y)
    hline(svg, LINE_LEFT, LINE_RIGHT, y)
  }
}

function listNumber(svg: SVGSVGElement): void {
  const digits = [1, 2, 3] as const
  for (let i = 0; i < ROW_Y.length; i++) {
    const y = ROW_Y[i]
    const digit = digits[i]
    if (y === undefined || digit === undefined) continue
    drawDigit(svg, digit, y)
    hline(svg, LINE_LEFT, LINE_RIGHT, y)
  }
}

function indentIcon(svg: SVGSVGElement, direction: 'decrease' | 'increase'): void {
  for (const y of ROW_Y) hline(svg, LINE_LEFT, LINE_RIGHT, y)
  if (direction === 'increase') {
    path(svg, 'M2.5 9.5 H6.5')
    path(svg, 'M4.5 7.5 L6.5 9.5 L4.5 11.5')
    return
  }
  path(svg, 'M6.5 9.5 H2.5')
  path(svg, 'M4.5 7.5 L2.5 9.5 L4.5 11.5')
}

function drawDigit(svg: SVGSVGElement, n: 1 | 2 | 3, y: number): void {
  if (n === 1) {
    path(svg, `M3.5 ${y - 2} L4.5 ${y - 2} V${y + 2}`)
    return
  }
  if (n === 2) {
    path(svg, `M3 ${y - 1} C3 ${y - 2.5} 6 ${y - 2.5} 6 ${y - 0.5} C6 ${y + 1} 3.5 ${y + 0.5} 3 ${y + 2} H6`)
    return
  }
  path(svg, `M3 ${y - 2} H5.5 C6.5 ${y - 2} 6.5 ${y} 4.5 ${y} C6.5 ${y} 6.5 ${y + 2} 5 ${y + 2} H3`)
}

// A 3 by 3 grid with a badge is a blot at 18 px. Each table icon is one or two cells instead:
// the affected row is a wide box, the affected column a tall one, and the mark sits inside it.
// The faint box is the row or column that is already there.
function drawTableRow(svg: SVGSVGElement, where: 'above' | 'below' | 'delete'): void {
  if (where === 'delete') {
    box(svg, 2.5, 5.5, 13, 7)
    timesMark(svg, 9, 9, 1.5)
    return
  }
  const fresh = where === 'above' ? 2.5 : 9.5
  const old = where === 'above' ? 10.5 : 3.5
  box(svg, 2.5, old, 13, 4, FAINT)
  box(svg, 2.5, fresh, 13, 6)
  plusMark(svg, 9, fresh + 3)
}

function drawTableColumn(svg: SVGSVGElement, where: 'left' | 'right' | 'delete'): void {
  if (where === 'delete') {
    box(svg, 5.5, 2.5, 7, 13)
    timesMark(svg, 9, 9, 1.5)
    return
  }
  const fresh = where === 'left' ? 2.5 : 9.5
  const old = where === 'left' ? 10.5 : 3.5
  box(svg, old, 2.5, 4, 13, FAINT)
  box(svg, fresh, 2.5, 6, 13)
  plusMark(svg, fresh + 3, 9)
}

function drawTableDelete(svg: SVGSVGElement): void {
  box(svg, 2.5, 3.5, 13, 11)
  timesMark(svg, 9, 9, 2)
}

function box(svg: SVGSVGElement, x: number, y: number, w: number, h: number, opacity = 1): void {
  path(svg, `M${x} ${y} H${x + w} V${y + h} H${x} Z`, opacity)
}

function gridAt(svg: SVGSVGElement, x: number, y: number, cell: number, opacity: number): void {
  const right = x + cell * 3
  const bottom = y + cell * 3
  path(svg, `M${x} ${y} H${right} V${bottom} H${x} Z`, opacity)
  path(svg, `M${x + cell} ${y} V${bottom}`, opacity)
  path(svg, `M${x + cell * 2} ${y} V${bottom}`, opacity)
  path(svg, `M${x} ${y + cell} H${right}`, opacity)
  path(svg, `M${x} ${y + cell * 2} H${right}`, opacity)
}

function plusMark(svg: SVGSVGElement, x: number, y: number): void {
  path(svg, `M${x - 1.5} ${y} H${x + 1.5}`)
  path(svg, `M${x} ${y - 1.5} V${y + 1.5}`)
}

function timesMark(svg: SVGSVGElement, x: number, y: number, arm: number): void {
  path(svg, `M${x - arm} ${y - arm} L${x + arm} ${y + arm}`)
  path(svg, `M${x + arm} ${y - arm} L${x - arm} ${y + arm}`)
}

function path(svg: SVGSVGElement, d: string, opacity = 1): void {
  const el = document.createElementNS(SVG_NS, 'path')
  el.setAttribute('d', d)
  el.setAttribute('fill', 'none')
  el.setAttribute('stroke', 'currentColor')
  el.setAttribute('stroke-width', STROKE)
  el.setAttribute('stroke-linecap', 'round')
  el.setAttribute('stroke-linejoin', 'round')
  if (opacity !== 1) el.setAttribute('stroke-opacity', String(opacity))
  svg.append(el)
}

function hline(svg: SVGSVGElement, x1: number, x2: number, y: number): void {
  path(svg, `M${x1} ${y} H${x2}`)
}

function dot(svg: SVGSVGElement, cx: number, cy: number): void {
  const el = document.createElementNS(SVG_NS, 'circle')
  el.setAttribute('cx', String(cx))
  el.setAttribute('cy', String(cy))
  el.setAttribute('r', '1.15')
  el.setAttribute('fill', 'currentColor')
  el.setAttribute('stroke', 'none')
  svg.append(el)
}
