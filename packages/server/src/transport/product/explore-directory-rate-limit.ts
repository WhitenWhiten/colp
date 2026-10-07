import type { FastifyRequest } from 'fastify';
import type {
  SearchRateLimiter,
  SearchRateLimitSubject,
} from '../../infrastructure/rate-limit/index.js';
import { ProductHttpError } from '../product-error.js';
import { productErrorStatus } from '../product-codes.js';

/**
 * P-04 Explore / COLP Directory admission. Reuses the Search limiter port as a
 * second instance (distinct Redis prefix + HMAC secret) so exhausting Explore
 * never exhausts Search.
 */
export function trustedExploreDirectoryClientIp(request: FastifyRequest): string {
  const ip = typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : 'unknown';
  return ip;
}

export function exploreDirectoryAnonymousSubject(request: FastifyRequest): SearchRateLimitSubject {
  return { family: 'anonymous', subject: trustedExploreDirectoryClientIp(request) };
}

export function exploreDirectoryAccountSubject(accountId: string): SearchRateLimitSubject {
  return { family: 'account', subject: accountId };
}

/**
 * Consumes one unit of the Explore/Directory family budget. The limiter is
 * required whenever those routes are registered; a missing limiter fails
 * closed instead of admitting unbounded traffic. Denied is 429 with quota
 * facts; shared-store failure is 503 without fabricated quota facts.
 */
export async function admitExploreDirectoryRateLimit(
  limiter: SearchRateLimiter | undefined,
  subject: SearchRateLimitSubject,
  deniedMessage: string,
): Promise<void> {
  if (limiter === undefined) {
    throw new Error(
      'Explore/Directory rate limiter is required whenever those routes are registered',
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
