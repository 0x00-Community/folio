/** Where the editing view and one print layout put each body block. */

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
