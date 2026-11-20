import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { test } from 'node:test'
import { aliasChain } from '../fonts.ts'
import { extractFace, readFaces, readFontFile } from '../../server/fonts.ts'
import { PrintError, createEngine } from './engine.ts'
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
