export type BookmarkIconSrc =
  | { kind: 'object'; src: string }
  | { kind: 'cdn'; src: string }
  | { kind: 'letter' }

export type BookmarkIconInput = {
  iconUrl?: string | null
  pageUrl?: string | null
  faviconCdnAllowed?: boolean | null
}

const FAVICON_PATH = /^\/api\/v1\/favicon\/[a-fA-F0-9-]{36}$/
const RESERVED_SUFFIXES = [
  '.local',
  '.localhost',
  '.internal',
  '.corp',
  '.home',
  '.lan',
  '.intranet',
] as const
const CDN_HOST_SAFE = /[A-Za-z0-9.-]/
const INTEGER_IPV4 = /^(?:0|[1-9]\d{0,9})$/
const HEX_IPV4 = /^0x[0-9a-f]{1,8}$/i
const IPV4_OCTET = /^(?:0|[1-9]\d*|0[0-7]+|0x[0-9a-f]+)$/i

function isProductFaviconObjectUrl(iconUrl: unknown): iconUrl is string {
  if (typeof iconUrl !== 'string' || iconUrl.length === 0 || iconUrl.length > 2048) {
    return false
  }
  try {
    const url = new URL(iconUrl)
    if (url.username !== '' || url.password !== '') return false
    if (!FAVICON_PATH.test(url.pathname)) return false
    if (typeof window !== 'undefined' && url.origin === window.location.origin) return true
    return url.protocol === 'https:'
  } catch {
    return false
  }
}

function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1)
  }
  return hostname
}

function isLiteralIpHostname(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname)
  if (host.includes(':')) return true
  if (INTEGER_IPV4.test(host)) {
    const value = Number(host)
    if (Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff) return true
  }
  if (HEX_IPV4.test(host)) return true
  const parts = host.split('.')
  if (parts.length >= 2 && parts.length <= 4 && parts.every((part) => IPV4_OCTET.test(part))) {
    return true
  }
  return false
}

function isReservedHotlinkHost(hostname: string): boolean {
  const folded = hostname.replace(/\.+$/u, '').toLowerCase()
  if (!folded || folded === 'localhost') return true
  return RESERVED_SUFFIXES.some((suffix) => folded.endsWith(suffix))
}

function encodeCdnHostname(hostname: string): string {
  let encoded = ''
  for (const char of hostname) {
    if (CDN_HOST_SAFE.test(char)) {
      encoded += char
      continue
    }
    const bytes = new TextEncoder().encode(char)
    for (const byte of bytes) {
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return encoded
}

function cdnFaviconSrc(pageUrl: unknown): string | null {
  if (typeof pageUrl !== 'string' || pageUrl.length === 0) return null
  let url: URL
  try {
    url = new URL(pageUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const hostname = url.hostname
  if (!hostname) return null
  if (isLiteralIpHostname(hostname)) return null
  if (isReservedHotlinkHost(hostname)) return null
  return `https://a.favicon.im/${encodeCdnHostname(hostname)}?throw-error-on-404=true`
}

export function bookmarkIconSrc(input: BookmarkIconInput = {}): BookmarkIconSrc {
  if (isProductFaviconObjectUrl(input.iconUrl)) {
    return { kind: 'object', src: input.iconUrl }
  }
  if (input.faviconCdnAllowed === true) {
    const src = cdnFaviconSrc(input.pageUrl)
    if (src) return { kind: 'cdn', src }
  }
  return { kind: 'letter' }
}

/**
 * The icon the account's online favicon provider serves for a page, resolved
 * the way the server resolves it: one {hostname} marker, an https result, and
 * no literal-IP or reserved hosts on either side. A host without a dot (a URL
 * still being typed) has no icon yet.
 */
export function providerFaviconSrc(template: string, pageUrl: string): string | null {
  if (template.length === 0 || template.length > 2048 || template.split('{hostname}').length !== 2) return null
  let page: URL
  try {
    page = new URL(pageUrl)
  } catch {
    return null
  }
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return null
  const hostname = page.hostname.toLowerCase()
  if (!hostname.includes('.') || isLiteralIpHostname(hostname) || isReservedHotlinkHost(hostname)) return null
  let target: URL
  try {
    target = new URL(template.replace('{hostname}', hostname))
  } catch {
    return null
  }
  if (target.protocol !== 'https:' || target.username !== '' || target.password !== '' || target.hash !== '') return null
  if (isLiteralIpHostname(target.hostname) || isReservedHotlinkHost(target.hostname)) return null
  return target.toString()
}
