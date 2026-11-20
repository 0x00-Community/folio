// One modal for every question. The key listener only takes Escape and Tab: a capture
// listener that stops every other key would keep a number field from receiving it.

export interface DialogButton<T> {
  readonly label: string
  readonly value: T
  readonly primary?: boolean
  readonly enabled?: () => boolean
}

export interface DialogRequest<T> {
  readonly title: string
  readonly body: HTMLElement
  readonly buttons: readonly DialogButton<T>[]
  readonly cancel: T
  readonly focus?: HTMLElement
}

interface Shell {
  readonly backdrop: HTMLDivElement
  readonly dialog: HTMLDivElement
  readonly title: HTMLParagraphElement
  readonly body: HTMLDivElement
  readonly actions: HTMLDivElement
}

let shell: Shell | null = null
let resolveOpen: ((value: unknown) => void) | null = null
let cancelValue: unknown = null
let refreshButtons = (): void => {}

export function isDialogOpen(): boolean {
  return shell !== null && !shell.backdrop.hidden
}

export function openDialog<T>(request: DialogRequest<T>): Promise<T> {
  const current = ensureShell()
  if (!current.backdrop.hidden) return Promise.resolve(request.cancel)
  return new Promise((resolve) => {
    resolveOpen = (value) => resolve(value as T)
    cancelValue = request.cancel
    current.title.textContent = request.title
    current.body.replaceChildren(request.body)
    current.actions.replaceChildren()
    let primary: HTMLButtonElement | null = null
    const refreshers: (() => void)[] = []
    for (const spec of request.buttons) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = spec.label
      if (spec.primary) {
        button.className = 'primary'
        primary = button
      }
      const apply = (): void => {
        const enabled = spec.enabled ? spec.enabled() : true
        if (button.disabled !== !enabled) button.disabled = !enabled
      }
      apply()
      refreshers.push(apply)
      button.addEventListener('click', () => {
        if (button.disabled) return
        finish(spec.value)
      })
      current.actions.append(button)
    }
    refreshButtons = () => {
      for (const apply of refreshers) apply()
    }
    refreshButtons()
    current.backdrop.hidden = false
    const target = request.focus ?? primary
    target?.focus()
  })
}

function ensureShell(): Shell {
  if (shell) return shell
  const backdrop = document.createElement('div')
  backdrop.className = 'unsaved'
  backdrop.hidden = true
  const dialog = document.createElement('div')
  dialog.className = 'unsaved-panel'
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', 'dialog-title')
  const title = document.createElement('p')
  title.id = 'dialog-title'
  const body = document.createElement('div')
  const actions = document.createElement('div')
  actions.className = 'unsaved-actions'
  dialog.append(title, body, actions)
  backdrop.append(dialog)
  document.body.append(backdrop)
  document.addEventListener('keydown', onKey, true)
  dialog.addEventListener('input', () => refreshButtons())
  dialog.addEventListener('change', () => refreshButtons())
  shell = { backdrop, dialog, title, body, actions }
  return shell
}

function onKey(event: KeyboardEvent): void {
  if (!shell || shell.backdrop.hidden) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    finish(cancelValue)
    return
  }
  if (event.key !== 'Tab') return
  const items = focusable(shell.dialog)
  event.preventDefault()
  event.stopPropagation()
  if (items.length === 0) return
  const current = document.activeElement
  let index = -1
  for (let i = 0; i < items.length; i++) {
    if (items[i] === current) index = i
  }
  const step = event.shiftKey ? -1 : 1
  const next = items[(index + step + items.length) % items.length]
  next?.focus()
}

function focusable(root: ParentNode): HTMLElement[] {
  const found = root.querySelectorAll<HTMLElement>('button, input, select, textarea')
  const out: HTMLElement[] = []
  for (const el of found) {
    if (el.matches(':disabled')) continue
    if (el.tabIndex < 0) continue
    out.push(el)
  }
  return out
}

function finish(value: unknown): void {
  if (!shell || shell.backdrop.hidden || !resolveOpen) return
  shell.backdrop.hidden = true
  const resolve = resolveOpen
  resolveOpen = null
  resolve(value)
}
