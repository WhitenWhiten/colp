import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const INSIGHT_COOKIE_NAME = '__Host-known_insight';
export const INSIGHT_COOKIE_MAX_AGE_SECONDS = 15552000;

/**
 * Server-minted insight ticket: `<id>.<mac>`.
 *
 * - `id` is 16 CSPRNG bytes as base64url (22 chars; same mint as before).
 * - `mac` is HMAC-SHA-256 over `insight-cookie-ticket|<id>` using
 *   `PUBLISHING_INSIGHTS_VISITOR_HMAC_KEY`, truncated to 32 base64url chars.
 *   The purpose prefix keeps the MAC domain separate from visitor_hash
 *   (`anon|<cookie>`) and the ingest rate-limit subject HMAC.
 * - Total length is 55 characters (bounded 32–64); charset matches mint
 *   (`[A-Za-z0-9_-]` plus one `.` separator).
 *
 * Verification failure, oversize, wrong charset, or an unknown ticket is
 * treated as absent — never as a client-chosen quota identity.
 */
export const INSIGHT_COOKIE_ID_BYTES = 16;
export const INSIGHT_COOKIE_ID_CHARS = 22;
export const INSIGHT_COOKIE_MAC_TRUNCATED_CHARS = 32;
export const INSIGHT_COOKIE_MAC_PURPOSE = 'insight-cookie-ticket|';
export const INSIGHT_COOKIE_TICKET_PATTERN =
  /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{32}$/u;

export function buildInsightSetCookie(
  rawToken: string,
  options: { readonly maxAgeSeconds?: number } = {},
): string {
  return [
    `${INSIGHT_COOKIE_NAME}=${encodeURIComponent(rawToken)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds ?? INSIGHT_COOKIE_MAX_AGE_SECONDS))}`,
  ].join('; ');
}

export type InsightCookieParseResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly raw: string }
  | { readonly kind: 'parse-error' };

export function parseInsightCookieField(header: string): InsightCookieParseResult {
  let raw: string | null = null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const name = trimmed.slice(0, eq).trim();
    if (name !== INSIGHT_COOKIE_NAME) continue;
    if (raw !== null) return { kind: 'parse-error' };
    try {
      raw = decodeURIComponent(trimmed.slice(eq + 1));
    } catch {
      return { kind: 'parse-error' };
    }
  }
  return raw === null ? { kind: 'absent' } : { kind: 'present', raw };
}

export function mintInsightCookieTicket(signingKey: Buffer): string {
  const id = randomBytes(INSIGHT_COOKIE_ID_BYTES).toString('base64url');
  if (id.length !== INSIGHT_COOKIE_ID_CHARS) {
    throw new Error('insight cookie mint produced an unexpected id length');
  }
  return `${id}.${insightCookieMac(signingKey, id)}`;
}

export function verifyInsightCookieTicket(signingKey: Buffer, raw: string): boolean {
  if (typeof raw !== 'string' || raw.length < 32 || raw.length > 64) return false;
  if (!INSIGHT_COOKIE_TICKET_PATTERN.test(raw)) return false;
  const dot = raw.indexOf('.');
  const id = raw.slice(0, dot);
  const supplied = Buffer.from(raw.slice(dot + 1));
  const expected = Buffer.from(insightCookieMac(signingKey, id));
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function readInsightCookie(request: FastifyRequest, signingKey: Buffer): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  const parsed = parseInsightCookieField(header);
  if (parsed.kind !== 'present') return null;
  return verifyInsightCookieTicket(signingKey, parsed.raw) ? parsed.raw : null;
}

export function insightCookieParseError(request: FastifyRequest): boolean {
  const header = request.headers.cookie;
  if (!header) return false;
  return parseInsightCookieField(header).kind === 'parse-error';
}

export function setInsightCookie(reply: FastifyReply, rawToken: string): void {
  reply.header('Set-Cookie', buildInsightSetCookie(rawToken));
}

function insightCookieMac(signingKey: Buffer, id: string): string {
  return createHmac('sha256', signingKey)
    .update(`${INSIGHT_COOKIE_MAC_PURPOSE}${id}`, 'utf8')
    .digest('base64url')
    .slice(0, INSIGHT_COOKIE_MAC_TRUNCATED_CHARS);
}
