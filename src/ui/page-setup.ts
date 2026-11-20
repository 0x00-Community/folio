// Page setup for the section that holds the caret. Points stay in the model; the
// fields show the locale's unit and convert only at this edge.
import { locale, t } from '../i18n.ts'
import type { PageSetup, Pt } from '../model.ts'
import { openDialog } from './dialog.ts'

export type PageUnit = 'cm' | 'in'
export type MarginEdge = 'top' | 'right' | 'bottom' | 'left'

export interface PaperSize {
  readonly key: string
  readonly widthPt: number
  readonly heightPt: number
}

export interface MarginTexts {
  readonly top: string
  readonly right: string
  readonly bottom: string
  readonly left: string
}

export interface ReadMargins {
  readonly page: PageSetup | null
  readonly invalid: readonly MarginEdge[]
}

const PT_PER_INCH = 72
const CM_PER_INCH = 2.54
const MATCH_PT = 0.5
const EDGES: readonly MarginEdge[] = ['top', 'right', 'bottom', 'left']

export const PAPER_SIZES: readonly PaperSize[] = [
  { key: 'A4', widthPt: 11906 / 20, heightPt: 16838 / 20 },
  { key: 'A3', widthPt: 16838 / 20, heightPt: 23811 / 20 },
  { key: 'A5', widthPt: 8391 / 20, heightPt: 11906 / 20 },
  { key: 'B5', widthPt: 10318 / 20, heightPt: 14570 / 20 },
  { key: 'Letter', widthPt: 12240 / 20, heightPt: 15840 / 20 },
  { key: 'Legal', widthPt: 12240 / 20, heightPt: 20160 / 20 },
  { key: '16K', widthPt: 10431 / 20, heightPt: 14740 / 20 },
]

export function pageUnit(): PageUnit {
  return locale === 'zh' ? 'cm' : 'in'
}

export function formatMargin(pt: number, unit: PageUnit): string {
  const inches = pt / PT_PER_INCH
  const value = unit === 'cm' ? inches * CM_PER_INCH : inches
  return trimFixed(value.toFixed(2))
}

export function matchPaper(page: { readonly widthPt: number; readonly heightPt: number }): { key: string; landscape: boolean } {
  const landscape = page.widthPt > page.heightPt
  const width = landscape ? page.heightPt : page.widthPt
  const height = landscape ? page.widthPt : page.heightPt
  const found = PAPER_SIZES.find((size) => Math.abs(size.widthPt - width) <= MATCH_PT && Math.abs(size.heightPt - height) <= MATCH_PT)
  return { key: found ? found.key : 'custom', landscape }
}

export function orientSize(
  size: { readonly widthPt: number; readonly heightPt: number },
  landscape: boolean,
): { widthPt: number; heightPt: number } {
  const wide = size.widthPt > size.heightPt
  if (landscape === wide) return { widthPt: size.widthPt, heightPt: size.heightPt }
  return { widthPt: size.heightPt, heightPt: size.widthPt }
}

export function sizeForPaper(
  key: string,
  landscape: boolean,
  current: { readonly widthPt: number; readonly heightPt: number },
): { widthPt: number; heightPt: number } {
  const found = PAPER_SIZES.find((size) => size.key === key)
  if (!found) return orientSize(current, landscape)
  return orientSize(found, landscape)
}

export function readMargins(
  size: { readonly widthPt: number; readonly heightPt: number },
  texts: MarginTexts,
  original: PageSetup,
  unit: PageUnit,
): ReadMargins {
  const invalid: MarginEdge[] = []
  const points: Partial<Record<MarginEdge, number>> = {}
  for (const edge of EDGES) {
    const parsed = marginPoint(texts[edge], original.margin[edge], unit)
    if (parsed === null) invalid.push(edge)
    else points[edge] = parsed
  }
  const top = points.top
  const right = points.right
  const bottom = points.bottom
  const left = points.left
  if (top !== undefined && bottom !== undefined && size.heightPt - top - bottom <= 0) {
    if (!invalid.includes('top')) invalid.push('top')
    if (!invalid.includes('bottom')) invalid.push('bottom')
  }
  if (left !== undefined && right !== undefined && size.widthPt - left - right - original.margin.gutter <= 0) {
    if (!invalid.includes('left')) invalid.push('left')
    if (!invalid.includes('right')) invalid.push('right')
  }
  if (invalid.length > 0 || top === undefined || right === undefined || bottom === undefined || left === undefined) {
    return { page: null, invalid }
  }
  const page: PageSetup = {
    widthPt: asPt(size.widthPt),
    heightPt: asPt(size.heightPt),
    margin: {
      top: asPt(top),
      right: asPt(right),
      bottom: asPt(bottom),
      left: asPt(left),
      header: original.margin.header,
      footer: original.margin.footer,
      gutter: original.margin.gutter,
    },
  }
  if (samePage(page, original)) return { page: null, invalid: [] }
  return { page, invalid: [] }
}

