import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkDoc, flatText } from '../model.ts'
import type { Paragraph, Pos } from '../model.ts'
import { apply, initialState, insertText, setSelection } from './edit.ts'
import type { EditorState } from './edit.ts'
import { buildKeymap, chordOf, defaultKeymap, IDLE, transition } from './input.ts'
import type { Action, DragUnit, InputMode, KeyFields, ModeEvent, Platform } from './input.ts'
import { makeDoc, paragraph, paraId, text } from './testkit.ts'

const PLATFORMS: readonly Platform[] = ['mac', 'other']
const keymaps = { mac: defaultKeymap('mac'), other: defaultKeymap('other') }

const ctrl = { ctrlKey: true }
const cmd = { metaKey: true }
const alt = { altKey: true }
const shift = { shiftKey: true }

function keyEvent(key: string, held: Partial<Omit<KeyFields, 'key'>> = {}): KeyFields {
  return { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...held }
}

const first = paragraph('a', [text('hello world', 1)], {}, { src: 1 })
const second = paragraph('b', [text('second line', 2)], {}, { src: 2 })
const third = paragraph('c', [text('third', 3)], {}, { src: 3 })

function stateAt(para: Paragraph, o: number): EditorState {
  const state = initialState(makeDoc([first, second, third]))
  const caret = { p: para.id, o }
  const sel = { kind: 'text', anchor: caret, head: caret } as const
  const tr = setSelection(sel)(state)
  if (!tr) {
    assert.deepEqual(state.sel, sel, 'the caret is already there')
    return state
  }
  return apply(state, tr, 0)
}

function bound(platform: Platform, event: KeyFields): Action | undefined {
  return keymaps[platform].get(chordOf(event, platform))
}

function press(state: EditorState, platform: Platform, event: KeyFields): EditorState {
  const chord = chordOf(event, platform)
  const action = keymaps[platform].get(chord)
  assert.ok(action && action.kind === 'command', `${chord} runs a command on ${platform}`)
  const tr = action.command(state)
  assert.ok(tr, `${chord} applies`)
  const next = apply(state, tr, 0)
  checkDoc(next.doc)
  return next
}

function heldFor(chord: string, platform: Platform): KeyFields {
  const parts = chord.split('+')
  const key = parts.pop() ?? ''
  const held = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }
  for (const part of parts) {
    if (part === 'mod') held[platform === 'mac' ? 'metaKey' : 'ctrlKey'] = true
    else if (part === 'ctrl') held.ctrlKey = true
    else if (part === 'meta') held.metaKey = true
    else if (part === 'alt') held.altKey = true
    else if (part === 'shift') held.shiftKey = true
    else assert.fail(`${chord} has an unknown modifier ${part}`)
  }
  return { key, ...held }
}

function caretOf(state: EditorState): Pos {
  assert.ok(state.sel.kind === 'text', 'the selection is in text')
  assert.deepEqual(state.sel.anchor, state.sel.head, 'the selection is collapsed')
  return state.sel.head
}

test('chordOf spells the platform primary modifier as mod and keeps the other one by name', () => {
  assert.equal(chordOf(keyEvent('b', ctrl), 'other'), 'mod+b', 'Ctrl is the primary modifier outside macOS')
  assert.equal(chordOf(keyEvent('b', cmd), 'mac'), 'mod+b', 'Cmd is the primary modifier on macOS')
  assert.equal(chordOf(keyEvent('b', cmd), 'other'), 'meta+b', 'the Windows key stays meta')
  assert.equal(chordOf(keyEvent('b', ctrl), 'mac'), 'ctrl+b', 'Ctrl on macOS stays ctrl')
})

test('chordOf lower-cases the key and puts shift after the other modifiers', () => {
  assert.equal(chordOf(keyEvent('B', { ctrlKey: true, shiftKey: true }), 'other'), 'mod+shift+b')
  assert.equal(chordOf(keyEvent('Z', { metaKey: true, shiftKey: true }), 'mac'), 'mod+shift+z')
  assert.equal(chordOf(keyEvent('ArrowDown', shift), 'mac'), 'shift+arrowdown')
  assert.equal(chordOf(keyEvent('ArrowDown', shift), 'other'), 'shift+arrowdown')
  assert.equal(chordOf(keyEvent('Enter'), 'other'), 'enter')
  assert.equal(chordOf(keyEvent('a'), 'mac'), 'a', 'a plain key has no modifiers')
})

