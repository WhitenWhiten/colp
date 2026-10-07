import type { FastifyRequest } from 'fastify';
import { ProductHttpError } from '../product-error.js';
import {
  consumeProductAdmission,
  createFixedWindowRateLimiter,
  rateLimitClientKey,
  type FixedWindowRateLimiter,
  type ProductAdmissionRateLimiter,
} from '../http-security.js';

/**
 * Cheap per-IP origin budget for public avatar and bookmark-favicon GET.
 *
 * This family is named `public-object`. It is not the auth `me` family used by
 * POST /api/v1/me/avatar. Production multi-replica composition injects the
 * shared Redis adapter; development and single-replica composition use the
 * bounded in-process fallback.
 */
export const PUBLIC_OBJECT_RATE_LIMIT_FAMILY = 'public-object';

/** Generous enough for a cache-miss burst; cheap enough to bound origin fetch. */
export const PUBLIC_OBJECT_RATE_LIMIT_MAX_REQUESTS = 120;
export const PUBLIC_OBJECT_RATE_LIMIT_WINDOW_MS = 60_000;

export type PublicObjectRateLimiter = ProductAdmissionRateLimiter;

export function createPublicObjectRateLimiter(options?: {
  readonly maxRequests?: number;
  readonly windowMs?: number;
  readonly now?: () => number;
}): FixedWindowRateLimiter {
  return createFixedWindowRateLimiter({
    maxRequests: options?.maxRequests ?? PUBLIC_OBJECT_RATE_LIMIT_MAX_REQUESTS,
    windowMs: options?.windowMs ?? PUBLIC_OBJECT_RATE_LIMIT_WINDOW_MS,
    ...(options?.now ? { now: options.now } : {}),
  });
}

export async function admitPublicObjectGet(
  limiter: PublicObjectRateLimiter,
  request: FastifyRequest,
): Promise<void> {
  const decision = await consumeProductAdmission(limiter,
    rateLimitClientKey(request, PUBLIC_OBJECT_RATE_LIMIT_FAMILY),
  );
  if (decision.kind === 'allowed') return;
  if (decision.kind === 'failed') {
    throw new ProductHttpError({
      statusCode: 503,
      code: 'feature_temporarily_unavailable',
      message: 'Public object admission is temporarily unavailable.',
      recovery: 'same_request',
      sameRequestRetrySafe: true,
    });
  }
  throw new ProductHttpError({
    statusCode: 429,
    code: 'rate_limited',
    message: 'Too many requests. Please try again later.',
    recovery: 'same_request',
    sameRequestRetrySafe: true,
    retryAfterSeconds: decision.retryAfterSeconds,
    headers: { 'Retry-After': String(decision.retryAfterSeconds) },
  });
}
