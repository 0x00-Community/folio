// `word.call`: validate a request, then read or run one editor command. It does not throw or reject.
import {
  changeIndentLevel,
  deleteBackward,
  deleteColumns,
  deleteEnclosingTable,
  deleteForward,
  deleteRows,
  deleteSelection,
  deleteTable,
  insertColumn,
  imageMoveIssue,
  imageResizeIssue,
  insertImage,
  insertLineBreak,
  insertPageBreak,
  insertRow,
  insertTable,
  insertText,
  moveAtom,
  resizeImage,
  selectAll,
  setAlign,
  setIndent,
  setLineSpacing,
  setSpacing,
  setMark,
  setPageSetup,
  setParaStyle,
  setSelection,
  splitParagraph,
  toggleList,
  toggleMark,
} from '../editor/edit.ts'
import type { Command, EditorState, MarkValue } from '../editor/edit.ts'
import { flatText, indexOf } from '../model.ts'
import type {
  Block,
  Doc,
  Hex,
  HighlightName,
  PageSetup,
  Paragraph,
  ParaLoc,
  Pos,
  Pt,
  Row,
  Selection,
  StyleId,
  Table,
} from '../model.ts'
import { locateParagraph, previewParagraph, resolveAddress, resolvePlace } from './address.ts'
import type { AddressError } from './address.ts'
import type { Host } from './host.ts'
import {
  documentSummary,
  readBlocks,
  readFind,
  readOutline,
  readText,
  readTextByIds,
} from './read.ts'
import type {
  Address,
  EditOk,
  Place,
  Refusal,
  Response,
  SelectionView,
} from './types.ts'

const TEXT_LIMIT = 1_000_000
const IMAGE_MAX = 16 * 1024 * 1024
const TABLE_ROWS = 500
const TABLE_COLS = 63
const FIND_DEFAULT = 100
const FIND_MAX = 1000
const ID_MAX = 500
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg'])

// Own keys only. A plain object would treat `constructor` and other prototype names as real ops.
export const KEYS: ReadonlyMap<string, readonly string[]> = new Map([
  ['info', ['op', 'v']],
  ['selection', ['op', 'v']],
  ['blocks', ['op', 'v', 'from', 'count']],
  ['outline', ['op', 'v']],
  ['find', ['op', 'v', 'text', 'from', 'limit', 'matchCase']],
  ['hitTest', ['op', 'v', 'clientX', 'clientY']],
  ['select', ['op', 'v', 'at']],
  ['selectCells', ['op', 'v', 'at', 'table', 'anchor', 'head']],
  ['selectAll', ['op', 'v', 'at']],
  ['insertText', ['op', 'v', 'at', 'text']],
  ['enter', ['op', 'v', 'at']],
  ['lineBreak', ['op', 'v', 'at']],
  ['pageBreak', ['op', 'v', 'at']],
  ['delete', ['op', 'v', 'at', 'direction', 'unit']],
  ['toggleMark', ['op', 'v', 'at', 'mark']],
  ['setMark', ['op', 'v', 'at', 'mark', 'value']],
  ['setStyle', ['op', 'v', 'at', 'style']],
  ['setAlign', ['op', 'v', 'at', 'align']],
  ['setIndent', ['op', 'v', 'at', 'left', 'right', 'firstLine', 'hanging']],
  ['setLineSpacing', ['op', 'v', 'at', 'rule', 'value']],
  ['setParaSpacing', ['op', 'v', 'at', 'before', 'after']],
  ['indentLevel', ['op', 'v', 'at', 'delta']],
  ['toggleList', ['op', 'v', 'at', 'list']],
  ['insertTable', ['op', 'v', 'at', 'rows', 'cols']],
  ['insertRow', ['op', 'v', 'at', 'where']],
  ['deleteRows', ['op', 'v', 'at']],
  ['insertColumn', ['op', 'v', 'at', 'where']],
  ['deleteColumns', ['op', 'v', 'at']],
  ['deleteTable', ['op', 'v', 'at', 'table']],
  ['insertImage', ['op', 'v', 'at', 'base64', 'contentType']],
  ['resizeImage', ['op', 'v', 'at', 'widthPt', 'heightPt']],
  ['moveImage', ['op', 'v', 'at', 'to']],
  ['setPageSetup', ['op', 'v', 'at', 'section', 'page']],
  ['undo', ['op', 'v', 'at']],
  ['redo', ['op', 'v', 'at']],
])

/** A valid edit that has not run. `dispatch` checks the host is idle, then calls `run`. */
interface Deferred {
  readonly deferred: true
  readonly run: () => Response | Promise<Response>
}

function defer(run: () => Response | Promise<Response>): Deferred {
  return { deferred: true, run }
}

function isDeferred(step: Response | Deferred): step is Deferred {
  return 'deferred' in step && step.deferred === true
}

export interface Word {
  readonly version: 1
  call(request: unknown): Promise<Response>
}

/** A page object. `version` is 1. `call` answers every request with JSON and never rejects. */
export function createInterface(host: Host): Word {
  let rev = 0
  let seenSession = host.file().session
  let seenDoc = host.state().doc

  const note = (): number => {
    const doc = host.state().doc
    const session = host.file().session
    if (session !== seenSession) {
      seenSession = session
      seenDoc = doc
      rev = 0
      return rev
    }
    if (doc !== seenDoc) {
      seenDoc = doc
      rev += 1
    }
    return rev
  }

  host.watch(note)

  return {
    version: 1,
    async call(request: unknown): Promise<Response> {
      try {
        note()
        return await dispatch(host, () => rev, note, request)
      } catch (error: unknown) {
        console.error(error)
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, error: { code: 'refused', message } }
      }
    },
  }
}

async function dispatch(host: Host, rev: () => number, note: () => number, request: unknown): Promise<Response> {
  if (!isRecord(request)) return bad('request')
  if ('v' in request && request.v !== 1) return unsupported()
  const op = request.op
  if (typeof op !== 'string' || op.length === 0) return bad('op')
  const allowed = op === 'text'
    ? ('ids' in request ? ['op', 'v', 'ids'] : ['op', 'v', 'from', 'count'])
    : KEYS.get(op)
  if (!allowed) return unknownOp(op)
  const extra = unknownKey(request, allowed)
  if (extra) return bad(extra)
  const step = route(host, rev, note, op, request)
  if (!isDeferred(step)) return step
  // Fields are valid. Every edit waits here, before an address is resolved or the host changes.
  const idle = ensureIdle(host)
  if (idle) return idle
  return step.run()
}

