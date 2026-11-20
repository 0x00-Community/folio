// Toolbar controls. The buttons are created once; a later change only writes an attribute when its value differs.
import type { ToggleMark, ToolbarState } from '../editor/edit.ts'
import type { Platform, ShortcutName } from '../editor/input.ts'
import { shortcutChord } from '../editor/input.ts'
import { installedFamilies } from '../fonts.ts'
import { t } from '../i18n.ts'
import type { Doc } from '../model.ts'
import { icon } from './icons.ts'
import type { IconName } from './icons.ts'
import { commandTitle, fontOptions, sizeOptions, styleOptions } from './text.ts'
import type { StyleOption } from './text.ts'

export type Align = 'left' | 'center' | 'right' | 'justify'

export interface ToolbarHandlers {
  onNew(): void
  onOpen(): void
  onSave(): void
  onSaveAs(): void
  onUndo(): void
  onRedo(): void
  onMark(mark: ToggleMark): void
  onFont(family: string): void
  onSize(sizePt: number): void
  onStyle(id: string): void
  onAlign(align: Align): void
  onList(kind: 'bullet' | 'decimal'): void
  onIndent(delta: 1 | -1): void
  onPageSetup(): void
  onInsertTable(): void
  onInsertImage(): void
  onTableRow(where: 'above' | 'below'): void
  onDeleteRows(): void
  onTableColumn(where: 'left' | 'right'): void
  onDeleteColumns(): void
  onDeleteTable(): void
  onZoom(zoom: number): void
}

export interface ToolbarView {
  render(state: ToolbarState, doc: Doc, usedFonts: readonly string[], canSave: boolean): void
  zoom(): number
}

const ALIGNS: readonly Align[] = ['left', 'center', 'right', 'justify']
const ZOOMS = [50, 75, 100, 125, 150, 200] as const

