import { describe, expect, it } from 'vitest'
import {
  canReviewDuplicates,
  classifyLinkHealthDisplay,
  isCannotProbe,
} from './classify'

describe('link-health display classification', () => {
  it('keeps pending, healthy, and redirect as stored statuses', () => {
    expect(classifyLinkHealthDisplay({ status: 'pending' }).kind).toBe('pending')
    expect(classifyLinkHealthDisplay({ status: 'healthy' }).kind).toBe('healthy')
    expect(classifyLinkHealthDisplay({ status: 'redirect' }).label).toBe('Redirected')
  })

  it('does not display timeout, denied, dns, or TLS/network http as broken', () => {
    for (const errorClass of ['timeout', 'denied', 'dns'] as const) {
      const display = classifyLinkHealthDisplay({ status: 'broken', errorClass })
      expect(display.kind).toBe('check_failed')
      expect(display.label).toBe('Could not check')
      expect(isCannotProbe({ status: 'broken', errorClass })).toBe(true)
    }
    const tls = classifyLinkHealthDisplay({ status: 'broken', errorClass: 'http' })
    expect(tls.kind).toBe('check_failed')
    expect(tls.label).not.toMatch(/broken/i)
  })

  it('classifies 4xx as broken and 5xx as a remote error', () => {
    expect(classifyLinkHealthDisplay({ status: 'broken', errorClass: 'http', httpStatus: 404 }))
      .toEqual({ kind: 'broken', label: 'Broken' })
    expect(classifyLinkHealthDisplay({ status: 'broken', errorClass: 'http', httpStatus: 503 }))
      .toEqual({ kind: 'remote_error', label: 'Remote error' })
    expect(classifyLinkHealthDisplay({ status: 'broken', errorClass: 'invalid_url' }).kind).toBe('broken')
  })

  it('treats stored broken without httpStatus as cannot-probe for N-1 payloads', () => {
    const display = classifyLinkHealthDisplay({ status: 'broken' })
    expect(display.kind).toBe('check_failed')
    expect(isCannotProbe({ status: 'broken' })).toBe(true)
  })

  it('hides review actions from viewers', () => {
    expect(canReviewDuplicates({ membership: 'viewer' })).toBe(false)
    expect(canReviewDuplicates({ membership: 'editor' })).toBe(true)
    expect(canReviewDuplicates({ membership: 'owner' })).toBe(true)
    expect(canReviewDuplicates({})).toBe(true)
  })
})
