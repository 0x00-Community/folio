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

export function namedRef(name) {
  let out = ''
  try {
    out = execFileSync('acde', ['inspect', '--find', name], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const stdout = error && error.stdout ? String(error.stdout) : ''
    const stderr = error && error.stderr ? String(error.stderr) : ''
    out = `${stdout}\n${stderr}`
  }
  const match = out.match(/\[(w\d+\.[\w.]+)\]/)
  if (!match) throw new Error(`no element named ${JSON.stringify(name)}: ${out.trim()}`)
  return match[1]
}

export function act(target, action, arg) {
  const args = ['act', target.startsWith('w') ? target : ref(target), action]
  if (arg !== undefined) args.push(arg)
  return acde(args)
}

// A button whose accessible name is exactly `name`. The dialog's own name contains its button labels,
// so the first inspect hit is not always the button.
export function buttonNamed(name) {
  let out = ''
  try {
    out = execFileSync('acde', ['inspect', '--find', name], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const stdout = error && error.stdout ? String(error.stdout) : ''
    const stderr = error && error.stderr ? String(error.stderr) : ''
    out = `${stdout}\n${stderr}`
  }
  const line = out.split('\n').find((item) => {
    const quoted = item.match(/button "([^"]*)"/)
    return !!(quoted && quoted[1] === name)
  })
  if (!line) throw new Error(`no button ${JSON.stringify(name)}: ${out.trim()}`)
  const match = line.match(/\[(w\d+\.[\w.]+)\]/)
  if (!match) throw new Error(line)
  return match[1]
}

// The click may close the window and drop the connection. That is the expected end: wait until
// `acde webs` no longer lists the app, so the next ensureDev starts a session instead of returning early.
export async function actClosing(target, action, arg) {
  let failure = null
  try {
    act(target, action, arg)
  } catch (error) {
    failure = error
  }
  for (let i = 0; i < 80; i++) {
    const listed = acde(['webs'], { allowFail: true })
    if (!listed || !listed.includes(APP)) return
    await sleep(150)
  }
  if (failure) throw failure
  throw new Error('acde webs still lists the app')
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
