import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { extname, join } from 'node:path'

export type FontFace = {
  id: string
  path: string
  faceIndex: number
  families: string[]
  bold: boolean
  italic: boolean
  cjk: boolean
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
    const os2 = tables.get('OS/2')
    if (os2 && os2.length >= 62) {
      const bytes = read(os2.at, Math.min(os2.length, 96))
      const weight = u16(bytes, 4)
      const selection = u16(bytes, 62)
      bold = weight >= 600 || (selection & 0x20) !== 0
      italic = (selection & 0x01) !== 0
      const unicodeRange2 = u32(bytes, 46)
      cjk = (unicodeRange2 & (1 << (59 - 32))) !== 0
    }
    return { faceIndex, families: [...families], bold, italic, cjk }
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
