import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import {
  CollectionAuthorizationError,
  CollectionChildrenCursorError,
  CollectionChildrenCursorExpiredError,
  CollectionChildrenInputError,
  SnapshotExpiredError,
  listCollectionChildren,
  type CollectionChildrenReadUnitOfWork,
} from '../../modules/collections/index.js';
import type { ProductAdmissionRateLimiter } from '../http-security.js';
import { consumeProductAdmission, rateLimitClientKey } from '../http-security.js';
import { mapAuthorizationOutcome } from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import { productErrorStatus } from '../product-codes.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { readCollectionIdParam } from './collection-route-helpers.js';
import { rejectNonemptyBody, withCancellation } from './favicon-policy-routes.js';
import { optionalSessionActor } from '../session-auth.js';

const CHILDREN = '/api/v1/collections/:collectionId/children';
const UNAVAILABLE_MESSAGE = 'Collection children are temporarily unavailable.';

export interface CollectionChildrenRouteDependencies {
  /** KNOWN_FEATURE_FAVICON_POLICY gate; false ⇒ every request is 404. */
  readonly enabled: boolean;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly childrenReadUnitOfWork: CollectionChildrenReadUnitOfWork;
  readonly rateLimiter: ProductAdmissionRateLimiter;
  readonly timeoutMs: number;
}

const ALLOWED_QUERY = ['parentId', 'sort', 'limit', 'cursor'] as const;
const LIMIT_PATTERN = /^[0-9]{1,9}$/u;

export function registerCollectionChildrenRoutes(
  app: FastifyInstance,
  deps: CollectionChildrenRouteDependencies,
): void {
  if (!Number.isInteger(deps.timeoutMs) || deps.timeoutMs < 1 || deps.timeoutMs > 30_000) {
    throw new TypeError('Collection children route timeout is outside the application budget.');
  }
  const exposure = async (): Promise<void> => {
    // FO-05 feature flag off => 404 with no new feature resources exposed.
    if (!deps.enabled) throw notFound();
  };
  const privateTransport = {
    duplicateQueryErrorCode: 'invalid_query' as const,
    queryErrorCode: 'invalid_query' as const,
    allowedQuery: ALLOWED_QUERY,
    acceptedMediaTypes: ['application/json'] as const,
    bodyLimitBytes: 32_768,
    cacheControl: 'private-no-store' as const,
  };
  const admission = async (request: FastifyRequest) => {
    const decision = await consumeProductAdmission(deps.rateLimiter, rateLimitClientKey(request, CHILDREN));
    if (decision.kind === 'failed') throw unavailable();
    if (decision.kind === 'denied') {
      throw new ProductHttpError({
        statusCode: 429,
        code: 'rate_limited',
        message: 'Too many collection children requests. Please try again later.',
        recovery: 'same_request',
        sameRequestRetrySafe: true,
        retryAfterSeconds: decision.retryAfterSeconds,
        headers: { 'Retry-After': String(decision.retryAfterSeconds) },
      });
    }
  };

  app.get(CHILDREN, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', CHILDREN),
      productTransport: privateTransport,
    },
    onRequest: admission,
  }, async (request, reply) => {
    await exposure();
    rejectNonemptyBody(request);
    const collectionId = readCollectionIdParam(request);
    const query = request.query as Record<string, string>;
    const session = await optionalSessionActor(request, deps.identityUnitOfWork);
    try {
      let limit: number | undefined;
      if (query.limit !== undefined) {
        if (!LIMIT_PATTERN.test(query.limit)) {
          throw new CollectionChildrenInputError('limit must be a base-10 integer');
        }
        limit = Number(query.limit);
      }
      const page = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.childrenReadUnitOfWork.execute((ports) => listCollectionChildren(ports, {
          actor: session
            ? { principalId: session.account.id, subjectId: session.account.subjectId }
            : { principalId: null, subjectId: null },
          collectionId,
          parentId: query.parentId,
          sort: query.sort,
          limit,
          cursor: query.cursor,
        }), { signal }), UNAVAILABLE_MESSAGE);
      return sendChildrenPage(reply, page);
    } catch (error) {
      throw mapChildrenRouteError(error);
    }
  });
}

function sendChildrenPage(reply: FastifyReply, page: unknown): FastifyReply {
  return reply
    .code(200)
    .type('application/json; charset=utf-8')
    .header('cache-control', 'private, no-store')
    .send(page);
}

export function mapChildrenRouteError(error: unknown): ProductHttpError {
  if (error instanceof ProductHttpError) return error;
  if (error instanceof CollectionChildrenCursorError) {
    return new ProductHttpError({
      statusCode: productErrorStatus('invalid_cursor'),
      code: 'invalid_cursor',
      message: error.message,
      recovery: 'restart_from_first_page',
    });
  }
  if (error instanceof CollectionChildrenCursorExpiredError || error instanceof SnapshotExpiredError) {
    return new ProductHttpError({
      statusCode: productErrorStatus('snapshot_expired'),
      code: 'snapshot_expired',
      message: error.message,
      recovery: 'restart_from_first_page',
    });
  }
  if (error instanceof CollectionChildrenInputError) {
    return new ProductHttpError({
      statusCode: productErrorStatus('invalid_query'),
      code: 'invalid_query',
      message: error.message,
    });
  }
  if (error instanceof CollectionAuthorizationError) {
    return mapAuthorizationOutcome(error.outcome);
  }
  if (error instanceof TypeError) {
    return new ProductHttpError({
      statusCode: productErrorStatus('invalid_query'),
      code: 'invalid_query',
      message: 'The request is invalid.',
    });
  }
  return mapRouteDatabaseError(error, 'The collection children request could not be completed.');
}

function mapRouteDatabaseError(error: unknown, fallback: string): ProductHttpError {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '57014' || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT') {
    return unavailable();
  }
  const kind = (error as { kind?: unknown } | null)?.kind;
  if (kind === 'serialization_failure' || kind === 'deadlock' || kind === 'lock_timeout' || kind === 'unavailable') {
    return unavailable();
  }
  return new ProductHttpError({
    statusCode: productErrorStatus('internal_error'),
    code: 'internal_error',
    message: fallback,
    recovery: 'same_request',
  });
}

function notFound(): ProductHttpError {
  return new ProductHttpError({
    statusCode: 404,
    code: 'resource_not_found',
    message: 'The requested resource was not found.',
    recovery: 'none',
  });
}

function unavailable(): ProductHttpError {
  return new ProductHttpError({
    statusCode: productErrorStatus('feature_temporarily_unavailable'),
    code: 'feature_temporarily_unavailable',
    message: UNAVAILABLE_MESSAGE,
    recovery: 'same_request',
    sameRequestRetrySafe: true,
    retryAfterSeconds: 1,
    headers: { 'Retry-After': '1' },
  });
}