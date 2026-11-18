import { window as appWindow } from 'acde:window'
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
  installHook(await boot(host))
}

function installHook(app: {
  readonly editor: Editor
  openBytes(bytes: Uint8Array, name?: string): Promise<void>
}): void {
  window.__word = {
    editor: app.editor,
    platform: app.editor.platform,
    openBytes(base64, name) {
      return app.openBytes(bytesFromBase64(base64), name)
    },
    insertText,
    setSelection,
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
    __word?: {
      editor: Editor
      platform: Editor['platform']
      openBytes(base64: string, name?: string): Promise<void>
      insertText(text: string): Command
      setSelection(sel: Selection): Command
    }
  }
}