test('chordOf gives every modifier combination one canonical name', () => {
  const all = { ctrlKey: true, metaKey: true, altKey: true, shiftKey: true }
  assert.equal(chordOf(keyEvent('a', all), 'other'), 'mod+meta+alt+shift+a')
  assert.equal(chordOf(keyEvent('a', all), 'mac'), 'mod+ctrl+alt+shift+a')
})

test('chordOf names space and plus so the chord can be split on "+"', () => {
  assert.equal(chordOf(keyEvent(' '), 'other'), 'space')
  assert.equal(chordOf(keyEvent('+', ctrl), 'other'), 'mod+plus')
})

test('a chord bound twice is refused, including one that collides with a default', () => {
  const noop: Action = { kind: 'history', step: 'undo' }
  assert.throws(() => buildKeymap([['mod+q', noop], ['mod+q', noop]]), RangeError)
  assert.throws(() => buildKeymap([...defaultKeymap('other'), ['mod+b', noop]]), RangeError, 'an app binding cannot shadow bold')
  const extended = buildKeymap([...defaultKeymap('other'), ['mod+s', noop]])
  assert.equal(extended.size, defaultKeymap('other').size + 1, 'a free chord is added')
})

test('the default keymap binds each chord once on both platforms', () => {
  for (const platform of PLATFORMS) {
    assert.doesNotThrow(() => defaultKeymap(platform), platform)
  }
})

test('every default chord is one that chordOf produces for a real key press', () => {
  for (const platform of PLATFORMS) {
    for (const chord of keymaps[platform].keys()) {
      assert.equal(chordOf(heldFor(chord, platform), platform), chord, `${chord} is canonical on ${platform}`)
    }
  }
})

test('every command in the default keymap applies on a mid-document caret and keeps the document valid', () => {
  for (const platform of PLATFORMS) {
    for (const [chord, action] of keymaps[platform]) {
      if (action.kind !== 'command') continue
      const state = stateAt(second, 6)
      const tr = action.command(state)
      assert.ok(tr, `${chord} applies on ${platform}`)
      checkDoc(apply(state, tr, 0).doc)
    }
  }
})

test('the keymap reaches every visual motion, with and without Shift, plus undo, redo and each clipboard operation', () => {
  for (const platform of PLATFORMS) {
    const actions = [...keymaps[platform].values()]
    const motions = actions.flatMap(action => action.kind === 'visual' ? [`${action.motion}:${action.extend}`] : [])
    for (const motion of ['lineUp', 'lineDown', 'pageUp', 'pageDown', 'lineStart', 'lineEnd']) {
      assert.ok(motions.includes(`${motion}:false`), `${motion} moves on ${platform}`)
      assert.ok(motions.includes(`${motion}:true`), `${motion} extends on ${platform}`)
    }
    const steps = actions.flatMap(action => action.kind === 'history' ? [action.step] : [])
    assert.deepEqual([...new Set(steps)].sort(), ['redo', 'undo'], `history on ${platform}`)
    const ops = actions.flatMap(action => action.kind === 'clipboard' ? [action.op] : [])
    assert.deepEqual([...new Set(ops)].sort(), ['copy', 'cut', 'paste'], `clipboard on ${platform}`)
  }
})

test('undo, redo and the clipboard sit on mod on both platforms, with redo on Shift+Z and on Y', () => {
  for (const [platform, held] of [['mac', cmd], ['other', ctrl]] as const) {
    assert.deepEqual(bound(platform, keyEvent('z', held)), { kind: 'history', step: 'undo' })
    assert.deepEqual(bound(platform, keyEvent('Z', { ...held, ...shift })), { kind: 'history', step: 'redo' })
    assert.deepEqual(bound(platform, keyEvent('y', held)), { kind: 'history', step: 'redo' })
    assert.deepEqual(bound(platform, keyEvent('c', held)), { kind: 'clipboard', op: 'copy' })
    assert.deepEqual(bound(platform, keyEvent('x', held)), { kind: 'clipboard', op: 'cut' })
    assert.deepEqual(bound(platform, keyEvent('v', held)), { kind: 'clipboard', op: 'paste' })
  }
})

