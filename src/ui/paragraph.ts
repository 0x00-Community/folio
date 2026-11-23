// Paragraph dialog. Points stay in the model; left, right and a point "by" amount show the locale's unit.
import type { IndentEdit, ParaFormat, SpacingEdit } from '../editor/edit.ts'
import { t } from '../i18n.ts'
import type { LineSpacing, PageSetup, ParaLook, ParaProps, Pt } from '../model.ts'
import { openDialog } from './dialog.ts'
import { formatMargin, pageUnit } from './page-setup.ts'
import type { PageUnit } from './page-setup.ts'

export type ParaField = 'left' | 'right' | 'by' | 'before' | 'after' | 'lineValue'
export type SpecialKind = 'none' | 'first' | 'hanging' | 'chars'
export type LineRule = 'single' | '1.5' | 'double' | 'multiple' | 'exact' | 'atLeast'

export interface ParaSnapshot {
  readonly align: NonNullable<ParaProps['align']> | null
  readonly left: number | null
  readonly right: number | null
  readonly special: SpecialKind | null
  readonly byPt: number | null
  readonly byChars: number | null
  readonly before: number | null
  readonly after: number | null
  readonly lineRule: LineRule | null
  readonly lineValue: number | null
}

export interface ParaTexts {
  readonly align: string
  readonly left: string
  readonly right: string
  readonly special: string
  readonly by: string
  /** The by field is hundredths of a character, not the dialog's length unit. */
  readonly byChars: boolean
  readonly before: string
  readonly after: string
  readonly lineRule: string
  readonly lineValue: string
}

export interface ReadParagraph {
  readonly format: ParaFormat | null
  readonly invalid: readonly ParaField[]
}

const PT_PER_INCH = 72
const CM_PER_INCH = 2.54
/** Character indents have no range in the brief. 0 to 999 characters is the field's own limit. */
const CHAR_MAX = 999
const SPACE_MAX = 1584
const MULTIPLE_MIN = 0.25
const MULTIPLE_MAX = 132
const LINE_MIN = 0.7
/** Distributed stays out of the list. A paragraph that already is distributed adds it below. */
const ALIGN_CHOICES = ['left', 'center', 'right', 'justify'] as const

export function indentMax(page: PageSetup): number {
  const content = page.widthPt - page.margin.left - page.margin.gutter - page.margin.right
  return Math.max(0, content - 72)
}

/**
 * Effective values from the looks the editor already resolved for painting.
 * A field is null only when the touched paragraphs do not share it.
 */
export function paragraphSnapshot(looks: readonly ParaLook[]): ParaSnapshot {
  return {
    align: shared(looks.map(look => look.align)),
    left: shared(looks.map(look => look.indent.left)),
    right: shared(looks.map(look => look.indent.right)),
    special: shared(looks.map(specialOf)),
    byPt: shared(looks.map(byPtOf)),
    byChars: shared(looks.map(byCharsOf)),
    before: shared(looks.map(look => look.spacing.before)),
    after: shared(looks.map(look => look.spacing.after)),
    lineRule: shared(looks.map(lineRuleOf)),
    lineValue: shared(looks.map(lineValueOf)),
  }
}

/** The strings the dialog shows for `original`. Reading them back writes nothing. */
export function snapshotTexts(original: ParaSnapshot, unit: PageUnit): ParaTexts {
  const chars = original.special === 'chars'
  const lineShown = original.lineRule !== null && needsLineValue(original.lineRule)
  return {
    align: original.align ?? '',
    left: original.left === null ? '' : formatMargin(original.left, unit),
    right: original.right === null ? '' : formatMargin(original.right, unit),
    special: original.special === null ? '' : (original.special === 'chars' ? 'first' : original.special),
    by: byText(original, unit),
    byChars: chars,
    before: original.before === null ? '' : trimFixed(original.before.toFixed(2)),
    after: original.after === null ? '' : trimFixed(original.after.toFixed(2)),
    lineRule: original.lineRule ?? '',
    lineValue: lineShown && original.lineValue !== null ? trimFixed(original.lineValue.toFixed(2)) : '',
  }
}

