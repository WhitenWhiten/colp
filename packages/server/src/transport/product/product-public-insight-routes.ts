import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  InsightConcealError,
  InsightEventCardinalityError,
  type InsightEventType,
  type RecordInsightEventInput,
  type RecordInsightEventResult,
  type VisitorHashPort,
} from '../../modules/publication/index.js';
import { secretsMatch, type IdentityUnitOfWork } from '../../modules/identity/index.js';
import type { PublishingInsightsIngestRateLimiter } from '../../infrastructure/rate-limit/index.js';
import { ProductHttpError } from '../product-error.js';
import { productErrorStatus } from '../product-codes.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireAllowedOrigin, requireCsrfHeader } from '../auth/origin-csrf.js';
import {
  authenticationRequired,
  requireSessionActor,
} from '../session-auth.js';
import { readSessionCookie } from '../session-cookie.js';
import {
  insightCookieParseError,
  mintInsightCookieTicket,
  readInsightCookie,
  setInsightCookie,
} from './insight-cookie.js';

const PRODUCT_PUBLIC_INSIGHT_ROUTE = '/api/v1/public-collections/:slug/insight-events';
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,261}[a-z0-9])$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/u;

const insightIngestMissingIdentity: IdentityUnitOfWork = {
  execute: async () => {
    throw authenticationRequired();
  },
};

export interface ProductPublicInsightRouteDependencies {
  readonly allowedOrigins: readonly string[];
  readonly identityUnitOfWork?: IdentityUnitOfWork;
  readonly visitorHash: VisitorHashPort;
  readonly rateLimiter: PublishingInsightsIngestRateLimiter;
  readonly rateLimitKeySecret: Buffer;
  /** Visitor HMAC pepper; used to mint/verify the signed insight cookie. */
  readonly insightCookieSigningKey: Buffer;
  readonly record: (input: RecordInsightEventInput) => Promise<RecordInsightEventResult>;
  readonly now?: () => Date;
  readonly csrfMatches?: (raw: string, expectedHash: string) => boolean;
}

export function registerProductPublicInsightRoutes(
  app: FastifyInstance,
  dependencies: ProductPublicInsightRouteDependencies,
): void {
  app.post(PRODUCT_PUBLIC_INSIGHT_ROUTE, {
    config: {
      ...productRouteMetadata('POST', PRODUCT_PUBLIC_INSIGHT_ROUTE),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    const slug = (request.params as { slug?: unknown }).slug;
    if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
      throw notFound();
    }
    if (insightCookieParseError(request)) {
      throw invalidRequest('Cookie __Host-known_insight must occur exactly once when provided.');
    }
    const body = parseInsightEventBody(request.body);
    const actor = await insightIngestSession(request, dependencies);
    // Signed tickets only. An illegal / unsigned / oversize cookie is absent
    // (IP/UA quota + a fresh mint). Origin allowlist is CSRF for browsers,
    // not a human-visitor proof and not a quota identity.
    let insightCookie = readInsightCookie(request, dependencies.insightCookieSigningKey);
    let mintedCookie: string | undefined;
    if (actor === null && insightCookie === null) {
      mintedCookie = mintInsightCookieTicket(dependencies.insightCookieSigningKey);
      insightCookie = mintedCookie;
    }
    const visitor = actor === null
      ? {
          kind: 'anonymous' as const,
          cookie: insightCookie ?? mintedCookie ?? '',
        }
      : { kind: 'subject' as const, subjectId: actor.account.subjectId };
    const rateVisitor = actor !== null
      ? { kind: 'subject' as const, subjectId: actor.account.subjectId }
      : insightIngestIpua(request);
    try {
      await dependencies.record({
        admitTarget: async (target) => {
          const outcome = await dependencies.rateLimiter.consume({
            visitor: rateVisitor,
            slug: target.collectionId,
            eventType: body.eventType,
            ...(target.nodeId === undefined ? {} : { nodeId: target.nodeId }),
          });
          if (outcome.kind === 'denied') {
            throw new ProductHttpError({
              statusCode: productErrorStatus('rate_limited'),
              code: 'rate_limited',
              message: 'Too many insight ingest requests. Please try again later.',
              recovery: 'same_request',
              sameRequestRetrySafe: true,
              retryAfterSeconds: outcome.decision.retryAfterSeconds,
              headers: { 'Retry-After': String(outcome.decision.retryAfterSeconds) },
            });
          }
          if (outcome.kind === 'failed') {
            throw new ProductHttpError({
              statusCode: productErrorStatus('feature_temporarily_unavailable'),
              code: 'feature_temporarily_unavailable',
              message: 'Rate limiting service is temporarily unavailable. Please try again later.',
              recovery: 'same_request',
              sameRequestRetrySafe: true,
            });
          }
        },
        slug,
        eventType: body.eventType,
        ...(body.nodeId === undefined ? {} : { nodeId: body.nodeId }),
        visitor,
        occurredAt: (dependencies.now ?? (() => new Date()))(),
      });
    } catch (error) {
      if (error instanceof InsightConcealError) throw notFound();
      if (error instanceof InsightEventCardinalityError) {
        throw invalidRequest(error.message);
      }
      throw error;
    }
    if (mintedCookie !== undefined) {
      setInsightCookie(reply, mintedCookie);
    }
    return reply.code(204).send();
  });
}