test('Home, End, Page Up, Page Down and the vertical arrows are visual motions that extend with Shift', () => {
  for (const platform of PLATFORMS) {
    assert.deepEqual(bound(platform, keyEvent('Home')), { kind: 'visual', motion: 'lineStart', extend: false })
    assert.deepEqual(bound(platform, keyEvent('End', shift)), { kind: 'visual', motion: 'lineEnd', extend: true })
    assert.deepEqual(bound(platform, keyEvent('PageUp')), { kind: 'visual', motion: 'pageUp', extend: false })
    assert.deepEqual(bound(platform, keyEvent('PageDown', shift)), { kind: 'visual', motion: 'pageDown', extend: true })
    assert.deepEqual(bound(platform, keyEvent('ArrowUp')), { kind: 'visual', motion: 'lineUp', extend: false })
    assert.deepEqual(bound(platform, keyEvent('ArrowDown', shift)), { kind: 'visual', motion: 'lineDown', extend: true })
  }
})

test('Enter splits the paragraph, Shift+Enter breaks the line inside it, and Mod+Enter inserts a page break', () => {
  for (const [platform, held] of [['mac', cmd], ['other', ctrl]] as const) {
    const start = stateAt(first, 5)
    const split = press(start, platform, keyEvent('Enter'))
    assert.deepEqual(split.doc.body.map(block => block.kind === 'p' ? flatText(block) : ''), ['hello', ' world', 'second line', 'third'], 'enter splits at the caret')
    const broken = press(start, platform, keyEvent('Enter', shift))
    assert.equal(broken.doc.body.length, 3, 'a line break adds no paragraph')
    const para = broken.doc.body[0]
    assert.ok(para && para.kind === 'p')
    assert.equal(flatText(para), 'hello\n world', 'the break is inside the paragraph')
    const paged = press(start, platform, keyEvent('Enter', held))
    const marked = paged.doc.body[0]
    assert.ok(marked && marked.kind === 'p')
    assert.equal(flatText(marked), 'hello￼ world', 'the page break is one atom at the caret')
  }
})

test('Backspace at a paragraph start and Delete at a paragraph end merge across the boundary', () => {
  for (const platform of PLATFORMS) {
    const back = press(stateAt(second, 0), platform, keyEvent('Backspace'))
    assert.deepEqual(back.doc.body.map(block => block.kind === 'p' ? flatText(block) : ''), ['hello worldsecond line', 'third'])
    assert.deepEqual(caretOf(back), { p: first.id, o: 11 }, 'the caret sits at the join')
    const forward = press(stateAt(first, 11), platform, keyEvent('Delete'))
    assert.deepEqual(forward.doc.body.map(block => block.kind === 'p' ? flatText(block) : ''), ['hello worldsecond line', 'third'])
  }
})

test('Backspace and Delete remove one character inside a paragraph', () => {
  const back = press(stateAt(first, 5), 'other', keyEvent('Backspace'))
  const afterBack = back.doc.body[0]
  assert.ok(afterBack && afterBack.kind === 'p')
  assert.equal(flatText(afterBack), 'hell world')
  const forward = press(stateAt(first, 5), 'other', keyEvent('Delete'))
  const afterForward = forward.doc.body[0]
  assert.ok(afterForward && afterForward.kind === 'p')
  assert.equal(flatText(afterForward), 'helloworld')
})

test('word deletion is Ctrl+Backspace outside macOS and Alt+Backspace on macOS, and neither platform answers the other chord', () => {
  const end = stateAt(first, 11)
  const other = press(end, 'other', keyEvent('Backspace', ctrl))
  const mac = press(end, 'mac', keyEvent('Backspace', alt))
  for (const state of [other, mac]) {
    const para = state.doc.body[0]
    assert.ok(para && para.kind === 'p')
    assert.equal(flatText(para), 'hello ', 'the last word is gone')
  }
  assert.equal(bound('mac', keyEvent('Backspace', ctrl)), undefined, 'Ctrl+Backspace is not a word delete on macOS')
  assert.equal(bound('other', keyEvent('Backspace', alt)), undefined, 'Alt+Backspace is not a word delete elsewhere')
})

