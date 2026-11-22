// Print-side height probe. Numbers and structure only: no paragraph text, no files left in the repo.
// The editing view is not running. Expected heights use derive.ts lineHeightPx, render.ts snapLinePx,
// and derive.ts documentGridPitch (one pitch, or none when sections disagree).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { documentGridPitch, lineHeightPx } from '../src/editor/derive.ts'
import { PT_TO_PX, snapLinePx } from '../src/editor/render.ts'
import { printFontRequest } from '../src/engine/engine.ts'
import { printFonts } from '../src/fonts.ts'
import { extractFace, readFontFile, resolveFont, scanFonts } from '../server/fonts.ts'
import { initSync, Session } from '../src/engine/pkg/engine.js'

const POPPLER = '/opt/homebrew/bin'
const CSS_PAD_V = 3 * 0.75 * 2
const CSS_PAD_H = 5 * 0.75 * 2
const WORD_CELL_DEFAULT = { top: 0, right: 5.4, bottom: 0, left: 5.4 }

const arg = process.argv[2]
const flags = process.argv.slice(3)
const structureOnly = flags.includes('--structure')
const rowIndexes = new Set(flags.filter((item) => /^\d+$/.test(item)).map(Number))
if (structureOnly && rowIndexes.size === 0) {
  for (const index of [133, 76, 94, 177]) rowIndexes.add(index)
}
const docPath = arg
  ? isAbsolute(arg)
    ? arg
    : resolve(arg)
  : process.env.WORD_TEST_DOC
    ? resolve(process.env.WORD_TEST_DOC)
    : ''
if (!docPath) {
  console.error('pass a document path or set WORD_TEST_DOC')
  process.exit(1)
}
if (!existsSync(docPath)) {
  console.error(`missing document ${docPath}`)
  process.exit(1)
}

const root = new URL('..', import.meta.url)
const wasmFile = readFileSync(new URL('public/engine.wasm', root))
const wasm = initSync({ module: wasmFile })
const docBytes = new Uint8Array(readFileSync(docPath))
const session = Session.open(docBytes)
let layout = null
let tempDir = null
try {
  const importedJson = session.import()
  const imported = JSON.parse(importedJson)
  const faces = scanFonts(fontDirs())
  if (structureOnly) {
    console.error(`fonts scanned=${faces.length} structure=1`)
    const model = buildModel(imported, [], faces)
    console.log(`doc ${basename(docPath)} blocks=${model.records.length} structure=1`)
    console.log(
      `grid documentPitch=${fmt(model.documentPitch)} sections=${model.sections.map((section) => section.label).join(',')}`,
    )
    for (const line of model.rowDump) console.log(line)
  } else {
  const request = printFontRequest(importedJson)
  const added = addFaces(session, request, faces)
  console.error(`fonts faces=${added.count} bytes=${added.bytes} han=${request.han ? 1 : 0}`)
  layout = session.print_layout(keepPatch(imported))
  const pageCount = layout.page_count()
  const pageSize = JSON.parse(layout.page_size(0))
  const boxes = readBoxes(layout)
  console.error(`layout pages=${pageCount} blocks=${boxes.length}`)
  const model = buildModel(imported, boxes, faces)
  console.log(`doc ${basename(docPath)} pages=${pageCount} blocks=${model.records.length} paper=${fmt(pageSize[0])}x${fmt(pageSize[1])}`)
  console.log(
    `grid documentPitch=${fmt(model.documentPitch)} sections=${model.sections.map((section) => section.label).join(',')}`,
  )
  console.log(`xml align=${model.align} tables=${model.tableCount} snapImported=no snap=${model.snap}`)
  for (const line of model.lines) console.log(line)
  summarize('all', model, 0)
  if (model.records.length > 18) summarize('from18', model, 18)
  const reference = referencePdf(docPath)
  tempDir = mkdtempSync(join(tmpdir(), 'rdocx-drift-'))
  const printPdf = join(tempDir, 'print.pdf')
  writeFileSync(printPdf, layout.pdf())
  const printBbox = bboxPages(printPdf)
  const origin = chooseOrigin(printBbox, model.records, model.margins)
  console.log(`pdfOrigin ${origin.mode} hit=${origin.hit} total=${origin.total} share=${fmt(origin.share)}`)
  if (origin.share >= 0.3) assignPdfLines(model.records, printBbox, origin)
  const printPitch = linePitch(printBbox, model.margins, 'print', origin.share >= 0.5 ? origin.flip : undefined)
  console.log(`printBaseline ${printPitch.line}`)
  console.log(`printGaps ${printPitch.hist}`)
  if (reference) {
    const refPitch = linePitch(bboxPages(reference), model.margins, 'word')
    const refPages = pdfPages(reference)
    console.log(`wordPages ${refPages}`)
    console.log(`wordBaseline ${refPitch.line}`)
    console.log(`wordGaps ${refPitch.hist}`)
  } else {
    console.log('wordPdf none')
  }
  if (origin.share >= 0.3) summarize('pdfLines', model, 0)
  console.log(gapLine(model.records))
  console.log(breakLine(model.records))
  console.log(`pages ${simLine('structural', model.records, false, (record) => record.baseContentPt)}`)
  console.log(`pages ${simLine('pdf', model.records, false, (record) => record.contentPt)}`)
  console.log(`pages ${simLine('breaks', model.records, true, (record) => record.contentPt)}`)
  causes(model, pageCount)
  for (const line of model.rowDump) console.log(line)
  if (rowIndexes.size > 0) {
    const svgPath = join('tmp-pdf', 'print.svg')
    execFileSync(join(POPPLER, 'pdftocairo'), ['-svg', printPdf, svgPath], { stdio: 'ignore' })
    const printRules = svgRulePages(readFileSync(svgPath, 'utf8'))
    for (const line of fragmentRules(model, printRules)) console.log(line)
  }
  }
  void wasm
} finally {
  layout?.free()
  session.free()
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
}

function fontDirs() {
  return [
    '/System/Library/Fonts',
    '/System/Library/Fonts/Supplemental',
    '/Library/Fonts',
    join(homedir(), 'Library/Fonts'),
  ]
}

function addFaces(session, request, faces) {
  const catalog = faces.map((face) => ({
    id: face.id,
    families: face.families,
    bold: face.bold,
    italic: face.italic,
    cjk: face.cjk,
    truetype: face.truetype,
    weight: face.weight,
  }))
  const plan = printFonts(request.families, catalog, request.han)
  const byId = new Map(faces.map((face) => [face.id, face]))
  let bytes = 0
  let count = 0
  for (const planned of plan.faces) {
    const face = byId.get(planned.id)
    if (!face) continue
    const file = readFontFile(face.path)
    const data = face.path.toLowerCase().endsWith('.ttc') || face.path.toLowerCase().endsWith('.otc')
      ? extractFace(file, face.faceIndex)
      : file
    session.add_font(planned.family, data)
    bytes += data.byteLength
    count += 1
  }
  for (const [requested, loaded] of plan.aliases) session.add_font_alias(requested, loaded)
  return { count, bytes }
}

function keepPatch(imported) {
  const body = imported.body.map((block) => {
    if (typeof block.src !== 'number') throw new Error('imported block has no src')
    return { keep: block.src }
  })
  return JSON.stringify({ body, sections: imported.sections, newLists: [], addedStyles: [], media: [] })
}

function readBoxes(layout) {
  if (typeof layout.block_boxes !== 'function') throw new Error('engine has no block_boxes')
  const parsed = JSON.parse(layout.block_boxes())
  if (!Array.isArray(parsed)) throw new Error('block_boxes is not a list')
  return parsed.map((box, index) => {
    if (!box || typeof box !== 'object' || box.index !== index || !Array.isArray(box.fragments)) {
      throw new Error(`block_boxes ${index}`)
    }
    let height = 0
    let previous = -1
    const fragments = []
    for (const fragment of box.fragments) {
      if (!fragment || typeof fragment.page !== 'number' || !Number.isInteger(fragment.page) || fragment.page < previous) {
        throw new Error(`block_boxes ${index} page`)
      }
      if (typeof fragment.y !== 'number' || typeof fragment.height !== 'number') throw new Error(`block_boxes ${index} box`)
      if (!Number.isFinite(fragment.y) || !Number.isFinite(fragment.height)) throw new Error(`block_boxes ${index} box`)
      previous = fragment.page
      height += fragment.height
      fragments.push({ page: fragment.page, y: fragment.y, height: fragment.height })
    }
    return { index, fragments, height: fragments.length > 0 ? height : null }
  })
}