export function openPageSetup(page: PageSetup): Promise<PageSetup | null> {
  const unit = pageUnit()
  const matched = matchPaper(page)
  let size = { widthPt: Number(page.widthPt), heightPt: Number(page.heightPt) }
  const body = document.createElement('div')
  body.className = 'page-setup'

  const paper = document.createElement('label')
  paper.className = 'page-setup-row'
  const paperCaption = document.createElement('span')
  paperCaption.textContent = t('page.paper')
  paperCaption.setAttribute('aria-hidden', 'true')
  const select = document.createElement('select')
  select.setAttribute('aria-label', t('page.paper'))
  for (const item of PAPER_SIZES) {
    const option = document.createElement('option')
    option.value = item.key
    option.textContent = t(`paper.${item.key}`)
    select.append(option)
  }
  const custom = document.createElement('option')
  custom.value = 'custom'
  custom.textContent = t('page.custom')
  select.append(custom)
  select.value = matched.key
  paper.append(paperCaption, select)

  const orient = document.createElement('fieldset')
  orient.className = 'page-setup-orient'
  const legend = document.createElement('legend')
  legend.textContent = t('page.orientation')
  orient.append(legend)
  const portrait = radio('portrait', !matched.landscape)
  const landscape = radio('landscape', matched.landscape)
  orient.append(portrait.label, landscape.label)

  const inputs = {
    top: marginInput('top', page, unit),
    right: marginInput('right', page, unit),
    bottom: marginInput('bottom', page, unit),
    left: marginInput('left', page, unit),
  }
  const margins = document.createElement('div')
  margins.className = 'page-setup-margins'
  margins.append(inputs.top.row, inputs.right.row, inputs.bottom.row, inputs.left.row)
  body.append(paper, orient, margins)

  function texts(): MarginTexts {
    return {
      top: fieldText(inputs.top.input),
      right: fieldText(inputs.right.input),
      bottom: fieldText(inputs.bottom.input),
      left: fieldText(inputs.left.input),
    }
  }

  function sync(): ReadMargins {
    const read = readMargins(size, texts(), page, unit)
    for (const edge of EDGES) {
      const input = inputs[edge].input
      if (read.invalid.includes(edge)) input.setAttribute('aria-invalid', 'true')
      else input.removeAttribute('aria-invalid')
    }
    return read
  }

  function landscapeNow(): boolean {
    return landscape.input.checked
  }

  select.addEventListener('change', () => {
    size = sizeForPaper(select.value, landscapeNow(), size)
    sync()
  })
  const onOrient = (): void => {
    size = sizeForPaper(select.value, landscapeNow(), size)
    sync()
  }
  portrait.input.addEventListener('change', onOrient)
  landscape.input.addEventListener('change', onOrient)

  return openDialog({
    title: t('pageSetup'),
    body,
    buttons: [
      { label: t('page.ok'), value: 'ok', primary: true, enabled: () => sync().invalid.length === 0 },
      { label: t('save.cancel'), value: 'cancel' },
    ],
    cancel: 'cancel',
    focus: inputs.top.input,
  }).then((choice) => (choice === 'ok' ? sync().page : null))
}

function radio(value: 'portrait' | 'landscape', checked: boolean): { input: HTMLInputElement; label: HTMLLabelElement } {
  const label = document.createElement('label')
  const input = document.createElement('input')
  input.type = 'radio'
  input.name = 'page-orientation'
  input.value = value
  input.checked = checked
  const name = t(`page.${value}`)
  input.setAttribute('aria-label', name)
  const caption = document.createElement('span')
  caption.textContent = name
  caption.setAttribute('aria-hidden', 'true')
  label.append(input, caption)
  return { input, label }
}

function marginInput(
  edge: MarginEdge,
  page: PageSetup,
  unit: PageUnit,
): { row: HTMLLabelElement; input: HTMLInputElement } {
  const row = document.createElement('label')
  row.className = 'page-setup-row'
  const caption = document.createElement('span')
  const name = t(`page.margin.${edge}`, { unit: t('page.unit') })
  caption.textContent = name
  caption.setAttribute('aria-hidden', 'true')
  const input = document.createElement('input')
  input.type = 'number'
  input.step = 'any'
  input.autocomplete = 'off'
  input.setAttribute('aria-label', name)
  input.value = formatMargin(page.margin[edge], unit)
  input.addEventListener('focus', () => input.select())
  row.append(caption, input)
  return { row, input }
}

function fieldText(input: HTMLInputElement): string {
  if (input.validity.badInput) return ''
  return input.value
}

function marginPoint(text: string, original: number, unit: PageUnit): number | null {
  if (text === formatMargin(original, unit)) return original
  if (text.trim() === '') return null
  const value = Number(text)
  if (!Number.isFinite(value)) return null
  const inches = unit === 'cm' ? value / CM_PER_INCH : value
  return Math.round(inches * PT_PER_INCH * 20) / 20
}

function trimFixed(text: string): string {
  return text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
}

function asPt(value: number): Pt {
  return value as Pt
}

function samePage(page: PageSetup, original: PageSetup): boolean {
  const margin = page.margin
  const had = original.margin
  return page.widthPt === original.widthPt
    && page.heightPt === original.heightPt
    && margin.top === had.top
    && margin.right === had.right
    && margin.bottom === had.bottom
    && margin.left === had.left
    && margin.header === had.header
    && margin.footer === had.footer
    && margin.gutter === had.gutter
}
