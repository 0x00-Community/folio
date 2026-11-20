import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PageSetup, Pt } from '../model.ts'
import { formatMargin, matchPaper, readMargins, sizeForPaper } from './page-setup.ts'

function pt(value: number): Pt {
  return value as Pt
}

function page(width: number, height: number, margins: Partial<PageSetup['margin']> = {}): PageSetup {
  return {
    widthPt: pt(width),
    heightPt: pt(height),
    margin: {
      top: pt(margins.top ?? 72),
      right: pt(margins.right ?? 72),
      bottom: pt(margins.bottom ?? 72),
      left: pt(margins.left ?? 72),
      header: pt(margins.header ?? 36),
      footer: pt(margins.footer ?? 36),
      gutter: pt(margins.gutter ?? 0),
    },
  }
}

const letter = page(12240 / 20, 15840 / 20)

test('paper match accepts either orientation within half a point', () => {
  assert.deepEqual(matchPaper(letter), { key: 'Letter', landscape: false })
  assert.deepEqual(matchPaper(page(15840 / 20, 12240 / 20)), { key: 'Letter', landscape: true })
  assert.deepEqual(matchPaper(page(612.5, 792.5)), { key: 'Letter', landscape: false })
  assert.equal(matchPaper(page(612.51, 792)).key, 'custom')
  assert.deepEqual(matchPaper(page(11906 / 20, 16838 / 20)), { key: 'A4', landscape: false })
  assert.deepEqual(matchPaper(page(16838 / 20, 11906 / 20)), { key: 'A4', landscape: true })
  assert.deepEqual(matchPaper(page(100, 200)), { key: 'custom', landscape: false })
  assert.deepEqual(matchPaper(page(200, 100)), { key: 'custom', landscape: true })
})

test('a named paper follows the orientation', () => {
  const landscape = sizeForPaper('A4', true, letter)
  assert.ok(landscape.widthPt > landscape.heightPt)
  assert.equal(landscape.widthPt, 16838 / 20)
  assert.equal(landscape.heightPt, 11906 / 20)
  const portrait = sizeForPaper('custom', false, landscape)
  assert.equal(portrait.widthPt, 11906 / 20)
  assert.equal(portrait.heightPt, 16838 / 20)
})

test('margins convert at the dialog edge and round to a twip', () => {
  assert.equal(formatMargin(144, 'in'), '2')
  assert.equal(formatMargin(144, 'cm'), '5.08')
  assert.equal(formatMargin(72, 'in'), '1')
  assert.equal(formatMargin(72, 'cm'), '2.54')
  const inches = readMargins(letter, { top: '2', right: '2', bottom: '2', left: '2' }, letter, 'in')
  assert.deepEqual(inches.invalid, [])
  assert.equal(inches.page?.margin.top, 144)
  assert.equal(inches.page?.margin.header, 36)
  const cm = readMargins(letter, { top: '5.08', right: '5.08', bottom: '5.08', left: '5.08' }, letter, 'cm')
  assert.equal(cm.page?.margin.left, 144)
  const kept = page(612, 792, { top: pt(72.01) })
  const same = readMargins(kept, {
    top: formatMargin(72.01, 'in'),
    right: '1',
    bottom: '1',
    left: '1',
  }, kept, 'in')
  assert.equal(same.page, null)
})

test('a margin that leaves no text area, or a non-number, is rejected', () => {
  const wide = readMargins(letter, { top: '1', right: '5', bottom: '1', left: '5' }, letter, 'in')
  assert.ok(wide.invalid.includes('left') && wide.invalid.includes('right'))
  assert.equal(wide.page, null)
  const a5 = sizeForPaper('A5', false, letter)
  const tight = readMargins(a5, { top: '1', right: '4', bottom: '1', left: '4' }, letter, 'in')
  assert.ok(tight.invalid.includes('left'))
  const empty = readMargins(letter, { top: '', right: '1', bottom: '1', left: '1' }, letter, 'in')
  assert.deepEqual(empty.invalid, ['top'])
  const bad = readMargins(letter, { top: '1', right: 'abc', bottom: '1', left: '1' }, letter, 'in')
  assert.ok(bad.invalid.includes('right'))
  const negative = readMargins(letter, { top: '-0.5', right: '1', bottom: '1', left: '1' }, letter, 'in')
  assert.deepEqual(negative.invalid, [])
  assert.equal(negative.page?.margin.top, -36)
})
