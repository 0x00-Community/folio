import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PrintError } from './engine/print-error.ts'
import { aliasChain, clearFontCatalog, cssStack, ensurePrintFonts, fetchMetrics, installPrintFonts, installedFamilies, printFonts, rememberedFamilies, selectNewPrintFonts } from './fonts.ts'
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

test('ensurePrintFonts fetches one face at a time and reports the family that failed', async () => {
  clearFontCatalog()
  const catalog = [face('song', ['宋体']), face('hei', ['黑体'])]
  let inFlight = 0
  let maxInFlight = 0
  let held = 0
  let maxHeld = 0
  const events: string[] = []
  const previous = globalThis.fetch
  const respond = (failHei: boolean) => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === '/api/fonts') return { ok: true, json: async () => catalog } as Response
      const id = decodeURIComponent(url.split('/').at(-2) ?? '')
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await Promise.resolve()
      inFlight -= 1
      if (failHei && id === 'hei') return { ok: false } as Response
      const bytes = new Uint8Array([id === 'hei' ? 2 : 1])
      return {
        ok: true,
        arrayBuffer: async () => {
          held += 1
          maxHeld = Math.max(maxHeld, held)
          return bytes.buffer
        },
      } as Response
    }) as typeof fetch
  }
  const source = () => ({
    addFont(family: string) {
      events.push(`font:${family}`)
      held -= 1
    },
    addFontAlias(requested: string, loaded: string) {
      events.push(`alias:${requested}=${loaded}`)
    },
  })
  try {
    respond(false)
    await ensurePrintFonts(source(), ['宋体', 'SimSun', '黑体'], false)
    assert.deepEqual(events, ['font:宋体', 'font:黑体', 'alias:SimSun=宋体'])
    assert.equal(maxInFlight, 1)
    assert.equal(maxHeld, 1)

    clearFontCatalog()
    inFlight = 0
    maxInFlight = 0
    held = 0
    maxHeld = 0
    events.length = 0
    respond(true)
    const failing = source()
    await assert.rejects(
      () => ensurePrintFonts(failing, ['宋体', '黑体'], false),
      (error: unknown) => {
        assert.ok(error instanceof PrintError)
        assert.equal(error.kind, 'font')
        assert.equal(error.family, '黑体')
        return true
      },
    )
    assert.deepEqual(events, ['font:宋体'])
    assert.equal(maxInFlight, 1)
    assert.equal(maxHeld, 1)
  } finally {
    globalThis.fetch = previous
    clearFontCatalog()
  }
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

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

test('a failed font catalog is fetched again and a success is kept', async () => {
  clearFontCatalog()
  const faces = [{ id: 'a', families: ['Calibri', '宋体'] }]
  const expected = ['Calibri', '宋体'].sort((a, b) => a.localeCompare(b))
  let mode: 'status' | 'throw' | 'ok' = 'status'
  let hits = 0
  const previous = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = requestUrl(input)
    if (url !== '/api/fonts') throw new Error(`unexpected fetch ${url}`)
    hits += 1
    if (mode === 'status') return { ok: false, status: 503 } as Response
    if (mode === 'throw') throw new Error('offline')
    return { ok: true, json: async () => faces } as Response
  }) as typeof fetch
  try {
    assert.deepEqual(await installedFamilies(), [])
    assert.equal(hits, 1)
    mode = 'ok'
    assert.deepEqual(await installedFamilies(), expected)
    assert.deepEqual(await installedFamilies(), expected)
    assert.equal(hits, 2, 'a success is not fetched again')

    clearFontCatalog()
    hits = 0
    mode = 'throw'
    assert.deepEqual(await installedFamilies(), [])
    assert.equal(hits, 1)
    mode = 'ok'
    assert.deepEqual(await installedFamilies(), expected)
    assert.equal(hits, 2)
    assert.deepEqual(await installedFamilies(), expected)
    assert.equal(hits, 2)
  } finally {
    globalThis.fetch = previous
    clearFontCatalog()
  }
})

