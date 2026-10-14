import { describe, expect, it } from 'vitest'
import { formatMicros } from './UsagePanel'

describe('formatMicros', () => {
  it('keeps the reported decimal exactly, without a currency it was not given', () => {
    expect(formatMicros('1250000')).toBe('1.25')
    expect(formatMicros('0')).toBe('0')
    expect(formatMicros('7')).toBe('0.000007')
    expect(formatMicros('123456789012345678901234')).toBe('123456789012345678.901234')
    expect(formatMicros('-1')).toBeNull()
    expect(formatMicros('1.5')).toBeNull()
  })
})
