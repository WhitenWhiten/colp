import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SearchRateLimiter } from '../../infrastructure/rate-limit/index.js';
import { productErrorStatus } from '../product-codes.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { negotiatePublicationRead } from './publication-read-negotiation.js';
import {
  admitExploreDirectoryRateLimit,
  exploreDirectoryAnonymousSubject,
} from './explore-directory-rate-limit.js';

export const PRODUCT_PUBLIC_PROFILE_CONTRACT_VERSION = '1.2.0';
export const PRODUCT_PUBLIC_PROFILE_MEDIA_TYPE = 'application/json';
const PRODUCT_PUBLIC_PROFILE_ROUTE = '/api/v1/profiles/:handle';
const PUBLIC_CACHE = 'public, max-age=60, stale-while-revalidate=300';
const GOVERNED_PUBLIC_CACHE = 'public, max-age=0, must-revalidate';

export interface ProductPublicProfileProjection {
  readonly profile: Readonly<{
    profileId: string;
    handle: string;
    displayName: string;
    avatarUrl: string | null;
    about: string;
  }>;
  readonly collections: readonly Readonly<{
    id: string;
    slug: string;
    title: string;
    summary: string | null;
    kind: 'bookmarks' | 'reading_path' | 'knowledge_collection' | 'mixed';
    updatedAt: string;
  }>[];
  readonly page: Readonly<{ cursor: string | null; hasMore: boolean }>;
}

export interface ProductPublicProfileQuery {
  get(input: {
    readonly handle: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<ProductPublicProfileProjection>;
}

export interface ProductPublicProfileRoutesDependencies {
  readonly query: ProductPublicProfileQuery;
  readonly rateLimiter?: SearchRateLimiter;
  readonly contentGovernanceEnabled?: boolean;
}

export function registerProductPublicProfileRoutes(
  app: FastifyInstance,
  dependencies: ProductPublicProfileRoutesDependencies,
): void {
  const routeConfig = {
    productTransport: {
      allowedQuery: ['limit', 'cursor'],
      duplicateQueryErrorCode: 'invalid_query' as const,
      cacheControl: 'private-no-store' as const,
    },
  };
  app.get(PRODUCT_PUBLIC_PROFILE_ROUTE, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', PRODUCT_PUBLIC_PROFILE_ROUTE),
      ...routeConfig,
    },
  }, profileHandler(dependencies));
  app.head(PRODUCT_PUBLIC_PROFILE_ROUTE, {
    config: {
      ...productRouteMetadata('HEAD', PRODUCT_PUBLIC_PROFILE_ROUTE),
      ...routeConfig,
    },
  }, profileHandler(dependencies));
}

function profileHandler(dependencies: ProductPublicProfileRoutesDependencies) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    mergeReplyVary(reply, ['Accept']);
    const accept = singleHeader(request.headers.accept);
    if (accept !== undefined && accept.trim() === '') throw notAcceptable();
    if (!negotiatePublicationRead({
      accept,
      protocolVersion: undefined,
      mediaType: PRODUCT_PUBLIC_PROFILE_MEDIA_TYPE,
      version: PRODUCT_PUBLIC_PROFILE_CONTRACT_VERSION,
    })) {
      throw notAcceptable();
    }

    const handle = (request.params as { handle?: unknown }).handle;
    if (typeof handle !== 'string' || handle.includes('%')) throw profileNotFound();
    const paging = parsePaging(request.query as Record<string, string | readonly string[]>);
    await admitExploreDirectoryRateLimit(
      dependencies.rateLimiter,
      exploreDirectoryAnonymousSubject(request),
      'Too many public Profile requests. Please try again later.',
    );
    let projection;
    try {
      projection = await dependencies.query.get({ handle, ...paging });
    } catch (error) {
      if (hasErrorCode(error, 'invalid_cursor')) {
        throw new ProductHttpError({
          statusCode: 400,
          code: 'invalid_cursor',
          message: 'The public Profile cursor is invalid.',
          recovery: 'restart_from_first_page',
        });
      }
      if (hasErrorCode(error, 'resource_not_found')) throw profileNotFound();
      if (error instanceof RangeError) throw invalidQuery('limit must be an integer between 1 and 100.');
      throw error;
    }

    const bytes = Buffer.from(JSON.stringify(projection), 'utf8');
    const etag = createPublicProfileEtag(bytes);
    reply
      .header('Cache-Control', dependencies.contentGovernanceEnabled ? GOVERNED_PUBLIC_CACHE : PUBLIC_CACHE)
      .header('ETag', etag)
      .header('X-Content-Type-Options', 'nosniff');

    const ifNoneMatch = singleHeader(request.headers['if-none-match']);
    if (ifNoneMatch !== undefined && ifNoneMatchMatches(ifNoneMatch, etag)) {
      return reply.code(304).send();
    }

    reply
      .code(200)
      .type('application/json; charset=utf-8')
      .header('Content-Length', String(bytes.byteLength));
    return request.method === 'HEAD' ? reply.send() : reply.send(bytes);
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { readonly code?: unknown }).code === code;
}

