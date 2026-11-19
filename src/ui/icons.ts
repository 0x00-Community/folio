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
