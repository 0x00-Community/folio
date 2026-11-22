import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export const root = new URL('../..', import.meta.url).pathname
const APP = 'word'

function acde(args, { allowFail = false, maxBuffer = 64 * 1024 * 1024 } = {}) {
  try {
    return execFileSync('acde', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer })
  } catch (error) {
    if (allowFail) return null
    throw new Error(`acde ${args.join(' ')} failed: ${error.stderr || error.message}`)
  }
}

let consoleSince = 1
let consoleMarked = false

function consoleOutput(args) {
  const result = spawnSync('acde', ['console', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) return String(result.error.message || result.error)
  const stdout = result.stdout ? String(result.stdout).trim() : ''
  if (stdout) return stdout
  return result.stderr ? String(result.stderr).trim() : ''
}

// null: the command answered, but not with a numbered list or a "no entries" line.
function nextConsoleEntry() {
  const text = consoleOutput([])
  if (text === '' || text.includes('no console entries')) return 1
  let last = 0
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\b/.exec(line)
    if (match) last = Math.max(last, Number(match[1]))
  }
  return last > 0 ? last + 1 : null
}

// One cursor per script, taken when ensureDev first runs. A session this process
// starts is 1, so its boot errors count. A later open whose numbers went backwards
// replaced the console; start again at 1 so those entries stay visible.
export async function ensureDev() {
  const running = Boolean(acde(['webs'], { allowFail: true })?.includes(APP))
  if (!running) {
    if (!consoleMarked) consoleSince = 1
    consoleMarked = true
    const child = spawn('acde', ['dev', '--headless'], { cwd: root, detached: true, stdio: 'ignore' })
    child.unref()
    for (let i = 0; i < 120; i++) {
      await sleep(500)
      if (acde(['webs'], { allowFail: true })?.includes(APP)) {
        const next = nextConsoleEntry()
        if (next !== null && next < consoleSince) consoleSince = 1
        return
      }
    }
    throw new Error('acde dev did not list the app within 60 s')
  }
  if (!consoleMarked) {
    const next = nextConsoleEntry()
    consoleSince = next ?? 1
    consoleMarked = true
  }
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

let bootSerial = 0

// `hash` is appended for a page that boots from location.hash. The boot query alone loads the editor.
export async function freshPage(ready, { label = ready, hash = '' } = {}) {
  bootSerial += 1
  const token = `e2e-${Date.now().toString(36)}-${bootSerial}`
  const hashPart = hash === '' ? '' : hash.startsWith('#') ? hash : `#${hash}`
  const url = `?boot=${token}${hashPart}`
  try {
    evaluate(`location.assign(location.pathname + ${JSON.stringify(url)})`)
  } catch {
    // Reloading the page aborts the eval.
  }
  return until(
    `new URLSearchParams(location.search).get('boot') === ${JSON.stringify(token)} && (${ready})`,
    { timeout: 60000, label },
  )
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

let evidenceDir = ''
let evidenceNoted = false

export function evidencePath(relativePath) {
  if (!evidenceDir) evidenceDir = mkdtempSync(join(tmpdir(), 'word-e2e-'))
  if (!evidenceNoted) {
    console.log(`evidence ${evidenceDir}`)
    evidenceNoted = true
  }
  const path = join(evidenceDir, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  return path
}

function hasEvidenceFile(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) return true
    if (entry.isDirectory() && hasEvidenceFile(join(dir, entry.name))) return true
  }
  return false
}

function copyEvidence(fromDir, toDir) {
  for (const entry of readdirSync(fromDir, { withFileTypes: true })) {
    const from = join(fromDir, entry.name)
    const to = join(toDir, entry.name)
    if (entry.isDirectory()) copyEvidence(from, to)
    else if (entry.isFile()) {
      mkdirSync(toDir, { recursive: true })
      copyFileSync(from, to)
    }
  }
}

async function publishEvidence() {
  if (process.env.WORD_E2E_EVIDENCE !== '1' || !evidenceDir || !hasEvidenceFile(evidenceDir)) return
  const marker = `e2e-${Date.now().toString(36)}-${bootSerial}`
  let armed = false
  let demo = false
  try {
    demo = evaluate(`location.hash === '#view-demo'`) === true
    evaluate(`window.__e2eEvidence = ${JSON.stringify(marker)}`)
    armed = evaluate('window.__e2eEvidence') === marker
  } catch {
    armed = false
  }
  copyEvidence(evidenceDir, join(root, 'docs/design/evidence'))
  if (!armed) return
  const end = Date.now() + 5000
  let gone = false
  while (Date.now() < end) {
    try {
      if (evaluate('window.__e2eEvidence') !== marker) {
        gone = true
        break
      }
    } catch {
      gone = true
      break
    }
    await sleep(150)
  }
  // Identical bytes do not reload the page, so a marker that stays means there is nothing to wait for.
  if (!gone) return
  // The view demo never installs window.__word.
  const ready = demo
    ? 'window.__demo && window.__demo.view.layout.complete === true'
    : '!!(window.__word && window.__word.editor)'
  await until(ready, { timeout: 60000, label: demo ? 'layout.complete' : 'editor' })
}

export function consoleErrors() {
  const text = consoleOutput(['--level', 'errors', '--since', String(consoleSince)])
  if (text === '' || text.includes('no console entries')) return []
  return text.split('\n').map((line) => line.trim()).filter(Boolean)
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

export async function summary() {
  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exitCode = failed.length ? 1 : 0
  try {
    await publishEvidence()
  } catch (error) {
    console.error(String(error.message || error))
    process.exitCode = 1
  }
  return results
}
