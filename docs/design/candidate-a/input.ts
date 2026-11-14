// InputAdapter: turns keyboard, IME, clipboard and pointer events into Commands. Holds no document state.
//
// Usage (written first):
//
//   const input = new InputAdapter(viewportEl, (cmd) => session.run(cmd), {
//     toDocPoint: (e) => view.toDocPoint(e.clientX, e.clientY),
//     selectedText: () => engine.selectedText(),
//     viewportPt: () => view.viewportHeightPt(),
//   })
//   input.placeAt(caretClientRect)   // every frame, so the IME candidate window follows the caret
//   input.focus()

import type { Command, DocPoint } from './wire'

type Run = (cmd: Command) => void

type Deps = {
  toDocPoint: (e: PointerEvent) => DocPoint | null
  selectedText: () => string
  viewportPt: () => number
}

/** IME phases. While composing, beforeinput/input are ignored and only composition events drive the engine. */
type Ime = { phase: 'idle' } | { phase: 'composing'; last: string }

/** Pointer gesture; `clicks` comes from PointerEvent.detail (1 caret, 2 word, 3 paragraph). */
type Gesture = { phase: 'none' } | { phase: 'pressed'; pointerId: number; clicks: number }

/** Key chord, normalized: 'mod' is Cmd on macOS and Ctrl elsewhere. */
type Chord = string

/**
 * One table from chord to command. Adding a shortcut is one row; no handler grows an if/else chain.
 * Text-producing keys are not here: they arrive as beforeinput insertText or composition.
 */
const KEYMAP: ReadonlyArray<readonly [Chord, (d: Deps) => Command]> = [
  ['Enter', () => ({ type: 'insertParagraph' })],
  ['shift+Enter', () => ({ type: 'insertLineBreak' })],
  ['Backspace', () => ({ type: 'delete', dir: 'back', unit: 'char' })],
  ['mod+Backspace', () => ({ type: 'delete', dir: 'back', unit: 'word' })],
  ['Delete', () => ({ type: 'delete', dir: 'fwd', unit: 'char' })],
  ['ArrowLeft', () => ({ type: 'move', unit: 'char', dir: 'back', extend: false })],
  ['shift+ArrowLeft', () => ({ type: 'move', unit: 'char', dir: 'back', extend: true })],
  ['mod+ArrowLeft', () => ({ type: 'move', unit: 'word', dir: 'back', extend: false })],
  ['ArrowUp', () => ({ type: 'move', unit: 'line', dir: 'back', extend: false })],
  ['Home', () => ({ type: 'move', unit: 'lineEdge', dir: 'back', extend: false })],
  ['mod+Home', () => ({ type: 'move', unit: 'docEdge', dir: 'back', extend: false })],
  ['PageDown', (d) => ({ type: 'move', unit: { screen: { viewportPt: d.viewportPt() } }, dir: 'fwd', extend: false })],
  ['mod+a', () => ({ type: 'selectAll' })],
  ['mod+b', () => ({ type: 'toggleMark', mark: 'bold' })],
  ['mod+i', () => ({ type: 'toggleMark', mark: 'italic' })],
  ['mod+u', () => ({ type: 'toggleMark', mark: 'underline' })],
  ['mod+z', () => ({ type: 'undo' })],
  ['mod+shift+z', () => ({ type: 'redo' })],
  ['Tab', () => ({ type: 'listLevel', delta: 1 })],
  // ... the remaining arrow / shift / mod variants are generated from one direction table, not listed by hand.
]

export class InputAdapter {
  /** Transparent, 1px wide, never display:none; positioned at the caret so the OS IME window appears there. */
  private readonly sink: HTMLTextAreaElement
  private ime: Ime = { phase: 'idle' }
  private gesture: Gesture = { phase: 'none' }

  constructor(private readonly surface: HTMLElement, private readonly run: Run, private readonly deps: Deps) {
    // TODO: create sink; listen keydown, beforeinput, compositionstart/update/end, copy, cut, paste on the sink;
    // pointerdown/move/up on the surface (setPointerCapture during a drag); refocus the sink on pointerup.
    throw new Error('not implemented')
  }

  focus(): void {
    throw new Error('not implemented')
  }

  /** Client-space caret rect from the view; null hides nothing, it just leaves the sink where it was. */
  placeAt(rect: DOMRect | null): void {
    throw new Error('not implemented')
  }

  private onKeyDown(e: KeyboardEvent): void {
    // TODO: if (e.isComposing || this.ime.phase === 'composing') return
    //   const hit = lookup(chord(e)); if (hit) { e.preventDefault(); this.run(hit(this.deps)) }
    throw new Error('not implemented')
  }

  private onBeforeInput(e: InputEvent): void {
    // TODO: always preventDefault so the sink stays empty.
    //   composing -> ignore (composition events carry the text)
    //   insertText -> run({ type: 'insertText', text: e.data })
    //   insertLineBreak / insertParagraph -> handled by keydown already; ignore
    throw new Error('not implemented')
  }

  private onComposition(e: CompositionEvent): void {
    // TODO: start  -> ime = composing; run(compose start)
    //       update -> if data !== last: run(compose update data)
    //       end    -> run(data ? compose commit data : compose cancel); ime = idle; sink.value = ''
    throw new Error('not implemented')
  }

  /** copy/cut write plain text from the engine; cut then deletes the selection; paste reads text/plain. */
  private onClipboard(e: ClipboardEvent): void {
    throw new Error('not implemented')
  }

  private onPointer(e: PointerEvent): void {
    // TODO: down -> run(pointer down, clicks = e.detail, extend = e.shiftKey); capture
    //       move while pressed -> run(pointer drag); up -> run(pointer up); release; focus()
    throw new Error('not implemented')
  }
}
