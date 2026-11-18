// Pure derivations the facade paints from: list markers, line heights, the document grid. No DOM.
import { aliasChain } from '../fonts.ts'
import type { FontMetrics } from '../fonts.ts'
import { newParaId } from '../model.ts'
import type {
  Block,
  Doc,
  LineSpacing,
  ListDef,
  ListLevel,
  NumId,
  Paragraph,
  ParaId,
  Pt,
} from '../model.ts'
import { PT_TO_PX } from './render.ts'

const markerCache = new WeakMap<Doc, ReadonlyMap<ParaId, string>>()

const SANS: ReadonlySet<string> = new Set([
  'simhei',
  '黑体',
  'heiti sc',
  'stheiti',
  'pingfang sc',
  'noto sans cjk sc',
  'microsoft yahei',
  '微软雅黑',
  'dengxian',
  '等线',
  'calibri',
  'carlito',
  'arial',
  'liberation sans',
  'arimo',
  'courier new',
  'liberation mono',
])

const DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
const SMALL = ['', '十', '百', '千']
const BIG = ['', '万', '亿', '兆']
const STEMS = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸']
const FALLBACK_RATIO = 1.3

/** CSS generic at the end of a font stack, so a missing face still picks a serif or a sans. */
export function cssGeneric(family: string): 'serif' | 'sans-serif' {
  for (const name of aliasChain(family)) {
    if (SANS.has(name.toLowerCase())) return 'sans-serif'
  }
  return 'serif'
}

/**
 * Word's single-spacing box times the paragraph's spacing rule.
 * `metrics` is the line box the resolver honors (OS/2 typo metrics when USE_TYPO_METRICS is set, otherwise hhea);
 * `descender` is negative. A face that did not resolve uses the 1.3 em box the page view used before metrics existed.
 */
export function lineHeightPx(metrics: FontMetrics | undefined, sizePt: Pt, rule: LineSpacing): number {
  const sizePx = (sizePt as number) * PT_TO_PX
  const base = sizePx * lineBoxRatio(metrics)
  if (rule.rule === 'exact') return (rule.pt as number) * PT_TO_PX
  if (rule.rule === 'atLeast') return Math.max(base, (rule.pt as number) * PT_TO_PX)
  const multiple = Number.isFinite(rule.multiple) && rule.multiple >= 0 ? rule.multiple : 1
  return base * multiple
}

/**
 * One pitch for every section, in px. RenderContext carries a single grid, so a document whose sections disagree
 * does not snap.
 */
export function documentGridPitch(doc: Doc): number | null {
  let pitch: number | null = null
  let seen = false
  for (const section of doc.sections) {
    const grid = section.grid
    const next = grid !== null && (grid.linePitch as number) > 0 ? (grid.linePitch as number) * PT_TO_PX : null
    if (!seen) {
      pitch = next
      seen = true
      continue
    }
    if (next !== pitch) return null
  }
  return pitch
}

/** Marker text keyed by paragraph, counted in document order. Cached on the document object. */
export function listMarkers(doc: Doc): ReadonlyMap<ParaId, string> {
  const cached = markerCache.get(doc)
  if (cached) return cached
  const markers = new Map<ParaId, string>()
  numberBlocks(doc, doc.body, markers)
  // A header that shares a numId must not continue the body list into the margin.
  for (const blocks of doc.stories.values()) numberBlocks(doc, blocks, markers)
  markerCache.set(doc, markers)
  return markers
}

/**
 * `initialState` needs a paragraph to put the caret in. `engine.blank()` imports an empty body, so the facade
 * supplies one empty paragraph in the default style before the first paint.
 */
export function withCaretParagraph(doc: Doc): Doc {
  if (hasParagraph(doc.body)) return doc
  const para: Paragraph = {
    kind: 'p',
    id: newParaId(),
    src: null,
    props: doc.styles.defaultParagraph ? { style: doc.styles.defaultParagraph } : {},
    inlines: [],
    lock: null,
    sectionEnd: null,
  }
  return { ...doc, body: doc.body.concat(para) }
}

function lineBoxRatio(metrics: FontMetrics | undefined): number {
  if (metrics === undefined || !(metrics.unitsPerEm > 0)) return FALLBACK_RATIO
  const box = metrics.ascender - metrics.descender + metrics.lineGap
  if (!(box > 0)) return FALLBACK_RATIO
  return box / metrics.unitsPerEm
}

function hasParagraph(blocks: readonly Block[]): boolean {
  for (const block of blocks) {
    if (block.kind === 'p') return true
    if (block.kind === 'table') {
      for (const row of block.rows) {
        for (const cell of row.cells) {
          if (hasParagraph(cell.blocks)) return true
        }
      }
    } else if (block.preview.length > 0) return true
  }
  return false
}

function eachParagraph(blocks: readonly Block[], visit: (para: Paragraph) => void): void {
  for (const block of blocks) {
    if (block.kind === 'p') visit(block)
    else if (block.kind === 'table') {
      for (const row of block.rows) {
        for (const cell of row.cells) eachParagraph(cell.blocks, visit)
      }
    } else {
      for (const para of block.preview) visit(para)
    }
  }
}

function numberingOf(doc: Doc, para: Paragraph): { num: NumId; level: number } | null {
  if (para.props.numbering === null) return null
  if (para.props.numbering !== undefined) return para.props.numbering
  const style = para.props.style ?? doc.styles.defaultParagraph
  return doc.styles.paragraph.get(style)?.look.numbering ?? null
}

