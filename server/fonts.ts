import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { extname, join } from 'node:path'
import { aliasChain } from '../src/fonts.ts'

export type FontFace = {
  id: string
  path: string
  faceIndex: number
  families: string[]
  bold: boolean
  italic: boolean
  cjk: boolean
  /** OS/2 usWeightClass. 400 when the face has no OS/2 table. */
  weight: number
  /** TrueType outlines. CFF (OTTO) faces are not embedded by the PDF writer. */
  truetype: boolean
  size: number
}

type Reader = (offset: number, length: number) => Uint8Array

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.otc'])
const MAX_DEPTH = 4

export function fontDirectories(os = platform(), home = homedir(), env = process.env): string[] {
  if (os === 'darwin') {
    return [
      '/System/Library/Fonts',
      '/System/Library/Fonts/Supplemental',
      '/Library/Fonts',
      join(home, 'Library/Fonts'),
      '/System/Library/AssetsV2',
    ]
  }
  if (os === 'win32') {
    const windows = env.WINDIR || 'C:\\Windows'
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    return [join(windows, 'Fonts'), join(local, 'Microsoft', 'Windows', 'Fonts')]
  }
  return ['/usr/share/fonts', '/usr/local/share/fonts', join(home, '.local/share/fonts'), join(home, '.fonts')]
}

function* fontFiles(dir: string, depth = 0): Generator<string> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) yield* fontFiles(path, depth + 1)
    } else if (FONT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      yield path
    }
  }
}

function byte(bytes: Uint8Array, at: number): number {
  return bytes[at] ?? 0
}

function u16(bytes: Uint8Array, at: number) {
  return (byte(bytes, at) << 8) | byte(bytes, at + 1)
}

function i16(bytes: Uint8Array, at: number) {
  const value = u16(bytes, at)
  return value >= 0x8000 ? value - 0x10000 : value
}

function u32(bytes: Uint8Array, at: number) {
  return ((byte(bytes, at) << 24) >>> 0) + ((byte(bytes, at + 1) << 16) | (byte(bytes, at + 2) << 8) | byte(bytes, at + 3))
}

function tag(bytes: Uint8Array, at: number) {
  return String.fromCharCode(byte(bytes, at), byte(bytes, at + 1), byte(bytes, at + 2), byte(bytes, at + 3))
}

function decodeName(bytes: Uint8Array, platformId: number): string {
  if (platformId === 0 || platformId === 3) {
    let text = ''
    for (let i = 0; i + 1 < bytes.length; i += 2) text += String.fromCharCode(u16(bytes, i))
    return text
  }
  return String.fromCharCode(...bytes)
}

/** Reads family names, style flags and CJK coverage of every face in a TTF, OTF or TTC. */
export function readFaces(read: Reader): Omit<FontFace, 'id' | 'path' | 'size'>[] {
  const head = read(0, 12)
  const offsets: number[] = []
  if (tag(head, 0) === 'ttcf') {
    const count = Math.min(u32(head, 8), 64)
    const table = read(12, count * 4)
    for (let i = 0; i < count; i++) offsets.push(u32(table, i * 4))
  } else {
    offsets.push(0)
  }
  return offsets.map((offset, faceIndex) => {
    const directory = read(offset, 12)
    const tableCount = u16(directory, 4)
    const records = read(offset + 12, tableCount * 16)
    const tables = new Map<string, { at: number; length: number }>()
    for (let i = 0; i < tableCount; i++) {
      tables.set(tag(records, i * 16), { at: u32(records, i * 16 + 8), length: u32(records, i * 16 + 12) })
    }
    const families = new Set<string>()
    const name = tables.get('name')
    if (name) {
      const bytes = read(name.at, Math.min(name.length, 1 << 20))
      const count = u16(bytes, 2)
      const strings = u16(bytes, 4)
      for (let i = 0; i < count; i++) {
        const record = 6 + i * 12
        const nameId = u16(bytes, record + 6)
        if (nameId !== 1 && nameId !== 16) continue
        const platformId = u16(bytes, record)
        const length = u16(bytes, record + 8)
        const start = strings + u16(bytes, record + 10)
        const value = decodeName(bytes.subarray(start, start + length), platformId).trim()
        if (value && (platformId !== 1 || /^[\x20-\x7e]+$/.test(value))) families.add(value)
      }
    }
    let bold = false
    let italic = false
    let cjk = false
    let weight = 400
    const os2 = tables.get('OS/2')
    if (os2 && os2.length >= 62) {
      const bytes = read(os2.at, Math.min(os2.length, 96))
      const usWeight = u16(bytes, 4)
      weight = usWeight === 0 ? 400 : usWeight
      const selection = u16(bytes, 62)
      bold = weight >= 600 || (selection & 0x20) !== 0
      italic = (selection & 0x01) !== 0
      const unicodeRange2 = u32(bytes, 46)
      cjk = (unicodeRange2 & (1 << (59 - 32))) !== 0
    }
    const truetype = tag(read(offset, 4), 0) !== 'OTTO'
    return { faceIndex, families: [...families], bold, italic, cjk, weight, truetype }
  })
}