test('two catalog readers share one in-flight fetch', async () => {
  clearFontCatalog()
  let hits = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const previous = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = requestUrl(input)
    if (url !== '/api/fonts') throw new Error(`unexpected fetch ${url}`)
    hits += 1
    await gate
    return { ok: true, json: async () => [{ id: 'a', families: ['Arial'] }] } as Response
  }) as typeof fetch
  try {
    const first = installedFamilies()
    const second = installedFamilies()
    assert.equal(hits, 1)
    release?.()
    assert.deepEqual(await first, ['Arial'])
    assert.deepEqual(await second, ['Arial'])
    assert.equal(hits, 1)
    assert.deepEqual(await installedFamilies(), ['Arial'])
    assert.equal(hits, 1, 'a success is not fetched again')
  } finally {
    release?.()
    globalThis.fetch = previous
    clearFontCatalog()
  }
})

test('a missing catalog is not treated as a family the index does not have', async () => {
  assert.deepEqual(rememberedFamilies(['Calibri', '宋体'], false, []), [])
  assert.deepEqual(rememberedFamilies(['Calibri'], false, ['Calibri']), [])
  assert.deepEqual(rememberedFamilies(['Calibri'], true, []), ['Calibri'])
  assert.deepEqual(rememberedFamilies(['Calibri'], true, ['Calibri', '宋体']), ['Calibri', '宋体'])

  clearFontCatalog()
  let catalogHits = 0
  let resolveHits = 0
  let catalogOk = false
  const previous = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = requestUrl(input)
    if (url === '/api/fonts') {
      catalogHits += 1
      if (!catalogOk) return { ok: false, status: 503 } as Response
      return {
        ok: true,
        json: async () => [{ id: 'arial', families: ['Arial'], cjk: false, truetype: true }],
      } as Response
    }
    resolveHits += 1
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch
  try {
    const down = await fetchMetrics(['Calibri', '宋体'])
    assert.equal(down.available, false)
    assert.equal(down.faces.size, 0)
    assert.equal(catalogHits, 1, 'one catalog request for every missing family')
    assert.equal(resolveHits, 0)
    const again = await fetchMetrics(['Calibri'])
    assert.equal(again.available, false)
    assert.equal(catalogHits, 2, 'a failed catalog is not reused')

    catalogOk = true
    const missing = await fetchMetrics(['Calibri'])
    assert.equal(missing.available, true)
    assert.equal(missing.faces.has('Calibri'), false)
    assert.equal(resolveHits, 0, 'an unlisted family is not resolved')
    assert.deepEqual(rememberedFamilies(['Calibri'], missing.available, missing.faces.keys()), ['Calibri'])
    assert.deepEqual(rememberedFamilies(['Calibri'], down.available, down.faces.keys()), [])
  } finally {
    globalThis.fetch = previous
    clearFontCatalog()
  }
})

test('Han text with no font catalog fails preview, and a catalog without a Chinese face does not', async () => {
  clearFontCatalog()
  let mode: 'status' | 'throw' | 'ok' = 'status'
  let body: unknown = null
  let allowFace = false
  const previous = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = requestUrl(input)
    if (url === '/api/fonts') {
      if (mode === 'throw') throw new Error('offline')
      if (mode === 'status') return { ok: false, status: 503 } as Response
      return { ok: true, json: async () => body } as Response
    }
    if (allowFace && url.endsWith('/face')) {
      return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer } as Response
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch
  const target = () => ({
    addFont() {},
    addFontAlias() {},
  })
  try {
    await assert.rejects(
      () => ensurePrintFonts(target(), ['Calibri'], true),
      (error: unknown) => {
        assert.ok(error instanceof PrintError)
        assert.equal(error.kind, 'font')
        assert.equal(error.family, '宋体')
        return true
      },
    )
    clearFontCatalog()
    mode = 'throw'
    await assert.rejects(
      () => ensurePrintFonts(target(), ['Calibri'], true),
      (error: unknown) => error instanceof PrintError && error.kind === 'font' && error.family === '宋体',
    )
    clearFontCatalog()
    mode = 'status'
    await ensurePrintFonts(target(), ['Calibri'], false)

    clearFontCatalog()
    mode = 'ok'
    body = [face('calibri', ['Calibri'], { cjk: false })]
    await ensurePrintFonts(target(), ['Calibri'], true)

    clearFontCatalog()
    body = [face('song', ['宋体'])]
    allowFace = true
    const held = target()
    await ensurePrintFonts(held, ['宋体'], true)
    clearFontCatalog()
    mode = 'status'
    allowFace = false
    await ensurePrintFonts(held, ['宋体'], true)
  } finally {
    globalThis.fetch = previous
    clearFontCatalog()
  }
})
