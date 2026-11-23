// File menu. The key motion is pure so Node can test it; the popup is built only when opened.
import type { Platform, ShortcutName } from '../editor/input.ts'
import { shortcutChord } from '../editor/input.ts'
import { t } from '../i18n.ts'
import { commandTitle, formatChord } from './text.ts'
import { icon } from './icons.ts'
import type { IconName } from './icons.ts'

export type FileMenuId = 'new' | 'open' | 'save' | 'saveAs' | 'pageSetup' | 'print'

export type FileMenuEntry =
  | { readonly kind: 'item'; readonly id: FileMenuId }
  | { readonly kind: 'separator' }

export const FILE_MENU: readonly FileMenuEntry[] = [
  { kind: 'item', id: 'new' },
  { kind: 'item', id: 'open' },
  { kind: 'item', id: 'save' },
  { kind: 'item', id: 'saveAs' },
  { kind: 'separator' },
  { kind: 'item', id: 'pageSetup' },
  { kind: 'item', id: 'print' },
]

export interface MenuFlag {
  readonly disabled: boolean
}

export type MenuKeyResult =
  | { readonly kind: 'move'; readonly index: number }
  | { readonly kind: 'activate'; readonly index: number }
  | { readonly kind: 'close' }
  | { readonly kind: 'stay' }

/**
 * Where a key lands. Arrows wrap and skip disabled items. Home and End jump.
 * Enter and Space activate the current item when it is enabled. Escape and Tab close.
 * Any other key, including letters, stays put: the menu does not type ahead.
 */
export function menuKey(index: number, items: readonly MenuFlag[], key: string): MenuKeyResult {
  if (key === 'Escape' || key === 'Tab') return { kind: 'close' }
  if (items.length === 0) return { kind: 'stay' }
  if (key === 'Enter' || key === ' ') {
    const current = items[index]
    if (!current || current.disabled) return { kind: 'stay' }
    return { kind: 'activate', index }
  }
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    return { kind: 'move', index: step(index, items, key === 'ArrowDown' ? 1 : -1) }
  }
  if (key === 'Home' || key === 'End') {
    return { kind: 'move', index: edge(items, key === 'Home' ? 'start' : 'end') }
  }
  return { kind: 'stay' }
}

function step(index: number, items: readonly MenuFlag[], dir: -1 | 1): number {
  const count = items.length
  const start = index < 0 || index >= count ? (dir > 0 ? -1 : 0) : index
  for (let n = 1; n <= count; n++) {
    const i = mod(start + dir * n, count)
    const item = items[i]
    if (item && !item.disabled) return i
  }
  return index >= 0 && index < count ? index : 0
}

function edge(items: readonly MenuFlag[], which: 'start' | 'end'): number {
  if (which === 'start') {
    for (let i = 0; i < items.length; i++) {
      if (!items[i]?.disabled) return i
    }
  } else {
    for (let i = items.length - 1; i >= 0; i--) {
      if (!items[i]?.disabled) return i
    }
  }
  return 0
}

function mod(value: number, count: number): number {
  return ((value % count) + count) % count
}

/**
 * Arrow keys move through a palette. Left and right wrap inside the row. Up and down keep the column
 * and clamp it when the next row is shorter. Home and End jump. Enter and Space choose. Escape and Tab close.
 */
