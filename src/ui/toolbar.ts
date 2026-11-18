// Toolbar controls. The buttons are created once; a later change only writes an attribute when its value differs.
import type { ToggleMark, ToolbarState } from '../editor/edit.ts'
import type { Platform, ShortcutName } from '../editor/input.ts'
import { shortcutChord } from '../editor/input.ts'
import { t } from '../i18n.ts'
import type { Doc } from '../model.ts'
import { commandTitle, styleOptions } from './text.ts'
import type { StyleOption } from './text.ts'

export type Align = 'left' | 'center' | 'right' | 'justify'

export interface ToolbarHandlers {
  onNew(): void
  onOpen(): void
  onUndo(): void
  onRedo(): void
  onMark(mark: ToggleMark): void
  onStyle(id: string): void
  onAlign(align: Align): void
  onList(kind: 'bullet' | 'decimal'): void
  onZoom(zoom: number): void
}

export interface ToolbarView {
  render(state: ToolbarState, doc: Doc): void
  zoom(): number
}

const ALIGNS: readonly Align[] = ['left', 'center', 'right', 'justify']
const ZOOMS = [50, 75, 100, 125, 150, 200] as const

export function createToolbar(root: HTMLElement, platform: Platform, handlers: ToolbarHandlers): ToolbarView {
  root.setAttribute('aria-label', t('toolbar'))
  let painting = false
  let ignoreStyle = false
  let zoom = 1
  let styleKey = ''
  let seenStyles: object | null = null
  let cachedOptions: readonly StyleOption[] = []

  const file = group(root)
  file.append(
    commandButton(t('new'), null, platform, () => handlers.onNew()),
    commandButton(t('open'), null, platform, () => handlers.onOpen()),
  )
  const undo = commandButton(t('undo'), 'undo', platform, () => handlers.onUndo())
  const redo = commandButton(t('redo'), 'redo', platform, () => handlers.onRedo())
  undo.disabled = true
  redo.disabled = true
  group(root).append(undo, redo)

  const marks = {
    bold: toggleButton(t('bold'), 'bold', platform, () => handlers.onMark('bold')),
    italic: toggleButton(t('italic'), 'italic', platform, () => handlers.onMark('italic')),
    underline: toggleButton(t('underline'), 'underline', platform, () => handlers.onMark('underline')),
    strike: toggleButton(t('strike'), null, platform, () => handlers.onMark('strike')),
  }
  group(root).append(marks.bold, marks.italic, marks.underline, marks.strike)

  const styleSelect = labeledSelect(t('style'), 'style')
  watchSelect(styleSelect, () => {
    if (painting || ignoreStyle) return
    const value = styleSelect.value
    if (value.length === 0) return
    handlers.onStyle(value)
  })
  group(root).append(styleSelect)

  const alignButtons = {
    left: toggleButton(t('align.left'), null, platform, () => handlers.onAlign('left')),
    center: toggleButton(t('align.center'), null, platform, () => handlers.onAlign('center')),
    right: toggleButton(t('align.right'), null, platform, () => handlers.onAlign('right')),
    justify: toggleButton(t('align.justify'), null, platform, () => handlers.onAlign('justify')),
  }
  group(root).append(alignButtons.left, alignButtons.center, alignButtons.right, alignButtons.justify)

  const bullet = toggleButton(t('list.bullet'), null, platform, () => handlers.onList('bullet'))
  const numbered = toggleButton(t('list.number'), null, platform, () => handlers.onList('decimal'))
  group(root).append(bullet, numbered)

  const zoomSelect = labeledSelect(t('zoom'), 'zoom')
  for (const percent of ZOOMS) {
    const option = document.createElement('option')
    option.value = String(percent)
    option.textContent = `${percent}%`
    zoomSelect.append(option)
  }
  zoomSelect.value = '100'
  watchSelect(zoomSelect, () => {
    if (painting) return
    const percent = Number(zoomSelect.value)
    if (!Number.isFinite(percent) || percent <= 0) return
    const next = percent / 100
    if (next === zoom) return
    zoom = next
    handlers.onZoom(zoom)
  })
  group(root).append(zoomSelect)

  function optionsFor(doc: Doc): readonly StyleOption[] {
    const styles = doc.styles.paragraph
    if (styles === seenStyles) return cachedOptions
    seenStyles = styles
    cachedOptions = styleOptions(styles, role => t(`style.${role}`))
    return cachedOptions
  }

  function paintStyles(doc: Doc, current: string | 'mixed'): void {
    let options = optionsFor(doc)
    if (current !== 'mixed' && !options.some(option => option.id === current)) {
      options = options.concat({ id: current, label: current })
    }
    const key = options.map(option => `${option.id}\t${option.label}`).join('\n')
    if (key !== styleKey) {
      styleKey = key
      const fragment = document.createDocumentFragment()
      const mixed = document.createElement('option')
      mixed.value = ''
      mixed.textContent = t('style.mixed')
      mixed.hidden = true
      fragment.append(mixed)
      for (const option of options) {
        const el = document.createElement('option')
        el.value = option.id
        el.textContent = option.label
        fragment.append(el)
      }
      // Rebuilding the options can emit change. Ignore it until the next frame so an open does not edit the document.
      ignoreStyle = true
      styleSelect.replaceChildren(fragment)
      requestAnimationFrame(() => { ignoreStyle = false })
    }
    const value = current === 'mixed' ? '' : current
    if (styleSelect.value !== value) styleSelect.value = value
  }

  return {
    zoom: () => zoom,
    render(state, doc) {
      painting = true
      try {
        if (undo.disabled !== !state.canUndo) undo.disabled = !state.canUndo
        if (redo.disabled !== !state.canRedo) redo.disabled = !state.canRedo
        setPressed(marks.bold, pressedOf(state.bold))
        setPressed(marks.italic, pressedOf(state.italic))
        setPressed(marks.underline, pressedOf(state.underline))
        setPressed(marks.strike, pressedOf(state.strike))
        for (const align of ALIGNS) {
          const pressed = state.align === 'mixed' ? 'mixed' : state.align === align ? 'true' : 'false'
          setPressed(alignButtons[align], pressed)
        }
        setPressed(bullet, state.list === 'mixed' ? 'mixed' : state.list === 'bullet' ? 'true' : 'false')
        setPressed(numbered, state.list === 'mixed' ? 'mixed' : state.list === 'decimal' ? 'true' : 'false')
        paintStyles(doc, state.style)
        const percent = String(Math.round(zoom * 100))
        if (zoomSelect.value !== percent) zoomSelect.value = percent
      } finally {
        painting = false
      }
    },
  }
}

