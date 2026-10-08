// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { safeReturnTo } from './safeReturnTo'

describe('safeReturnTo', () => {
  const origin = window.location.origin
  const host = window.location.host

  it('keeps same-origin paths and absolute URLs as path, query and hash', () => {
    expect(safeReturnTo('/c/reading?view=list#top')).toBe('/c/reading?view=list#top')
    expect(safeReturnTo(`${origin}/settings#security`)).toBe('/settings#security')
  })

  it('uses the given fallback', () => {
    expect(safeReturnTo(null, '/onboarding')).toBe('/onboarding')
    expect(safeReturnTo('https://evil.example/', '/onboarding')).toBe('/onboarding')
  })

  it('rejects inputs whose normalized path is protocol-relative (R15-20)', () => {
    expect(safeReturnTo(`${origin}//evil.com`)).toBe('/library')
    expect(safeReturnTo(`${origin}/\\evil.com`)).toBe('/library')
    expect(safeReturnTo('/.//evil.com')).toBe('/library')
    expect(safeReturnTo('//evil.com')).toBe('/library')
    // Resolved against the origin, `https:<host>//evil.com` is a plain
    // same-origin path, never a `//` one.
    const schemeRelative = safeReturnTo(`${window.location.protocol}${host}//evil.com`)
    expect(schemeRelative.startsWith('/') && !schemeRelative.startsWith('//')).toBe(true)
  })

  it('rejects foreign origins, credentials, control characters and oversize input', () => {
    expect(safeReturnTo('https://evil.example/steal')).toBe('/library')
    expect(safeReturnTo(`${window.location.protocol}//user:pw@${host}/x`)).toBe('/library')
    expect(safeReturnTo('/a\u0000b')).toBe('/library')
    expect(safeReturnTo('javascript:alert(1)')).toBe('/library')
    expect(safeReturnTo(`/${'a'.repeat(2048)}`)).toBe('/library')
  })
})
