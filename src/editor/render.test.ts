import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pt, RunLook } from '../model.ts'
import { flatText, pageBoxStyle, scriptSegments } from './render.ts'
import type { Paragraph, Section } from '../model.ts'

const look = {
  fonts: { ascii: 'Times', hAnsi: 'TimesHigh', eastAsia: 'SimSun', cs: 'Naskh' },
  sizePt: 10.5 as Pt,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  color: 'auto',
  caps: false,
  charSpacingPt: 0 as Pt,
} satisfies RunLook

test('scriptSegments gives CJK the east Asia font and Latin the ASCII font', () => {
  const segments = scriptSegments('Hello世界', look)
  assert.deepEqual(segments, [
    { text: 'Hello', family: 'Times' },
    { text: '世界', family: 'SimSun' },
  ])
})

test('scriptSegments keeps fullwidth forms on the east Asia font and high ANSI on hAnsi', () => {
  const segments = scriptSegments('A１é', look)
  assert.equal(segments.map((segment) => segment.text).join(''), 'A１é')
  assert.equal(segments[0]?.family, 'Times')
  assert.equal(segments[1]?.family, 'SimSun')
  assert.equal(segments[2]?.family, 'TimesHigh')
})

test('flatText counts an atom as one object-replacement character', () => {
  const para = {
    kind: 'p',
    id: 'p' as Paragraph['id'],
    src: null,
    props: {},
    inlines: [
      { kind: 'text', text: 'ab', marks: {}, src: null },
      { kind: 'atom', atom: { type: 'pageBreak' }, src: null },
      { kind: 'text', text: 'c', marks: {}, src: null },
    ],
    lock: null,
    sectionEnd: null,
  } satisfies Paragraph
  assert.equal(flatText(para), 'ab\uFFFCc')
})

test('pageBoxStyle converts points to px at 4/3', () => {
  const section = {
    src: null,
    page: {
      widthPt: 75 as Pt,
      heightPt: 150 as Pt,
      margin: {
        top: 15 as Pt,
        right: 7.5 as Pt,
        bottom: 15 as Pt,
        left: 7.5 as Pt,
        header: 0 as Pt,
        footer: 0 as Pt,
        gutter: 0 as Pt,
      },
    },
    breakType: 'nextPage',
    titlePage: false,
    headers: {},
    footers: {},
    grid: null,
  } satisfies Section
  const box = pageBoxStyle(section)
  assert.equal(box.page.width, '100px')
  assert.equal(box.page.height, '200px')
  assert.equal(box.content.left, '10px')
  assert.equal(box.content.top, '20px')
})