function buildModel(imported, boxes, faces) {
  const names = zipNames(docPath)
  const documentXml = zipText(docPath, names.find((name) => name === 'word/document.xml') ?? 'word/document.xml')
  const stylesXml = names.includes('word/styles.xml') ? zipText(docPath, 'word/styles.xml') : ''
  const footnotesXml = names.includes('word/footnotes.xml') ? zipText(docPath, 'word/footnotes.xml') : ''
  const headerNames = names.filter((name) => /^word\/header\d+\.xml$/.test(name))
  const footerNames = names.filter((name) => /^word\/footer\d+\.xml$/.test(name))
  const document = parseXml(documentXml)
  const body = findDescendant(document, 'body') ?? document
  const xmlNodes = alignNodes(body.children ?? [], imported.body)
  const xmlGrids = xmlSectionGrids(body)
  const paraLooks = new Map()
  for (const entry of imported.paraLooks ?? []) paraLooks.set(entry.style, entry.look)
  const runLooks = new Map()
  for (const entry of imported.runLooks ?? []) {
    runLooks.set(`${entry.para}\0${entry.character ?? ''}`, entry.look)
  }
  const defaultStyle = imported.styles?.defaultParagraph ?? 'Normal'
  const sections = (imported.sections ?? []).map((section, index) => sectionInfo(section, index))
  const sectionAt = sectionIndexes(imported.body)
  const pitchPx = documentGridPitch({
    sections: sections.map((section) => ({ grid: section.pitch > 0 ? { linePitch: section.pitch } : null })),
  })
  const documentPitch = pitchPx === null ? null : pitchPx / PT_TO_PX
  const metricsOf = metricsCache(faces)
  const margins = sections[0]?.margins ?? { top: 72, right: 72, bottom: 72, left: 72, header: 36, footer: 36, gutter: 0 }
  const records = []
  const lines = []
  const rowDump = []
  let tableOrdinal = 0
  for (let index = 0; index < imported.body.length; index++) {
    const block = imported.body[index]
    const box = boxes[index]
    const section = sections[sectionAt[index] ?? 0] ?? sections[0]
    const xmlGrid = xmlGrids[section?.index ?? 0] ?? null
    const kind = blockKind(block)
    const print = box?.height ?? null
    if (kind === 'table') {
      const xml = xmlNodes.tables[tableOrdinal] ?? null
      tableOrdinal += 1
      const row = tableRecord(block, xml, section, print, index, defaultStyle, paraLooks, runLooks, metricsOf, documentPitch)
      if (rowIndexes.has(index)) {
        rowDump.push(
          ...describeTable(block, section, print, index, defaultStyle, paraLooks, runLooks, metricsOf, documentPitch),
        )
      }
      const record = finishRecord(row.record, box, block, section, sections)
      records.push(record)
      lines.push(`${row.line} firstPage=${record.firstPage ?? 'none'} sectionBreak=${record.sectionBreak ?? 'none'}`)
    } else if (kind === 'paragraph') {
      const xml = xmlNodes.ok ? xmlNodes.nodes[index] : null
      const row = paragraphRecord(
        block,
        xml,
        section,
        xmlGrid,
        print,
        index,
        defaultStyle,
        paraLooks,
        runLooks,
        metricsOf,
        documentPitch,
        margins,
      )
      const record = finishRecord(row.record, box, block, section, sections)
      records.push(record)
      lines.push(`${row.line} firstPage=${record.firstPage ?? 'none'} sectionBreak=${record.sectionBreak ?? 'none'}`)
    } else {
      const record = {
        index,
        kind: 'opaque',
        print,
        editPt: print,
        sectionEditPt: print,
        lineSrc: 'opaque',
        style: '',
        rule: 'none',
        grid: section?.type ?? 'none',
        snap: 'na',
        before: 0,
        after: 0,
        contentPt: print,
        pageBreaks: 0,
        imagePt: 0,
      }
      const placed = finishRecord(record, box, block, section, sections)
      records.push(placed)
      lines.push(
        `b ${index} opaque print=${fmt(print)} grid=${section?.type ?? 'none'} pitch=${fmt(section?.pitch)} firstPage=${placed.firstPage ?? 'none'} sectionBreak=${placed.sectionBreak ?? 'none'}`,
      )
    }
  }
  const furniture = furnitureReport(headerNames, footerNames, defaultStyle, paraLooks, runLooks, metricsOf, documentPitch, sections[0])
  const notes = noteReport(documentXml, footnotesXml)
  const cellMargins = marginReport(xmlNodes.tables, stylesXml)
  return {
    records,
    lines,
    sections,
    documentPitch,
    align: xmlNodes.ok ? 'yes' : `no ${xmlNodes.reason}`,
    tableCount: xmlNodes.tables.length,
    margins,
    furniture,
    notes,
    cellMargins,
    snap: snapSummary(body),
    bodyHeight: (sections[0]?.paperHeight ?? 0) - margins.top - margins.bottom,
    rowDump,
  }
}

function finishRecord(record, box, block, section, sections) {
  record.fragments = box?.fragments ?? []
  record.firstPage = record.fragments[0]?.page ?? null
  record.baseEditPt = record.editPt
  record.baseContentPt = record.contentPt ?? record.editPt
  record.baseLines = record.lines ?? 0
  record.baseSectionEditPt = record.sectionEditPt
  record.baseLineSrc = record.lineSrc
  record.bodyHeight = (section?.paperHeight ?? 0) - (section?.margins.top ?? 0) - (section?.margins.bottom ?? 0)
  record.sectionBreak = null
  if (typeof block?.sectionEnd === 'number') {
    record.sectionBreak = sections[block.sectionEnd + 1]?.breakType ?? 'nextPage'
  }
  return record
}

function snapSummary(body) {
  const counts = { on: 0, off: 0, absent: 0 }
  for (const para of collect(body, 'p')) {
    const snap = snapOf(para)
    if (snap === '0') counts.off += 1
    else if (snap === 'absent') counts.absent += 1
    else counts.on += 1
  }
  return `on:${counts.on} off:${counts.off} absent:${counts.absent}`
}

function sectionInfo(section, index) {
  const grid = section.grid
  const margins = section.marginsPt ?? [72, 72, 72, 72, 36, 36, 0]
  const [top, right, bottom, left, header, footer, gutter] = margins
  const pitch = grid && typeof grid[1] === 'number' ? grid[1] : 0
  const charSpace = grid && typeof grid[2] === 'number' ? grid[2] : null
  const type = grid && typeof grid[0] === 'string' ? grid[0] : 'none'
  return {
    index,
    type,
    pitch,
    charSpace,
    breakType: typeof section.breakType === 'string' ? section.breakType : 'nextPage',
    label: `${index}:${type}:${fmt(pitch)}:${charSpace === null ? 'none' : fmt(charSpace)}`,
    margins: { top, right, bottom, left, header, footer, gutter: gutter ?? 0 },
    paperWidth: section.widthPt,
    paperHeight: section.heightPt,
    contentWidth: section.widthPt - left - right - (gutter ?? 0),
  }
}

function xmlSectionGrids(body) {
  const grids = []
  const take = (sect) => {
    if (!sect) return
    const grid = findChild(sect, 'docGrid')
    if (!grid) {
      grids.push(null)
      return
    }
    grids.push({
      type: attr(grid, 'type') || 'default',
      pitch: twips(attr(grid, 'linePitch')),
      charSpace: twips(attr(grid, 'charSpace')),
    })
  }
  for (const child of body.children ?? []) {
    if (child.name === 'p') take(findChild(findChild(child, 'pPr'), 'sectPr'))
    else if (child.name === 'sectPr') take(child)
  }
  return grids
}

function sectionIndexes(body) {
  const out = []
  let section = 0
  for (const block of body) {
    out.push(section)
    if (block?.kind === 'p' && typeof block.sectionEnd === 'number') section = block.sectionEnd + 1
  }
  return out
}