export function createToolbar(root: HTMLElement, platform: Platform, handlers: ToolbarHandlers): ToolbarView {
  root.setAttribute('aria-label', t('toolbar'))
  let painting = false
  let zoom = 1
  let styleKey = ''
  let fontKey = ''
  let sizeKey = ''
  let seenStyles: object | null = null
  let cachedOptions: readonly StyleOption[] = []
  let installed: readonly string[] = []
  let usedFonts: readonly string[] = []
  let fontNow: string | 'mixed' = 'mixed'
  let fontReady = false
  const styleGuard = { n: 0, ignore: false }
  const fontGuard = { n: 0, ignore: false }
  const sizeGuard = { n: 0, ignore: false }

  const file = group(root)
  const saveButton = iconButton(t('save'), 'save', platform, () => handlers.onSave(), 'save')
  file.append(
    textButton(t('new'), platform, () => handlers.onNew(), 'doc'),
    textButton(t('open'), platform, () => handlers.onOpen(), 'folder'),
    saveButton,
    textButton(t('saveAs'), platform, () => handlers.onSaveAs(), 'save-as', 'saveAs'),
  )
  const undo = iconButton(t('undo'), 'undo', platform, () => handlers.onUndo(), 'undo')
  const redo = iconButton(t('redo'), 'redo', platform, () => handlers.onRedo(), 'redo')
  undo.disabled = true
  redo.disabled = true
  group(root).append(undo, redo)

  const marks = {
    bold: toggleButton(t('bold'), 'bold', platform, () => handlers.onMark('bold'), 'bold'),
    italic: toggleButton(t('italic'), 'italic', platform, () => handlers.onMark('italic'), 'italic'),
    underline: toggleButton(t('underline'), 'underline', platform, () => handlers.onMark('underline'), 'underline'),
    strike: toggleButton(t('strike'), null, platform, () => handlers.onMark('strike'), 'strike'),
  }
  group(root).append(marks.bold, marks.italic, marks.underline, marks.strike)

  const fontSelect = labeledSelect(t('font'), 'font')
  watchSelect(fontSelect, () => {
    if (painting || fontGuard.ignore) return
    const value = fontSelect.value
    if (value.length === 0) return
    handlers.onFont(value)
  })
  const sizeSelect = labeledSelect(t('size'), 'size')
  watchSelect(sizeSelect, () => {
    if (painting || sizeGuard.ignore) return
    const value = Number(sizeSelect.value)
    if (!Number.isFinite(value) || value <= 0) return
    handlers.onSize(value)
  })
  group(root).append(fontSelect, sizeSelect)

  const styleSelect = labeledSelect(t('style'), 'style')
  watchSelect(styleSelect, () => {
    if (painting || styleGuard.ignore) return
    const value = styleSelect.value
    if (value.length === 0) return
    handlers.onStyle(value)
  })
  group(root).append(styleSelect)

  void installedFamilies().then((names) => {
    installed = names
    if (!fontReady) return
    paintFont(usedFonts, fontNow)
  })

  const alignButtons = {
    left: toggleButton(t('align.left'), null, platform, () => handlers.onAlign('left'), 'align-left'),
    center: toggleButton(t('align.center'), null, platform, () => handlers.onAlign('center'), 'align-center'),
    right: toggleButton(t('align.right'), null, platform, () => handlers.onAlign('right'), 'align-right'),
    justify: toggleButton(t('align.justify'), null, platform, () => handlers.onAlign('justify'), 'align-justify'),
  }
  group(root).append(alignButtons.left, alignButtons.center, alignButtons.right, alignButtons.justify)

  const bullet = toggleButton(t('list.bullet'), null, platform, () => handlers.onList('bullet'), 'list-bullet')
  const numbered = toggleButton(t('list.number'), null, platform, () => handlers.onList('decimal'), 'list-number')
  const decrease = iconButton(t('list.decrease'), null, platform, () => handlers.onIndent(-1), 'indent-decrease')
  const increase = iconButton(t('list.increase'), null, platform, () => handlers.onIndent(1), 'indent-increase')
  group(root).append(bullet, numbered, decrease, increase)
  group(root).append(iconButton(t('pageSetup'), null, platform, () => handlers.onPageSetup(), 'page-setup'))

  const insertTable = iconButton(t('table.insert'), null, platform, () => handlers.onInsertTable(), 'table')
  const insertPicture = iconButton(t('image.insert'), null, platform, () => handlers.onInsertImage(), 'image')
  group(root).append(insertTable, insertPicture)
  const rowAbove = iconButton(t('table.rowAbove'), null, platform, () => handlers.onTableRow('above'), 'table-row-above')
  const rowBelow = iconButton(t('table.rowBelow'), null, platform, () => handlers.onTableRow('below'), 'table-row-below')
  const deleteRow = iconButton(t('table.deleteRow'), null, platform, () => handlers.onDeleteRows(), 'table-row-delete')
  const columnLeft = iconButton(t('table.columnLeft'), null, platform, () => handlers.onTableColumn('left'), 'table-col-left')
  const columnRight = iconButton(t('table.columnRight'), null, platform, () => handlers.onTableColumn('right'), 'table-col-right')
  const deleteColumn = iconButton(t('table.deleteColumn'), null, platform, () => handlers.onDeleteColumns(), 'table-col-delete')
  const deleteTableButton = iconButton(t('table.delete'), null, platform, () => handlers.onDeleteTable(), 'table-delete')
  for (const button of [rowAbove, rowBelow, deleteRow, columnLeft, columnRight, deleteColumn, deleteTableButton]) {
    button.disabled = true
  }
  group(root).append(rowAbove, rowBelow, deleteRow, columnLeft, columnRight, deleteColumn, deleteTableButton)

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
  group(root, true).append(zoomSelect)

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
      replaceOptions(styleSelect, options.map((option) => ({ value: option.id, label: option.label })), styleGuard)
    }
    const value = current === 'mixed' ? '' : current
    if (styleSelect.value !== value) styleSelect.value = value
  }

  function paintFont(used: readonly string[], current: string | 'mixed'): void {
    usedFonts = used
    fontNow = current
    let options = fontOptions(used, installed, current)
    // The helper folds case. The select value has to be the toolbar's spelling, so keep that string too.
    if (current !== 'mixed' && current.trim() !== '' && !options.includes(current)) options = options.concat(current)
    const key = JSON.stringify(options)
    if (key !== fontKey) {
      fontKey = key
      replaceOptions(fontSelect, options.map((name) => ({ value: name, label: name })), fontGuard)
    }
    const value = current === 'mixed' ? '' : current
    if (fontSelect.value !== value) fontSelect.value = value
  }

  function paintSize(current: ToolbarState['sizePt']): void {
    const options = sizeOptions(current)
    const key = JSON.stringify(options)
    if (key !== sizeKey) {
      sizeKey = key
      replaceOptions(
        sizeSelect,
        options.map((size) => ({ value: String(size), label: String(size) })),
        sizeGuard,
      )
    }
    const value = current === 'mixed' ? '' : String(current)
    if (sizeSelect.value !== value) sizeSelect.value = value
  }

  return {
    zoom: () => zoom,
    render(state, doc, used, canSave) {
      painting = true
      fontReady = true
      try {
        if (saveButton.disabled !== !canSave) saveButton.disabled = !canSave
        if (undo.disabled !== !state.canUndo) undo.disabled = !state.canUndo
        if (redo.disabled !== !state.canRedo) redo.disabled = !state.canRedo
        // A table nested in a cell is refused on save, so insert stays off while the caret is in one.
        setDisabled(insertTable, state.inTable)
        setDisabled(rowAbove, !state.rowTools)
        setDisabled(rowBelow, !state.rowTools)
        setDisabled(deleteRow, !state.rowTools)
        setDisabled(columnLeft, !state.columnTools)
        setDisabled(columnRight, !state.columnTools)
        setDisabled(deleteColumn, !state.columnTools)
        setDisabled(deleteTableButton, !state.inTable)
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
        paintFont(used, state.font)
        paintSize(state.sizePt)
        const percent = String(Math.round(zoom * 100))
        if (zoomSelect.value !== percent) zoomSelect.value = percent
      } finally {
        painting = false
      }
    },
  }
}