function fileReader(path: string): { read: Reader; close: () => void } {
  const fd = openSync(path, 'r')
  return {
    read(offset, length) {
      const buffer = new Uint8Array(length)
      readSync(fd, buffer, 0, length, offset)
      return buffer
    },
    close: () => closeSync(fd),
  }
}

/** Every font face on this system with its family names, in directory order. Unreadable files are skipped. */
export function scanFonts(directories = fontDirectories()): FontFace[] {
  const faces: FontFace[] = []
  const seen = new Set<string>()
  for (const dir of directories) {
    for (const path of fontFiles(dir)) {
      if (seen.has(path)) continue
      seen.add(path)
      let reader: ReturnType<typeof fileReader> | undefined
      try {
        const size = statSync(path).size
        reader = fileReader(path)
        for (const face of readFaces(reader.read)) {
          faces.push({ ...face, id: String(faces.length), path, size })
        }
      } catch {
        // a damaged or unsupported font file is not a reason to fail the scan
      } finally {
        reader?.close()
      }
    }
  }
  return faces
}

export type FaceMetrics = {
  unitsPerEm: number
  ascender: number
  descender: number
  lineGap: number
  winAscent: number
  winDescent: number
  typoAscender: number
  typoDescender: number
  typoLineGap: number
  hheaAscender: number
  hheaDescender: number
  hheaLineGap: number
}

export type ResolvedFont = {
  id: string
  family: string
  faceIndex: number
  path: string
  metrics: FaceMetrics
}

function directoryTables(read: Reader, faceAt: number): Map<string, { at: number; length: number }> {
  const directory = read(faceAt, 12)
  const tableCount = u16(directory, 4)
  const records = read(faceAt + 12, tableCount * 16)
  const tables = new Map<string, { at: number; length: number }>()
  for (let i = 0; i < tableCount; i++) {
    tables.set(tag(records, i * 16), { at: u32(records, i * 16 + 8), length: u32(records, i * 16 + 12) })
  }
  return tables
}

function faceStart(read: Reader, faceIndex: number): number {
  const head = read(0, 12)
  if (tag(head, 0) !== 'ttcf') {
    if (faceIndex !== 0) throw new Error(`face ${faceIndex} is out of range`)
    return 0
  }
  const count = u32(head, 8)
  if (faceIndex < 0 || faceIndex >= count) throw new Error(`face ${faceIndex} is out of range`)
  return u32(read(12, (faceIndex + 1) * 4), faceIndex * 4)
}

/** hhea and OS/2 vertical metrics. `ascender`/`descender`/`lineGap` follow USE_TYPO_METRICS (fsSelection bit 7). */
export function readFaceMetrics(read: Reader, faceIndex: number): FaceMetrics | undefined {
  const tables = directoryTables(read, faceStart(read, faceIndex))
  const head = tables.get('head')
  const hhea = tables.get('hhea')
  if (head === undefined || hhea === undefined || head.length < 20 || hhea.length < 10) return undefined
  const headBytes = read(head.at, 20)
  const hheaBytes = read(hhea.at, 10)
  const unitsPerEm = u16(headBytes, 18)
  const hheaAscender = i16(hheaBytes, 4)
  const hheaDescender = i16(hheaBytes, 6)
  const hheaLineGap = i16(hheaBytes, 8)
  let winAscent = Math.abs(hheaAscender)
  let winDescent = Math.abs(hheaDescender)
  let typoAscender = hheaAscender
  let typoDescender = hheaDescender
  let typoLineGap = hheaLineGap
  let useTypo = false
  const os2 = tables.get('OS/2')
  if (os2 !== undefined && os2.length >= 64) {
    const bytes = read(os2.at, Math.min(os2.length, 96))
    const selection = u16(bytes, 62)
    if (bytes.length >= 78) {
      winAscent = u16(bytes, 74)
      winDescent = u16(bytes, 76)
    }
    if (bytes.length >= 74) {
      typoAscender = i16(bytes, 68)
      typoDescender = i16(bytes, 70)
      typoLineGap = i16(bytes, 72)
      // Bit 7 selects the OS/2 typographic line metrics over hhea.
      useTypo = (selection & 0x80) !== 0
    }
  }
  const honored = useTypo
    ? { ascender: typoAscender, descender: typoDescender, lineGap: typoLineGap }
    : { ascender: hheaAscender, descender: hheaDescender, lineGap: hheaLineGap }
  return {
    unitsPerEm,
    ...honored,
    winAscent,
    winDescent,
    typoAscender,
    typoDescender,
    typoLineGap,
    hheaAscender,
    hheaDescender,
    hheaLineGap,
  }
}

