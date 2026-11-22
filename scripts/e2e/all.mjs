import { spawn, spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const root = fileURLToPath(new URL('../..', import.meta.url))

function callsSummary(source) {
  return source.split('\n').some((line) => /^\s*(?:await\s+)?summary\(\)\s*;?\s*$/.test(line))
}

function checkScripts() {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.mjs') && callsSummary(readFileSync(join(dir, name), 'utf8')))
    .map((name) => name.slice(0, -'.mjs'.length))
    .sort((a, b) => a.localeCompare(b, 'en'))
}

function usage(scripts) {
  return [
    'usage: node scripts/e2e/all.mjs [--repeat N] [script ...]',
    '',
    'Runs every check script in one acde dev session. A check script is a file in',
    'scripts/e2e that calls summary(); helpers that only define it are left out.',
    'With no names, the order is:',
    ...scripts.map((name) => `  ${name}`),
  ].join('\n')
}

function parseRepeat(value) {
  if (!/^[1-9]\d*$/.test(value ?? '')) {
    console.error('repeat must be a positive integer')
    process.exit(1)
  }
  return Number(value)
}

function parseArgs(argv) {
  let repeat = 1
  const names = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--repeat') {
      repeat = parseRepeat(argv[i + 1])
      i += 1
      continue
    }
    if (arg.startsWith('--repeat=')) {
      repeat = parseRepeat(arg.slice('--repeat='.length))
      continue
    }
    if (arg.startsWith('-')) {
      console.error(`unknown argument ${arg}`)
      process.exit(1)
    }
    names.push(arg.endsWith('.mjs') ? arg.slice(0, -'.mjs'.length) : arg)
  }
  return { repeat, names }
}

function acdeOnPath() {
  const result = spawnSync('acde', ['--help'], { encoding: 'utf8' })
  return !(result.error && result.error.code === 'ENOENT')
}

function stop() {
  spawnSync('acde', ['stop'], { cwd: root, stdio: 'inherit' })
}

function runScript(name) {
  const started = Date.now()
  const child = spawn(process.execPath, [join(dir, `${name}.mjs`)], {
    cwd: root,
    stdio: ['inherit', 'pipe', 'pipe'],
    env: process.env,
  })
  let buffer = ''
  let settled = false
  const take = (chunk, stream) => {
    stream.write(chunk)
    buffer += chunk.toString()
  }
  child.stdout.on('data', (chunk) => take(chunk, process.stdout))
  child.stderr.on('data', (chunk) => take(chunk, process.stderr))
  return new Promise((resolve) => {
    const finish = (code) => {
      if (settled) return
      settled = true
      const found = [...buffer.matchAll(/(\d+)\/(\d+) passed/g)]
      const last = found.at(-1)
      resolve({
        script: name,
        passed: last ? Number(last[1]) : null,
        total: last ? Number(last[2]) : null,
        seconds: (Date.now() - started) / 1000,
        code,
      })
    }
    child.on('error', (error) => {
      process.stderr.write(`${error.message}\n`)
      finish(1)
    })
    child.on('close', (code) => finish(code ?? 1))
  })
}

function printTable(rows) {
  const header = ['script', 'passed', 'seconds', 'exit']
  const body = rows.map((row) => [
    row.script,
    row.passed === null ? '-' : `${row.passed}/${row.total}`,
    row.seconds.toFixed(1),
    String(row.code),
  ])
  const widths = header.map((name, index) => Math.max(name.length, ...body.map((line) => line[index].length)))
  const format = (cols) => cols.map((col, index) => col.padEnd(widths[index])).join('  ')
  console.log('')
  console.log(format(header))
  for (const line of body) console.log(format(line))
}

const known = checkScripts()
const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(usage(known))
  process.exit(0)
}

const { repeat, names } = parseArgs(argv)
for (const name of names) {
  if (!known.includes(name)) {
    console.error(`unknown script ${name}`)
    process.exit(1)
  }
}
const selected = names.length > 0 ? names : known

if (!acdeOnPath()) {
  console.error('acde is not on PATH; add ~/.acde/bin to PATH')
  process.exit(2)
}

stop()
let failed = false
try {
  for (let round = 1; round <= repeat; round += 1) {
    if (repeat > 1) console.log(`\nround ${round}`)
    const rows = []
    for (const name of selected) rows.push(await runScript(name))
    printTable(rows)
    if (rows.some((row) => row.code !== 0)) failed = true
  }
} finally {
  stop()
}
process.exitCode = failed ? 1 : 0
