/**
 * Date display convention:
 * - Timeline/inbox rows (Feed, Notifications, Today): formatCompactDateTime —
 *   no year, so dense rows do not clip the time.
 * - Detail/full pages (history, reports, share): formatDateTime.
 * - Day separators on timelines: formatDate.
 *
 * Product chrome is English. Always format in en-US so the browser locale cannot inject mixed-language dates.
 */
export const DATE_LOCALE = 'en-US'

export function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat(DATE_LOCALE, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date)
}

/**
 * A calendar day stored as UTC midnight (digest coverage periods). Formatted
 * in UTC so the day never shifts with the reader's time zone.
 */
export function formatCalendarDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat(DATE_LOCALE, {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
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

/** Notification/feed timestamps for dense rows — no year, so 390px does not clip PM. */
export function formatCompactDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat(DATE_LOCALE, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

export function formatInstant(value: string | null | undefined, empty = 'Never'): string {
  if (!value) return empty
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return 'Unavailable'
  return formatDateTime(value)
}

export function formatWeekdayDate(date = new Date()): string {
  const weekday = new Intl.DateTimeFormat(DATE_LOCALE, { weekday: 'long' }).format(date)
  const rest = new Intl.DateTimeFormat(DATE_LOCALE, { month: 'long', day: 'numeric' }).format(date)
  return `${weekday} · ${rest}`
}

export function formatWeekdayShortDate(date = new Date()): string {
  return new Intl.DateTimeFormat(DATE_LOCALE, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date)
}

export function formatClockTime(date = new Date()): string {
  return new Intl.DateTimeFormat(DATE_LOCALE, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

export function formatClockTimeWithSeconds(date = new Date()): string {
  return new Intl.DateTimeFormat(DATE_LOCALE, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}

export function formatLongDate(date = new Date()): string {
  return new Intl.DateTimeFormat(DATE_LOCALE, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(date)
}

export function formatTimeZoneName(date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat(DATE_LOCALE, { timeZoneName: 'short' }).formatToParts(date)
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? ''
  } catch {
    return ''
  }
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
