import assert from 'node:assert/strict'
import { test } from 'node:test'
import { aliasChain, cssStack, installedFamilies } from './fonts.ts'

test('cssStack builds the 宋体 substitute list and ends in the generic family', () => {
  const stack = cssStack('宋体', 'serif')
  assert.ok(stack.endsWith(', serif'), 'css stack ends with the generic family')
  assert.ok(stack.includes('SimSun'), '宋体 stack includes SimSun')
  assert.ok(stack.includes('"宋体"'), 'non-ascii family names are quoted')
  assert.ok(stack.includes('"Songti SC"'), 'family names with spaces are quoted')
})

test('installedFamilies drops private names, keeps the first spelling, and reads the index once', async () => {
  const faces = [
    { id: 'a', families: ['Times New Roman', 'Arial', '.SF NS'] },
    { id: 'b', families: ['arial', '宋体', ''] },
    { id: 'c', families: [' .Private', 'Calibri', 'Calibri'] },
    { id: 'd', families: 'nope' },
    'bad',
  ]
  const inserted = ['Times New Roman', 'Arial', '宋体', 'Calibri']
  const expected = [...inserted].sort((a, b) => a.localeCompare(b))
  let hits = 0
  const previous = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === '/api/fonts') {
      hits += 1
      return { ok: true, json: async () => faces } as Response
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch
  try {
    const first = await installedFamilies()
    const second = await installedFamilies()
    assert.deepEqual(first, expected)
    assert.deepEqual(second, expected)
    assert.equal(hits, 1, 'the index is fetched once')
    assert.ok(!first.some((name) => name.startsWith('.')), 'private names stay out')
  } finally {
    globalThis.fetch = previous
  }
})

test('aliasChain walks the task order, with SimSun before 宋体', () => {
  assert.deepEqual(aliasChain('宋体').slice(0, 4), ['SimSun', '宋体', 'Songti SC', 'STSong'])
  assert.deepEqual(aliasChain('Calibri'), ['Calibri', 'Carlito'])
  assert.deepEqual(aliasChain('Courier New'), ['Courier New', 'Liberation Mono'])
  assert.deepEqual(aliasChain('等线').slice(0, 2), ['DengXian', 'PingFang SC'])
})
