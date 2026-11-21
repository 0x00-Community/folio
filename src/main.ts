import { window as appWindow } from 'acde:window'
import type { Word } from './automation/api.ts'
import type { BlockHeight, PrintBlockHeight, PrintMeasure } from './app.ts'
import type { DriftReport } from './editor/drift.ts'
import type { Editor } from './editor/editor.ts'
import { insertText, setSelection } from './editor/edit.ts'
import type { Command } from './editor/edit.ts'
import { t, translate } from './i18n.ts'
import type { Selection } from './model.ts'
import './editor/view.css'

translate()
appWindow.setTitle(t('title'))

if (location.hash === '#view-demo') {
  const { startViewDemo } = await import('./editor/demo.ts')
  startViewDemo()
} else {
  document.body.classList.add('shell')
  const host = document.querySelector('#pages')
  if (!(host instanceof HTMLElement)) throw new Error('missing #pages')
  const { boot } = await import('./app.ts')
  const app = await boot(host)
  // The automation interface, in every build. `__word` stays the test hook.
  window.word = app.word
  installHook(app)
}

function installHook(app: {
  readonly editor: Editor
  openBytes(bytes: Uint8Array, name?: string): Promise<void>
  save(): { base64: string; ms: number }
  saveTampered(): string
  requestClose(): boolean
  pageSetupMs(): number
  memoryBytes(): number
  printLayout(): Promise<PrintMeasure>
  drift(): Promise<DriftReport>
  blockHeights(): readonly BlockHeight[]
  printHeights(): Promise<readonly PrintBlockHeight[]>
}): void {
  // There is no production build flag. These hooks are how the e2e reaches save, a forced verify
  // failure, and beforeclose. `acde act w1 close` waits until the window is gone, so a handler that
  // returns false cannot be driven from the CLI and still continue the test.
  window.__word = {
    editor: app.editor,
    platform: app.editor.platform,
    openBytes(base64, name) {
      return app.openBytes(bytesFromBase64(base64), name)
    },
    insertText,
    setSelection,
    save() {
      return app.save()
    },
    saveTampered() {
      return app.saveTampered()
    },
    requestClose() {
      return app.requestClose()
    },
    pageSetupMs() {
      return app.pageSetupMs()
    },
    memoryBytes() {
      return app.memoryBytes()
    },
    printLayout() {
      return app.printLayout()
    },
    drift() {
      return app.drift()
    },
    blockHeights() {
      return app.blockHeights()
    },
    printHeights() {
      return app.printHeights()
    },
  }
}

function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

declare global {
  interface Window {
    word?: Word
    __word?: {
      editor: Editor
      platform: Editor['platform']
      openBytes(base64: string, name?: string): Promise<void>
      insertText(text: string): Command
      setSelection(sel: Selection): Command
      save(): { base64: string; ms: number }
      saveTampered(): string
      requestClose(): boolean
      pageSetupMs(): number
      memoryBytes(): number
      printLayout(): Promise<PrintMeasure>
      drift(): Promise<DriftReport>
      blockHeights(): readonly BlockHeight[]
      printHeights(): Promise<readonly PrintBlockHeight[]>
    }
  }
}
