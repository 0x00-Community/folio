// Font color, highlight, the more menu, and line spacing. Palettes and menus use the File menu's popup.
import type { ToolbarState } from '../editor/edit.ts'
import type { Platform, ShortcutName } from '../editor/input.ts'
import { shortcutChord } from '../editor/input.ts'
import { t } from '../i18n.ts'
import type { HighlightName } from '../model.ts'
import { icon } from './icons.ts'
import type { IconName } from './icons.ts'
import { gridKey, menuKey } from './menu.ts'
import type { MenuFlag, MenuKeyResult } from './menu.ts'
import { commandTitle, formatChord } from './text.ts'

const FONT_COLORS: readonly (readonly [hex: string, key: string])[] = [
  ['C00000', 'color.darkRed'],
  ['FF0000', 'color.red'],
  ['FFC000', 'color.orange'],
  ['FFFF00', 'color.yellow'],
  ['92D050', 'color.lightGreen'],
  ['00B050', 'color.green'],
  ['00B0F0', 'color.lightBlue'],
  ['0070C0', 'color.blue'],
  ['002060', 'color.navy'],
  ['7030A0', 'color.purple'],
  ['000000', 'color.black'],
  ['404040', 'color.darkGray'],
  ['7F7F7F', 'color.gray'],
  ['BFBFBF', 'color.lightGray'],
  ['FFFFFF', 'color.white'],
]

const HIGHLIGHTS: readonly (readonly [name: HighlightName, key: string, hex: string])[] = [
  ['yellow', 'highlight.yellow', 'FFFF00'],
  ['green', 'highlight.green', '00FF00'],
  ['cyan', 'highlight.cyan', '00FFFF'],
  ['magenta', 'highlight.magenta', 'FF00FF'],
  ['blue', 'highlight.blue', '0000FF'],
  ['red', 'highlight.red', 'FF0000'],
  ['darkBlue', 'highlight.darkBlue', '000080'],
  ['darkCyan', 'highlight.darkCyan', '008080'],
  ['darkGreen', 'highlight.darkGreen', '008000'],
  ['darkMagenta', 'highlight.darkMagenta', '800080'],
  ['darkRed', 'highlight.darkRed', '800000'],
  ['darkYellow', 'highlight.darkYellow', '808000'],
  ['darkGray', 'highlight.darkGray', '808080'],
  ['lightGray', 'highlight.lightGray', 'C0C0C0'],
  ['black', 'highlight.black', '000000'],
]

const LINE_MULTIPLES = [1, 1.15, 1.5, 2, 2.5, 3] as const

export interface FormatHandlers {
  onColor(hex: string | undefined): void
  onHighlight(name: HighlightName | undefined): void
  onVertAlign(which: 'super' | 'sub'): void
  onClear(): void
  onLineSpacing(multiple: number): void
  onParaSpacing(edge: 'before' | 'after', points: number): void
  onParagraph(): void
}

export interface FormatChrome {
  readonly color: HTMLElement
  readonly highlight: HTMLElement
  readonly more: HTMLButtonElement
  readonly spacing: HTMLButtonElement
  close(restore?: boolean): void
  sync(state: ToolbarState): void
}

interface PopupEntry {
  readonly role: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox'
  readonly label: string
  readonly checked: boolean
  readonly swatch?: string
  readonly shortcut?: ShortcutName
  run(): void
}

type PopupRow = PopupEntry | 'separator'

interface Popup {
  close(restore?: boolean): void
}

