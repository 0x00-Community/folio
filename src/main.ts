import { window } from 'acde:window'
import { t, translate } from './i18n.ts'

translate()
window.setTitle(t('title'))

if (location.hash === '#view-demo') {
  const { startViewDemo } = await import('./editor/demo.ts')
  startViewDemo()
} else {
  await bootEditor()
}

async function bootEditor(): Promise<void> {
  const { default: init, Session } = await import('./engine/pkg/engine.js')
  const status = document.querySelector('#status')
  if (status === null) throw new Error('missing #status')
  const response = await fetch('/engine.wasm')
  if (!response.ok) throw new Error(`engine.wasm: ${response.status}`)
  const bytes = await response.arrayBuffer()
  await init({ module_or_path: bytes })
  const session = Session.blank()
  status.textContent = `${t('title')} — ${t('engineReady', { count: session.paragraph_count() })}`
}
