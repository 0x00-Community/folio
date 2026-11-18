import type { Status } from '../editor/editor.ts'
import { t } from '../i18n.ts'
import { statusText } from './text.ts'

export interface StatusView {
  render(status: Status, zoom: number): void
}

export function createStatus(root: HTMLElement): StatusView {
  let shown = ''
  return {
    render(status, zoom) {
      const text = statusText(status, zoom, t)
      if (text === shown) return
      shown = text
      root.textContent = text
    },
  }
}