test('arrows move one character and Shift extends the selection from the original anchor', () => {
  for (const platform of PLATFORMS) {
    const right = press(stateAt(first, 3), platform, keyEvent('ArrowRight'))
    assert.deepEqual(caretOf(right), { p: first.id, o: 4 })
    const extended = press(press(stateAt(first, 3), platform, keyEvent('ArrowRight', shift)), platform, keyEvent('ArrowRight', shift))
    assert.deepEqual(extended.sel, { kind: 'text', anchor: { p: first.id, o: 3 }, head: { p: first.id, o: 5 } })
    const collapsed = press(extended, platform, keyEvent('ArrowLeft'))
    assert.deepEqual(caretOf(collapsed), { p: first.id, o: 3 }, 'a plain arrow collapses to the start of the selection')
  }
})

test('an arrow at a paragraph edge crosses into the neighbor', () => {
  const next = press(stateAt(first, 11), 'other', keyEvent('ArrowRight'))
  assert.deepEqual(caretOf(next), { p: second.id, o: 0 })
  const previous = press(stateAt(second, 0), 'other', keyEvent('ArrowLeft'))
  assert.deepEqual(caretOf(previous), { p: first.id, o: 11 })
})

test('word motion is Ctrl+arrow outside macOS and Alt+arrow on macOS', () => {
  const start = stateAt(first, 0)
  const other = press(start, 'other', keyEvent('ArrowRight', ctrl))
  const mac = press(start, 'mac', keyEvent('ArrowRight', alt))
  assert.deepEqual(caretOf(other), { p: first.id, o: 6 }, 'Ctrl+Right lands at the next word start')
  assert.deepEqual(caretOf(mac), { p: first.id, o: 6 }, 'Alt+Right lands at the next word start')
  assert.equal(bound('mac', keyEvent('ArrowRight', ctrl)), undefined, 'Ctrl+arrow belongs to the OS on macOS')
  const selecting = press(start, 'other', keyEvent('ArrowRight', { ...ctrl, ...shift }))
  assert.deepEqual(selecting.sel, { kind: 'text', anchor: { p: first.id, o: 0 }, head: { p: first.id, o: 6 } })
})

test('the document edges are Ctrl+Home and Ctrl+End outside macOS and Cmd+Up and Cmd+Down on macOS', () => {
  const middle = stateAt(second, 3)
  for (const [platform, event] of [['other', keyEvent('Home', ctrl)], ['mac', keyEvent('ArrowUp', cmd)]] as const) {
    assert.deepEqual(caretOf(press(middle, platform, event)), { p: first.id, o: 0 }, `document start on ${platform}`)
  }
  for (const [platform, event] of [['other', keyEvent('End', ctrl)], ['mac', keyEvent('ArrowDown', cmd)]] as const) {
    assert.deepEqual(caretOf(press(middle, platform, event)), { p: third.id, o: 5 }, `document end on ${platform}`)
  }
})

test('Cmd+Left and Cmd+Right are line edges on macOS', () => {
  assert.deepEqual(bound('mac', keyEvent('ArrowLeft', cmd)), { kind: 'visual', motion: 'lineStart', extend: false })
  assert.deepEqual(bound('mac', keyEvent('ArrowRight', { ...cmd, ...shift })), { kind: 'visual', motion: 'lineEnd', extend: true })
})

test('Alt+Up and Alt+Down move by paragraph on macOS', () => {
  const middle = stateAt(second, 3)
  assert.deepEqual(caretOf(press(middle, 'mac', keyEvent('ArrowUp', alt))), { p: second.id, o: 0 })
  assert.deepEqual(caretOf(press(middle, 'mac', keyEvent('ArrowDown', alt))), { p: second.id, o: 11 })
})

test('Mod+A selects the whole document', () => {
  for (const [platform, held] of [['mac', cmd], ['other', ctrl]] as const) {
    const state = press(stateAt(second, 3), platform, keyEvent('a', held))
    assert.deepEqual(state.sel, { kind: 'text', anchor: { p: first.id, o: 0 }, head: { p: third.id, o: 5 } })
  }
})

