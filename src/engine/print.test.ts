import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { test } from 'node:test'
import { aliasChain } from '../fonts.ts'
import { extractFace, readFaces, readFontFile } from '../../server/fonts.ts'
import { cell, makeDoc, paragraph, paraLook, pt, row, storyKey, styleId, table, text, NORMAL } from '../editor/testkit.ts'
import type { Block, RunLook, StoryKey, StyleId, StyleSheet } from '../model.ts'
import { PrintError, createEngine, fontsUsedIn } from './engine.ts'
import { initSync } from './pkg/engine.js'

const root = new URL('../../', import.meta.url)

initSync({ module: readFileSync(new URL('public/engine.wasm', root)) })
const engine = createEngine()

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`fixtures/${name}`, root)))
}

function songtiFace(): Uint8Array {
  const path = process.env.WORD_TEST_CJK_FONT ?? '/System/Library/Fonts/Supplemental/Songti.ttc'
  if (!existsSync(path)) {
    throw new Error(`WORD_TEST_CJK_FONT file is missing or unreadable at ${path}`)
  }
  const bytes = readFontFile(path)
  const ext = extname(path).toLowerCase()
  if (ext !== '.ttc' && ext !== '.otc') return bytes
  const faces = readFaces((offset, length) => bytes.subarray(offset, offset + length))
  for (const name of aliasChain('宋体')) {
    const key = name.toLowerCase()
    const matches = faces.filter((face) => face.families.some((item) => item.toLowerCase() === key))
    const face = matches.find((item) => !item.bold && !item.italic) ?? matches[0]
    if (face) return extractFace(bytes, face.faceIndex)
  }
  throw new Error(`WORD_TEST_CJK_FONT has no 宋体 face at ${path}`)
}

test('addFont stores a bold companion without listing it', () => {
  const opened = engine.blank()
  try {
    const bytes = new Uint8Array([0, 1, 2, 3])
    opened.source.addFont('宋体 Bold', bytes)
    opened.source.addFont('宋体', bytes)
    const used = opened.source.fontsUsed(opened.doc)
    assert.equal(used.includes('宋体'), true)
    assert.equal(used.includes('宋体 Bold'), false)
  } finally {
    opened.source.free()
  }
})

function faceLook(family: string): RunLook {
  return {
    fonts: { ascii: family, hAnsi: family, eastAsia: family, cs: family },
    sizePt: pt(11),
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    color: 'auto',
    caps: false,
    charSpacingPt: pt(0),
  }
}

function paraStyle(name: string, basedOn: StyleId | null = null): StyleSheet['paragraph'] extends ReadonlyMap<StyleId, infer Value> ? Value : never {
  return { name, role: null, next: null, basedOn, look: paraLook() }
}

function sorted(names: readonly string[]): string[] {
  return [...names].sort((left, right) => left.localeCompare(right))
}

test('fontsUsed names families of used styles, not every style in the table', () => {
  const song = styleId('song')
  const hei = styleId('hei')
  const kai = styleId('kai')
  const fang = styleId('fang')
  const child = styleId('child')
  const looks = new Map<string, RunLook>([
    [`${song}\0`, faceLook('宋体')],
    [`${hei}\0`, faceLook('黑体')],
    [`${kai}\0`, faceLook('楷体')],
    [`${fang}\0`, faceLook('仿宋')],
    [`${child}\0`, faceLook('Calibri')],
  ])
  const tableStyles = (): StyleSheet => ({
    paragraph: new Map([
      [NORMAL, { name: 'Normal', role: 'normal', next: null, look: paraLook() }],
      [song, paraStyle('Song')],
      [hei, paraStyle('Hei')],
      [kai, paraStyle('Kai')],
      [fang, paraStyle('Fang')],
      [child, paraStyle('Child', fang)],
    ]),
    character: new Map(),
    defaultParagraph: NORMAL,
    added: [],
  })
  const onlySong = makeDoc([paragraph('p1', [text('正文')], { style: song })], { styles: tableStyles() })
  assert.deepEqual(sorted(fontsUsedIn(onlySong, looks)), sorted(['Calibri', '宋体']))

  const stories = new Map<StoryKey, readonly Block[]>()
  stories.set(storyKey('s0/header/default'), [paragraph('h1', [text('页眉')], { style: kai })])
  const placed = makeDoc(
    [
      paragraph('p1', [text('正文')], { style: song }),
      table('t1', [row([cell([paragraph('c1', [text('格')], { style: hei })])])]),
    ],
    { styles: tableStyles(), stories },
  )
  assert.deepEqual(sorted(fontsUsedIn(placed, looks)), sorted(['Calibri', '宋体', '楷体', '黑体']))

  const chained = makeDoc([paragraph('p1', [text('子样式')], { style: child })], { styles: tableStyles() })
  assert.deepEqual(sorted(fontsUsedIn(chained, looks)), sorted(['Calibri', '仿宋']))
})

