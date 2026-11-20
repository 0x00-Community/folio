// The confirm button and aria-invalid share one read of the two fields.
import { t } from '../i18n.ts'
import { openDialog } from './dialog.ts'

export const TABLE_ROW_MIN = 1
export const TABLE_ROW_MAX = 20
export const TABLE_COLUMN_MIN = 1
export const TABLE_COLUMN_MAX = 10
export const TABLE_ROW_DEFAULT = 3
export const TABLE_COLUMN_DEFAULT = 3

export type TableAxis = 'rows' | 'cols'

export interface TableSize {
  readonly rows: number
  readonly cols: number
}

export interface ReadTableSize {
  readonly size: TableSize | null
  readonly invalid: readonly TableAxis[]
}

export function readTableSize(rowsText: string, colsText: string): ReadTableSize {
  const rows = readCount(rowsText, TABLE_ROW_MIN, TABLE_ROW_MAX)
  const cols = readCount(colsText, TABLE_COLUMN_MIN, TABLE_COLUMN_MAX)
  const invalid: TableAxis[] = []
  if (rows === null) invalid.push('rows')
  if (cols === null) invalid.push('cols')
  if (rows === null || cols === null) return { size: null, invalid }
  return { size: { rows, cols }, invalid }
}

export function openInsertTable(): Promise<TableSize | null> {
  const body = document.createElement('div')
  body.className = 'insert-table'
  const rows = countInput('rows', TABLE_ROW_DEFAULT, TABLE_ROW_MIN, TABLE_ROW_MAX)
  const cols = countInput('cols', TABLE_COLUMN_DEFAULT, TABLE_COLUMN_MIN, TABLE_COLUMN_MAX)
  body.append(rows.row, cols.row)

  function read(): ReadTableSize {
    const result = readTableSize(fieldText(rows.input), fieldText(cols.input))
    mark(rows.input, result.invalid.includes('rows'))
    mark(cols.input, result.invalid.includes('cols'))
    return result
  }

  return openDialog({
    title: t('table.insert'),
    body,
    buttons: [
      { label: t('page.ok'), value: 'ok', primary: true, enabled: () => read().size !== null },
      { label: t('save.cancel'), value: 'cancel' },
    ],
    cancel: 'cancel',
    focus: rows.input,
  }).then((choice) => (choice === 'ok' ? read().size : null))
}

function countInput(
  axis: TableAxis,
  value: number,
  min: number,
  max: number,
): { row: HTMLLabelElement, input: HTMLInputElement } {
  const row = document.createElement('label')
  row.className = 'insert-table-row'
  const name = t(axis === 'rows' ? 'table.rows' : 'table.columns')
  const caption = document.createElement('span')
  caption.textContent = name
  caption.setAttribute('aria-hidden', 'true')
  const input = document.createElement('input')
  input.type = 'number'
  input.min = String(min)
  input.max = String(max)
  input.step = '1'
  input.autocomplete = 'off'
  input.setAttribute('aria-label', name)
  input.value = String(value)
  input.addEventListener('focus', () => input.select())
  row.append(caption, input)
  return { row, input }
}

function mark(input: HTMLInputElement, invalid: boolean): void {
  if (invalid) input.setAttribute('aria-invalid', 'true')
  else input.removeAttribute('aria-invalid')
}

function fieldText(input: HTMLInputElement): string {
  if (input.validity.badInput) return ''
  return input.value
}

function readCount(text: string, min: number, max: number): number | null {
  const trimmed = text.trim()
  if (!/^[0-9]+$/.test(trimmed)) return null
  const value = Number(trimmed)
  if (!Number.isInteger(value) || value < min || value > max) return null
  return value
}
