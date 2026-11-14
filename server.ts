import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { extractFace, fontDirectories, readFontFile, resolveFont, scanFonts, type FontFace } from './server/fonts.ts'

const TYPES: Record<string, string> = {
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ttc': 'font/collection',
  '.otc': 'font/collection',
}

let cached: { stamp: string; faces: FontFace[] } | undefined

function stamp(): string {
  return fontDirectories()
    .map((dir) => {
      try {
        return `${dir}:${statSync(dir).mtimeMs}`
      } catch {
        return `${dir}:missing`
      }
    })
    .join('\n')
}

function index(): FontFace[] {
  const current = stamp()
  if (cached === undefined || cached.stamp !== current) cached = { stamp: current, faces: scanFonts() }
  return cached.faces
}

function notFound(): Response {
  return new Response('not found', { status: 404 })
}

function fontId(pathname: string): { id: string; face: boolean } | undefined {
  const prefix = '/api/fonts/'
  if (!pathname.startsWith(prefix)) return undefined
  const raw = pathname.slice(prefix.length)
  const face = raw.endsWith('/face')
  const encoded = face ? raw.slice(0, -'/face'.length) : raw
  let id: string
  try {
    id = decodeURIComponent(encoded)
  } catch {
    return undefined
  }
  if (id === '' || id.includes('/')) return undefined
  return { id, face }
}

export default {
  fetch(request: Request): Response {
    if (request.method !== 'GET') return notFound()
    const url = new URL(request.url)
    if (url.pathname === '/api/fonts') {
      return Response.json(
        index().map(({ id, families, bold, italic, cjk, size }) => ({
          id,
          families,
          bold,
          italic,
          cjk,
          size,
        })),
      )
    }
    if (url.pathname === '/api/fonts/resolve') {
      const family = url.searchParams.get('family')
      if (family === null || family.trim() === '') return notFound()
      const resolved = resolveFont(family, index())
      if (resolved === null) return notFound()
      return Response.json({
        id: resolved.id,
        family: resolved.family,
        faceIndex: resolved.faceIndex,
        metrics: resolved.metrics,
      })
    }
    const route = fontId(url.pathname)
    if (route === undefined) return notFound()
    const face = index().find((item) => item.id === route.id)
    if (face === undefined) return notFound()
    if (route.face) {
      const bytes = extractFace(readFontFile(face.path), face.faceIndex)
      return new Response(new Uint8Array(bytes), { headers: { 'content-type': 'font/sfnt' } })
    }
    const type = TYPES[extname(face.path).toLowerCase()]
    if (type === undefined) return notFound()
    return new Response(new Uint8Array(readFileSync(face.path)), {
      headers: { 'content-type': type },
    })
  },
}