async function insightIngestSession(
  request: FastifyRequest,
  deps: ProductPublicInsightRouteDependencies,
) {
  const raw = readSessionCookie(request);
  if (!raw) {
    requireAllowedOrigin(request, deps.allowedOrigins);
    return null;
  }
  let actor;
  try {
    actor = await requireSessionActor(
      request,
      deps.identityUnitOfWork ?? insightIngestMissingIdentity,
      { touch: false },
    );
  } catch (error: unknown) {
    // Present but unusable (expired / revoked / occupancy / missing mapping):
    // anonymous ingest. Do not owner-skip and do not require CSRF.
    if (isUnusableInsightSession(error)) {
      requireAllowedOrigin(request, deps.allowedOrigins);
      return null;
    }
    throw error;
  }
  requireAllowedOrigin(request, deps.allowedOrigins);
  if (!('session' in actor) || actor.session === undefined) {
    return null;
  }
  requireCsrfHeader(request, actor.session.csrfTokenHash, deps.csrfMatches ?? secretsMatch);
  return actor;
}

function isUnusableInsightSession(error: unknown): boolean {
  return error instanceof ProductHttpError
    && (error.productCode === 'authentication_required'
      || error.productCode === 'verification_required');
}

function insightIngestIpua(request: FastifyRequest) {
  return {
    kind: 'ipua' as const,
    ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : 'unknown',
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : '',
  };
}

function parseInsightEventBody(body: unknown): {
  readonly eventType: InsightEventType;
  readonly nodeId?: string;
} {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest('Insight event body is invalid.');
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  const eventType = record.eventType;
  if (eventType === 'collection_view' || eventType === 'preview_open') {
    if (keys.length !== 1 || !Object.hasOwn(record, 'eventType')) {
      throw invalidRequest('collection_view and preview_open forbid additional properties.');
    }
    return { eventType };
  }
  if (eventType === 'resource_open') {
    if (keys.length !== 2 || !Object.hasOwn(record, 'nodeId') || typeof record.nodeId !== 'string'
      || record.nodeId.length === 0 || !OPAQUE_ID_PATTERN.test(record.nodeId)) {
      throw invalidRequest('resource_open requires nodeId and forbids additional properties.');
    }
    return { eventType, nodeId: record.nodeId };
  }
  throw invalidRequest('Insight event type is not in the closed set.');
}

function invalidRequest(message: string): ProductHttpError {
  return new ProductHttpError({ statusCode: 400, code: 'invalid_request', message });
}

function notFound(): ProductHttpError {
  return new ProductHttpError({
    statusCode: 404,
    code: 'resource_not_found',
    message: 'The requested Collection was not found.',
    recovery: 'none',
  });
}