export function readParagraph(
  texts: ParaTexts,
  original: ParaSnapshot,
  unit: PageUnit,
  indentMaxPt: number,
): ReadParagraph {
  const invalid: ParaField[] = []
  const format: { align?: ParaFormat['align'], indent?: IndentEdit, spacing?: SpacingEdit } = {}

  if (texts.align !== '' && texts.align !== (original.align ?? '')) {
    if (isAlign(texts.align)) format.align = texts.align
  }

  const indent: {
    left?: Pt
    right?: Pt
    firstLine?: Pt | null
    hanging?: Pt | null
    firstLineChars?: number | null
  } = {}
  const left = lengthField(texts.left, original.left, unit, 0, indentMaxPt)
  if (left === 'bad') invalid.push('left')
  else if (left !== 'omit') indent.left = asPt(left)
  const right = lengthField(texts.right, original.right, unit, 0, indentMaxPt)
  if (right === 'bad') invalid.push('right')
  else if (right !== 'omit') indent.right = asPt(right)

  const special = readSpecial(texts, original, unit, indentMaxPt)
  if (special === 'bad') invalid.push('by')
  else if (special) Object.assign(indent, special)
  if (indent.left !== undefined || indent.right !== undefined || (special !== 'bad' && special !== null)) {
    format.indent = indent
  }

  const spacing: { before?: Pt, after?: Pt, line?: LineSpacing } = {}
  const before = pointField(texts.before, original.before, 0, SPACE_MAX)
  if (before === 'bad') invalid.push('before')
  else if (before !== 'omit') spacing.before = asPt(before)
  const after = pointField(texts.after, original.after, 0, SPACE_MAX)
  if (after === 'bad') invalid.push('after')
  else if (after !== 'omit') spacing.after = asPt(after)
  const line = readLine(texts, original)
  if (line === 'bad') invalid.push('lineValue')
  else if (line) spacing.line = line
  if (spacing.before !== undefined || spacing.after !== undefined || spacing.line) format.spacing = spacing

  if (invalid.length > 0) return { format: null, invalid }
  if (format.align === undefined && format.indent === undefined && format.spacing === undefined) {
    return { format: null, invalid }
  }
  return { format, invalid }
}

