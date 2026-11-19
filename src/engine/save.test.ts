import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { apply, deleteBackward, deleteForward, initialState, insertText, move, redo, setAlign, setMark, setParaStyle, setPageSetup, setSelection, splitParagraph, toggleList, toggleMark, undo } from '../editor/edit.ts'
import type { Command, EditorState } from '../editor/edit.ts'
import { withCaretParagraph } from '../editor/derive.ts'
import { flatText, indexOf, type Block, type Doc, type Marks, type Paragraph, type Pt, type StyleId } from '../model.ts'
import {
  SaveVerifyError,
  SaveWriteError,
  createEngine,
  documentPatch,
  parseImported,
  saveTampered,
  toDoc,
  toWireBlock,
} from './engine.ts'
import type { Opened } from './engine.ts'
import { initSync } from './pkg/engine.js'
import type { PatchBlock } from './wire.ts'

const root = new URL('../../', import.meta.url)

initSync({ module: readFileSync(new URL('public/engine.wasm', root)) })
const engine = createEngine()

const FIXTURES = ['basic.docx', 'long.docx', 'preserve.docx'] as const

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`fixtures/${name}`, root)))
}

function golden(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`engine/tests/golden/${name}.json`, root), 'utf8'))
}

function run(state: EditorState, command: Command): EditorState {
  const tr = command(state)
  assert.ok(tr, 'command applies')
  return apply(state, tr, 0)
}

function caret(state: EditorState, para: Paragraph, offset: number): EditorState {
  const sel = { kind: 'text' as const, anchor: { p: para.id, o: offset }, head: { p: para.id, o: offset } }
  const tr = setSelection(sel)(state)
  if (!tr) return state
  return apply(state, tr, 0)
}

function bodyParas(doc: Doc): Paragraph[] {
  return doc.body.filter((block): block is Paragraph => block.kind === 'p')
}

function paraByText(doc: Doc, text: string): Paragraph {
  const found = bodyParas(doc).find((para) => flatText(para) === text)
  assert.ok(found, text)
  return found
}

function isKeep(block: PatchBlock): block is { keep: number } {
  return 'keep' in block && !('kind' in block)
}

function same(actual: unknown, expected: unknown, path: string): void {
  if (Object.is(actual, expected)) return
  if (Array.isArray(actual) && Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, `${path} length`)
    actual.forEach((item, index) => same(item, expected[index], `${path}[${index}]`))
    return
  }
  if (isRecord(actual) && isRecord(expected)) {
    const keys = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort()
    for (const key of keys) same(actual[key], expected[key], `${path}.${key}`)
    return
  }
  assert.deepEqual(actual, expected, path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sortedMarks(marks: Marks): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(marks).sort()) out[key] = marks[key as keyof Marks]
  return out
}

type RunFact = { readonly text: string; readonly marks: Record<string, unknown> } | { readonly atom: string }

function mergedRuns(para: Paragraph): RunFact[] {
  const out: ({ text: string; marks: Record<string, unknown> } | { atom: string })[] = []
  for (const inline of para.inlines) {
    if (inline.kind === 'atom') {
      out.push({ atom: inline.atom.type })
      continue
    }
    const marks = sortedMarks(inline.marks)
    const last = out[out.length - 1]
    if (last && 'text' in last && JSON.stringify(last.marks) === JSON.stringify(marks)) last.text += inline.text
    else out.push({ text: inline.text, marks })
  }
  return out
}

function listFormat(doc: Doc, para: Paragraph): string | null {
  const numbering = para.props.numbering
  if (numbering === undefined) return null
  if (numbering === null) return 'none'
  const level = doc.lists.byNum.get(numbering.num)?.levels[numbering.level]
  return level ? `${level.format}:${level.text}` : 'missing'
}

function projectBlocks(doc: Doc, blocks: readonly Block[]): unknown[] {
  return blocks.map((block) => {
    if (block.kind === 'p') {
      return {
        text: flatText(block),
        runs: mergedRuns(block),
        style: block.props.style ?? null,
        align: block.props.align ?? null,
        list: listFormat(doc, block),
      }
    }
    if (block.kind === 'table') {
      return { kind: 'table', rows: block.rows.map((row) => row.cells.map((cell) => projectBlocks(doc, cell.blocks))) }
    }
    return { kind: 'opaque', label: block.label, preview: block.preview.map((para) => flatText(para)) }
  })
}

function project(doc: Doc): unknown {
  return {
    body: projectBlocks(doc, doc.body),
    stories: [...doc.stories].map(([key, blocks]) => [String(key), projectBlocks(doc, blocks)]),
  }
}

