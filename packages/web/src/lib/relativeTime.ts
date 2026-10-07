import { DATE_LOCALE, formatDate } from './formatDate'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

/** Compact relative timestamps for community rows (comments): "just now"
    under a minute, then 5m / 3h / 2d; anything older than a week falls
    back to the date — same year drops the year, older keeps it. */
export function formatRelativeTime(value: string, now: Date = new Date()): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  const elapsed = now.getTime() - date.getTime()
  if (elapsed < MINUTE) return 'just now'
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`
  if (elapsed < WEEK) return `${Math.floor(elapsed / DAY)}d`
  if (date.getFullYear() === now.getFullYear()) {
    return new Intl.DateTimeFormat(DATE_LOCALE, { month: 'short', day: 'numeric' }).format(date)
  }
  return formatDate(value)
}
