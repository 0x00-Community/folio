// Resize math for an inline picture. The box is in page pixels (the layout, before zoom).
// Pointer deltas are screen pixels. The opposite corner or side stays fixed.
import type { Pos } from '../model.ts'

export const MIN_IMAGE_PT = 8
export const HANDLE_SCREEN_PX = 8
export const HANDLE_HIT_SCREEN_PX = 14
export const MOVE_THRESHOLD_PX = 4

export const RESIZE_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
export type ResizeHandle = (typeof RESIZE_HANDLES)[number]

export interface PageBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface ResizeLimits {
  /** Minimum width and height, in the same units as the box. */
  readonly min: number
  /** Maximum width, in the same units as the box. Height has no maximum of its own. */
  readonly maxWidth: number
}

export type ImageGesture =
  | { readonly kind: 'resize', readonly box: PageBox, readonly label: string }
  | { readonly kind: 'move', readonly from: Pos, readonly target: Pos | null }

const CORNER: ReadonlySet<ResizeHandle> = new Set(['nw', 'ne', 'se', 'sw'])

export function isCorner(handle: ResizeHandle): boolean {
  return CORNER.has(handle)
}

/** The resize cursor for a handle. */
export function resizeCursor(handle: ResizeHandle): string {
  if (handle === 'nw' || handle === 'se') return 'nwse-resize'
  if (handle === 'ne' || handle === 'sw') return 'nesw-resize'
  if (handle === 'n' || handle === 's') return 'ns-resize'
  return 'ew-resize'
}

/**
 * The box after dragging `handle` by a screen-pixel delta.
 * A corner keeps the starting aspect ratio. A side changes one dimension.
 * When the maximum width is below the minimum, the width limit wins and a
 * corner scales both sides together.
 */
export function resizeBox(
  start: PageBox,
  handle: ResizeHandle,
  dxScreen: number,
  dyScreen: number,
  zoom: number,
  limits: ResizeLimits,
): PageBox {
  const z = zoom > 0 && Number.isFinite(zoom) ? zoom : 1
  const dx = dxScreen / z
  const dy = dyScreen / z
  const min = limits.min > 0 && Number.isFinite(limits.min) ? limits.min : 0
  const maxWidth = limits.maxWidth > 0 && Number.isFinite(limits.maxWidth) ? limits.maxWidth : start.width
  const left = start.x
  const top = start.y
  const right = start.x + start.width
  const bottom = start.y + start.height
  const east = handle === 'ne' || handle === 'e' || handle === 'se'
  const west = handle === 'nw' || handle === 'w' || handle === 'sw'
  const south = handle === 'se' || handle === 's' || handle === 'sw'
  const north = handle === 'ne' || handle === 'n' || handle === 'nw'

  if (isCorner(handle)) {
    const signX = east ? 1 : -1
    const signY = south ? 1 : -1
    const width0 = start.width > 0 ? start.width : 1
    const height0 = start.height > 0 ? start.height : 1
    const rawW = width0 + signX * dx
    const rawH = height0 + signY * dy
    const denom = width0 * width0 + height0 * height0
    let factor = (width0 * rawW + height0 * rawH) / denom
    if (!Number.isFinite(factor)) factor = 1
    // A pointer that has not changed the box leaves a picture that is already
    // under the minimum or over the maximum alone. A real drag is clamped.
    if (Math.abs(factor - 1) > 1e-9) {
      const minFactor = Math.max(min / width0, min / height0)
      const maxFactor = maxWidth / width0
      factor = maxFactor < minFactor ? maxFactor : Math.min(maxFactor, Math.max(minFactor, factor))
    }
    const width = width0 * factor
    const height = height0 * factor
    return {
      x: east ? left : right - width,
      y: south ? top : bottom - height,
      width,
      height,
    }
  }

  let x = left
  let y = top
  let width = start.width
  let height = start.height
  if (east || west) {
    const raw = east ? start.width + dx : start.width - dx
    width = clampSpan(raw, start.width, min, maxWidth)
    x = east ? left : right - width
  }
  if (north || south) {
    const raw = south ? start.height + dy : start.height - dy
    height = clampSpan(raw, start.height, min, null)
    y = south ? top : bottom - height
  }
  return { x, y, width, height }
}

/** Top-left of a handle's hit square, in page pixels, centered on the handle point. */
export function handleOrigin(box: PageBox, handle: ResizeHandle, hitScreenPx: number, zoom: number): { x: number, y: number } {
  const z = zoom > 0 && Number.isFinite(zoom) ? zoom : 1
  const hit = hitScreenPx / z
  const cx = handle === 'nw' || handle === 'w' || handle === 'sw'
    ? box.x
    : handle === 'ne' || handle === 'e' || handle === 'se'
      ? box.x + box.width
      : box.x + box.width / 2
  const cy = handle === 'nw' || handle === 'n' || handle === 'ne'
    ? box.y
    : handle === 'sw' || handle === 's' || handle === 'se'
      ? box.y + box.height
      : box.y + box.height / 2
  return { x: cx - hit / 2, y: cy - hit / 2 }
}

function clampSpan(raw: number, start: number, min: number, max: number | null): number {
  if (Math.abs(raw - start) < 1e-9) return start
  if (max !== null && max < min) return max
  let value = raw < min ? min : raw
  if (max !== null && value > max) value = max
  return value
}
