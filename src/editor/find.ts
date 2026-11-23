// One definition of a match. The find bar and `word.call` `find` both use it.
// A match stays inside one paragraph, never covers an atom (U+FFFC), and is addressed in the original UTF-16 offsets.
import { comparePos, flatText, indexOf } from '../model.ts'
import type { Block, Doc, ParaId, ParaLoc, Pos } from '../model.ts'

export interface FindOptions {
  readonly matchCase: boolean
  readonly wholeWord: boolean
}

export interface TextMatch {
  readonly para: ParaId
  readonly start: number
  readonly end: number
}

const ATOM = '\uFFFC'

// The same locale and granularity as the editor's word motion, so a whole word is a segmenter word, including Chinese.
const words = new Intl.Segmenter('zh', { granularity: 'word' })

/** Every match in body order. Headers, footers, and opaque-block previews are skipped. An empty needle matches nothing. */
export function findMatches(doc: Doc, needle: string, options: FindOptions): TextMatch[] {
  if (needle.length === 0 || needle.includes(ATOM)) return []
  const index = indexOf(doc)
  const out: TextMatch[] = []
  for (const id of index.ordered) {
    const loc = index.get(id)
    if (loc.story !== 'body') break
    if (previewParagraph(doc, loc)) continue
    const text = flatText(loc.para)
    if (text.length < needle.length) continue
    for (const hit of collect(text, needle, options.matchCase, options.wholeWord)) {
      out.push({ para: loc.para.id, start: hit.start, end: hit.end })
    }
  }
  return out
}

/**
 * The first match whose start is at or after `pos`, or -1 when every match starts earlier.
 * `pos` must name a paragraph in `doc`.
 */
export function matchFrom(doc: Doc, matches: readonly TextMatch[], pos: Pos): number {
  const index = indexOf(doc)
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]
    if (!match) continue
    if (comparePos(index, { p: match.para, o: match.start }, pos) >= 0) return i
  }
  return -1
}

/** The last match whose start is before `pos`, or -1 when none starts earlier. */
export function matchUntil(doc: Doc, matches: readonly TextMatch[], pos: Pos): number {
  const index = indexOf(doc)
  let found = -1
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]
    if (!match) continue
    if (comparePos(index, { p: match.para, o: match.start }, pos) < 0) found = i
    else break
  }
  return found
}

/**
 * The match after `index`, with offsets shifted when it sits in the same paragraph at or after the replaced span.
 * Null when this is the only match. A replacement that contains the needle is not searched again.
 */
export function followingMatch(matches: readonly TextMatch[], index: number, replacement: string): TextMatch | null {
  const current = matches[index]
  if (!current || matches.length < 2) return null
  const next = matches[(index + 1) % matches.length]
  if (!next) return null
  const delta = replacement.length - (current.end - current.start)
  if (next.para === current.para && next.start >= current.end) {
    return { para: next.para, start: next.start + delta, end: next.end + delta }
  }
  return next
}

function collect(
  text: string,
  needle: string,
  matchCase: boolean,
  wholeWord: boolean,
): { start: number, end: number }[] {
  const hits: { start: number, end: number }[] = []
  let bounds: Set<number> | null = null
  const accept = (start: number): number => {
    const end = start + needle.length
    if (wholeWord) {
      bounds ??= wordBounds(text)
      if (!bounds.has(start) || !bounds.has(end)) return start + 1
    }
    hits.push({ start, end })
    // Advance by the match so "aa" inside "aaa" is one match, not two.
    return end
  }
  if (matchCase) {
    let from = 0
    while (from <= text.length - needle.length) {
      const at = text.indexOf(needle, from)
      if (at < 0) break
      from = accept(at)
    }
    return hits
  }
  const foldedNeedle = needle.toLocaleLowerCase()
  const foldedText = text.toLocaleLowerCase()
  // Indexing the folded string is valid only when the fold does not change UTF-16 length.
  // İ lowercases to two units; a paragraph that contains it takes the slow path so "b" stays at its real offset.
  if (foldedNeedle.length === needle.length && foldedText.length === text.length) {
    let from = 0
    while (from <= foldedText.length - needle.length) {
      const at = foldedText.indexOf(foldedNeedle, from)
      if (at < 0) break
      from = accept(at)
    }
    return hits
  }
  let from = 0
  while (from <= text.length - needle.length) {
    if (text.slice(from, from + needle.length).toLocaleLowerCase() === foldedNeedle) from = accept(from)
    else from += 1
  }
  return hits
}

function wordBounds(text: string): Set<number> {
  const bounds = new Set<number>([0, text.length])
  for (const part of words.segment(text)) {
    bounds.add(part.index)
    bounds.add(part.index + part.segment.length)
  }
  return bounds
}

function previewParagraph(doc: Doc, loc: ParaLoc): boolean {
  if (loc.story !== 'body') return false
  let blocks: readonly Block[] = doc.body
  const path = loc.path
  let i = 0
  while (i < path.length) {
    const index = path[i]
    if (index === undefined) return false
    const block = blocks[index]
    if (!block) return false
    if (block.kind === 'opaque') return true
    if (block.kind === 'p') return false
    const row = path[i + 1]
    const cell = path[i + 2]
    if (row === undefined || cell === undefined) return false
    const inner = block.rows[row]?.cells[cell]?.blocks
    if (!inner) return false
    blocks = inner
    i += 3
  }
  return false
}