export function createFormatChrome(
  platform: Platform,
  handlers: FormatHandlers,
  closeFile: () => void,
): FormatChrome {
  let color = 'C00000'
  let highlight: HighlightName = 'yellow'
  let current: ToolbarState | null = null
  const popups: Popup[] = []
  let fontMain: HTMLButtonElement | null = null
  let fontPopup: Popup | null = null
  let markerPopup: Popup | null = null
  let morePopup: Popup | null = null
  let spacingPopup: Popup | null = null

  function closeOthers(except: Popup | null): void {
    closeFile()
    for (const popup of popups) {
      if (popup !== except) popup.close(false)
    }
  }

  const font = splitButton(platform, t('fontColor'), t('fontColor.menu'), 'font-color', () => handlers.onColor(color), {
    rows: [1, 10, 5],
    palette: true,
    columns: 10,
    entries: () => fontEntries(colorOf(current), (hex) => {
      if (hex) {
        color = hex
        if (fontMain) paintBar(fontMain, color)
      }
      handlers.onColor(hex)
    }),
    paint: (button) => paintBar(button, color),
    beforeOpen: () => closeOthers(fontPopup),
  })
  let markerMain: HTMLButtonElement | null = null
  const marker = splitButton(platform, t('highlight'), t('highlight.menu'), 'highlight', () => handlers.onHighlight(highlight), {
    rows: [1, 5, 5, 5],
    palette: true,
    columns: 5,
    entries: () => highlightEntries(highlightOf(current), (name) => {
      if (name) {
        highlight = name
        if (markerMain) paintBar(markerMain, highlightHex(highlight))
      }
      handlers.onHighlight(name)
    }),
    paint: (button) => paintBar(button, highlightHex(highlight)),
    beforeOpen: () => closeOthers(markerPopup),
  })
  markerMain = marker.main
  const more = menuButton(platform, t('more'), 'more', {
    rows: null,
    entries: () => moreEntries(current, handlers),
    beforeOpen: () => closeOthers(morePopup),
  })
  const spacing = menuButton(platform, t('spacing.menu'), 'line-spacing', {
    rows: null,
    entries: () => spacingEntries(current, handlers),
    beforeOpen: () => closeOthers(spacingPopup),
  })
  fontMain = font.main
  fontPopup = font.popup
  markerPopup = marker.popup
  morePopup = more.popup
  spacingPopup = spacing.popup
  popups.push(font.popup, marker.popup, more.popup, spacing.popup)

  return {
    color: font.wrap,
    highlight: marker.wrap,
    more: more.button,
    spacing: spacing.button,
    close(restore = false) {
      for (const popup of popups) popup.close(restore)
    },
    sync(state) {
      current = state
    },
  }
}

interface PopupController extends Popup {
  open(): void
}

function splitButton(
  platform: Platform,
  label: string,
  menuLabel: string,
  graphic: IconName,
  onApply: () => void,
  options: {
    readonly rows: readonly number[]
    readonly palette: boolean
    readonly columns: number
    readonly entries: () => readonly PopupRow[]
    readonly paint?: (button: HTMLButtonElement) => void
    readonly beforeOpen: () => void
  },
): { wrap: HTMLElement, main: HTMLButtonElement, popup: PopupController } {
  const wrap = document.createElement('div')
  wrap.className = 'split'
  const main = document.createElement('button')
  main.type = 'button'
  main.setAttribute('aria-label', label)
  main.title = label
  main.append(icon(graphic))
  options.paint?.(main)
  const chevron = document.createElement('button')
  chevron.type = 'button'
  chevron.className = 'chevron'
  chevron.setAttribute('aria-label', menuLabel)
  chevron.title = menuLabel
  chevron.setAttribute('aria-haspopup', 'menu')
  chevron.setAttribute('aria-expanded', 'false')
  chevron.append(icon('chevron'))
  wrap.append(main, chevron)
  const popup = createPopup(platform, chevron, menuLabel, options.rows, options.entries, options.palette, options.columns, options.beforeOpen)
  main.addEventListener('click', () => {
    popup.close(false)
    onApply()
  })
  return { wrap, main, popup }
}

function menuButton(
  platform: Platform,
  label: string,
  graphic: IconName,
  options: {
    readonly rows: readonly number[] | null
    readonly entries: () => readonly PopupRow[]
    readonly beforeOpen: () => void
  },
): { button: HTMLButtonElement, popup: PopupController } {
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('aria-label', label)
  button.title = label
  button.setAttribute('aria-haspopup', 'menu')
  button.setAttribute('aria-expanded', 'false')
  button.append(icon(graphic))
  const popup = createPopup(platform, button, label, options.rows, options.entries, false, 0, options.beforeOpen)
  return { button, popup }
}

