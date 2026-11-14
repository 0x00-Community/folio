import { execFileSync, spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

export const root = new URL('../..', import.meta.url).pathname
const APP = 'word'

function acde(args, { allowFail = false } = {}) {
  try {
    return execFileSync('acde', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    if (allowFail) return null
    throw new Error(`acde ${args.join(' ')} failed: ${error.stderr || error.message}`)
  }
}

export async function ensureDev() {
  if (acde(['webs'], { allowFail: true })?.includes(APP)) return
  const child = spawn('acde', ['dev', '--headless'], { cwd: root, detached: true, stdio: 'ignore' })
  child.unref()
  for (let i = 0; i < 120; i++) {
    await sleep(500)
    if (acde(['webs'], { allowFail: true })?.includes(APP)) return
  }
  throw new Error('acde dev did not list the app within 60 s')
}

export function evaluate(expression) {
  const out = acde(['eval', APP, expression])
  return out.trim() === '' ? undefined : JSON.parse(out)
}

export async function until(expression, { timeout = 15000, label = expression } = {}) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try {
      last = evaluate(expression)
      if (last) return last
    } catch (error) {
      last = String(error.message || error)
    }
    await sleep(150)
  }
  throw new Error(`timed out waiting for ${label}; last value ${JSON.stringify(last)}`)
}

export function ref(selector) {
  const out = acde(['query', selector, '--limit', '1'], { allowFail: true }) || ''
  const match = out.match(/\[(w\d+\.[\w.]+)\]/)
  if (!match) throw new Error(`no element for ${selector}`)
  return match[1]
}

export function act(target, action, arg) {
  const args = ['act', target.startsWith('w') ? target : ref(target), action]
  if (arg !== undefined) args.push(arg)
  return acde(args)
}

export function shot(path) {
  acde(['shot', APP, '-o', path])
  return path
}

export function consoleErrors() {
  const out = acde(['console', '--level', 'errors'], { allowFail: true }) || ''
  return out.includes('no console entries') ? [] : out.trim().split('\n').filter(Boolean)
}

const results = []

export async function check(name, body) {
  const started = Date.now()
  try {
    await body()
    results.push({ name, ok: true, ms: Date.now() - started })
    console.log(`PASS ${name}`)
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error: String(error.message || error) })
    console.log(`FAIL ${name}: ${error.message || error}`)
  }
}

export function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export function summary() {
  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exitCode = failed.length ? 1 : 0
  return results
}
