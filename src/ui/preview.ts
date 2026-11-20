// Print preview. One state value owns the layout and the page blob URLs.
// Rendering is one page per frame, and it stops as soon as the phase leaves open.
import { t } from '../i18n.ts'

export type PreviewPhase = 'closed' | 'preparing' | 'cancelling' | 'open' | 'exporting' | 'failed' | 'unusable'

export interface PreviewLayout {
  free(): void
}

/** Raster time is 140 to 230 ms, so a frame renders one page and a closed preview renders none. */
export function shouldRender(phase: PreviewPhase): boolean {
  return phase === 'open' || phase === 'exporting'
}

const CSS_DPI = 96
const MAX_DPI = 144

/** 96 times the device pixel ratio, and at most 144. A 1x display does not rasterize 2x pixels. */
export function previewDpi(devicePixelRatio: number): number {
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) return CSS_DPI
  const dpi = CSS_DPI * devicePixelRatio
  return dpi > MAX_DPI ? MAX_DPI : dpi
}

/** CSS pixels for a length in points, at 96 dpi, before fit-to-width. */
export function pageCssPx(pt: number): number {
  return pt * CSS_DPI / 72
}

/** Shrink a page to the viewport width. A wider window does not scale it up. */
export function fitScale(pageWidthPx: number, availablePx: number): number {
  if (!(pageWidthPx > 0) || !(availablePx > 0)) return 1
  const scale = availablePx / pageWidthPx
  return scale < 1 ? scale : 1
}

export function fittedPagePx(
  widthPt: number,
  heightPt: number,
  availablePx: number,
): { width: number; height: number } {
  const width = pageCssPx(widthPt)
  const height = pageCssPx(heightPt)
  const scale = fitScale(width, availablePx)
  return { width: width * scale, height: height * scale }
}

