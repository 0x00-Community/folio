// Events to commands. Owns the hidden textarea (the input sink), the keymap table, IME composition, clipboard, and mouse
// gestures. It holds no document state: it reads editor state and calls editor methods.
import type { Command } from './edit'
import type { Editor } from './editor'
import type { PageView } from './pages'

/**
 * The keymap is data. One table, read by the keydown handler and by the menus (which show the same shortcuts),
 * so a shortcut cannot exist in one place and be missing from the other.
 * Keys are acde chord names ("ctrl+b", "shift+arrowdown"); "mod" is Cmd on macOS and Ctrl elsewhere.
 */
export type Action =
  | { readonly kind: 'command'; readonly command: Command }
  | { readonly kind: 'visual'; readonly motion: 'lineUp' | 'lineDown' | 'pageUp' | 'pageDown' | 'lineStart' | 'lineEnd'; readonly extend: boolean }
  | { readonly kind: 'history'; readonly step: 'undo' | 'redo' }
  | { readonly kind: 'clipboard'; readonly op: 'copy' | 'cut' | 'paste' }

export type Keymap = ReadonlyMap<string, Action>

/** Arrows, Home/End, PageUp/PageDown, Ctrl+arrows, Ctrl+Home/End, Shift variants, Enter, Shift+Enter, Ctrl+Enter,
 *  Backspace, Delete, Ctrl+Backspace, Tab in lists and tables, Ctrl+A/B/I/U/Z/Y, Ctrl+Shift+Z, Ctrl+C/X/V. */
export function defaultKeymap(): Keymap {
  throw new Error('not implemented')
}

/**
 * Wires one textarea to the editor.
 *
 * - keydown: looks up the chord in the keymap; a hit cancels the event and runs the action. Vertical motion asks
 *   PageView for the target Pos and keeps the goal column until a non-vertical action runs.
 * - beforeinput outside composition: cancels it and runs insertText(data). Enter arrives through keydown, not here.
 * - compositionstart: deletes a non-empty selection as a typing step and remembers the caret.
 *   compositionupdate: editor.setPreedit({ pos, text: data }). beforeinput during composition is left alone.
 *   compositionend: editor.setPreedit(null), then insertText(data), then clears the textarea.
 * - copy and cut: fills clipboardData with text/plain (and later text/html) from the selection; cut then deletes.
 *   paste: reads text/plain and runs insertText, which splits paragraphs at "\n".
 * - mousedown on a page: cancels focus loss, places the caret (Shift extends), detail 2 selects the word, detail 3 the
 *   paragraph; mousemove extends with autoscroll near the viewport edges; mouseup ends the drag.
 * - drop of files is the app's concern, not this module's.
 */
export function attachInput(editor: Editor, view: PageView, sink: HTMLTextAreaElement, keymap: Keymap): () => void {
  throw new Error('not implemented')
}

/** Normalizes a KeyboardEvent to a chord name, with "mod" resolved for the platform. */
export function chordOf(event: KeyboardEvent): string {
  throw new Error('not implemented')
}
