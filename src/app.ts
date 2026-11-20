// Owns the open file and the window chrome. Dirty is editor.state.doc !== file.saved.
import { window as appWindow } from 'acde:window'
import { Editor } from './editor/editor.ts'
import { changeIndentLevel, deleteColumns, deleteEnclosingTable, deleteRows, insertColumn, insertImage, insertRow, insertTable, setAlign, setMark, setPageSetup, setParaStyle, toggleList, toggleMark } from './editor/edit.ts'
import type { ToggleMark } from './editor/edit.ts'
import { detectPlatform } from './editor/input.ts'
import { OpenError, SaveVerifyError, SaveWriteError, engineBootMs, loadEngine, saveTampered, wasmMemoryBytes } from './engine/engine.ts'
import type { Opened, PrintFontInfo, PrintLayout } from './engine/engine.ts'
import { ensurePrintFonts } from './fonts.ts'
import { locale, t } from './i18n.ts'
import type { Block, Doc, Pt, StyleId } from './model.ts'
import { createStatus } from './ui/status.ts'
import { createToolbar } from './ui/toolbar.ts'
import { canSave, fileHandleFromRequest, formatTitle, isAbort, isDirty } from './ui/text.ts'
import { isDialogOpen } from './ui/dialog.ts'
import { openPageSetup } from './ui/page-setup.ts'
import { openInsertTable } from './ui/table-tools.ts'
import { createUnsavedDialog } from './ui/unsaved.ts'
import type { UnsavedChoice } from './ui/unsaved.ts'
import { describePrintFailure, mountPreview, pdfFileName, previewDpi, PreviewMachine } from './ui/preview.ts'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const PDF_MIME = 'application/pdf'

export interface OpenFile {
  readonly handle: FileSystemFileHandle | null
  readonly name: string
  readonly saved: Doc
}

export interface WordApp {
  readonly editor: Editor
  openBytes(bytes: Uint8Array, name?: string): Promise<void>
  /** Bytes from `source.save`, timed around that call only. Does not write a file or clear the dirty bit. */
  save(): { base64: string; ms: number }
  /**
   * Dev hook: save, then fail verification. Shows the error band, writes nothing and stays dirty.
   * Returns the detail. There is no separate production build, so the hook lives on `window.__word`.
   */
  saveTampered(): string
  /** The `beforeclose` handler. False means the window stays and the dialog is up. */
  requestClose(): boolean
  /** How long the last page-setup confirm blocked, including the relayout. Zero before the first one. */
  pageSetupMs(): number
  /** The wasm memory size now. The print preview e2e reads it after opening and closing. */
  memoryBytes(): number
  /**
   * Dev hook: fetch the CJK faces, lay out the open document, and time the blocking calls.
   * Does not write a file. The PDF is base64. The preview does not call this.
   */
  printLayout(): Promise<PrintMeasure>
}

export type PrintMeasure = {
  readonly pages: number
  readonly pdfBase64: string
  readonly fontMs: number
  readonly layoutMs: number
  readonly pdfMs: number
  readonly pngMs: number
  readonly pngBytes: number
  readonly memoryBefore: number
  readonly memoryAfter: number
  readonly bootMs: number
  readonly fonts: readonly PrintFontInfo[]
}

type Pending = {
  next: () => void
  onCancel?: () => void
}

