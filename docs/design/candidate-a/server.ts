// Backend: font discovery only. Pages cannot read system fonts and wasm rdocx has none, so this is the one thing the
// backend does. Portable Node/Bun, `export default { fetch }`.
//
// Usage (written first), from editor.ts:
//
//   const { families } = await (await fetch('/api/fonts')).json()          // ['SimSun', 'SimHei', 'KaiTi']
//   for (const f of engine.wantedFonts().filter((f) => families.includes(f)))
//     engine.addFont(f, new Uint8Array(await (await fetch(`/api/fonts/${encodeURIComponent(f)}`)).arrayBuffer()))

/** Family -> candidate files per platform, first existing wins; `face` selects a member of a collection. */
type FontSource = { file: string; face: number }
type FontTable = Record<string, FontSource[]>

/**
 * The fixed table: SimSun, SimHei, KaiTi, FangSong, Microsoft YaHei, Songti SC, Noto Serif CJK SC, Noto Sans CJK SC.
 * Searched under /Library/Fonts, ~/Library/Fonts, /System/Library/Fonts, /usr/share/fonts, ~/.local/share/fonts,
 * C:\Windows\Fonts.
 */
const FONTS: FontTable = {}

/** Resolved once per backend start: family -> the first existing source. */
function discover(table: FontTable): Map<string, FontSource> {
  throw new Error('not implemented')
}

/**
 * One face of a TrueType collection as a standalone sfnt: copy the face's table directory and tables, rewrite offsets,
 * 4-byte align. `@font-face` cannot select a collection index, and Noto CJK ships as .ttc on Linux.
 * A plain .ttf/.otf is returned as is.
 */
function singleFace(bytes: Uint8Array, face: number): Uint8Array {
  throw new Error('not implemented')
}

export default {
  async fetch(request: Request): Promise<Response> {
    // TODO:
    //   GET /api/fonts           -> { families: [...discovered keys] }
    //   GET /api/fonts/:family   -> singleFace(read(file), face), content-type font/sfnt, cache-control immutable
    //   else 404
    throw new Error('not implemented')
  },
}
