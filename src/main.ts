import { window as appWindow } from 'acde:window'
import type { Editor } from './editor/editor.ts'
import { insertText, setSelection } from './editor/edit.ts'
import type { Command } from './editor/edit.ts'
import type { Engine } from './engine/engine.ts'
import { locale, t, translate } from './i18n.ts'
import type { Selection } from './model.ts'
import './editor/view.css'

translate()
appWindow.setTitle(t('title'))

if (location.hash === '#view-demo') {
  const { startViewDemo } = await import('./editor/demo.ts')
  startViewDemo()
} else {
  await bootEditor()
}

async function bootEditor(): Promise<void> {
  const host = document.querySelector('#pages')
  if (!(host instanceof HTMLElement)) throw new Error('missing #pages')
  const { loadEngine } = await import('./engine/engine.ts')
  const { Editor } = await import('./editor/editor.ts')
  const engine = await loadEngine()
  const editor = Editor.mount(host, engine.blank(), { locale: locale === 'zh' ? 'zh' : 'en' })
  // acde dev serves a production build, so there is no dev flag to gate the e2e hook on.
  installHook(engine, editor)
}

function installHook(engine: Engine, editor: Editor): void {
  window.__word = {
    editor,
    platform: editor.platform,
    openBytes(base64) {
      const opened = engine.open(bytesFromBase64(base64))
      editor.load(opened)
      return whenLaidOut(editor)
    },
    insertText,
    setSelection,
  }
}

function whenLaidOut(editor: Editor): Promise<void> {
  return new Promise((resolve) => {
    const tick = (): void => {
      if (editor.status().pagesFinal) resolve()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
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
      openBytes(base64: string): Promise<void>
      insertText(text: string): Command
      setSelection(sel: Selection): Command
    }
  }
}
