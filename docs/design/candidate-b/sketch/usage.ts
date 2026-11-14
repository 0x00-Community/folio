// Call sites in src/app.ts, written before the types. The types in model.ts, editor/*.ts and engine.ts serve these.
/// <reference types="@dopame/acde-api/app" />
import { window as self } from 'acde:window'
import { Editor } from './editor/editor'
import { toggleMark, setParaStyle, toggleList, insertTable, insertImage, setPageSetup } from './editor/edit'
import { loadEngine, OpenError, SaveVerifyError, type Opened } from './engine'
import { fetchFonts } from './fonts'
import type { Doc, PageSetup, StyleId } from './model'

type OpenFile = { handle: FileSystemFileHandle | null; name: string; saved: Doc }

const engine = await loadEngine()
const editor = Editor.mount(document.getElementById('pages')!, engine.blank(), { locale: navigator.language.startsWith('zh') ? 'zh' : 'en' })
let file: OpenFile = { handle: null, name: '未命名.docx', saved: editor.state.doc }

// Call site 1: the system hands the app a .docx as its default handler, a picker, or a drop. All three end in load().
function load(opened: Opened, handle: FileSystemFileHandle | null, name: string) {
  editor.load(opened)
  file = { handle, name, saved: opened.doc }
  self.setTitle(`${name} - Word`)
}

async function openBytes(handle: FileSystemFileHandle): Promise<void> {
  const blob = await handle.getFile()
  try {
    load(engine.open(new Uint8Array(await blob.arrayBuffer())), handle, blob.name)
  } catch (error) {
    if (error instanceof OpenError) return showError(error.reason)
    throw error
  }
}

self.on('request', async (request) => {
  if (request.kind === 'open-file' && request.handle.kind === 'file') await openBytes(request.handle)
})

addEventListener('drop', async (event) => {
  event.preventDefault()
  const item = [...event.dataTransfer!.items].find((entry) => entry.kind === 'file')
  const handle = await item?.getAsFileSystemHandle()
  if (handle?.kind === 'file') await openBytes(handle as FileSystemFileHandle) // read-only: the first save becomes Save As
})

async function openWithPicker() {
  const [handle] = await showOpenFilePicker({ types: [DOCX] })
  await openBytes(handle)
}

// Call site 2: save overwrites the opened file through its handle. A refused write (a dropped file) becomes Save As.
async function save(): Promise<void> {
  let bytes: Uint8Array
  try {
    bytes = editor.source.save(editor.state.doc)
  } catch (error) {
    if (error instanceof SaveVerifyError) return showError(t('save.verifyFailed')) // the file on disk is untouched
    throw error
  }
  if (file.handle && (await tryWrite(file.handle, bytes))) {
    file.saved = editor.state.doc
    return
  }
  await saveAs(bytes)
}

async function saveAs(bytes = editor.source.save(editor.state.doc)) {
  const handle = await showSaveFilePicker({ suggestedName: file.name, types: [DOCX] })
  await writeAll(handle, bytes)
  file = { handle, name: handle.name, saved: editor.state.doc }
  self.setTitle(`${handle.name} - Word`)
}

// Call site 3: export PDF. The backend supplies the CJK font files the page cannot read.
async function exportPdf() {
  const doc = editor.state.doc
  for (const [family, bytes] of await fetchFonts(editor.source.fontsUsed(doc))) editor.source.addFont(family, bytes)
  const pdf = editor.source.exportPdf(doc)
  const handle = await showSaveFilePicker({ suggestedName: file.name.replace(/\.docx$/i, '.pdf'), types: [PDF] })
  await writeAll(handle, pdf)
}

// Call site 4: toolbar, menus and status read derived state and run commands. They never touch the model directly.
toolbar.bold.onclick = () => editor.run(toggleMark('bold'))
toolbar.style.onchange = (id: StyleId) => editor.run(setParaStyle(id))
toolbar.bullets.onclick = () => editor.run(toggleList('bullet'))
menu.insertTable = () => editor.run(insertTable(3, 3))
menu.insertImage = async () => {
  const [handle] = await showOpenFilePicker({ types: [IMAGES] })
  const image = await handle.getFile()
  editor.run(insertImage(await editor.source.addMedia(image))) // decodes natural size, keeps bytes for every later save
}
menu.pageSetup = (setup: PageSetup) => editor.run(setPageSetup(editor.status().section, setup))

editor.on('change', () => {
  toolbar.render(editor.toolbar()) // { bold: true | false | 'mixed', font, sizePt, style, align, list, ... }
  const status = editor.status() // { page, pages, pagesFinal, words, section }
  statusBar.render(status)
  self.setTitle(`${editor.state.doc === file.saved ? '' : '• '}${file.name} - Word`)
})

self.on('beforeclose', async () => {
  if (editor.state.doc === file.saved) return true
  const answer = await askUnsaved() // in-page dialog: confirm() returns false in acde
  if (answer === 'save') await save()
  return answer !== 'cancel'
})

declare const DOCX: FilePickerAcceptType, PDF: FilePickerAcceptType, IMAGES: FilePickerAcceptType
declare const toolbar: any, menu: any, statusBar: any
declare function showError(message: string): void
declare function t(key: string): string
declare function askUnsaved(): Promise<'save' | 'discard' | 'cancel'>
declare function tryWrite(handle: FileSystemFileHandle, bytes: Uint8Array): Promise<boolean>
declare function writeAll(handle: FileSystemFileHandle, bytes: Uint8Array): Promise<void>