function paragraphRecord(block, xml, section, xmlGrid, print, index, defaultStyle, paraLooks, runLooks, metricsOf, documentPitch, margins) {
  const spacing = resolvedSpacing(block, paraLooks, defaultStyle)
  const runs = runSpecs(block, spacing.style, runLooks, defaultStyle)
  const spec = dominantRun(runs)
  const metrics = metricsOf(spec.han ? spec.east : spec.ascii)
  const editLine = editLinePt(metrics, spec.size, spacing.line, documentPitch)
  const sectionLine = editLinePt(metrics, spec.size, spacing.line, section?.pitch > 0 ? section.pitch : null)
  const snap = xml ? snapOf(xml) : 'unaligned'
  const width = Math.max(1, (section?.contentWidth ?? 468) - spacing.indent)
  const units = textUnits(block)
  const atoms = atomFacts(block)
  const wrap = wrapLines(units, spec.size, width, 0)
  const gridType = xmlGrid?.type || section?.type
  const charSpacePt = xmlGrid?.charSpace ?? section?.charSpace ?? 0
  const printWrap = wrapLines(
    units,
    spec.size,
    width,
    gridType === 'linesAndChars' || gridType === 'snapToChars' ? charSpacePt : 0,
  )
  const matched = matchPitch(print, spacing.before, spacing.after, section?.pitch ?? 0)
  const lineSrc = matched ? 'multiple' : 'wrap'
  const lines = matched ? matched.n : wrap
  const extra = matched ? matched.extra : spacing.before + spacing.after
  const contentPt = Math.max(lines * editLine, atoms.imagePt)
  const editPt = contentPt + extra
  const sectionEditPt = lines * sectionLine + extra
  const direct = block.props ?? {}
  const record = {
    index,
    kind: 'paragraph',
    print,
    editPt,
    sectionEditPt,
    editLine,
    sectionLine,
    lineSrc,
    lines,
    style: spacing.style,
    rule: lineText(spacing.line),
    grid: section?.type ?? 'none',
    snap,
    before: spacing.before,
    after: spacing.after,
    pitch: section?.pitch ?? 0,
    wrap,
    printWrap,
    metrics: metrics ? 1 : 0,
    pdfLines: null,
    contentPt,
    pageBreaks: atoms.pageBreaks,
    imagePt: atoms.imagePt,
  }
  const line = [
    `b ${index} paragraph`,
    `style=${JSON.stringify(spacing.style)}`,
    `directLine=${lineText(direct.line)}`,
    `directBefore=${fmt(direct.spaceBefore)}`,
    `directAfter=${fmt(direct.spaceAfter)}`,
    `resolvedLine=${lineText(spacing.line)}`,
    `resolvedBefore=${fmt(spacing.before)}`,
    `resolvedAfter=${fmt(spacing.after)}`,
    `snap=${snap}`,
    `importSnap=no`,
    `grid=${section?.type ?? 'none'}`,
    `pitch=${fmt(section?.pitch)}`,
    `charSpace=${fmt(section?.charSpace)}`,
    `xmlCharSpace=${fmt(xmlGrid?.charSpace ?? null)}`,
    `print=${fmt(print)}`,
    `editLine=${fmt(editLine)}`,
    `editPt=${fmt(editPt)}`,
    `lines=${lines}`,
    `lineSrc=${lineSrc}`,
    `contentPt=${fmt(contentPt)}`,
    `pageBreaks=${atoms.pageBreaks}`,
    `imagePt=${fmt(atoms.imagePt)}`,
  ].join(' ')
  void margins
  return { record, line }
}

function tableRecord(block, xml, section, print, index, defaultStyle, paraLooks, runLooks, metricsOf, documentPitch) {
  const rows = xml ? xmlRows(xml) : []
  const margins = xml ? cellMarginsOf(xml) : null
  const used = margins ?? WORD_CELL_DEFAULT
  const marginSource = margins ? 'direct' : 'wordDefault'
  let declared = 0
  let declaredKnown = rows.length > 0
  const rules = []
  let content = 0
  const grid = block.gridPt ?? []
  for (let r = 0; r < (block.rows ?? []).length; r++) {
    const row = block.rows[r]
    const spec = rows[r] ?? { rule: 'missing', pt: null }
    rules.push(`${spec.rule}:${fmt(spec.pt)}`)
    if (typeof spec.pt === 'number') declared += spec.pt
    else declaredKnown = false
    content += rowContent(row, grid, used, section, defaultStyle, paraLooks, runLooks, metricsOf, documentPitch)
  }
  const declaredSum = declaredKnown ? declared : null
  const record = {
    index,
    kind: 'table',
    print,
    editPt: content,
    sectionEditPt: content,
    lineSrc: 'table',
    lines: block.rows?.length ?? 0,
    style: '',
    rule: 'table',
    grid: section?.type ?? 'none',
    snap: 'na',
    before: 0,
    after: 0,
    pitch: section?.pitch ?? 0,
    declaredSum,
    content,
    marginV: used.top + used.bottom,
    marginH: used.left + used.right,
    marginSource,
    rowCount: block.rows?.length ?? 0,
    contentPt: content,
    pageBreaks: atomFacts(block).pageBreaks,
    imagePt: 0,
  }
  const line = [
    `b ${index} table`,
    `rows=${record.rowCount}`,
    `print=${fmt(print)}`,
    `declaredSum=${fmt(declaredSum)}`,
    `editContent=${fmt(content)}`,
    `grid=${section?.type ?? 'none'}`,
    `pitch=${fmt(section?.pitch)}`,
    `cellMar=${fmt(used.top)},${fmt(used.right)},${fmt(used.bottom)},${fmt(used.left)}`,
    `cellMarSource=${marginSource}`,
    `cssPad=${fmt(CSS_PAD_V)},${fmt(CSS_PAD_H)}`,
    `rowRules=${rules.join(',')}`,
  ].join(' ')
  return { record, line }
}

function describeTable(block, section, print, index, defaultStyle, paraLooks, runLooks, metricsOf, documentPitch) {
  const grid = block.gridPt ?? []
  const tableBorders = block.borders ?? null
  const tableMargins = block.margins ?? null
  const rows = block.rows ?? []
  const lines = []
  lines.push(
    [
      `rows b=${index}`,
      `n=${rows.length}`,
      `print=${fmt(print)}`,
      `grid=${grid.map((width) => fmt(width)).join('|')}`,
      `mar=${marginText(tableMargins)}`,
      `bdr=${borderSetText(tableBorders)}`,
      `pitch=${fmt(documentPitch)}`,
      `sectionPitch=${fmt(section?.pitch)}`,
      `contentW=${fmt(section?.contentWidth)}`,
      `gridSum=${fmt(grid.reduce((sum, width) => sum + width, 0))}`,
    ].join(' '),
  )
  const tops = []
  const bots = []
  const placed = []
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]
    let col = 0
    let tallest = 0
    let tallestDrop = 0
    let tallestBare = 0
    let topW = 0
    let bottomW = 0
    const cellSigs = []
    const rowPlaced = []
    for (const cell of row?.cells ?? []) {
      const span = cell.span > 0 ? cell.span : 1
      if (cell.vMerge === 'continue') {
        col += span
        continue
      }
      const startCol = col
      let width = 0
      for (let c = 0; c < span; c++) width += grid[col + c] ?? 0
      col += span
      const pad = cellPadOf(tableMargins, cell.margins)
      const inner = Math.max(1, width - pad.left - pad.right)
      let cover = 1
      if (cell.vMerge === 'restart') {
        for (let below = r + 1; below < rows.length; below++) {
          const next = cellAt(rows, below, startCol)
          if (next?.vMerge !== 'continue') break
          cover += 1
        }
      }
      const paraBlocks = (cell.blocks ?? []).filter((child) => child.kind === 'p')
      const nested = (cell.blocks ?? []).filter((child) => child.kind !== 'p').length
      const images = imagePt(cell)
      let stack = 0
      let dropStack = 0
      let previousAfter = null
      const paraSigs = []
      for (let pi = 0; pi < paraBlocks.length; pi++) {
        const child = paraBlocks[pi]
        const spacing = resolvedSpacing(child, paraLooks, defaultStyle)
        const spec = dominantRun(runSpecs(child, spacing.style, runLooks, defaultStyle))
        const metrics = metricsOf(spec.han ? spec.east : spec.ascii)
        const line = editLinePt(metrics, spec.size, spacing.line, documentPitch)
        const sectionLine = editLinePt(metrics, spec.size, spacing.line, section?.pitch > 0 ? section.pitch : null)
        const units = textUnits(child)
        const buckets = charBuckets(child)
        const usable = Math.max(1, inner - spacing.indent)
        const n = wrapLines(units, spec.size, usable, 0)
        const before = previousAfter === null ? Math.max(0, spacing.before) : Math.max(0, spacing.before - previousAfter)
        const after = Math.max(0, spacing.after)
        const dropBefore = pi === 0 ? 0 : before
        const dropAfter = pi === paraBlocks.length - 1 ? 0 : after
        stack += n * line + before + after
        dropStack += n * line + dropBefore + dropAfter
        previousAfter = spacing.after
        paraSigs.push(
          [
            `${n}x${fmt(line)}`,
            lineText(spacing.line),
            `sz${fmt(spec.size)}`,
            `b${fmt(before)}`,
            `a${fmt(after)}`,
            `sec${fmt(sectionLine)}`,
            `h${units.han}`,
            `o${units.other}`,
            `bk${buckets}`,
            `w${fmt(usable)}`,
            spacing.contextual ? 'ctx' : 'noctx',
            metrics ? 'm1' : 'm0',
            metrics ? '' : `font=${spec.han ? spec.east : spec.ascii}`,
            child.props?.numbering ? 'num' : 'nonum',
          ].join('/'),
        )
      }
      const content = stack + pad.top + pad.bottom
      const dropped = dropStack + pad.top + pad.bottom
      const last = r === rows.length - 1
      const tw = edgeWidth(cell.borders, 'top', tableBorders, r === 0 ? 'top' : 'insideH')
      const bw = edgeWidth(cell.borders, 'bottom', tableBorders, last ? 'bottom' : 'insideH')
      if (tw > topW) topW = tw
      if (bw > bottomW) bottomW = bw
      cellSigs.push(
        `c${cellSigs.length} v=${cell.vMerge ?? 'none'} rows=${cover} span=${span} mar=${marginText(pad)} topW=${fmt(tw)} botW=${fmt(bw)} paras=${paraBlocks.length} nested=${nested} img=${fmt(images)} stack=${fmt(content)} ${paraSigs.join('+') || 'empty'}`,
      )
      rowPlaced.push({ cover, content, dropped, bare: stack })
      if (cover === 1) {
        if (content > tallest) tallest = content
        if (dropped > tallestDrop) tallestDrop = dropped
        if (stack > tallestBare) tallestBare = stack
      }
    }
    tops.push(topW)
    bots.push(bottomW)
    placed.push(rowPlaced)
    const declared = typeof row?.heightPt === 'number' ? row.heightPt : null
    const rule = row?.heightRule || (declared === null ? 'auto' : 'implicit')
    lines.push(
      [
        `row b=${index}`,
        `r=${r}`,
        `rule=${rule}`,
        `h=${fmt(declared)}`,
        `single=${fmt(tallest)}`,
        `bare=${fmt(tallestBare)}`,
        `drop=${fmt(tallestDrop)}`,
        `topW=${fmt(topW)}`,
        `botW=${fmt(bottomW)}`,
        `header=${row?.header ? 1 : 0}`,
        `cantSplit=${row?.cantSplit ? 1 : 0}`,
        cellSigs.join(' '),
      ].join(' '),
    )
  }
  let borderSum = tops[0] ?? 0
  for (let r = 0; r < rows.length; r++) {
    if (r + 1 === rows.length) borderSum += bots[r] ?? 0
    else borderSum += Math.max(bots[r] ?? 0, tops[r + 1] ?? 0)
  }
  const floors = rows.map((row) => {
    const declared = typeof row?.heightPt === 'number' ? row.heightPt : 0
    const rule = row?.heightRule || (declared === 0 ? 'auto' : 'implicit')
    if (rule === 'exact') return 0
    return declared
  })
  const flow = assignRowHeights(placed, floors.map(() => 0), 'content')
  const least = assignRowHeights(placed, floors, 'content')
  const dropped = assignRowHeights(placed, floors.map(() => 0), 'dropped')
  const flowSum = sumOf(flow)
  const leastSum = sumOf(least)
  const dropSum = sumOf(dropped)
  const col0 = rows.map((row) => row?.cells?.[0]?.vMerge ?? 'none').join(',')
  lines.push(`merge b=${index} col0=${col0}`)
  lines.push(
    `fit b=${index} flow=${flow.map((value) => fmt(value)).join(',')} least=${least.map((value) => fmt(value)).join(',')}`,
  )
  lines.push(
    [
      `sum b=${index}`,
      `flow=${fmt(flowSum)}`,
      `least=${fmt(leastSum)}`,
      `drop=${fmt(dropSum)}`,
      `border=${fmt(borderSum)}`,
      `flowBorder=${fmt(flowSum + borderSum)}`,
      `leastBorder=${fmt(leastSum + borderSum)}`,
      `dropBorder=${fmt(dropSum + borderSum)}`,
      `print=${fmt(print)}`,
    ].join(' '),
  )
  return lines
}