export function createPublicProfileEtag(bytes: Uint8Array): string {
  const digest = createHash('sha256')
    .update(`known-product-profile\n${PRODUCT_PUBLIC_PROFILE_CONTRACT_VERSION}\n${PRODUCT_PUBLIC_PROFILE_MEDIA_TYPE}\n`)
    .update(bytes)
    .digest('base64url');
  return `"sha256-${digest}"`;
}

function parsePaging(query: Record<string, string | readonly string[]>): {
  readonly limit?: number;
  readonly cursor?: string;
} {
  const rawLimit = query.limit;
  let limit: number | undefined;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'string' || !/^[1-9][0-9]*$/u.test(rawLimit)) {
      throw invalidQuery('limit must be an integer between 1 and 100.');
    }
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw invalidQuery('limit must be an integer between 1 and 100.');
    }
  }
  const cursor = query.cursor;
  if (cursor !== undefined) {
    if (typeof cursor !== 'string' || cursor.length === 0) {
      throw invalidQuery('cursor must be a non-empty signed value.');
    }
    if (cursor.length > 2048) {
      throw new ProductHttpError({
        statusCode: 400,
        code: 'invalid_cursor',
        message: 'The public Profile cursor is invalid.',
        recovery: 'restart_from_first_page',
      });
    }
  }
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function ifNoneMatchMatches(value: string, current: string): boolean {
  if (value.trim() === '*') return true;
  const validators = splitEntityTagList(value);
  if (validators === null) {
    throw new ProductHttpError({
      statusCode: 400,
      code: 'invalid_request',
      message: 'If-None-Match is invalid.',
    });
  }
  const normalizedCurrent = current.replace(/^W\//u, '');
  return validators.some((validator) => validator.replace(/^W\//u, '') === normalizedCurrent);
}

function splitEntityTagList(value: string): readonly string[] | null {
  const values: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22) quoted = !quoted;
    if (code === 0x2c && !quoted) {
      values.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quoted) return null;
  values.push(value.slice(start).trim());
  if (values.some((item) => !/^(?:W\/)?"[\x21\x23-\x7E\u0080-\uFFFF]*"$/u.test(item))) return null;
  return values;
}

function singleHeader(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ProductHttpError({
      statusCode: 400,
      code: 'invalid_request',
      message: 'The request header must occur once.',
    });
  }
  return value;
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

function invalidQuery(message: string): ProductHttpError {
  return new ProductHttpError({ statusCode: 400, code: 'invalid_query', message });
}

function notAcceptable(): ProductHttpError {
  return new ProductHttpError({
    statusCode: productErrorStatus('not_acceptable'),
    code: 'not_acceptable',
    message: 'No acceptable public Profile representation is available.',
  });
}

function profileNotFound(): ProductHttpError {
  return new ProductHttpError({
    statusCode: 404,
    code: 'resource_not_found',
    message: 'The requested Profile was not found.',
    recovery: 'none',
  });
}
