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

type MarkIcon = 'bold' | 'italic' | 'underline' | 'strike'

const MARK: Record<MarkIcon, string> = { bold: 'B', italic: 'I', underline: 'U', strike: 'S' }

export function icon(name: IconName): SVGSVGElement | HTMLSpanElement {
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

function glyph(kind: MarkIcon): HTMLSpanElement {
  const el = document.createElement('span')
  el.className = `glyph ${kind}`
  el.setAttribute('aria-hidden', 'true')
  el.textContent = MARK[kind]
  return el
}

function draw(name: Exclude<IconName, MarkIcon>, svg: SVGSVGElement): void {
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
    default: {
      const unexpected: never = name
      throw new Error(`unknown icon ${unexpected}`)
    }
  }
}

function drawDoc(svg: SVGSVGElement): void {
  path(svg, 'M5 2.4 H10.3 L13.9 6 V15.6 H5 Z')
  path(svg, 'M10.3 2.4 V6 H13.9')
}

function drawFolder(svg: SVGSVGElement): void {
  path(svg, 'M2.2 6.6 V4.5 H7.3 L8.8 6.6 H15.8 V14.7 H2.2 Z')
}

function drawSave(svg: SVGSVGElement): void {
  path(svg, 'M4 2.6 H11.2 L15 6.4 V15.4 H4 Z')
  path(svg, 'M6.2 2.6 V6.4 H10.6')
  path(svg, 'M6.2 15.4 V10.2 H12.6 V15.4')
}

function drawPageSetup(svg: SVGSVGElement): void {
  path(svg, 'M4 2.4 H14 V15.6 H4 Z')
  path(svg, 'M6.2 5.2 H11.8')
  path(svg, 'M6.2 8 H11.8')
  path(svg, 'M6.2 10.8 H9.6')
}

function drawTable(svg: SVGSVGElement): void {
  grid(svg, 3, 3, 12, 12)
}

function drawImage(svg: SVGSVGElement): void {
  path(svg, 'M3.2 4.2 H14.8 V13.8 H3.2 Z')
  path(svg, 'M3.2 11.4 L6.6 8.4 L9.2 10.6 L11.4 8.8 L14.8 12')
  dot(svg, 6.4, 6.8)
}

function drawTableRow(svg: SVGSVGElement, where: 'above' | 'below' | 'delete'): void {
  if (where === 'above') {
    plus(svg, 9, 2.4)
    grid(svg, 3.2, 5.6, 11.6, 9.2)
    return
  }
  if (where === 'below') {
    grid(svg, 3.2, 3.2, 11.6, 9.2)
    plus(svg, 9, 15.6)
    return
  }
  grid(svg, 3, 3, 12, 12)
  path(svg, 'M4.2 7.4 L13.8 10.6')
}

function drawTableColumn(svg: SVGSVGElement, where: 'left' | 'right' | 'delete'): void {
  if (where === 'left') {
    plus(svg, 2.4, 9)
    grid(svg, 5.6, 3.2, 9.2, 11.6)
    return
  }
  if (where === 'right') {
    grid(svg, 3.2, 3.2, 9.2, 11.6)
    plus(svg, 15.6, 9)
    return
  }
  grid(svg, 3, 3, 12, 12)
  path(svg, 'M7.4 4.2 L10.6 13.8')
}

function drawPrint(svg: SVGSVGElement): void {
  path(svg, 'M5 2.6 H13 V6.4 H5 Z')
  path(svg, 'M3.2 6.4 H14.8 V12 H3.2 Z')
  path(svg, 'M5.6 10.2 H12.4 V15.4 H5.6 Z')
  path(svg, 'M6.4 8.4 H8')
}

function drawTableDelete(svg: SVGSVGElement): void {
  grid(svg, 3, 3, 12, 12)
  path(svg, 'M4.6 4.6 L13.4 13.4')
  path(svg, 'M13.4 4.6 L4.6 13.4')
}

function grid(svg: SVGSVGElement, x: number, y: number, w: number, h: number): void {
  path(svg, `M${x} ${y} H${x + w} V${y + h} H${x} Z`)
  path(svg, `M${x + w / 2} ${y} V${y + h}`)
  path(svg, `M${x} ${y + h / 2} H${x + w}`)
}

