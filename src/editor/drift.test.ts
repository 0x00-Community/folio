import assert from 'node:assert/strict'
import { test } from 'node:test'
import { drift, heightDrift, heightKind } from './drift.ts'
import type { HeightKind } from './drift.ts'

function pages(first: readonly (number | null)[]): { firstPage: number | null }[] {
  return first.map((firstPage) => ({ firstPage }))
}

test('blocks on the same first page count, and the first mismatch is the lowest index', () => {
  const report = drift([0, 0, 1, 2], pages([0, 0, 2, 2]))
  assert.equal(report.blocks, 4)
  assert.equal(report.samePage, 3)
  assert.equal(report.share, 0.75)
  assert.equal(report.firstDiff, 2)
  assert.equal(report.editPages, 3)
  assert.equal(report.printPages, 3)
  assert.deepEqual(report.byPage, [
    { page: 0, blocks: 2, same: 2 },
    { page: 2, blocks: 2, same: 1 },
  ])
})

test('a null on either side differs, including when both are null', () => {
  const report = drift([0, null, null], pages([0, 1, null]))
  assert.equal(report.samePage, 1)
  assert.equal(report.firstDiff, 1)
  assert.equal(report.share, 1 / 3)
  assert.deepEqual(report.byPage, [
    { page: 0, blocks: 1, same: 1 },
    { page: 1, blocks: 1, same: 0 },
  ])
})

test('an empty pair agrees, and a longer side is a difference at the first missing block', () => {
  const empty = drift([], [])
  assert.equal(empty.blocks, 0)
  assert.equal(empty.samePage, 0)
  assert.equal(empty.share, 1)
  assert.equal(empty.firstDiff, null)
  assert.equal(empty.editPages, 0)
  assert.equal(empty.printPages, 0)
  assert.deepEqual(empty.byPage, [])

  const longer = drift([0], pages([0, 1]))
  assert.equal(longer.blocks, 2)
  assert.equal(longer.samePage, 1)
  assert.equal(longer.firstDiff, 1)
  assert.equal(longer.editPages, 1)
  assert.equal(longer.printPages, 2)
  assert.deepEqual(longer.byPage, [
    { page: 0, blocks: 1, same: 1 },
    { page: 1, blocks: 1, same: 0 },
  ])
})

test('byPage follows the print page, not the order the blocks were given', () => {
  const report = drift([2, 0, 0], pages([1, 0, 0]))
  assert.equal(report.firstDiff, 0)
  assert.equal(report.samePage, 2)
  assert.deepEqual(report.byPage, [
    { page: 0, blocks: 2, same: 2 },
    { page: 1, blocks: 1, same: 0 },
  ])
})

test('heightKind names the three block kinds', () => {
  assert.equal(heightKind('p'), 'paragraph')
  assert.equal(heightKind('table'), 'table')
  assert.equal(heightKind('opaque'), 'opaque')
})

test('height deltas are print minus edit, summed by kind, with the twenty largest', () => {
  const edit = Array.from({ length: 25 }, () => ({ kind: 'paragraph' as const, heightPt: 0 }))
  const print = Array.from({ length: 25 }, (_, index) => ({ heightPt: index + 1 }))
  const report = heightDrift(edit, print)
  assert.equal(report.blocks.length, 25)
  assert.equal(report.blocks[0]?.delta, 1)
  assert.equal(report.blocks[24]?.delta, 25)
  assert.equal(report.byKind.find((row) => row.kind === 'paragraph')?.delta, (25 * 26) / 2)
  assert.equal(report.byKind.find((row) => row.kind === 'table')?.delta, 0)
  assert.equal(report.byKind.find((row) => row.kind === 'opaque')?.delta, 0)
  assert.equal(report.largest.length, 20)
  assert.equal(report.largest[0]?.index, 24)
  assert.equal(report.largest[0]?.delta, 25)
  assert.equal(report.largest[19]?.index, 5)
  assert.equal(report.largest[19]?.delta, 6)
})

test('a missing height is left out of the kind sum and the largest list', () => {
  const report = heightDrift(
    [
      { kind: 'paragraph', heightPt: 10 },
      { kind: 'table', heightPt: null },
      { kind: 'opaque', heightPt: 4 },
      { kind: 'paragraph', heightPt: Number.NaN },
    ],
    [{ heightPt: 12 }, { heightPt: 8 }, { heightPt: null }, { heightPt: 9 }],
  )
  assert.equal(report.blocks[0]?.delta, 2)
  assert.equal(report.blocks[1]?.delta, null)
  assert.equal(report.blocks[2]?.delta, null)
  assert.equal(report.blocks[3]?.editPt, null)
  assert.equal(report.blocks[3]?.delta, null)
  assert.deepEqual(
    report.byKind.map((row) => row.delta),
    [2, 0, 0],
  )
  assert.deepEqual(
    report.largest.map((row) => row.index),
    [0],
  )
})

test('an empty height pair agrees, and a print block with no edit row is opaque', () => {
  const empty = heightDrift([], [])
  assert.deepEqual(empty.blocks, [])
  assert.deepEqual(
    empty.byKind.map((row) => row.delta),
    [0, 0, 0],
  )
  assert.deepEqual(empty.largest, [])

  const longer = heightDrift([], [{ heightPt: 3 }])
  assert.equal(longer.blocks[0]?.kind, 'opaque')
  assert.equal(longer.blocks[0]?.editPt, null)
  assert.equal(longer.blocks[0]?.printPt, 3)
  assert.equal(longer.blocks[0]?.delta, null)
})

test('equal absolute deltas keep the lower index first', () => {
  const report = heightDrift(
    [
      { kind: 'paragraph', heightPt: 0 },
      { kind: 'table', heightPt: 10 },
      { kind: 'opaque', heightPt: 0 },
    ],
    [{ heightPt: 5 }, { heightPt: 0 }, { heightPt: 10 }],
  )
  assert.deepEqual(
    report.largest.map((row) => row.index),
    [1, 2, 0],
  )
  assert.equal(report.byKind.find((row) => row.kind === 'table')?.delta, -10)
  assert.equal(report.byKind.find((row) => row.kind === 'opaque')?.delta, 10)
  const kinds: readonly HeightKind[] = report.byKind.map((row) => row.kind)
  assert.deepEqual(kinds, ['paragraph', 'table', 'opaque'])
})
