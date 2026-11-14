// The Editor facade: the only editor module the app imports. Holds EditorState, runs commands, drives PageView,
// derives toolbar and status state, and emits 'change'. Everything else in editor/ is reachable only through it
// (a lint rule rejects imports of editor/* from outside editor/ except editor.ts and edit.ts's commands).
import type { Doc, Pos } from '../model'
import type { Source, Opened } from '../engine'
import { type EditorState, type Command, type ToolbarState } from './edit'
import type { Decoration } from './render'

export interface EditorOptions {
  readonly locale: 'zh' | 'en'
}

export interface Status {
  /** 1-based page holding the caret. */
  readonly page: number
  readonly pages: number
  /** False while a large document is still being measured; the UI shows "≥ pages". */
  readonly pagesFinal: boolean
  readonly words: number
  /** Section index holding the caret, for page setup. */
  readonly section: number
}

export class Editor {
  /** Creates the page view, the hidden textarea and its listeners inside `host`, and shows the opened document. */
  static mount(host: HTMLElement, opened: Opened, options: EditorOptions): Editor {
    throw new Error('not implemented')
  }

  /** Replaces the document and the rdocx session; frees the previous session; resets history and selection. */
  load(opened: Opened): void {
    throw new Error('not implemented')
  }

  get state(): EditorState {
    throw new Error('not implemented')
  }

  /** The rdocx session the current document came from: save, export, fonts, media. */
  get source(): Source {
    throw new Error('not implemented')
  }

  /**
   * Runs a command. On a transaction: apply() with history, PageView.update(previous, next), paint the caret, scroll
   * it into view, schedule 'change' for the next animation frame. Returns false when the command did not apply.
   */
  run(command: Command): boolean {
    throw new Error('not implemented')
  }

  undo(): boolean {
    throw new Error('not implemented')
  }

  redo(): boolean {
    throw new Error('not implemented')
  }

  /** IME preedit from input.ts. View-only; never enters state or history. */
  setPreedit(deco: Decoration | null): void {
    throw new Error('not implemented')
  }

  /** Called once per animation frame after changes, never per keystroke synchronously. */
  on(event: 'change', listener: () => void): () => void {
    throw new Error('not implemented')
  }

  toolbar(): ToolbarState {
    throw new Error('not implemented')
  }

  status(): Status {
    throw new Error('not implemented')
  }

  setZoom(zoom: number): void {
    throw new Error('not implemented')
  }

  focus(): void {
    throw new Error('not implemented')
  }

  destroy(): void {
    throw new Error('not implemented')
  }
}

export type { Doc, Pos }
