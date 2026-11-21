import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listMarkers } from '../editor/derive.ts'
import {
  apply,
  COALESCE_MS,
  initialState,
  insertText,
  redo,
  setSelection,
  undo,
  wordCount,
} from '../editor/edit.ts'
import type { Command, MediaRef } from '../editor/edit.ts'
import { checkDoc, flatText } from '../model.ts'
import type { Block, Doc, Paragraph, Pos, Table } from '../model.ts'
import {
  cell,
  makeDoc,
  mediaKey,
  mulberry32,
  NORMAL,
  opaqueBlock,
  paragraph,
  row,
  storyKey,
  table,
  text,
} from '../editor/testkit.ts'
import { KEYS, createInterface } from './api.ts'
import type { Host } from './host.ts'
import type { EditOk, Response } from './types.ts'

const CODES = new Set([
  'bad-request',
  'unknown-op',
  'unsupported-version',
  'unknown-address',
  'out-of-range',
  'locked',
  'read-only-story',
  'busy',
  'refused',
])

function opsDoc(): Doc {
  const built = makeDoc([
    paragraph('p', [text('Hello')], { style: NORMAL, indent: { firstLineChars: 200 } }),
    paragraph('open', [text('yes')]),
    paragraph('locked', [text('no')], {}, { lock: { reason: 'revisions' } }),
    table('t', [
      row([
        cell([paragraph('c', [text('c')])]),
        cell([paragraph('d', [text('d')])]),
      ]),
      row([
        cell([paragraph('e', [text('e')])]),
        cell([paragraph('f', [text('f')])]),
      ]),
    ]),
  ], {
    stories: new Map([[storyKey('s0/header/default'), [paragraph('header', [text('Head')])]]]),
  })
  checkDoc(built)
  return built
}

interface Harness {
  host: Host
  call(request: unknown): Promise<Response>
  media: Blob[]
  setBusy(reason: string | null): void
  setHit(pos: Pos | null): void
  explode(): void
  editOutside(command: Command, notifyNow?: boolean): void
  load(next: Doc): void
}