test('fontsUsed on basic.docx is the families the text and the default style name', () => {
  const opened = engine.open(fixture('basic.docx'))
  try {
    assert.deepEqual(sorted(opened.source.fontsUsed(opened.doc)), sorted(['Arial', 'Calibri', 'Times New Roman', '楷体', '宋体']))
  } finally {
    opened.source.free()
  }
})

test('printLayout of basic.docx with the Songti face returns pages and a PDF', () => {
  const opened = engine.open(fixture('basic.docx'))
  let layout: ReturnType<typeof opened.source.printLayout> | undefined
  try {
    const face = songtiFace()
    opened.source.addFont('宋体', face)
    opened.source.addFontAlias('SimSun', '宋体')
    const printed = opened.source.printLayout(opened.doc)
    layout = printed
    assert.equal(printed.pageCount() > 0, true, 'page count')
    const blockPages = printed.blockPages()
    assert.equal(blockPages.length, opened.doc.body.length)
    let previous = -1
    for (const entry of blockPages) {
      if (entry.firstPage === null) {
        assert.equal(entry.lastPage, null)
        continue
      }
      assert.equal(entry.lastPage !== null && entry.lastPage >= entry.firstPage, true)
      assert.equal(entry.firstPage >= previous, true)
      previous = entry.firstPage
    }
    const last = blockPages[blockPages.length - 1]
    assert.ok(last)
    assert.equal(last.lastPage, printed.pageCount() - 1)
    const boxes = printed.blockBoxes()
    assert.equal(boxes.length, blockPages.length)
    for (const entry of boxes) {
      const placed = blockPages[entry.index]
      assert.ok(placed)
      assert.equal(entry.index, placed.index)
      let previous = -1
      for (const fragment of entry.fragments) {
        assert.equal(fragment.height > 0, true, 'fragment height')
        assert.equal(Number.isFinite(fragment.y), true, 'fragment y')
        assert.equal(fragment.page >= previous, true, 'page order')
        previous = fragment.page
      }
      if (placed.firstPage === null) assert.equal(entry.fragments.length, 0)
      else {
        assert.equal(entry.fragments[0]?.page, placed.firstPage)
        assert.equal(entry.fragments[entry.fragments.length - 1]?.page, placed.lastPage)
      }
    }
    const pdf = printed.pdf()
    assert.equal(Buffer.from(pdf.subarray(0, 5)).toString('latin1'), '%PDF-')
    const png = printed.pagePng(0, 144)
    assert.equal(png[0], 0x89)
    assert.equal(png[1], 0x50)
    const fonts = printed.fonts()
    assert.equal(
      fonts.some((font) => font.embedded && font.family.includes('Songti')),
      true,
      'Songti is embedded',
    )
    assert.throws(
      () => printed.pagePng(1000, 144),
      (error: unknown) => {
        assert.ok(error instanceof PrintError)
        assert.equal(error.kind, 'render')
        assert.equal(typeof error.detail, 'string')
        return true
      },
    )
  } finally {
    layout?.free()
    opened.source.free()
  }
})
