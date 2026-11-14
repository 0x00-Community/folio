// One alias table for font families, shared by the page (CSS stacks) and the font service (which file to serve).

export const FAMILY_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  ['simsun', ['SimSun', '宋体', 'Songti SC', 'STSong', 'Noto Serif CJK SC', 'Source Han Serif SC']],
  ['宋体', ['SimSun', '宋体', 'Songti SC', 'STSong', 'Noto Serif CJK SC', 'Source Han Serif SC']],
  ['simhei', ['SimHei', 'Heiti SC', 'PingFang SC', 'Noto Sans CJK SC', '黑体', 'STHeiti']],
  ['黑体', ['SimHei', 'Heiti SC', 'PingFang SC', 'Noto Sans CJK SC', '黑体', 'STHeiti']],
  ['kaiti', ['KaiTi', 'Kaiti SC', '楷体', 'STKaiti']],
  ['楷体', ['KaiTi', 'Kaiti SC', '楷体', 'STKaiti']],
  ['fangsong', ['FangSong', 'STFangsong', '仿宋']],
  ['仿宋', ['FangSong', 'STFangsong', '仿宋']],
  ['仿宋_gb2312', ['FangSong', 'STFangsong', 'FangSong_GB2312', '仿宋_GB2312', '仿宋']],
  ['microsoft yahei', ['Microsoft YaHei', 'PingFang SC', '微软雅黑', 'Noto Sans CJK SC']],
  ['微软雅黑', ['Microsoft YaHei', 'PingFang SC', '微软雅黑', 'Noto Sans CJK SC']],
  ['等线', ['DengXian', 'PingFang SC', '等线']],
  ['dengxian', ['DengXian', 'PingFang SC', '等线']],
  ['times new roman', ['Times New Roman', 'Liberation Serif', 'Tinos']],
  ['calibri', ['Calibri', 'Carlito']],
  ['cambria', ['Cambria', 'Caladea']],
  ['arial', ['Arial', 'Liberation Sans', 'Arimo']],
  ['courier new', ['Courier New', 'Liberation Mono']],
])

/** Ordered substitutes for a Word family. The first installed face wins. */
export function aliasChain(family: string): readonly string[] {
  const trimmed = family.trim()
  const key = trimmed.toLowerCase()
  const direct = FAMILY_ALIASES.get(key)
  if (direct !== undefined) return direct
  for (const chain of FAMILY_ALIASES.values()) {
    if (chain.some((name) => name.toLowerCase() === key)) return chain
  }
  return trimmed === '' ? [] : [trimmed]
}

function cssFamily(name: string): string {
  if (/[^\x21-\x7e]|["'\\]/.test(name)) return `"${name.replaceAll('"', '\\"')}"`
  return name
}

/** CSS font-family list for a requested family, ending in a generic family. */
export function cssStack(family: string, generic: 'serif' | 'sans-serif'): string {
  const seen = new Set<string>()
  const names: string[] = []
  for (const name of aliasChain(family)) {
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    names.push(cssFamily(name))
  }
  names.push(generic)
  return names.join(', ')
}

export type FontMetrics = {
  readonly unitsPerEm: number
  readonly winAscent: number
  readonly winDescent: number
  readonly typoAscender: number
  readonly typoDescender: number
  readonly typoLineGap: number
  readonly hheaAscender: number
  readonly hheaDescender: number
  readonly hheaLineGap: number
}

type ResolvedFace = {
  id: string
  family: string
  faceIndex: number
  metrics: {
    unitsPerEm: number
    ascender: number
    descender: number
    lineGap: number
    winAscent?: number
    winDescent?: number
    typoAscender?: number
    typoDescender?: number
    typoLineGap?: number
    hheaAscender?: number
    hheaDescender?: number
    hheaLineGap?: number
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isResolved(value: unknown): value is ResolvedFace {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.family !== 'string') return false
  if (typeof value.faceIndex !== 'number' || !isRecord(value.metrics)) return false
  const metrics = value.metrics
  return (
    typeof metrics.unitsPerEm === 'number' &&
    typeof metrics.ascender === 'number' &&
    typeof metrics.descender === 'number' &&
    typeof metrics.lineGap === 'number'
  )
}

async function resolveFamily(family: string): Promise<ResolvedFace | undefined> {
  const response = await fetch(`/api/fonts/resolve?family=${encodeURIComponent(family)}`)
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`font resolve ${family}: ${response.status}`)
  const body: unknown = await response.json()
  if (!isResolved(body)) throw new Error(`font resolve ${family}: unexpected response`)
  return body
}

/** Fetches one standalone face per family that resolves. Missing families are omitted. */
export async function fetchFonts(families: readonly string[]): Promise<ReadonlyMap<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>()
  for (const family of families) {
    const resolved = await resolveFamily(family)
    if (resolved === undefined) continue
    const response = await fetch(`/api/fonts/${encodeURIComponent(resolved.id)}/face`)
    if (!response.ok) throw new Error(`font face ${family}: ${response.status}`)
    out.set(family, new Uint8Array(await response.arrayBuffer()))
  }
  return out
}

function metric(resolved: ResolvedFace, name: keyof ResolvedFace['metrics'], fallback: number): number {
  const value = resolved.metrics[name]
  return typeof value === 'number' ? value : fallback
}

/** Units and the vertical metrics the resolver read. The honored triple fills any slot the response omits. */
export async function fetchMetrics(families: readonly string[]): Promise<ReadonlyMap<string, FontMetrics>> {
  const out = new Map<string, FontMetrics>()
  for (const family of families) {
    const resolved = await resolveFamily(family)
    if (resolved === undefined) continue
    const { ascender, descender, lineGap, unitsPerEm } = resolved.metrics
    out.set(family, {
      unitsPerEm,
      winAscent: metric(resolved, 'winAscent', Math.abs(ascender)),
      winDescent: metric(resolved, 'winDescent', Math.abs(descender)),
      typoAscender: metric(resolved, 'typoAscender', ascender),
      typoDescender: metric(resolved, 'typoDescender', descender),
      typoLineGap: metric(resolved, 'typoLineGap', lineGap),
      hheaAscender: metric(resolved, 'hheaAscender', ascender),
      hheaDescender: metric(resolved, 'hheaDescender', descender),
      hheaLineGap: metric(resolved, 'hheaLineGap', lineGap),
    })
  }
  return out
}
