// PageViewport: paints PageViews from the engine as positioned spans; owns page virtualization, fonts, media,
// overlays (caret, selection, composition underline) and zoom. Holds no document state beyond DOM caches.
//
// Usage (written first):
//
//   const view = new PageViewport(scrollerEl)
//   view.render(update, (i) => engine.page(i), (k) => engine.fontBytes(k), (k) => engine.mediaBytes(k))
//   view.setZoom(1.25)                                    // CSS transform only
//   const at = view.toDocPoint(e.clientX, e.clientY)       // pointer -> document points for the engine
//   input.placeAt(update.caret && view.caretClientRect(update.caret))

import type { CaretRect, DocPoint, FontMeta, LineView, PageMeta, PageView, Shape, Update } from './wire'

type PageSource = (index: number) => PageView
type Bytes = (key: string) => Uint8Array | undefined

/**
 * One @font-face per content key, declared at weight 400 so `font-weight: 700` synthesizes bold where rdocx did.
 * The baseline offset is measured once per key with a DOM probe, so span placement matches this browser exactly.
 */
class FontRegistry {
  private readonly ascent = new Map<string, number>()
  private readonly sheet: CSSStyleSheet | null = null

  /** Idempotent: a known key is skipped. */
  ensure(fonts: FontMeta[], bytes: Bytes): Promise<void> {
    // TODO: for new keys: blob URL from bytes(key); insertRule(@font-face { font-family: "k<key>"; src: url(blob) });
    // await document.fonts.load(`16px "k<key>"`); probe baseline -> ascent.set(key, ratio)
    throw new Error('not implemented')
  }

  /** Ascent as a fraction of font size, as this browser places the baseline in a line box. */
  ascentOf(key: string): number {
    throw new Error('not implemented')
  }
}

/** Blob URLs for images, keyed by content hash; idempotent. */
class MediaRegistry {
  private readonly urls = new Map<string, string>()
  url(key: string, bytes: Bytes): string {
    throw new Error('not implemented')
  }
}

/** A mounted page's DOM, reused across frames. Lines are reconciled by key; shapes are replaced when their key changes. */
type MountedPage = {
  meta: PageMeta
  root: HTMLElement
  lines: Map<string, HTMLElement>
  shapesKey: string
  overlay: HTMLElement
}

type Slot = { meta: PageMeta; mounted: MountedPage | null; stale: boolean }

export class PageViewport {
  private slots: Slot[] = []
  private zoom = 1
  private readonly fonts = new FontRegistry()
  private readonly media = new MediaRegistry()
  /** Pages within one viewport of the visible area are mounted; the rest are sized placeholders. */
  private readonly observer: IntersectionObserver

  constructor(private readonly scroller: HTMLElement) {
    throw new Error('not implemented')
  }

  /**
   * Apply one Update. With `layout`: resize the page stack from PageMeta (pt, `top` in document space), mark slots
   * whose hash changed as stale, fetch PageViews only for mounted stale pages. Always: redraw overlays and reveal.
   */
  render(u: Update, page: PageSource, fontBytes: Bytes, mediaBytes: Bytes): void {
    throw new Error('not implemented')
  }

  reset(): void {
    throw new Error('not implemented')
  }

  setZoom(zoom: number): void {
    throw new Error('not implemented')
  }

  /** Client px -> document points (inverse of zoom and scroll); null outside every page and gap. */
  toDocPoint(clientX: number, clientY: number): DocPoint | null {
    throw new Error('not implemented')
  }

  caretClientRect(caret: CaretRect): DOMRect {
    throw new Error('not implemented')
  }

  viewportHeightPt(): number {
    throw new Error('not implemented')
  }

  private paintPage(slot: Slot, view: PageView, mediaBytes: Bytes): void {
    // TODO: keep line elements whose key is in view.lines, remove the others, create the new ones in order;
    // replace the per-page <svg> (below / above text) only if view.shapes.key changed.
    throw new Error('not implemented')
  }

  /**
   * One span per SpanView, in pt: left = x, top = baseline - ascentOf(font) * size, font: `${size}pt "k${font}"`,
   * white-space: pre, letter-spacing = ls, transform when the run sits in a rotated or scaled group.
   */
  private lineElement(line: LineView): HTMLElement {
    throw new Error('not implemented')
  }

  private shapesElement(shapes: Shape[], mediaBytes: Bytes): SVGSVGElement {
    throw new Error('not implemented')
  }

  /** Caret (blinking, restarted on each Update), selection rects, composition underline: per-page overlay divs. */
  private paintOverlays(u: Update): void {
    throw new Error('not implemented')
  }
}