test('Mod+B, Mod+I and Mod+U mark the next typed text and the other platform primary key does not', () => {
  for (const [platform, held, foreign] of [['mac', cmd, ctrl], ['other', ctrl, cmd]] as const) {
    for (const [letter, mark] of [['b', 'bold'], ['i', 'italic'], ['u', 'underline']] as const) {
      const marked = press(stateAt(first, 5), platform, keyEvent(letter, held))
      assert.equal(marked.stored?.[mark], true, `${letter} stores ${mark} on ${platform}`)
      assert.equal(bound(platform, keyEvent(letter, foreign)), undefined, `${letter} with the other primary key is unbound on ${platform}`)
    }
  }
  const bold = press(stateAt(first, 5), 'other', keyEvent('b', ctrl))
  const typed = apply(bold, insertText('!')(bold) ?? assert.fail('typing applies'), 10)
  const para = typed.doc.body[0]
  assert.ok(para && para.kind === 'p')
  const runs = para.inlines.flatMap(inline => inline.kind === 'text' ? [[inline.text, inline.marks.bold]] : [])
  assert.deepEqual(runs, [['hello', undefined], ['!', true], [' world', undefined]], 'only the typed character is bold')
})

const at: Pos = { p: paraId('a'), o: 3 }
const elsewhere: Pos = { p: paraId('b'), o: 1 }
const composing: InputMode = { kind: 'composing', at }
const dragging: InputMode = { kind: 'dragging', anchor: at, unit: 'char' }

const compositionStart: ModeEvent = { kind: 'compositionStart', at }
const compositionEnd: ModeEvent = { kind: 'compositionEnd' }
const pointerDown = (unit: DragUnit = 'char'): ModeEvent => ({ kind: 'pointerDown', at: elsewhere, unit })
const pointerUp: ModeEvent = { kind: 'pointerUp' }
const reset: ModeEvent = { kind: 'reset' }

test('a composition starts at the remembered caret and ends back at idle', () => {
  const started = transition(IDLE, compositionStart)
  assert.deepEqual(started, { kind: 'composing', at })
  assert.deepEqual(transition(started, compositionEnd), IDLE)
})

test('a drag remembers its anchor and unit until the pointer is released', () => {
  const started = transition(IDLE, { kind: 'pointerDown', at, unit: 'word' })
  assert.deepEqual(started, { kind: 'dragging', anchor: at, unit: 'word' }, 'a double click drags by word')
  assert.deepEqual(transition(started, pointerUp), IDLE)
})

test('events that mean nothing in a mode return that very mode', () => {
  const ignored: readonly [string, InputMode, ModeEvent][] = [
    ['idle ignores a composition end', IDLE, compositionEnd],
    ['idle ignores a pointer release', IDLE, pointerUp],
    ['idle ignores a reset', IDLE, reset],
    ['composing ignores a second composition start', composing, { kind: 'compositionStart', at: elsewhere }],
    ['composing ignores a pointer press', composing, pointerDown()],
    ['composing ignores a pointer release', composing, pointerUp],
    ['dragging ignores a composition end', dragging, compositionEnd],
  ]
  for (const [name, mode, event] of ignored) {
    assert.equal(transition(mode, event), mode, name)
  }
})

test('a click during composition does not start a drag, and the commit still finds the original caret', () => {
  const clicked = transition(composing, pointerDown())
  assert.deepEqual(clicked, { kind: 'composing', at }, 'the remembered caret is kept')
  assert.deepEqual(transition(clicked, compositionEnd), IDLE)
})

test('a second composition start keeps the first caret', () => {
  assert.deepEqual(transition(composing, { kind: 'compositionStart', at: elsewhere }), { kind: 'composing', at })
})

test('a press during a drag restarts it at the new anchor and unit', () => {
  assert.deepEqual(transition(dragging, pointerDown('paragraph')), { kind: 'dragging', anchor: elsewhere, unit: 'paragraph' })
})

test('a composition that starts during a drag takes over from the drag', () => {
  const taken = transition(dragging, { kind: 'compositionStart', at: elsewhere })
  assert.deepEqual(taken, { kind: 'composing', at: elsewhere })
  assert.equal(transition(taken, pointerUp), taken, 'the late mouseup does not disturb the composition')
})

test('reset abandons a composition or a drag', () => {
  assert.deepEqual(transition(composing, reset), IDLE)
  assert.deepEqual(transition(dragging, reset), IDLE)
})

test('every mode and event pair returns a mode without throwing', () => {
  const events: readonly ModeEvent[] = [compositionStart, compositionEnd, pointerDown('word'), pointerUp, reset]
  for (const mode of [IDLE, composing, dragging]) {
    for (const event of events) {
      const next = transition(mode, event)
      assert.ok(['idle', 'composing', 'dragging'].includes(next.kind), `${mode.kind} then ${event.kind}`)
    }
  }
})
