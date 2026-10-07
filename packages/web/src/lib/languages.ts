const LANGUAGE_NAMES = typeof Intl.DisplayNames === 'function'
  ? new Intl.DisplayNames(['en'], { type: 'language' })
  : null

/** Human-readable language name for a BCP tag ('en' → 'English');
   falls back to the raw tag for nonstandard values. */
export function languageLabel(tag: string): string {
  try {
    return LANGUAGE_NAMES?.of(tag) ?? tag
  } catch {
    return tag
  }
}

/** Catalog languages offered by the collection and digest settings (BCP 47
    primary tags). A stored tag outside the list is still shown as-is. */
export const CATALOG_LANGUAGES = ['en', 'zh', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'ru', 'it'] as const

export function catalogLanguageOptions(current: string): Array<{ value: string; label: string }> {
  const known: readonly string[] = CATALOG_LANGUAGES
  return [
    { value: '', label: 'Not set' },
    ...CATALOG_LANGUAGES.map((tag) => ({ value: tag, label: languageLabel(tag) })),
    ...(current && !known.includes(current) ? [{ value: current, label: languageLabel(current) }] : []),
  ]
}
