import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ListLevel, RunLook, Section } from '../model.ts'
import { checkDoc } from '../model.ts'
import type { FontMetrics as FaceMetrics } from '../fonts.ts'
import { initialState, toolbarState, wordCount } from './edit.ts'
import {
  cssGeneric,
  documentGridPitch,
  lineHeightPx,
  listMarkers,
  withCaretParagraph,
} from './derive.ts'
import {
  cell,
  makeDoc,
  NORMAL,
  numId,
  paragraph,
  paraLook,
  pt,
  row,
  section,
  storyKey,
  styleId,
  stylesheet,
  table,
  text,
} from './testkit.ts'

function lvl(format: ListLevel['format'], template: string, start = 1): ListLevel {
  return { format, text: template, start, indentLeft: pt(36), hanging: pt(18) }
}

function lists(entries: readonly (readonly [number, readonly ListLevel[]])[]) {
  return {
    byNum: new Map(entries.map(([id, levels]) => [numId(id), { fresh: false, levels }] as const)),
  }
}

function numbered(id: string, level: number, num = 1) {
  return paragraph(id, [text(id)], { numbering: { num: numId(num), level } })
}

function face(over: Partial<FaceMetrics> = {}): FaceMetrics {
  return {
    unitsPerEm: 1000,
    ascender: 800,
    descender: -200,
    lineGap: 200,
    winAscent: 800,
    winDescent: 200,
    typoAscender: 800,
    typoDescender: -200,
    typoLineGap: 200,
    hheaAscender: 800,
    hheaDescender: -200,
    hheaLineGap: 200,
    ...over,
  }
}

const runLook = {
  fonts: { ascii: 'Calibri', hAnsi: 'Calibri', eastAsia: '宋体', cs: 'Calibri' },
  sizePt: pt(12),
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  color: 'auto',
  caps: false,
  charSpacingPt: pt(0),
} satisfies RunLook

test('list markers count in document order, restart deeper levels, and keep each list separate', () => {
  const levels = [lvl('decimal', '%1.'), lvl('lowerLetter', '%1.%2'), lvl('decimal', '%1.%2.%3')]
  const a = numbered('a', 0)
  const b = numbered('b', 1)
  const c = numbered('c', 1)
  const plain = paragraph('d', [text('plain')])
  const e = numbered('e', 0)
  const f = numbered('f', 1)
  const other = numbered('i', 0, 2)
  const again = numbered('j', 0, 2)
  const doc = makeDoc([a, b, c, plain, e, f, other, again], {
    lists: lists([
      [1, levels],
      [2, [lvl('decimal', '%1.')]],
    ]),
  })
  const markers = listMarkers(doc)
  assert.equal(listMarkers(doc), markers, 'markers are cached on the document object')
  assert.equal(markers.get(a.id), '1.', 'the first item uses the level start')
  assert.equal(markers.get(b.id), '1.a', 'a child substitutes its own format into the parent number')
  assert.equal(markers.get(c.id), '1.b', 'the next child increments')
  assert.equal(markers.get(plain.id), undefined, 'a paragraph outside the list has no marker')
  assert.equal(markers.get(e.id), '2.', 'a plain paragraph does not restart the list')
  assert.equal(markers.get(f.id), '2.a', 'returning to a deeper level restarts it')
  assert.equal(markers.get(other.id), '1.', 'a second numId counts on its own')
  assert.equal(markers.get(again.id), '2.', 'the second list increments independently')
})

