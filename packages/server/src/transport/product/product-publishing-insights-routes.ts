import type { FastifyInstance } from 'fastify';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import type { PublishingInsights, PublishingInsightsActor } from '../../modules/publication/index.js';
import { createFixedWindowRateLimiter, type FixedWindowRateLimiter } from '../http-security.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireSessionActor } from '../session-auth.js';

const PRODUCT_PUBLISHING_INSIGHTS_ROUTE = '/api/v1/me/publishing-insights';
const DEFAULT_DASHBOARD_RATE_LIMIT = Object.freeze({ maxRequests: 120, windowMs: 60_000 });

export interface ProductPublishingInsightsRouteDependencies {
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly getInsights: (actor: PublishingInsightsActor, now: Date) => Promise<PublishingInsights>;
  readonly now?: () => Date;
  readonly rateLimiter?: FixedWindowRateLimiter;
}

export function registerProductPublishingInsightsRoutes(
  app: FastifyInstance,
  dependencies: ProductPublishingInsightsRouteDependencies,
): void {
  const limiter = dependencies.rateLimiter
    ?? createFixedWindowRateLimiter(DEFAULT_DASHBOARD_RATE_LIMIT);
  app.get(PRODUCT_PUBLISHING_INSIGHTS_ROUTE, {
    config: {
      ...productRouteMetadata('GET', PRODUCT_PUBLISHING_INSIGHTS_ROUTE),
      productTransport: {
        allowedQuery: [],
        queryErrorCode: 'invalid_query',
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    const { account } = await requireSessionActor(request, dependencies.identityUnitOfWork, { touch: false });
    const decision = limiter.consume(`publishing-insights:principal:${account.id}`);
    if (!decision.allowed) {
      throw new ProductHttpError({
        statusCode: 429,
        code: 'rate_limited',
        message: 'Too many Publishing Insights requests.',
        recovery: 'same_request',
        sameRequestRetrySafe: true,
        retryAfterSeconds: decision.retryAfterSeconds,
        headers: { 'Retry-After': String(decision.retryAfterSeconds) },
      });
    }
    const body = await dependencies.getInsights(
      { subjectId: account.subjectId },
      (dependencies.now ?? (() => new Date()))(),
    );
    return reply.code(200).type('application/json; charset=utf-8').send(body);
  });
}
