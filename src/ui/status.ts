import type { Status } from '../editor/editor.ts'
import { t } from '../i18n.ts'
import { icon } from './icons.ts'
import type { IconName } from './icons.ts'
import { statusText, stepZoom, zoomAtEnd, ZOOM_PERCENTS } from './text.ts'

export interface StatusView {
  render(status: Status): void
  zoom(): number
}

export function createStatus(root: HTMLElement, onZoom: (zoom: number) => void): StatusView {
  root.removeAttribute('role')
  let painting = false
  let zoom = 1
  let shown = ''
  const text = document.createElement('div')
  text.className = 'status-text'
  text.setAttribute('role', 'status')
  const zoomOut = zoomButton(t('zoom.out'), 'zoom-out', () => apply(stepZoom(Math.round(zoom * 100), -1)))
  const zoomIn = zoomButton(t('zoom.in'), 'zoom-in', () => apply(stepZoom(Math.round(zoom * 100), 1)))
  const zoomSelect = document.createElement('select')
  zoomSelect.className = 'zoom'
  zoomSelect.setAttribute('aria-label', t('zoom'))
  for (const percent of ZOOM_PERCENTS) {
    const option = document.createElement('option')
    option.value = String(percent)
    option.textContent = `${percent}%`
    zoomSelect.append(option)
  }
  zoomSelect.value = '100'
  const zoomBox = document.createElement('div')
  zoomBox.className = 'status-zoom'
  zoomBox.append(zoomOut, zoomSelect, zoomIn)
  root.replaceChildren(text, zoomBox)

  function paintZoom(): void {
    const percent = Math.round(zoom * 100)
    const value = String(percent)
    if (zoomSelect.value !== value) zoomSelect.value = value
    const ends = zoomAtEnd(percent)
    if (zoomOut.disabled !== ends.out) zoomOut.disabled = ends.out
    if (zoomIn.disabled !== ends.in) zoomIn.disabled = ends.in
  }

  function apply(percent: number): void {
    if (painting) return
    if (!Number.isFinite(percent) || percent <= 0) return
    const next = percent / 100
    if (next === zoom) return
    zoom = next
    paintZoom()
    onZoom(zoom)
  }

  zoomSelect.addEventListener('change', () => apply(Number(zoomSelect.value)))
  zoomSelect.addEventListener('input', () => apply(Number(zoomSelect.value)))
  paintZoom()

  return {
    zoom: () => zoom,
    render(status) {
      painting = true
      try {
        const line = statusText(status, t)
        if (line !== shown) {
          shown = line
          text.textContent = line
        }
        paintZoom()
      } finally {
        painting = false
      }
    },
  }
}

function zoomButton(label: string, graphic: IconName, onClick: () => void): HTMLButtonElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.setAttribute('aria-label', label)
  el.title = label
  el.append(icon(graphic))
  el.addEventListener('click', onClick)
  return el
}
