// The pure half of the input layer: the keymap, chord naming, and the input mode machine. No DOM, no editor state.
import type { Pos } from '../model.ts'
import {
  deleteBackward,
  deleteForward,
  insertLineBreak,
  insertPageBreak,
  move,
  selectAll,
  splitParagraph,
  toggleMark,
} from './edit.ts'
import type { Command, LogicalUnit } from './edit.ts'

export type Platform = 'mac' | 'other'

/** Motion that needs line geometry, so edit.ts cannot express it as a Command. PageView resolves the target Pos. */
export type VisualMotion = 'lineUp' | 'lineDown' | 'pageUp' | 'pageDown' | 'lineStart' | 'lineEnd'

export type Action =
  | { readonly kind: 'command'; readonly command: Command }
  | { readonly kind: 'visual'; readonly motion: VisualMotion; readonly extend: boolean }
  | { readonly kind: 'history'; readonly step: 'undo' | 'redo' }
  | { readonly kind: 'clipboard'; readonly op: 'copy' | 'cut' | 'paste' }

export type Binding = readonly [chord: string, action: Action]

/**
 * One table, read by the keydown handler and by the menus, so a shortcut cannot exist in one place and be missing from
 * the other. Keys are chord names as chordOf spells them.
 */
export type Keymap = ReadonlyMap<string, Action>

export type DragUnit = 'char' | 'word' | 'paragraph'

export type InputMode =
  | { readonly kind: 'idle' }
  /** `at` is the caret where the preedit is drawn, taken after compositionstart deleted any selection. */
  | { readonly kind: 'composing'; readonly at: Pos }
  /** `unit` is 'word' or 'paragraph' after a double or triple click, and the drag then extends by that unit. */
  | { readonly kind: 'dragging'; readonly anchor: Pos; readonly unit: DragUnit }

export type ModeEvent =
  | { readonly kind: 'compositionStart'; readonly at: Pos }
  | { readonly kind: 'compositionEnd' }
  | { readonly kind: 'pointerDown'; readonly at: Pos; readonly unit: DragUnit }
  | { readonly kind: 'pointerUp' }
  /** Blur, a new document, or destroy: whatever was in flight is abandoned. */
  | { readonly kind: 'reset' }

export type KeyFields = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>

export const IDLE: InputMode = { kind: 'idle' }

/**
 * Every (mode, event) pair has an answer. An event that means nothing in the current mode returns `mode` itself, so a
 * caller can tell "ignored" from "moved" by identity.
 */
export function transition(mode: InputMode, event: ModeEvent): InputMode {
  switch (mode.kind) {
    case 'idle':
      switch (event.kind) {
        case 'compositionStart': return { kind: 'composing', at: event.at }
        case 'pointerDown': return { kind: 'dragging', anchor: event.at, unit: event.unit }
        case 'compositionEnd':
        case 'pointerUp':
        case 'reset': return mode
      }
    case 'composing':
      switch (event.kind) {
        case 'compositionEnd':
        case 'reset': return IDLE
        // A click cannot start a drag until the IME commits, or the committed text would land at the old caret.
        case 'pointerDown':
        case 'compositionStart':
        case 'pointerUp': return mode
      }
    case 'dragging':
      switch (event.kind) {
        // Typing through an IME while the button is down wins over the drag, so the committed text is not lost.
        case 'compositionStart': return { kind: 'composing', at: event.at }
        // A press while dragging means the earlier mouseup never arrived (released outside the window).
        case 'pointerDown': return { kind: 'dragging', anchor: event.at, unit: event.unit }
        case 'pointerUp':
        case 'reset': return IDLE
        case 'compositionEnd': return mode
      }
  }
}

type ModifierField = Exclude<keyof KeyFields, 'key'>

// "mod" is the platform's primary modifier, so Cmd on macOS and Ctrl elsewhere both read "mod". The other one of the
// pair keeps its own name. The order of each list is the canonical modifier order in a chord.
const MODIFIERS: Readonly<Record<Platform, readonly (readonly [name: string, field: ModifierField])[]>> = {
  mac: [['mod', 'metaKey'], ['ctrl', 'ctrlKey'], ['alt', 'altKey'], ['shift', 'shiftKey']],
  other: [['mod', 'ctrlKey'], ['meta', 'metaKey'], ['alt', 'altKey'], ['shift', 'shiftKey']],
}