function createPopup(
  platform: Platform,
  opener: HTMLButtonElement,
  label: string,
  rows: readonly number[] | null,
  entries: () => readonly PopupRow[],
  palette: boolean,
  columns: number,
  beforeOpen: () => void,
): PopupController {
  const menu = document.createElement('div')
  menu.className = palette ? 'file-menu palette' : 'file-menu narrow'
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', label)
  let open = false
  let active = 0
  let buttons: HTMLButtonElement[] = []
  let flags: MenuFlag[] = []

  document.addEventListener('keydown', onKey, true)
  document.addEventListener('pointerdown', onPointerDown, true)
  opener.addEventListener('click', () => {
    if (open) dismiss(true)
    else controller.open()
  })
  opener.addEventListener('keydown', (event) => {
    if (open || event.key !== 'ArrowDown') return
    if (event.altKey || event.ctrlKey || event.metaKey) return
    event.preventDefault()
    event.stopPropagation()
    controller.open()
  })
  menu.addEventListener('pointerdown', (event) => {
    event.stopPropagation()
  })

  const controller: PopupController = {
    open() {
      if (open) return
      const body = opener.ownerDocument.body
      if (!body) return
      beforeOpen()
      rebuild()
      open = true
      opener.setAttribute('aria-expanded', 'true')
      body.append(menu)
      place()
      const checked = buttons.findIndex((button) => button.getAttribute('aria-checked') === 'true')
      active = checked >= 0 ? checked : 0
      buttons[active]?.focus()
    },
    close(restore = true) {
      dismiss(restore)
    },
  }
  return controller

  function rebuild(): void {
    menu.replaceChildren()
    buttons = []
    flags = []
    if (palette) {
      menu.style.setProperty('--cols', String(columns))
      for (const entry of entries()) {
        if (entry === 'separator') continue
        const button = itemButton(entry)
        buttons.push(button)
        flags.push({ disabled: false })
        if (!entry.swatch) button.style.gridColumn = '1 / -1'
        menu.append(button)
      }
    } else {
      for (const entry of entries()) {
        if (entry === 'separator') {
          menu.append(separator())
          continue
        }
        const button = itemButton(entry)
        buttons.push(button)
        flags.push({ disabled: false })
        menu.append(button)
      }
    }
  }

  function itemButton(entry: PopupEntry): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = entry.swatch ? 'swatch' : 'item'
    button.tabIndex = -1
    button.setAttribute('role', entry.role)
    button.setAttribute('aria-label', entry.label)
    button.title = entry.shortcut
      ? commandTitle(entry.label, shortcutChord(platform, entry.shortcut), platform)
      : entry.label
    if (entry.role !== 'menuitem') button.setAttribute('aria-checked', entry.checked ? 'true' : 'false')
    if (entry.swatch) button.style.background = `#${entry.swatch}`
    else {
      if (!palette) {
        const mark = document.createElement('span')
        mark.className = 'mark'
        mark.setAttribute('aria-hidden', 'true')
        if (entry.checked && entry.role !== 'menuitem') mark.append(icon('check'))
        button.append(mark)
      }
      const name = document.createElement('span')
      name.className = 'name'
      name.textContent = entry.label
      button.append(name)
      if (entry.shortcut) {
        const chord = shortcutChord(platform, entry.shortcut)
        if (chord) {
          const hint = document.createElement('span')
          hint.className = 'chord'
          hint.setAttribute('aria-hidden', 'true')
          hint.textContent = formatChord(chord, platform)
          button.append(hint)
        }
      }
    }
    button.addEventListener('click', () => {
      if (button.disabled) return
      dismiss(true)
      entry.run()
    })
    return button
  }

  function place(): void {
    const box = opener.getBoundingClientRect()
    menu.style.left = `${Math.max(0, box.left)}px`
    menu.style.top = `${box.bottom + 4}px`
  }

  function dismiss(restore: boolean): void {
    if (!open) return
    open = false
    opener.setAttribute('aria-expanded', 'false')
    menu.remove()
    if (restore) opener.focus()
  }

  function onKey(event: KeyboardEvent): void {
    if (!open) return
    const result = moveKey(active, rows, flags, event.key)
    event.preventDefault()
    event.stopPropagation()
    if (result.kind === 'stay') return
    if (result.kind === 'close') {
      dismiss(true)
      return
    }
    if (result.kind === 'move') {
      active = result.index
      buttons[active]?.focus()
      return
    }
    const button = buttons[result.index]
    button?.click()
  }

  function onPointerDown(event: PointerEvent): void {
    if (!open) return
    const target = event.target
    if (target instanceof Node && (menu.contains(target) || opener.contains(target))) return
    dismiss(false)
  }
}

