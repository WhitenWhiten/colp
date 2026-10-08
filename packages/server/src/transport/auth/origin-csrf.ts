import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { canonicalizeSafeReturnTo } from '../../modules/identity/index.js';
import { ProductHttpError } from '../product-error.js';

/**
 * Require a single Origin header matching the exact allowlist.
 * Missing, null, multi-value (already rejected by admission), or mismatch → csrf_failed.
 */
export function requireAllowedOrigin(
  request: FastifyRequest,
  allowedOrigins: readonly string[],
): string {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0 || origin === 'null') {
    throw csrfFailed();
  }
  if (!allowedOrigins.includes(origin)) {
    throw csrfFailed();
  }
  return origin;
}

export function requireCsrfHeader(
  request: FastifyRequest,
  expectedHash: string,
  matches: (raw: string, expectedHash: string) => boolean,
): void {
  const raw = request.headers['x-csrf-token'];
  if (typeof raw !== 'string' || raw.length === 0) {
    throw csrfFailed();
  }
  if (!matches(raw, expectedHash)) {
    throw csrfFailed();
  }
}

export function csrfFailed(): ProductHttpError {
  // Do not distinguish missing vs mismatch vs origin failure.
  return new ProductHttpError({
    statusCode: 403,
    code: 'csrf_failed',
    message: 'The request failed CSRF or Origin validation.',
    recovery: 'user_action',
  });
}

export function constantTimeEqualString(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Validate returnTo against the product origin.
 * Invalid values, including a pathname that is `//` after canonicalization,
 * fall back without reflecting the input. The OIDC callback uses this on
 * persisted rows, not only on the start query.
 */
export function resolveBrowserReturnTo(
  raw: string | undefined,
  productOrigin: string,
  fallback = '/',
): string {
  return canonicalizeSafeReturnTo(raw, productOrigin) ?? fallback;
}
