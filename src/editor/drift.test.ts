import assert from 'node:assert/strict'
import { test } from 'node:test'
import { drift } from './drift.ts'

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
