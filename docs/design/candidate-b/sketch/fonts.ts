// One alias table for font families, shared by the page bundle (CSS stacks) and the backend bundle (which file to
// serve). Display and PDF export resolve a family through the same list, so both use the same physical font.

/**
 * Requested family (any spelling a document uses) to an ordered list of substitutes. The first one installed wins,
 * on screen and in the PDF. Keys are matched case-insensitively.
 */
export const FAMILY_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  ['simsun', ['SimSun', '宋体', 'Songti SC', 'STSong', 'Noto Serif CJK SC', 'Source Han Serif SC']],
  ['宋体', ['SimSun', '宋体', 'Songti SC', 'STSong', 'Noto Serif CJK SC', 'Source Han Serif SC']],
  ['simhei', ['SimHei', '黑体', 'Heiti SC', 'STHeiti', 'PingFang SC', 'Noto Sans CJK SC']],
  ['黑体', ['SimHei', '黑体', 'Heiti SC', 'STHeiti', 'PingFang SC', 'Noto Sans CJK SC']],
  ['kaiti', ['KaiTi', '楷体', 'Kaiti SC', 'STKaiti']],
  ['fangsong', ['FangSong', '仿宋', 'STFangsong']],
  ['仿宋_gb2312', ['FangSong_GB2312', '仿宋_GB2312', 'FangSong', '仿宋', 'STFangsong']],
  ['microsoft yahei', ['Microsoft YaHei', '微软雅黑', 'PingFang SC', 'Noto Sans CJK SC']],
  ['times new roman', ['Times New Roman', 'Liberation Serif', 'Tinos']],
  ['calibri', ['Calibri', 'Carlito']],
  ['cambria', ['Cambria', 'Caladea']],
  ['arial', ['Arial', 'Liberation Sans', 'Arimo']],
])

/** CSS font-family value for a requested family, ending in a generic family. */
export function cssStack(family: string, generic: 'serif' | 'sans-serif'): string {
  throw new Error('not implemented')
}

/** Page side. GET /api/font?family=... per family; the backend answers with one standalone face or 404. */
export async function fetchFonts(families: readonly string[]): Promise<ReadonlyMap<string, Uint8Array>> {
  throw new Error('not implemented')
}

/** Page side. GET /api/font/metrics?family=...: unitsPerEm, OS/2 win and typo ascent and descent, hhea, for line heights. */
export async function fetchMetrics(families: readonly string[]): Promise<ReadonlyMap<string, FontMetrics>> {
  throw new Error('not implemented')
}

export interface FontMetrics {
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

/**
 * Backend side (server.ts). Indexes the system font directories by every name-table family name, localized names
 * included, and resolves a request through FAMILY_ALIASES. A .ttc face is extracted into a standalone sfnt.
 * Stateless apart from the index, which it rebuilds when a directory's mtime changes.
 */
export interface FontIndex {
  resolve(family: string): { file: string; face: number; family: string } | null
  faceBytes(file: string, face: number): Promise<Uint8Array>
}