test('toDoc then toWireBlock is the import block for every fixture block', () => {
  for (const name of FIXTURES) {
    const raw = golden(name)
    assert.ok(isRecord(raw), name)
    const built = toDoc(parseImported(raw))
    const body = raw.body
    assert.ok(Array.isArray(body), `${name} body`)
    assert.equal(built.doc.body.length, body.length, `${name} body length`)
    built.doc.body.forEach((block, index) => same(toWireBlock(block), body[index], `${name} body[${index}]`))
    const stories = raw.stories
    assert.ok(Array.isArray(stories), `${name} stories`)
    assert.equal(built.doc.stories.size, stories.length, `${name} story count`)
    let index = 0
    for (const [key, blocks] of built.doc.stories) {
      const pair: unknown = stories[index]
      assert.ok(Array.isArray(pair), `${name} story ${index}`)
      assert.equal(String(key), pair[0], `${name} story ${index} key`)
      const rawBlocks = pair[1]
      assert.ok(Array.isArray(rawBlocks), `${name} story ${index} blocks`)
      assert.equal(blocks.length, rawBlocks.length, `${name} story ${index} length`)
      blocks.forEach((block, blockIndex) => {
        same(toWireBlock(block), rawBlocks[blockIndex], `${name} ${String(key)}[${blockIndex}]`)
      })
      index += 1
    }
  }
})

test('an untouched document is all keep, and a copied block is not', () => {
  const opened = engine.open(fixture('basic.docx'))
  try {
    const patch = documentPatch(opened.source, opened.doc)
    assert.ok(patch.body.every(isKeep), 'every imported block is kept by identity')
    assert.deepEqual(patch.newLists, [])
    assert.deepEqual(patch.addedStyles, [])
    const first = opened.doc.body[0]
    assert.ok(first, 'body')
    const copy = { ...first }
    const edited = { ...opened.doc, body: [copy, ...opened.doc.body.slice(1)] }
    const changed = documentPatch(opened.source, edited)
    assert.equal(isKeep(changed.body[0] as PatchBlock), false, 'a new object is not keep, even with the same fields')
    assert.ok(changed.body.slice(1).every((block) => isKeep(block)), 'the other blocks are still the imported objects')
  } finally {
    opened.source.free()
  }
})

test('one edited paragraph is the only block that is not keep', () => {
  const opened = engine.open(fixture('basic.docx'))
  try {
    const first = paraByText(opened.doc, 'Quarterly report')
    let state = caret(initialState(opened.doc), first, 0)
    state = run(state, insertText('X'))
    const patch = documentPatch(opened.source, state.doc)
    const changed = patch.body.filter((block) => !isKeep(block))
    assert.equal(changed.length, 1)
    const block = changed[0]
    assert.ok(block && 'kind' in block && block.kind === 'p')
    assert.equal(block.src, first.src)
    assert.ok(patch.body.slice(1).every((item) => isKeep(item)))
  } finally {
    opened.source.free()
  }
})

test('a split keeps the paragraph src on both halves, and a join keeps the side mergeSide picks', () => {
  const opened = engine.open(fixture('basic.docx'))
  try {
    const first = paraByText(opened.doc, 'Quarterly report')
    let state = caret(initialState(opened.doc), first, 4)
    state = run(state, splitParagraph)
    const split = documentPatch(opened.source, state.doc)
    assert.equal(split.body.length, opened.doc.body.length + 1)
    const left = split.body[0]
    const right = split.body[1]
    assert.ok(left && 'kind' in left && left.kind === 'p' && left.src === first.src)
    assert.ok(right && 'kind' in right && right.kind === 'p' && right.src === first.src)
    assert.ok(split.body.slice(2).every((block) => isKeep(block)))

    const second = paraByText(opened.doc, 'Overview')
    let joined = caret(initialState(opened.doc), second, 0)
    joined = run(joined, deleteBackward('char'))
    const patch = documentPatch(opened.source, joined.doc)
    assert.equal(patch.body.length, opened.doc.body.length - 1)
    const merged = patch.body[0]
    assert.ok(merged && 'kind' in merged && merged.kind === 'p')
    assert.equal(merged.src, first.src, 'backspace at the next paragraph starts at the end of the first')
    assert.ok(patch.body.slice(1).every((block) => isKeep(block)))
  } finally {
    opened.source.free()
  }
})