function group(root: HTMLElement, atEnd = false): HTMLElement {
  const el = document.createElement('div')
  el.className = atEnd ? 'group zoom' : 'group'
  const leading = root.childElementCount > 0
  root.append(el)
  if (leading) el.append(divider())
  return el
}

function divider(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'divider'
  el.setAttribute('aria-hidden', 'true')
  return el
}

function textButton(
  label: string,
  platform: Platform,
  onClick: () => void,
  graphic: IconName,
  shortcut: ShortcutName | null = null,
): HTMLButtonElement {
  return commandButton(label, shortcut, platform, onClick, graphic, true)
}

function iconButton(
  label: string,
  shortcut: ShortcutName | null,
  platform: Platform,
  onClick: () => void,
  graphic: IconName,
): HTMLButtonElement {
  return commandButton(label, shortcut, platform, onClick, graphic, false)
}

function commandButton(
  label: string,
  shortcut: ShortcutName | null,
  platform: Platform,
  onClick: () => void,
  graphic: IconName,
  withLabel: boolean,
): HTMLButtonElement {
  const el = document.createElement('button')
  el.type = 'button'
  if (withLabel) el.className = 'labeled'
  el.setAttribute('aria-label', label)
  el.append(icon(graphic))
  if (withLabel) el.append(label)
  const chord = shortcut === null ? null : shortcutChord(platform, shortcut)
  if (!withLabel || chord) el.title = commandTitle(label, chord, platform)
  el.addEventListener('click', onClick)
  return el
}

function toggleButton(
  label: string,
  shortcut: ShortcutName | null,
  platform: Platform,
  onClick: () => void,
  graphic: IconName,
): HTMLButtonElement {
  const el = iconButton(label, shortcut, platform, onClick, graphic)
  el.setAttribute('aria-pressed', 'false')
  return el
}

function labeledSelect(label: string, className: string): HTMLSelectElement {
  const el = document.createElement('select')
  el.className = className
  el.setAttribute('aria-label', label)
  return el
}

function replaceOptions(
  select: HTMLSelectElement,
  entries: readonly { value: string, label: string }[],
  guard: { n: number, ignore: boolean },
): void {
  const fragment = document.createDocumentFragment()
  const mixed = document.createElement('option')
  mixed.value = ''
  mixed.textContent = t('style.mixed')
  mixed.hidden = true
  fragment.append(mixed)
  for (const entry of entries) {
    const option = document.createElement('option')
    option.value = entry.value
    option.textContent = entry.label
    fragment.append(option)
  }
  // Rebuilding the options can emit change. Ignore it until the next frame so a rebuild does not edit the document.
  guard.n += 1
  const token = guard.n
  guard.ignore = true
  select.replaceChildren(fragment)
  requestAnimationFrame(() => {
    if (guard.n === token) guard.ignore = false
  })
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

function setDisabled(button: HTMLButtonElement, disabled: boolean): void {
  if (button.disabled !== disabled) button.disabled = disabled
}
