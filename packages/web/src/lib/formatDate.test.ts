import { describe, expect, it } from 'vitest'
import { formatDate, formatDateTime, formatMediumInstant } from './formatDate'

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
