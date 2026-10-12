/**
 * Date display convention:
 * - Dates in rows and heads: formatDate.
 * - A moment with its time (agent activity): formatDateTime.
 * - Timestamps that may be missing (history, sync, approvals): formatMediumInstant.
 * - "When did this last happen" on a live list (agents): formatRelative.
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

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", then the date. */
export function formatRelative(value: string, now: number = Date.now()): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  const seconds = Math.round((now - date.valueOf()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return formatDate(value)
}
