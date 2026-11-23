import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LineSpacing, PageSetup, ParaLook, Pt } from '../model.ts'
import { paraLook, pt } from '../editor/testkit.ts'
import { indentMax, paragraphSnapshot, readParagraph, snapshotTexts } from './paragraph.ts'
import type { ParaSnapshot, ParaTexts } from './paragraph.ts'

function page(width: number): PageSetup {
  return {
    widthPt: pt(width),
    heightPt: pt(792),
    margin: {
      top: pt(72),
      right: pt(72),
      bottom: pt(72),
      left: pt(72),
      header: pt(36),
      footer: pt(36),
      gutter: pt(0),
    },
  }
}

function blankTexts(over: Partial<ParaTexts> = {}): ParaTexts {
  return {
    align: '',
    left: '',
    right: '',
    special: '',
    by: '',
    byChars: false,
    before: '',
    after: '',
    lineRule: '',
    lineValue: '',
    ...over,
  }
}

function emptySnap(over: Partial<ParaSnapshot> = {}): ParaSnapshot {
  return {
    align: null,
    left: null,
    right: null,
    special: null,
    byPt: null,
    byChars: null,
    before: null,
    after: null,
    lineRule: null,
    lineValue: null,
    ...over,
  }
}

test('indent max is the content width minus 72 points', () => {
  assert.equal(indentMax(page(612)), 612 - 72 - 72 - 72)
  assert.equal(indentMax(page(100)), 0)
})

function resolved(over: {
  align?: ParaLook['align']
  left?: number
  right?: number
  first?: number
  hanging?: number
  chars?: number
  before?: number
  after?: number
  line?: LineSpacing
} = {}): ParaLook {
  const base = paraLook()
  return {
    ...base,
    align: over.align ?? base.align,
    indent: {
      left: pt(over.left ?? 0),
      right: pt(over.right ?? 0),
      firstLine: pt(over.first ?? 0),
      hanging: pt(over.hanging ?? 0),
      firstLineChars: over.chars ?? 0,
    },
    spacing: {
      before: pt(over.before ?? 0),
      after: pt(over.after ?? 0),
      line: over.line ?? base.spacing.line,
      contextual: false,
    },
  }
}

test('a style value is shown, and accepting it writes nothing', () => {
  const plain = paragraphSnapshot([resolved({})])
  assert.equal(plain.align, 'left')
  assert.equal(plain.left, 0)
  assert.equal(plain.right, 0)
  assert.equal(plain.special, 'none')
  assert.equal(plain.before, 0)
  assert.equal(plain.after, 0)
  assert.equal(plain.lineRule, 'single')
  assert.equal(plain.lineValue, 1)
  assert.deepEqual(readParagraph(snapshotTexts(plain, 'in'), plain, 'in', 396), { format: null, invalid: [] })

  const fromStyle = paragraphSnapshot([resolved({
    align: 'justify',
    left: 36,
    before: 12,
    after: 6,
    line: { rule: 'auto', multiple: 1.15 },
  })])
  assert.equal(fromStyle.align, 'justify')
  assert.equal(fromStyle.left, 36)
  assert.equal(fromStyle.right, 0)
  assert.equal(fromStyle.special, 'none')
  assert.equal(fromStyle.before, 12)
  assert.equal(fromStyle.after, 6)
  assert.equal(fromStyle.lineRule, 'multiple')
  assert.equal(fromStyle.lineValue, 1.15)
  assert.deepEqual(readParagraph(snapshotTexts(fromStyle, 'cm'), fromStyle, 'cm', 396), { format: null, invalid: [] })
  const edited = readParagraph({ ...snapshotTexts(fromStyle, 'in'), before: '18' }, fromStyle, 'in', 396)
  assert.equal(edited.format?.spacing?.before, 18)
  assert.equal(edited.format?.align, undefined)
  assert.equal(edited.format?.indent, undefined)
  assert.equal(edited.format?.spacing?.after, undefined)
  assert.equal(edited.format?.spacing?.line, undefined)
})

test('a direct value in the resolved look replaces the style value', () => {
  const over = paragraphSnapshot([resolved({
    align: 'center',
    left: 36,
    before: 8,
    chars: 200,
    line: { rule: 'exact', pt: pt(20) },
  })])
  assert.equal(over.align, 'center')
  assert.equal(over.left, 36)
  assert.equal(over.before, 8)
  assert.equal(over.special, 'chars')
  assert.equal(over.byChars, 200)
  assert.equal(over.lineRule, 'exact')
  assert.equal(over.lineValue, 20)
  assert.deepEqual(readParagraph(snapshotTexts(over, 'in'), over, 'in', 396), { format: null, invalid: [] })
})