test('list markers format numbers, inherit a style, and number each story alone', () => {
  const one = (format: ListLevel['format'], start: number, template = '%1') => {
    const para = numbered('a', 0)
    const doc = makeDoc([para], { lists: lists([[1, [lvl(format, template, start)]]]) })
    return listMarkers(doc).get(para.id)
  }
  assert.equal(one('decimal', 5), '5', 'a level start above 1 is the first value')
  assert.equal(one('decimal', 5, 'Item %1 (100%%)'), 'Item 5 (100%)', '%% is a literal percent')
  assert.equal(one('lowerLetter', 1), 'a')
  assert.equal(one('lowerLetter', 26), 'z')
  assert.equal(one('lowerLetter', 27), 'aa', 'the 27th letter repeats a, it does not become ab')
  assert.equal(one('lowerLetter', 52), 'zz')
  assert.equal(one('lowerLetter', 53), 'aaa')
  assert.equal(one('upperLetter', 27), 'AA')
  assert.equal(one('lowerRoman', 4), 'iv')
  assert.equal(one('lowerRoman', 9), 'ix')
  assert.equal(one('lowerRoman', 14), 'xiv')
  assert.equal(one('upperRoman', 40), 'XL')
  assert.equal(one('chineseCounting', 1), '一')
  assert.equal(one('chineseCounting', 10), '十')
  assert.equal(one('chineseCounting', 11), '十一')
  assert.equal(one('chineseCounting', 20), '二十')
  assert.equal(one('chineseCounting', 21), '二十一')
  assert.equal(one('chineseCounting', 101), '一百零一')
  assert.equal(one('chineseCounting', 110), '一百一十')
  assert.equal(one('chineseCounting', 1001), '一千零一')
  assert.equal(one('chineseCounting', 10000), '一万')
  assert.equal(one('chineseCounting', 10001), '一万零一')
  assert.equal(one('chineseCounting', 10010), '一万零一十')
  assert.equal(one('ideographTraditional', 1), '甲')
  assert.equal(one('ideographTraditional', 10), '癸')
  assert.equal(one('ideographTraditional', 11), '甲甲')
  assert.equal(one('ideographTraditional', 12), '乙乙')
  assert.equal(one('decimalEnclosedCircle', 1), '\u2460')
  assert.equal(one('decimalEnclosedCircle', 20), '\u2473')
  assert.equal(one('decimalEnclosedCircle', 21), '\u3251')
  assert.equal(one('decimalEnclosedCircle', 35), '\u325f')
  assert.equal(one('decimalEnclosedCircle', 36), '\u32b1')
  assert.equal(one('decimalEnclosedCircle', 50), '\u32bf')
  assert.equal(one('decimalEnclosedCircle', 51), '51', 'circled numbers past 50 fall back to decimal')
  const top = numbered('top', 0)
  const jump = numbered('jump', 2)
  const mid = numbered('mid', 1)
  const jumped = makeDoc([top, jump, mid], {
    lists: lists([[1, [lvl('decimal', '%1'), lvl('decimal', '%1.%2'), lvl('decimal', '%1.%2.%3')]]]),
  })
  const jumpedMarkers = listMarkers(jumped)
  assert.equal(jumpedMarkers.get(top.id), '1')
  assert.equal(jumpedMarkers.get(jump.id), '1.1.1', 'a skipped level displays its start without being consumed')
  assert.equal(jumpedMarkers.get(mid.id), '1.1', 'the skipped level still starts at 1 when it is first used')

  assert.equal(one('bullet', 1, '•'), '•')
  assert.equal(one('bullet', 1, ''), '•', 'an empty bullet level still marks the paragraph')
  assert.equal(one('none', 1, ''), undefined)

  const bullet = numbered('b', 0)
  const nested = numbered('n', 1)
  const bullets = makeDoc([bullet, nested], {
    lists: lists([[1, [lvl('bullet', '•'), lvl('bullet', '◦')]]]),
  })
  const bulletMarkers = listMarkers(bullets)
  assert.equal(bulletMarkers.get(bullet.id), '•')
  assert.equal(bulletMarkers.get(nested.id), '◦')

  const styles = stylesheet()
  const paragraphStyles = new Map(styles.paragraph)
  paragraphStyles.set(styleId('List'), {
    name: 'List',
    role: null,
    next: NORMAL,
    look: paraLook({ num: numId(1), level: 0 }),
  })
  const inherited = paragraph('s', [text('styled')], { style: styleId('List') })
  const cleared = paragraph('c', [text('cleared')], { style: styleId('List'), numbering: null })
  const styled = makeDoc([inherited, cleared], {
    styles: { ...styles, paragraph: paragraphStyles },
    lists: lists([[1, [lvl('decimal', '%1.')]]]),
  })
  assert.equal(listMarkers(styled).get(inherited.id), '1.', 'numbering on the paragraph style is a list')
  assert.equal(listMarkers(styled).get(cleared.id), undefined, 'explicit numbering null overrides the style')

  const body = numbered('body', 0)
  const inside = numbered('cell', 0)
  const after = numbered('after', 0)
  const headed = numbered('head', 0)
  const withTable = makeDoc(
    [body, table('t', [row([cell([inside])])]), after],
    {
      lists: lists([[1, [lvl('decimal', '%1.')]]]),
      stories: new Map([[storyKey('s0/header/default'), [headed]]]),
    },
  )
  const flowed = listMarkers(withTable)
  assert.equal(flowed.get(body.id), '1.')
  assert.equal(flowed.get(inside.id), '2.', 'a cell continues the body list')
  assert.equal(flowed.get(after.id), '3.')
  assert.equal(flowed.get(headed.id), '1.', 'a header story starts its own count')

  const missing = paragraph('m', [text('m')], { numbering: { num: numId(9), level: 3 } })
  assert.equal(listMarkers(makeDoc([missing], { lists: lists([[9, [lvl('decimal', '%1.')]]]) })).get(missing.id), undefined, 'a level the definition does not have has no marker')
})

