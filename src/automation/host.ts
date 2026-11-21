// The seam between `word.call` and the editor. Unit 3 implements this over `Editor`.
// Tests implement it over `EditorState`, `apply`, `undo`, and `redo`.
import type { ParaId, Pos } from '../model.ts'
import type { Command, EditorState, MediaRef } from '../editor/edit.ts'
import type { Status } from '../editor/editor.ts'

/** The open file. `session` is `Editor.source`: a new object means another file was loaded. */
export interface HostFile {
  /** File name shown for the document. */
  readonly name: string
  /** True when the document differs from the last save. */
  readonly dirty: boolean
  /**
   * Identity of the open file. It stays the same object until another file is loaded.
   * `rev` returns to 0 when this object changes.
   */
  readonly session: object
}

/**
 * What the automation interface needs from the editor.
 * Every member is answered by `Editor`'s public surface, by `listMarkers` of its document,
 * or by the one page-of-a-block method unit 3 adds. `addMedia` is `Source.addMedia`
 * followed by the width conversion `insertImage` already expects.
 */
export interface Host {
  /** The current editor state. */
  state(): EditorState
  /** Run a command the way `Editor.run` does. False when the command returns null. */
  run(command: Command): boolean
  /** Undo one history entry. False when there is nothing to undo. */
  undo(): boolean
  /** Redo one history entry. False when there is nothing to redo. */
  redo(): boolean
  /**
   * 0-based page of a body block, or null when the layout has not measured it.
   * Read views add one, so callers see a 1-based page.
   */
  pageOf(id: string): number | null
  /** The editor status bar: page count, whether layout is finished, and the word count. */
  status(): Status
  /**
   * Why edits are refused, or null when they may run.
   * The app reports `preview`, `dialog`, or `composition`.
   */
  busy(): string | null
  /** Store image bytes and return the media `insertImage` inserts. */
  addMedia(blob: Blob): Promise<MediaRef>
  /** The address under a window point, or null when the point misses the pages. */
  hitTest(clientX: number, clientY: number): Pos | null
  /** The open file's name, dirty flag, and session identity. */
  file(): HostFile
  /** List markers for the current document. The app passes `listMarkers(editor.state.doc)`. */
  markers(): ReadonlyMap<ParaId, string>
  /**
   * Subscribe to editor changes. The app forwards `Editor`'s `change` event.
   * The interface advances `rev` when the document object changes between calls.
   */
  watch(listener: () => void): () => void
}
