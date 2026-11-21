/** Where the editing view and one print layout put each body block, and how tall each block is. */

export type HeightKind = 'paragraph' | 'table' | 'opaque'

export type HeightRow = {
  readonly index: number
  readonly kind: HeightKind
  readonly editPt: number | null
  readonly printPt: number | null
  /** `printPt - editPt`. Null when either side was not measured. */
  readonly delta: number | null
}

export type HeightDrift = {
  readonly blocks: readonly HeightRow[]
  readonly byKind: readonly { readonly kind: HeightKind; readonly delta: number }[]
  /** Up to twenty blocks, largest absolute delta first. Equal magnitudes keep the lower index. */
  readonly largest: readonly HeightRow[]
}

const HEIGHT_KINDS: readonly HeightKind[] = ['paragraph', 'table', 'opaque']

/** The height report's name for a model block kind. */
export function heightKind(kind: 'p' | 'table' | 'opaque'): HeightKind {
  if (kind === 'p') return 'paragraph'
  if (kind === 'table') return 'table'
  return 'opaque'
}

/**
 * Compare one height list from the editing view with one from a print layout.
 * Lists are parallel in body order. A missing side, or a height that is not a
 * finite number, is null and drops out of `byKind` and `largest`.
 */
export function heightDrift(
  edit: readonly { readonly kind: HeightKind; readonly heightPt: number | null }[],
  print: readonly { readonly heightPt: number | null }[],
): HeightDrift {
  const count = Math.max(edit.length, print.length)
  const blocks: HeightRow[] = []
  const sums = new Map<HeightKind, number>(HEIGHT_KINDS.map((kind) => [kind, 0]))
  for (let index = 0; index < count; index++) {
    const editRow = edit[index]
    const printRow = print[index]
    const kind = knownKind(editRow?.kind)
    const editPt = finiteOrNull(editRow?.heightPt)
    const printPt = finiteOrNull(printRow?.heightPt)
    const delta = editPt === null || printPt === null ? null : printPt - editPt
    if (delta !== null) sums.set(kind, (sums.get(kind) ?? 0) + delta)
    blocks.push({ index, kind, editPt, printPt, delta })
  }
  const largest = blocks.filter((row) => row.delta !== null)
  largest.sort(
    (left, right) => Math.abs(right.delta ?? 0) - Math.abs(left.delta ?? 0) || left.index - right.index,
  )
  return {
    blocks,
    byKind: HEIGHT_KINDS.map((kind) => ({ kind, delta: sums.get(kind) ?? 0 })),
    largest: largest.slice(0, 20),
  }
}

function knownKind(kind: HeightKind | undefined): HeightKind {
  if (kind === 'paragraph' || kind === 'table' || kind === 'opaque') return kind
  return 'opaque'
}

function finiteOrNull(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

export type DriftPage = {
  readonly page: number
  readonly blocks: number
  readonly same: number
}

export type DriftReport = {
  readonly blocks: number
  readonly samePage: number
  readonly share: number
  readonly firstDiff: number | null
  readonly editPages: number
  readonly printPages: number
  readonly byPage: readonly DriftPage[]
}

/**
 * Compare 0-based first pages. A block with `null` on either side differs.
 * `editPages` and `printPages` are one past the highest first page on that
 * side, or 0 when that side places nothing. `byPage` groups by the print
 * side's first page and leaves out a block the print layout did not place.
 */
export function drift(
  edit: readonly (number | null)[],
  print: readonly { readonly firstPage: number | null }[],
): DriftReport {
  const blocks = Math.max(edit.length, print.length)
  let samePage = 0
  let firstDiff: number | null = null
  let editMax = -1
  let printMax = -1
  const groups = new Map<number, { blocks: number; same: number }>()
  for (let index = 0; index < blocks; index++) {
    const editPage = edit[index] ?? null
    const printPage = print[index]?.firstPage ?? null
    if (editPage !== null && editPage > editMax) editMax = editPage
    if (printPage !== null && printPage > printMax) printMax = printPage
    const same = editPage !== null && printPage !== null && editPage === printPage
    if (same) samePage += 1
    else if (firstDiff === null) firstDiff = index
    if (printPage === null) continue
    const group = groups.get(printPage) ?? { blocks: 0, same: 0 }
    group.blocks += 1
    if (same) group.same += 1
    groups.set(printPage, group)
  }
  const byPage = [...groups.keys()]
    .sort((left, right) => left - right)
    .map((page) => {
      const group = groups.get(page)
      return { page, blocks: group?.blocks ?? 0, same: group?.same ?? 0 }
    })
  return {
    blocks,
    samePage,
    share: blocks === 0 ? 1 : samePage / blocks,
    firstDiff,
    editPages: editMax < 0 ? 0 : editMax + 1,
    printPages: printMax < 0 ? 0 : printMax + 1,
    byPage,
  }
}
