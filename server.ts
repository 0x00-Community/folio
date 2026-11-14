import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { scanFonts } from './server/fonts.ts'

const TYPES: Record<string, string> = {
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ttc': 'font/collection',
  '.otc': 'font/collection',
}

let faces: ReturnType<typeof scanFonts> | undefined

function index() {
  faces ??= scanFonts()
  return faces
}

function notFound(): Response {
  return new Response('not found', { status: 404 })
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
    const prefix = '/api/fonts/'
    if (!url.pathname.startsWith(prefix)) return notFound()
    let id: string
    try {
      id = decodeURIComponent(url.pathname.slice(prefix.length))
    } catch {
      return notFound()
    }
    if (id === '' || id.includes('/')) return notFound()
    const face = index().find((item) => item.id === id)
    if (face === undefined) return notFound()
    const type = TYPES[extname(face.path).toLowerCase()]
    if (type === undefined) return notFound()
    return new Response(new Uint8Array(readFileSync(face.path)), {
      headers: { 'content-type': type },
    })
  },
}