function route(
  host: Host,
  rev: () => number,
  note: () => number,
  op: string,
  request: Record<string, unknown>,
): Response | Deferred {
  switch (op) {
    case 'info':
      return readInfo(host, rev())
    case 'selection':
      return { ok: true, rev: rev(), selection: selectionView(host.state().sel) }
    case 'blocks':
      return readBlocksOp(host, rev(), request)
    case 'text':
      return readTextOp(host, rev(), request)
    case 'outline':
      return readOutlineOp(host, rev())
    case 'find':
      return readFindOp(host, rev(), request)
    case 'hitTest':
      return readHit(host, rev(), request)
    case 'select':
      return selectOp(host, note, request)
    case 'selectCells':
      return selectCellsOp(host, note, request)
    case 'selectAll':
      return selectAllOp(host, note, request)
    case 'insertText':
      return insertTextOp(host, note, request)
    case 'enter':
      return plainEdit(host, note, request, 'enter', splitParagraph, true)
    case 'lineBreak':
      return plainEdit(host, note, request, 'lineBreak', insertLineBreak, true)
    case 'pageBreak':
      return plainEdit(host, note, request, 'pageBreak', insertPageBreak, true)
    case 'delete':
      return deleteOp(host, note, request)
    case 'toggleMark':
      return toggleMarkOp(host, note, request)
    case 'setMark':
      return setMarkOp(host, note, request)
    case 'setStyle':
      return setStyleOp(host, note, request)
    case 'setAlign':
      return setAlignOp(host, note, request)
    case 'setIndent':
      return setIndentOp(host, note, request)
    case 'setLineSpacing':
      return setLineSpacingOp(host, note, request)
    case 'setParaSpacing':
      return setParaSpacingOp(host, note, request)
    case 'indentLevel':
      return indentOp(host, note, request)
    case 'toggleList':
      return toggleListOp(host, note, request)
    case 'insertTable':
      return insertTableOp(host, note, request)
    case 'insertRow':
      return rowOp(host, note, request, 'insertRow')
    case 'deleteRows':
      return deleteRowsOp(host, note, request)
    case 'insertColumn':
      return columnOp(host, note, request, 'insertColumn')
    case 'deleteColumns':
      return deleteColumnsOp(host, note, request)
    case 'deleteTable':
      return deleteTableOp(host, note, request)
    case 'insertImage':
      return insertImageOp(host, note, request)
    case 'resizeImage':
      return resizeImageOp(host, note, request)
    case 'moveImage':
      return moveImageOp(host, note, request)
    case 'setPageSetup':
      return setPageSetupOp(host, note, request)
    case 'undo':
      return historyOp(host, note, request, 'undo')
    case 'redo':
      return historyOp(host, note, request, 'redo')
    default:
      return unknownOp(op)
  }
}

function readInfo(host: Host, rev: number): Response {
  const file = host.file()
  const status = host.status()
  const summary = documentSummary(host.state().doc)
  return {
    ok: true,
    rev,
    name: file.name,
    dirty: file.dirty,
    pages: status.pages,
    pagesFinal: status.pagesFinal,
    words: summary.words,
    blocks: summary.blocks,
    sections: summary.sections.map((section) => ({ ...section, page: { ...section.page, margin: { ...section.page.margin } } })),
    styles: summary.styles.map((style) => ({ ...style })),
  }
}

function readBlocksOp(host: Host, rev: number, record: Record<string, unknown>): Response {
  const from = optionalInt(record, 'from', 0)
  if (isRefusal(from)) return from
  const count = optionalInt(record, 'count', 1)
  if (isRefusal(count)) return count
  const page = readBlocks(host.state().doc, (id) => host.pageOf(id), from ?? 0, count)
  return { ok: true, rev, total: page.total, from: page.from, next: page.next, blocks: [...page.blocks] }
}

function readTextOp(host: Host, rev: number, record: Record<string, unknown>): Response {
  const doc = host.state().doc
  const markers = host.markers()
  if ('ids' in record) {
    if (!Array.isArray(record.ids) || record.ids.length > ID_MAX) return bad('ids')
    const ids: string[] = []
    for (const id of record.ids) {
      if (typeof id !== 'string' || id.length === 0) return bad('ids')
      ids.push(id)
    }
    const text = readTextByIds(doc, markers, ids)
    if (!text.ok) return unknownId(text.missing)
    return { ok: true, rev, total: text.blocks.length, from: 0, next: null, blocks: [...text.blocks] }
  }
  const from = optionalInt(record, 'from', 0)
  if (isRefusal(from)) return from
  const count = optionalInt(record, 'count', 1)
  if (isRefusal(count)) return count
  const page = readText(doc, markers, from ?? 0, count)
  return { ok: true, rev, total: page.total, from: page.from, next: page.next, blocks: [...page.blocks] }
}

function readOutlineOp(host: Host, rev: number): Response {
  const outline = readOutline(host.state().doc, host.markers(), (id) => host.pageOf(id))
  return { ok: true, rev, headings: [...outline.headings], truncated: outline.truncated }
}

function readFindOp(host: Host, rev: number, record: Record<string, unknown>): Response {
  const text = requiredString(record, 'text')
  if (isRefusal(text)) return text
  if (text.length === 0 || text.length > TEXT_LIMIT) return bad('text')
  let matchCase = false
  if ('matchCase' in record) {
    if (typeof record.matchCase !== 'boolean') return bad('matchCase')
    matchCase = record.matchCase
  }
  const limitRaw = optionalInt(record, 'limit', 1)
  if (isRefusal(limitRaw)) return limitRaw
  let from: Pos | null = null
  if ('from' in record) {
    const address = parseAddress(record.from, 'from')
    if (isRefusal(address)) return address
    const resolved = resolveAddress(host.state().doc, address)
    if (!resolved.ok) return fromAddress(resolved.error)
    from = resolved.pos
  }
  const found = readFind(host.state().doc, text, from, Math.min(limitRaw ?? FIND_DEFAULT, FIND_MAX), matchCase)
  return { ok: true, rev, matches: [...found.matches], truncated: found.truncated }
}

function readHit(host: Host, rev: number, record: Record<string, unknown>): Response {
  const clientX = finite(record.clientX, 'clientX')
  if (isRefusal(clientX)) return clientX
  const clientY = finite(record.clientY, 'clientY')
  if (isRefusal(clientY)) return clientY
  const pos = host.hitTest(clientX, clientY)
  if (!pos) return { ok: true, rev, at: null }
  const loc = locateParagraph(host.state().doc, pos.p)
  if (!loc) return { ok: true, rev, at: null }
  return { ok: true, rev, at: { para: loc.para.id, offset: pos.o } }
}

