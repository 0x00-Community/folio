import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  RESIZE_HANDLES,
  handleOrigin,
  resizeBox,
  resizeCursor,
} from './image-geom.ts'
import type { PageBox, ResizeHandle } from './image-geom.ts'

const limits = { min: 8, maxWidth: 400 }
const start: PageBox = { x: 10, y: 20, width: 100, height: 50 }

function close(got: number, want: number): void {
  assert.ok(Math.abs(got - want) < 1e-9, `${got} vs ${want}`)
}

function sameBox(got: PageBox, want: PageBox): void {
  close(got.x, want.x)
  close(got.y, want.y)
  close(got.width, want.width)
  close(got.height, want.height)
}

const opposite: Record<ResizeHandle, (box: PageBox) => { x: number, y: number }> = {
  se: (box) => ({ x: box.x, y: box.y }),
  e: (box) => ({ x: box.x, y: box.y + box.height / 2 }),
  ne: (box) => ({ x: box.x, y: box.y + box.height }),
  n: (box) => ({ x: box.x + box.width / 2, y: box.y + box.height }),
  nw: (box) => ({ x: box.x + box.width, y: box.y + box.height }),
  w: (box) => ({ x: box.x + box.width, y: box.y + box.height / 2 }),
  sw: (box) => ({ x: box.x + box.width, y: box.y }),
  s: (box) => ({ x: box.x + box.width / 2, y: box.y }),
}

test('each handle keeps the opposite side and the corner ratio', () => {
  const dragged: Record<ResizeHandle, { dx: number, dy: number, box: PageBox }> = {
    se: { dx: 20, dy: 10, box: { x: 10, y: 20, width: 120, height: 60 } },
    e: { dx: 30, dy: 80, box: { x: 10, y: 20, width: 130, height: 50 } },
    ne: { dx: 20, dy: -10, box: { x: 10, y: 10, width: 120, height: 60 } },
    n: { dx: 40, dy: 10, box: { x: 10, y: 30, width: 100, height: 40 } },
    nw: { dx: -20, dy: -10, box: { x: -10, y: 10, width: 120, height: 60 } },
    w: { dx: 30, dy: -40, box: { x: 40, y: 20, width: 70, height: 50 } },
    sw: { dx: -20, dy: 10, box: { x: -10, y: 20, width: 120, height: 60 } },
    s: { dx: -40, dy: 20, box: { x: 10, y: 20, width: 100, height: 70 } },
  }
  for (const handle of RESIZE_HANDLES) {
    const step = dragged[handle]
    const next = resizeBox(start, handle, step.dx, step.dy, 1, limits)
    sameBox(next, step.box)
    const before = opposite[handle](start)
    const after = opposite[handle](next)
    close(after.x, before.x)
    close(after.y, before.y)
    if (handle === 'nw' || handle === 'ne' || handle === 'se' || handle === 'sw') {
      close(next.width / next.height, start.width / start.height)
    } else if (handle === 'e' || handle === 'w') {
      close(next.height, start.height)
    } else {
      close(next.width, start.width)
    }
  }
})

test('zoom scales the pointer delta before the box changes', () => {
  const next = resizeBox(start, 'se', 20, 10, 2, limits)
  sameBox(next, { x: 10, y: 20, width: 110, height: 55 })
  close(next.width / next.height, start.width / start.height)
})

test('a corner stops at both limits and scales both sides', () => {
  const small = resizeBox(start, 'se', -1000, -1000, 1, limits)
  sameBox(small, { x: 10, y: 20, width: 16, height: 8 })
  const large = resizeBox(start, 'se', 10000, 10000, 1, limits)
  sameBox(large, { x: 10, y: 20, width: 400, height: 200 })
  const east = resizeBox(start, 'e', 10000, 0, 1, limits)
  sameBox(east, { x: 10, y: 20, width: 400, height: 50 })
  const west = resizeBox(start, 'w', 10000, 0, 1, limits)
  sameBox(west, { x: 102, y: 20, width: 8, height: 50 })
  close(west.x + west.width, start.x + start.width)
})

test('a side that does not move stays, even under the minimum', () => {
  const thin: PageBox = { x: 0, y: 0, width: 100, height: 4 }
  const held = resizeBox(thin, 'e', 10, 0, 1, limits)
  sameBox(held, { x: 0, y: 0, width: 110, height: 4 })
  const untouched = resizeBox(thin, 's', 0, 0, 1, limits)
  sameBox(untouched, thin)
  const grown = resizeBox(thin, 's', 0, 1, 1, limits)
  sameBox(grown, { x: 0, y: 0, width: 100, height: 8 })
})

test('a width limit below the minimum wins for the dragged width', () => {
  const tight = { min: 8, maxWidth: 4 }
  const side = resizeBox(start, 'e', 10, 0, 1, tight)
  sameBox(side, { x: 10, y: 20, width: 4, height: 50 })
  const corner = resizeBox(start, 'se', 10, 10, 1, tight)
  sameBox(corner, { x: 10, y: 20, width: 4, height: 2 })
  close(corner.width / corner.height, start.width / start.height)
})

test('handle hit origins sit on the box and cursors match the direction', () => {
  const origin = handleOrigin(start, 'se', 14, 2)
  close(origin.x, start.x + start.width - 3.5)
  close(origin.y, start.y + start.height - 3.5)
  assert.equal(resizeCursor('se'), 'nwse-resize')
  assert.equal(resizeCursor('ne'), 'nesw-resize')
  assert.equal(resizeCursor('n'), 'ns-resize')
  assert.equal(resizeCursor('e'), 'ew-resize')
})