/** `basic.docx` becomes `basic.pdf`. A name without that suffix gains one. */
export function pdfFileName(name: string): string {
  const trimmed = name.trim()
  const stem = trimmed.replace(/\.docx$/i, '')
  const base = stem.length > 0 ? stem : 'document'
  return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`
}

/**
 * The next page to rasterize. Pages on screen come before the one on either side.
 * `visible` is in reading order. Null means nothing new is wanted.
 */
export function nextPage(count: number, visible: readonly number[], done: ReadonlySet<number>): number | null {
  let firstVisible: number | null = null
  for (const index of visible) {
    if (index < 0 || index >= count || done.has(index)) continue
    if (firstVisible === null || index < firstVisible) firstVisible = index
  }
  if (firstVisible !== null) return firstVisible
  let best: number | null = null
  for (const index of visible) {
    for (const neighbor of [index - 1, index + 1]) {
      if (neighbor < 0 || neighbor >= count || done.has(neighbor)) continue
      if (best === null || neighbor < best) best = neighbor
    }
  }
  return best
}

type Translate = (key: string, values?: Record<string, string | number>) => string

export interface PrintFailure {
  readonly message: string
  readonly abort: boolean
}

/** A panic reaches JavaScript as a RuntimeError and the wasm instance does not run again. */
export function isWasmAbort(error: unknown): boolean {
  if (typeof WebAssembly !== 'undefined' && error instanceof WebAssembly.RuntimeError) return true
  return error instanceof Error && error.name === 'RuntimeError'
}

export function describePrintFailure(error: unknown, translate: Translate): PrintFailure {
  if (isWasmAbort(error)) return { message: translate('print.reopen'), abort: true }
  if (error instanceof Error && error.name === 'PrintError') {
    const extra = error as Error & { kind?: string; family?: string; detail?: string }
    if (extra.kind === 'font') {
      return { message: translate('print.error.font', { family: extra.family ?? '' }), abort: false }
    }
    if (extra.kind === 'render') {
      return { message: translate('print.error.render', { detail: extra.detail ?? error.message }), abort: false }
    }
    return { message: translate('print.error.layout', { detail: extra.detail ?? error.message }), abort: false }
  }
  if (error instanceof Error && error.name === 'SaveWriteError') {
    const detail = (error as Error & { detail?: string }).detail ?? error.message
    return { message: translate('print.error.layout', { detail }), abort: false }
  }
  const detail = error instanceof Error ? error.message : String(error)
  return { message: translate('print.error.layout', { detail }), abort: false }
}

function defaultRevoke(url: string): void {
  URL.revokeObjectURL(url)
}

/**
 * `closed -> preparing -> open -> exporting -> open`, and `preparing -> failed -> closed`.
 * Cancel during preparation is `cancelling` until the layout call returns, which frees it.
 * `unusable` is a wasm abort: the layout is dropped and nothing here calls the engine again.
 */
export class PreviewMachine<T extends PreviewLayout> {
  private phaseName: PreviewPhase = 'closed'
  private heldLayout: T | null = null
  private urls: string[] = []
  private readonly revokeUrl: (url: string) => void

  constructor(revokeUrl: (url: string) => void = defaultRevoke) {
    this.revokeUrl = revokeUrl
  }

  get phase(): PreviewPhase {
    return this.phaseName
  }

  held(): T | null {
    return this.heldLayout
  }

  /** False while a layout is held or one is still on the way, so a second one cannot start. */
  begin(): boolean {
    if (this.phaseName !== 'closed') return false
    this.phaseName = 'preparing'
    return true
  }

  /** The layout call cannot be interrupted. The click takes effect when that call returns. */
  cancel(): void {
    if (this.phaseName === 'preparing') this.phaseName = 'cancelling'
  }

  /** Cancel arrived before a layout existed. */
  finishCancel(): PreviewPhase {
    if (this.phaseName !== 'cancelling') return this.phaseName
    this.release()
    if (this.readPhase() !== 'unusable') this.phaseName = 'closed'
    return this.readPhase()
  }

  /**
   * Keep the layout only while still preparing. A cancel, or a layout that arrived
   * beside one already held, frees the newcomer and leaves the phase closed or open.
   */
  settle(layout: T): 'open' | 'closed' | 'unusable' {
    if (this.phaseName !== 'preparing' || this.heldLayout !== null) {
      this.freeLayout(layout)
      if (this.readPhase() === 'unusable') return 'unusable'
      if (this.phaseName === 'cancelling') this.phaseName = 'closed'
      return this.phaseName === 'open' || this.phaseName === 'exporting' ? 'open' : 'closed'
    }
    this.heldLayout = layout
    this.phaseName = 'open'
    return 'open'
  }

  fail(): PreviewPhase {
    if (this.phaseName === 'closed' || this.phaseName === 'unusable') return this.phaseName
    const layout = this.heldLayout
    this.heldLayout = null
    this.dropUrls()
    this.phaseName = 'failed'
    this.freeLayout(layout)
    return this.readPhase()
  }

  /** Drop the layout without `free`. Calling into wasm again would use a dead instance. */
  abort(): void {
    this.heldLayout = null
    this.dropUrls()
    this.phaseName = 'unusable'
  }

  dismiss(): void {
    if (this.phaseName !== 'failed') return
    this.phaseName = 'closed'
  }

  startExport(): boolean {
    if (this.phaseName !== 'open' || this.heldLayout === null) return false
    this.phaseName = 'exporting'
    return true
  }

  finishExport(): boolean {
    if (this.phaseName !== 'exporting') return false
    this.phaseName = 'open'
    return true
  }

  close(): PreviewPhase {
    if (this.phaseName === 'preparing') {
      this.phaseName = 'cancelling'
      return this.phaseName
    }
    if (this.phaseName !== 'open' && this.phaseName !== 'exporting') return this.phaseName
    const layout = this.heldLayout
    this.heldLayout = null
    this.dropUrls()
    this.phaseName = 'closed'
    this.freeLayout(layout)
    return this.readPhase()
  }

  /** A url that arrives after close is revoked immediately, so a late frame cannot leak it. */
  holdUrl(url: string): void {
    if (!shouldRender(this.phaseName)) {
      this.revokeUrl(url)
      return
    }
    this.urls.push(url)
  }

  /** A fresh read. Control-flow narrowing of `phaseName` does not see writes made in `free`. */
  private readPhase(): PreviewPhase {
    return this.phaseName
  }

  private release(): void {
    const layout = this.heldLayout
    this.heldLayout = null
    this.dropUrls()
    this.freeLayout(layout)
  }

  /** A panic while dropping the layout leaves the instance unusable. `free` is not tried again. */
  private freeLayout(layout: T | null): void {
    if (!layout) return
    try {
      layout.free()
    } catch (error) {
      if (!isWasmAbort(error)) throw error
      this.phaseName = 'unusable'
    }
  }

  private dropUrls(): void {
    const urls = this.urls
    this.urls = []
    for (const url of urls) this.revokeUrl(url)
  }
}

export interface PageSource {
  pageCount(): number
  pageSize(index: number): readonly [number, number]
  pagePng(index: number, dpi: number): Uint8Array
}

export interface PreviewFontInfo {
  readonly family: string
  readonly embedded: boolean
}

export interface PreviewDetails {
  readonly pages: number
  readonly fonts: readonly PreviewFontInfo[]
}

export interface PreviewHandlers {
  onCancel(): void
  onClose(): void
  onExport(): void
  onRenderError(error: unknown): void
}

export interface PreviewView {
  showPreparing(): void
  markCancelling(): void
  showPages(layout: PageSource, dpi: number, details: PreviewDetails): void
  setExporting(exporting: boolean): void
  hide(): void
}

export function mountPreview<T extends PreviewLayout>(
  before: HTMLElement,
  machine: PreviewMachine<T>,
  handlers: PreviewHandlers,
): PreviewView {
  const region = document.createElement('div')
  region.className = 'preview'
  region.setAttribute('role', 'region')
  region.setAttribute('aria-label', t('print.region'))
  region.hidden = true

  const bar = document.createElement('div')
  bar.className = 'preview-bar'
  const count = document.createElement('span')
  count.className = 'preview-count'
  const exportButton = barButton(t('print.export'), 'primary', handlers.onExport)
  const closeButton = barButton(t('print.close'), '', handlers.onClose)
  const cancelButton = barButton(t('print.cancel'), '', handlers.onCancel)
  exportButton.hidden = true
  closeButton.hidden = true
  bar.append(count, exportButton, closeButton, cancelButton)

  const scroller = document.createElement('div')
  scroller.className = 'preview-pages'
  region.append(bar, scroller)
  before.parentElement?.insertBefore(region, before)

  let generation = 0
  let frame = 0
  let observer: IntersectionObserver | null = null
  let resize: ResizeObserver | null = null
  let source: PageSource | null = null
  let dpi = CSS_DPI
  const visible = new Set<number>()
  const done = new Set<number>()
  let boxes: HTMLElement[] = []
  let images: HTMLImageElement[] = []
  let sizes: { widthPt: number; heightPt: number }[] = []

  function stopRendering(): void {
    generation += 1
    if (frame !== 0) cancelAnimationFrame(frame)
    frame = 0
    observer?.disconnect()
    observer = null
    resize?.disconnect()
    resize = null
    source = null
    visible.clear()
    done.clear()
    boxes = []
    images = []
    sizes = []
  }

  function hide(): void {
    stopRendering()
    scroller.replaceChildren()
    region.hidden = true
    delete region.dataset.pages
    delete region.dataset.fonts
  }

  function showPreparing(): void {
    stopRendering()
    scroller.replaceChildren()
    count.textContent = t('print.preparing')
    exportButton.hidden = true
    closeButton.hidden = true
    cancelButton.hidden = false
    cancelButton.disabled = false
    exportButton.disabled = false
    region.hidden = false
    delete region.dataset.pages
    delete region.dataset.fonts
    cancelButton.focus()
  }

  function applyFit(): void {
    const available = Math.max(0, scroller.clientWidth - 32)
    for (let index = 0; index < boxes.length; index++) {
      const size = sizes[index]
      const box = boxes[index]
      const img = images[index]
      if (!size || !box || !img) continue
      const fitted = fittedPagePx(size.widthPt, size.heightPt, available)
      const width = `${fitted.width}px`
      const height = `${fitted.height}px`
      if (box.style.width !== width) box.style.width = width
      if (box.style.height !== height) box.style.height = height
      if (img.style.width !== width) img.style.width = width
      if (img.style.height !== height) img.style.height = height
    }
  }

  function seedVisible(): void {
    visible.clear()
    const root = scroller.getBoundingClientRect()
    if (root.height < 1) {
      if (boxes.length > 0) visible.add(0)
      return
    }
    for (let index = 0; index < boxes.length; index++) {
      const box = boxes[index]
      if (!box) continue
      const rect = box.getBoundingClientRect()
      if (rect.bottom > root.top && rect.top < root.bottom) visible.add(index)
    }
    if (visible.size === 0 && boxes.length > 0) visible.add(0)
  }

  function schedule(token: number): void {
    if (frame !== 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      if (token !== generation) return
      step(token)
    })
  }

  function step(token: number): void {
    if (token !== generation || !shouldRender(machine.phase)) return
    const layout = source
    if (!layout) return
    const index = nextPage(images.length, [...visible].sort((a, b) => a - b), done)
    if (index === null) return
    let png: Uint8Array
    try {
      png = layout.pagePng(index, dpi)
    } catch (error) {
      if (token !== generation) return
      handlers.onRenderError(error)
      return
    }
    // The call blocks the thread. A close that landed during it runs before the next frame.
    if (token !== generation || !shouldRender(machine.phase)) return
    const url = URL.createObjectURL(new Blob([pngBytes(png)], { type: 'image/png' }))
    machine.holdUrl(url)
    const img = images[index]
    if (img) img.src = url
    done.add(index)
    schedule(token)
  }

  function showPages(layout: PageSource, nextDpi: number, details: PreviewDetails): void {
    stopRendering()
    const token = generation
    source = layout
    dpi = nextDpi
    count.textContent = t('print.pages', { count: details.pages })
    region.dataset.pages = String(details.pages)
    region.dataset.fonts = JSON.stringify(details.fonts)
    exportButton.hidden = false
    closeButton.hidden = false
    cancelButton.hidden = true
    exportButton.disabled = false
    region.hidden = false
    scroller.replaceChildren()
    const pageCount = details.pages
    for (let index = 0; index < pageCount; index++) {
      const size = layout.pageSize(index)
      const widthPt = size[0]
      const heightPt = size[1]
      if (widthPt === undefined || heightPt === undefined) continue
      const box = document.createElement('div')
      box.className = 'preview-page'
      box.dataset.page = String(index)
      const img = document.createElement('img')
      img.alt = t('print.page', { page: index + 1, pages: pageCount })
      box.append(img)
      scroller.append(box)
      boxes.push(box)
      images.push(img)
      sizes.push({ widthPt, heightPt })
    }
    applyFit()
    observer = new IntersectionObserver((entries) => {
      if (token !== generation) return
      for (const entry of entries) {
        const index = Number((entry.target as HTMLElement).dataset.page)
        if (!Number.isInteger(index)) continue
        if (entry.isIntersecting) visible.add(index)
        else visible.delete(index)
      }
      schedule(token)
    }, { root: scroller })
    for (const box of boxes) observer.observe(box)
    resize = new ResizeObserver(() => {
      if (token !== generation) return
      applyFit()
    })
    resize.observe(scroller)
    seedVisible()
    schedule(token)
    closeButton.focus()
  }

  return {
    showPreparing,
    markCancelling() {
      cancelButton.disabled = true
    },
    showPages,
    setExporting(exporting: boolean) {
      exportButton.disabled = exporting
    },
    hide,
  }
}

function pngBytes(png: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(png.byteLength)
  new Uint8Array(copy).set(png)
  return copy
}

function barButton(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  if (className !== '') button.className = className
  button.setAttribute('aria-label', label)
  button.textContent = label
  button.addEventListener('click', onClick)
  return button
}
