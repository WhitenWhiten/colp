export const PAGE_META_DESCRIPTION_MAX = 500

const CONTROL_OR_NEWLINE = /[\u0000-\u001F\u007F]/gu

/** Normalizes dynamic text before it becomes a description attribute value. */
export function normalizePageMetaText(
  value: string,
  maxLength = PAGE_META_DESCRIPTION_MAX,
): string {
  return value
    .replace(CONTROL_OR_NEWLINE, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength)
}