function numberBlocks(doc: Doc, blocks: readonly Block[], markers: Map<ParaId, string>): void {
  const counters = new Map<NumId, number[]>()
  eachParagraph(blocks, (para) => {
    const info = numberingOf(doc, para)
    if (!info) return
    const def = doc.lists.byNum.get(info.num)
    const spec = def?.levels[info.level]
    if (!def || !spec) return
    const values = counters.get(info.num) ?? []
    counters.set(info.num, values)
    while (values.length <= info.level) values.push(0)
    for (let deeper = info.level + 1; deeper < values.length; deeper++) values[deeper] = 0
    const start = spec.start > 0 ? spec.start : 1
    const next = (values[info.level] ?? 0) + 1
    values[info.level] = next < start ? start : next
    const text = markerText(spec, def, values, info.level)
    if (text.length > 0) markers.set(para.id, text)
  })
}

function markerText(spec: ListLevel, def: ListDef, values: readonly number[], level: number): string {
  if (spec.format === 'none') return ''
  if (spec.format === 'bullet') return spec.text.length > 0 ? spec.text : '•'
  const text = substitute(spec.text, def, values)
  if (text.length > 0) return text
  return formatNumber(spec.format, shown(values, def, level))
}

function substitute(template: string, def: ListDef, values: readonly number[]): string {
  let out = ''
  for (let i = 0; i < template.length; i++) {
    const ch = template[i] ?? ''
    const next = template[i + 1]
    if (ch === '%' && next === '%') {
      out += '%'
      i += 1
      continue
    }
    if (ch === '%' && next !== undefined && next >= '1' && next <= '9') {
      const level = Number(next) - 1
      i += 1
      const spec = def.levels[level]
      out += spec ? formatNumber(spec.format, shown(values, def, level)) : ''
      continue
    }
    out += ch
  }
  return out
}

function shown(values: readonly number[], def: ListDef, level: number): number {
  const current = values[level] ?? 0
  if (current > 0) return current
  const start = def.levels[level]?.start ?? 1
  return start > 0 ? start : 1
}

function formatNumber(format: ListLevel['format'], n: number): string {
  switch (format) {
    case 'bullet':
      return '•'
    case 'none':
      return ''
    case 'decimal':
      return String(n)
    case 'lowerLetter':
      return alpha(n, false)
    case 'upperLetter':
      return alpha(n, true)
    case 'lowerRoman':
      return roman(n).toLowerCase()
    case 'upperRoman':
      return roman(n)
    case 'chineseCounting':
      return chinese(n)
    case 'ideographTraditional':
      return stems(n)
    case 'decimalEnclosedCircle':
      return circled(n)
  }
}

// Word repeats the letter (z, aa, bb). It does not count in base 26 (z, aa, ab).
function alpha(n: number, upper: boolean): string {
  if (!Number.isInteger(n) || n <= 0) return String(n)
  const index = (n - 1) % 26
  const reps = Math.floor((n - 1) / 26) + 1
  return String.fromCharCode((upper ? 65 : 97) + index).repeat(reps)
}

function roman(n: number): string {
  if (!Number.isInteger(n) || n <= 0 || n >= 4000) return String(n)
  const parts: readonly (readonly [number, string])[] = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ]
  let out = ''
  let rest = n
  for (const [value, glyph] of parts) {
    while (rest >= value) {
      out += glyph
      rest -= value
    }
  }
  return out
}

function chinese(n: number): string {
  if (!Number.isInteger(n) || n <= 0 || n >= 1e16) return String(n)
  const groups: number[] = []
  let rest = n
  while (rest > 0) {
    groups.push(rest % 10000)
    rest = Math.floor(rest / 10000)
  }
  let out = ''
  for (let g = groups.length - 1; g >= 0; g--) {
    const group = groups[g] ?? 0
    if (group === 0) continue
    if (out.length > 0 && group < 1000) out += '零'
    out += chineseGroup(group, g === groups.length - 1)
    out += BIG[g] ?? ''
  }
  return out
}

function chineseGroup(group: number, leading: boolean): string {
  let out = ''
  let zero = false
  for (let i = 3; i >= 0; i--) {
    const digit = Math.floor(group / 10 ** i) % 10
    if (digit === 0) {
      if (out.length > 0) zero = true
      continue
    }
    if (zero) {
      out += '零'
      zero = false
    }
    const omitOne = leading && out.length === 0 && i === 1 && digit === 1
    out += (omitOne ? '' : DIGITS[digit]) + (SMALL[i] ?? '')
  }
  return out
}

// The ten heavenly stems, then the same letter-style repetition (癸, 甲甲).
function stems(n: number): string {
  if (!Number.isInteger(n) || n <= 0) return String(n)
  const index = (n - 1) % 10
  const reps = Math.floor((n - 1) / 10) + 1
  return (STEMS[index] ?? '').repeat(reps)
}

function circled(n: number): string {
  if (n >= 1 && n <= 20) return String.fromCodePoint(0x245f + n)
  if (n >= 21 && n <= 35) return String.fromCodePoint(0x3251 + (n - 21))
  if (n >= 36 && n <= 50) return String.fromCodePoint(0x32b1 + (n - 36))
  return String(n)
}