function plus(svg: SVGSVGElement, x: number, y: number): void {
  path(svg, `M${x - 1.7} ${y} H${x + 1.7}`)
  path(svg, `M${x} ${y - 1.7} V${y + 1.7}`)
}

function drawSaveAs(svg: SVGSVGElement): void {
  path(svg, 'M2.2 3.2 H7.4 L10.2 6 V12.6 H2.2 Z')
  path(svg, 'M4 3.2 V6 H7.2')
  path(svg, 'M4 12.6 V9.2 H8.4 V12.6')
  path(svg, 'M11.4 10.4 L15.6 14.6')
  path(svg, 'M12.4 14.6 H15.6 V11.4')
}

function drawUndo(svg: SVGSVGElement): void {
  path(svg, 'M6.2 10.7 L2 6.5 L6.2 2.3')
  path(svg, 'M2 6.5 H10.5 A5 5 0 0 1 15.5 11.5 A5 5 0 0 1 10.5 16.5 H8')
}

function drawRedo(svg: SVGSVGElement): void {
  path(svg, 'M11.8 10.7 L16 6.5 L11.8 2.3')
  path(svg, 'M16 6.5 H7.5 A5 5 0 0 0 2.5 11.5 A5 5 0 0 0 7.5 16.5 H10')
}

function align(svg: SVGSVGElement, mode: 'left' | 'center' | 'right' | 'justify'): void {
  const full: readonly [number, number] = [3, 15]
  const short: readonly [number, number] = mode === 'left'
    ? [3, 10]
    : mode === 'center'
      ? [5.5, 12.5]
      : mode === 'right'
        ? [8, 15]
        : full
  for (const y of [4.5, 9, 13.5]) {
    const [x1, x2] = y === 9 && mode !== 'justify' ? short : full
    hline(svg, x1, x2, y)
  }
}

function listBullet(svg: SVGSVGElement): void {
  for (const y of [4.5, 9, 13.5]) {
    dot(svg, 4, y)
    hline(svg, 7.4, 15, y)
  }
}

function indentIcon(svg: SVGSVGElement, direction: 'decrease' | 'increase'): void {
  for (const y of [4.5, 9, 13.5]) hline(svg, 7.4, 15.2, y)
  if (direction === 'increase') {
    path(svg, 'M2.1 9 H5.2')
    path(svg, 'M3.4 7.2 L5.4 9 L3.4 10.8')
    return
  }
  path(svg, 'M5.4 9 H2.3')
  path(svg, 'M4.1 7.2 L2.1 9 L4.1 10.8')
}

function listNumber(svg: SVGSVGElement): void {
  const rows: readonly (readonly [string, number])[] = [
    ['1', 3.8],
    ['2', 9],
    ['3', 14.2],
  ]
  for (const [label, y] of rows) {
    const text = document.createElementNS(SVG_NS, 'text')
    text.setAttribute('x', '1')
    text.setAttribute('y', String(y + 2.2))
    text.setAttribute('fill', 'currentColor')
    text.setAttribute('stroke', 'none')
    text.setAttribute('font-family', 'ui-sans-serif, system-ui, sans-serif')
    text.setAttribute('font-size', '6.5')
    text.setAttribute('font-weight', '600')
    text.textContent = label
    svg.append(text)
    hline(svg, 7.6, 15.2, y)
  }
}

function path(svg: SVGSVGElement, d: string): void {
  const el = document.createElementNS(SVG_NS, 'path')
  el.setAttribute('d', d)
  el.setAttribute('fill', 'none')
  el.setAttribute('stroke', 'currentColor')
  el.setAttribute('stroke-width', '1.6')
  el.setAttribute('stroke-linecap', 'round')
  el.setAttribute('stroke-linejoin', 'round')
  svg.append(el)
}

function hline(svg: SVGSVGElement, x1: number, x2: number, y: number): void {
  path(svg, `M ${x1} ${y} H ${x2}`)
}

function dot(svg: SVGSVGElement, cx: number, cy: number): void {
  const el = document.createElementNS(SVG_NS, 'circle')
  el.setAttribute('cx', String(cx))
  el.setAttribute('cy', String(cy))
  el.setAttribute('r', '1.3')
  el.setAttribute('fill', 'currentColor')
  el.setAttribute('stroke', 'none')
  svg.append(el)
}