function familyMatches(face: FontFace, family: string): boolean {
  const key = family.toLowerCase()
  return face.families.some((name) => name.toLowerCase() === key)
}

/** The first alias that is installed, preferring a regular face over bold or italic. */
export function resolveFont(family: string, faces: readonly FontFace[]): ResolvedFont | null {
  for (const name of aliasChain(family)) {
    const matches = faces.filter((face) => familyMatches(face, name))
    const face = matches.find((item) => !item.bold && !item.italic) ?? matches[0]
    if (face === undefined) continue
    const reader = fileReader(face.path)
    try {
      const metrics = readFaceMetrics(reader.read, face.faceIndex)
      if (metrics === undefined) continue
      return { id: face.id, family: name, faceIndex: face.faceIndex, path: face.path, metrics }
    } finally {
      reader.close()
    }
  }
  return null
}

function writeU16(bytes: Uint8Array, at: number, value: number) {
  bytes[at] = (value >> 8) & 0xff
  bytes[at + 1] = value & 0xff
}

function writeU32(bytes: Uint8Array, at: number, value: number) {
  bytes[at] = (value >>> 24) & 0xff
  bytes[at + 1] = (value >>> 16) & 0xff
  bytes[at + 2] = (value >>> 8) & 0xff
  bytes[at + 3] = value & 0xff
}

function writeTag(bytes: Uint8Array, at: number, name: string) {
  bytes[at] = name.charCodeAt(0)
  bytes[at + 1] = name.charCodeAt(1)
  bytes[at + 2] = name.charCodeAt(2)
  bytes[at + 3] = name.charCodeAt(3)
}

function sumU32(bytes: Uint8Array): number {
  let sum = 0
  for (let at = 0; at < bytes.length; at += 4) sum = (sum + u32(bytes, at)) >>> 0
  return sum
}

/**
 * A single-face sfnt. Collection offsets are absolute, so the table directory is rewritten
 * and `head.checksumAdjustment` is recomputed for the new file.
 */
export function extractFace(bytes: Uint8Array, faceIndex: number): Uint8Array {
  const read = (offset: number, length: number) => bytes.subarray(offset, offset + length)
  const faceAt = faceStart(read, faceIndex)
  const directory = read(faceAt, 12)
  const tableCount = u16(directory, 4)
  const records = read(faceAt + 12, tableCount * 16)
  const tables: { name: string; checksum: number; length: number; bytes: Uint8Array }[] = []
  for (let i = 0; i < tableCount; i++) {
    const name = tag(records, i * 16)
    const checksum = u32(records, i * 16 + 4)
    const at = u32(records, i * 16 + 8)
    const length = u32(records, i * 16 + 12)
    if (at + length > bytes.length) throw new Error(`table ${name} is truncated`)
    const padded = new Uint8Array((length + 3) & ~3)
    padded.set(bytes.subarray(at, at + length))
    tables.push({ name, checksum, length, bytes: padded })
  }
  tables.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  let searchRange = 16
  let entrySelector = 0
  while (searchRange * 2 <= tableCount * 16) {
    searchRange *= 2
    entrySelector += 1
  }
  const rangeShift = tableCount * 16 - searchRange
  let offset = 12 + tableCount * 16
  const placed = tables.map((table) => {
    const at = offset
    offset += table.bytes.length
    return { ...table, at }
  })
  const out = new Uint8Array(offset)
  out.set(directory.subarray(0, 4))
  writeU16(out, 4, tableCount)
  writeU16(out, 6, searchRange)
  writeU16(out, 8, entrySelector)
  writeU16(out, 10, rangeShift)
  const head = placed.find((table) => table.name === 'head')
  if (head !== undefined && head.length >= 12) writeU32(head.bytes, 8, 0)
  for (let i = 0; i < placed.length; i++) {
    const table = placed[i]
    if (table === undefined) continue
    const at = 12 + i * 16
    writeTag(out, at, table.name)
    // Directory checksums are taken with head.checksumAdjustment still zero.
    writeU32(out, at + 4, sumU32(table.bytes))
    writeU32(out, at + 8, table.at)
    writeU32(out, at + 12, table.length)
    out.set(table.bytes, table.at)
  }
  if (head !== undefined && head.length >= 12) {
    const adjustment = (0xb1b0afba - sumU32(out)) >>> 0
    writeU32(out, head.at + 8, adjustment)
  }
  return out
}

export function readFontFile(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path))
}
