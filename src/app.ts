// Owns the open file and the window chrome. Dirty is editor.state.doc !== file.saved.
import { window as appWindow } from 'acde:window'
import { Editor } from './editor/editor.ts'
import { changeIndentLevel, setAlign, setMark, setParaStyle, toggleList, toggleMark } from './editor/edit.ts'
import type { ToggleMark } from './editor/edit.ts'
import { detectPlatform } from './editor/input.ts'
import { OpenError, SaveVerifyError, SaveWriteError, loadEngine, saveTampered } from './engine/engine.ts'
import type { Opened } from './engine/engine.ts'
import { locale, t } from './i18n.ts'
import type { Doc, Pt, StyleId } from './model.ts'
import { createStatus } from './ui/status.ts'
import { createToolbar } from './ui/toolbar.ts'
import { canSave, fileHandleFromRequest, formatTitle, isAbort, isDirty } from './ui/text.ts'
import { createUnsavedDialog } from './ui/unsaved.ts'
import type { UnsavedChoice } from './ui/unsaved.ts'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

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
    onZoom(zoom) {
      edit(() => { current().setZoom(zoom) })
    },
  })
  const status = createStatus(statusRoot)
  const dialog = createUnsavedDialog((choice) => { void answer(choice) })

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
  return { editor, openBytes, save: timedSave, saveTampered: failSave, requestClose }
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