export function openParagraph(looks: readonly ParaLook[], page: PageSetup): Promise<ParaFormat | null> {
  const unit = pageUnit()
  const original = paragraphSnapshot(looks)
  const shown = snapshotTexts(original, unit)
  const limit = indentMax(page)
  let byChars = original.special === 'chars'
  const body = document.createElement('div')
  body.className = 'para-setup'

  const align = selectField('para.align', alignOptions(original.align), shown.align)
  const left = labeledNumber(t('para.left', { unit: t('page.unit') }), shown.left, false)
  const right = labeledNumber(t('para.right', { unit: t('page.unit') }), shown.right, false)
  const indents = document.createElement('div')
  indents.className = 'para-setup-grid'
  indents.append(left.row, right.row)

  const special = selectField('para.special', [
    { value: 'none', label: t('para.special.none') },
    { value: 'first', label: t('para.special.first') },
    { value: 'hanging', label: t('para.special.hanging') },
  ], shown.special)
  const by = byField(shown.by, byChars, original.special === 'none' || original.special === null)
  const specialRow = document.createElement('div')
  specialRow.className = 'para-setup-grid'
  specialRow.append(special.row, by.row)

  const before = pointRow('before', shown.before)
  const after = pointRow('after', shown.after)
  const spaces = document.createElement('div')
  spaces.className = 'para-setup-grid'
  spaces.append(before.row, after.row)

  const line = selectField('para.line', [
    { value: 'single', label: t('para.line.single') },
    { value: '1.5', label: t('para.line.1.5') },
    { value: 'double', label: t('para.line.double') },
    { value: 'multiple', label: t('para.line.multiple') },
    { value: 'exact', label: t('para.line.exact') },
    { value: 'atLeast', label: t('para.line.atLeast') },
  ], shown.lineRule)
  const lineValue = labeledNumber(t('para.lineValue'), shown.lineValue, false)
  lineValue.input.disabled = !needsLineValue(shown.lineRule)
  const lineRow = document.createElement('div')
  lineRow.className = 'para-setup-grid'
  lineRow.append(line.row, lineValue.row)
  body.append(
    group('para.group.general', gridOf(align.row)),
    group('para.group.indent', stack(indents, specialRow)),
    group('para.group.spacing', stack(spaces, lineRow)),
  )

  function paintBy(): void {
    byChars = byChars && special.select.value === 'first'
    const chars = byChars && special.select.value === 'first'
    const name = chars
      ? t('para.byChars')
      : t('para.by', { unit: t('page.unit') })
    by.caption.textContent = name
    by.input.setAttribute('aria-label', name)
    by.input.disabled = special.select.value === 'none' || special.select.value === ''
  }

  function texts(): ParaTexts {
    return {
      align: align.select.value,
      left: fieldText(left.input),
      right: fieldText(right.input),
      special: special.select.value,
      by: fieldText(by.input),
      byChars: byChars && special.select.value === 'first',
      before: fieldText(before.input),
      after: fieldText(after.input),
      lineRule: line.select.value,
      lineValue: fieldText(lineValue.input),
    }
  }

  function sync(): ReadParagraph {
    const read = readParagraph(texts(), original, unit, limit)
    const fields = { left: left.input, right: right.input, by: by.input, before: before.input, after: after.input, lineValue: lineValue.input }
    for (const key of Object.keys(fields) as ParaField[]) {
      const input = fields[key]
      if (read.invalid.includes(key)) input.setAttribute('aria-invalid', 'true')
      else input.removeAttribute('aria-invalid')
    }
    return read
  }

  // The runtime reports a select change as input, change or both, as the toolbar selects found.
  const onSpecial = (): void => {
    if (special.select.value !== 'first') byChars = false
    if (byChars === false && by.input.dataset.chars === 'true' && special.select.value !== 'first') {
      by.input.value = ''
      delete by.input.dataset.chars
    }
    paintBy()
    sync()
  }
  special.select.addEventListener('change', onSpecial)
  special.select.addEventListener('input', onSpecial)
  const onLine = (): void => {
    const show = needsLineValue(line.select.value)
    lineValue.input.disabled = !show
    if (!show) lineValue.input.value = ''
    else if (lineValue.input.value === '' && original.lineRule === line.select.value && original.lineValue !== null) {
      lineValue.input.value = trimFixed(original.lineValue.toFixed(2))
    }
    sync()
  }
  line.select.addEventListener('change', onLine)
  line.select.addEventListener('input', onLine)
  paintBy()

  return openDialog({
    title: t('para.title'),
    body,
    buttons: [
      { label: t('page.ok'), value: 'ok', primary: true, enabled: () => sync().invalid.length === 0 },
      { label: t('save.cancel'), value: 'cancel' },
    ],
    cancel: 'cancel',
    focus: align.select,
  }).then((choice) => (choice === 'ok' ? sync().format : null))
}

function readSpecial(
  texts: ParaTexts,
  original: ParaSnapshot,
  unit: PageUnit,
  indentMaxPt: number,
): IndentEdit | null | 'bad' {
  const shown = original.special === 'chars' ? 'first' : (original.special ?? '')
  if (texts.special === '' || texts.special === shown && texts.by.trim() === '') return null
  if (texts.special === 'none') {
    if (shown === 'none' || shown === '') return null
    return { firstLine: null, hanging: null, firstLineChars: null }
  }
  if (texts.special !== 'first' && texts.special !== 'hanging') return null
  if (texts.byChars && texts.special === 'first') {
    const chars = characterField(texts.by, original.byChars)
    if (chars === 'bad') return 'bad'
    if (chars === 'omit') return null
    return { firstLineChars: chars }
  }
  if (texts.by.trim() === '') return texts.special === shown ? null : 'bad'
  const amount = lengthField(texts.by, texts.special === shown ? original.byPt : null, unit, 0, indentMaxPt)
  if (amount === 'bad') return 'bad'
  if (amount === 'omit') return null
  if (texts.special === 'first') return { firstLine: asPt(amount), hanging: null, firstLineChars: null }
  return { hanging: asPt(amount), firstLine: null, firstLineChars: null }
}