function selectOp(host: Host, note: () => number, record: Record<string, unknown>): Response | Deferred {
  if (!('at' in record)) return bad('at')
  const place = parsePlace(record.at, 'at')
  if (isRefusal(place)) return place
  return defer(() => {
    const resolved = resolvePlace(host.state().doc, place)
    if (!resolved.ok) return fromAddress(resolved.error)
    return applySelection(host, note, 'select', resolved.selection)
  })
}

function selectCellsOp(host: Host, note: () => number, record: Record<string, unknown>): Response | Deferred {
  const place = optionalPlace(record)
  if (isRefusal(place)) return place
  const id = requiredString(record, 'table')
  if (isRefusal(id)) return id
  const anchor = parseCorner(record.anchor, 'anchor')
  if (isRefusal(anchor)) return anchor
  const head = parseCorner(record.head, 'head')
  if (isRefusal(head)) return head
  return defer(() => {
    if (place) {
      const resolved = resolvePlace(host.state().doc, place)
      if (!resolved.ok) return fromAddress(resolved.error)
    }
    const table = findTable(host.state().doc.body, id)
    if (!table) return unknownId(id)
    if (!cellFits(table, anchor.row, anchor.cell) || !cellFits(table, head.row, head.cell)) {
      return { ok: false, error: { code: 'out-of-range', message: 'cell is outside the table', para: table.id } }
    }
    const selection: Selection = { kind: 'cells', table: table.id, anchor, head }
    return applySelection(host, note, 'selectCells', selection)
  })
}

function selectAllOp(host: Host, note: () => number, record: Record<string, unknown>): Response | Deferred {
  const place = optionalPlace(record)
  if (isRefusal(place)) return place
  return defer(() => {
    const guarded = guard(host, place, false)
    if (!guarded.ok) return guarded.refusal
    const ids = blockIds(host.state().doc)
    if (guarded.moved) host.run(setSelection(guarded.selection))
    const ran = host.run(selectAll)
    if (!ran) {
      if (!hasMovable(host.state().doc)) {
        if (guarded.moved) host.run(setSelection(guarded.before))
        return refused('selectAll')
      }
    }
    return edited(host, note, ids)
  })
}

function insertTextOp(host: Host, note: () => number, record: Record<string, unknown>): Response | Deferred {
  const text = requiredString(record, 'text')
  if (isRefusal(text)) return text
  if (text.length > TEXT_LIMIT) return bad('text')
  return plainEdit(host, note, record, 'insertText', insertText(text), true)
}

function deleteOp(host: Host, note: () => number, record: Record<string, unknown>): Response | Deferred {
  const place = optionalPlace(record)
  if (isRefusal(place)) return place
  const direction = record.direction
  const unit = record.unit
  if (!('direction' in record)) {
    if ('unit' in record) return bad('unit')
    return defer(() => runEdit(host, note, 'delete', place, deleteSelection, true, null))
  }
  if (direction !== 'backward' && direction !== 'forward') return bad('direction')
  if ('unit' in record && unit !== 'char' && unit !== 'word') return bad('unit')
  const step = unit === 'word' ? 'word' : 'char'
  const command = direction === 'backward' ? deleteBackward(step) : deleteForward(step)
  return defer(() => runEdit(host, note, 'delete', place, command, true, direction))
}

function toggleMarkOp(host: Host, note: () => number, record: Record<string, unknown>): Response | Deferred {
  const mark = record.mark
  if (mark !== 'bold' && mark !== 'italic' && mark !== 'underline' && mark !== 'strike') return bad('mark')
  return plainEdit(host, note, record, 'toggleMark', toggleMark(mark), true)
}

function setMarkOp(host: Host, note: () => number, record: Record<string, unknown>): Response | Deferred {
  if (typeof record.mark !== 'string') return bad('mark')
  const change = markChange(record.mark, 'value' in record ? record.value : undefined)
  if (isRefusal(change)) return change
  return plainEdit(host, note, record, 'setMark', setMark(change), true)
}

function setStyleOp(host: Host, note: () => number, record: Record<string, unknown>): Response | Deferred {
  const id = requiredString(record, 'style')
  if (isRefusal(id)) return id
  const style = styleRef(host.state().doc, id)
  if (!style) return bad('style')
  return plainEdit(host, note, record, 'setStyle', setParaStyle(style), true)
}

function setAlignOp(host: Host, note: () => number, record: Record<string, unknown>): Response | Deferred {
  const align = record.align
  if (align !== 'left' && align !== 'center' && align !== 'right' && align !== 'justify' && align !== 'distribute') {
    return bad('align')
  }
  return plainEdit(host, note, record, 'setAlign', setAlign(align), true)
}

function setIndentOp(host: Host, note: () => number, record: Record<string, unknown>): Response | Deferred {
  const left = optionalPoint(record, 'left')
  if (isRefusal(left)) return left
  const right = optionalPoint(record, 'right')
  if (isRefusal(right)) return right
  const firstLine = optionalPoint(record, 'firstLine')
  if (isRefusal(firstLine)) return firstLine
  const hanging = optionalPoint(record, 'hanging')
  if (isRefusal(hanging)) return hanging
  if (left === undefined && right === undefined && firstLine === undefined && hanging === undefined) return bad('left')
  const indent: { left?: Pt, right?: Pt, firstLine?: Pt, hanging?: Pt } = {}
  if (left !== undefined) indent.left = points(left)
  if (right !== undefined) indent.right = points(right)
  if (firstLine !== undefined) indent.firstLine = points(firstLine)
  if (hanging !== undefined) indent.hanging = points(hanging)
  return plainEdit(host, note, record, 'setIndent', setIndent(indent), true)
}

function setParaSpacingOp(host: Host, note: () => number, record: Record<string, unknown>): Response | Deferred {
  const before = optionalPoint(record, 'before')
  if (isRefusal(before)) return before
  const after = optionalPoint(record, 'after')
  if (isRefusal(after)) return after
  if (before === undefined && after === undefined) return bad('before')
  const spacing: { before?: Pt, after?: Pt } = {}
  if (before !== undefined) spacing.before = points(before)
  if (after !== undefined) spacing.after = points(after)
  return plainEdit(host, note, record, 'setParaSpacing', setSpacing(spacing), true)
}

