import { flatText } from '../model.ts'
import type {
  Block,
  Cell,
  Doc,
  Marks,
  MediaKey,
  NumId,
  ParaId,
  ParaLook,
  ParaProps,
  Paragraph,
  Pos,
  Pt,
  Row,
  RunLook,
  Section,
  StyleId,
  Table,
  TableId,
} from '../model.ts'
import { listMarkers } from './derive.ts'
import { PageView } from './pages.ts'
import type { RenderContext } from './render.ts'
import './view.css'

const NORMAL = 'Normal' as StyleId
const HEADING = 'Heading1' as StyleId
const TITLE = 'Title' as StyleId
const LIST = 1 as NumId
const MEDIA = 'fig1' as MediaKey
const TABLE = 't1' as TableId

const UNIT = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏 river layout '
const CORPUS = UNIT.repeat(400)

const IMAGE_URL =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#d5e4f2"/><rect x="8" y="8" width="144" height="74" fill="none" stroke="#3d5a73"/></svg>',
  )

function pt(n: number): Pt {
  return n as Pt
}

function take(seed: number, count: number): string {
  const span = CORPUS.length - count
  const start = span <= 0 ? 0 : Math.abs(seed * 97) % span
  return CORPUS.slice(start, start + count)
}

function textRun(text: string): Paragraph['inlines'][number] {
  return { kind: 'text', text, marks: {}, src: null }
}

function paragraph(id: ParaId, props: ParaProps, inlines: Paragraph['inlines']): Paragraph {
  return { kind: 'p', id, src: null, props, inlines, lock: null, sectionEnd: null }
}

function lookOf(para: Paragraph, marks: Marks): RunLook {
  const style = para.props.style
  const title = style === TITLE
  const heading = style === HEADING
  return {
    fonts: {
      ascii: 'Times New Roman',
      hAnsi: 'Times New Roman',
      eastAsia: title || heading ? 'SimHei' : 'SimSun',
      cs: 'Times New Roman',
    },
    sizePt: marks.sizePt ?? pt(title ? 22 : heading ? 16 : 10.5),
    bold: marks.bold ?? (title || heading),
    italic: marks.italic ?? false,
    underline: marks.underline ?? false,
    strike: marks.strike ?? false,
    color: marks.color ?? 'auto',
    ...(marks.highlight ? { highlight: marks.highlight } : {}),
    caps: false,
    charSpacingPt: pt(0),
  }
}

function paraLookOf(para: Paragraph): ParaLook {
  const style = para.props.style
  const title = style === TITLE
  const heading = style === HEADING
  const numbering = para.props.numbering ?? null
  const level = numbering?.level ?? 0
  const indent = para.props.indent
  const spacing = para.props.spacing
  return {
    align: para.props.align ?? (title ? 'center' : 'left'),
    indent: {
      left: indent?.left ?? (numbering ? pt(level === 0 ? 28 : 56) : pt(0)),
      right: indent?.right ?? pt(0),
      firstLine: indent?.firstLine ?? pt(0),
      hanging: indent?.hanging ?? (numbering ? pt(21) : pt(0)),
      firstLineChars: indent?.firstLineChars ?? (numbering || heading || title ? 0 : 200),
    },
    spacing: {
      before: spacing?.before ?? (heading ? pt(14) : pt(0)),
      after: spacing?.after ?? (heading ? pt(6) : title ? pt(12) : pt(0)),
      line: spacing?.line ?? { rule: 'auto', multiple: 1 },
      contextual: false,
    },
    numbering,
    keepNext: para.props.keepNext ?? heading,
    keepLines: para.props.keepLines ?? false,
    pageBreakBefore: para.props.pageBreakBefore ?? false,
    widowControl: para.props.widowControl ?? true,
  }
}

