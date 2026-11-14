// EditorSession: engine lifecycle, the frame loop, idle sealing, the file handle, save / save as / PDF, dirty title.
//
// Usage (written first):
//
//   // main.ts
//   const session = await EditorSession.boot(document.querySelector('#app')!)
//   self.on('request', (r) => { if (r.kind === 'open-file') void session.openHandle(r.handle) })
//   self.on('beforeclose', () => session.confirmClose())
//
//   // chrome.ts
//   boldButton.onclick = () => session.run({ type: 'toggleMark', mark: 'bold' })
//   zoomSlider.oninput = () => session.setZoom(Number(zoomSlider.value))
//   menu('file', [
//     { id: 'open', label: t('open'), shortcut: 'mod+o', onSelect: () => session.openPicked() },
//     { id: 'save', label: t('save'), shortcut: 'mod+s', onSelect: () => session.save() },
//     { id: 'pdf', label: t('exportPdf'), onSelect: () => session.exportPdf() },
//   ])
//   session.onUpdate((u) => { toolbar.render(u.format); status.render(u.where, session.stats) })
//
//   // input.ts (owned by the session; shown for the call it makes)
//   session.run({ type: 'move', unit: 'line', dir: 'fwd', extend: e.shiftKey })

import { window as self } from 'acde:window'
import type { Command, Editor, EngineModule, Stats, Update } from './wire'
import { InputAdapter } from './input'
import { PageViewport } from './view'

/** Where the bytes came from decides what Save does. A drop handle is read-only (acde files guide). */
type Source =
  | { kind: 'untitled'; name: string }
  | { kind: 'handle'; handle: FileSystemFileHandle; name: string; writable: 'unknown' | 'yes' | 'no' }

type UpdateListener = (u: Update) => void

const IDLE_SEAL_MS = 700
const STATS_DELAY_MS = 400

export class EditorSession {
  private engine: Editor
  private source: Source = { kind: 'untitled', name: '' }
  private raf = 0
  private idleTimer = 0
  private listeners: UpdateListener[] = []
  private last: Update | null = null
  stats: Stats = { words: 0, characters: 0 }

  private constructor(
    private readonly mod: EngineModule,
    private readonly view: PageViewport,
    private readonly input: InputAdapter,
  ) {
    throw new Error('not implemented')
  }

  /** Fetch and instantiate the wasm (no instantiateStreaming in acdert), mount view and input, open a blank doc. */
  static async boot(root: HTMLElement): Promise<EditorSession> {
    throw new Error('not implemented')
  }

  /**
   * The only way anything changes the document or selection. Applies now; paints on the next animation frame,
   * so several commands between frames cost one layout.
   */
  run(cmd: Command): void {
    // TODO: this.engine.apply(cmd); this.schedule(); this.armIdle()
    throw new Error('not implemented')
  }

  onUpdate(listener: UpdateListener): () => void {
    throw new Error('not implemented')
  }

  setZoom(zoom: number): void {
    // Pure view change: no engine call, no relayout.
    throw new Error('not implemented')
  }

  newDocument(): Promise<void> {
    throw new Error('not implemented')
  }

  /** showOpenFilePicker, then openHandle. AbortError is a cancel, not an error. */
  openPicked(): Promise<void> {
    throw new Error('not implemented')
  }

  /** From the picker, a drop (read-only), or an `open-file` request. */
  async openHandle(handle: FileSystemFileHandle): Promise<void> {
    // TODO:
    //   if dirty and !(await this.confirmDiscard()) return
    //   bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer())
    //   next = this.mod.Editor.open(bytes)
    //   await this.loadFonts(next)            // before the first frame, so pages never reflow on font arrival
    //   swap engines (free the old), source = { kind: 'handle', handle, writable: 'unknown' }, view.reset()
    //   schedule()
    throw new Error('not implemented')
  }

  /** Overwrite the opened file through its handle; fall back to Save As for untitled or read-only sources. */
  async save(): Promise<void> {
    // TODO:
    //   if source.kind === 'untitled' || source.writable === 'no' -> return this.saveAs()
    //   bytes = engine.save()                 // seals; marks saved only after the write below succeeds
    //   try { w = await handle.createWritable(); await w.write(bytes); await w.close(); writable = 'yes' }
    //   catch NotAllowedError -> writable = 'no'; return this.saveAs()
    //   schedule()                            // dirty flips in the next Update
    throw new Error('not implemented')
  }

  saveAs(): Promise<void> {
    throw new Error('not implemented')
  }

  /** PDF from the on-screen layout (same fonts, same pages). */
  exportPdf(): Promise<void> {
    throw new Error('not implemented')
  }

  /** `beforeclose` handler. `confirm()` returns false in acde, so this shows the app's own dialog. */
  confirmClose(): Promise<boolean> {
    throw new Error('not implemented')
  }

  private schedule(): void {
    // TODO: if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.flush() })
    throw new Error('not implemented')
  }

  /** One frame: engine frame -> view -> input placement -> listeners -> title. */
  private flush(): void {
    // TODO:
    //   const u = this.engine.frame()
    //   this.view.render(u, (i) => this.engine.page(i), (k) => this.engine.fontBytes(k), (k) => this.engine.mediaBytes(k))
    //   this.input.placeAt(u.caret && this.view.caretClientRect(u.caret))
    //   if (u.notice) toast(t(u.notice))
    //   if (!this.last || u.dirty !== this.last.dirty) self.setTitle(title(this.source, u.dirty))
    //   this.last = u; this.listeners.forEach((l) => l(u))
    throw new Error('not implemented')
  }

  /** After IDLE_SEAL_MS without input: seal an undo checkpoint; after STATS_DELAY_MS: refresh word count. */
  private armIdle(): void {
    throw new Error('not implemented')
  }

  /** GET /api/fonts, then fetch and addFont each wanted family the backend has. */
  private async loadFonts(engine: Editor): Promise<void> {
    throw new Error('not implemented')
  }

  private confirmDiscard(): Promise<boolean> {
    throw new Error('not implemented')
  }
}
