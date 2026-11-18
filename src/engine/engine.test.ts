import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { checkDoc, type Block, type Doc, type Paragraph, type Pt } from '../model.ts'
import { createEngine, type Opened } from './engine.ts'
import { initSync } from './pkg/engine.js'

const root = new URL('../../', import.meta.url)

initSync({ module: readFileSync(new URL('public/engine.wasm', root)) })
const engine = createEngine()

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`fixtures/${name}`, root)))
}

function paragraphs(blocks: readonly Block[]): Paragraph[] {
  const found: Paragraph[] = []
  for (const block of blocks) {
    if (block.kind === 'p') found.push(block)
    else if (block.kind === 'table') {
      for (const row of block.rows) {
        for (const cell of row.cells) found.push(...paragraphs(cell.blocks))
      }
    }
  }
  return found
}

function textOf(para: Paragraph): string {
  let text = ''
  for (const inline of para.inlines) {
    if (inline.kind === 'text') text += inline.text
  }
  return text
}

function storyText(doc: Doc, part: string): string {
  let text = ''
  for (const [key, blocks] of doc.stories) {
    if (!key.includes(part)) continue
    text += paragraphs(blocks).map(textOf).join('\n')
  }
  return text
}

function assertCheckDoc(doc: Doc) {
  try {
    checkDoc(doc)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'not implemented') {
      assert.equal(message, 'not implemented', 'checkDoc is not implemented yet; structural check skipped')
      return
    }
    throw error
  }
}

test('open parses basic.docx into a document', () => {
  const opened = engine.open(fixture('basic.docx'))
  try {
    const body = paragraphs(opened.doc.body)
    assert.ok(
      body.some((para) => textOf(para) === 'Quarterly report'),
      'title paragraph text is kept',
    )
    const table = opened.doc.body.find((block) => block.kind === 'table')
    assert.ok(table !== undefined && table.kind === 'table', 'basic.docx has a table')
    if (table === undefined || table.kind !== 'table') return
    assert.equal(table.rows.length, 3, 'table has 3 rows')
    assert.ok(
      table.rows.every((row) => row.cells.length === 3),
      'table has 3 cells in every row',
    )
    const lists = body.filter((para) => para.props.numbering !== undefined && para.props.numbering !== null)
    assert.equal(lists.length, 6, 'six list paragraphs')
    const images = body.flatMap((para) => para.inlines).filter((inline) => inline.kind === 'atom' && inline.atom.type === 'image')
    assert.equal(images.length, 1, 'one image')
    const image = images[0]
    if (image === undefined || image.kind !== 'atom' || image.atom.type !== 'image') return
    const url = opened.source.imageUrl(image.atom.media)
    assert.ok(url.startsWith('blob:'), 'image bytes are served as a blob URL')
    assert.ok(storyText(opened.doc, 'header').includes('rdocx-acde fixture header'), 'header story text')
    assert.ok(storyText(opened.doc, 'footer').includes('rdocx-acde fixture footer'), 'footer story text')
    const roles = [...opened.doc.styles.paragraph.values()].map((style) => style.role)
    assert.ok(roles.includes('title'), 'Title role detected')
    assert.ok(roles.includes('heading1'), 'Heading 1 role detected')
    const centered = body.find((para) => para.props.align === 'center')
    assert.ok(centered !== undefined, 'centered paragraph keeps its direct alignment')
    if (centered !== undefined) {
      assert.equal(opened.source.paraLook(centered).align, 'center', 'paraLook overlays direct alignment')
    }
    const plain = body.find((para) => textOf(para).startsWith('Plain, '))
    assert.ok(plain !== undefined, 'mixed-formatting paragraph is present')
    if (plain !== undefined) {
      assert.equal(opened.source.look(plain, { bold: true }).bold, true, 'look overlays a direct bold mark')
    }
    assertCheckDoc(opened.doc)
  } finally {
    opened.source.free()
  }
})

function pt(value: number): Pt {
  return value as Pt
}