export function gridKey(index: number, rows: readonly number[], items: readonly MenuFlag[], key: string): MenuKeyResult {
  if (key === 'Escape' || key === 'Tab') return { kind: 'close' }
  const count = items.length
  if (count === 0 || rows.length === 0) return { kind: 'stay' }
  if (key === 'Enter' || key === ' ') {
    const current = items[index]
    if (!current || current.disabled) return { kind: 'stay' }
    return { kind: 'activate', index }
  }
  if (key === 'Home') return { kind: 'move', index: edge(items, 'start') }
  if (key === 'End') return { kind: 'move', index: edge(items, 'end') }
  if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'ArrowUp' && key !== 'ArrowDown') return { kind: 'stay' }
  const place = cellOf(rows, index)
  if (!place) return { kind: 'move', index: edge(items, 'start') }
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const width = rows[place.row] ?? 0
    if (width <= 0) return { kind: 'stay' }
    const dir = key === 'ArrowRight' ? 1 : -1
    for (let step = 1; step <= width; step++) {
      const col = mod(place.col + dir * step, width)
      const next = indexOfCell(rows, place.row, col)
      if (!items[next]?.disabled) return { kind: 'move', index: next }
    }
    return { kind: 'stay' }
  }
  const dir = key === 'ArrowDown' ? 1 : -1
  for (let step = 1; step <= rows.length; step++) {
    const row = mod(place.row + dir * step, rows.length)
    const width = rows[row] ?? 0
    if (width <= 0) continue
    const col = Math.min(place.col, width - 1)
    for (let scan = 0; scan < width; scan++) {
      const next = indexOfCell(rows, row, mod(col + scan, width))
      if (!items[next]?.disabled) return { kind: 'move', index: next }
    }
  }
  return { kind: 'stay' }
}

function cellOf(rows: readonly number[], index: number): { row: number, col: number } | null {
  if (index < 0) return null
  let start = 0
  for (let row = 0; row < rows.length; row++) {
    const width = rows[row] ?? 0
    if (index < start + width) return { row, col: index - start }
    start += width
  }
  return null
}

function indexOfCell(rows: readonly number[], row: number, col: number): number {
  let start = 0
  for (let i = 0; i < row; i++) start += rows[i] ?? 0
  return start + col
}

export interface FileMenuCommand {
  readonly label: string
  readonly icon: IconName
  readonly shortcut: ShortcutName | null
  /** Icon commands that already had a title keep one. A labeled command with no chord does not. */
  readonly showTitle: boolean
  run(): void
}

export interface FileMenu {
  readonly button: HTMLButtonElement
  /** `restore` sends focus back to the File button. A click on the page leaves focus alone. */
  close(restore?: boolean): void
  setDisabled(id: FileMenuId, disabled: boolean): void
}

const MENU_ID = 'file-menu'

