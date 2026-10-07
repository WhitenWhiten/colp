// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { hostLetter } from '../components/DomainMark'
import { bookmarkIconSrc, type BookmarkIconInput } from './bookmarkIcon'
import { hostInitial } from './libraryTree'

const OBJECT_ID = '01234567-89ab-4cde-8f01-23456789abcd'
const HTTPS_OBJECT = `https://known.example/api/v1/favicon/${OBJECT_ID}`
const GITHUB = 'https://github.com/x'
const GITHUB_CDN = 'https://a.favicon.im/github.com?throw-error-on-404=true'
const WWW_GITHUB_CDN = 'https://a.favicon.im/www.github.com?throw-error-on-404=true'

function cdnAllowed(
  input: Omit<BookmarkIconInput, 'faviconCdnAllowed'> & { faviconCdnAllowed?: unknown },
) {
  return bookmarkIconSrc(input as BookmarkIconInput)
}

describe('bookmarkIconSrc', () => {
  it('lets a valid object iconUrl win over CDN even when the flag is true', () => {
    expect(bookmarkIconSrc({
      iconUrl: HTTPS_OBJECT,
      pageUrl: GITHUB,
      faviconCdnAllowed: true,
    })).toEqual({ kind: 'object', src: HTTPS_OBJECT })
  })

  it('treats absent, false, and the string "true" as no CDN', () => {
    expect(bookmarkIconSrc({ pageUrl: GITHUB })).toEqual({ kind: 'letter' })
    expect(bookmarkIconSrc({
      iconUrl: HTTPS_OBJECT,
      pageUrl: GITHUB,
    })).toEqual({ kind: 'object', src: HTTPS_OBJECT })
    expect(bookmarkIconSrc({
      pageUrl: GITHUB,
      faviconCdnAllowed: false,
    })).toEqual({ kind: 'letter' })
    expect(cdnAllowed({
      pageUrl: GITHUB,
      faviconCdnAllowed: 'true',
    })).toEqual({ kind: 'letter' })
    expect(cdnAllowed({
      pageUrl: GITHUB,
      faviconCdnAllowed: undefined,
    })).toEqual({ kind: 'letter' })
  })

  it('hotlinks the exact a.favicon.im URL with throw-error-on-404 when allowed', () => {
    const src = bookmarkIconSrc({ pageUrl: GITHUB, faviconCdnAllowed: true })
    expect(src).toEqual({ kind: 'cdn', src: GITHUB_CDN })
    expect(src).not.toEqual({ kind: 'cdn', src: 'https://favicon.im/github.com' })
    expect(src).not.toEqual({ kind: 'cdn', src: 'https://a.favicon.im/github.com' })
    expect(JSON.stringify(src)).not.toMatch(/duckduckgo/i)
    expect(JSON.stringify(src)).not.toMatch(/icons\.duckduckgo\.com/)
  })

  it('does not strip www. from the CDN hostname key', () => {
    expect(bookmarkIconSrc({
      pageUrl: 'https://www.github.com/know-n/web',
      faviconCdnAllowed: true,
    })).toEqual({ kind: 'cdn', src: WWW_GITHUB_CDN })
  })

  it('rejects localhost and reserved suffixes for CDN', () => {
    const hosts = [
      'http://localhost/app',
      'https://LOCALHOST/app',
      'http://foo.local/x',
      'https://printer.localhost/x',
      'https://jira.internal/browse/1',
      'https://wiki.corp/home',
      'https://nas.home/share',
      'https://router.lan/status',
      'https://files.intranet/doc',
    ]
    for (const pageUrl of hosts) {
      expect(bookmarkIconSrc({ pageUrl, faviconCdnAllowed: true }), pageUrl).toEqual({ kind: 'letter' })
    }
  })

  it('rejects literal IPv4, IPv6, and alternate numeric forms and never emits %3A CDN URLs', () => {
    const hosts = [
      'http://127.0.0.1/',
      'https://8.8.8.8/lookup',
      'http://127.1/',
      'http://2130706433/',
      'http://0x7f000001/',
      'http://[::1]/',
      'http://[2001:db8::1]/path',
      'http://[::ffff:127.0.0.1]/',
    ]
    for (const pageUrl of hosts) {
      const result = bookmarkIconSrc({ pageUrl, faviconCdnAllowed: true })
      expect(result, pageUrl).toEqual({ kind: 'letter' })
      expect(JSON.stringify(result)).not.toMatch(/%3A/i)
      expect(JSON.stringify(result)).not.toMatch(/favicon\.im/i)
    }
  })

  it('treats a non-product iconUrl as missing rather than as an object img', () => {
    expect(bookmarkIconSrc({
      iconUrl: 'https://github.com/favicon.ico',
      pageUrl: GITHUB,
      faviconCdnAllowed: true,
    })).toEqual({ kind: 'cdn', src: GITHUB_CDN })
    expect(bookmarkIconSrc({
      iconUrl: 'https://cdn.example/logo.png',
      pageUrl: GITHUB,
      faviconCdnAllowed: false,
    })).toEqual({ kind: 'letter' })
    expect(bookmarkIconSrc({
      iconUrl: 'https://a.favicon.im/github.com?throw-error-on-404=true',
      pageUrl: GITHUB,
      faviconCdnAllowed: false,
    })).toEqual({ kind: 'letter' })
    expect(bookmarkIconSrc({
      iconUrl: `https://known.example/api/v1/favicon/not-a-uuid`,
      pageUrl: GITHUB,
      faviconCdnAllowed: true,
    })).toEqual({ kind: 'cdn', src: GITHUB_CDN })
    expect(bookmarkIconSrc({
      iconUrl: `http://evil.example/api/v1/favicon/${OBJECT_ID}`,
      faviconCdnAllowed: false,
    })).toEqual({ kind: 'letter' })
    const sameOrigin = `${window.location.origin}/api/v1/favicon/${OBJECT_ID}`
    expect(bookmarkIconSrc({
      iconUrl: sameOrigin,
      faviconCdnAllowed: false,
    })).toEqual({ kind: 'object', src: sameOrigin })
  })

  it('accepts punycode DNS names for CDN and keeps letter kind free of a glyph', () => {
    const src = bookmarkIconSrc({
      pageUrl: 'https://xn--fsq.com/path',
      faviconCdnAllowed: true,
    })
    expect(src).toEqual({
      kind: 'cdn',
      src: 'https://a.favicon.im/xn--fsq.com?throw-error-on-404=true',
    })
    expect(bookmarkIconSrc({ faviconCdnAllowed: true })).toEqual({ kind: 'letter' })
    expect(bookmarkIconSrc({ pageUrl: 'ftp://github.com/x', faviconCdnAllowed: true })).toEqual({ kind: 'letter' })
  })
})

describe('CDN hostname key vs letter keys', () => {
  it('does not collapse hostInitial, hostLetter, and the CDN host into one function', () => {
    expect(hostInitial('www.example.com')).toBe('E')
    expect(hostInitial('')).toBe('#')
    expect(hostLetter('')).toBe('·')
    expect(hostLetter('www.github.com')).toBe('G')
    expect(hostInitial('www.github.com')).toBe('G')
    const cdn = bookmarkIconSrc({
      pageUrl: 'https://www.github.com/x',
      faviconCdnAllowed: true,
    })
    expect(cdn).toEqual({ kind: 'cdn', src: WWW_GITHUB_CDN })
    expect(cdn).not.toEqual({ kind: 'letter' })
  })
})
