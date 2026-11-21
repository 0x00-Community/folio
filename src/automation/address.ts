// Turn a caller's address into a position. Resolution happens before a command runs.
import { flatText, indexOf } from '../model.ts'
import type { Block, Doc, ParaLoc, Pos, Selection } from '../model.ts'
import type { Address, Place } from './types.ts'

export interface AddressError {
  readonly code: 'unknown-address' | 'out-of-range' | 'read-only-story' | 'bad-request'
  readonly message: string
  readonly para?: string
}

export type Resolved =
  | { readonly ok: true, readonly pos: Pos }
  | { readonly ok: false, readonly error: AddressError }

export type ResolvedPlace =
  | { readonly ok: true, readonly selection: Selection }
  | { readonly ok: false, readonly error: AddressError }

/** The paragraph with this id, or null when the document has no such paragraph. */
export function locateParagraph(doc: Doc, id: string): ParaLoc | null {
  const index = indexOf(doc)
  for (const paraId of index.ordered) {
    if (paraId === id) return index.get(paraId)
  }
  return null
}

/** True when the paragraph is the preview of an opaque block. Header and footer stories are a separate check. */
export function previewParagraph(doc: Doc, loc: ParaLoc): boolean {
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

/**
 * An unknown id is `unknown-address`. An offset outside `0..length` is `out-of-range`.
 * A header, a footer, or an opaque preview is `read-only-story`. `'end'` is the paragraph length.
 */
export function resolveAddress(doc: Doc, address: Address): Resolved {
  if (typeof address.offset === 'number' && !Number.isInteger(address.offset)) {
    return { ok: false, error: { code: 'bad-request', message: 'bad field "offset"' } }
  }
  const loc = locateParagraph(doc, address.para)
  if (!loc) {
    return {
      ok: false,
      error: { code: 'unknown-address', message: `unknown paragraph ${address.para}`, para: address.para },
    }
  }
  if (loc.story !== 'body' || previewParagraph(doc, loc)) {
    return {
      ok: false,
      error: {
        code: 'read-only-story',
        message: `paragraph ${address.para} is in a read-only story`,
        para: address.para,
      },
    }
  }
  const length = flatText(loc.para).length
  const offset = address.offset === 'end' ? length : address.offset
  if (offset < 0 || offset > length) {
    return {
      ok: false,
      error: {
        code: 'out-of-range',
        message: `offset ${offset} is outside 0..${length}`,
        para: address.para,
      },
    }
  }
  return { ok: true, pos: { p: loc.para.id, o: offset } }
}

/** A place is a caret when it is one address, and a text selection when it is a range. */
export function resolvePlace(doc: Doc, place: Place): ResolvedPlace {
  if ('para' in place) {
    const resolved = resolveAddress(doc, place)
    if (!resolved.ok) return resolved
    return { ok: true, selection: { kind: 'text', anchor: resolved.pos, head: resolved.pos } }
  }
  const anchor = resolveAddress(doc, place.anchor)
  if (!anchor.ok) return anchor
  const head = resolveAddress(doc, place.head)
  if (!head.ok) return head
  return { ok: true, selection: { kind: 'text', anchor: anchor.pos, head: head.pos } }
}
