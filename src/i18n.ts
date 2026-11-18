import en from './locales/en.ts'
import zh from './locales/zh.ts'

type Catalog = Record<string, string>

const catalogs: Record<string, Catalog> = { en, zh }
const available = Object.keys(catalogs)

function matchTag(tag: string, known: readonly string[]): string | null {
  if (tag.length === 0) return null
  if (known.includes(tag)) return tag
  try {
    const { language } = new Intl.Locale(tag)
    if (known.includes(language)) return language
  } catch {
    return null
  }
  return null
}

/**
 * `?lang=` overrides the system language so an end-to-end script can open the other locale without a settings change.
 * An unknown tag falls through to the system language, then English.
 */
export function selectLocale(query: string, language: string, known: readonly string[] = available): string {
  const requested = new URLSearchParams(query).get('lang')
  if (requested) {
    const picked = matchTag(requested, known)
    if (picked) return picked
  }
  return matchTag(language, known) ?? 'en'
}

function pageQuery(): string {
  if (typeof location === 'undefined') return ''
  try {
    return location.search
  } catch {
    return ''
  }
}

function pageLanguage(): string {
  if (typeof navigator === 'undefined') return 'en'
  try {
    return navigator.language || 'en'
  } catch {
    return 'en'
  }
}

export const locale = selectLocale(pageQuery(), pageLanguage())
const messages: Catalog = { ...en, ...(catalogs[locale] ?? en) }

export function t(key: string, values: Record<string, string | number> = {}): string {
  const text = messages[key] ?? key
  return text.replace(/\{(\w+)\}/g, (all, name) => {
    const value = values[name]
    return value === undefined ? all : String(value)
  })
}

export function translate(root: ParentNode = document): void {
  document.documentElement.lang = locale
  for (const element of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = element.dataset.i18n
    if (key !== undefined) element.textContent = t(key)
  }
}