function setLineSpacingOp(host: Host, note: () => number, record: Record<string, unknown>): Response | Deferred {
  const rule = record.rule
  if (rule !== 'auto' && rule !== 'exact' && rule !== 'atLeast') return bad('rule')
  const value = finite(record.value, 'value')
  if (isRefusal(value)) return value
  if (value < 0) return bad('value')
  const command = rule === 'auto'
    ? setLineSpacing({ rule: 'auto', multiple: value })
    : rule === 'exact'
      ? setLineSpacing({ rule: 'exact', pt: points(value) })
      : setLineSpacing({ rule: 'atLeast', pt: points(value) })
  return plainEdit(host, note, record, 'setLineSpacing', command, true)
}

function indentOp(host: Host, note: () => number, record: Record<string, unknown>): Response | Deferred {
  if (record.delta !== 1 && record.delta !== -1) return bad('delta')
  return plainEdit(host, note, record, 'indentLevel', changeIndentLevel(record.delta), true)
}

function toggleListOp(host: Host, note: () => number, record: Record<string, unknown>): Response | Deferred {
  if (record.list !== 'bullet' && record.list !== 'decimal') return bad('list')
  return plainEdit(host, note, record, 'toggleList', toggleList(record.list), true)
}

function insertTableOp(host: Host, note: () => number, record: Record<string, unknown>): Response | Deferred {
  const rows = requiredInt(record, 'rows', 1)
  if (isRefusal(rows)) return rows
  const cols = requiredInt(record, 'cols', 1)
  if (isRefusal(cols)) return cols
  if (rows > TABLE_ROWS) return bad('rows')
  if (cols > TABLE_COLS) return bad('cols')
  return plainEdit(host, note, record, 'insertTable', insertTable(rows, cols), true)
}

function rowOp(host: Host, note: () => number, record: Record<string, unknown>, op: 'insertRow'): Response | Deferred {
  const where = record.where
  if (where !== 'above' && where !== 'below') return bad('where')
  return plainEdit(host, note, record, op, insertRow(where), true)
}

function deleteRowsOp(host: Host, note: () => number, record: Record<string, unknown>): Response | Deferred {
  const place = optionalPlace(record)
  if (isRefusal(place)) return place
  return defer(() => {
    const guarded = guard(host, place, true)
    if (!guarded.ok) return guarded.refusal
    const hit = tableHit(host.state().doc, guarded.selection)
    if (hit) {
      const locked = firstLockedParagraph(paragraphsInRows(hit.table, hit.r0, hit.r1))
      if (locked) return lockedRefusal(locked)
    }
    return commit(host, note, 'deleteRows', guarded, deleteRows())
  })
}

function columnOp(host: Host, note: () => number, record: Record<string, unknown>, op: 'insertColumn'): Response | Deferred {
  const where = record.where
  if (where !== 'left' && where !== 'right') return bad('where')
  return plainEdit(host, note, record, op, insertColumn(where), true)
}

function deleteColumnsOp(host: Host, note: () => number, record: Record<string, unknown>): Response | Deferred {
  const place = optionalPlace(record)
  if (isRefusal(place)) return place
  return defer(() => {
    const guarded = guard(host, place, true)
    if (!guarded.ok) return guarded.refusal
    const span = columnSpan(host.state().doc, guarded.selection)
    if (span) {
      const locked = firstLockedParagraph(paragraphsInColumns(span.table, span.start, span.end))
      if (locked) return lockedRefusal(locked)
    }
    return commit(host, note, 'deleteColumns', guarded, deleteColumns())
  })
}

function deleteTableOp(host: Host, note: () => number, record: Record<string, unknown>): Response | Deferred {
  const place = optionalPlace(record)
  if (isRefusal(place)) return place
  if ('table' in record) {
    if (typeof record.table !== 'string' || record.table.length === 0) return bad('table')
    const id = record.table
    return defer(() => {
      if (place) {
        const resolved = resolvePlace(host.state().doc, place)
        if (!resolved.ok) return fromAddress(resolved.error)
      }
      const table = findTable(host.state().doc.body, id)
      if (!table) return unknownId(id)
      const locked = firstLockedParagraph(paragraphsInTable(table))
      if (locked) return lockedRefusal(locked)
      const guarded = guard(host, place, false)
      if (!guarded.ok) return guarded.refusal
      return commit(host, note, 'deleteTable', guarded, deleteTable(table.id))
    })
  }
  return defer(() => {
    const guarded = guard(host, place, true)
    if (!guarded.ok) return guarded.refusal
    const hit = tableHit(host.state().doc, guarded.selection)
    if (hit) {
      const locked = firstLockedParagraph(paragraphsInTable(hit.table))
      if (locked) return lockedRefusal(locked)
    }
    return commit(host, note, 'deleteTable', guarded, deleteEnclosingTable())
  })
}

function insertImageOp(host: Host, note: () => number, record: Record<string, unknown>): Response | Deferred {
  const contentType = requiredString(record, 'contentType')
  if (isRefusal(contentType)) return contentType
  if (!IMAGE_TYPES.has(contentType)) return bad('contentType')
  const base64 = requiredString(record, 'base64')
  if (isRefusal(base64)) return base64
  const bytes = decodeBase64(base64)
  if (isRefusal(bytes)) return bytes
  const place = optionalPlace(record)
  if (isRefusal(place)) return place
  return defer(async () => {
    const guarded = guard(host, place, true)
    if (!guarded.ok) return guarded.refusal
    const media = await host.addMedia(blobFrom(bytes, contentType))
    // The bytes are stored. The host can become busy before the image is inserted.
    const still = ensureIdle(host)
    if (still) return still
    const again = guard(host, place, true)
    if (!again.ok) return again.refusal
    return commit(host, note, 'insertImage', again, insertImage(media))
  })
}

function resizeImageOp(host: Host, note: () => number, record: Record<string, unknown>): Response | Deferred {
  if (!('at' in record)) return bad('at')
  const at = parseAddress(record.at, 'at')
  if (isRefusal(at)) return at
  const width = finite(record.widthPt, 'widthPt')
  if (isRefusal(width)) return width
  const height = finite(record.heightPt, 'heightPt')
  if (isRefusal(height)) return height
  return defer(() => {
    const guarded = guard(host, at, true)
    if (!guarded.ok) return guarded.refusal
    if (guarded.selection.kind !== 'text') return bad('at')
    const pos = guarded.selection.anchor
    const issue = imageResizeIssue(guarded.preview.doc, pos, width, height)
    if (issue === 'missing') {
      return { ok: false, error: { code: 'out-of-range', message: `no picture at offset ${pos.o}`, para: pos.p } }
    }
    if (issue === 'range') {
      return { ok: false, error: { code: 'out-of-range', message: `picture size ${width} by ${height} is outside the limits`, para: pos.p } }
    }
    return commit(host, note, 'resizeImage', guarded, resizeImage(pos, width, height))
  })
}