function readLine(texts: ParaTexts, original: ParaSnapshot): LineSpacing | null | 'bad' {
  if (texts.lineRule === '') return null
  if (texts.lineRule === 'single') return sameLineValue(original, { rule: 'auto', multiple: 1 })
  if (texts.lineRule === '1.5') return sameLineValue(original, { rule: 'auto', multiple: 1.5 })
  if (texts.lineRule === 'double') return sameLineValue(original, { rule: 'auto', multiple: 2 })
  if (texts.lineRule !== 'multiple' && texts.lineRule !== 'exact' && texts.lineRule !== 'atLeast') return null
  const min = texts.lineRule === 'multiple' ? MULTIPLE_MIN : LINE_MIN
  const max = texts.lineRule === 'multiple' ? MULTIPLE_MAX : SPACE_MAX
  const originalValue = texts.lineRule === original.lineRule ? original.lineValue : null
  const parsed = pointField(texts.lineValue, originalValue, min, max)
  if (parsed === 'bad') return 'bad'
  if (parsed === 'omit') return texts.lineRule === original.lineRule ? null : 'bad'
  if (texts.lineRule === 'multiple') return sameLineValue(original, { rule: 'auto', multiple: parsed })
  if (texts.lineRule === 'exact') return sameLineValue(original, { rule: 'exact', pt: asPt(parsed) })
  return sameLineValue(original, { rule: 'atLeast', pt: asPt(parsed) })
}

function sameLineValue(original: ParaSnapshot, line: LineSpacing): LineSpacing | null {
  if (original.lineRule === null) return line
  if (line.rule === 'auto' && (original.lineRule === 'single' || original.lineRule === '1.5' || original.lineRule === 'double' || original.lineRule === 'multiple')) {
    const current = original.lineRule === 'single' ? 1 : original.lineRule === '1.5' ? 1.5 : original.lineRule === 'double' ? 2 : original.lineValue
    if (current === line.multiple) return null
  }
  if (line.rule !== 'auto' && (original.lineRule === 'exact' || original.lineRule === 'atLeast') && original.lineValue === line.pt) {
    if ((line.rule === 'exact' && original.lineRule === 'exact') || (line.rule === 'atLeast' && original.lineRule === 'atLeast')) {
      return null
    }
  }
  return line
}

function lengthField(
  text: string,
  original: number | null,
  unit: PageUnit,
  min: number,
  max: number,
): number | 'omit' | 'bad' {
  if (text.trim() === '') return 'omit'
  if (original !== null && text === formatMargin(original, unit)) return 'omit'
  const value = Number(text)
  if (!Number.isFinite(value)) return 'bad'
  const inches = unit === 'cm' ? value / CM_PER_INCH : value
  const points = Math.round(inches * PT_PER_INCH * 20) / 20
  if (points < min || points > max) return 'bad'
  return points
}

function pointField(text: string, original: number | null, min: number, max: number): number | 'omit' | 'bad' {
  if (text.trim() === '') return 'omit'
  if (original !== null && text === trimFixed(original.toFixed(2))) return 'omit'
  const value = Number(text)
  if (!Number.isFinite(value) || value < min || value > max) return 'bad'
  return Math.round(value * 20) / 20
}

function characterField(text: string, original: number | null): number | 'omit' | 'bad' {
  if (text.trim() === '') return 'omit'
  if (original !== null && text === formatChars(original)) return 'omit'
  const value = Number(text)
  if (!Number.isFinite(value) || value < 0 || value > CHAR_MAX) return 'bad'
  return Math.round(value * 100)
}

function specialOf(look: ParaLook): SpecialKind {
  if (look.indent.firstLineChars !== 0) return 'chars'
  const first = look.indent.firstLine
  const hanging = look.indent.hanging
  if (first !== 0 && hanging === 0) return 'first'
  if (hanging !== 0 && first === 0) return 'hanging'
  if (first === 0 && hanging === 0) return 'none'
  return 'first'
}

function byPtOf(look: ParaLook): number | null {
  const kind = specialOf(look)
  if (kind === 'first') return look.indent.firstLine
  if (kind === 'hanging') return look.indent.hanging
  return null
}

function byCharsOf(look: ParaLook): number | null {
  if (look.indent.firstLineChars === 0) return null
  return look.indent.firstLineChars
}

function lineRuleOf(look: ParaLook): LineRule {
  const line = look.spacing.line
  if (line.rule === 'exact') return 'exact'
  if (line.rule === 'atLeast') return 'atLeast'
  if (line.multiple === 1) return 'single'
  if (line.multiple === 1.5) return '1.5'
  if (line.multiple === 2) return 'double'
  return 'multiple'
}

function lineValueOf(look: ParaLook): number {
  const line = look.spacing.line
  if (line.rule === 'auto') return line.multiple
  return line.pt
}

function byText(original: ParaSnapshot, unit: PageUnit): string {
  if (original.special === 'chars') return original.byChars === null ? '' : formatChars(original.byChars)
  if (original.special === 'first' || original.special === 'hanging') {
    return original.byPt === null ? '' : formatMargin(original.byPt, unit)
  }
  return ''
}