function fontStack(family: string): string {
  if (family === 'SimSun' || family === '宋体') return '"SimSun","Songti SC","STSong",serif'
  if (family === 'SimHei' || family === '黑体') return '"SimHei","Heiti SC","STHeiti","PingFang SC",sans-serif'
  if (family === 'Times New Roman') return '"Times New Roman","Liberation Serif",serif'
  return `"${family}",serif`
}

function lineHeightPx(_family: string, sizePt: Pt, rule: ParaLook['spacing']['line']): number {
  const sizePx = (sizePt as number) * (4 / 3)
  const base = sizePx * 1.3
  if (rule.rule === 'exact') return (rule.pt as number) * (4 / 3)
  if (rule.rule === 'atLeast') return Math.max(base, (rule.pt as number) * (4 / 3))
  return base * rule.multiple
}

const ctx: RenderContext = {
  look: lookOf,
  paraLook: paraLookOf,
  fontStack,
  lineHeightPx,
  marker: (id) => markers.get(id) ?? null,
  imageUrl: (key) => (key === MEDIA ? IMAGE_URL : ''),
  gridPitchPx: null,
}

const markers = new Map<string, string>()

interface Built {
  doc: Doc
  benchId: ParaId
  laterId: ParaId
  straddleId: ParaId
}

function sectionA4(): Section {
  const edge = pt(72)
  return {
    src: null,
    page: {
      widthPt: pt(595.3),
      heightPt: pt(841.9),
      margin: { top: edge, right: edge, bottom: edge, left: edge, header: pt(36), footer: pt(36), gutter: pt(0) },
    },
    breakType: 'nextPage',
    titlePage: false,
    headers: {},
    footers: {},
    grid: null,
  }
}

function buildDoc(): Built {
  const blocks: Block[] = []
  let n = 0
  const pid = (): ParaId => {
    n += 1
    return `p${n}` as ParaId
  }
  const add = (props: ParaProps, inlines: Paragraph['inlines']): Paragraph => {
    const para = paragraph(pid(), props, inlines)
    blocks.push(para)
    return para
  }

  add({ style: TITLE, align: 'center' }, [textRun('页面视图演示 Document view')])

  let benchId: ParaId | null = null
  let straddleId: ParaId | null = null
  let specials = false
  for (let i = 0; i < 1600; i++) {
    if (!specials && blocks.length >= 240) {
      const listed = addList()
      for (const item of listed) blocks.push(item)
      blocks.push(imageParagraph(pid()))
      add({ style: NORMAL, pageBreakBefore: true }, [textRun(`强制分页 ${take(9000, 240)}`)])
      const firstLong = add({ style: NORMAL }, [textRun(`跨页长段甲 ${take(3, 8000)}`)])
      straddleId = firstLong.id
      add({ style: NORMAL }, [textRun(`跨页长段乙 ${take(11, 8000)}`)])
      add({ style: NORMAL }, [textRun(`跨页长段丙 ${take(19, 8000)}`)])
      blocks.push(wideTable())
      specials = true
    }
    if (i % 15 === 0) {
      const headingNo = i / 15 + 1
      add({ style: HEADING, keepNext: true }, [textRun(`第${headingNo}节 标题 Heading ${headingNo}`)])
    }
    const body = add({ style: NORMAL }, [textRun(take(i + 1, 300))])
    if (i === 80) benchId = body.id
  }
  const last = blocks[blocks.length - 1]
  if (!benchId || !straddleId || !last || last.kind !== 'p') throw new Error('demo document is incomplete')
  const doc: Doc = {
    body: blocks,
    sections: [sectionA4()],
    stories: new Map(),
    styles: { paragraph: new Map(), character: new Map(), defaultParagraph: NORMAL, added: [] },
    lists: {
      byNum: new Map([
        [
          LIST,
          {
            fresh: true,
            levels: [
              { format: 'decimal', text: '%1.', start: 1, indentLeft: pt(28), hanging: pt(21) },
              { format: 'decimal', text: '%1.%2', start: 1, indentLeft: pt(56), hanging: pt(21) },
            ],
          },
        ],
      ]),
    },
    media: { byKey: new Map([[MEDIA, { contentType: 'image/svg+xml', origin: 'added' }]]) },
  }
  return { doc, benchId, laterId: last.id, straddleId }
}

