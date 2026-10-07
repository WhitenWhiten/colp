import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SearchRateLimiter } from '../../infrastructure/rate-limit/index.js';
import {
  PUBLIC_ACTIVITY_PAGE_MAX_LIMIT,
  PublicActivityCursorError,
  PublicActivityNotFoundError,
  queryCurrentPublicActivity,
  type PublicActivityQueryPage,
  type PublicActivityQueryPorts,
} from '../../modules/social/index.js';
import {
  admitPublicActivityRateLimit,
  publicActivityAnonymousSubject,
} from './public-activity-rate-limit.js';
import { ProductHttpError } from '../product-error.js';
import { productErrorStatus } from '../product-codes.js';
import { productRouteMetadata } from '../product-route-manifest.js';

const ACTIVITY_ROUTE = '/api/v1/profiles/:handle/activity';
const PUBLIC_CACHE = 'public, max-age=60';
const GOVERNED_PUBLIC_CACHE = 'public, max-age=0, must-revalidate';

export const PUBLIC_ACTIVITY_OPERATION_IDS = [
  'listPublicProfileActivity',
  'headPublicProfileActivity',
] as const;

export interface ProductPublicActivityQuery {
  get(input: {
    readonly handle: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<PublicActivityQueryPage>;
}

export interface PublicActivityRoutesDependencies {
  readonly query: ProductPublicActivityQuery;
  readonly rateLimiter?: SearchRateLimiter;
  /** Governance mode revalidates every time so an edge cannot serve a pre-hide activity row. */
  readonly contentGovernanceEnabled?: boolean;
}

export function registerProductPublicActivityRoutes(
  app: FastifyInstance,
  dependencies: PublicActivityRoutesDependencies,
): void {
  const routeOptions = {
    config: {
      productTransport: {
        allowedQuery: ['limit', 'cursor'],
        duplicateQueryErrorCode: 'invalid_query' as const,
        cacheControl: 'private-no-store' as const,
      },
    },
  };
  app.get(ACTIVITY_ROUTE, {
    exposeHeadRoute: false,
    config: { ...productRouteMetadata('GET', ACTIVITY_ROUTE), ...routeOptions.config },
    handler: activityHandler(dependencies),
  });
  app.head(ACTIVITY_ROUTE, {
    config: { ...productRouteMetadata('HEAD', ACTIVITY_ROUTE), ...routeOptions.config },
    handler: activityHandler(dependencies),
  });
}

export function composeProductPublicActivityQuery(
  ports: PublicActivityQueryPorts,
): ProductPublicActivityQuery {
  return Object.freeze({
    get(input: { readonly handle: string; readonly limit?: number; readonly cursor?: string }) {
      return queryCurrentPublicActivity(ports, input);
    },
  });
}

function activityHandler(dependencies: PublicActivityRoutesDependencies) {
  return async (
    request: FastifyRequest<{
      Params: { handle?: string };
      Querystring: Record<string, string | undefined>;
    }>,
    reply: FastifyReply,
  ): Promise<PublicActivityQueryPage> => {
    const handle = request.params.handle;
    if (typeof handle !== 'string' || handle.includes('%')) throw activityNotFound();
    const paging = parsePaging(request.query);
    await admitPublicActivityRateLimit(
      dependencies.rateLimiter,
      publicActivityAnonymousSubject(request),
      'Too many public Activity requests. Please try again later.',
    );
    let page: PublicActivityQueryPage;
    try {
      page = await dependencies.query.get({ handle, ...paging });
    } catch (error: unknown) {
      throw mapError(error);
    }
    reply.header('cache-control', dependencies.contentGovernanceEnabled ? GOVERNED_PUBLIC_CACHE : PUBLIC_CACHE);
    return page;
  };
}

function parsePaging(query: Record<string, string | undefined>): {
  readonly limit?: number;
  readonly cursor?: string;
} {
  if (query.cursor !== undefined && (!query.cursor || query.cursor.length > 2048 || query.limit !== undefined)) {
    if (query.cursor !== undefined && query.cursor.length > 2048) throw invalidCursor();
    throw invalidQuery();
  }
  let limit: number | undefined;
  if (query.limit !== undefined) {
    if (!/^[1-9][0-9]*$/u.test(query.limit) || Number(query.limit) > PUBLIC_ACTIVITY_PAGE_MAX_LIMIT) {
      throw invalidQuery();
    }
    limit = Number(query.limit);
  }
  return {
    ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function mapError(error: unknown): unknown {
  if (error instanceof ProductHttpError) return error;
  if (error instanceof PublicActivityCursorError) return invalidCursor();
  if (error instanceof PublicActivityNotFoundError) return activityNotFound();
  if (hasErrorCode(error, 'invalid_cursor')) return invalidCursor();
  if (hasErrorCode(error, 'resource_not_found')) return activityNotFound();
  if (error instanceof TypeError) return invalidQuery();
  return error;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { readonly code?: unknown }).code === code;
}

function activityNotFound(): ProductHttpError {
  return new ProductHttpError({
    statusCode: 404,
    code: 'resource_not_found',
    message: 'The requested Profile was not found.',
    recovery: 'none',
  });
}

function invalidCursor(): ProductHttpError {
  return new ProductHttpError({
    statusCode: 400,
    code: 'invalid_cursor',
    message: 'The public Activity cursor is invalid.',
    recovery: 'restart_from_first_page',
  });
}

function invalidQuery(): ProductHttpError {
  return new ProductHttpError({
    statusCode: productErrorStatus('invalid_query'),
    code: 'invalid_query',
    message: 'The public Activity request is invalid.',
  });
}
