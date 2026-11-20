import assert from 'node:assert/strict'
import { test } from 'node:test'
import { aliasChain, cssStack, installPrintFonts, installedFamilies, printFonts, selectNewPrintFonts } from './fonts.ts'
import type { PrintCatalogFace } from './fonts.ts'

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

function face(id: string, families: string[], fields: Partial<PrintCatalogFace> = {}): PrintCatalogFace {
  return {
    id,
    families,
    bold: false,
    italic: false,
    cjk: true,
    truetype: true,
    weight: 400,
    ...fields,
  }
}

/** Songti SC as this machine lists it: Black, Bold, Light, plus a CFF twin and Calibri. */
function songtiCatalog(): PrintCatalogFace[] {
  return [
    face('songti-black', ['Songti SC', '宋体-简'], { bold: true, weight: 900 }),
    face('songti-bold', ['Songti SC', '宋体-简'], { bold: true, weight: 700 }),
    face('songti', ['Songti SC', '宋体-简'], { weight: 300 }),
    face('songti-otf', ['Songti SC'], { truetype: false, weight: 400 }),
    face('source-han', ['Source Han Serif SC'], { truetype: false }),
    face('calibri', ['Calibri'], { cjk: false }),
  ]
}

test('printFonts maps 宋体 and SimSun onto one Songti face and one alias', () => {
  const catalog = songtiCatalog().filter((item) => !item.bold)
  const plan = printFonts(['宋体', 'SimSun'], catalog)
  assert.deepEqual(plan.faces, [{ id: 'songti', family: '宋体' }])
  assert.deepEqual(plan.aliases, [['SimSun', '宋体']])
})

test('printFonts adds the bold face, skips Calibri and CFF, and supplies 宋体 for Han text', () => {
  const catalog = songtiCatalog()
  const both = printFonts(['宋体', 'SimSun'], catalog)
  assert.deepEqual(both.faces, [
    { id: 'songti', family: '宋体' },
    { id: 'songti-bold', family: '宋体 Bold' },
  ])
  assert.deepEqual(both.aliases, [['SimSun', '宋体']])
  assert.equal(both.faces.some((item) => item.id === 'songti-black' || item.id === 'songti-otf'), false)

  assert.deepEqual(printFonts(['Calibri'], catalog), { faces: [], aliases: [] })
  const cffOnly = catalog.filter((item) => item.truetype === false || item.cjk === false)
  assert.deepEqual(printFonts(['宋体'], cffOnly), { faces: [], aliases: [] })

  const han = printFonts(['Calibri', 'Times New Roman'], catalog, true)
  assert.deepEqual(han.faces, [
    { id: 'songti', family: '宋体' },
    { id: 'songti-bold', family: '宋体 Bold' },
  ])
  assert.deepEqual(han.aliases, [])
  assert.deepEqual(printFonts(['Calibri', 'Times New Roman'], catalog), { faces: [], aliases: [] })
})

test('a face the session already holds is not added again', () => {
  const added: string[] = []
  const aliases: string[] = []
  const source = {
    addFont(family: string) {
      added.push(family)
    },
    addFontAlias(requested: string, loaded: string) {
      aliases.push(`${requested}=${loaded}`)
    },
  }
  const fetched = {
    faces: [{ family: '宋体', bytes: new Uint8Array([1, 2]) }],
    aliases: [['SimSun', '宋体'] as [string, string]],
  }
  const plan = {
    faces: [
      { id: 'songti', family: '宋体' },
      { id: 'hei', family: '黑体' },
    ],
    aliases: [['SimSun', '宋体'] as [string, string], ['Heiti SC', '黑体'] as [string, string]],
  }
  assert.deepEqual(selectNewPrintFonts(source, plan), plan)
  installPrintFonts(source, fetched)
  installPrintFonts(source, fetched)
  assert.deepEqual(added, ['宋体'])
  assert.deepEqual(aliases, ['SimSun=宋体'])
  assert.deepEqual(selectNewPrintFonts(source, plan), {
    faces: [{ id: 'hei', family: '黑体' }],
    aliases: [['Heiti SC', '黑体']],
  })
})
