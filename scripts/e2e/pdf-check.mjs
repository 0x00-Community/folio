// Poppler checks shared by the print hook and the preview export.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert } from './acde.mjs'

const POPPLER = '/opt/homebrew/bin'

export function poppler(tool, args) {
  return execFileSync(join(POPPLER, tool), args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

export function listedFonts(output) {
  const lines = output.split('\n').filter((line) => line.trim() !== '')
  const header = lines[0] || ''
  const embAt = header.indexOf('emb')
  assert(embAt >= 0, 'pdffonts has no emb column')
  const fonts = []
  for (const line of lines.slice(2)) {
    const name = line.trim().split(/\s+/)[0]
    if (!name || /^-+$/.test(name)) continue
    const emb = (line.slice(embAt).trim().split(/\s+/)[0] || '')
    fonts.push({ name, embedded: emb === 'yes' })
  }
  return fonts
}

export function pdfPages(path) {
  const info = poppler('pdfinfo', [path])
  const line = info.split('\n').find((item) => item.startsWith('Pages:'))
  assert(line, 'pdfinfo has no Pages line')
  return Number(line.slice('Pages:'.length).trim())
}

export function strip(text) {
  return text.replace(/\s+/g, '')
}

export function readable(text) {
  return ['rdocx-acdefixtureheader', 'rdocx-acdefixturefooter'].reduce(
    (out, token) => out.split(token).join(''),
    strip(text),
  )
}

export function pdfText(path) {
  return readable(poppler('pdftotext', ['-enc', 'UTF-8', path, '-']))
}

export function missingPart(haystack, parts) {
  let rest = haystack
  for (const part of parts) {
    const token = strip(part)
    if (!token) continue
    const at = rest.indexOf(token)
    if (at < 0) return token
    rest = rest.slice(at + token.length)
  }
  return null
}

export function familyPrefix(family) {
  const prefix = family.replace(/[^A-Za-z0-9-]/g, '')
  return prefix || 'Font'
}

// How many characters of the document the PDF lacks, counted as a multiset. A paragraph that a page break
// cuts inside a table has a repeated header row between its halves, so its text is not contiguous in the PDF.
export function shortfall(text, parts) {
  const have = new Map()
  for (const ch of text) have.set(ch, (have.get(ch) ?? 0) + 1)
  let missing = 0
  for (const part of parts) {
    for (const ch of strip(part)) {
      const left = have.get(ch) ?? 0
      if (left > 0) have.set(ch, left - 1)
      else missing += 1
    }
  }
  return missing
}

// `maxShortfall` replaces the in-order check with a count, for documents whose tables break across pages.
export function checkPdf(path, result, paragraphs, quiet, maxShortfall) {
  const fonts = listedFonts(poppler('pdffonts', [path]))
  assert(fonts.length > 0, 'pdffonts listed no fonts')
  assert(fonts.every((font) => font.embedded), 'a font is not embedded')
  const cjk = (result.fonts || []).filter((font) => /[^\x00-\x7f]|Songti|Kaiti|Heiti|Fangsong|STSong/i.test(font.family))
  assert(cjk.length > 0, 'layout used no CJK face')
  assert(cjk.every((font) => font.embedded), 'a CJK face is not embedded')
  const named = fonts.some((font) => cjk.some((face) => font.name.startsWith(familyPrefix(face.family))))
  assert(named, `no font name starts with ${cjk.map((face) => familyPrefix(face.family)).join(', ')}`)
  assert(pdfPages(path) === result.pages, `pdfinfo pages differ from the layout (${result.pages})`)
  const text = readable(poppler('pdftotext', ['-enc', 'UTF-8', path, '-']))
  if (maxShortfall !== undefined) {
    const lacking = shortfall(text, paragraphs)
    console.log(`  shortfall ${lacking} characters`)
    assert(lacking <= maxShortfall, `the PDF lacks ${lacking} characters of the document (limit ${maxShortfall})`)
    return
  }
  const missing = missingPart(text, paragraphs)
  const detail = missing !== null && !quiet ? `missing ${missing.slice(0, 40)}` : 'exported text does not contain the document text in order'
  assert(missing === null, detail)
}

export function withPdf(base64, run) {
  const dir = mkdtempSync(join(tmpdir(), 'rdocx-print-e2e-'))
  const path = join(dir, 'out.pdf')
  try {
    writeFileSync(path, Buffer.from(base64, 'base64'))
    return run(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function lcsRatio(reference, exported) {
  const left = codes(reference)
  const right = codes(exported)
  const width = right.length
  let prev = new Uint32Array(width + 1)
  let curr = new Uint32Array(width + 1)
  for (let i = 1; i <= left.length; i++) {
    const code = left[i - 1]
    for (let j = 1; j <= width; j++) {
      if (code === right[j - 1]) curr[j] = (prev[j - 1] ?? 0) + 1
      else {
        const up = prev[j] ?? 0
        const across = curr[j - 1] ?? 0
        curr[j] = up > across ? up : across
      }
    }
    const swap = prev
    prev = curr
    curr = swap
    curr.fill(0)
  }
  const matched = prev[width] ?? 0
  return left.length === 0 ? 1 : matched / left.length
}

function codes(text) {
  const out = new Uint16Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i)
  return out
}
