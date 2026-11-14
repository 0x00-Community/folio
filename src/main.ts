import { window } from 'acde:window'
import init, { Session } from './engine/pkg/engine.js'
import { t, translate } from './i18n.ts'

translate()
window.setTitle(t('title'))

const status = document.querySelector('#status')
if (status === null) throw new Error('missing #status')

const response = await fetch('/engine.wasm')
if (!response.ok) throw new Error(`engine.wasm: ${response.status}`)
const bytes = await response.arrayBuffer()
await init({ module_or_path: bytes })
const session = Session.blank()
status.textContent = `${t('title')} — ${t('engineReady', { count: session.paragraph_count() })}`
