import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  clearEmailSuppressionFact,
  listEmailSuppressionFacts,
  verifyEmailOpsToken,
  type EmailSuppressionOpsRepository,
  type EmailSuppressionFactView,
} from '../../modules/notifications/index.js';
import type { Metrics } from '../../infrastructure/telemetry/index.js';
import { ProductHttpError } from '../product-error.js';
import { rateLimitClientKey, type FixedWindowRateLimiter } from '../http-security.js';

export const EMAIL_OPS_SUPPRESSIONS_PATH = '/ops/email/suppressions';
export const EMAIL_OPS_SUPPRESSION_PATH = '/ops/email/suppressions/:recipientAccountId';
const ACCOUNT_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

/**
 * P5-31 ops-only suppression surface.
 *
 * GET  /ops/email/suppressions                 -> scrubbed suppression facts
 * DELETE /ops/email/suppressions/:accountId    -> clear fact (documented as
 *                                                  resubscribe; aligns with
 *                                                  provider UnblockRecipient)
 *
 * Both routes require a Bearer token equal (constant-time) to the configured
 * EMAIL_OPS_TOKEN. When the email feature is disabled or the token is unset
 * the whole surface is DISABLED (404). Ops output is scrubbed: account ids
 * and timestamps only - recipient emails and credentials never leave the
 * repository (the facts table stores no email address).
 */
export interface EmailOpsRoutesDependencies {
  readonly enabled: boolean;
  /** EMAIL_OPS_TOKEN; null/empty disables the surface (404). */
  readonly opsToken: string | null;
  readonly repository: EmailSuppressionOpsRepository;
  readonly metrics?: Metrics;
  /**
   * Bounded per-IP fixed-window rate limiter (B2) driven by
   * EMAIL_OPS_RATE_LIMIT_MAX/EMAIL_OPS_RATE_LIMIT_WINDOW_MS. Optional: when
   * absent (or the surface is disabled) no 429 is ever returned - the
   * surface keeps its existing 404/401/200 behavior.
   */
  readonly rateLimiter?: FixedWindowRateLimiter;
}

export function registerEmailOpsRoutes(app: FastifyInstance, deps: EmailOpsRoutesDependencies): void {
  const applyRateLimit = async (request: FastifyRequest): Promise<void> => {
    // Brute-force protection only while the surface is enabled; a disabled
    // surface keeps answering 404 and never burns limiter capacity (B2).
    if (!deps.enabled || deps.opsToken === null || deps.opsToken.length === 0) return;
    const limiter = deps.rateLimiter;
    if (!limiter) return;
    const decision = limiter.consume(rateLimitClientKey(request, EMAIL_OPS_SUPPRESSIONS_PATH));
    if (decision.allowed) return;
    throw new ProductHttpError({ statusCode: 429, code: 'rate_limited',
      message: 'Too many requests. Please try again later.', recovery: 'same_request',
      sameRequestRetrySafe: true, retryAfterSeconds: decision.retryAfterSeconds,
      headers: { 'Retry-After': String(decision.retryAfterSeconds) } });
  };
  const guard = (request: FastifyRequest, reply: FastifyReply): { readonly denied: boolean } => {
    if (!deps.enabled || deps.opsToken === null || deps.opsToken.length === 0) {
      void reply.code(404).send({ error: 'not_found' });
      return { denied: true };
    }
    const header = request.headers.authorization;
    const provided = typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim() : undefined;
    if (!verifyEmailOpsToken(deps.opsToken, provided)) {
      // 401s advertise the Bearer challenge (repo convention shared with the
      // sync protected routes) so clients know how to authenticate.
      reply.header('WWW-Authenticate', 'Bearer');
      void reply.code(401).send({ error: 'unauthorized' });
      return { denied: true };
    }
    return { denied: false };
  };

  app.get(EMAIL_OPS_SUPPRESSIONS_PATH, {
    config: { productTransport: { allowedQuery: [], cacheControl: 'no-store' } },
    onRequest: applyRateLimit,
  }, async (request, reply) => {
    if (guard(request, reply).denied) return reply;
    const views = await listEmailSuppressionFacts(deps.repository);
    return reply.code(200).send({ facts: views });
  });

  app.delete(EMAIL_OPS_SUPPRESSION_PATH, {
    config: { productTransport: { allowedQuery: [], cacheControl: 'no-store' } },
    onRequest: applyRateLimit,
  }, async (request, reply) => {
    if (guard(request, reply).denied) return reply;
    const recipientAccountId = (request.params as { recipientAccountId?: string }).recipientAccountId ?? '';
    if (!ACCOUNT_ID.test(recipientAccountId)) {
      return reply.code(400).send({ error: 'invalid_recipient_account_id' });
    }
    const result = await clearEmailSuppressionFact(deps.repository, recipientAccountId);
    if (!result.cleared) return reply.code(404).send({ cleared: false, recipientAccountId });
    deps.metrics?.increment('notifications.email_delivery.suppression_cleared');
    return reply.code(200).send({ cleared: true, recipientAccountId });
  });
}

export type { EmailSuppressionFactView };
