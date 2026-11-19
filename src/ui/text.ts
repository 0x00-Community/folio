// Pure strings for the shell. No DOM, so the title, dirty bit and status line can be tested on Node.
import type { Platform } from '../editor/input.ts'

export interface StatusCounts {
  readonly page: number
  readonly pages: number
  readonly pagesFinal: boolean
  readonly words: number
}

export type Translate = (key: string, values?: Record<string, string | number>) => string

export interface StyleOption {
  readonly id: string
  readonly label: string
}

const ROLE_ORDER: readonly string[] = ['normal', 'title', 'heading1', 'heading2', 'heading3']

/** True when the document object is not the snapshot taken at the last open or new. A missing file is not dirty. */
export function isDirty(doc: object, file: { readonly saved: object } | null): boolean {
  return file !== null && doc !== file.saved
}

/**
 * Save has something to write. A clean document that already has a file handle does not.
 * No handle (untitled, or bytes opened without a file) still offers Save, which asks for a place.
 */
export function canSave(
  doc: object,
  file: { readonly handle: object | null; readonly saved: object } | null,
): boolean {
  if (file === null || file.handle === null) return true
  return doc !== file.saved
}

/** File name, a leading bullet while dirty, then the app name. The bullet is the dirty mark in the window title. */
export function formatTitle(name: string, dirty: boolean, appName: string): string {
  return `${dirty ? '• ' : ''}${name} - ${appName}`
}

/**
 * Page, word count and zoom, in that order. While pagination is still running, the page count is prefixed with ≥
 * so a partial count is not shown as final.
 */
export function statusText(status: StatusCounts, zoom: number, translate: Translate): string {
  const pages = status.pagesFinal ? String(status.pages) : `≥${status.pages}`
  const percent = Math.round(zoom * 100)
  return [
    translate('status.page', { page: status.page, pages }),
    translate('status.words', { words: status.words }),
    translate('status.zoom', { zoom: percent }),
  ].join(' · ')
}

/** "mod+shift+z" as a person would read it: ⌘⇧Z on macOS, Ctrl+Shift+Z elsewhere. */
export function formatChord(chord: string, platform: Platform): string {
  const mac = platform === 'mac'
  const word: Record<string, string> = mac
    ? { mod: '⌘', shift: '⇧', alt: '⌥', ctrl: '⌃', meta: '⌘' }
    : { mod: 'Ctrl', shift: 'Shift', alt: 'Alt', ctrl: 'Ctrl', meta: 'Meta' }
  const parts = chord.split('+').filter(part => part.length > 0).map(part => {
    const named = word[part]
    if (named !== undefined) return named
    return part.length === 1 ? part.toUpperCase() : part
  })
  return mac ? parts.join('') : parts.join('+')
}

/** Button title. No chord means the label alone, so a command the keymap does not bind grows no shortcut. */
export function commandTitle(label: string, chord: string | null, platform: Platform): string {
  if (chord === null || chord.length === 0) return label
  return `${label} (${formatChord(chord, platform)})`
}

/**
 * Paragraph styles for the dropdown. The five roles come first, in reading order; everything else follows by name.
 * A known role uses the locale label. Any other style keeps the name stored in the document.
 */
export function styleOptions(
  styles: Iterable<[string, { readonly name: string; readonly role: string | null }]>,
  roleLabel: (role: string) => string,
): StyleOption[] {
  const rows = [...styles]
  rows.sort((a, b) => {
    const byRole = roleRank(a[1].role) - roleRank(b[1].role)
    if (byRole !== 0) return byRole
    return a[1].name < b[1].name ? -1 : a[1].name > b[1].name ? 1 : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
  })
  return rows.map(([id, style]) => {
    const role = style.role
    const known = role !== null && ROLE_ORDER.includes(role)
    return { id, label: known && role !== null ? roleLabel(role) : style.name }
  })
}

function roleRank(role: string | null): number {
  if (role === null) return ROLE_ORDER.length + 1
  const index = ROLE_ORDER.indexOf(role)
  return index === -1 ? ROLE_ORDER.length : index
}

const FONT_SIZES: readonly number[] = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72]

/**
 * Families for the font menu: the ones the document uses, then the installed ones.
 * Comparison is case-insensitive and the first spelling wins. A current value in neither list is appended.
 * `'mixed'` adds nothing.
 */
export function fontOptions(
  used: readonly string[],
  installed: readonly string[],
  current: string | 'mixed',
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const add = (name: string): void => {
    const trimmed = name.trim()
    if (trimmed === '') return
    const key = trimmed.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(trimmed)
  }
  for (const name of used) add(name)
  for (const name of installed) add(name)
  if (current !== 'mixed') add(current)
  return out
}

/**
 * The fixed point sizes, with `current` inserted in order when it is not already there.
 * `'mixed'` leaves the list as it is.
 */
export function sizeOptions(current: number | 'mixed'): number[] {
  const sizes = [...FONT_SIZES]
  if (current === 'mixed' || !Number.isFinite(current) || sizes.some((size) => size === current)) return sizes
  const index = sizes.findIndex((size) => size > current)
  if (index === -1) sizes.push(current)
  else sizes.splice(index, 0, current)
  return sizes
}

export function isFileHandle(handle: { readonly kind: string } | undefined): handle is FileSystemFileHandle {
  return handle !== undefined && handle.kind === 'file'
}

/** A system open-file request carries a file handle. Anything else, including a directory, is ignored. */
export function fileHandleFromRequest(request: {
  readonly kind: string
  readonly handle?: { readonly kind: string }
}): FileSystemFileHandle | null {
  if (request.kind !== 'open-file' || !isFileHandle(request.handle)) return null
  return request.handle
}

export function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}
