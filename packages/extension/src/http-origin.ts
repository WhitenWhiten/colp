/**
 * Plain-HTTP server origins. COLP allows http:// only on loopback
 * (localhost, 127.0.0.1, [::1]); COLP Server refuses to start with any other
 * http:// origin, and a home network uses https:// with the server's
 * tls-internal profile (D26). A loopback origin needs one confirmation.
 * The English matches the options page `t()` calls.
 */
export const HTTP_ORIGIN_UNENCRYPTED_WARNING =
  'This server uses plain HTTP. Credentials and bookmarks travel unencrypted.';

export const HTTP_ORIGIN_REFUSED =
  'Plain HTTP works only for a server on this computer (localhost, 127.0.0.1, [::1]). On a home network, use https:// with the server\'s tls-internal profile.';

export type HttpOriginConfirmation = 'https' | 'loopback' | 'refused';

/** Whether an exact origin can be saved, and whether it needs the HTTP warning first. */
export function httpOriginConfirmation(origin: string): HttpOriginConfirmation {
  const url = new URL(origin);
  if (url.protocol === 'https:') return 'https';
  if (url.protocol !== 'http:') throw new TypeError('Server origin must be HTTP or HTTPS');
  return isLoopbackHttpHost(url.hostname) ? 'loopback' : 'refused';
}

/** The three loopback names the COLP schema accepts. `URL.hostname` keeps IPv6 brackets. */
export function isLoopbackHttpHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}