function moveImageOp(host: Host, note: () => number, record: Record<string, unknown>): Response | Deferred {
  if (!('at' in record)) return bad('at')
  if (!('to' in record)) return bad('to')
  const at = parseAddress(record.at, 'at')
  if (isRefusal(at)) return at
  const to = parseAddress(record.to, 'to')
  if (isRefusal(to)) return to
  return defer(() => {
    const guarded = guard(host, at, true)
    if (!guarded.ok) return guarded.refusal
    if (guarded.selection.kind !== 'text') return bad('at')
    const from = guarded.selection.anchor
    const dest = resolveAddress(guarded.preview.doc, to)
    if (!dest.ok) return fromAddress(dest.error)
    const issue = imageMoveIssue(guarded.preview.doc, from, dest.pos)
    if (issue === 'missing') {
      return { ok: false, error: { code: 'out-of-range', message: `no picture at offset ${from.o}`, para: from.p } }
    }
    if (issue === 'file') return refused('moveImage')
    if (issue === 'locked') return lockedRefusal(dest.pos.p)
    if (issue === 'preview' || issue === 'story') {
      return { ok: false, error: { code: 'read-only-story', message: `paragraph ${dest.pos.p} is in a read-only story`, para: dest.pos.p } }
    }
    if (issue === 'same') {
      return applySelection(host, note, 'moveImage', {
        kind: 'text',
        anchor: from,
        head: { p: from.p, o: from.o + 1 },
      })
    }
    return commit(host, note, 'moveImage', guarded, moveAtom(from, dest.pos))
  })
}

function setPageSetupOp(host: Host, note: () => number, record: Record<string, unknown>): Response | Deferred {
  const section = requiredInt(record, 'section', 0)
  if (isRefusal(section)) return section
  if (section >= host.state().doc.sections.length) return bad('section')
  const page = parsePage(record.page)
  if (isRefusal(page)) return page
  return plainEdit(host, note, record, 'setPageSetup', setPageSetup(section, page), false)
}

function historyOp(host: Host, note: () => number, record: Record<string, unknown>, op: 'undo' | 'redo'): Response | Deferred {
  const place = optionalPlace(record)
  if (isRefusal(place)) return place
  // Undo and redo restore their own selection, so `at` is checked and then does not stick.
  return defer(() => {
    if (place) {
      const resolved = resolvePlace(host.state().doc, place)
      if (!resolved.ok) return fromAddress(resolved.error)
    }
    const ids = blockIds(host.state().doc)
    const ran = op === 'undo' ? host.undo() : host.redo()
    if (!ran) return refused(op)
    return edited(host, note, ids)
  })
}

function plainEdit(
  host: Host,
  note: () => number,
  record: Record<string, unknown>,
  op: string,
  command: Command,
  locks: boolean,
): Response | Deferred {
  const place = optionalPlace(record)
  if (isRefusal(place)) return place
  return defer(() => runEdit(host, note, op, place, command, locks, null))
}

function runEdit(
  host: Host,
  note: () => number,
  op: string,
  place: Place | undefined,
  command: Command,
  locks: boolean,
  boundary: 'backward' | 'forward' | null,
): Response {
  const guarded = guard(host, place, locks)
  if (!guarded.ok) return guarded.refusal
  if (boundary) {
    const neighbor = boundaryLock(host.state().doc, guarded.selection, boundary)
    if (neighbor) return lockedRefusal(neighbor)
  }
  return commit(host, note, op, guarded, command)
}

interface Guarded {
  readonly ok: true
  readonly before: Selection
  readonly selection: Selection
  readonly moved: boolean
  readonly preview: EditorState
}

function guard(host: Host, place: Place | undefined, locks: boolean): Guarded | { ok: false, refusal: Refusal } {
  const state = host.state()
  let selection = state.sel
  let preview = state
  let moved = false
  if (place) {
    const resolved = resolvePlace(state.doc, place)
    if (!resolved.ok) return { ok: false, refusal: fromAddress(resolved.error) }
    selection = resolved.selection
    const tr = setSelection(selection)(state)
    if (tr) {
      moved = true
      preview = { doc: tr.doc, sel: tr.sel, stored: tr.stored, history: state.history }
    }
  }
  // Page setup and deleting a table by id do not edit the caret, so a preview selection does not block them.
  if (place || locks) {
    const readOnly = readOnlyId(state.doc, selection)
    if (readOnly) {
      return { ok: false, refusal: { ok: false, error: { code: 'read-only-story', message: `paragraph ${readOnly} is in a read-only story`, para: readOnly } } }
    }
  }
  if (locks) {
    const locked = firstLockedParagraph(selectedParagraphs(state.doc, selection))
    if (locked) return { ok: false, refusal: lockedRefusal(locked) }
  }
  return { ok: true, before: state.sel, selection, moved, preview }
}

function commit(host: Host, note: () => number, op: string, guarded: Guarded, command: Command): Response {
  const ids = blockIds(host.state().doc)
  const tr = command(guarded.preview)
  if (!tr) return refused(op)
  if (guarded.moved) host.run(setSelection(guarded.selection))
  const ran = host.run(command)
  if (!ran) {
    if (guarded.moved) host.run(setSelection(guarded.before))
    return refused(op)
  }
  return edited(host, note, ids)
}

function applySelection(host: Host, note: () => number, op: string, selection: Selection): Response {
  const ids = blockIds(host.state().doc)
  const ran = host.run(setSelection(selection))
  if (!ran && !sameSelection(host.state().sel, selection)) return refused(op)
  return edited(host, note, ids)
}

function edited(host: Host, note: () => number, before: readonly string[]): EditOk {
  const rev = note()
  const state = host.state()
  const after = blockIds(state.doc)
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  return {
    ok: true,
    rev,
    selection: selectionView(state.sel),
    created: after.filter((id) => !beforeSet.has(id)),
    removed: before.filter((id) => !afterSet.has(id)),
  }
}

