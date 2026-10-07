/**
 * FO-02 favicon fetch policy (pure functions; no I/O).
 *
 * The favicon chain resolves the account provider template against the
 * bookmark hostname and fetches through hardened egress. This module owns the
 * favicon-specific constraints the contract requires on top of the shared
 * egress checks:
 *
 * - the resolved fetch URL must be HTTPS with a DNS hostname (never a literal
 *   IP as the target, no userinfo, no fragment, port omitted or 443) and the
 *   template must contain exactly one `{hostname}` in the path;
 * - the bookmark hostname is normalized before substitution (lowercase, no
 *   trailing dot, no userinfo, no zone) and the substituted path segment is a
 *   single safe path segment so the URL always parses;
 * - private/reserved hosts and hostnames are rejected fail-closed at enqueue;
 *   hardened egress revalidates DNS, every redirect hop and the connector at
 *   fetch time, so this pre-check is authorization, not a replaceable gate.
 *
 * Failure classification maps transport/egress errors to the wire `IconJob`
 * error reasons (fetch_failed / unsafe_source / invalid_image).
 */
import { isIP } from 'node:net';

export const FAVICON_FETCH_USER_AGENT = 'Known-Favicon/1';
export const FAVICON_MAX_DECOMPRESSED_RATIO = 64;

/**
 * Reserved host suffix / literal forms that must never be the target of a
 * favicon fetch. This mirrors the hardened egress address classification for
 * the hostname layer (loopback, RFC1918, link-local, metadata, localhost and
 * reserved private suffixes all fail closed).
 */
const RESERVED_HOST_SUFFIXES = Object.freeze([
  '.local',
  '.localhost',
  '.internal',
  '.corp',
  '.home',
  '.lan',
  '.intranet',
  '.test',
  '.example',
  '.invalid',
  '.onion',
] as const);

const INTEGER_IPV4 = /^(?:0|[1-9]\d{0,9})$/u;
const HEX_IPV4 = /^0x[0-9a-f]{1,8}$/iu;
const IPV4_OCTET = /^(?:0|[1-9]\d*|0[0-7]+|0x[0-9a-f]+)$/iu;

function stripIpv6Brackets(hostname: string): string {
  const trimmed = hostname.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1);
  return trimmed;
}

/**
 * Literal IP hostname detection (IPv4 decimal/hex/octal, IPv6 incl. mapped
 * forms). `isIP` from node:net catches canonical forms; the extra patterns
 * catch the alternate encodings the URL parser also accepts.
 */
export function isFaviconLiteralIpHostname(hostname: string): boolean {
  if (typeof hostname !== 'string' || hostname.length === 0) return false;
  const host = stripIpv6Brackets(hostname).toLowerCase().split('%')[0] ?? '';
  if (host.includes(':')) return isIP(host) !== 0;
  if (INTEGER_IPV4.test(host)) {
    const value = Number(host);
    if (Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff) return true;
  }
  if (HEX_IPV4.test(host)) return true;
  const parts = host.split('.');
  return parts.length >= 2 && parts.length <= 4 && parts.every((part) => IPV4_OCTET.test(part));
}

/** Reserved private/internal hostname (localhost, .internal, .local, bare single-label…). */
export function isFaviconReservedHostname(hostname: string): boolean {
  const folded = hostname.trim().replace(/\.+$/u, '').toLowerCase();
  if (folded.length === 0 || folded === 'localhost') return true;
  // A bare single-label hostname is an intranet/device name, never a public
  // favicon provider target.
  if (!folded.includes('.')) return true;
  return RESERVED_HOST_SUFFIXES.some((suffix) => folded.endsWith(suffix));
}

const HOSTNAME_SEGMENT = /^[A-Za-z0-9._~-]{1,253}$/u;

/**
 * Normalize a bookmark hostname for provider template substitution:
 * lowercase, no IPv6 brackets, no zone, no trailing dot. Returns null for
 * empty, literal-IP or syntactically invalid values; the caller rejects
 * reserved forms separately.
 */