function near(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual}`)
}

test('lineHeightPx uses the honored font box and falls back when the face is missing', () => {
  const metrics = face()
  const size = pt(10)
  near(lineHeightPx(metrics, size, { rule: 'auto', multiple: 1 }), 16, '1200/1000 of 10pt is 16px')
  near(lineHeightPx(metrics, size, { rule: 'auto', multiple: 1.5 }), 24, 'the multiple scales the single box')
  assert.equal(lineHeightPx(metrics, size, { rule: 'exact', pt: pt(20) }), 20 * (4 / 3), 'exact spacing ignores the font box')
  assert.equal(lineHeightPx(metrics, size, { rule: 'atLeast', pt: pt(20) }), 20 * (4 / 3), 'atLeast grows to the requested size')
  near(lineHeightPx(metrics, size, { rule: 'atLeast', pt: pt(10) }), 16, 'atLeast keeps the font box when it is taller')
  const fallback = 12 * (4 / 3) * 1.3 * 2
  assert.equal(lineHeightPx(undefined, pt(12), { rule: 'auto', multiple: 2 }), fallback, 'a missing face uses 1.3 em')
  assert.equal(lineHeightPx(face({ unitsPerEm: 0 }), pt(12), { rule: 'auto', multiple: 1 }), 12 * (4 / 3) * 1.3)
  assert.equal(
    lineHeightPx(face({ ascender: 0, descender: 0, lineGap: 0 }), pt(12), { rule: 'auto', multiple: 1 }),
    12 * (4 / 3) * 1.3,
    'a zero line box falls back',
  )
})

test('document grid pitch is one value, and mixed sections do not snap', () => {
  const pitch = (value: number | null): Section => {
    const base = section()
    if (value === null) return base
    return { ...base, grid: { type: 'lines', linePitch: pt(value) } }
  }
  assert.equal(documentGridPitch(makeDoc([paragraph('a', [text('a')])])), null)
  assert.equal(documentGridPitch(makeDoc([], { sections: [pitch(15.6)] })), 15.6 * (4 / 3))
  assert.equal(documentGridPitch(makeDoc([], { sections: [pitch(15.6), pitch(15.6)] })), 15.6 * (4 / 3))
  assert.equal(documentGridPitch(makeDoc([], { sections: [pitch(15.6), pitch(18)] })), null, 'disagreeing sections do not snap')
  assert.equal(documentGridPitch(makeDoc([], { sections: [pitch(15.6), pitch(null)] })), null)
})

test('an empty body gains one paragraph so the caret has a home', () => {
  const filled = makeDoc([paragraph('a', [text('a')])])
  assert.equal(withCaretParagraph(filled), filled, 'a document that already has a paragraph is unchanged')
  const next = withCaretParagraph(makeDoc([]))
  assert.equal(next.body.length, 1)
  const para = next.body[0]
  assert.equal(para?.kind, 'p')
  if (para?.kind === 'p') assert.equal(para.props.style, next.styles.defaultParagraph)
  checkDoc(next)
  const state = initialState(next)
  assert.equal(state.sel.kind, 'text')
  assert.equal(wordCount(next), 0, 'the supplied paragraph is empty')
})

test('toolbarState and wordCount stay pure functions of the document', () => {
  const para = paragraph('p', [text('你好')])
  const doc = makeDoc([para])
  assert.equal(wordCount(doc), 2, 'each CJK character counts once')
  const bar = toolbarState(initialState(doc), () => runLook)
  assert.equal(bar.bold, false, 'the look supplies bold when the run has no direct mark')
  assert.equal(bar.canUndo, false)
  assert.equal(bar.canRedo, false)
  assert.equal(bar.style, NORMAL, 'a paragraph with no direct style shows the default')
  assert.equal(bar.font, '宋体')
})