function selectionView(sel: Selection): SelectionView {
  if (sel.kind === 'text') {
    return {
      kind: 'text',
      anchor: { para: sel.anchor.p, offset: sel.anchor.o },
      head: { para: sel.head.p, offset: sel.head.o },
    }
  }
  return {
    kind: 'cells',
    table: sel.table,
    anchor: { row: sel.anchor.row, cell: sel.anchor.cell },
    head: { row: sel.head.row, cell: sel.head.cell },
  }
}

function sameSelection(a: Selection, b: Selection): boolean {
  if (a.kind === 'text' && b.kind === 'text') {
    return a.anchor.p === b.anchor.p && a.anchor.o === b.anchor.o && a.head.p === b.head.p && a.head.o === b.head.o
  }
  if (a.kind === 'cells' && b.kind === 'cells') {
    return a.table === b.table
      && a.anchor.row === b.anchor.row && a.anchor.cell === b.anchor.cell
      && a.head.row === b.head.row && a.head.cell === b.head.cell
  }
  return false
}

/** Paragraph, table, and opaque ids in document order, cells and stories included. */
function blockIds(doc: Doc): string[] {
  const out: string[] = []
  const walk = (blocks: readonly Block[]): void => {
    for (const block of blocks) {
      out.push(block.id)
      if (block.kind === 'table') {
        for (const row of block.rows) {
          for (const cell of row.cells) walk(cell.blocks)
        }
      } else if (block.kind === 'opaque') {
        for (const para of block.preview) out.push(para.id)
      }
    }
  }
  walk(doc.body)
  for (const blocks of doc.stories.values()) walk(blocks)
  return out
}

function selectedParagraphs(doc: Doc, sel: Selection): Paragraph[] {
  if (sel.kind === 'cells') {
    const table = findTable(doc.body, sel.table)
    if (!table) return []
    const r0 = Math.min(sel.anchor.row, sel.head.row)
    const r1 = Math.max(sel.anchor.row, sel.head.row)
    const c0 = Math.min(sel.anchor.cell, sel.head.cell)
    const c1 = Math.max(sel.anchor.cell, sel.head.cell)
    const out: Paragraph[] = []
    for (let r = r0; r <= r1; r++) {
      const row = table.rows[r]
      if (!row) continue
      for (let c = c0; c <= c1; c++) {
        const cell = row.cells[c]
        if (cell) collectParagraphs(cell.blocks, out)
      }
    }
    return out
  }
  const index = indexOf(doc)
  const anchor = locateParagraph(doc, sel.anchor.p)
  const head = locateParagraph(doc, sel.head.p)
  if (!anchor || !head || anchor.story !== 'body' || head.story !== 'body') return []
  const anchorFirst = anchor.order < head.order || (anchor.order === head.order && sel.anchor.o <= sel.head.o)
  const from = anchorFirst ? anchor : head
  const to = anchorFirst ? head : anchor
  const toOffset = anchorFirst ? sel.head.o : sel.anchor.o
  const out: Paragraph[] = []
  for (const id of index.ordered) {
    const loc = index.get(id)
    if (loc.story !== 'body') break
    if (loc.order < from.order || loc.order > to.order) continue
    if (loc.order === to.order && loc.order !== from.order && toOffset === 0) continue
    if (previewParagraph(doc, loc)) continue
    out.push(loc.para)
  }
  return out
}

function firstLockedParagraph(paras: readonly Paragraph[]): string | null {
  for (const para of paras) {
    if (para.lock) return para.id
  }
  return null
}

function readOnlyId(doc: Doc, sel: Selection): string | null {
  if (sel.kind !== 'text') return null
  const ids = sel.anchor.p === sel.head.p ? [sel.anchor.p] : [sel.anchor.p, sel.head.p]
  for (const id of ids) {
    const loc = locateParagraph(doc, id)
    if (!loc) continue
    if (loc.story !== 'body' || previewParagraph(doc, loc)) return loc.para.id
  }
  return null
}

function boundaryLock(doc: Doc, sel: Selection, direction: 'backward' | 'forward'): string | null {
  if (sel.kind !== 'text') return null
  if (sel.anchor.p !== sel.head.p || sel.anchor.o !== sel.head.o) return null
  const loc = locateParagraph(doc, sel.head.p)
  if (!loc) return null
  const length = flatText(loc.para).length
  if (direction === 'backward' && sel.head.o !== 0) return null
  if (direction === 'forward' && sel.head.o < length) return null
  const neighbor = sibling(doc, loc, direction)
  if (!neighbor?.para.lock) return null
  return neighbor.para.id
}

function sibling(doc: Doc, loc: ParaLoc, direction: 'backward' | 'forward'): ParaLoc | null {
  const index = indexOf(doc)
  const paras: ParaLoc[] = []
  for (const id of index.ordered) {
    const item = index.get(id)
    if (item.story !== 'body') break
    if (!previewParagraph(doc, item)) paras.push(item)
  }
  const at = paras.findIndex((item) => item.para.id === loc.para.id)
  if (at < 0) return null
  const other = paras[direction === 'backward' ? at - 1 : at + 1]
  if (!other || !adjacent(direction === 'backward' ? other : loc, direction === 'backward' ? loc : other)) return null
  return other
}

function adjacent(first: ParaLoc, second: ParaLoc): boolean {
  if (first.path.length !== second.path.length) return false
  for (let i = 0; i < first.path.length - 1; i++) {
    if (first.path[i] !== second.path[i]) return false
  }
  const a = first.path[first.path.length - 1]
  const b = second.path[second.path.length - 1]
  return a !== undefined && b !== undefined && b === a + 1
}

function hasMovable(doc: Doc): boolean {
  const index = indexOf(doc)
  for (const id of index.ordered) {
    const loc = index.get(id)
    if (loc.story !== 'body') break
    if (!previewParagraph(doc, loc)) return true
  }
  return false
}

interface TableHit {
  readonly table: Table
  readonly r0: number
  readonly r1: number
  readonly c0: number
  readonly c1: number
}

function tableHit(doc: Doc, sel: Selection): TableHit | null {
  if (sel.kind === 'cells') {
    const table = findTable(doc.body, sel.table)
    if (!table) return null
    return {
      table,
      r0: Math.min(sel.anchor.row, sel.head.row),
      r1: Math.max(sel.anchor.row, sel.head.row),
      c0: Math.min(sel.anchor.cell, sel.head.cell),
      c1: Math.max(sel.anchor.cell, sel.head.cell),
    }
  }
  const loc = locateParagraph(doc, sel.head.p)
  if (!loc) return null
  const addr = tableAddress(doc, loc)
  if (!addr) return null
  return { table: addr.table, r0: addr.row, r1: addr.row, c0: addr.cell, c1: addr.cell }
}