test('a fresh list is newLists and a missing built-in role is addedStyles', () => {
  const opened = engine.open(fixture('basic.docx'))
  try {
    const plain = paraByText(opened.doc, 'Plain, bold, italic, underlined, struck, red, large, highlighted, Arial.')
    let state = caret(initialState(opened.doc), plain, 0)
    state = run(state, toggleList('bullet'))
    const listed = documentPatch(opened.source, state.doc)
    assert.equal(listed.newLists.length, 1)
    const fresh = listed.newLists[0]
    assert.ok(fresh && fresh[0] < 0, 'toggleList mints a negative id')
    assert.equal(fresh[1].fresh, true)
    assert.equal(fresh[1].levels[0]?.format, 'bullet')
    const changed = listed.body.filter((block) => !isKeep(block))
    assert.equal(changed.length, 1)
    assert.ok(changed[0] && 'kind' in changed[0] && changed[0].kind === 'p')
    assert.deepEqual(changed[0].props.numbering?.[0], fresh[0])

    state = run(state, setParaStyle('heading1' as StyleId))
    const styled = documentPatch(opened.source, state.doc)
    assert.deepEqual(styled.addedStyles, ['heading1'])
    assert.deepEqual([...state.doc.styles.added], ['heading1'])
    const existing = run(initialState(opened.doc), setParaStyle('Heading1' as StyleId))
    assert.ok(opened.source.save(existing.doc).byteLength > 0, 'an existing style id saves')
    assert.ok(opened.source.save(state.doc).byteLength > 0, 'a missing built-in role saves')
  } finally {
    opened.source.free()
  }
})

test('a page setup change is refused and nothing is written', () => {
  const opened = engine.open(fixture('basic.docx'))
  try {
    const section = opened.doc.sections[0]
    assert.ok(section)
    const page = { ...section.page, widthPt: section.page.widthPt }
    const widened = { ...page, widthPt: (Number(page.widthPt) + 36) as typeof page.widthPt }
    const state = run(initialState(opened.doc), setPageSetup(0, widened))
    assert.notEqual(state.doc.sections, opened.doc.sections)
    assert.throws(() => opened.source.save(state.doc), (error: unknown) => {
      assert.ok(error instanceof SaveWriteError)
      assert.match(error.detail, /page setup/)
      return true
    })
  } finally {
    opened.source.free()
  }
})

test('save of an untouched fixture reopens to the same text and marks', () => {
  for (const name of FIXTURES) {
    const opened = engine.open(fixture(name))
    try {
      const before = project(opened.doc)
      const started = performance.now()
      const bytes = opened.source.save(opened.doc)
      const ms = performance.now() - started
      if (name === 'long.docx') {
        console.log(`long.docx save ${ms.toFixed(1)} ms`)
        assert.ok(ms < 1000, `long.docx save took ${ms.toFixed(1)} ms`)
      }
      const again = engine.open(bytes)
      try {
        same(project(again.doc), before, name)
      } finally {
        again.source.free()
      }
    } finally {
      opened.source.free()
    }
  }
})

test('save writes an edit, a bold run and a fresh list', () => {
  const opened = engine.open(fixture('basic.docx'))
  let again: Opened | undefined
  try {
    const first = paraByText(opened.doc, 'Quarterly report')
    let state = caret(initialState(opened.doc), first, 0)
    state = run(state, insertText('Hello 你好'))
    const edited = paraByText(state.doc, 'Hello 你好Quarterly report')
    state = caret(state, edited, 0)
    state = run(state, setSelection({
      kind: 'text',
      anchor: { p: edited.id, o: 0 },
      head: { p: edited.id, o: 5 },
    }))
    state = run(state, toggleMark('bold'))
    const plain = paraByText(state.doc, 'Plain, bold, italic, underlined, struck, red, large, highlighted, Arial.')
    state = caret(state, plain, 0)
    state = run(state, toggleList('bullet'))
    const before = project(state.doc)
    const bytes = opened.source.save(state.doc)
    again = engine.open(bytes)
    const after = project(again.doc)
    same(after, before, 'edited')
  } finally {
    again?.source.free()
    opened.source.free()
  }
})

// A write refusal is accepted only when its detail is one of the contracts the
// save design leaves unread: tables, images, page setup, hyperlinks, breaks,
// fields and other unmodeled children. A defect such as a bad split point is not.
const OUT_OF_SCOPE = [
  'inserted tables',
  'row and column changes',
  'inserted images',
  'page setup',
  'hyperlink',
  'section break',
  'unmodeled content',
  'field',
  'page break',
  'column break',
  'opaque atom',
  'non-removable',
  'locked paragraph',
  'content control',
  'tracked revision',
  'ruby',
]

