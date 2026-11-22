// Retained heap per undo entry: 2,900 paragraphs, 500 single-character edits in
// different paragraphs (none coalesce). Run: node --expose-gc scripts/history-heap.mjs
import { apply, initialState, insertText, setSelection } from '../src/editor/edit.ts'
import { makeDoc, paragraph, text } from '../src/editor/testkit.ts'
import { indexOf } from '../src/model.ts'

const PARAGRAPHS = 2900
const EDITS = 500

if (typeof globalThis.gc !== 'function') {
  console.error('run with node --expose-gc')
  process.exit(1)
}

function heap() {
  globalThis.gc()
  globalThis.gc()
  globalThis.gc()
  return process.memoryUsage().heapUsed
}

const blocks = []
for (let i = 0; i < PARAGRAPHS; i++) blocks.push(paragraph(`p${i}`, [text('hello')]))
let state = initialState(makeDoc(blocks))
const before = heap()

for (let i = 0; i < EDITS; i++) {
  const para = state.doc.body[i]
  if (!para || para.kind !== 'p') throw new Error(`missing paragraph ${i}`)
  const caret = { p: para.id, o: 1 }
  const placed = setSelection({ kind: 'text', anchor: caret, head: caret })(state)
  if (placed) state = apply(state, placed, i * 10000)
  const tr = insertText('x')(state)
  if (!tr) throw new Error(`edit ${i} did not apply`)
  state = apply(state, tr, i * 10000 + 1)
}
indexOf(state.doc)

const entries = state.history.past.length
if (entries !== EDITS) throw new Error(`history entries ${entries}, expected ${EDITS}`)
const after = heap()
const retained = after - before
const perEntry = retained / entries
console.log(JSON.stringify({
  paragraphs: PARAGRAPHS,
  entries,
  before,
  after,
  retained,
  perEntry,
  perEntryKb: Math.round((perEntry / 1024) * 10) / 10,
}))
