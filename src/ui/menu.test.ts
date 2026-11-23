import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FILE_MENU, gridKey, menuKey } from './menu.ts'
import type { MenuFlag } from './menu.ts'

function items(disabled: readonly string[] = []): MenuFlag[] {
  const out: MenuFlag[] = []
  for (const entry of FILE_MENU) {
    if (entry.kind === 'item') out.push({ disabled: disabled.includes(entry.id) })
  }
  return out
}

test('the file menu lists file commands with a rule before page setup', () => {
  assert.deepEqual(
    FILE_MENU.map(entry => entry.kind === 'item' ? entry.id : 'rule'),
    ['new', 'open', 'save', 'saveAs', 'rule', 'pageSetup', 'print'],
  )
})

test('arrow keys wrap and skip a disabled Save', () => {
  const rows = items(['save'])
  // 0 new, 1 open, 2 save, 3 saveAs, 4 pageSetup, 5 print
  assert.deepEqual(menuKey(1, rows, 'ArrowDown'), { kind: 'move', index: 3 })
  assert.deepEqual(menuKey(3, rows, 'ArrowUp'), { kind: 'move', index: 1 })
  assert.deepEqual(menuKey(5, rows, 'ArrowDown'), { kind: 'move', index: 0 })
  assert.deepEqual(menuKey(0, rows, 'ArrowUp'), { kind: 'move', index: 5 })
  assert.deepEqual(menuKey(4, rows, 'Home'), { kind: 'move', index: 0 })
  assert.deepEqual(menuKey(1, rows, 'End'), { kind: 'move', index: 5 })
  assert.deepEqual(menuKey(-1, rows, 'ArrowDown'), { kind: 'move', index: 0 })
  assert.deepEqual(menuKey(-1, rows, 'ArrowUp'), { kind: 'move', index: 5 })
})

test('Home and End skip disabled ends', () => {
  const rows = items(['new', 'print'])
  assert.deepEqual(menuKey(3, rows, 'Home'), { kind: 'move', index: 1 })
  assert.deepEqual(menuKey(1, rows, 'End'), { kind: 'move', index: 4 })
})

test('Enter and Space activate an enabled item and leave a disabled one', () => {
  const rows = items(['save'])
  assert.deepEqual(menuKey(1, rows, 'Enter'), { kind: 'activate', index: 1 })
  assert.deepEqual(menuKey(4, rows, ' '), { kind: 'activate', index: 4 })
  assert.deepEqual(menuKey(2, rows, 'Enter'), { kind: 'stay' })
  assert.deepEqual(menuKey(2, rows, ' '), { kind: 'stay' })
})

test('Escape and Tab close', () => {
  const rows = items()
  assert.deepEqual(menuKey(0, rows, 'Escape'), { kind: 'close' })
  assert.deepEqual(menuKey(3, rows, 'Tab'), { kind: 'close' })
  assert.deepEqual(menuKey(0, [], 'Escape'), { kind: 'close' })
})

test('a letter or an unrelated arrow does nothing', () => {
  const rows = items()
  for (const key of ['a', 'n', 'S', '1', 'ArrowLeft', 'ArrowRight', 'Shift', 'Meta']) {
    assert.deepEqual(menuKey(1, rows, key), { kind: 'stay' }, key)
  }
  assert.deepEqual(menuKey(1, [], 'ArrowDown'), { kind: 'stay' })
})

function cells(count: number, disabled: readonly number[] = []): MenuFlag[] {
  return Array.from({ length: count }, (_, index) => ({ disabled: disabled.includes(index) }))
}

test('palette arrows move by row and wrap inside a short row', () => {
  const rows = [1, 10, 5]
  const items = cells(16)
  assert.deepEqual(gridKey(0, rows, items, 'ArrowDown'), { kind: 'move', index: 1 })
  assert.deepEqual(gridKey(1, rows, items, 'ArrowRight'), { kind: 'move', index: 2 })
  assert.deepEqual(gridKey(10, rows, items, 'ArrowRight'), { kind: 'move', index: 1 })
  assert.deepEqual(gridKey(1, rows, items, 'ArrowLeft'), { kind: 'move', index: 10 })
  assert.deepEqual(gridKey(5, rows, items, 'ArrowDown'), { kind: 'move', index: 15 })
  assert.deepEqual(gridKey(15, rows, items, 'ArrowDown'), { kind: 'move', index: 0 })
  assert.deepEqual(gridKey(15, rows, items, 'ArrowRight'), { kind: 'move', index: 11 })
  assert.deepEqual(gridKey(11, rows, items, 'ArrowUp'), { kind: 'move', index: 1 })
  assert.deepEqual(gridKey(0, rows, items, 'ArrowUp'), { kind: 'move', index: 11 })
  assert.deepEqual(gridKey(7, rows, items, 'Home'), { kind: 'move', index: 0 })
  assert.deepEqual(gridKey(0, rows, items, 'End'), { kind: 'move', index: 15 })
  assert.deepEqual(gridKey(4, rows, items, 'Enter'), { kind: 'activate', index: 4 })
  assert.deepEqual(gridKey(4, rows, items, ' '), { kind: 'activate', index: 4 })
  assert.deepEqual(gridKey(4, rows, items, 'Escape'), { kind: 'close' })
  assert.deepEqual(gridKey(4, rows, items, 'a'), { kind: 'stay' })
  assert.deepEqual(gridKey(2, rows, cells(16, [3]), 'ArrowRight'), { kind: 'move', index: 4 })
  assert.deepEqual(gridKey(4, rows, cells(16, [4]), 'Enter'), { kind: 'stay' })
})
