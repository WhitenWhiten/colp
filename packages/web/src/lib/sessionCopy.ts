import { productName } from './edition'

/**
 * When the session check runs again after the server rate-limited it, from
 * its Retry-After. Rounded, because the text is shown once and does not tick.
 */
export function busyRetryWhen(seconds: number): string {
  if (seconds <= 5) return 'in a few seconds'
  if (seconds < 60) return 'in under a minute'
  const minutes = Math.ceil(seconds / 60)
  return minutes === 1 ? 'in about a minute' : `in about ${minutes} minutes`
}

/** The toast and status line while the server asks this browser to wait. */
export function serverBusyLine(seconds: number): string {
  return `${productName()} is busy. Checking your session again ${busyRetryWhen(seconds)}.`
}
