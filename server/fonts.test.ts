import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { readFaces, scanFonts } from './fonts.ts'

const directory = '/Users/lilleap/code/rdocx/crates/oxml-layout/fonts'

test('scanFonts finds Carlito and the Noto Sans SC subset', () => {
  const faces = scanFonts([directory])
  assert.ok(faces.some((face) => face.families.includes('Carlito')))
  assert.ok(faces.some((face) => face.cjk && face.path.includes('NotoSansSC')))
})

test('readFaces reports bold for Carlito-Bold', () => {
  const bytes = readFileSync(`${directory}/Carlito-Bold.ttf`)
  const face = readFaces((offset, length) => bytes.subarray(offset, offset + length))[0]
  if (face === undefined) throw new Error('Carlito-Bold has no face')
  assert.equal(face.bold, true)
  assert.ok(face.families.includes('Carlito'))
})