function tableAddress(doc: Doc, loc: ParaLoc): { table: Table, row: number, cell: number } | null {
  let blocks: readonly Block[] = doc.body
  const path = loc.path
  let i = 0
  while (i + 3 < path.length) {
    const blockIndex = path[i]
    const row = path[i + 1]
    const cell = path[i + 2]
    if (blockIndex === undefined || row === undefined || cell === undefined) return null
    const block = blocks[blockIndex]
    if (!block || block.kind !== 'table') return null
    const inner = block.rows[row]?.cells[cell]?.blocks
    if (!inner) return null
    if (i + 4 === path.length) return { table: block, row, cell }
    blocks = inner
    i += 3
  }
  return null
}

function findTable(blocks: readonly Block[], id: string): Table | null {
  for (const block of blocks) {
    if (block.kind !== 'table') continue
    if (block.id === id) return block
    for (const row of block.rows) {
      for (const cell of row.cells) {
        const found = findTable(cell.blocks, id)
        if (found) return found
      }
    }
  }
  return null
}

function paragraphsInTable(table: Table): Paragraph[] {
  const out: Paragraph[] = []
  for (const row of table.rows) {
    for (const cell of row.cells) collectParagraphs(cell.blocks, out)
  }
  return out
}

function paragraphsInRows(table: Table, r0: number, r1: number): Paragraph[] {
  const out: Paragraph[] = []
  for (let r = r0; r <= r1; r++) {
    const row = table.rows[r]
    if (!row) continue
    for (const cell of row.cells) collectParagraphs(cell.blocks, out)
  }
  return out
}

function paragraphsInColumns(table: Table, start: number, end: number): Paragraph[] {
  const out: Paragraph[] = []
  for (const row of table.rows) {
    let cursor = 0
    for (const cell of row.cells) {
      const cellStart = cursor
      const cellEnd = cursor + cell.span - 1
      cursor += cell.span
      if (cellEnd < start || cellStart > end) continue
      collectParagraphs(cell.blocks, out)
    }
  }
  return out
}

function columnSpan(doc: Doc, sel: Selection): { table: Table, start: number, end: number } | null {
  const hit = tableHit(doc, sel)
  if (!hit) return null
  const top = hit.table.rows[hit.r0]
  const bottom = hit.table.rows[hit.r1]
  if (!top) return null
  const row = bottom ?? top
  const a = columnOf(top, hit.c0)
  const b = columnOf(row, hit.c1)
  const aSpan = top.cells[hit.c0]?.span ?? 1
  const bSpan = row.cells[hit.c1]?.span ?? 1
  return { table: hit.table, start: Math.min(a, b), end: Math.max(a + aSpan - 1, b + bSpan - 1) }
}

function columnOf(row: Row, cellIndex: number): number {
  let col = 0
  for (let i = 0; i < cellIndex; i++) col += row.cells[i]?.span ?? 1
  return col
}

function collectParagraphs(blocks: readonly Block[], out: Paragraph[]): void {
  for (const block of blocks) {
    if (block.kind === 'p') out.push(block)
    else if (block.kind === 'table') {
      for (const row of block.rows) {
        for (const cell of row.cells) collectParagraphs(cell.blocks, out)
      }
    }
  }
}

function cellFits(table: Table, row: number, cell: number): boolean {
  return row >= 0 && row < table.rows.length && cell >= 0 && cell < (table.rows[row]?.cells.length ?? 0)
}

function markChange(mark: string, value: unknown): MarkValue | Refusal {
  if (
    mark !== 'font' && mark !== 'fontEastAsia' && mark !== 'sizePt'
    && mark !== 'color' && mark !== 'highlight' && mark !== 'vertAlign'
  ) {
    return bad('mark')
  }
  if (value === undefined || (value !== null && typeof value !== 'string' && typeof value !== 'number')) return bad('value')
  if (mark === 'font') {
    if (value === null) return { mark: 'font', value: undefined }
    if (typeof value !== 'string') return bad('value')
    return { mark: 'font', value }
  }
  if (mark === 'fontEastAsia') {
    if (value === null) return { mark: 'fontEastAsia', value: undefined }
    if (typeof value !== 'string') return bad('value')
    return { mark: 'fontEastAsia', value }
  }
  if (mark === 'sizePt') {
    if (value === null) return { mark: 'sizePt', value: undefined }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return bad('value')
    return { mark: 'sizePt', value: points(value) }
  }
  if (mark === 'color') {
    if (value === null) return { mark: 'color', value: undefined }
    if (typeof value !== 'string' || !/^[0-9A-Fa-f]{6}$/.test(value)) return bad('value')
    return { mark: 'color', value: hexColor(value) }
  }
  if (mark === 'highlight') {
    if (value === null) return { mark: 'highlight', value: undefined }
    if (typeof value !== 'string') return bad('value')
    const highlight = highlightOf(value)
    if (!highlight) return bad('value')
    return { mark: 'highlight', value: highlight }
  }
  if (mark === 'vertAlign') {
    if (value === null) return { mark: 'vertAlign', value: undefined }
    if (value !== 'super' && value !== 'sub') return bad('value')
    return { mark: 'vertAlign', value }
  }
  return bad('mark')
}

function highlightOf(value: string): HighlightName | null {
  switch (value) {
    case 'yellow':
    case 'green':
    case 'cyan':
    case 'magenta':
    case 'blue':
    case 'red':
    case 'darkBlue':
    case 'darkCyan':
    case 'darkGreen':
    case 'darkMagenta':
    case 'darkRed':
    case 'darkYellow':
    case 'darkGray':
    case 'lightGray':
    case 'black':
      return value
    default:
      return null
  }
}

function styleRef(doc: Doc, id: string): StyleId | null {
  for (const key of doc.styles.paragraph.keys()) {
    if (key === id) return key
  }
  switch (id) {
    case 'normal':
    case 'title':
    case 'heading1':
    case 'heading2':
    case 'heading3':
      // StyleId is a string brand. These literals are the role ids the editor can add.
      return id as StyleId
    default:
      return null
  }
}

