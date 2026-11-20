import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  TABLE_COLUMN_DEFAULT,
  TABLE_COLUMN_MAX,
  TABLE_ROW_DEFAULT,
  TABLE_ROW_MAX,
  readTableSize,
} from './table-tools.ts'

test('table size accepts 1 to 20 rows and 1 to 10 columns', () => {
  assert.deepEqual(readTableSize('3', '3'), { size: { rows: 3, cols: 3 }, invalid: [] })
  assert.deepEqual(readTableSize(String(TABLE_ROW_DEFAULT), String(TABLE_COLUMN_DEFAULT)).size, { rows: 3, cols: 3 })
  assert.deepEqual(readTableSize('1', '1').size, { rows: 1, cols: 1 })
  assert.deepEqual(readTableSize(String(TABLE_ROW_MAX), String(TABLE_COLUMN_MAX)).size, { rows: 20, cols: 10 })
  assert.deepEqual(readTableSize(' 2 ', '03').size, { rows: 2, cols: 3 })
})

test('a blank, fractional, or out-of-range table size is rejected per field', () => {
  const rows = readTableSize('21', '3')
  assert.equal(rows.size, null)
  assert.deepEqual(rows.invalid, ['rows'])
  const cols = readTableSize('3', '11')
  assert.equal(cols.size, null)
  assert.deepEqual(cols.invalid, ['cols'])
  assert.deepEqual(readTableSize('0', '0').invalid, ['rows', 'cols'])
  assert.deepEqual(readTableSize('', '3').invalid, ['rows'])
  assert.deepEqual(readTableSize('2.5', '3').invalid, ['rows'])
  assert.deepEqual(readTableSize('-1', '3').invalid, ['rows'])
  assert.deepEqual(readTableSize('3e0', '1').invalid, ['rows'])
  assert.deepEqual(readTableSize('  ', '10').invalid, ['rows'])
})
