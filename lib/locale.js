export const LOCALE_SETTINGS = Object.freeze(['system', 'zh-CN', 'en-US'])

export function normalizeLocaleSetting(value) {
  return LOCALE_SETTINGS.includes(value) ? value : 'system'
}

export function resolveLocale(value) {
  const setting = normalizeLocaleSetting(value)
  if (setting !== 'system') return setting
  const detected = Intl.DateTimeFormat().resolvedOptions().locale || process.env.LANG || 'en-US'
  return String(detected).toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

export function tr(locale, zh, en) {
  return resolveLocale(locale) === 'zh-CN' ? zh : en
}
