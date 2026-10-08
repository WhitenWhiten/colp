const RETURN_TO_FALLBACK = '/library'

/**
 * Same-origin callback-URL guard mirroring authClient.assertSafeCallbackUrl
 * semantics: a relative path or an absolute URL on the product origin,
 * normalized to `path?query#hash`. Anything else falls back before any
 * network call or navigation.
 *
 * The output is validated, not only the input: `https://<origin>//evil.com`,
 * `https://<origin>/\evil.com` and `https:<host>//evil.com` all parse to a
 * `//evil.com` path, which a browser reads as protocol-relative (R15-20).
 *
 * One implementation: every auth page imports this helper.
 */
export function safeReturnTo(raw: string | null, fallback = RETURN_TO_FALLBACK): string {
  if (!raw || raw.length > 2048 || /[\u0000-\u001f\u007f\\]/u.test(raw)) return fallback
  const loc = (globalThis as { location?: { origin?: string } }).location
  const origin = typeof loc?.origin === 'string' && loc.origin ? loc.origin : ''
  if (!origin || origin === 'null') return fallback
  let url: URL
  try {
    url = new URL(raw, origin)
  } catch {
    return fallback
  }
  if (url.origin !== origin || url.username || url.password) return fallback
  const out = `${url.pathname}${url.search}${url.hash}`
  return out.startsWith('/') && !out.startsWith('//') ? out : fallback
}