export function normalizeFaviconHostname(hostname: string): string | null {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const zone = host.indexOf('%');
  if (zone !== -1) host = host.slice(0, zone);
  host = host.replace(/\.+$/u, '');
  if (host.length === 0) return null;
  if (isFaviconLiteralIpHostname(host)) return null;
  if (isFaviconReservedHostname(host)) return null;
  if (!HOSTNAME_SEGMENT.test(host)) return null;
  return host;
}

/**
 * Extract the normalized favicon hostname from a bookmark URL. Only absolute
 * http(s) URLs without userinfo qualify (mirrors domain bookmark-url.accept).
 */
export function faviconHostnameFromBookmarkUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.hostname.length < 1) return null;
  return normalizeFaviconHostname(parsed.hostname);
}

/**
 * Resolve the provider template with the normalized bookmark hostname. The
 * contract template regex already constrains the static shape; this is the
 * authorization layer that rejects anything that would fetch a non-HTTPS,
 * non-DNS target. Returns null when the template or hostname is unsafe.
 */
export function resolveFaviconProviderUrl(
  template: string,
  hostname: string,
): string | null {
  if (typeof template !== 'string' || template.length === 0 || template.length > 2048) {
    return null;
  }
  const markerCount = template.split('{hostname}').length - 1;
  if (markerCount !== 1) return null;
  const normalized = normalizeFaviconHostname(hostname);
  if (normalized === null) return null;
  const substituted = template.replace('{hostname}', normalized);
  let parsed: URL;
  try {
    parsed = new URL(substituted);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.hash !== '') return null;
  if (parsed.port !== '' && parsed.port !== '443') return null;
  const target = parsed.hostname.toLowerCase();
  if (isFaviconLiteralIpHostname(target)) return null;
  if (isFaviconReservedHostname(target)) return null;
  if (target.includes('..')) return null;
  return parsed.toString();
}

/**
 * Classify a transport/egress/validation failure into the wire IconJob error
 * reason. Hardened egress denials (URL policy, DNS, address, redirect target)
 * are unsafe_source; timeouts, transport errors and non-2xx responses are
 * fetch_failed. Image/limit failures are invalid_image (set by the caller).
 */
export function classifyFaviconFetchFailure(
  error: unknown,
): 'fetch_failed' | 'unsafe_source' {
  if (error instanceof Error && error.name === 'AbortError') return 'fetch_failed';
  if (isHardenedEgressDenial(error)) return 'unsafe_source';
  return 'fetch_failed';
}

const DENIED_EGRESS_REASONS = new Set([
  'invalid_url',
  'denied',
  'denied_address',
  'dns_failure',
  'redirect_invalid',
]);

function isHardenedEgressDenial(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; reason?: unknown };
  if (candidate.name !== 'HardenedEgressError') return false;
  return typeof candidate.reason === 'string' && DENIED_EGRESS_REASONS.has(candidate.reason);
}

/**
 * Retry scheduling for favicon jobs: `attempts` is 1-based after the first
 * failure; the backoff index is clamped to the last entry. Returns the next
 * attempt time or null when the attempt budget is exhausted.
 */
export function nextFaviconAttemptAt(
  attempts: number,
  maxAttempts: number,
  backoffSeconds: readonly number[],
  now: Date,
): Date | null {
  if (!Number.isInteger(attempts) || attempts < 1) return null;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) return null;
  if (attempts >= maxAttempts) return null;
  const index = Math.min(attempts - 1, backoffSeconds.length - 1);
  const candidate = backoffSeconds[index];
  const delaySeconds = typeof candidate === 'number' && candidate > 0 ? candidate : 1;
  const safeDelay = Number.isFinite(delaySeconds) && delaySeconds > 0 ? delaySeconds : 1;
  return new Date(now.getTime() + safeDelay * 1_000);
}

/** A 2xx fetch response is eligible for image validation. */
export function isFaviconFetchSuccessStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 200 && status < 300;
}