// A space would split a chord's words and "+" would be read as the separator.
const KEY_NAMES: ReadonlyMap<string, string> = new Map([[' ', 'space'], ['+', 'plus']])

/** "mod+b", "mod+shift+z", "shift+arrowdown": modifiers in canonical order, then the lower-cased key, joined by "+". */
export function chordOf(event: KeyFields, platform: Platform): string {
  const held = MODIFIERS[platform].filter(([, field]) => event[field]).map(([name]) => name)
  return [...held, KEY_NAMES.get(event.key) ?? event.key.toLowerCase()].join('+')
}

/** Refuses a chord bound twice, which a Map would otherwise settle silently in favor of the later one. */
export function buildKeymap(bindings: Iterable<Binding>): Keymap {
  const map = new Map<string, Action>()
  for (const [chord, action] of bindings) {
    if (map.has(chord)) throw new RangeError(`chord "${chord}" is bound twice`)
    map.set(chord, action)
  }
  return map
}

function run(command: Command): Action {
  return { kind: 'command', command }
}

function step(direction: 'backward' | 'forward', unit: LogicalUnit): (extend: boolean) => Action {
  return (extend) => run(move(direction, unit, extend))
}

function glide(motion: VisualMotion): (extend: boolean) => Action {
  return (extend) => ({ kind: 'visual', motion, extend })
}

/** The chord as given, and the chord with Shift added, which extends the selection. Shift sorts last before the key. */
function extendable(chord: string, make: (extend: boolean) => Action): Binding[] {
  const parts = chord.split('+')
  const key = parts.pop()
  return [[chord, make(false)], [[...parts, 'shift', key].join('+'), make(true)]]
}

/**
 * Word motion and word deletion sit on Alt on macOS and on Ctrl elsewhere. macOS then spends Cmd on line and document
 * edges and Alt+Up/Down on paragraphs. Elsewhere those are Home, End and Ctrl+Home/End.
 */
export function defaultKeymap(platform: Platform): Keymap {
  const word = platform === 'mac' ? 'alt' : 'mod'
  const common: Binding[] = [
    ...extendable('arrowleft', step('backward', 'char')),
    ...extendable('arrowright', step('forward', 'char')),
    ...extendable('arrowup', glide('lineUp')),
    ...extendable('arrowdown', glide('lineDown')),
    ...extendable('pageup', glide('pageUp')),
    ...extendable('pagedown', glide('pageDown')),
    ...extendable('home', glide('lineStart')),
    ...extendable('end', glide('lineEnd')),
    ...extendable('mod+home', step('backward', 'document')),
    ...extendable('mod+end', step('forward', 'document')),
    ...extendable(`${word}+arrowleft`, step('backward', 'word')),
    ...extendable(`${word}+arrowright`, step('forward', 'word')),
    ['enter', run(splitParagraph)],
    ['shift+enter', run(insertLineBreak)],
    ['mod+enter', run(insertPageBreak)],
    ['backspace', run(deleteBackward('char'))],
    ['delete', run(deleteForward('char'))],
    [`${word}+backspace`, run(deleteBackward('word'))],
    [`${word}+delete`, run(deleteForward('word'))],
    ['mod+a', run(selectAll)],
    ['mod+b', run(toggleMark('bold'))],
    ['mod+i', run(toggleMark('italic'))],
    ['mod+u', run(toggleMark('underline'))],
    ['mod+z', { kind: 'history', step: 'undo' }],
    ['mod+y', { kind: 'history', step: 'redo' }],
    ['mod+shift+z', { kind: 'history', step: 'redo' }],
    ['mod+c', { kind: 'clipboard', op: 'copy' }],
    ['mod+x', { kind: 'clipboard', op: 'cut' }],
    ['mod+v', { kind: 'clipboard', op: 'paste' }],
  ]
  const mac: Binding[] = [
    ...extendable('mod+arrowleft', glide('lineStart')),
    ...extendable('mod+arrowright', glide('lineEnd')),
    ...extendable('mod+arrowup', step('backward', 'document')),
    ...extendable('mod+arrowdown', step('forward', 'document')),
    ...extendable('alt+arrowup', step('backward', 'paragraph')),
    ...extendable('alt+arrowdown', step('forward', 'paragraph')),
  ]
  return buildKeymap(platform === 'mac' ? [...common, ...mac] : common)
}
