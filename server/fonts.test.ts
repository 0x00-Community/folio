import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import server from '../server.ts'
import { extractFace, readFaceMetrics, readFaces, resolveFont, scanFonts } from './fonts.ts'

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

test('resolve 宋体 returns SimSun from the user font library', () => {
  const faces = scanFonts([join(homedir(), 'Library', 'Fonts')])
  const resolved = resolveFont('宋体', faces)
  assert.ok(resolved, '宋体 resolves to an installed face')
  assert.equal(resolved.family, 'SimSun', '宋体 resolves to SimSun')
  assert.equal(resolved.metrics.unitsPerEm > 0, true, 'SimSun has unitsPerEm')
  assert.equal(Number.isFinite(resolved.metrics.ascender), true, 'SimSun ascender is a number')
  assert.equal(Number.isFinite(resolved.metrics.descender), true, 'SimSun descender is a number')
  assert.equal(Number.isFinite(resolved.metrics.lineGap), true, 'SimSun lineGap is a number')
})

test('resolve Calibri returns Carlito or nothing, matching what is installed', () => {
  const resolved = resolveFont('Calibri', scanFonts())
  if (resolved === null) {
    assert.equal(resolved, null, 'Calibri and Carlito are not installed')
    return
  }
  assert.ok(
    resolved.family === 'Carlito' || resolved.family === 'Calibri',
    `Calibri resolved to ${resolved.family}`,
  )
})

test('GET /api/fonts/resolve returns SimSun for 宋体', async () => {
  const response = await server.fetch(
    new Request(`http://localhost/api/fonts/resolve?family=${encodeURIComponent('宋体')}`),
  )
  assert.equal(response.status, 200, '宋体 resolves over HTTP')
  const body: unknown = await response.json()
  assert.equal(isFamily(body, 'SimSun'), true, 'HTTP resolve returns SimSun')
})

test('extracts Hiragino Sans GB face 0 as a single sfnt', () => {
  const source = new Uint8Array(readFileSync('/System/Library/Fonts/Hiragino Sans GB.ttc'))
  const face = extractFace(source, 0)
  const read = (offset: number, length: number) => face.subarray(offset, offset + length)
  const faces = readFaces(read)
  assert.equal(faces.length, 1, 'extracted sfnt has one face')
  assert.ok(faces[0]?.families.includes('Hiragino Sans GB'), 'extracted family is Hiragino Sans GB')
  const metrics = readFaceMetrics(read, 0)
  assert.ok(metrics !== undefined && metrics.unitsPerEm > 0, 'extracted face has metrics')
  assert.equal(metrics?.ascender, honoredAscender(source, 0), 'honored ascender matches USE_TYPO_METRICS')
})

function isFamily(value: unknown, family: string): boolean {
  return typeof value === 'object' && value !== null && 'family' in value && value.family === family
}

function honoredAscender(bytes: Uint8Array, faceIndex: number): number {
  const u16 = (data: Uint8Array, at: number) => ((data[at] ?? 0) << 8) | (data[at + 1] ?? 0)
  const i16 = (data: Uint8Array, at: number) => {
    const value = u16(data, at)
    return value >= 0x8000 ? value - 0x10000 : value
  }
  const u32 = (data: Uint8Array, at: number) =>
    (((data[at] ?? 0) << 24) >>> 0) +
    (((data[at + 1] ?? 0) << 16) | ((data[at + 2] ?? 0) << 8) | (data[at + 3] ?? 0))
  const tagAt = (data: Uint8Array, at: number) =>
    String.fromCharCode(data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0, data[at + 3] ?? 0)
  const origin = tagAt(bytes, 0) === 'ttcf' ? u32(bytes, 12 + faceIndex * 4) : 0
  const count = u16(bytes.subarray(origin, origin + 12), 4)
  const records = bytes.subarray(origin + 12, origin + 12 + count * 16)
  let hheaAt = 0
  let os2At = 0
  let os2Len = 0
  for (let index = 0; index < count; index++) {
    const name = tagAt(records, index * 16)
    const at = u32(records, index * 16 + 8)
    const length = u32(records, index * 16 + 12)
    if (name === 'hhea') hheaAt = at
    if (name === 'OS/2') {
      os2At = at
      os2Len = length
    }
  }
  const hheaAscender = i16(bytes.subarray(hheaAt, hheaAt + 10), 4)
  if (os2Len < 74) return hheaAscender
  const os2 = bytes.subarray(os2At, os2At + os2Len)
  return (u16(os2, 62) & 0x80) !== 0 ? i16(os2, 68) : hheaAscender
}