export async function boot(host: HTMLElement): Promise<WordApp> {
  document.body.classList.add('shell')
  const engine = await loadEngine()
  const platform = detectPlatform(navigator.platform, navigator.userAgent)
  let editor: Editor | null = null
  let file: OpenFile | null = null
  let titleShown = ''
  let tail: Promise<void> = Promise.resolve()
  let pending: Pending | null = null
  let lastPageSetupMs = 0

  const toolbarRoot = required('#toolbar')
  const statusRoot = required('#status')
  const toolbar = createToolbar(toolbarRoot, platform, {
    onNew() {
      confirmReplace(() => newDocument())
    },
    onOpen() {
      confirmReplace(() => { void openWithPicker() })
    },
    onSave() {
      void saveFromToolbar(false)
    },
    onSaveAs() {
      void saveFromToolbar(true)
    },
    onUndo() {
      edit(() => { current().undo() })
    },
    onRedo() {
      edit(() => { current().redo() })
    },
    onMark(mark: ToggleMark) {
      edit(() => { current().run(toggleMark(mark)) })
    },
    onFont(family: string) {
      edit(() => { current().run(setMark({ mark: 'font', value: family })) })
    },
    onSize(sizePt: number) {
      edit(() => { current().run(setMark({ mark: 'sizePt', value: sizePt as Pt })) })
    },
    onStyle(id: string) {
      edit(() => { current().run(setParaStyle(id as StyleId)) })
    },
    onAlign(align) {
      edit(() => { current().run(setAlign(align)) })
    },
    onList(kind) {
      edit(() => { current().run(toggleList(kind)) })
    },
    onIndent(delta) {
      edit(() => { current().run(changeIndentLevel(delta)) })
    },
    onPageSetup() {
      const editorNow = current()
      const section = editorNow.status().section
      const page = editorNow.state.doc.sections[section]?.page
      if (!page || isDialogOpen()) return
      void openPageSetup(page).then((next) => {
        if (!next) {
          current().focus()
          return
        }
        const started = performance.now()
        edit(() => { current().run(setPageSetup(section, next)) })
        lastPageSetupMs = performance.now() - started
      })
    },
    onPrint() {
      void openPreview()
    },
    onInsertTable() {
      if (isDialogOpen() || current().toolbar().inTable) return
      void openInsertTable().then((size) => {
        if (!size || current().toolbar().inTable) {
          current().focus()
          return
        }
        edit(() => { current().run(insertTable(size.rows, size.cols)) })
      })
    },
    onInsertImage() {
      void insertPicture()
    },
    onTableRow(where) {
      edit(() => { current().run(insertRow(where)) })
    },
    onDeleteRows() {
      edit(() => { current().run(deleteRows()) })
    },
    onTableColumn(where) {
      if (!current().toolbar().columnTools) return
      edit(() => { current().run(insertColumn(where)) })
    },
    onDeleteColumns() {
      if (!current().toolbar().columnTools) return
      edit(() => { current().run(deleteColumns()) })
    },
    onDeleteTable() {
      edit(() => { current().run(deleteEnclosingTable()) })
    },
    onZoom(zoom) {
      edit(() => { current().setZoom(zoom) })
    },
  })
  const status = createStatus(statusRoot)
  const dialog = createUnsavedDialog((choice) => { void answer(choice) })
  const pages = host
  const machine = new PreviewMachine<PrintLayout>()
  let heldScroll = { top: 0, left: 0 }
  const preview = mountPreview(pages, machine, {
    onCancel() {
      requestPreviewClose()
    },
    onClose() {
      requestPreviewClose()
    },
    onExport() {
      void exportPdf()
    },
    onRenderError(error) {
      failPreview(error)
    },
  })
  // The dialog's own listener is capture-phase and stops Escape while it is open.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || isDialogOpen()) return
    const phase = machine.phase
    if (phase === 'closed' || phase === 'unusable' || phase === 'failed') return
    event.preventDefault()
    requestPreviewClose()
  })

  function current(): Editor {
    if (!editor) throw new Error('editor is not ready')
    return editor
  }

  function renderChrome(): void {
    const currentEditor = current()
    const name = file?.name ?? t('untitled')
    const title = formatTitle(name, isDirty(currentEditor.state.doc, file), t('title'))
    if (title !== titleShown) {
      titleShown = title
      document.title = title
      appWindow.setTitle(title)
    }
    toolbar.render(
      currentEditor.toolbar(),
      currentEditor.state.doc,
      currentEditor.source.fontsUsed(currentEditor.state.doc),
      canSave(currentEditor.state.doc, file),
    )
    status.render(currentEditor.status(), toolbar.zoom())
  }

  function edit(run: () => void): void {
    run()
    renderChrome()
    current().focus()
  }

  function adopt(opened: Opened, handle: FileSystemFileHandle | null, name: string): void {
    const currentEditor = current()
    currentEditor.load(opened)
    file = { handle, name, saved: currentEditor.state.doc }
    clearError()
    renderChrome()
  }

  function newDocument(): void {
    adopt(engine.blank(), null, t('untitled'))
    current().focus()
  }

  // New, Open and a system open ask before replacing a dirty document. Closing asks in requestClose.
  // openBytes is the test hook, so it passes ask false and replaces immediately.
  function confirmReplace(next: () => void, onCancel?: () => void, ask = true): void {
    const currentEditor = current()
    if (ask && file && isDirty(currentEditor.state.doc, file)) {
      pending = { next, onCancel }
      if (!dialog.open) dialog.ask(file.name)
      return
    }
    next()
  }

  function requestClose(): boolean {
    if (dialog.open) return false
    const currentEditor = current()
    if (!file || !isDirty(currentEditor.state.doc, file)) return true
    pending = null
    dialog.ask(file.name)
    return false
  }

  async function answer(choice: UnsavedChoice): Promise<void> {
    const job = pending
    pending = null
    if (choice === 'cancel') {
      job?.onCancel?.()
      current().focus()
      return
    }
    if (choice === 'discard') {
      if (job) job.next()
      else appWindow.close()
      return
    }
    const ok = await enqueueSave(false)
    await drain()
    if (!ok || isDirty(current().state.doc, file)) {
      if (!ok) job?.onCancel?.()
      current().focus()
      return
    }
    if (job) job.next()
    else appWindow.close()
  }

  function enqueueSave(asNew: boolean): Promise<boolean> {
    const run = tail.then(() => performSave(asNew))
    tail = run.then(() => undefined, () => undefined)
    return run
  }

  async function drain(): Promise<void> {
    let seen = tail
    for (;;) {
      await seen
      if (tail === seen) return
      seen = tail
    }
  }

  async function saveFromToolbar(asNew: boolean): Promise<void> {
    const ok = await enqueueSave(asNew)
    if (ok) current().focus()
  }

  async function performSave(asNew: boolean): Promise<boolean> {
    const currentEditor = current()
    const doc = currentEditor.state.doc
    const open = file
    if (!asNew && open?.handle && doc === open.saved) return true
    let bytes: Uint8Array
    try {
      bytes = currentEditor.source.save(doc)
    } catch (error) {
      showSaveError(error)
      renderChrome()
      return false
    }
    const name = open?.name ?? t('untitled')
    let handle = !asNew && open?.handle ? open.handle : null
    if (handle) {
      const wrote = await tryWrite(handle, bytes)
      if (!wrote) handle = null
    }
    if (!handle) {
      let picked: FileSystemFileHandle | null
      try {
        picked = await pickSave(name)
      } catch (error) {
        showSaveError(error)
        renderChrome()
        return false
      }
      if (!picked) return false
      try {
        await writeBytes(picked, bytes)
      } catch (error) {
        if (isAbort(error)) return false
        showSaveError(error)
        renderChrome()
        return false
      }
      handle = picked
    }
    const writtenName = handle.name || name
    file = { handle, name: writtenName, saved: doc }
    clearError()
    renderChrome()
    return true
  }

  async function openHandle(handle: FileSystemFileHandle): Promise<void> {
    let bytes: Uint8Array
    let name: string
    try {
      const blob = await handle.getFile()
      bytes = new Uint8Array(await blob.arrayBuffer())
      name = blob.name || handle.name
    } catch {
      // The system can refuse the read after the pick, for example a folder the runtime has no permission for.
      showOpenError('unreadable')
      return
    }
    try {
      adopt(engine.open(bytes), handle, name)
    } catch (error) {
      if (error instanceof OpenError) {
        showOpenError(error.reason)
        return
      }
      throw error
    }
  }

  async function insertPicture(): Promise<void> {
    try {
      const picked = await window.showOpenFilePicker({
        multiple: false,
        types: [{
          description: t('file.image'),
          accept: { 'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'] },
        }],
      })
      const handle = picked[0]
      if (!handle) return
      const blob = await handle.getFile()
      const media = await current().source.addMedia(blob)
      edit(() => {
        current().run(insertImage({
          key: media.key,
          contentType: media.contentType,
          widthPx: media.widthPt / 0.75,
          heightPx: media.heightPt / 0.75,
        }))
      })
      clearError()
    } catch (error) {
      if (isAbort(error)) return
      showBand(t('image.error'))
    } finally {
      current().focus()
    }
  }

  async function openWithPicker(): Promise<void> {
    try {
      const picked = await window.showOpenFilePicker({
        multiple: false,
        types: [{ description: t('file.docx'), accept: { [DOCX_MIME]: ['.docx'] } }],
      })
      const handle = picked[0]
      if (!handle) return
      await openHandle(handle)
    } catch (error) {
      if (!isAbort(error)) throw error
    } finally {
      current().focus()
    }
  }

  function openBytes(bytes: Uint8Array, name?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      confirmReplace(() => {
        try {
          adopt(engine.open(bytes), null, name && name.length > 0 ? name : t('openedName'))
        } catch (error) {
          if (error instanceof OpenError) showOpenError(error.reason)
          reject(error)
          return
        }
        void whenLaidOut(current()).then(resolve, reject)
      }, undefined, false)
    })
  }

  function timedSave(): { base64: string; ms: number } {
    const doc = current().state.doc
    const started = performance.now()
    const bytes = current().source.save(doc)
    const ms = performance.now() - started
    return { base64: encodeBase64(bytes), ms }
  }

  function failSave(): string {
    try {
      saveTampered(current().source, current().state.doc)
    } catch (error) {
      showSaveError(error)
      renderChrome()
      return saveDetail(error)
    }
    return ''
  }

  const opened = engine.blank()
  editor = Editor.mount(host, opened, { locale: locale === 'zh' ? 'zh' : 'en' })
  file = { handle: null, name: t('untitled'), saved: editor.state.doc }
  editor.on('change', renderChrome)
  editor.onFile((op) => { void saveFromToolbar(op === 'saveAs') })
  renderChrome()
  // A file the user opened with this app arrives as a system request. The runtime holds it until a handler exists.
  appWindow.on('request', request => {
    const handle = fileHandleFromRequest(request)
    if (!handle) return
    confirmReplace(() => { void openHandle(handle).then(() => current().focus()) })
  })
  // Return false at once. The runtime closes a dirty window if beforeclose is still pending after 3 seconds.
  // close() does not ask again, so Save and Don't save close the window themselves.
  appWindow.on('beforeclose', () => requestClose())

  function concealEditing(): void {
    toolbarRoot.hidden = true
    pages.hidden = true
  }

  function revealEditing(scroll: { top: number; left: number }): void {
    preview.hide()
    toolbarRoot.hidden = false
    pages.hidden = false
    const restore = (): void => {
      const phase = machine.phase
      if (phase !== 'closed' && phase !== 'unusable' && phase !== 'failed') return
      pages.scrollTop = scroll.top
      pages.scrollLeft = scroll.left
    }
    restore()
    // The page view may relayout on the frame it becomes visible and clamp the position.
    requestAnimationFrame(() => {
      restore()
      requestAnimationFrame(restore)
    })
    current().focus()
  }

  function requestPreviewClose(): void {
    const phase = machine.phase
    if (phase === 'preparing') {
      machine.cancel()
      preview.markCancelling()
      return
    }
    if (phase !== 'open' && phase !== 'exporting') return
    const scroll = heldScroll
    try {
      preview.hide()
      if (machine.close() === 'unusable') showBand(t('print.reopen'))
    } catch (error) {
      const failure = describePrintFailure(error, t)
      if (failure.abort) machine.abort()
      showBand(failure.message)
    } finally {
      revealEditing(scroll)
    }
  }

  function failPreview(error: unknown): void {
    const failure = describePrintFailure(error, t)
    preview.hide()
    if (failure.abort) {
      machine.abort()
      revealEditing(heldScroll)
      showBand(failure.message)
      return
    }
    if (machine.phase === 'cancelling') {
      const phase = machine.finishCancel()
      revealEditing(heldScroll)
      if (phase === 'unusable') showBand(t('print.reopen'))
      return
    }
    if (machine.phase !== 'closed' && machine.phase !== 'unusable') {
      const phase = machine.fail()
      if (phase === 'unusable') {
        revealEditing(heldScroll)
        showBand(t('print.reopen'))
        return
      }
      machine.dismiss()
    }
    revealEditing(heldScroll)
    showBand(failure.message)
  }

  async function openPreview(): Promise<void> {
    if (isDialogOpen()) return
    if (machine.phase === 'unusable') {
      showBand(t('print.reopen'))
      return
    }
    if (!machine.begin()) return
    const editorNow = current()
    const doc = editorNow.state.doc
    heldScroll = { top: pages.scrollTop, left: pages.scrollLeft }
    concealEditing()
    preview.showPreparing()
    clearError()
    try {
      // The status line has to paint before printLayout blocks the thread.
      await paintFrame()
      await paintFrame()
      if (machine.phase !== 'preparing') {
        machine.finishCancel()
        revealEditing(heldScroll)
        return
      }
      await ensurePrintFonts(editorNow.source, editorNow.source.fontsUsed(doc), documentHasHan(doc))
      if (machine.phase !== 'preparing') {
        machine.finishCancel()
        revealEditing(heldScroll)
        return
      }
      const layout = editorNow.source.printLayout(doc)
      // The click is queued during the blocking call. This timer is queued after it, so settle sees the cancel.
      await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
      const settled = machine.settle(layout)
      if (settled !== 'open') {
        revealEditing(heldScroll)
        if (settled === 'unusable') showBand(t('print.reopen'))
        return
      }
      preview.showPages(layout, previewDpi(window.devicePixelRatio), {
        pages: layout.pageCount(),
        fonts: layout.fonts(),
      })
    } catch (error) {
      failPreview(error)
    }
  }

  async function exportPdf(): Promise<void> {
    if (!machine.startExport()) return
    preview.setExporting(true)
    const layout = machine.held()
    if (layout === null) {
      machine.finishExport()
      preview.setExporting(false)
      return
    }
    let bytes: Uint8Array
    try {
      bytes = layout.pdf()
    } catch (error) {
      failPreview(error)
      return
    }
    const suggested = pdfFileName(file?.name ?? t('untitled'))
    try {
      const picked = await pickPdf(suggested)
      if (machine.phase !== 'exporting') return
      if (!picked) {
        machine.finishExport()
        preview.setExporting(false)
        return
      }
      await writeBytes(picked, bytes)
      if (machine.phase !== 'exporting') return
      machine.finishExport()
      preview.setExporting(false)
    } catch (error) {
      if (machine.phase === 'exporting') {
        machine.finishExport()
        preview.setExporting(false)
      }
      if (isAbort(error)) return
      const detail = error instanceof Error ? error.message : String(error)
      showBand(t('print.error.write', { detail }))
    }
  }

  async function measurePrint(): Promise<PrintMeasure> {
    const editorNow = current()
    const doc = editorNow.state.doc
    const memoryBefore = wasmMemoryBytes()
    const fontStarted = performance.now()
    await ensurePrintFonts(editorNow.source, editorNow.source.fontsUsed(doc), documentHasHan(doc))
    const fontMs = performance.now() - fontStarted
    const layoutStarted = performance.now()
    const layout = editorNow.source.printLayout(doc)
    const layoutMs = performance.now() - layoutStarted
    try {
      const pdfStarted = performance.now()
      const pdf = layout.pdf()
      const pdfMs = performance.now() - pdfStarted
      const pngStarted = performance.now()
      const png = layout.pagePng(0, 144)
      const pngMs = performance.now() - pngStarted
      return {
        pages: layout.pageCount(),
        pdfBase64: encodeBase64(pdf),
        fontMs,
        layoutMs,
        pdfMs,
        pngMs,
        pngBytes: png.byteLength,
        memoryBefore,
        memoryAfter: wasmMemoryBytes(),
        bootMs: engineBootMs(),
        fonts: layout.fonts(),
      }
    } finally {
      layout.free()
    }
  }

  return {
    editor,
    openBytes,
    save: timedSave,
    saveTampered: failSave,
    requestClose,
    pageSetupMs: () => lastPageSetupMs,
    memoryBytes: () => wasmMemoryBytes(),
    printLayout: measurePrint,
  }
}