function cellAt(rows, rowIndex, col) {
  let cursor = 0
  for (const cell of rows[rowIndex]?.cells ?? []) {
    const span = cell.span > 0 ? cell.span : 1
    if (col >= cursor && col < cursor + span) return cell
    cursor += span
  }
  return null
}

function assignRowHeights(placed, floors, key) {
  const heights = floors.map((floor, row) => {
    let single = floor
    for (const cell of placed[row] ?? []) {
      if (cell.cover === 1) single = Math.max(single, cell[key] ?? 0)
    }
    return single
  })
  let guard = 0
  let changed = true
  while (changed && guard < 32) {
    changed = false
    guard += 1
    for (let row = 0; row < placed.length; row++) {
      for (const cell of placed[row] ?? []) {
        if (cell.cover <= 1) continue
        let sum = 0
        for (let i = 0; i < cell.cover; i++) sum += heights[row + i] ?? 0
        const need = cell[key] ?? 0
        if (need > sum + 0.01) {
          heights[row + cell.cover - 1] += need - sum
          changed = true
        }
      }
    }
  }
  return heights
}

function sumOf(values) {
  return values.reduce((sum, value) => sum + value, 0)
}

function cellPadOf(tableMargins, cellMargins) {
  return {
    top: padEdge(cellMargins?.top, tableMargins?.top, WORD_CELL_DEFAULT.top),
    right: padEdge(cellMargins?.right, tableMargins?.right, WORD_CELL_DEFAULT.right),
    bottom: padEdge(cellMargins?.bottom, tableMargins?.bottom, WORD_CELL_DEFAULT.bottom),
    left: padEdge(cellMargins?.left, tableMargins?.left, WORD_CELL_DEFAULT.left),
  }
}

function padEdge(cell, table, fallback) {
  if (typeof cell === 'number') return cell
  if (typeof table === 'number') return table
  return fallback
}

function edgeWidth(own, key, tableBorders, tableKey) {
  if (own && Object.hasOwn(own, key)) {
    const edge = own[key]
    return edge && typeof edge.widthPt === 'number' && edge.widthPt > 0 ? edge.widthPt : 0
  }
  const edge = tableBorders?.[tableKey]
  return edge && typeof edge.widthPt === 'number' && edge.widthPt > 0 ? edge.widthPt : 0
}

function marginText(margins) {
  if (!margins) return 'none'
  return [margins.top, margins.right, margins.bottom, margins.left].map((value) => fmt(value)).join(',')
}

function borderSetText(borders) {
  if (!borders) return 'none'
  return ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((key) => {
      const edge = borders[key]
      if (!edge) return `${key}:0`
      return `${key}:${fmt(edge.widthPt)}`
    })
    .join(',')
}

function rowContent(row, grid, margins, section, defaultStyle, paraLooks, runLooks, metricsOf, documentPitch) {
  let col = 0
  let tallest = 0
  for (const cell of row?.cells ?? []) {
    const span = cell.span > 0 ? cell.span : 1
    if (cell.vMerge === 'continue') {
      col += span
      continue
    }
    let width = 0
    for (let c = 0; c < span; c++) width += grid[col + c] ?? 0
    col += span
    const inner = Math.max(1, width - CSS_PAD_H)
    let stack = 0
    let previousAfter = null
    for (const child of cell.blocks ?? []) {
      if (child.kind !== 'p') continue
      const spacing = resolvedSpacing(child, paraLooks, defaultStyle)
      const spec = dominantRun(runSpecs(child, spacing.style, runLooks, defaultStyle))
      const metrics = metricsOf(spec.han ? spec.east : spec.ascii)
      const line = editLinePt(metrics, spec.size, spacing.line, documentPitch)
      const units = textUnits(child)
      const lines = wrapLines(units, spec.size, inner, 0)
      const before = previousAfter === null ? Math.max(0, spacing.before) : Math.max(0, spacing.before - previousAfter)
      stack += lines * line + before + Math.max(0, spacing.after)
      previousAfter = spacing.after
    }
    tallest = Math.max(tallest, stack + CSS_PAD_V)
  }
  return tallest
}

function resolvedSpacing(block, paraLooks, defaultStyle) {
  const style = block.props?.style || defaultStyle
  const look = paraLooks.get(style) ?? paraLooks.get(defaultStyle)
  const base = look?.spacing ?? { before: 0, after: 0, line: { rule: 'auto', multiple: 1 } }
  const direct = block.props ?? {}
  const indent = (direct.indentLeft ?? look?.indent?.left ?? 0) + (direct.indentRight ?? look?.indent?.right ?? 0)
  return {
    style,
    before: numberOr(direct.spaceBefore, base.before ?? 0),
    after: numberOr(direct.spaceAfter, base.after ?? 0),
    line: direct.line ?? base.line ?? { rule: 'auto', multiple: 1 },
    indent,
    contextual: look?.spacing?.contextual === true,
  }
}

function runSpecs(block, style, runLooks, defaultStyle) {
  const specs = []
  for (const inline of block.inlines ?? []) {
    if (inline.kind !== 'text') continue
    const marks = inline.marks ?? {}
    const base = runLooks.get(`${style}\0${marks.charStyle ?? ''}`) ?? runLooks.get(`${style}\0`) ?? runLooks.get(`${defaultStyle}\0`)
    const size = numberOr(marks.sizePt, base?.sizePt ?? 11)
    const east = marks.fontEastAsia || marks.font || base?.fonts?.eastAsia || 'Calibri'
    const ascii = marks.font || base?.fonts?.ascii || 'Calibri'
    const units = charUnits(inline.text ?? '')
    specs.push({ size, east, ascii, han: units.han > 0, units })
  }
  if (specs.length === 0) {
    const base = runLooks.get(`${style}\0`) ?? runLooks.get(`${defaultStyle}\0`)
    specs.push({
      size: base?.sizePt ?? 11,
      east: base?.fonts?.eastAsia || 'Calibri',
      ascii: base?.fonts?.ascii || 'Calibri',
      han: false,
      units: { han: 0, other: 0 },
    })
  }
  return specs
}