function addList(): Paragraph[] {
  const items: Paragraph[] = []
  let n = 0
  const push = (level: number, marker: string, text: string): void => {
    n += 1
    const id = `list${n}` as ParaId
    markers.set(id, marker)
    items.push(
      paragraph(id, { style: NORMAL, numbering: { num: LIST, level } }, [textRun(text)]),
    )
  }
  for (let i = 1; i <= 4; i++) {
    push(0, `${i}.`, `条目 ${i} first level item`)
    for (let k = 1; k <= 2; k++) push(1, `${i}.${k}`, `子项 ${i}.${k} second level`)
  }
  return items
}

function imageParagraph(id: ParaId): Paragraph {
  return paragraph(id, { style: NORMAL, align: 'left' }, [
    textRun('插图 '),
    { kind: 'atom', atom: { type: 'image', media: MEDIA, widthPt: pt(160), heightPt: pt(90) }, src: null },
    textRun(' '),
    { kind: 'atom', atom: { type: 'opaque', label: '式', display: 'a²+b²', removable: true }, src: null },
    textRun(' 说明 illustration'),
  ])
}

function cellPara(id: ParaId, text: string): Paragraph {
  return paragraph(id, { style: NORMAL, indent: { firstLineChars: 0 }, widowControl: false }, [textRun(text)])
}

function wideTable(): Table {
  const cols = 6
  const rows = 4
  const grid = Array.from({ length: cols }, () => pt(75))
  const built: Row[] = []
  for (let r = 0; r < rows; r++) {
    const header = r === 0
    const cells: Cell[] = []
    for (let c = 0; c < cols; c++) {
      const text = header ? `列${c + 1}` : take(1000 + r * 10 + c, 180)
      cells.push({
        src: null,
        span: 1,
        vMerge: null,
        shading: header ? ('F4F4F4' as Cell['shading']) : undefined,
        blocks: [cellPara(`cell-${r}-${c}` as ParaId, text)],
      })
    }
    built.push({
      src: null,
      props: { header, cantSplit: true },
      cells,
    })
  }
  return { kind: 'table', id: TABLE, src: null, props: { align: 'left' }, grid, rows: built }
}

interface RoundTrip {
  samples: number
  exact: number
  equivalent: number
  miss: number
  examples: { p: string; o: number; hitP: string | null; hitO: number | null }[]
}

interface LineProbe {
  from: { p: string; o: number }
  down: { p: string; o: number }
  back: { p: string; o: number }
  goalX: number
  downX: number
  dx: number
  fromPage: number
  downPage: number
}

interface EditBench {
  p95: number
  before: number
  after: number
  laterBefore: number
  laterAfter: number
  max: number
}

interface StraddleInfo {
  id: string
  page: number
  y0: number
  y1: number
  nextY0: number
}

