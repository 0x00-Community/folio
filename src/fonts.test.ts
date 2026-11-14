import assert from 'node:assert/strict'
import { test } from 'node:test'
import { aliasChain, cssStack } from './fonts.ts'

test('cssStack builds the 宋体 substitute list and ends in the generic family', () => {
  const stack = cssStack('宋体', 'serif')
  assert.ok(stack.endsWith(', serif'), 'css stack ends with the generic family')
  assert.ok(stack.includes('SimSun'), '宋体 stack includes SimSun')
  assert.ok(stack.includes('"宋体"'), 'non-ascii family names are quoted')
  assert.ok(stack.includes('"Songti SC"'), 'family names with spaces are quoted')
})

test('aliasChain walks the task order, with SimSun before 宋体', () => {
  assert.deepEqual(aliasChain('宋体').slice(0, 4), ['SimSun', '宋体', 'Songti SC', 'STSong'])
  assert.deepEqual(aliasChain('Calibri'), ['Calibri', 'Carlito'])
  assert.deepEqual(aliasChain('Courier New'), ['Courier New', 'Liberation Mono'])
  assert.deepEqual(aliasChain('等线').slice(0, 2), ['DengXian', 'PingFang SC'])
})