function dominantRun(specs) {
  let best = specs[0]
  for (const spec of specs) {
    if (spec.han && !best.han) best = spec
    else if (spec.han === best.han && spec.size > best.size) best = spec
  }
  const units = { han: 0, other: 0 }
  for (const spec of specs) {
    units.han += spec.units.han
    units.other += spec.units.other
  }
  return { ...best, units }
}

function textUnits(block) {
  const units = { han: 0, other: 0 }
  walkText(block, (text) => {
    const part = charUnits(text)
    units.han += part.han
    units.other += part.other
  })
  return units
}

function atomFacts(block) {
  const facts = { pageBreaks: 0, imagePt: 0 }
  eachPara(block, (para) => {
    for (const inline of para.inlines ?? []) {
      if (inline.kind !== 'atom') continue
      if (inline.atom?.type === 'pageBreak') facts.pageBreaks += 1
      if (inline.atom?.type === 'image' && typeof inline.atom.heightPt === 'number') facts.imagePt += inline.atom.heightPt
    }
  })
  return facts
}

function eachPara(block, visit) {
  if (!block) return
  if (block.kind === 'p') {
    visit(block)
    return
  }
  if (block.kind === 'table') {
    for (const row of block.rows ?? []) {
      for (const cell of row.cells ?? []) {
        for (const child of cell.blocks ?? []) eachPara(child, visit)
      }
    }
  }
}

function walkText(block, visit) {
  if (!block) return
  if (block.kind === 'p') {
    for (const inline of block.inlines ?? []) {
      if (inline.kind === 'text' && typeof inline.text === 'string') visit(inline.text)
      else if (inline.kind === 'atom' && typeof inline.atom?.display === 'string') visit(inline.atom.display)
    }
    return
  }
  if (block.kind === 'table') {
    for (const row of block.rows ?? []) {
      for (const cell of row.cells ?? []) {
        for (const child of cell.blocks ?? []) walkText(child, visit)
      }
    }
  }
}

function editLinePt(metrics, sizePt, rule, pitchPt) {
  const spacing = rule?.rule === 'exact' || rule?.rule === 'atLeast' || rule?.rule === 'auto' ? rule : { rule: 'auto', multiple: 1 }
  const heightPx = lineHeightPx(metrics ?? undefined, sizePt, spacing)
  const pitchPx = typeof pitchPt === 'number' && pitchPt > 0 ? pitchPt * PT_TO_PX : null
  return snapLinePx(heightPx, pitchPx, spacing) / PT_TO_PX
}

function wrapLines(units, size, width, charSpace) {
  const hanW = Math.max(0.5, size + charSpace)
  const otherW = Math.max(0.25, size * 0.5)
  const need = units.han * hanW + units.other * otherW
  if (!(width > 0) || need <= 0) return 1
  return Math.max(1, Math.ceil(need / width - 1e-9))
}

function matchPitch(print, before, after, pitch) {
  if (!(pitch > 0) || typeof print !== 'number') return null
  const options = [
    { name: 'content', value: print - before - after, extra: before + after },
    { name: 'raw', value: print, extra: 0 },
    { name: 'largerSpace', value: print - Math.max(before, after), extra: Math.max(before, after) },
  ]
  let best = null
  for (const option of options) {
    if (!(option.value > 0)) continue
    const n = Math.round(option.value / pitch)
    if (n < 1) continue
    const err = Math.abs(option.value - n * pitch)
    if (err > 0.75) continue
    if (!best || err < best.err) best = { n, err, extra: option.extra, name: option.name }
  }
  return best
}

function imagePt(block) {
  let height = 0
  const visit = (node) => {
    if (!node) return
    if (node.kind === 'p') {
      for (const inline of node.inlines ?? []) {
        if (inline.kind === 'atom' && inline.atom?.type === 'image' && typeof inline.atom.heightPt === 'number') {
          height += inline.atom.heightPt
        }
      }
      return
    }
    for (const child of node.blocks ?? []) visit(child)
  }
  visit(block)
  return height
}

function charBuckets(block) {
  const counts = { han: 0, ascii: 0, digit: 0, fw: 0, punct: 0, other: 0 }
  walkText(block, (text) => {
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0
      if (cp <= 32) continue
      if (cp >= 0xff00 && cp <= 0xff60) counts.fw += 1
      else if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) counts.han += 1
      else if (cp >= 48 && cp <= 57) counts.digit += 1
      else if (cp >= 65 && cp <= 90 || cp >= 97 && cp <= 122) counts.ascii += 1
      else if (cp < 128) counts.punct += 1
      else counts.other += 1
    }
  })
  return [counts.han, counts.ascii, counts.digit, counts.fw, counts.punct, counts.other].join(',')
}

function charUnits(text) {
  let han = 0
  let other = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp <= 32) continue
    if (isWide(cp)) han += 1
    else other += 1
  }
  return { han, other }
}

function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x2e80 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60)
  )
}

function metricsCache(faces) {
  const cache = new Map()
  return (family) => {
    const key = family.toLowerCase()
    if (cache.has(key)) return cache.get(key)
    const resolved = resolveFont(family, faces)
    const metrics = resolved?.metrics ?? null
    cache.set(key, metrics)
    return metrics
  }
}

function summarize(label, model, start) {
  const rows = model.records.filter((record) => record.index >= start)
  const paras = rows.filter((record) => record.kind === 'paragraph')
  let whole = 0
  let contentWhole = 0
  let pitched = 0
  for (const record of paras) {
    if (!(record.pitch > 0) || typeof record.print !== 'number') continue
    pitched += 1
    if (nearMultiple(record.print, record.pitch)) whole += 1
    if (nearMultiple(record.print - record.before - record.after, record.pitch)) contentWhole += 1
  }
  console.log(
    `${label} paragraphs=${paras.length} pitched=${pitched} printWhole=${whole} contentWhole=${contentWhole} sharePrint=${fmt(share(whole, pitched))} shareContent=${fmt(share(contentWhole, pitched))}`,
  )
  const groups = new Map()
  let differ = 0
  for (const record of paras) {
    const left = record.editLine
    const right = record.sectionLine
    if (typeof left !== 'number' || typeof right !== 'number') continue
    if (Math.abs(left - right) <= 0.5) continue
    differ += 1
    const key = `${record.style}|${record.rule}|${record.grid}`
    const group = groups.get(key) ?? { n: 0, points: 0 }
    group.n += 1
    group.points += (record.baseSectionEditPt ?? record.sectionEditPt ?? 0) - (record.baseEditPt ?? record.editPt ?? 0)
    groups.set(key, group)
  }
  console.log(`${label} ruleDiff paragraphs=${differ} (section snap minus document snap)`)
  const ranked = [...groups.entries()].sort((a, b) => Math.abs(b[1].points) - Math.abs(a[1].points) || b[1].n - a[1].n)
  for (const [key, group] of ranked.slice(0, 12)) {
    console.log(`  group ${key} n=${group.n} points=${fmt(group.points)}`)
  }
  const cross = crossing(rows, model.bodyHeight)
  console.log(
    `${label} cross printAheadAt=${cross.at === null ? 'none' : cross.at} cumDelta=${fmt(cross.cum)} body=${fmt(model.bodyHeight)} editKnown=${cross.known} editMissing=${cross.missing}`,
  )
  const byKind = kindDelta(rows)
  for (const kind of ['paragraph', 'table', 'opaque']) {
    const item = byKind.get(kind)
    console.log(`${label} ${kind} n=${item.n} print=${fmt(item.print)} edit=${fmt(item.edit)} delta=${fmt(item.delta)}`)
  }
}

function crossing(rows, body) {
  let cum = 0
  let at = null
  let known = 0
  let missing = 0
  for (const record of rows) {
    if (typeof record.print !== 'number' || typeof record.editPt !== 'number') {
      missing += 1
      continue
    }
    known += 1
    cum += record.print - record.editPt
    if (at === null && body > 0 && cum >= body) at = record.index
  }
  return { at, cum, known, missing }
}

function kindDelta(rows) {
  const out = new Map([
    ['paragraph', { n: 0, print: 0, edit: 0, delta: 0 }],
    ['table', { n: 0, print: 0, edit: 0, delta: 0 }],
    ['opaque', { n: 0, print: 0, edit: 0, delta: 0 }],
  ])
  for (const record of rows) {
    const item = out.get(record.kind)
    if (!item || typeof record.print !== 'number' || typeof record.editPt !== 'number') continue
    item.n += 1
    item.print += record.print
    item.edit += record.editPt
    item.delta += record.print - record.editPt
  }
  return out
}