function rngOf(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function findPara(doc: Doc, id: string): Paragraph | null {
  for (const block of doc.body) {
    if (block.kind === 'p' && block.id === id) return block
    if (block.kind !== 'table') continue
    for (const row of block.rows) {
      for (const cell of row.cells) {
        for (const child of cell.blocks) {
          if (child.kind === 'p' && child.id === id) return child
        }
      }
    }
  }
  return null
}

function replaceText(doc: Doc, id: string, text: string): Doc {
  return {
    ...doc,
    body: doc.body.map((block) => {
      if (block.kind !== 'p' || block.id !== id) return block
      return { ...block, inlines: [textRun(text)] }
    }),
  }
}

function findStraddle(view: PageView, prefer: string): StraddleInfo | null {
  const pages = view.layout.pages
  const found: StraddleInfo[] = []
  for (let i = 0; i < pages.length - 1; i++) {
    const page = pages[i]
    const next = pages[i + 1]
    const last = page?.slices[page.slices.length - 1]
    const first = next?.slices[0]
    if (!last || !first || last.block !== first.block) continue
    if (last.y1 - last.y0 < 8 || first.y1 - first.y0 < 8) continue
    found.push({ id: last.block, page: i, y0: last.y0, y1: last.y1, nextY0: first.y0 })
  }
  return found.find((item) => item.id === prefer) ?? found[0] ?? null
}

function scrollToPage(index: number, fraction: number): void {
  const page = document.querySelector<HTMLElement>(`.page[data-page="${index}"]`)
  const host = document.querySelector<HTMLElement>('.page-view')
  if (!page || !host) return
  const top = page.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop
  host.scrollTop = Math.max(0, top - host.clientHeight * fraction)
}

function centerOf(view: PageView, pos: Pos): { x: number; y: number } | null {
  const caret = view.caretRect(pos)
  const page = document.querySelector<HTMLElement>(`.page[data-page="${caret.page}"]`)
  if (!page || page.offsetWidth === 0 || page.offsetHeight === 0) return null
  const box = page.getBoundingClientRect()
  return {
    x: box.left + caret.x * (box.width / page.offsetWidth),
    y: box.top + (caret.top + caret.height / 2) * (box.height / page.offsetHeight),
  }
}

function wrapEquivalent(view: PageView, from: Pos, hit: Pos): boolean {
  if (hit.p !== from.p || Math.abs(hit.o - from.o) !== 1) return false
  const a = view.caretRect(from)
  const b = view.caretRect(hit)
  const ay = a.top + a.height / 2
  const by = b.top + b.height / 2
  return a.page !== b.page || Math.abs(ay - by) > Math.min(a.height, b.height) * 0.6
}

export function startViewDemo(): void {
  document.documentElement.style.height = '100%'
  document.body.style.margin = '0'
  document.body.style.height = '100%'
  document.body.style.overflow = 'hidden'
  document.body.replaceChildren()
  const host = document.createElement('div')
  host.id = 'view-demo'
  host.style.height = '100%'
  host.style.width = '100%'
  document.body.append(host)

  const built = buildDoc()
  let doc = built.doc
  const view = new PageView(host, () => ctx)
  view.show(doc)
  const firstPageMs = performance.now()

  const api = {
    view,
    get doc() {
      return doc
    },
    firstPageMs,
    benchId: built.benchId,
    laterId: built.laterId,
    straddleId: built.straddleId,
    flat(id: string): string {
      const para = findPara(doc, id)
      return para ? flatText(para) : ''
    },
    roundTrip(n: number): RoundTrip {
      const random = rngOf(42)
      const pool: { id: ParaId; length: number }[] = []
      for (const page of document.querySelectorAll<HTMLElement>('.page[data-mounted="1"]')) {
        for (const el of page.querySelectorAll<HTMLElement>('.blk.p')) {
          if (el.closest('.repeat-head')) continue
          const id = el.dataset.id
          if (!id) continue
          const para = findPara(doc, id)
          if (!para) continue
          const text = flatText(para)
          if (text.length < 8 || text.includes('\uFFFC')) continue
          pool.push({ id: para.id, length: text.length })
        }
      }
      const result: RoundTrip = { samples: 0, exact: 0, equivalent: 0, miss: 0, examples: [] }
      if (pool.length === 0) return result
      for (let i = 0; i < n; i++) {
        const item = pool[Math.floor(random() * pool.length)]
        if (!item) continue
        const pos: Pos = { p: item.id, o: 1 + Math.floor(random() * (item.length - 2)) }
        const point = centerOf(view, pos)
        const hit = point ? view.posAtPoint(point.x, point.y) : null
        result.samples += 1
        if (hit && hit.p === pos.p && hit.o === pos.o) result.exact += 1
        else if (hit && wrapEquivalent(view, pos, hit)) result.equivalent += 1
        else {
          result.miss += 1
          if (result.examples.length < 8) {
            result.examples.push({ p: pos.p, o: pos.o, hitP: hit?.p ?? null, hitO: hit?.o ?? null })
          }
        }
      }
      return result
    },
    lineProbe(): LineProbe {
      const info = findStraddle(view, built.straddleId)
      if (!info) throw new Error('no straddling paragraph')
      const para = findPara(doc, info.id)
      if (!para) throw new Error('straddle paragraph missing')
      scrollToPage(info.page + 1, 0.45)
      const length = flatText(para).length
      let lo = 0
      let hi = length
      let last = 0
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (view.pageOf({ p: para.id, o: mid }) <= info.page) {
          last = mid
          lo = mid + 1
        } else hi = mid - 1
      }
      const origin = view.caretRect({ p: para.id, o: last })
      let edge = last
      while (edge > 0) {
        const prev = view.caretRect({ p: para.id, o: edge - 1 })
        if (prev.page !== origin.page || Math.abs(prev.top - origin.top) > 2) break
        edge -= 1
      }
      let o = edge
      while (o < last) {
        const caret = view.caretRect({ p: para.id, o })
        if (caret.x >= 48) break
        o += 1
      }
      const from: Pos = { p: para.id, o }
      const caret = view.caretRect(from)
      const down = view.lineMove(from, 'down', caret.x)
      const downCaret = view.caretRect(down.pos)
      const back = view.lineMove(down.pos, 'up', down.goalX)
      return {
        from: { p: from.p, o: from.o },
        down: { p: down.pos.p, o: down.pos.o },
        back: { p: back.pos.p, o: back.pos.o },
        goalX: caret.x,
        downX: downCaret.x,
        dx: Math.abs(downCaret.x - caret.x),
        fromPage: caret.page,
        downPage: downCaret.page,
      }
    },
    editBench(): EditBench {
      if (!view.layout.complete) throw new Error(`layout is incomplete (${view.layout.pages.length} pages)`)
      const before = view.layout.pages.length
      const laterBefore = view.pageOf({ p: built.laterId, o: 0 })
      const base = flatText(findPara(doc, built.benchId) ?? paragraph(built.benchId, {}, [textRun('x')]))
      const times: number[] = []
      for (let i = 1; i <= 50; i++) {
        const next = replaceText(doc, built.benchId, base + '测'.repeat(i * 56))
        const started = performance.now()
        view.update(doc, next, listMarkers(doc), listMarkers(next))
        times.push(performance.now() - started)
        doc = next
      }
      times.sort((a, b) => a - b)
      const index = Math.ceil(0.95 * times.length) - 1
      return {
        p95: times[index] ?? 0,
        max: times[times.length - 1] ?? 0,
        before,
        after: view.layout.pages.length,
        laterBefore,
        laterAfter: view.pageOf({ p: built.laterId, o: 0 }),
      }
    },
    straddle(): StraddleInfo {
      const info = findStraddle(view, built.straddleId)
      if (!info) throw new Error('no straddling paragraph')
      return info
    },
    revealStraddle(): StraddleInfo {
      const info = api.straddle()
      scrollToPage(info.page + 1, 0.45)
      return info
    },
  }
  window.__demo = api
  window.__viewFirstPageMs = firstPageMs
}

declare global {
  interface Window {
    __demo: {
      view: PageView
      readonly doc: Doc
      firstPageMs: number
      benchId: string
      laterId: string
      straddleId: string
      flat(id: string): string
      roundTrip(n: number): RoundTrip
      lineProbe(): LineProbe
      editBench(): EditBench
      straddle(): StraddleInfo
      revealStraddle(): StraddleInfo
    }
    __viewFirstPageMs: number
  }
}
