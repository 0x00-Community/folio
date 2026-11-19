// Owns the open file and the window chrome. Dirty is editor.state.doc !== file.saved.
import { window as appWindow } from 'acde:window'
import { Editor } from './editor/editor.ts'
import { setAlign, setMark, setParaStyle, toggleList, toggleMark } from './editor/edit.ts'
import type { ToggleMark } from './editor/edit.ts'
import { detectPlatform } from './editor/input.ts'
import { OpenError, loadEngine } from './engine/engine.ts'
import type { Opened } from './engine/engine.ts'
import { locale, t } from './i18n.ts'
import type { Doc, Pt, StyleId } from './model.ts'
import { createStatus } from './ui/status.ts'
import { createToolbar } from './ui/toolbar.ts'
import { fileHandleFromRequest, formatTitle, isAbort, isDirty } from './ui/text.ts'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export interface OpenFile {
  readonly handle: FileSystemFileHandle | null
  readonly name: string
  readonly saved: Doc
}

export interface WordApp {
  readonly editor: Editor
  openBytes(bytes: Uint8Array, name?: string): Promise<void>
}

export async function boot(host: HTMLElement): Promise<WordApp> {
  document.body.classList.add('shell')
  const engine = await loadEngine()
  const platform = detectPlatform(navigator.platform, navigator.userAgent)
  let editor: Editor | null = null
  let file: OpenFile | null = null
  let titleShown = ''

  const toolbarRoot = required('#toolbar')
  const statusRoot = required('#status')
  const toolbar = createToolbar(toolbarRoot, platform, {
    onNew() {
      newDocument()
    },
    onOpen() {
      void openWithPicker()
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
    onZoom(zoom) {
      edit(() => { current().setZoom(zoom) })
    },
  })
  const status = createStatus(statusRoot)

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
    clearOpenError()
    renderChrome()
  }

  function newDocument(): void {
    adopt(engine.blank(), null, t('untitled'))
    current().focus()
  }

  async function openHandle(handle: FileSystemFileHandle): Promise<void> {
    const blob = await handle.getFile()
    const bytes = new Uint8Array(await blob.arrayBuffer())
    try {
      adopt(engine.open(bytes), handle, blob.name || handle.name)
    } catch (error) {
      if (error instanceof OpenError) {
        showOpenError(error)
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
    try {
      adopt(engine.open(bytes), null, name && name.length > 0 ? name : t('openedName'))
    } catch (error) {
      if (error instanceof OpenError) showOpenError(error)
      throw error
    }
    return whenLaidOut(current())
  }

  const opened = engine.blank()
  editor = Editor.mount(host, opened, { locale: locale === 'zh' ? 'zh' : 'en' })
  file = { handle: null, name: t('untitled'), saved: editor.state.doc }
  editor.on('change', renderChrome)
  renderChrome()
  // A file the user opened with this app arrives as a system request. The runtime holds it until a handler exists.
  appWindow.on('request', request => {
    const handle = fileHandleFromRequest(request)
    if (!handle) return
    void openHandle(handle).then(() => current().focus())
  })
  return { editor, openBytes }
}

function required(selector: string): HTMLElement {
  const el = document.querySelector(selector)
  if (!(el instanceof HTMLElement)) throw new Error(`missing ${selector}`)
  return el
}

function showOpenError(error: OpenError): void {
  const el = document.querySelector('#open-error')
  if (!(el instanceof HTMLElement)) return
  const message = t(`open.error.${error.reason}`)
  if (el.textContent !== message) el.textContent = message
  if (el.hidden) el.hidden = false
}

function clearOpenError(): void {
  const el = document.querySelector('#open-error')
  if (!(el instanceof HTMLElement)) return
  if (el.textContent) el.textContent = ''
  if (!el.hidden) el.hidden = true
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