function parsePage(value: unknown): PageSetup | Refusal {
  if (!isRecord(value)) return bad('page')
  const extra = unknownKey(value, ['widthPt', 'heightPt', 'margin'])
  if (extra) return bad(extra)
  const widthPt = finite(value.widthPt, 'widthPt')
  if (isRefusal(widthPt)) return widthPt
  const heightPt = finite(value.heightPt, 'heightPt')
  if (isRefusal(heightPt)) return heightPt
  if (widthPt <= 0) return bad('widthPt')
  if (heightPt <= 0) return bad('heightPt')
  if (!isRecord(value.margin)) return bad('margin')
  const marginExtra = unknownKey(value.margin, ['top', 'right', 'bottom', 'left', 'header', 'footer', 'gutter'])
  if (marginExtra) return bad(marginExtra)
  const top = finite(value.margin.top, 'top')
  if (isRefusal(top)) return top
  const right = finite(value.margin.right, 'right')
  if (isRefusal(right)) return right
  const bottom = finite(value.margin.bottom, 'bottom')
  if (isRefusal(bottom)) return bottom
  const left = finite(value.margin.left, 'left')
  if (isRefusal(left)) return left
  const header = finite(value.margin.header, 'header')
  if (isRefusal(header)) return header
  const footer = finite(value.margin.footer, 'footer')
  if (isRefusal(footer)) return footer
  const gutter = finite(value.margin.gutter, 'gutter')
  if (isRefusal(gutter)) return gutter
  return {
    widthPt: points(widthPt),
    heightPt: points(heightPt),
    margin: {
      top: points(top),
      right: points(right),
      bottom: points(bottom),
      left: points(left),
      header: points(header),
      footer: points(footer),
      gutter: points(gutter),
    },
  }
}

function blobFrom(bytes: Uint8Array, type: string): Blob {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return new Blob([copy], { type })
}

function decodeBase64(value: string): Uint8Array | Refusal {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return bad('base64')
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  if ((value.length / 4) * 3 - padding > IMAGE_MAX) return bad('base64')
  try {
    const binary = atob(value)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    if (out.byteLength > IMAGE_MAX) return bad('base64')
    return out
  } catch {
    return bad('base64')
  }
}

function optionalPlace(record: Record<string, unknown>): Place | undefined | Refusal {
  if (!('at' in record)) return undefined
  return parsePlace(record.at, 'at')
}

function parsePlace(value: unknown, field: string): Place | Refusal {
  if (!isRecord(value)) return bad(field)
  if ('para' in value) {
    if ('anchor' in value || 'head' in value) return bad(field)
    return parseAddress(value, field)
  }
  const extra = unknownKey(value, ['anchor', 'head'])
  if (extra) return bad(extra)
  const anchor = parseAddress(value.anchor, 'anchor')
  if (isRefusal(anchor)) return anchor
  const head = parseAddress(value.head, 'head')
  if (isRefusal(head)) return head
  return { anchor, head }
}

function parseAddress(value: unknown, field: string): Address | Refusal {
  if (!isRecord(value)) return bad(field)
  const extra = unknownKey(value, ['para', 'offset'])
  if (extra) return bad(extra)
  if (typeof value.para !== 'string' || value.para.length === 0) return bad('para')
  const offset = value.offset
  if (offset !== 'end' && (typeof offset !== 'number' || !Number.isInteger(offset))) return bad('offset')
  return { para: value.para, offset }
}

function parseCorner(value: unknown, field: string): { row: number, cell: number } | Refusal {
  if (!isRecord(value)) return bad(field)
  const extra = unknownKey(value, ['row', 'cell'])
  if (extra) return bad(extra)
  if (typeof value.row !== 'number' || !Number.isInteger(value.row) || value.row < 0) return bad('row')
  if (typeof value.cell !== 'number' || !Number.isInteger(value.cell) || value.cell < 0) return bad('cell')
  return { row: value.row, cell: value.cell }
}

function optionalInt(record: Record<string, unknown>, field: string, min: number): number | undefined | Refusal {
  if (!(field in record)) return undefined
  const value = record[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) return bad(field)
  return value
}

function requiredInt(record: Record<string, unknown>, field: string, min: number): number | Refusal {
  if (!(field in record)) return bad(field)
  const value = record[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) return bad(field)
  return value
}

function requiredString(record: Record<string, unknown>, field: string): string | Refusal {
  const value = record[field]
  if (typeof value !== 'string') return bad(field)
  return value
}

function optionalPoint(record: Record<string, unknown>, field: string): number | undefined | Refusal {
  if (!(field in record)) return undefined
  const value = finite(record[field], field)
  if (isRefusal(value)) return value
  return value
}

function finite(value: unknown, field: string): number | Refusal {
  if (typeof value !== 'number' || !Number.isFinite(value)) return bad(field)
  return value
}

function points(value: number): Pt {
  // Pt is a number brand. `value` was checked to be a finite number.
  return value as Pt
}

function hexColor(value: string): Hex {
  // Hex is a string brand. `value` matched RRGGBB.
  return value as Hex
}

function bad(field: string): Refusal {
  return { ok: false, error: { code: 'bad-request', message: `bad field "${field}"` } }
}

function unsupported(): Refusal {
  return { ok: false, error: { code: 'unsupported-version', message: 'unsupported version' } }
}

function unknownOp(op: string): Refusal {
  return { ok: false, error: { code: 'unknown-op', message: `unknown op "${op}"` } }
}

function busy(reason: string): Refusal {
  const message = reason.length > 0 ? `busy: ${reason}` : 'busy'
  return { ok: false, error: { code: 'busy', message } }
}

function ensureIdle(host: Host): Refusal | null {
  const reason = host.busy()
  return reason === null ? null : busy(reason)
}

function refused(op: string): Refusal {
  return { ok: false, error: { code: 'refused', message: `${op} did not apply` } }
}

function unknownId(id: string): Refusal {
  return { ok: false, error: { code: 'unknown-address', message: `unknown id ${id}`, para: id } }
}

function lockedRefusal(id: string): Refusal {
  return { ok: false, error: { code: 'locked', message: `paragraph ${id} is locked`, para: id } }
}

function fromAddress(error: AddressError): Refusal {
  if (error.para !== undefined) {
    return { ok: false, error: { code: error.code, message: error.message, para: error.para } }
  }
  return { ok: false, error: { code: error.code, message: error.message } }
}

function unknownKey(record: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) return key
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRefusal(value: unknown): value is Refusal {
  return typeof value === 'object' && value !== null && 'ok' in value && value.ok === false && 'error' in value
}
