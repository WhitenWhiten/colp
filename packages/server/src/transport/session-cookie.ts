import type { FastifyReply, FastifyRequest } from 'fastify';

export const SESSION_COOKIE_NAME = '__Host-known_session';
export const INSECURE_SESSION_COOKIE_NAME = 'known_session';

function insecureHttp(): boolean {
  return process.env.COLP_INSECURE_HTTP === 'true';
}

/** TLS writes `__Host-known_session` with Secure. Plain HTTP writes `known_session` without Secure. */
export function writtenSessionCookieName(): string {
  return insecureHttp() ? INSECURE_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME;
}

/** Build Set-Cookie for the product session cookie (never sets Domain). */
export function buildSessionSetCookie(
  rawToken: string,
  options: { readonly maxAgeSeconds: number; readonly clear?: boolean } = { maxAgeSeconds: 0 },
): string {
  const name = writtenSessionCookieName();
  const secure = name === SESSION_COOKIE_NAME ? 'Secure; ' : '';
  if (options.clear) {
    return `${name}=; Path=/; HttpOnly; ${secure}SameSite=Lax; Max-Age=0`;
  }
  // __Host- prefix requires Secure, Path=/, no Domain. known_session omits Secure.
  return [
    `${name}=${encodeURIComponent(rawToken)}`,
    'Path=/',
    'HttpOnly',
    ...(name === SESSION_COOKIE_NAME ? ['Secure'] : []),
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
  ].join('; ');
}

export type SessionCookieParseResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly raw: string }
  | { readonly kind: 'parse-error' };

/**
 * Parse the full Cookie field (FIX-L-003): the session cookie name is
 * case-sensitive and must occur exactly once. 0 occurrences -> absent;
 * >1 occurrences or malformed percent-encoding of its value -> parse-error,
 * which product admission maps to 400 so ambiguous cookies fail closed.
 * Manual parse: only our cookie name; avoid depending on @fastify/cookie.
 */
/**
 * Each mode reads only the name it writes. Cookies ignore the port, so on
 * http://localhost another app's `__Host-known_session` reaches this server;
 * accepting both names would turn that into a 400 on every request.
 */
function acceptedSessionCookieNames(): ReadonlySet<string> {
  return new Set([writtenSessionCookieName()]);
}

export function parseSessionCookieField(header: string): SessionCookieParseResult {
  const accepted = acceptedSessionCookieNames();
  let raw: string | null = null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const name = trimmed.slice(0, eq).trim();
    if (!accepted.has(name)) continue;
    if (raw !== null) return { kind: 'parse-error' };
    try {
      raw = decodeURIComponent(trimmed.slice(eq + 1));
    } catch {
      return { kind: 'parse-error' };
    }
  }
  return raw === null ? { kind: 'absent' } : { kind: 'present', raw };
}

export function readSessionCookie(request: FastifyRequest): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  const parsed = parseSessionCookieField(header);
  // Product admission rejects parse errors with 400 before any handler runs;
  // failing closed as absent here keeps ambiguous cookies unauthenticated.
  return parsed.kind === 'present' ? parsed.raw : null;
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.header('Set-Cookie', buildSessionSetCookie('', { maxAgeSeconds: 0, clear: true }));
}

export function setSessionCookie(
  reply: FastifyReply,
  rawToken: string,
  absoluteExpiresAt: Date,
  now: Date = new Date(),
): void {
  const maxAgeSeconds = Math.max(
    0,
    Math.floor((absoluteExpiresAt.getTime() - now.getTime()) / 1000),
  );
  reply.header('Set-Cookie', buildSessionSetCookie(rawToken, { maxAgeSeconds }));
}
