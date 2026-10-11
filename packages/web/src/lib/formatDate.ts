/**
 * Date display convention:
 * - Dates in rows and heads: formatDate.
 * - A moment with its time (agent activity): formatDateTime.
 * - Timestamps that may be missing (history, sync, approvals): formatMediumInstant.
 *
 * Product chrome is English. Always format in en-US so the browser locale cannot inject mixed-language dates.
 */
const DATE_LOCALE = 'en-US'

export function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat(DATE_LOCALE, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date)
}

export function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat(DATE_LOCALE, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

export function formatMediumInstant(value: string | null): string {
  if (!value) return 'Never'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unavailable'
  return new Intl.DateTimeFormat(DATE_LOCALE, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}