test('a field is blank only where the touched paragraphs differ', () => {
  const first = resolved({ align: 'justify', left: 36, before: 12, line: { rule: 'auto', multiple: 1.15 } })
  const second = resolved({ align: 'right', left: 36, before: 0, hanging: 18, line: { rule: 'exact', pt: pt(18) } })
  const mixed = paragraphSnapshot([first, second])
  assert.equal(mixed.align, null)
  assert.equal(mixed.before, null)
  assert.equal(mixed.lineRule, null)
  assert.equal(mixed.lineValue, null)
  assert.equal(mixed.special, null)
  assert.equal(mixed.left, 36)
  assert.equal(mixed.right, 0)
  assert.equal(mixed.after, 0)
  assert.deepEqual(readParagraph(snapshotTexts(mixed, 'in'), mixed, 'in', 396), { format: null, invalid: [] })
})

test('distribute is kept on screen and accepting it writes nothing', () => {
  const original = paragraphSnapshot([resolved({ align: 'distribute' })])
  assert.equal(original.align, 'distribute')
  assert.deepEqual(readParagraph(snapshotTexts(original, 'in'), original, 'in', 396), { format: null, invalid: [] })
  const changed = readParagraph(blankTexts({ align: 'left' }), original, 'in', 396)
  assert.equal(changed.format?.align, 'left')
  assert.equal(changed.format?.indent, undefined)
})

test('readParagraph applies only the fields that changed', () => {
  const original = emptySnap({ align: 'left', before: 6, lineRule: 'single', lineValue: 1 })
  const same = readParagraph(blankTexts({ align: 'left', before: '6', lineRule: 'single' }), original, 'in', 396)
  assert.deepEqual(same, { format: null, invalid: [] })
  const changed = readParagraph(blankTexts({
    align: 'justify',
    left: '0.5',
    special: 'first',
    by: '0.3333333333',
    before: '8',
    after: '',
    lineRule: 'exact',
    lineValue: '20',
  }), original, 'in', 396)
  assert.deepEqual(changed.invalid, [])
  assert.equal(changed.format?.align, 'justify')
  assert.equal(changed.format?.indent?.left, 36)
  assert.equal(changed.format?.indent?.firstLine, 24)
  assert.equal(changed.format?.indent?.hanging, null)
  assert.equal(changed.format?.indent?.firstLineChars, null)
  assert.equal(changed.format?.spacing?.before, 8)
  assert.equal(changed.format?.spacing?.after, undefined)
  assert.deepEqual(changed.format?.spacing?.line, { rule: 'exact', pt: 20 as Pt })
})

test('an empty field changes nothing and an out-of-range field disables OK', () => {
  const original = emptySnap({ left: 36, special: 'first', byPt: 24, before: 6 })
  const emptied = readParagraph(blankTexts({ left: '', special: 'first', by: '' }), original, 'in', 396)
  assert.deepEqual(emptied, { format: null, invalid: [] })
  const wide = readParagraph(blankTexts({ left: '20' }), original, 'in', 396)
  assert.deepEqual(wide.invalid, ['left'])
  assert.equal(wide.format, null)
  const space = readParagraph(blankTexts({ before: '1584.1' }), original, 'in', 396)
  assert.deepEqual(space.invalid, ['before'])
  const multiple = readParagraph(blankTexts({ lineRule: 'multiple', lineValue: '0.2' }), original, 'in', 396)
  assert.deepEqual(multiple.invalid, ['lineValue'])
  const exact = readParagraph(blankTexts({ lineRule: 'exact', lineValue: '0.6' }), original, 'in', 396)
  assert.deepEqual(exact.invalid, ['lineValue'])
  const missing = readParagraph(blankTexts({ lineRule: 'atLeast', lineValue: '' }), original, 'in', 396)
  assert.deepEqual(missing.invalid, ['lineValue'])
  const least = readParagraph(blankTexts({ lineRule: 'atLeast', lineValue: '0.7' }), original, 'in', 396)
  assert.deepEqual(least.format?.spacing?.line, { rule: 'atLeast', pt: 0.7 as Pt })
})

test('a character indent stays in characters until the special mode changes', () => {
  const original = emptySnap({ special: 'chars', byChars: 200 })
  const kept = readParagraph(blankTexts({ special: 'first', by: '2', byChars: true }), original, 'cm', 396)
  assert.equal(kept.format, null)
  const edited = readParagraph(blankTexts({ special: 'first', by: '3', byChars: true }), original, 'cm', 396)
  assert.deepEqual(edited.format?.indent, { firstLineChars: 300 })
  const huge = readParagraph(blankTexts({ special: 'first', by: '1000', byChars: true }), original, 'cm', 396)
  assert.deepEqual(huge.invalid, ['by'])
  const cleared = readParagraph(blankTexts({ special: 'none' }), original, 'cm', 396)
  assert.deepEqual(cleared.format?.indent, { firstLine: null, hanging: null, firstLineChars: null })
  const hanging = readParagraph(blankTexts({ special: 'hanging', by: '' }), original, 'cm', 396)
  assert.deepEqual(hanging.invalid, ['by'])
})
