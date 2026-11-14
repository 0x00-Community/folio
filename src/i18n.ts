import en from './locales/en.ts'
import zh from './locales/zh.ts'

type Catalog = Record<string, string>

const catalogs: Record<string, Catalog> = { en, zh }

function pick(tag: string): string {
  if (tag in catalogs) return tag
  try {
    const { language } = new Intl.Locale(tag)
    if (language in catalogs) return language
  } catch {}
  return 'en'
}

export const locale = pick(navigator.language)
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
