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
  /** Line box the resolver honors. `descender` is negative: OS/2 typo metrics when USE_TYPO_METRICS is set, otherwise hhea. */
  readonly ascender: number
  readonly descender: number
  readonly lineGap: number
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

/** Fetches one standalone face per family that resolves. Missing families are omitted, without a request that 404s. */
export async function fetchFonts(families: readonly string[]): Promise<ReadonlyMap<string, Uint8Array>> {
  const installed = await installedNames()
  const out = new Map<string, Uint8Array>()
  if (installed === null) return out
  for (const family of families) {
    if (!listed(family, installed)) continue
    try {
      const resolved = await resolveFamily(family)
      if (resolved === undefined) continue
      const response = await fetch(`/api/fonts/${encodeURIComponent(resolved.id)}/face`)
      if (!response.ok) continue
      out.set(family, new Uint8Array(await response.arrayBuffer()))
    } catch {
      // One face that fails to read leaves the others usable.
    }
  }
  return out
}

function metric(resolved: ResolvedFace, name: keyof ResolvedFace['metrics'], fallback: number): number {
  const value = resolved.metrics[name]
  return typeof value === 'number' ? value : fallback
}

/**
 * Units and the vertical metrics the resolver read. The honored triple fills any slot the response omits.
 * Families the index does not list are skipped: a 404 for a missing face is a console error, and line height falls back.
 */
export async function fetchMetrics(families: readonly string[]): Promise<ReadonlyMap<string, FontMetrics>> {
  const installed = await installedNames()
  const out = new Map<string, FontMetrics>()
  if (installed === null) return out
  for (const family of families) {
    if (!listed(family, installed)) continue
    try {
      const resolved = await resolveFamily(family)
      if (resolved === undefined) continue
      const { ascender, descender, lineGap, unitsPerEm } = resolved.metrics
      out.set(family, {
        unitsPerEm,
        ascender,
        descender,
        lineGap,
        winAscent: metric(resolved, 'winAscent', Math.abs(ascender)),
        winDescent: metric(resolved, 'winDescent', Math.abs(descender)),
        typoAscender: metric(resolved, 'typoAscender', ascender),
        typoDescender: metric(resolved, 'typoDescender', descender),
        typoLineGap: metric(resolved, 'typoLineGap', lineGap),
        hheaAscender: metric(resolved, 'hheaAscender', ascender),
        hheaDescender: metric(resolved, 'hheaDescender', descender),
        hheaLineGap: metric(resolved, 'hheaLineGap', lineGap),
      })
    } catch {
      // One face that fails to read leaves the others usable.
    }
  }
  return out
}

function listed(family: string, names: ReadonlySet<string>): boolean {
  return aliasChain(family).some((name) => names.has(name.toLowerCase()))
}

let catalogPromise: Promise<unknown> | null = null

/** One read of `GET /api/fonts`. `installedNames` and `installedFamilies` both wait on it. */
function fontCatalog(): Promise<unknown> {
  if (catalogPromise === null) catalogPromise = readFontCatalog()
  return catalogPromise
}