const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34]
const STEPS = 40
const SAMPLES = ['Hello', 'Report', 'A', 'word', '你好', '文字', '甲', 'Hello 你好']
const FONTS: readonly (string | undefined)[] = ['Arial', 'Calibri', '宋体', undefined]
const SIZES: readonly (number | undefined)[] = [12, 16, 22, undefined]
const STYLES = ['Normal', 'Heading1', 'Heading2', 'Title', 'heading1', 'heading2'] as const
const ALIGNS = ['left', 'center', 'right', 'justify'] as const
const MARKS = ['bold', 'italic', 'underline', 'strike'] as const
const UNITS = ['char', 'word'] as const
const GRAINS = ['char', 'word', 'paragraph', 'document'] as const

/** mulberry32. Written here so the sequence does not depend on another module. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  if (items.length === 0) throw new Error('empty choice')
  return items[Math.floor(rng() * items.length)] as T
}

function editable(doc: Doc): Paragraph[] {
  const index = indexOf(doc)
  const paragraphs: Paragraph[] = []
  for (const id of index.ordered) {
    const located = index.get(id)
    if (located.story !== 'body') break
    if (located.para.lock) continue
    paragraphs.push(located.para)
  }
  return paragraphs
}

interface Fact {
  text: string
  marks: { text: string; marks: string }[]
  style: string | null
  align: string | null
  list: string
}

function paragraphFacts(doc: Doc): Fact[] {
  const index = indexOf(doc)
  return index.ordered.map((id) => {
    const para = index.get(id).para
    return {
      text: flatText(para),
      marks: mergedMarks(para),
      style: para.props.style ?? null,
      align: para.props.align ?? null,
      list: listKind(doc, para),
    }
  })
}

function mergedMarks(para: Paragraph): { text: string; marks: string }[] {
  const segments: { text: string; marks: string }[] = []
  for (const inline of para.inlines) {
    if (inline.kind !== 'text' || inline.text === '') continue
    const marks = JSON.stringify(sortedMarks(inline.marks))
    const last = segments[segments.length - 1]
    if (last && last.marks === marks) last.text += inline.text
    else segments.push({ text: inline.text, marks })
  }
  return segments
}

/** Direct numbering wins. An untouched paragraph inherits the style's list. */
function listKind(doc: Doc, para: Paragraph): string {
  const direct = para.props.numbering
  const numbering =
    direct === undefined
      ? (para.props.style ? doc.styles.paragraph.get(para.props.style)?.look.numbering ?? null : null)
      : direct
  if (!numbering) return 'none'
  return doc.lists.byNum.get(numbering.num)?.levels[numbering.level]?.format ?? 'missing'
}

function isOutOfScope(detail: string): boolean {
  const text = detail.toLowerCase()
  return OUT_OF_SCOPE.some((item) => text.includes(item))
}

function step(state: EditorState, rng: () => number, now: number): { label: string; next: EditorState } {
  const kind = Math.floor(rng() * 14)
  if (kind === 0) {
    const text = pick(rng, SAMPLES)
    return command(state, `insertText ${JSON.stringify(text)}`, insertText(text), now)
  }
  if (kind === 1) return command(state, 'enter', splitParagraph, now)
  if (kind === 2) {
    const unit = pick(rng, UNITS)
    return command(state, `deleteBackward ${unit}`, deleteBackward(unit), now)
  }
  if (kind === 3) {
    const unit = pick(rng, UNITS)
    return command(state, `deleteForward ${unit}`, deleteForward(unit), now)
  }
  if (kind === 4) {
    const direction = rng() < 0.5 ? 'backward' : 'forward'
    const grain = pick(rng, GRAINS)
    const extend = rng() < 0.4
    return command(state, `move ${direction} ${grain}${extend ? ' extend' : ''}`, move(direction, grain, extend), now)
  }
  if (kind === 5) return command(state, 'setSelection', selection(state, rng), now)
  if (kind === 6) {
    const mark = pick(rng, MARKS)
    return command(state, `toggleMark ${mark}`, toggleMark(mark), now)
  }
  if (kind === 7) {
    const font = pick(rng, FONTS)
    return command(state, `setMark font ${font ?? 'clear'}`, setMark({ mark: 'font', value: font }), now)
  }
  if (kind === 8) {
    const size = pick(rng, SIZES)
    const value = size === undefined ? undefined : size as Pt
    return command(state, `setMark size ${size ?? 'clear'}`, setMark({ mark: 'sizePt', value }), now)
  }
  if (kind === 9) {
    const style = pick(rng, STYLES) as StyleId
    return command(state, `setParaStyle ${style}`, setParaStyle(style), now)
  }
  if (kind === 10) {
    const align = pick(rng, ALIGNS)
    return command(state, `setAlign ${align}`, setAlign(align), now)
  }
  if (kind === 11) {
    const list = rng() < 0.5 ? 'bullet' : 'decimal'
    return command(state, `toggleList ${list}`, toggleList(list), now)
  }
  if (kind === 12) {
    const next = undo(state)
    return { label: next ? 'undo' : 'undo (noop)', next: next ?? state }
  }
  const next = redo(state)
  return { label: next ? 'redo' : 'redo (noop)', next: next ?? state }
}

