import { describe, expect, it } from 'vitest'
import { formatDate, formatDateTime, formatMediumInstant, formatRelative } from './formatDate'

describe('formatDate locale', () => {
  it('formats dates in English regardless of the runtime locale', () => {
    expect(formatDate('2026-08-18T12:00:00.000Z')).toBe('Aug 18, 2026')
    expect(formatDateTime('2026-08-18T12:00:00.000Z')).toMatch(/^Aug 18, 2026, \d{1,2}:\d{2} [AP]M$/)
  })

  it('names missing and malformed instants instead of printing them', () => {
    expect(formatMediumInstant(null)).toBe('Never')
    expect(formatMediumInstant('not a date')).toBe('Unavailable')
    expect(formatMediumInstant('2026-08-18T12:00:00.000Z')).toMatch(/^Aug 18, 2026/)
    expect(formatDate('not a date')).toBe('not a date')
  })
})

describe('formatRelative', () => {
  const now = Date.parse('2026-10-11T12:00:00Z')
  it('speaks in recent steps, then falls back to the date', () => {
    expect(formatRelative('2026-10-11T11:59:30Z', now)).toBe('just now')
    expect(formatRelative('2026-10-11T11:55:00Z', now)).toBe('5 min ago')
    expect(formatRelative('2026-10-11T09:00:00Z', now)).toBe('3 h ago')
    expect(formatRelative('2026-10-10T10:00:00Z', now)).toBe('yesterday')
    expect(formatRelative('2026-10-07T12:00:00Z', now)).toBe('4 days ago')
    expect(formatRelative('2026-09-01T12:00:00Z', now)).toBe('Sep 1, 2026')
    expect(formatRelative('not a date', now)).toBe('not a date')
  })
})