function shared<T>(values: readonly T[]): T | null {
  const first = values[0]
  if (first === undefined) return null
  for (const value of values) if (!Object.is(value, first)) return null
  return first
}

function isAlign(value: string): value is NonNullable<ParaProps['align']> {
  return value === 'distribute' || (ALIGN_CHOICES as readonly string[]).includes(value)
}

function alignOptions(current: ParaSnapshot['align']): { value: string, label: string }[] {
  const options: { value: string, label: string }[] = ALIGN_CHOICES.map((value) => ({
    value,
    label: t(`para.align.${value}`),
  }))
  if (current === 'distribute') options.push({ value: 'distribute', label: t('para.align.distribute') })
  return options
}

function needsLineValue(rule: string): boolean {
  return rule === 'multiple' || rule === 'exact' || rule === 'atLeast'
}

function formatChars(hundredths: number): string {
  return trimFixed((hundredths / 100).toFixed(2))
}

function trimFixed(text: string): string {
  return text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
}

function asPt(value: number): Pt {
  return value as Pt
}

function selectField(
  key: string,
  options: readonly { value: string, label: string }[],
  value: string,
): { row: HTMLLabelElement, select: HTMLSelectElement } {
  const row = document.createElement('label')
  row.className = 'para-setup-row'
  const caption = document.createElement('span')
  caption.textContent = t(key)
  caption.setAttribute('aria-hidden', 'true')
  const select = document.createElement('select')
  select.setAttribute('aria-label', t(key))
  const blank = document.createElement('option')
  blank.value = ''
  blank.hidden = value !== ''
  select.append(blank)
  for (const option of options) {
    const el = document.createElement('option')
    el.value = option.value
    el.textContent = option.label
    select.append(el)
  }
  select.value = value
  row.append(caption, select)
  return { row, select }
}

function group(key: string, content: HTMLElement): HTMLElement {
  const section = document.createElement('div')
  section.className = 'para-group'
  const caption = document.createElement('div')
  caption.className = 'para-caption'
  caption.textContent = t(key)
  section.append(caption, content)
  return section
}

function gridOf(child: HTMLElement): HTMLElement {
  const grid = document.createElement('div')
  grid.className = 'para-setup-grid'
  grid.append(child)
  return grid
}

function stack(...children: HTMLElement[]): HTMLElement {
  const rows = document.createElement('div')
  rows.className = 'para-rows'
  rows.append(...children)
  return rows
}

function byField(
  text: string,
  chars: boolean,
  disabled: boolean,
): { row: HTMLLabelElement, caption: HTMLSpanElement, input: HTMLInputElement } {
  const name = chars ? t('para.byChars') : t('para.by', { unit: t('page.unit') })
  const row = document.createElement('label')
  row.className = 'para-setup-row'
  const caption = document.createElement('span')
  caption.textContent = name
  caption.setAttribute('aria-hidden', 'true')
  const input = document.createElement('input')
  input.type = 'text'
  input.inputMode = 'decimal'
  input.autocomplete = 'off'
  input.setAttribute('aria-label', name)
  input.value = text
  if (chars) input.dataset.chars = 'true'
  input.disabled = disabled
  input.addEventListener('focus', () => input.select())
  row.append(caption, input)
  return { row, caption, input }
}

function pointRow(key: 'before' | 'after', value: string): { row: HTMLLabelElement, input: HTMLInputElement } {
  return labeledNumber(t(`para.${key}`), value, false)
}

function labeledNumber(name: string, value: string, chars: boolean): { row: HTMLLabelElement, input: HTMLInputElement } {
  const row = document.createElement('label')
  row.className = 'para-setup-row'
  const caption = document.createElement('span')
  caption.textContent = name
  caption.setAttribute('aria-hidden', 'true')
  const input = document.createElement('input')
  input.type = 'text'
  input.inputMode = 'decimal'
  input.autocomplete = 'off'
  input.setAttribute('aria-label', name)
  input.value = value
  if (chars) input.dataset.chars = 'true'
  input.addEventListener('focus', () => input.select())
  row.append(caption, input)
  return { row, input }
}

function fieldText(input: HTMLInputElement): string {
  if (input.disabled) return ''
  return input.value
}