function documentHasHan(doc: Doc): boolean {
  const han = /\p{Script=Han}/u
  const visit = (blocks: readonly Block[]): boolean => {
    for (const block of blocks) {
      if (block.kind === 'p') {
        for (const inline of block.inlines) {
          if (inline.kind === 'text' && han.test(inline.text)) return true
        }
      } else if (block.kind === 'table') {
        for (const row of block.rows) {
          for (const cell of row.cells) {
            if (visit(cell.blocks)) return true
          }
        }
      } else if (visit(block.preview)) {
        return true
      }
    }
    return false
  }
  if (visit(doc.body)) return true
  for (const blocks of doc.stories.values()) {
    if (visit(blocks)) return true
  }
  return false
}

function required(selector: string): HTMLElement {
  const el = document.querySelector(selector)
  if (!(el instanceof HTMLElement)) throw new Error(`missing ${selector}`)
  return el
}

async function tryWrite(handle: FileSystemFileHandle, bytes: Uint8Array): Promise<boolean> {
  try {
    await writeBytes(handle, bytes)
    return true
  } catch {
    return false
  }
}

async function writeBytes(handle: FileSystemFileHandle, bytes: Uint8Array): Promise<void> {
  const writable = await handle.createWritable()
  try {
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    await writable.write(copy)
    await writable.close()
  } catch (error) {
    await writable.abort().catch(() => undefined)
    throw error
  }
}