async function readFontCatalog(): Promise<unknown> {
  try {
    const response = await fetch('/api/fonts')
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

function walkFamilies(body: unknown, visit: (name: string) => void): boolean {
  if (!Array.isArray(body)) return false
  for (const item of body) {
    if (!isRecord(item) || !Array.isArray(item.families)) continue
    for (const name of item.families) {
      if (typeof name !== 'string' || name.trim() === '') continue
      visit(name)
    }
  }
  return true
}

/**
 * Family names for the font menu. A name that starts with "." is a system-private face and is left out.
 * The same name in another case keeps the first spelling. The rest is sorted with localeCompare.
 */
export async function installedFamilies(): Promise<readonly string[]> {
  const seen = new Set<string>()
  const names: string[] = []
  const ok = walkFamilies(await fontCatalog(), (name) => {
    const trimmed = name.trim()
    if (trimmed.startsWith('.')) return
    const key = trimmed.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    names.push(trimmed)
  })
  if (!ok) return []
  names.sort((a, b) => a.localeCompare(b))
  return names
}

async function installedNames(): Promise<ReadonlySet<string> | null> {
  const names = new Set<string>()
  const ok = walkFamilies(await fontCatalog(), (name) => {
    names.add(name.toLowerCase())
  })
  if (!ok) return null
  return names
}

/** One face from `GET /api/fonts`. `truetype` is false for a CFF `.otf`. */
export type PrintCatalogFace = {
  readonly id: string
  readonly families: readonly string[]
  readonly bold: boolean
  readonly italic: boolean
  readonly cjk: boolean
  readonly truetype: boolean
  /** OS/2 usWeightClass. Missing means the catalog did not say. */
  readonly weight?: number
}

export type PrintFontPlan = {
  readonly faces: readonly { readonly id: string; readonly family: string }[]
  readonly aliases: readonly [string, string][]
}

/**
 * The session keeps one face per family name, so a bold companion is registered under `${family} Bold`.
 * Layout matches that face by the name and weight stored in the font, not by this key.
 */
export function isPrintBoldKey(family: string): boolean {
  return family.endsWith(' Bold') || family.includes(' Bold ')
}

/**
 * Caller faces for one print. Only CJK TrueType faces, each physical face once.
 * The upright face is the first non-bold, non-italic match, the same face `resolveFont` returns.
 * A bold face of that family is added when the catalog has one, preferring weight 700 over Black.
 * Other requested spellings of the same face become aliases onto the first spelling.
 * `han` adds 宋体 when the document has Han text and no CJK family resolved.
 */
export function printFonts(
  families: readonly string[],
  catalog: readonly PrintCatalogFace[],
  han = false,
): PrintFontPlan {
  const requested: string[] = []
  const seen = new Set<string>()
  for (const family of families) {
    const trimmed = family.trim()
    const key = trimmed.toLowerCase()
    if (trimmed === '' || seen.has(key)) continue
    seen.add(key)
    requested.push(trimmed)
  }
  if (han && !requested.some((family) => resolvedFaces(catalog, family).length > 0) && !seen.has('宋体')) {
    requested.push('宋体')
  }

  const faces: { id: string; family: string }[] = []
  const aliases: [string, string][] = []
  const loadedById = new Map<string, string>()
  const used = new Set<string>()
  for (const family of requested) {
    const matches = resolvedFaces(catalog, family)
    const regular = regularFace(matches)
    if (regular === undefined) continue
    const existing = loadedById.get(regular.id)
    if (existing !== undefined) {
      if (existing !== family) aliases.push([family, existing])
      continue
    }
    const key = claim(family, used)
    loadedById.set(regular.id, key)
    faces.push({ id: regular.id, family: key })
    const bold = boldFace(matches)
    if (bold !== undefined && bold.id !== regular.id && !loadedById.has(bold.id)) {
      const boldKey = claimBold(key, bold.id, used)
      loadedById.set(bold.id, boldKey)
      faces.push({ id: bold.id, family: boldKey })
    }
  }
  return { faces, aliases }
}

export type FetchedPrintFonts = {
  readonly faces: readonly { readonly family: string; readonly bytes: Uint8Array }[]
  readonly aliases: readonly [string, string][]
}

/** `printFonts` against `GET /api/fonts`, then one extracted face per id. A face that fails to read is omitted. */
export async function fetchPrintFonts(families: readonly string[], han: boolean): Promise<FetchedPrintFonts> {
  const plan = printFonts(families, await readPrintCatalog(), han)
  const cached = new Map<string, Uint8Array>()
  const faces: { family: string; bytes: Uint8Array }[] = []
  for (const face of plan.faces) {
    let bytes = cached.get(face.id)
    if (bytes === undefined) {
      const read = await readPrintFace(face.id)
      if (read === undefined) continue
      bytes = read
      cached.set(face.id, bytes)
    }
    faces.push({ family: face.family, bytes })
  }
  const loaded = new Set(faces.map((face) => face.family))
  const aliases = plan.aliases.filter((pair) => loaded.has(pair[1]))
  return { faces, aliases }
}

function resolvedFaces(catalog: readonly PrintCatalogFace[], requested: string): readonly PrintCatalogFace[] {
  for (const name of aliasChain(requested)) {
    const matches = catalog.filter((face) => face.cjk && face.truetype && sameFamily(face, name))
    if (matches.length > 0) return matches
  }
  return []
}

function sameFamily(face: PrintCatalogFace, name: string): boolean {
  const key = name.trim().toLowerCase()
  return face.families.some((family) => family.trim().toLowerCase() === key)
}

function regularFace(matches: readonly PrintCatalogFace[]): PrintCatalogFace | undefined {
  return matches.find((face) => !face.bold && !face.italic) ?? matches[0]
}

function boldFace(matches: readonly PrintCatalogFace[]): PrintCatalogFace | undefined {
  const bolds = matches.filter((face) => face.bold && !face.italic)
  let best: PrintCatalogFace | undefined
  for (const face of bolds) {
    if (best === undefined || weightDistance(face) < weightDistance(best)) best = face
  }
  return best
}

function weightDistance(face: PrintCatalogFace): number {
  return typeof face.weight === 'number' ? Math.abs(face.weight - 700) : Number.POSITIVE_INFINITY
}

function claim(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name)
    return name
  }
  let n = 2
  let key = `${name} ${n}`
  while (used.has(key)) {
    n += 1
    key = `${name} ${n}`
  }
  used.add(key)
  return key
}

function claimBold(loaded: string, id: string, used: Set<string>): string {
  const preferred = `${loaded} Bold`
  if (!used.has(preferred)) {
    used.add(preferred)
    return preferred
  }
  const alt = `${loaded} Bold ${id}`
  if (!used.has(alt)) {
    used.add(alt)
    return alt
  }
  return claim(alt, used)
}

async function readPrintCatalog(): Promise<PrintCatalogFace[]> {
  const body = await fontCatalog()
  if (!Array.isArray(body)) return []
  const faces: PrintCatalogFace[] = []
  for (const item of body) {
    if (!isRecord(item) || typeof item.id !== 'string' || !Array.isArray(item.families)) continue
    const families: string[] = []
    for (const name of item.families) {
      if (typeof name === 'string' && name.trim() !== '') families.push(name)
    }
    if (families.length === 0) continue
    const face: PrintCatalogFace = {
      id: item.id,
      families,
      bold: item.bold === true,
      italic: item.italic === true,
      cjk: item.cjk === true,
      truetype: item.truetype === true,
    }
    if (typeof item.weight === 'number' && Number.isFinite(item.weight)) faces.push({ ...face, weight: item.weight })
    else faces.push(face)
  }
  return faces
}

async function readPrintFace(id: string): Promise<Uint8Array | undefined> {
  try {
    const response = await fetch(`/api/fonts/${encodeURIComponent(id)}/face`)
    if (!response.ok) return undefined
    return new Uint8Array(await response.arrayBuffer())
  } catch {
    return undefined
  }
}