export function createFileMenu(
  parent: HTMLElement,
  platform: Platform,
  commands: Readonly<Record<FileMenuId, FileMenuCommand>>,
): FileMenu {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'file'
  button.setAttribute('aria-haspopup', 'menu')
  button.setAttribute('aria-expanded', 'false')
  button.setAttribute('aria-controls', MENU_ID)
  button.setAttribute('aria-label', t('file'))
  button.append(document.createTextNode(t('file')), icon('chevron'))

  const menu = document.createElement('div')
  menu.id = MENU_ID
  menu.className = 'file-menu'
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', t('file'))

  const disabled = new Map<FileMenuId, boolean>()
  const itemButtons = new Map<FileMenuId, HTMLButtonElement>()
  let open = false
  let active = 0

  for (const entry of FILE_MENU) {
    if (entry.kind === 'separator') {
      menu.append(separator())
      continue
    }
    const command = commands[entry.id]
    if (!command) continue
    const item = menuItem(command, platform)
    itemButtons.set(entry.id, item)
    item.addEventListener('click', () => {
      if (item.disabled) return
      dismiss(true)
      command.run()
    })
    menu.append(item)
  }

  // Capture runs before the editor's textarea, so a key cannot type while the menu is up.
  // isDialogOpen stays false: the automation host answers busy only for a dialog.
  document.addEventListener('keydown', onKey, true)
  document.addEventListener('pointerdown', onPointerDown, true)
  button.addEventListener('click', () => {
    if (open) dismiss(true)
    else openMenu()
  })
  button.addEventListener('keydown', (event) => {
    if (open || event.key !== 'ArrowDown') return
    if (event.altKey || event.ctrlKey || event.metaKey) return
    event.preventDefault()
    event.stopPropagation()
    openMenu()
  })
  // The hit stays on the item. The page scroller never sees the event.
  menu.addEventListener('pointerdown', (event) => {
    event.stopPropagation()
  })

  function flagList(): MenuFlag[] {
    const out: MenuFlag[] = []
    for (const entry of FILE_MENU) {
      if (entry.kind !== 'item') continue
      out.push({ disabled: disabled.get(entry.id) === true })
    }
    return out
  }

  function idAt(index: number): FileMenuId | null {
    let seen = 0
    for (const entry of FILE_MENU) {
      if (entry.kind !== 'item') continue
      if (seen === index) return entry.id
      seen += 1
    }
    return null
  }

  function focusActive(): void {
    const id = idAt(active)
    if (!id) return
    itemButtons.get(id)?.focus()
  }

  function place(): void {
    const box = button.getBoundingClientRect()
    menu.style.left = `${Math.max(0, box.left)}px`
    menu.style.top = `${box.bottom + 4}px`
  }

  function openMenu(): void {
    if (open) return
    const body = parent.ownerDocument.body
    if (!body) return
    open = true
    button.setAttribute('aria-expanded', 'true')
    // On the document, above the page scroller. A child of the bar would sit under the table
    // strip (a later sibling) and acdert hit testing ignores the scroller's clip.
    body.append(menu)
    place()
    const first = menuKey(-1, flagList(), 'ArrowDown')
    active = first.kind === 'move' ? first.index : 0
    focusActive()
  }

  function dismiss(restore: boolean): void {
    if (!open) return
    open = false
    button.setAttribute('aria-expanded', 'false')
    menu.remove()
    if (restore) button.focus()
  }

  function onKey(event: KeyboardEvent): void {
    if (!open) return
    const result = menuKey(active, flagList(), event.key)
    event.preventDefault()
    event.stopPropagation()
    if (result.kind === 'stay') return
    if (result.kind === 'close') {
      dismiss(true)
      return
    }
    if (result.kind === 'move') {
      active = result.index
      focusActive()
      return
    }
    const id = idAt(result.index)
    const command = id ? commands[id] : undefined
    const item = id ? itemButtons.get(id) : undefined
    if (!command || !item || item.disabled) return
    dismiss(true)
    command.run()
  }

  function onPointerDown(event: PointerEvent): void {
    if (!open) return
    const target = event.target
    if (target instanceof Node && (menu.contains(target) || button.contains(target))) return
    dismiss(false)
  }

  return {
    button,
    close(restore = true) {
      dismiss(restore)
    },
    setDisabled(id, next) {
      const item = itemButtons.get(id)
      if ((disabled.get(id) === true) === next && item?.disabled === next) return
      disabled.set(id, next)
      if (item && item.disabled !== next) item.disabled = next
      if (!open || !next || idAt(active) !== id) return
      const moved = menuKey(active, flagList(), 'ArrowDown')
      if (moved.kind !== 'move') return
      active = moved.index
      focusActive()
    },
  }
}

function separator(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'sep'
  el.setAttribute('role', 'separator')
  return el
}

function menuItem(command: FileMenuCommand, platform: Platform): HTMLButtonElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'item'
  el.tabIndex = -1
  el.setAttribute('role', 'menuitem')
  el.setAttribute('aria-label', command.label)
  el.append(icon(command.icon))
  const name = document.createElement('span')
  name.className = 'name'
  name.textContent = command.label
  el.append(name)
  const chord = command.shortcut === null ? null : shortcutChord(platform, command.shortcut)
  if (chord) {
    const hint = document.createElement('span')
    hint.className = 'chord'
    hint.setAttribute('aria-hidden', 'true')
    hint.textContent = formatChord(chord, platform)
    el.append(hint)
  }
  if (command.showTitle) el.title = commandTitle(command.label, chord, platform)
  return el
}