function causes(model, pageCount) {
  const paras = model.records.filter((record) => record.kind === 'paragraph' && typeof record.print === 'number' && typeof editOf(record) === 'number')
  let paraDelta = 0
  let contentDelta = 0
  let sectionGain = 0
  let snapOff = 0
  let snapOffDelta = 0
  let charBlocks = 0
  let charPoints = 0
  let metricsMissing = 0
  const bySrc = new Map()
  for (const record of paras) {
    const edit = editOf(record)
    const delta = record.print - edit
    const content = record.baseContentPt ?? record.contentPt
    paraDelta += delta
    if (typeof content === 'number') contentDelta += record.print - content
    sectionGain += (record.baseLines ?? 0) * ((record.sectionLine ?? 0) - (record.editLine ?? 0))
    if (typeof record.printWrap === 'number' && typeof record.wrap === 'number' && record.printWrap !== record.wrap) {
      charBlocks += 1
      charPoints += (record.printWrap - record.wrap) * (record.editLine ?? 0)
    }
    if (!record.metrics) metricsMissing += 1
    if (record.snap === '0' || record.snap === 'false') {
      snapOff += 1
      snapOffDelta += delta
    }
    const src = record.baseLineSrc ?? record.lineSrc ?? 'none'
    const bucket = bySrc.get(src) ?? { n: 0, delta: 0 }
    bucket.n += 1
    bucket.delta += delta
    bySrc.set(src, bucket)
  }
  console.log(
    `CAUSE paragraphModel blocks=${paras.length} measuredDelta=${fmt(paraDelta)} contentDelta=${fmt(contentDelta)} inferred=${bySrc.has('wrap') ? 'part' : 'no'} missingMetrics=${metricsMissing}`,
  )
  for (const [src, bucket] of bySrc) console.log(`  lineSrc ${src} n=${bucket.n} delta=${fmt(bucket.delta)}`)
  console.log(`CAUSE sectionSnap points=${fmt(sectionGain)} documentPitch=${fmt(model.documentPitch)} ${model.documentPitch === null ? 'inferred' : 'measured'}`)
  console.log(`CAUSE snapToGridOff blocks=${snapOff} points=${fmt(snapOffDelta)} import=no ${model.align === 'yes' ? 'measured' : 'unaligned'} all=${model.snap}`)
  console.log(`CAUSE charSpace blocks=${charBlocks} points=${fmt(charPoints)} inferred`)
  let tableDelta = 0
  let declaredDelta = 0
  let printVsDeclared = 0
  let ruled = 0
  let padPoints = 0
  let rows = 0
  for (const record of model.records) {
    if (record.kind !== 'table') continue
    if (typeof record.print === 'number' && typeof record.editPt === 'number') tableDelta += record.print - record.editPt
    if (typeof record.declaredSum === 'number' && typeof record.editPt === 'number') declaredDelta += record.declaredSum - record.editPt
    if (typeof record.print === 'number' && typeof record.declaredSum === 'number') {
      printVsDeclared += record.print - record.declaredSum
      if (Math.abs(record.print - record.declaredSum) <= 2) ruled += 1
    }
    const pad = CSS_PAD_V - (record.marginV ?? CSS_PAD_V)
    if (typeof record.declaredSum !== 'number' || (typeof record.print === 'number' && Math.abs(record.print - record.declaredSum) > 2)) {
      padPoints += pad * (record.rowCount ?? 0)
    }
    rows += record.rowCount ?? 0
  }
  console.log(
    `CAUSE tableRows blocks=${model.tableCount} rows=${rows} printMinusEdit=${fmt(tableDelta)} declaredMinusEdit=${fmt(declaredDelta)} printMinusDeclared=${fmt(printVsDeclared)} ruled=${ruled} inferred`,
  )
  console.log(`CAUSE cellPad points=${fmt(padPoints)} cssV=${fmt(CSS_PAD_V)} rows=${rows} inferred`)
  for (const margin of model.cellMargins) console.log(`  cellMar ${margin}`)
  console.log(`CAUSE footnotes refs=${model.notes.refs} bodies=${model.notes.bodies} ${model.notes.refs === 0 ? 'measured' : 'counted'}`)
  console.log(
    `CAUSE headerFooter fileOverflow=${fmt(model.furniture.fileOverflow)} editOverflow=${fmt(model.furniture.editOverflow)} pages=${pageCount} points=${fmt((model.furniture.fileOverflow - model.furniture.editOverflow) * pageCount)} inferred`,
  )
  for (const line of model.furniture.lines) console.log(`  ${line}`)
}

function furnitureReport(headerNames, footerNames, defaultStyle, paraLooks, runLooks, metricsOf, documentPitch, section) {
  const lines = []
  let headerFile = 0
  let headerEdit = 0
  let footerFile = 0
  let footerEdit = 0
  for (const name of [...headerNames, ...footerNames]) {
    const xml = parseXml(zipText(docPath, name))
    const root = findDescendant(xml, 'hdr') ?? findDescendant(xml, 'ftr') ?? xml
    const paras = collect(root, 'p')
    let file = 0
    let edit = 0
    for (const para of paras) {
      const direct = spacingOf(para)
      const style = attr(findChild(findChild(para, 'pPr'), 'pStyle'), 'val') || defaultStyle
      const look = paraLooks.get(style) ?? paraLooks.get(defaultStyle)
      const filePitch = section?.pitch > 0 ? section.pitch : null
      const fileLine = lineFromXml(direct, look, runLooks, metricsOf, style, filePitch)
      const editLook = paraLooks.get(defaultStyle)
      const editLine = lineFromXml({ before: null, after: null, line: null }, editLook, runLooks, metricsOf, defaultStyle, documentPitch)
      file += fileLine + (direct.before ?? look?.spacing?.before ?? 0) + (direct.after ?? look?.spacing?.after ?? 0)
      edit += editLine + (editLook?.spacing?.before ?? 0) + (editLook?.spacing?.after ?? 0)
    }
    if (name.includes('/header')) {
      headerFile = Math.max(headerFile, file)
      headerEdit = Math.max(headerEdit, edit)
    } else {
      footerFile = Math.max(footerFile, file)
      footerEdit = Math.max(footerEdit, edit)
    }
    lines.push(`${basename(name)} paragraphs=${paras.length} filePt=${fmt(file)} editPt=${fmt(edit)}`)
  }
  const margins = section?.margins ?? { top: 72, bottom: 72, header: 36, footer: 36 }
  const headerSlot = Math.max(0, margins.top - margins.header)
  const footerSlot = Math.max(0, margins.bottom - margins.footer)
  const fileOverflow = Math.max(0, headerFile - headerSlot) + Math.max(0, footerFile - footerSlot)
  const editOverflow = Math.max(0, headerEdit - headerSlot) + Math.max(0, footerEdit - footerSlot)
  return { lines, fileOverflow, editOverflow }
}

function lineFromXml(direct, look, runLooks, metricsOf, style, pitch) {
  const rule = direct.line ?? look?.spacing?.line ?? { rule: 'auto', multiple: 1 }
  const base = runLooks.get(`${style}\0`)
  const metrics = metricsOf(base?.fonts?.eastAsia || base?.fonts?.ascii || 'Calibri')
  return editLinePt(metrics, base?.sizePt ?? 11, rule, pitch)
}

function spacingOf(para) {
  const spacing = findChild(findChild(para, 'pPr'), 'spacing')
  if (!spacing) return { before: null, after: null, line: null }
  const before = twips(attr(spacing, 'before'))
  const after = twips(attr(spacing, 'after'))
  const line = attr(spacing, 'line')
  const rule = attr(spacing, 'lineRule') || 'auto'
  let parsed = null
  if (line !== null) {
    if (rule === 'exact') parsed = { rule: 'exact', pt: Number(line) / 20 }
    else if (rule === 'atLeast') parsed = { rule: 'atLeast', pt: Number(line) / 20 }
    else parsed = { rule: 'auto', multiple: Number(line) / 240 }
  }
  return { before, after, line: parsed }
}

function noteReport(documentXml, footnotesXml) {
  const refs = countTags(documentXml, 'footnoteReference')
  let bodies = 0
  if (footnotesXml) {
    const root = parseXml(footnotesXml)
    for (const note of collect(root, 'footnote')) {
      const type = attr(note, 'type')
      if (type === 'separator' || type === 'continuationSeparator') continue
      bodies += 1
    }
  }
  return { refs, bodies }
}