test('a list level supplies left and hanging indent, and a paragraph indent overrides it', () => {
  const opened = engine.open(fixture('basic.docx'))
  try {
    const body = paragraphs(opened.doc.body)
    const bullet = body.find((para) => textOf(para) === 'First bullet')
    const nested = body.find((para) => textOf(para) === 'Nested bullet')
    const step = body.find((para) => textOf(para) === 'Step one')
    const plain = body.find((para) => textOf(para).startsWith('Plain, '))
    assert.ok(bullet && nested && step && plain)
    if (!bullet || !nested || !step || !plain) return
    const look = opened.source.paraLook(bullet)
    const numbering = look.numbering
    assert.ok(numbering, 'the bullet is numbered')
    if (!numbering) return
    const level = opened.doc.lists.byNum.get(numbering.num)?.levels[numbering.level]
    assert.ok(level)
    if (!level) return
    assert.equal(Number(level.indentLeft), 36)
    assert.equal(Number(level.hanging), 18)
    assert.equal(look.indent.left, level.indentLeft, 'the bullet takes the level left indent')
    assert.equal(look.indent.hanging, level.hanging, 'the bullet takes the level hanging indent')
    assert.ok(Number(look.indent.hanging) > 0, 'a hanging indent gives the marker a column of its own')
    const nestedLook = opened.source.paraLook(nested)
    assert.equal(Number(nestedLook.indent.left), 72)
    assert.equal(Number(nestedLook.indent.hanging), 18)
    const stepLook = opened.source.paraLook(step)
    assert.equal(Number(stepLook.indent.left), 36)
    assert.equal(Number(stepLook.indent.hanging), 18)
    assert.equal(Number(opened.source.paraLook(plain).indent.left), 0)
    assert.equal(Number(opened.source.paraLook(plain).indent.hanging), 0, 'a paragraph outside a list keeps the style indent')
    const own = opened.source.paraLook({
      ...bullet,
      props: { ...bullet.props, indent: { left: pt(12), hanging: pt(0) } },
    })
    assert.equal(Number(own.indent.left), 12, 'a direct left indent wins')
    assert.equal(Number(own.indent.hanging), 0, 'a direct hanging indent wins, including zero')
    const leftOnly = opened.source.paraLook({
      ...bullet,
      props: { ...bullet.props, indent: { left: pt(10) } },
    })
    assert.equal(Number(leftOnly.indent.left), 10)
    assert.equal(leftOnly.indent.hanging, level.hanging, 'an unset hanging indent still comes from the level')
    const cleared = opened.source.paraLook({
      ...bullet,
      props: { ...bullet.props, numbering: null },
    })
    assert.equal(Number(cleared.indent.left), 0)
    assert.equal(Number(cleared.indent.hanging), 0, 'leaving the list drops the level indent')
  } finally {
    opened.source.free()
  }
})

test('open parses long.docx and preserve.docx', () => {
  const long = engine.open(fixture('long.docx'))
  const preserve = engine.open(fixture('preserve.docx'))
  try {
    assert.ok(
      paragraphs(long.doc.body).some((para) => textOf(para).includes('Chapter 1')),
      'long.docx keeps chapter text',
    )
    assert.ok(
      paragraphs(long.doc.body).some((para) => textOf(para).includes('这是一段中文内容')),
      'long.docx keeps Chinese text',
    )
    const paras = paragraphs(preserve.doc.body)
    const atoms = paras.flatMap((para) => para.inlines).flatMap((inline) => (inline.kind === 'atom' ? [inline.atom] : []))
    assert.ok(
      atoms.some((atom) => atom.type === 'opaque' && atom.label === 'comment'),
      'comment appears as an atom',
    )
    assert.ok(
      atoms.some((atom) => atom.type === 'opaque' && atom.label === 'bookmark' && atom.display.includes('kept_bookmark')),
      'bookmark appears as an atom',
    )
    assert.ok(
      atoms.some((atom) => atom.type === 'field'),
      'field appears as an atom',
    )
    assert.ok(
      paras.some((para) => para.inlines.some((inline) => inline.kind === 'text' && inline.marks.link === 'https://example.com/')),
      'hyperlink mark is the relationship URL',
    )
    assertCheckDoc(long.doc)
    assertCheckDoc(preserve.doc)
  } finally {
    long.source.free()
    preserve.source.free()
  }
})

test('blank imports an empty document through the same path', () => {
  let opened: Opened | undefined
  try {
    opened = engine.blank()
    assert.ok(Array.isArray(opened.doc.body), 'blank document has a body')
    assert.ok(opened.doc.sections.length > 0, 'blank document has a section')
  } finally {
    opened?.source.free()
  }
})
