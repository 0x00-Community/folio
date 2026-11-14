import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_BYTES = 32 * 1024 * 1024

function appData(): string {
  const dir = process.env.ACDE_APP_DATA || join(tmpdir(), 'rdocx-word')
  mkdirSync(dir, { recursive: true })
  return dir
}

function currentPath(): string {
  return join(appData(), 'current.docx')
}

function binary(): string {
  const fromEnv = process.env.RDOCX_WORD
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const beside = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'word.bin')
  const home = process.env.HOME || ''
  const candidates = [
    beside,
    join(home, 'code', 'rdocx-acde', 'public', 'word.bin'),
    join(home, 'code', 'rdocx', 'target', 'release', 'rdocx-word'),
  ]
  const found = candidates.find((path) => existsSync(path))
  if (!found) throw new Error('missing word.bin')
  try {
    chmodSync(found, 0o755)
  } catch {
    // already executable
  }
  return found
}

function engine(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('rdocx timed out'))
    }, 120_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      })
    })
  })
}

async function call(args: string[]): Promise<unknown> {
  const result = await engine(args)
  let body: { error?: string } = {}
  try {
    body = JSON.parse(result.stdout)
  } catch {
    body = { error: result.stderr.trim() || result.stdout.trim() || 'rdocx failed' }
  }
  if (result.code !== 0) throw new Error(body.error || 'rdocx failed')
  return body
}

function remember(name: string) {
  writeFileSync(join(appData(), 'current.name'), name)
}

function remembered(): string {
  const path = join(appData(), 'current.name')
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : 'Document.docx'
}

function fail(error: unknown, status = 400): Response {
  const message = error instanceof Error ? error.message : 'rdocx failed'
  return Response.json({ error: message }, { status })
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (url.pathname === '/api/health' && request.method === 'GET') {
        const version = (await call(['version'])) as { version: string }
        return Response.json({ ok: true, version: version.version, bin: binary() })
      }

      if (url.pathname === '/api/new' && request.method === 'POST') {
        const name = 'Document.docx'
        remember(name)
        const model = await call(['create', currentPath()])
        return Response.json({ ...(model as object), name })
      }

      if (url.pathname === '/api/open' && request.method === 'POST') {
        const bytes = new Uint8Array(await request.arrayBuffer())
        if (bytes.byteLength > MAX_BYTES) return fail(new Error('file is larger than 32 MB'), 413)
        if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return fail(new Error('not a DOCX package'))
        let name = 'Document.docx'
        const raw = request.headers.get('x-file-name')
        if (raw) {
          try {
            name = decodeURIComponent(raw)
          } catch {
            name = raw
          }
          name = name.split(/[/\\]/).pop() || name
        }
        writeFileSync(currentPath(), bytes)
        remember(name)
        const model = await call(['open', currentPath()])
        return Response.json({ ...(model as object), name })
      }

      if (url.pathname === '/api/save' && request.method === 'POST') {
        if (!existsSync(currentPath())) return fail(new Error('no document'), 404)
        const edits = join(appData(), 'edits.json')
        writeFileSync(edits, await request.text())
        const model = await call(['save', currentPath(), edits])
        rmSync(edits, { force: true })
        return Response.json({ ...(model as object), name: remembered() })
      }

      if (url.pathname === '/api/export' && request.method === 'GET') {
        if (!existsSync(currentPath())) return fail(new Error('no document'), 404)
        const format = url.searchParams.get('format') || ''
        const types: Record<string, string> = {
          pdf: 'application/pdf',
          html: 'text/html; charset=utf-8',
          md: 'text/markdown; charset=utf-8',
          docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }
        if (!types[format]) return fail(new Error('unknown format'))
        const stem = remembered().replace(/\.docx$/i, '') || 'Document'
        const filename = `${stem}.${format === 'md' ? 'md' : format}`
        if (format === 'docx') {
          return new Response(new Uint8Array(readFileSync(currentPath())), {
            headers: { 'content-type': types.docx, 'content-disposition': `attachment; filename="${filename}"` },
          })
        }
        const output = join(appData(), `export.${format === 'md' ? 'md' : format}`)
        await call(['export', currentPath(), format, output])
        return new Response(new Uint8Array(readFileSync(output)), {
          headers: { 'content-type': types[format], 'content-disposition': `attachment; filename="${filename}"` },
        })
      }

      return new Response('not found', { status: 404 })
    } catch (error) {
      return fail(error, 500)
    }
  },
}
