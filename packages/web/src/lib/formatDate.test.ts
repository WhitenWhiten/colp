import { describe, expect, it } from 'vitest'
import {
  formatCalendarDate,
  formatClockTime,
  formatCompactDateTime,
  formatDate,
  formatLongDate,
  formatWeekdayDate,
  formatWeekdayShortDate,
} from './formatDate'

describe('formatDate locale', () => {
  it('formats calendar dates in English regardless of the runtime locale', () => {
    const date = new Date(2026, 7, 18)
    expect(formatWeekdayDate(date)).toBe('Tuesday · August 18')
    expect(formatWeekdayShortDate(date)).toBe('Tue, Aug 18')
    expect(formatLongDate(date)).toBe('Tuesday, August 18')
    expect(formatDate('2026-08-18T12:00:00.000Z')).toBe('Aug 18, 2026')
    expect(formatClockTime(new Date(2026, 7, 18, 15, 4))).toMatch(/3:04/)
  })

  it('omits the year from compact date-times used in notification rows', () => {
    const formatted = formatCompactDateTime('2026-08-19T14:56:00.000Z')
    expect(formatted).not.toMatch(/2026/)
    expect(formatted).toMatch(/Aug/)
    expect(formatted).toMatch(/\d{1,2}:\d{2}/)
  })

  it('formats a UTC-midnight calendar day in UTC so the day never shifts', () => {
    expect(formatCalendarDate('2026-09-14T00:00:00.000Z')).toBe('Sep 14, 2026')
    const previous = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    try { expect(formatCalendarDate('2026-09-14T00:00:00.000Z')).toBe('Sep 14, 2026') } finally { process.env.TZ = previous }
  })
})