function harness(doc: Doc): Harness {
  let state = initialState(doc)
  let original = doc
  let session: object = {}
  let busy: string | null = null
  let hit: Pos | null = null
  let now = 0
  let boom = false
  const media: Blob[] = []
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of listeners) listener()
  }
  const host: Host = {
    state: () => state,
    run(command) {
      if (boom) {
        boom = false
        throw new Error('boom')
      }
      const tr = command(state)
      if (!tr) return false
      now += COALESCE_MS + 1
      state = apply(state, tr, now)
      notify()
      return true
    },
    undo() {
      const next = undo(state)
      if (!next) return false
      state = next
      notify()
      return true
    },
    redo() {
      const next = redo(state)
      if (!next) return false
      state = next
      notify()
      return true
    },
    pageOf: () => 0,
    status: () => ({ page: 1, pages: 3, pagesFinal: true, words: wordCount(state.doc), section: 0 }),
    busy: () => busy,
    async addMedia(blob): Promise<MediaRef> {
      media.push(blob)
      return { key: mediaKey('m'), contentType: blob.type, widthPx: 8, heightPx: 8 }
    },
    hitTest: () => hit,
    file: () => ({ name: 'doc.docx', dirty: state.doc !== original, session }),
    markers: () => listMarkers(state.doc),
    watch(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  const word = createInterface(host)
  return {
    host,
    call: (request) => word.call(request),
    media,
    setBusy(reason) {
      busy = reason
    },
    setHit(pos) {
      hit = pos
    },
    explode() {
      boom = true
    },
    editOutside(command, notifyNow = false) {
      const tr = command(state)
      if (!tr) throw new Error('outside edit did not apply')
      now += COALESCE_MS + 1
      state = apply(state, tr, now)
      if (notifyNow) notify()
    },
    load(next) {
      original = next
      state = initialState(next)
      session = {}
      notify()
    },
  }
}

function assertEdit(response: Response): EditOk {
  if (!response.ok || !('created' in response)) assert.fail(JSON.stringify(response))
  return response
}

function assertRefusal(response: Response): Extract<Response, { ok: false }> {
  if (response.ok) assert.fail(JSON.stringify(response))
  return response
}

function idsOf(doc: Doc): string[] {
  const out: string[] = []
  const walk = (blocks: readonly Block[]): void => {
    for (const block of blocks) {
      out.push(block.id)
      if (block.kind === 'table') {
        for (const line of block.rows) {
          for (const item of line.cells) walk(item.blocks)
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

function idDiff(before: readonly string[], after: readonly string[]): { created: string[], removed: string[] } {
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  return {
    created: after.filter((id) => !beforeSet.has(id)),
    removed: before.filter((id) => !afterSet.has(id)),
  }
}

function findPara(doc: Doc, id: string): Paragraph {
  const visit = (blocks: readonly Block[]): Paragraph | null => {
    for (const block of blocks) {
      if (block.kind === 'p') {
        if (block.id === id) return block
      } else if (block.kind === 'table') {
        for (const line of block.rows) {
          for (const item of line.cells) {
            const found = visit(item.blocks)
            if (found) return found
          }
        }
      } else {
        for (const para of block.preview) {
          if (para.id === id) return para
        }
      }
    }
    return null
  }
  const found = visit(doc.body)
  if (found) return found
  for (const blocks of doc.stories.values()) {
    const story = visit(blocks)
    if (story) return story
  }
  assert.fail(`missing paragraph ${id}`)
}

function pageBody(width: number) {
  return {
    widthPt: width,
    heightPt: 792,
    margin: { top: 72, right: 72, bottom: 72, left: 72, header: 36, footer: 36, gutter: 0 },
  }
}

const end = { para: 'p', offset: 'end' as const }
const range = { anchor: { para: 'p', offset: 0 }, head: { para: 'p', offset: 5 } }

async function runOp(request: Record<string, unknown>, check: (doc: Doc, response: EditOk) => void): Promise<void> {
  const h = harness(opsDoc())
  const before = h.host.state().doc
  const response = assertEdit(await h.call(request))
  const after = h.host.state().doc
  const diff = idDiff(idsOf(before), idsOf(after))
  assert.deepEqual(response.created, diff.created)
  assert.deepEqual(response.removed, diff.removed)
  check(after, response)
  if (after !== before) {
    const undone = assertEdit(await h.call({ op: 'undo' }))
    assert.equal(h.host.state().doc, before)
    assert.deepEqual(undone.created, diff.removed)
    assert.deepEqual(undone.removed, diff.created)
  }
}

test('every edit op reports created and removed and undo restores the doc', async () => {
  await runOp({ op: 'select', at: { para: 'p', offset: 2 } }, (doc, response) => {
    assert.equal(flatText(findPara(doc, 'p')), 'Hello')
    assert.deepEqual(response.selection, {
      kind: 'text',
      anchor: { para: 'p', offset: 2 },
      head: { para: 'p', offset: 2 },
    })
  })
  await runOp({
    op: 'selectCells',
    table: 't',
    anchor: { row: 0, cell: 0 },
    head: { row: 1, cell: 1 },
  }, (_doc, response) => {
    assert.deepEqual(response.selection, {
      kind: 'cells',
      table: 't',
      anchor: { row: 0, cell: 0 },
      head: { row: 1, cell: 1 },
    })
  })
  await runOp({ op: 'selectAll' }, (_doc, response) => {
    assert.deepEqual(response.selection, {
      kind: 'text',
      anchor: { para: 'p', offset: 0 },
      head: { para: 'f', offset: 1 },
    })
  })
  await runOp({ op: 'insertText', text: 'A\nB', at: end }, (doc, response) => {
    assert.equal(response.created.length, 1)
    assert.deepEqual(response.removed, [])
    const created = response.created[0]
    assert.ok(created)
    assert.equal(flatText(findPara(doc, 'p')), 'HelloA')
    assert.equal(flatText(findPara(doc, created)), 'B')
    assert.equal(findPara(doc, created).props.style, 'normal')
  })
  await runOp({ op: 'insertText', text: '\t', at: { para: 'p', offset: 0 } }, (doc, response) => {
    assert.deepEqual(response.created, [])
    assert.equal(flatText(findPara(doc, 'p')), '\tHello')
  })
  await runOp({ op: 'enter', at: end }, (doc, response) => {
    assert.equal(response.created.length, 1)
    assert.equal(flatText(findPara(doc, 'p')), 'Hello')
    const created = response.created[0]
    assert.ok(created)
    assert.equal(flatText(findPara(doc, created)), '')
  })
  await runOp({ op: 'lineBreak', at: end }, (doc, response) => {
    assert.deepEqual(response.created, [])
    assert.equal(flatText(findPara(doc, 'p')), 'Hello\n')
  })
  await runOp({ op: 'pageBreak', at: end }, (doc, response) => {
    assert.deepEqual(response.created, [])
    assert.equal(findPara(doc, 'p').inlines.some((inline) => inline.kind === 'atom' && inline.atom.type === 'pageBreak'), true)
  })
  await runOp({
    op: 'delete',
    at: { anchor: { para: 'p', offset: 1 }, head: { para: 'p', offset: 4 } },
  }, (doc, response) => {
    assert.deepEqual(response.removed, [])
    assert.equal(flatText(findPara(doc, 'p')), 'Ho')
  })
  await runOp({ op: 'delete', direction: 'backward', at: end }, (doc) => {
    assert.equal(flatText(findPara(doc, 'p')), 'Hell')
  })
  await runOp({ op: 'delete', direction: 'forward', unit: 'word', at: { para: 'p', offset: 0 } }, (doc) => {
    assert.equal(flatText(findPara(doc, 'p')), '')
  })
  await runOp({ op: 'toggleMark', mark: 'bold', at: range }, (doc) => {
    const inline = findPara(doc, 'p').inlines[0]
    assert.equal(inline?.kind, 'text')
    if (inline?.kind === 'text') assert.equal(inline.marks.bold, true)
  })
  await runOp({ op: 'setMark', mark: 'font', value: 'Songti', at: range }, (doc) => {
    const inline = findPara(doc, 'p').inlines[0]
    assert.equal(inline?.kind, 'text')
    if (inline?.kind === 'text') assert.equal(inline.marks.font, 'Songti')
  })
  await runOp({ op: 'setStyle', style: 'heading1', at: { para: 'p', offset: 0 } }, (doc) => {
    assert.equal(findPara(doc, 'p').props.style, 'heading1')
  })
  await runOp({ op: 'setAlign', align: 'center', at: { para: 'p', offset: 0 } }, (doc) => {
    assert.equal(findPara(doc, 'p').props.align, 'center')
  })
  await runOp({ op: 'setAlign', align: 'distribute', at: { para: 'p', offset: 0 } }, (doc) => {
    assert.equal(findPara(doc, 'p').props.align, 'distribute')
  })
  await runOp({ op: 'setIndent', left: 36, at: { para: 'p', offset: 0 } }, (doc) => {
    assert.equal(findPara(doc, 'p').props.indent?.left, 36)
    assert.equal(findPara(doc, 'p').props.indent?.firstLineChars, 200)
  })
  await runOp({ op: 'setLineSpacing', rule: 'exact', value: 16, at: { para: 'p', offset: 0 } }, (doc) => {
    assert.deepEqual(findPara(doc, 'p').props.spacing?.line, { rule: 'exact', pt: 16 })
  })
  await runOp({ op: 'setLineSpacing', rule: 'auto', value: 1.5, at: { para: 'p', offset: 0 } }, (doc) => {
    assert.deepEqual(findPara(doc, 'p').props.spacing?.line, { rule: 'auto', multiple: 1.5 })
  })
  await runOp({ op: 'indentLevel', delta: 1, at: { para: 'p', offset: 0 } }, (doc) => {
    assert.equal(findPara(doc, 'p').props.indent?.left, 36)
    assert.equal(findPara(doc, 'p').props.indent?.firstLineChars, 200)
  })
  await runOp({ op: 'toggleList', list: 'bullet', at: { para: 'p', offset: 0 } }, (doc) => {
    assert.equal(findPara(doc, 'p').props.numbering?.level, 0)
  })
  await runOp({ op: 'insertTable', rows: 2, cols: 2, at: end }, (doc, response) => {
    assert.equal(response.created.length, 5)
    assert.deepEqual(response.removed, [])
    const tableId = response.created[0]
    assert.ok(tableId)
    const block = doc.body.find((item) => item.id === tableId)
    assert.equal(block?.kind, 'table')
  })
  await runOp({ op: 'insertRow', where: 'below', at: { para: 'c', offset: 0 } }, (doc, response) => {
    assert.equal(response.created.length, 2)
    assert.deepEqual(response.removed, [])
    const grid = doc.body.find((item) => item.id === 't')
    assert.equal(grid?.kind, 'table')
    if (grid?.kind === 'table') assert.equal(grid.rows.length, 3)
  })
  await runOp({ op: 'deleteRows', at: { para: 'c', offset: 0 } }, (_doc, response) => {
    assert.deepEqual(response.removed, ['c', 'd'])
    assert.deepEqual(response.created, [])
  })
  await runOp({ op: 'insertColumn', where: 'right', at: { para: 'c', offset: 0 } }, (_doc, response) => {
    assert.equal(response.created.length, 2)
    assert.deepEqual(response.removed, [])
  })
  await runOp({ op: 'deleteColumns', at: { para: 'c', offset: 0 } }, (_doc, response) => {
    assert.deepEqual(response.removed, ['c', 'e'])
    assert.deepEqual(response.created, [])
  })
  await runOp({ op: 'deleteTable', table: 't' }, (_doc, response) => {
    assert.deepEqual(response.removed, ['t', 'c', 'd', 'e', 'f'])
    assert.deepEqual(response.created, [])
  })
  await runOp({ op: 'deleteTable', at: { para: 'c', offset: 0 } }, (_doc, response) => {
    assert.deepEqual(response.removed, ['t', 'c', 'd', 'e', 'f'])
  })
  await runOp({
    op: 'insertImage',
    base64: 'YQ==',
    contentType: 'image/png',
    at: end,
  }, (doc, response) => {
    assert.deepEqual(response.created, [])
    assert.equal(findPara(doc, 'p').inlines.some((inline) => inline.kind === 'atom' && inline.atom.type === 'image'), true)
  })
  await runOp({ op: 'setPageSetup', section: 0, page: pageBody(500) }, (doc, response) => {
    assert.deepEqual(response.created, [])
    assert.deepEqual(response.removed, [])
    assert.equal(doc.sections[0]?.page.widthPt, 500)
  })
})

test('undo and redo restore the previous document object', async () => {
  const h = harness(opsDoc())
  const original = h.host.state().doc
  const empty = assertRefusal(await h.call({ op: 'undo' }))
  assert.equal(empty.error.code, 'refused')
  assert.equal(h.host.state().doc, original)
  const inserted = assertEdit(await h.call({ op: 'insertText', text: 'A\nB', at: end }))
  const edited = h.host.state().doc
  assert.equal(inserted.created.length, 1)
  const undone = assertEdit(await h.call({ op: 'undo', at: { para: 'open', offset: 0 } }))
  assert.equal(h.host.state().doc, original)
  assert.deepEqual(undone.removed, inserted.created)
  const redone = assertEdit(await h.call({ op: 'redo' }))
  assert.equal(h.host.state().doc, edited)
  assert.deepEqual(redone.created, inserted.created)
  const again = assertEdit(await h.call({ op: 'undo' }))
  assert.equal(h.host.state().doc, original)
  assert.equal(again.rev, 4)
})

test('a refused op after at leaves the selection', async () => {
  const h = harness(opsDoc())
  const stored = assertEdit(await h.call({ op: 'toggleMark', mark: 'bold', at: { para: 'p', offset: 0 } }))
  assert.equal(stored.rev, 0)
  const sel = h.host.state().sel
  const marks = h.host.state().stored
  const doc = h.host.state().doc
  assert.ok(marks)
  const response = assertRefusal(await h.call({
    op: 'insertRow',
    where: 'above',
    at: { para: 'p', offset: 0 },
  }))
  assert.equal(response.error.code, 'refused')
  assert.match(response.error.message, /insertRow/)
  assert.equal(h.host.state().sel, sel)
  assert.equal(h.host.state().stored, marks)
  assert.equal(h.host.state().doc, doc)
})

test('locked, read-only, and unknown addresses change nothing', async () => {
  const h = harness(opsDoc())
  const doc = h.host.state().doc
  const locked = assertRefusal(await h.call({
    op: 'insertText',
    text: 'x',
    at: { para: 'locked', offset: 0 },
  }))
  assert.equal(locked.error.code, 'locked')
  assert.equal(locked.error.para, 'locked')
  assert.equal(h.host.state().doc, doc)

  const across = assertRefusal(await h.call({
    op: 'setAlign',
    align: 'center',
    at: { anchor: { para: 'open', offset: 0 }, head: { para: 'locked', offset: 1 } },
  }))
  assert.equal(across.error.code, 'locked')
  assert.equal(across.error.para, 'locked')
  assert.equal(h.host.state().doc, doc)
  assert.equal(findPara(h.host.state().doc, 'open').props.align, undefined)

  const boundary = assertRefusal(await h.call({
    op: 'delete',
    direction: 'forward',
    at: { para: 'open', offset: 'end' },
  }))
  assert.equal(boundary.error.code, 'locked')
  assert.equal(boundary.error.para, 'locked')
  assert.equal(h.host.state().doc, doc)

  const header = assertRefusal(await h.call({
    op: 'insertText',
    text: 'x',
    at: { para: 'header', offset: 0 },
  }))
  assert.equal(header.error.code, 'read-only-story')
  assert.equal(header.error.para, 'header')
  assert.equal(h.host.state().doc, doc)

  const missing = assertRefusal(await h.call({
    op: 'insertText',
    text: 'x',
    at: { para: 'missing', offset: 0 },
  }))
  assert.equal(missing.error.code, 'unknown-address')
  assert.equal(missing.error.para, 'missing')
  assert.equal(h.host.state().doc, doc)

  const chosen = assertEdit(await h.call({ op: 'select', at: { para: 'locked', offset: 1 } }))
  assert.equal(h.host.state().doc, doc)
  assert.equal(chosen.selection.kind, 'text')
  if (chosen.selection.kind === 'text') assert.equal(chosen.selection.head.para, 'locked')

  const previewDoc = makeDoc([
    paragraph('p', [text('Hello')]),
    opaqueBlock('box', [paragraph('prev', [text('Shown')], {}, { lock: { reason: 'preview' } })], true),
  ])
  const preview = harness(previewDoc)
  const shown = findPara(preview.host.state().doc, 'prev')
  assert.equal(preview.host.run(setSelection({
    kind: 'text',
    anchor: { p: shown.id, o: 0 },
    head: { p: shown.id, o: 0 },
  })), true)
  const before = preview.host.state().doc
  const refused = assertRefusal(await preview.call({ op: 'insertText', text: 'x' }))
  assert.equal(refused.error.code, 'read-only-story')
  assert.equal(refused.error.para, 'prev')
  assert.equal(preview.host.state().doc, before)
})

test('rev advances once per document change and not on a selection change', async () => {
  const h = harness(opsDoc())
  const info0 = await h.call({ op: 'info' })
  assert.equal(info0.ok, true)
  if (!info0.ok || !('name' in info0)) assert.fail(JSON.stringify(info0))
  assert.equal(info0.rev, 0)
  assert.equal(info0.name, 'doc.docx')
  assert.equal(info0.dirty, false)
  assert.equal(info0.pages, 3)
  assert.equal(info0.pagesFinal, true)
  assert.equal(info0.words, wordCount(h.host.state().doc))
  assert.equal(info0.blocks, 4)

  const selected = assertEdit(await h.call({ op: 'select', at: { para: 'p', offset: 1 } }))
  assert.equal(selected.rev, 0)
  const first = assertEdit(await h.call({ op: 'insertText', text: 'A' }))
  assert.equal(first.rev, 1)
  const afterFirst = h.host.state().doc
  const info1 = await h.call({ op: 'info' })
  if (!info1.ok || !('name' in info1)) assert.fail(JSON.stringify(info1))
  assert.equal(info1.rev, 1)
  assert.equal(info1.dirty, true)
  const second = assertEdit(await h.call({ op: 'insertText', text: 'B' }))
  assert.equal(second.rev, 2)
  const afterSecond = h.host.state().doc
  const undone = assertEdit(await h.call({ op: 'undo' }))
  assert.equal(undone.rev, 3)
  assert.equal(h.host.state().doc, afterFirst)
  const redone = assertEdit(await h.call({ op: 'redo' }))
  assert.equal(redone.rev, 4)
  assert.equal(h.host.state().doc, afterSecond)
  h.load(makeDoc([paragraph('q', [text('Q')])]))
  const loaded = await h.call({ op: 'info' })
  if (!loaded.ok || !('rev' in loaded)) assert.fail(JSON.stringify(loaded))
  assert.equal(loaded.rev, 0)

  const external = harness(opsDoc())
  external.editOutside(insertText('Z'))
  const seen = await external.call({ op: 'info' })
  if (!seen.ok || !('rev' in seen)) assert.fail(JSON.stringify(seen))
  assert.equal(seen.rev, 1)
  external.editOutside(insertText('Y'), true)
  const seenAgain = await external.call({ op: 'info' })
  if (!seenAgain.ok || !('rev' in seenAgain)) assert.fail(JSON.stringify(seenAgain))
  assert.equal(seenAgain.rev, 2)
})

test('busy blocks edits after the shape is valid and reads still answer', async () => {
  const h = harness(opsDoc())
  const doc = h.host.state().doc
  h.setBusy('preview')
  const edit = assertRefusal(await h.call({ op: 'insertText', text: 'x', at: { para: 'missing', offset: 0 } }))
  assert.equal(edit.error.code, 'busy')
  assert.match(edit.error.message, /preview/)
  assert.equal(h.host.state().doc, doc)
  const shaped = assertRefusal(await h.call({ op: 'insertText' }))
  assert.equal(shaped.error.code, 'bad-request')
  assert.match(shaped.error.message, /text/)
  const image = assertRefusal(await h.call({ op: 'insertImage', base64: 'YQ==', contentType: 'image/png' }))
  assert.equal(image.error.code, 'busy')
  assert.equal(h.media.length, 0)
  const info = await h.call({ op: 'info' })
  assert.equal(info.ok, true)
})

// `text` is chosen in dispatch and is not a KEYS entry. These are the read ops that are.
const READ_OPS = new Set(['info', 'selection', 'blocks', 'outline', 'find', 'hitTest'])

test('every edit op is busy and leaves the host state object', async () => {
  const cases: Record<string, unknown>[] = [
    { op: 'select', at: { para: 'p', offset: 2 } },
    { op: 'selectCells', table: 't', anchor: { row: 0, cell: 0 }, head: { row: 1, cell: 1 } },
    { op: 'selectAll' },
    { op: 'insertText', text: 'x', at: end },
    { op: 'enter', at: end },
    { op: 'lineBreak', at: end },
    { op: 'pageBreak', at: end },
    { op: 'delete', at: { anchor: { para: 'p', offset: 1 }, head: { para: 'p', offset: 4 } } },
    { op: 'toggleMark', mark: 'bold', at: range },
    { op: 'setMark', mark: 'font', value: 'Songti', at: range },
    { op: 'setStyle', style: 'heading1', at: { para: 'p', offset: 0 } },
    { op: 'setAlign', align: 'center', at: { para: 'p', offset: 0 } },
    { op: 'setIndent', left: 36, at: { para: 'p', offset: 0 } },
    { op: 'setLineSpacing', rule: 'exact', value: 16, at: { para: 'p', offset: 0 } },
    { op: 'indentLevel', delta: 1, at: { para: 'p', offset: 0 } },
    { op: 'toggleList', list: 'bullet', at: { para: 'p', offset: 0 } },
    { op: 'insertTable', rows: 2, cols: 2, at: end },
    { op: 'insertRow', where: 'below', at: { para: 'c', offset: 0 } },
    { op: 'deleteRows', at: { para: 'c', offset: 0 } },
    { op: 'insertColumn', where: 'right', at: { para: 'c', offset: 0 } },
    { op: 'deleteColumns', at: { para: 'c', offset: 0 } },
    { op: 'deleteTable', table: 't' },
    { op: 'insertImage', base64: 'YQ==', contentType: 'image/png', at: end },
    { op: 'setPageSetup', section: 0, page: pageBody(500) },
    { op: 'undo' },
    { op: 'redo' },
  ]
  const names = cases.map((request) => {
    if (typeof request.op !== 'string') assert.fail(JSON.stringify(request))
    return request.op
  })
  const editOps = [...KEYS.keys()].filter((op) => !READ_OPS.has(op))
  assert.equal(editOps.length, 26)
  assert.deepEqual([...names].sort(), [...editOps].sort())

  // Each request changes the editor state when the host is idle, so a missed busy check fails below.
  for (const request of cases) {
    const check = harness(opsDoc())
    assertEdit(await check.call({ op: 'insertText', text: 'A', at: end }))
    assertEdit(await check.call({ op: 'insertText', text: 'B' }))
    assertEdit(await check.call({ op: 'undo' }))
    const before = check.host.state()
    const response = await check.call(request)
    assert.equal(response.ok, true, JSON.stringify(request))
    assert.notEqual(check.host.state(), before, JSON.stringify(request.op))
  }

  const h = harness(opsDoc())
  assertEdit(await h.call({ op: 'insertText', text: 'A', at: end }))
  assertEdit(await h.call({ op: 'insertText', text: 'B' }))
  assertEdit(await h.call({ op: 'undo' }))
  const state = h.host.state()
  const media = h.media.length
  h.setBusy('preview')
  for (const request of cases) {
    const op = typeof request.op === 'string' ? request.op : ''
    const response = assertRefusal(await h.call(request))
    assert.equal(response.error.code, 'busy', op)
    assert.equal(h.host.state(), state, op)
    assert.equal(h.media.length, media, op)
  }
})

test('prototype names are unknown ops', async () => {
  const h = harness(opsDoc())
  const state = h.host.state()
  const errors: unknown[][] = []
  const write = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args)
  }
  try {
    for (const op of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const response = assertRefusal(await h.call({ op }))
      assert.equal(response.error.code, 'unknown-op', op)
      assert.equal(h.host.state(), state, op)
    }
    assert.equal(errors.length, 0)
  } finally {
    console.error = write
  }
})

test('a throwing host resolves as refused', async () => {
  const h = harness(opsDoc())
  const doc = h.host.state().doc
  const errors: unknown[][] = []
  const write = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args)
  }
  try {
    h.explode()
    const response = assertRefusal(await h.call({ op: 'insertText', text: 'x' }))
    assert.equal(response.error.code, 'refused')
    assert.equal(response.error.message, 'boom')
    assert.equal(h.host.state().doc, doc)
    assert.equal(errors.length, 1)
  } finally {
    console.error = write
  }
})

test('requests with a bad shape or a bad image are refused before the document changes', async () => {
  const h = harness(opsDoc())
  const doc = h.host.state().doc
  const cases: { request: unknown, code: string, field?: string }[] = [
    { request: null, code: 'bad-request', field: 'request' },
    { request: [], code: 'bad-request', field: 'request' },
    { request: { v: 2, op: 'nope' }, code: 'unsupported-version' },
    { request: { op: 'nope' }, code: 'unknown-op' },
    { request: { op: 'info', extra: 1 }, code: 'bad-request', field: 'extra' },
    { request: { op: 'insertText', text: 'a', extra: 1 }, code: 'bad-request', field: 'extra' },
    { request: { op: 'insertText', text: 'a', at: { para: 'p', offset: 1.5 } }, code: 'bad-request', field: 'offset' },
    { request: { op: 'insertText', text: 'a', at: { para: 'p', offset: -1 } }, code: 'out-of-range' },
    { request: { op: 'insertText', text: 'a', at: { para: 'p', offset: 6 } }, code: 'out-of-range' },
    { request: { op: 'delete', unit: 'word' }, code: 'bad-request', field: 'unit' },
    { request: { op: 'setMark', mark: 'bold', value: true }, code: 'bad-request', field: 'mark' },
    { request: { op: 'setMark', mark: 'sizePt', value: '14' }, code: 'bad-request', field: 'value' },
    { request: { op: 'setMark', mark: 'color', value: 'red' }, code: 'bad-request', field: 'value' },
    { request: { op: 'setMark', mark: 'highlight', value: 'pink' }, code: 'bad-request', field: 'value' },
    { request: { op: 'setMark', mark: 'vertAlign', value: true }, code: 'bad-request', field: 'value' },
    { request: { op: 'setStyle', style: 'heading 2' }, code: 'bad-request', field: 'style' },
    { request: { op: 'insertTable', rows: 501, cols: 2 }, code: 'bad-request', field: 'rows' },
    { request: { op: 'insertTable', rows: 2, cols: 64 }, code: 'bad-request', field: 'cols' },
    { request: { op: 'insertText', text: 'a'.repeat(1_000_001) }, code: 'bad-request', field: 'text' },
    { request: { op: 'text', ids: Array.from({ length: 501 }, () => 'p') }, code: 'bad-request', field: 'ids' },
    { request: { op: 'text', ids: ['missing'] }, code: 'unknown-address' },
    { request: { op: 'insertImage', base64: '!!!!', contentType: 'image/png' }, code: 'bad-request', field: 'base64' },
    { request: { op: 'insertImage', base64: 'YQ', contentType: 'image/png' }, code: 'bad-request', field: 'base64' },
    { request: { op: 'insertImage', base64: 'YQ==', contentType: 'image/webp' }, code: 'bad-request', field: 'contentType' },
    { request: { op: 'setPageSetup', section: 3, page: pageBody(500) }, code: 'bad-request', field: 'section' },
    { request: { v: 1, op: 'info' }, code: 'ok' },
  ]
  for (const item of cases) {
    const response = await h.call(item.request)
    if (item.code === 'ok') {
      assert.equal(response.ok, true, JSON.stringify(item.request))
    } else {
      const refusal = assertRefusal(response)
      assert.equal(refusal.error.code, item.code, JSON.stringify(item.request))
      if (item.field) assert.match(refusal.error.message, new RegExp(item.field))
    }
    assert.equal(h.host.state().doc, doc)
    assert.equal(h.media.length, 0)
  }
  const atEnd = assertEdit(await h.call({ op: 'insertText', text: 'Z', at: { para: 'p', offset: 5 } }))
  assert.equal(atEnd.rev, 1)
  assert.equal(flatText(findPara(h.host.state().doc, 'p')), 'HelloZ')
  await h.call({ op: 'undo' })
  const atWord = assertEdit(await h.call({ op: 'insertText', text: 'Z', at: end }))
  assert.equal(flatText(findPara(h.host.state().doc, atWord.selection.kind === 'text' ? 'p' : 'p')), 'HelloZ')
  const gif = assertEdit(await h.call({ op: 'insertImage', base64: 'YQ==', contentType: 'image/gif' }))
  assert.equal(gif.created.length, 0)
  assert.equal(h.media.length, 1)
  assert.equal(h.media[0]?.type, 'image/gif')
  assert.equal(h.media[0]?.size, 1)
  const huge = 'A'.repeat(22_369_624)
  const tooBig = assertRefusal(await h.call({ op: 'insertImage', base64: huge, contentType: 'image/png' }))
  assert.equal(tooBig.error.code, 'bad-request')
  assert.equal(h.media.length, 1)
})

test('setMark checks each mark against the editor union', async () => {
  const h = harness(opsDoc())
  const applyMark = async (mark: string, value: string | number | null) => {
    const response = assertEdit(await h.call({ op: 'setMark', mark, value, at: range }))
    return response
  }
  await applyMark('sizePt', 14)
  await applyMark('color', 'FF0000')
  await applyMark('highlight', 'yellow')
  await applyMark('vertAlign', 'super')
  await applyMark('font', 'Songti')
  let inline = findPara(h.host.state().doc, 'p').inlines[0]
  assert.equal(inline?.kind, 'text')
  if (inline?.kind === 'text') {
    assert.equal(inline.marks.sizePt, 14)
    assert.equal(inline.marks.color, 'FF0000')
    assert.equal(inline.marks.highlight, 'yellow')
    assert.equal(inline.marks.vertAlign, 'super')
    assert.equal(inline.marks.font, 'Songti')
  }
  await applyMark('font', null)
  inline = findPara(h.host.state().doc, 'p').inlines[0]
  if (inline?.kind === 'text') assert.equal(inline.marks.font, undefined)
  const role = assertEdit(await h.call({ op: 'setStyle', style: 'heading2', at: { para: 'open', offset: 0 } }))
  assert.equal(role.ok, true)
  let addedName: string | undefined
  for (const [key, style] of h.host.state().doc.styles.paragraph) {
    if (key === 'heading2') addedName = style.name
  }
  assert.equal(addedName, 'heading2')
  assert.equal(findPara(h.host.state().doc, 'open').props.style, 'heading2')
})

test('random valid requests keep the document invariants', { timeout: 60_000 }, async () => {
  const built = makeDoc([
    paragraph('a', [text('alpha beta')]),
    paragraph('locked', [text('secret')], {}, { lock: { reason: 'revisions' } }),
    table('t', [
      row([
        cell([paragraph('c', [text('one')])]),
        cell([paragraph('d', [text('two')])]),
      ]),
    ]),
    paragraph('z', [text('tail')]),
  ])
  checkDoc(built)
  const h = harness(built)
  const baseline = h.host.state().doc
  const rng = mulberry32(20261121)
  const pick = <T>(items: readonly T[]): T => {
    const item = items[Math.floor(rng() * items.length)]
    if (item === undefined) throw new Error('empty pick')
    return item
  }
  for (let i = 0; i < 500; i++) {
    const doc = h.host.state().doc
    const paras: Paragraph[] = []
    const tables: Table[] = []
    const walk = (blocks: readonly Block[]): void => {
      for (const block of blocks) {
        if (block.kind === 'p') paras.push(block)
        else if (block.kind === 'table') {
          tables.push(block)
          for (const line of block.rows) {
            for (const item of line.cells) walk(item.blocks)
          }
        }
      }
    }
    walk(doc.body)
    const grid = tables[0]
    if (paras.length === 0) {
      checkDoc(doc)
      checkDoc(doc, baseline)
      continue
    }
    const para = pick(paras)
    const len = flatText(para).length
    const offset = Math.floor(rng() * (len + 1))
    const caret = { para: para.id, offset }
    const other = pick(paras)
    const otherOffset = Math.floor(rng() * (flatText(other).length + 1))
    const span = { anchor: caret, head: { para: other.id, offset: otherOffset } }
    const page = pageBody(400 + Math.floor(rng() * 200))
    const requests: unknown[] = [
      { op: 'info' },
      { op: 'selection' },
      { op: 'blocks', from: 0, count: 1 + Math.floor(rng() * 4) },
      { op: 'text', from: 0, count: 2 },
      { op: 'outline' },
      { op: 'find', text: pick(['a', 'e', '你']), limit: 1 + Math.floor(rng() * 5), matchCase: rng() < 0.5 },
      { op: 'hitTest', clientX: rng() * 40, clientY: rng() * 40 },
      { op: 'select', at: caret },
      { op: 'select', at: span },
      { op: 'selectAll' },
      { op: 'insertText', text: pick(['a', 'A\nB', '\t', '你']), at: caret },
      { op: 'enter', at: caret },
      { op: 'lineBreak', at: caret },
      { op: 'pageBreak', at: caret },
      { op: 'delete', at: span },
      { op: 'delete', direction: pick(['backward', 'forward'] as const), unit: pick(['char', 'word'] as const), at: caret },
      { op: 'toggleMark', mark: pick(['bold', 'italic', 'underline', 'strike'] as const), at: span },
      { op: 'setMark', mark: 'font', value: rng() < 0.3 ? null : 'Songti', at: span },
      { op: 'setMark', mark: 'sizePt', value: 10 + Math.floor(rng() * 8), at: span },
      { op: 'setStyle', style: pick(['normal', 'heading1', 'heading2']), at: caret },
      { op: 'setAlign', align: pick(['left', 'center', 'right', 'justify', 'distribute'] as const), at: caret },
      { op: 'setIndent', left: Math.floor(rng() * 72), at: caret },
      { op: 'setLineSpacing', rule: 'auto', value: rng() * 2, at: caret },
      { op: 'setLineSpacing', rule: 'exact', value: Math.floor(rng() * 24), at: caret },
      { op: 'indentLevel', delta: rng() < 0.5 ? 1 : -1, at: caret },
      { op: 'toggleList', list: pick(['bullet', 'decimal'] as const), at: caret },
      { op: 'insertTable', rows: 1 + Math.floor(rng() * 2), cols: 1 + Math.floor(rng() * 2), at: caret },
      { op: 'insertRow', where: pick(['above', 'below'] as const), at: caret },
      { op: 'deleteRows', at: caret },
      { op: 'insertColumn', where: pick(['left', 'right'] as const), at: caret },
      { op: 'deleteColumns', at: caret },
      { op: 'deleteTable', at: caret },
      { op: 'insertImage', base64: 'YQ==', contentType: 'image/png', at: caret },
      { op: 'setPageSetup', section: 0, page },
      { op: 'undo' },
      { op: 'redo' },
    ]
    if (grid) {
      const rowIndex = Math.floor(rng() * grid.rows.length)
      const row = grid.rows[rowIndex]
      const cellIndex = row ? Math.floor(rng() * row.cells.length) : 0
      requests.push({
        op: 'selectCells',
        table: grid.id,
        anchor: { row: rowIndex, cell: cellIndex },
        head: { row: rowIndex, cell: cellIndex },
      })
      requests.push({ op: 'deleteTable', table: grid.id })
    }
    const request = pick(requests)
    const response = await h.call(request)
    if (response.ok) assert.equal(typeof response.rev, 'number')
    else assert.equal(CODES.has(response.error.code), true, response.error.code)
    checkDoc(h.host.state().doc)
    checkDoc(h.host.state().doc, baseline)
  }
})