function marginReport(tables, stylesXml) {
  const counts = new Map()
  for (const table of tables) {
    const margins = cellMarginsOf(table)
    const key = margins ? `${fmt(margins.top)},${fmt(margins.right)},${fmt(margins.bottom)},${fmt(margins.left)}` : 'absent'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const styleCounts = new Map()
  if (stylesXml) {
    const root = parseXml(stylesXml)
    for (const margin of collect(root, 'tblCellMar')) {
      const value = edges(margin)
      const key = value ? `${fmt(value.top)},${fmt(value.right)},${fmt(value.bottom)},${fmt(value.left)}` : 'partial'
      styleCounts.set(key, (styleCounts.get(key) ?? 0) + 1)
    }
  }
  const lines = []
  for (const [key, count] of counts) lines.push(`table ${key} n=${count}`)
  for (const [key, count] of styleCounts) lines.push(`style ${key} n=${count}`)
  if (lines.length === 0) lines.push('none')
  return lines
}

function chooseOrigin(pages, records, margins) {
  const modes = [
    { mode: 'top', shift: 0, flip: false },
    { mode: 'bottom', shift: 0, flip: true },
    { mode: 'top-body', shift: margins?.top ?? 0, flip: false },
    { mode: 'bottom-body', shift: margins?.top ?? 0, flip: true },
  ]
  let best = { mode: 'none', hit: 0, total: 0, share: 0, flip: false, shift: 0 }
  for (const mode of modes) {
    const score = scoreOrigin(pages, records, mode)
    if (score.share > best.share) best = { ...mode, ...score }
  }
  return best
}

function scoreOrigin(pages, records, mode) {
  let hit = 0
  let total = 0
  for (let page = 0; page < pages.length; page++) {
    const item = pages[page]
    const fragments = fragmentsOn(records, page)
    for (const word of item.words) {
      total += 1
      const y = wordY(word, item.height, mode)
      if (fragments.some((fragment) => y >= fragment.y + mode.shift - 1.5 && y <= fragment.y + mode.shift + fragment.height + 1.5)) {
        hit += 1
      }
    }
  }
  return { hit, total, share: total === 0 ? 0 : hit / total }
}

function assignPdfLines(records, pages, origin) {
  const mode = origin
  for (const record of records) {
    if (record.kind !== 'paragraph') continue
    const ys = []
    for (const fragment of record.fragments ?? []) {
      const page = pages[fragment.page]
      if (!page) continue
      for (const word of page.words) {
        const y = wordY(word, page.height, mode)
        const top = fragment.y + mode.shift
        if (y >= top - 1.5 && y <= top + fragment.height + 1.5) ys.push(y)
      }
    }
    const lines = cluster(ys)
    record.pdfLines = lines.length
    if (lines.length >= 1) {
      record.lines = lines.length
      record.lineSrc = 'pdf'
      const extra = record.before + record.after
      record.contentPt = Math.max(lines.length * record.editLine, record.imagePt ?? 0)
      record.editPt = record.contentPt + extra
    }
  }
}

function gapLine(records) {
  let n = 0
  let gap = 0
  let expected = 0
  let crosses = 0
  for (let i = 1; i < records.length; i++) {
    const prev = records[i - 1]
    const next = records[i]
    const prevBox = prev.fragments?.[prev.fragments.length - 1]
    const nextBox = next.fragments?.[0]
    if (!prevBox || !nextBox) continue
    if (prevBox.page !== nextBox.page) {
      crosses += 1
      continue
    }
    n += 1
    const found = nextBox.y - (prevBox.y + prevBox.height)
    const want = Math.max(prev.after ?? 0, next.before ?? 0)
    gap += found
    expected += want
  }
  return `gaps samePage=${n} gap=${fmt(gap)} collapsed=${fmt(expected)} delta=${fmt(gap - expected)} pageCross=${crosses}`
}

function breakLine(records) {
  const indexes = []
  for (const record of records) {
    if ((record.pageBreaks ?? 0) > 0) indexes.push(record.index)
  }
  const shown = indexes.slice(0, 40).join(',')
  return `pageBreakAtoms n=${indexes.length} indexes=${shown || 'none'}${indexes.length > 40 ? ',…' : ''}`
}

function simLine(label, records, honorBreaks, contentOf) {
  let page = 0
  let y = 0
  let prevAfter = 0
  let differ = 0
  let first = null
  let known = 0
  for (const record of records) {
    const body = record.bodyHeight > 0 ? record.bodyHeight : 648
    const content = contentOf(record)
    const before = record.before ?? 0
    const after = record.after ?? 0
    const measured = (typeof content === 'number' ? content : 0) + before + after
    const atTop = y <= 0.5
    if (!atTop) {
      const skip = Math.min(before, Math.max(0, prevAfter))
      const advance = Math.max(0, measured - skip)
      if (y + advance > body + 0.75) {
        page += 1
        y = Math.max(0, measured - before)
      } else y += advance
    } else y = Math.max(0, measured - before)
    if (typeof record.firstPage === 'number') {
      known += 1
      if (record.firstPage !== page) {
        differ += 1
        if (first === null) first = record.index
      }
    }
    if (honorBreaks && (record.pageBreaks ?? 0) > 0) {
      page += 1
      y = 0
      prevAfter = 0
    } else prevAfter = after
    if (record.sectionBreak && record.sectionBreak !== 'continuous') {
      page += 1
      y = 0
      prevAfter = 0
    }
  }
  const pages = y > 0.5 ? page + 1 : page
  return `${label} editPages=${pages} firstDiff=${first === null ? 'none' : first} differ=${differ} known=${known}`
}

function linePitch(pages, margins, label, flip) {
  const useFlip = typeof flip === 'boolean' ? flip : flipWithBodyLines(pages, margins)
  const deltas = []
  const top = margins?.top ?? 72
  const bottomCut = margins?.bottom ?? 72
  for (const page of pages) {
    const lines = cluster(
      page.words
        .map((word) => wordY(word, page.height, { flip: useFlip, shift: 0 }))
        .filter((y) => y >= top - 4 && y <= page.height - bottomCut + 4),
    )
    for (let i = 1; i < lines.length; i++) deltas.push(lines[i] - lines[i - 1])
  }
  const lineDeltas = deltas.filter((delta) => delta >= 4 && delta <= 40)
  const med = median(lineDeltas)
  return { line: `${label} flip=${useFlip ? 1 : 0} n=${lineDeltas.length} median=${fmt(med)}`, hist: histText(deltas) }
}

function flipWithBodyLines(pages, margins) {
  const upright = bandDeltas(pages, margins, false)
  const flipped = bandDeltas(pages, margins, true)
  return flipped > upright
}

function bandDeltas(pages, margins, flip) {
  const top = margins?.top ?? 72
  const bottomCut = margins?.bottom ?? 72
  let count = 0
  for (const page of pages) {
    const lines = cluster(
      page.words
        .map((word) => wordY(word, page.height, { flip, shift: 0 }))
        .filter((y) => y >= top - 4 && y <= page.height - bottomCut + 4),
    )
    for (let i = 1; i < lines.length; i++) {
      const delta = lines[i] - lines[i - 1]
      if (delta >= 8 && delta <= 36) count += 1
    }
  }
  return count
}

function wordY(word, pageHeight, mode) {
  const center = (word.yMin + word.yMax) / 2
  const y = mode.flip ? pageHeight - center : center
  return y
}

function fragmentsOn(records, page) {
  const out = []
  for (const record of records) {
    for (const fragment of record.fragments ?? []) {
      if (fragment.page === page) out.push(fragment)
    }
  }
  return out
}

function cluster(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  const lines = []
  for (const y of sorted) {
    const last = lines[lines.length - 1]
    if (last && y - last < 2.5) lines[lines.length - 1] = (last + y) / 2
    else lines.push(y)
  }
  return lines
}

function histText(deltas) {
  const counts = new Map()
  for (const delta of deltas) {
    if (!(delta >= 2 && delta <= 160)) continue
    const key = Math.round(delta * 2) / 2
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 8)
    .map(([key, count]) => `${fmt(key)}:${count}`)
    .join(' ')
}

function bboxPages(path) {
  const xml = poppler('pdftotext', ['-bbox', '-enc', 'UTF-8', path, '-'])
  const pages = []
  const pageRe = /<page\b([^>]*)>([\s\S]*?)<\/page>/g
  let match
  while ((match = pageRe.exec(xml))) {
    const pageAttrs = attrsOf(match[1] ?? '')
    const height = Number(pageAttrs.height)
    const words = []
    const wordRe = /<word\b([^>]*)>/g
    let word
    const inner = match[2] ?? ''
    while ((word = wordRe.exec(inner))) {
      const attrs = attrsOf(word[1] ?? '')
      const yMin = Number(attrs.yMin)
      const yMax = Number(attrs.yMax)
      if (Number.isFinite(yMin) && Number.isFinite(yMax)) words.push({ yMin, yMax })
    }
    pages.push({ height, words })
  }
  return pages
}

function pdfPages(path) {
  const info = poppler('pdfinfo', [path])
  const line = info.split('\n').find((item) => item.startsWith('Pages:'))
  return line ? Number(line.slice('Pages:'.length).trim()) : null
}

function poppler(tool, args) {
  return execFileSync(join(POPPLER, tool), args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function referencePdf(path) {
  const env = process.env.WORD_TEST_REF_PDF
  if (env && process.env.WORD_TEST_DOC && resolve(process.env.WORD_TEST_DOC) === path && existsSync(env)) return env
  const sibling = path.replace(/\.docx$/i, '.pdf')
  if (sibling !== path && existsSync(sibling)) return sibling
  return null
}

function alignNodes(children, body) {
  const nodes = []
  for (const child of children) {
    const kind = xmlKind(child)
    if (kind === 'skip') continue
    nodes.push({ kind, node: child })
  }
  const tables = nodes.filter((item) => item.kind === 'table').map((item) => item.node)
  const ok = nodes.length === body.length && nodes.every((item, index) => item.kind === blockKind(body[index]))
  let reason = 'ok'
  if (!ok) {
    const xmlCounts = countKinds(nodes.map((item) => item.kind))
    const bodyCounts = countKinds(body.map((block) => blockKind(block)))
    reason = `xml ${xmlCounts} body ${bodyCounts}`
  }
  return { ok, nodes: nodes.map((item) => item.node), tables, reason }
}

function xmlKind(node) {
  if (node.name === 'p') return 'paragraph'
  if (node.name === 'tbl') return 'table'
  if (node.name === 'sdt') return 'opaque'
  if (node.name === 'sectPr') return 'skip'
  return 'opaque'
}

function blockKind(block) {
  if (block?.kind === 'p') return 'paragraph'
  if (block?.kind === 'table') return 'table'
  return 'opaque'
}

function countKinds(kinds) {
  const counts = new Map()
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1)
  return [...counts.entries()].map(([kind, count]) => `${kind}:${count}`).join('/')
}

function xmlRows(table) {
  return (table.children ?? [])
    .filter((child) => child.name === 'tr')
    .map((row) => {
      const height = findChild(findChild(row, 'trPr'), 'trHeight')
      if (!height) return { rule: 'auto', pt: null }
      const rule = attr(height, 'hRule') || 'atLeast'
      return { rule, pt: twips(attr(height, 'val')) }
    })
}

function cellMarginsOf(table) {
  const margin = findChild(findChild(table, 'tblPr'), 'tblCellMar')
  if (!margin) return null
  return edges(margin)
}

function edges(margin) {
  const top = edgePt(findChild(margin, 'top'))
  const right = edgePt(findChild(margin, 'right'))
  const bottom = edgePt(findChild(margin, 'bottom'))
  const left = edgePt(findChild(margin, 'left'))
  if (top === null && right === null && bottom === null && left === null) return null
  return { top: top ?? 0, right: right ?? 0, bottom: bottom ?? 0, left: left ?? 0 }
}

function edgePt(node) {
  if (!node) return null
  const type = attr(node, 'type') || 'dxa'
  const value = Number(attr(node, 'w'))
  if (!Number.isFinite(value)) return null
  if (type === 'nil') return 0
  if (type === 'dxa') return value / 20
  return null
}

function snapOf(para) {
  const snap = findChild(findChild(para, 'pPr'), 'snapToGrid')
  if (!snap) return 'absent'
  const value = attr(snap, 'val')
  if (value === null || value === '1' || value === 'true' || value === 'on') return '1'
  if (value === '0' || value === 'false' || value === 'off') return '0'
  return value
}

function parseXml(xml) {
  const root = { name: '#', attrs: {}, children: [] }
  const stack = [root]
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/[^>]+>|<[^>]+>/g
  let match
  while ((match = re.exec(xml))) {
    const tok = match[0]
    if (tok.startsWith('<!--') || tok.startsWith('<![') || tok.startsWith('<?')) continue
    if (tok.startsWith('</')) {
      if (stack.length > 1) stack.pop()
      continue
    }
    const self = /\/>$/.test(tok)
    const name = local(tok.slice(1).split(/[\s/>]/)[0] ?? '')
    const node = { name, attrs: attrsOf(tok), children: [] }
    stack[stack.length - 1]?.children.push(node)
    if (!self) stack.push(node)
  }
  return root
}

function attrsOf(source) {
  const out = {}
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let match
  while ((match = re.exec(source))) {
    out[local(match[1] ?? '')] = match[2] ?? match[3] ?? ''
  }
  return out
}

function attr(node, name) {
  if (!node) return null
  const value = node.attrs?.[name]
  return value === undefined || value === '' ? null : value
}

function editOf(record) {
  return typeof record.baseEditPt === 'number' ? record.baseEditPt : record.editPt
}

function findDescendant(node, name) {
  if (!node) return null
  if (node.name === name) return node
  for (const child of node.children ?? []) {
    const found = findDescendant(child, name)
    if (found) return found
  }
  return null
}

function findChild(node, name) {
  if (!node?.children) return null
  for (const child of node.children) {
    if (child.name === name) return child
  }
  return null
}

function collect(node, name, out = []) {
  if (!node) return out
  if (node.name === name) out.push(node)
  for (const child of node.children ?? []) collect(child, name, out)
  return out
}

function local(name) {
  const at = name.lastIndexOf(':')
  return at < 0 ? name : name.slice(at + 1)
}

function twips(value) {
  if (value === null) return null
  const number = Number(value)
  return Number.isFinite(number) ? number / 20 : null
}

function zipNames(path) {
  const listing = execFileSync('unzip', ['-l', path], { encoding: 'utf8' })
  const names = []
  for (const line of listing.split('\n')) {
    const match = line.match(/(?:^|\s)(word\/\S+)\s*$/)
    if (match?.[1]) names.push(match[1])
  }
  return names
}

function zipText(path, name) {
  return execFileSync('unzip', ['-p', path, name], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function countTags(xml, name) {
  const re = new RegExp(`<w:${name}\\b`, 'g')
  return xml.match(re)?.length ?? 0
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function nearMultiple(value, pitch) {
  if (!(pitch > 0) || !Number.isFinite(value)) return false
  const n = Math.round(value / pitch)
  return n >= 1 && Math.abs(value - n * pitch) <= 0.75
}

function share(part, whole) {
  return whole === 0 ? 0 : part / whole
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] ?? null
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

function lineText(line) {
  if (!line || typeof line !== 'object') return 'none'
  if (line.rule === 'auto') return `auto:${fmt(line.multiple)}`
  if (line.rule === 'exact') return `exact:${fmt(line.pt)}`
  if (line.rule === 'atLeast') return `atLeast:${fmt(line.pt)}`
  return 'none'
}

function fmt(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'none'
  return (Math.round(value * 100) / 100).toFixed(2)
}

function svgRulePages(svg) {
  const parts = svg.split('<page>')
  return parts.slice(1).map((page) => {
    const raw = []
    const re = /\bd="([^"]+)"/g
    let match
    while ((match = re.exec(page))) {
      const nums = (match[1].match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
      if (nums.length < 4 || nums.length > 8) continue
      const xs = []
      const ys = []
      for (let i = 0; i < nums.length; i += 2) {
        xs.push(nums[i] ?? 0)
        ys.push(nums[i + 1] ?? 0)
      }
      const width = Math.max(...xs) - Math.min(...xs)
      const height = Math.max(...ys) - Math.min(...ys)
      if (height < 0.8 && width >= 30) raw.push({ y: Math.min(...ys), w: width })
    }
    raw.sort((a, b) => a.y - b.y || b.w - a.w)
    const lines = []
    for (const rule of raw) {
      const last = lines[lines.length - 1]
      if (last && Math.abs(rule.y - last.y) < 0.6) last.ws.push(rule.w)
      else lines.push({ y: rule.y, ws: [rule.w] })
    }
    return lines.map((line) => ({ y: line.y, w: Math.max(...line.ws) }))
  })
}

function fragmentRules(model, pages) {
  const lines = []
  for (const record of model.records) {
    if (!rowIndexes.has(record.index)) continue
    const fragments = record.fragments ?? []
    lines.push(
      `frag b=${record.index} n=${fragments.length} h=${fmt(record.print)} ${fragments
        .map((fragment) => `p${fragment.page}@${fmt(fragment.y)}+${fmt(fragment.height)}`)
        .join(' ')}`,
    )
    const gaps = []
    for (const fragment of fragments) {
      const page = pages[fragment.page] ?? []
      const inside = page.filter((rule) => rule.y >= fragment.y - 1.5 && rule.y <= fragment.y + fragment.height + 1.5)
      const wide = inside.filter((rule) => rule.w >= 40)
      const ys = wide.map((rule) => rule.y)
      const deltas = []
      for (let i = 1; i < ys.length; i++) deltas.push(ys[i] - ys[i - 1])
      gaps.push(...deltas)
      lines.push(
        `rules b=${record.index} p=${fragment.page} n=${wide.length} span=${fmt(deltas.reduce((sum, value) => sum + value, 0))} d=${deltas.map((value) => fmt(value)).join(',')}`,
      )
    }
    lines.push(`rulesum b=${record.index} gaps=${fmt(gaps.reduce((sum, value) => sum + value, 0))} n=${gaps.length}`)
  }
  return lines
}