function paintFrame(): Promise<void> {
  return new Promise((resolve) => { requestAnimationFrame(() => resolve()) })
}

async function pickPdf(name: string): Promise<FileSystemFileHandle | null> {
  try {
    return await window.showSaveFilePicker({
      suggestedName: name,
      types: [{ description: t('file.pdf'), accept: { [PDF_MIME]: ['.pdf'] } }],
    })
  } catch (error) {
    if (isAbort(error)) return null
    throw error
  }
}

async function pickSave(name: string): Promise<FileSystemFileHandle | null> {
  try {
    return await window.showSaveFilePicker({
      suggestedName: name,
      types: [{ description: t('file.docx'), accept: { [DOCX_MIME]: ['.docx'] } }],
    })
  } catch (error) {
    if (isAbort(error)) return null
    throw error
  }
}

function saveDetail(error: unknown): string {
  if (error instanceof SaveVerifyError) return error.firstDifference
  if (error instanceof SaveWriteError) return error.detail
  if (error instanceof Error) return error.message
  return String(error)
}

function showSaveError(error: unknown): void {
  showBand(t('save.error', { detail: saveDetail(error) }))
}

function showOpenError(reason: OpenError['reason'] | 'unreadable'): void {
  showBand(t(`open.error.${reason}`))
}

function showBand(message: string): void {
  const el = document.querySelector('#open-error')
  if (!(el instanceof HTMLElement)) return
  if (el.textContent !== message) el.textContent = message
  if (el.hidden) el.hidden = false
}

function clearError(): void {
  const el = document.querySelector('#open-error')
  if (!(el instanceof HTMLElement)) return
  if (el.textContent) el.textContent = ''
  if (!el.hidden) el.hidden = true
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x2000
  for (let i = 0; i < bytes.length; i += chunk) {
    const piece = bytes.subarray(i, i + chunk)
    binary += String.fromCharCode(...piece)
  }
  return btoa(binary)
}

function whenLaidOut(editor: Editor): Promise<void> {
  return new Promise(resolve => {
    const tick = (): void => {
      if (editor.status().pagesFinal) resolve()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}