function command(state: EditorState, label: string, action: Command, now: number): { label: string; next: EditorState } {
  const transaction = action(state)
  if (!transaction) return { label: `${label} (noop)`, next: state }
  return { label, next: apply(state, transaction, now) }
}

function selection(state: EditorState, rng: () => number): Command {
  const paragraphs = editable(state.doc)
  if (paragraphs.length === 0) return () => null
  const anchor = pick(rng, paragraphs)
  const head = rng() < 0.5 ? anchor : pick(rng, paragraphs)
  return setSelection({
    kind: 'text',
    anchor: { p: anchor.id, o: Math.floor(rng() * (flatText(anchor).length + 1)) },
    head: { p: head.id, o: Math.floor(rng() * (flatText(head).length + 1)) },
  })
}

function sameFacts(want: readonly Fact[], got: readonly Fact[], where: string): void {
  assert.equal(got.length, want.length, `${where} paragraph count`)
  for (let index = 0; index < want.length; index += 1) {
    const expected = want[index]
    const actual = got[index]
    assert.equal(actual?.text, expected?.text, `${where} paragraph ${index} text`)
    assert.deepEqual(actual?.marks, expected?.marks, `${where} paragraph ${index} marks`)
    assert.equal(actual?.style, expected?.style, `${where} paragraph ${index} style`)
    assert.equal(actual?.align, expected?.align, `${where} paragraph ${index} align`)
    assert.equal(actual?.list, expected?.list, `${where} paragraph ${index} list`)
  }
}

test('random edits save and reopen to the same text, marks, style, alignment and list', () => {
  const started = performance.now()
  let refusals = 0
  let runs = 0
  for (const name of FIXTURES) {
    for (const seed of SEEDS) {
      runs += 1
      const opened = engine.open(fixture(name))
      const commands: string[] = []
      try {
        let state = initialState(opened.doc)
        const rng = mulberry32(seed)
        for (let index = 0; index < STEPS; index += 1) {
          const taken = step(state, rng, index * 2000)
          commands.push(taken.label)
          state = taken.next
        }
        try {
          const bytes = opened.source.save(state.doc)
          const again = engine.open(bytes)
          try {
            sameFacts(paragraphFacts(state.doc), paragraphFacts(again.doc), `${name} seed ${seed}`)
          } finally {
            again.source.free()
          }
        } catch (error) {
          if (error instanceof SaveWriteError && isOutOfScope(error.detail)) {
            refusals += 1
            continue
          }
          const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
          throw new Error(`${name} seed ${seed}\n${commands.join('\n')}\n${detail}`)
        }
      } finally {
        opened.source.free()
      }
    }
  }
  const elapsed = performance.now() - started
  console.log(`save property: ${runs} runs, ${refusals} refusals, ${elapsed.toFixed(0)} ms, seeds ${SEEDS.join(',')}`)
  assert.ok(elapsed < 60_000, `the property test took ${elapsed.toFixed(0)} ms`)
  assert.ok(refusals * 10 <= runs, `${refusals} refusals of ${runs} runs`)
})

test('save_tampered fails verification and a blank document saves', () => {
  const opened = engine.open(fixture('basic.docx'))
  try {
    assert.throws(() => saveTampered(opened.source, opened.doc), (error: unknown) => {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      assert.ok(error instanceof SaveVerifyError, message)
      assert.ok(error.firstDifference.length > 0)
      return true
    })
  } finally {
    opened.source.free()
  }
  const blank = engine.blank()
  let again: Opened | undefined
  try {
    const doc = withCaretParagraph(blank.doc)
    const bytes = blank.source.save(doc)
    again = engine.open(bytes)
    same(project(again.doc), project(doc), 'blank')
  } finally {
    again?.source.free()
    blank.source.free()
  }
})
