import type { FastifyRequest } from 'fastify';
import type {
  SearchRateLimiter,
  SearchRateLimitSubject,
} from '../../infrastructure/rate-limit/index.js';
import { ProductHttpError } from '../product-error.js';
import { productErrorStatus } from '../product-codes.js';

export function trustedPublicActivityClientIp(request: FastifyRequest): string {
  const ip = typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : 'unknown';
  return ip;
}

export function publicActivityAnonymousSubject(request: FastifyRequest): SearchRateLimitSubject {
  return { family: 'anonymous', subject: trustedPublicActivityClientIp(request) };
}

export function publicActivityAccountSubject(accountId: string): SearchRateLimitSubject {
  return { family: 'account', subject: accountId };
}

/**
 * Consumes one unit of the public Activity family budget. The limiter is
 * required whenever those routes are registered; a missing limiter fails
 * closed instead of admitting unbounded traffic.
 */
export async function admitPublicActivityRateLimit(
  limiter: SearchRateLimiter | undefined,
  subject: SearchRateLimitSubject,
  deniedMessage: string,
): Promise<void> {
  if (limiter === undefined) {
    throw new Error(
      'public Activity rate limiter is required whenever those routes are registered',
    );
  }
  const outcome = await limiter.consume(subject);
  if (outcome.kind === 'allowed') return;
  if (outcome.kind === 'denied') {
    throw new ProductHttpError({
      statusCode: productErrorStatus('rate_limited'),
      code: 'rate_limited',
      message: deniedMessage,
      recovery: 'same_request',
      sameRequestRetrySafe: true,
      retryAfterSeconds: outcome.decision.retryAfterSeconds,
      headers: {
        'Retry-After': String(outcome.decision.retryAfterSeconds),
        'RateLimit-Policy': limiter.policy[subject.family],
      },
    });
  }
  throw new ProductHttpError({
    statusCode: productErrorStatus('feature_temporarily_unavailable'),
    code: 'feature_temporarily_unavailable',
    message: 'Rate limiting service is temporarily unavailable. Please try again later.',
    recovery: 'same_request',
    sameRequestRetrySafe: true,
  });
}