function moveKey(
  index: number,
  rows: readonly number[] | null,
  items: readonly MenuFlag[],
  key: string,
): MenuKeyResult {
  if (rows) return gridKey(index, rows, items, key)
  return menuKey(index, items, key)
}

function separator(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'sep'
  el.setAttribute('role', 'separator')
  return el
}

function highlightHex(name: HighlightName): string {
  const found = HIGHLIGHTS.find(([item]) => item === name)
  return found ? found[2] : 'FFFF00'
}

function paintBar(button: HTMLButtonElement, hex: string): void {
  const bar = button.querySelector('.bar')
  if (bar instanceof HTMLElement) bar.style.background = `#${hex}`
}

function colorOf(state: ToolbarState | null): string | null | 'mixed' {
  if (!state || state.color === 'mixed') return 'mixed'
  if (state.color === 'auto') return null
  return state.color
}

function highlightOf(state: ToolbarState | null): HighlightName | null | 'mixed' {
  if (!state || state.highlight === 'mixed') return 'mixed'
  if (state.highlight === 'none') return null
  return state.highlight
}

function fontEntries(current: string | null | 'mixed', choose: (hex: string | undefined) => void): PopupRow[] {
  const clear: PopupEntry = {
    role: 'menuitemradio',
    label: t('color.auto'),
    checked: current === null,
    run: () => choose(undefined),
  }
  return [
    clear,
    ...FONT_COLORS.map(([hex, key]): PopupEntry => ({
      role: 'menuitemradio',
      label: t(key),
      checked: typeof current === 'string' && current.toUpperCase() === hex,
      swatch: hex,
      run: () => choose(hex),
    })),
  ]
}

function highlightEntries(
  current: HighlightName | null | 'mixed',
  choose: (name: HighlightName | undefined) => void,
): PopupRow[] {
  const clear: PopupEntry = {
    role: 'menuitemradio',
    label: t('highlight.none'),
    checked: current === null,
    run: () => choose(undefined),
  }
  return [
    clear,
    ...HIGHLIGHTS.map(([name, key, hex]): PopupEntry => ({
      role: 'menuitemradio',
      label: t(key),
      checked: current === name,
      swatch: hex,
      run: () => choose(name),
    })),
  ]
}

function moreEntries(state: ToolbarState | null, handlers: FormatHandlers): PopupRow[] {
  const align = state?.vertAlign ?? 'none'
  return [
    {
      role: 'menuitemcheckbox',
      label: t('vert.super'),
      checked: align === 'super',
      shortcut: 'superscript',
      run: () => handlers.onVertAlign('super'),
    },
    {
      role: 'menuitemcheckbox',
      label: t('vert.sub'),
      checked: align === 'sub',
      shortcut: 'subscript',
      run: () => handlers.onVertAlign('sub'),
    },
    {
      role: 'menuitem',
      label: t('clearFormatting'),
      checked: false,
      shortcut: 'clearFormatting',
      run: () => handlers.onClear(),
    },
  ]
}

function spacingEntries(state: ToolbarState | null, handlers: FormatHandlers): PopupRow[] {
  const multiple = state?.lineMultiple ?? null
  const before = state?.spaceBefore ?? 0
  const after = state?.spaceAfter ?? 0
  const lines: PopupRow[] = LINE_MULTIPLES.map((value) => ({
    role: 'menuitemradio' as const,
    label: value.toFixed(value === 1.15 ? 2 : 1),
    checked: multiple !== null && Math.abs(multiple - value) < 0.001,
    run: () => handlers.onLineSpacing(value),
  }))
  return [
    ...lines,
    'separator',
    {
      role: 'menuitem',
      label: before > 0 ? t('spacing.before.remove') : t('spacing.before.add'),
      checked: false,
      run: () => handlers.onParaSpacing('before', before > 0 ? 0 : 12),
    },
    {
      role: 'menuitem',
      label: after > 0 ? t('spacing.after.remove') : t('spacing.after.add'),
      checked: false,
      run: () => handlers.onParaSpacing('after', after > 0 ? 0 : 12),
    },
    'separator',
    {
      role: 'menuitem',
      label: t('para.open'),
      checked: false,
      run: () => handlers.onParagraph(),
    },
  ]
}
