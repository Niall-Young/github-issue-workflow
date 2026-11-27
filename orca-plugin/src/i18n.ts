import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type Locale = 'es' | 'en' | 'zh'

let overrideLocale: Locale | null = null
let cachedPrefsLocale: Locale | undefined

export function getUiPrefsPath(home = homedir()): string {
  return join(home, '.local', 'share', 'orca-autopilot', 'ui-prefs.json')
}

export function normalizeLocaleTag(raw: string | undefined | null): Locale | null {
  if (!raw) return null
  const lower = raw.trim().toLowerCase()
  if (!lower) return null
  if (lower === 'es' || lower.startsWith('es-') || lower.startsWith('es_') || lower === 'español' || lower === 'espanol' || lower === 'spanish') {
    return 'es'
  }
  if (lower === 'en' || lower.startsWith('en-') || lower.startsWith('en_') || lower === 'english' || lower === 'ingles' || lower === 'inglés') {
    return 'en'
  }
  if (lower === 'zh' || lower.startsWith('zh-') || lower.startsWith('zh_') || lower === 'chinese' || lower === '中文' || lower === 'chino') {
    return 'zh'
  }
  return null
}

function isAutomatedTestRuntime(): boolean {
  if (process.env.NODE_ENV === 'test' || process.env.BUN_ENV === 'test') return true
  if (Array.isArray(process.argv) && process.argv.some((a) => /\.test\.[cm]?[jt]s$/i.test(a) || a === 'test')) {
    return true
  }
  return false
}

export function readSavedLocale(home = homedir()): Locale | null {
  try {
    const p = getUiPrefsPath(home)
    if (!existsSync(p)) return null
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as { lang?: string }
    return normalizeLocaleTag(parsed.lang)
  } catch {
    return null
  }
}

export function saveLocalePreference(locale: Locale, home = homedir()): void {
  overrideLocale = locale
  cachedPrefsLocale = locale
  try {
    const p = getUiPrefsPath(home)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, `${JSON.stringify({ lang: locale }, null, 2)}\n`, 'utf8')
  } catch {
    // ignore disk write errors in read-only sandboxes
  }
}

export function setLocale(locale: Locale | null): void {
  overrideLocale = locale
}

export function getLocale(): Locale {
  if (overrideLocale) return overrideLocale

  const envLang = normalizeLocaleTag(process.env.ORCA_AUTOPILOT_LANG)
  if (envLang) return envLang

  if (isAutomatedTestRuntime()) {
    return 'zh'
  }

  if (cachedPrefsLocale === undefined) {
    cachedPrefsLocale = readSavedLocale() ?? undefined
  }
  if (cachedPrefsLocale) return cachedPrefsLocale

  const sysEnv =
    normalizeLocaleTag(process.env.LC_ALL) ||
    normalizeLocaleTag(process.env.LANG) ||
    normalizeLocaleTag(Intl.DateTimeFormat().resolvedOptions().locale)

  return sysEnv ?? 'en'
}

export function pick<T>(variants: { es: T; en: T; zh: T }, locale = getLocale()): T {
  return variants[locale]
}
