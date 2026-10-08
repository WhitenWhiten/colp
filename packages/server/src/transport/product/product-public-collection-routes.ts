import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  getProductPublicCollectionPage,
  PRODUCT_PUBLIC_COLLECTION_MAX_LIMIT,
  ProductPublicCollectionCursorError,
  ProductPublicCollectionNotFoundError,
  PublicationNotFoundError,
  PublicationSnapshotExpiredError,
  type ProductPublicCollectionQueryPorts,
} from '../../modules/publication/index.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import type { SearchRateLimiter } from '../../infrastructure/rate-limit/index.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { optionalSessionActor } from '../session-auth.js';
import {
  admitExploreDirectoryRateLimit,
  exploreDirectoryAccountSubject,
  exploreDirectoryAnonymousSubject,
} from './explore-directory-rate-limit.js';

const PRODUCT_PUBLIC_COLLECTION_ROUTE = '/api/v1/collections/:collectionId';

export function registerProductPublicCollectionRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly query: ProductPublicCollectionQueryPorts;
    readonly identityUnitOfWork?: IdentityUnitOfWork;
    readonly rateLimiter?: SearchRateLimiter;
    readonly contentGovernanceEnabled?: boolean;
  },
): void {
  app.get(PRODUCT_PUBLIC_COLLECTION_ROUTE, {
    config: {
      ...productRouteMetadata('GET', PRODUCT_PUBLIC_COLLECTION_ROUTE),
      // Failures stay private/no-store; successful anonymous reads override this below.
      productTransport: { allowedQuery: ['limit', 'cursor', 'include'], cacheControl: 'private-no-store' },
    },
  }, async (request, reply) => {
    mergeReplyVary(reply, ['Cookie']);
    // Path param is named collectionId because GET shares the OpenAPI template
    // with PATCH updateCollection, but this GET treats it only as a canonical
    // publication slug — never as a Collection OpaqueId / UUID fallback.
    const slug = (request.params as { collectionId?: unknown }).collectionId;
    if (typeof slug !== 'string') throw notFound();
    const paging = parsePaging(request.query as Record<string, string>);
    const session = await optionalSessionActor(request, dependencies.identityUnitOfWork, { bearer: 'ignore' });
    await admitExploreDirectoryRateLimit(
      dependencies.rateLimiter,
      session
        ? exploreDirectoryAccountSubject(session.account.id)
        : exploreDirectoryAnonymousSubject(request),
      'Too many public Collection requests. Please try again later.',
    );
    try {
      const page = await getProductPublicCollectionPage(dependencies.query, {
        slug,
        principal: session
          ? { kind: 'account', principalId: session.account.id, subjectId: session.account.subjectId }
          : { kind: 'anonymous' },
        ...paging,
      });
      reply.header(
        'Cache-Control',
        session || paging.includeRelations
          ? 'private, no-store'
          : dependencies.contentGovernanceEnabled
            ? 'public, max-age=0, must-revalidate'
            : 'public, max-age=60, stale-while-revalidate=300',
      );
      return reply.code(200).type('application/json; charset=utf-8').send(page);
    } catch (error) {
      if (error instanceof ProductPublicCollectionCursorError) {
        throw new ProductHttpError({
          statusCode: 400,
          code: 'invalid_cursor',
          message: 'The public Collection cursor is invalid.',
          recovery: 'restart_from_first_page',
        });
      }
      if (error instanceof PublicationSnapshotExpiredError) {
        throw new ProductHttpError({
          statusCode: 409,
          code: 'snapshot_expired',
          message: 'The public Collection snapshot has expired.',
          recovery: 'restart_from_first_page',
        });
      }
      if (error instanceof ProductPublicCollectionNotFoundError || error instanceof PublicationNotFoundError) {
        throw notFound();
      }
      throw error;
    }
  });
}

function mergeReplyVary(reply: FastifyReply, additions: readonly string[]): void {
  const current = reply.getHeader('Vary');
  const fields = new Map<string, string>();
  const append = (value: string): void => {
    for (const field of value.split(',').map((part) => part.trim()).filter(Boolean)) {
      fields.set(field.toLowerCase(), fields.get(field.toLowerCase()) ?? field);
    }
  };
  if (Array.isArray(current)) current.forEach(append);
  else if (current !== undefined) append(String(current));
  additions.forEach(append);
  reply.header('Vary', fields.has('*') ? '*' : [...fields.values()].join(', '));
}

function parsePaging(query: Record<string, string>): { readonly limit?: number; readonly cursor?: string; readonly includeRelations?: boolean } {
  if (query.include !== undefined && query.include !== 'relations') {
    throw new ProductHttpError({ statusCode: 400, code: 'invalid_query', message: 'Unsupported Collection include.' });
  }
  const cursor = query.cursor;
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > 1024)) {
    throw new ProductHttpError({ statusCode: 400, code: 'invalid_cursor', message: 'The public Collection cursor is invalid.' });
  }
  const rawLimit = query.limit;
  let limit: number | undefined;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'string' || !/^[1-9][0-9]*$/u.test(rawLimit)) {
      throw invalidLimit();
    }
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 2 || limit > PRODUCT_PUBLIC_COLLECTION_MAX_LIMIT) {
      throw invalidLimit();
    }
  }
  return { ...(query.include === 'relations' ? { includeRelations: true } : {}), ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) };
}

function invalidLimit(): ProductHttpError {
  return new ProductHttpError({
    statusCode: 400,
    code: 'invalid_query',
    message: `limit must be an integer between 2 and ${PRODUCT_PUBLIC_COLLECTION_MAX_LIMIT}.`,
  });
}

function notFound(): ProductHttpError {
  return new ProductHttpError({
    statusCode: 404,
    code: 'resource_not_found',
    message: 'The requested Collection was not found.',
    recovery: 'none',
  });
}