function group(root: HTMLElement): HTMLElement {
  const el = document.createElement('div')
  el.className = 'group'
  root.append(el)
  return el
}

function commandButton(
  label: string,
  shortcut: ShortcutName | null,
  platform: Platform,
  onClick: () => void,
): HTMLButtonElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.textContent = label
  el.setAttribute('aria-label', label)
  if (shortcut) {
    const chord = shortcutChord(platform, shortcut)
    if (chord) el.title = commandTitle(label, chord, platform)
  }
  el.addEventListener('click', onClick)
  return el
}

function toggleButton(
  label: string,
  shortcut: ShortcutName | null,
  platform: Platform,
  onClick: () => void,
): HTMLButtonElement {
  const el = commandButton(label, shortcut, platform, onClick)
  el.setAttribute('aria-pressed', 'false')
  return el
}

function labeledSelect(label: string, className: string): HTMLSelectElement {
  const el = document.createElement('select')
  el.className = className
  el.setAttribute('aria-label', label)
  return el
}

function watchSelect(select: HTMLSelectElement, apply: () => void): void {
  select.addEventListener('change', apply)
  select.addEventListener('input', apply)
}

function pressedOf(value: boolean | 'mixed'): 'true' | 'false' | 'mixed' {
  if (value === 'mixed') return 'mixed'
  return value ? 'true' : 'false'
}

function setPressed(button: HTMLButtonElement, pressed: 'true' | 'false' | 'mixed'): void {
  if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed)
}
