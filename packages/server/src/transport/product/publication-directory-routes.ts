import { createValidatorRegistry } from '@know-n/colp/schema';
import {
  composePublicationHttpRead,
  mergePublicationAntiDiscoveryHeaders,
} from '@know-n/colp/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  getPublicationDirectoryPage,
  PublicationDirectoryCursorError,
  PublicationDirectoryInvalidQueryError,
  type PublicationDirectoryQueryInput,
  type PublicationDirectoryPageResult,
  type PublicationDirectoryQueryPorts,
} from '../../modules/publication/index.js';
import type { PublicationConfig } from '../../bootstrap/config.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import { CacheFallbackRejectedError, isCacheAbortError } from '../../infrastructure/cache/index.js';
import { sendPublicationProblem } from './publication-snapshot-routes.js';
import { optionalSessionActor } from '../session-auth.js';
import { negotiatePublicationRead } from './publication-read-negotiation.js';
import { abortPublicationRead, requestCancellation } from './publication-request-cancel.js';
import type { SearchRateLimiter } from '../../infrastructure/rate-limit/index.js';
import {
  admitExploreDirectoryRateLimit,
  exploreDirectoryAccountSubject,
  exploreDirectoryAnonymousSubject,
} from './explore-directory-rate-limit.js';
import { ProductHttpError } from '../product-error.js';

const DIRECTORY_ROUTE = '/colp/v0.1/directory';
const DIRECTORY_MEDIA_TYPE = 'application/vnd.collection-protocol.catalog+json;version=0.1';
const DIRECTORY_BASE_MEDIA_TYPE = 'application/vnd.collection-protocol.catalog+json';
const validators = createValidatorRegistry();

/** T10 optional cache-aware reader (same call surface as getPublicationDirectoryPage). */
export type PublicationDirectoryRouteReader = (
  ports: PublicationDirectoryQueryPorts,
  input: PublicationDirectoryQueryInput,
  signal?: AbortSignal,
) => Promise<PublicationDirectoryPageResult>;

export function registerPublicationDirectoryRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly config: PublicationConfig;
    readonly query: PublicationDirectoryQueryPorts;
    readonly identityUnitOfWork?: IdentityUnitOfWork;
    /** T10 cache seam: defaults to the authoritative PostgreSQL reader. */
    readonly reader?: PublicationDirectoryRouteReader;
    /** P-04 Explore/Directory admission limiter; optional so HTTP tests omit it. */
    readonly rateLimiter?: SearchRateLimiter;
  },
): void {
  app.route({
    method: ['GET', 'HEAD'],
    url: DIRECTORY_ROUTE,
    config: {
      productTransport: {
        allowedQuery: ['tag', 'creator', 'kind', 'updatedSince', 'q', 'limit', 'cursor'],
        cacheControl: 'public-revalidate',
      },
    },
    handler: async (request, reply) => {
      if (!negotiatePublicationRead({
        accept: request.headers.accept,
        protocolVersion: request.headers['collection-protocol-version'],
        mediaType: DIRECTORY_BASE_MEDIA_TYPE,
        version: '0.1',
      })) {
        return sendPublicationProblem(reply, request.method, {
          code: 'unsupported_version', recovery: { supportedVersions: ['0.1'] },
        });
      }
      const session = await optionalSessionActor(request, dependencies.identityUnitOfWork, { bearer: 'ignore' });
      const cancellation = requestCancellation(request, reply);
      try {
        await admitExploreDirectoryRateLimit(
          dependencies.rateLimiter,
          session
            ? exploreDirectoryAccountSubject(session.account.id)
            : exploreDirectoryAnonymousSubject(request),
          'Too many Directory requests. Please try again later.',
        );
        const common = {
          endpoint: 'directory',
          method: request.method as 'GET' | 'HEAD',
          rawSearch: rawSearch(request),
          validators,
          ifNoneMatch: typeof request.headers['if-none-match'] === 'string'
            ? request.headers['if-none-match']
            : null,
          async resolveRepresentation(decoded: Readonly<Record<string, unknown>>) {
            const result = await (dependencies.reader ?? getPublicationDirectoryPage)(dependencies.query, {
              principal: session
                ? { kind: 'account', principalId: session.account.id, subjectId: session.account.subjectId }
                : { kind: 'anonymous' },
              query: decoded,
            }, cancellation.signal);
            const nextUrl = result.nextCursor
              ? createNextUrl(dependencies.config, decoded, result.nextCursor)
              : null;
            const headers = mergePublicationAntiDiscoveryHeaders({ Vary: directoryVary(request) });
            if (nextUrl) headers.set('Link', `<${nextUrl}>; rel="next"`);
            const latest = result.directory.collections
              .map((collection) => Date.parse(collection.updatedAt))
              .filter(Number.isFinite)
              .reduce((maximum, value) => Math.max(maximum, value), 0);
            return {
              value: result.directory,
              revision: 'directory-v1',
              projectionKey: result.projection === 'member' ? 'member-directory' : 'anonymous-public-directory',
              protocolVersion: '0.1',
              lastModified: new Date(latest),
              negotiatedMediaType: DIRECTORY_MEDIA_TYPE,
              pageIdentity: {
                ...(typeof decoded.cursor === 'string' ? { pageCursor: decoded.cursor } : {}),
                key: 'updatedAt-desc-id-asc',
              },
              headers,
            };
          },
        } as const;
        const response = session
          ? await composePublicationHttpRead({
              ...common,
              access: 'authorized-private',
              authorize: () => ({ allowed: true, context: null }),
              resolveRepresentation: async (decoded) => ({
                ...await common.resolveRepresentation(decoded),
                principalScope: `account:${session.account.id}`,
              }),
            })
          : await composePublicationHttpRead({ ...common, access: 'anonymous-public' });
        return sendFetchResponse(reply, response, request);
      } catch (error) {
        const limited = sendDirectoryRateLimitProblem(reply, request, error);
        if (limited !== undefined) return limited;
        if (isCacheAbortError(error) || cancellation.signal.aborted) return abortPublicationRead(reply);
        if (error instanceof PublicationDirectoryCursorError) {
          return sendPublicationProblem(reply, request.method, { code: 'invalid_cursor_scope' });
        }
        if (error instanceof PublicationDirectoryInvalidQueryError) {
          return sendPublicationProblem(reply, request.method, { code: 'invalid_query' });
        }
        if (error instanceof CacheFallbackRejectedError) {
          // Bounded overload while Redis is degraded (T-10): retryable 503, not a 500.
          reply.header('Retry-After', '1');
          return sendPublicationProblem(reply, request.method, { code: 'service_unavailable' });
        }
        throw error;
      } finally {
        cancellation.dispose();
      }
    },
  });
}

function sendDirectoryRateLimitProblem(
  reply: FastifyReply,
  request: FastifyRequest,
  error: unknown,
): FastifyReply | undefined {
  if (!(error instanceof ProductHttpError)) return undefined;
  if (error.productCode === 'rate_limited') {
    for (const [name, value] of Object.entries(error.headers)) reply.header(name, value);
    return sendPublicationProblem(reply, request.method, {
      code: 'rate_limited',
      ...(error.retryAfterSeconds === null
        ? {}
        : { recovery: { retryAfterSeconds: error.retryAfterSeconds } }),
    });
  }
  if (error.productCode === 'feature_temporarily_unavailable') {
    return sendPublicationProblem(reply, request.method, { code: 'service_unavailable' });
  }
  return undefined;
}

function createNextUrl(
  config: PublicationConfig,
  query: Readonly<Record<string, unknown>>,
  cursor: string,
): string {
  const next = new URL(config.endpoints.directory);
  for (const name of ['tag', 'creator', 'kind', 'updatedSince', 'q'] as const) {
    if (typeof query[name] === 'string') next.searchParams.set(name, query[name]);
  }
  if (typeof query.limit === 'number') next.searchParams.set('limit', String(query.limit));
  next.searchParams.set('cursor', cursor);
  return next.toString();
}

function rawSearch(request: FastifyRequest): string {
  const index = request.raw.url?.indexOf('?') ?? -1;
  return index < 0 ? '' : request.raw.url!.slice(index);
}

async function sendFetchResponse(
  reply: FastifyReply,
  response: Response,
  request: FastifyRequest,
): Promise<FastifyReply> {
  reply.code(response.status);
  response.headers.forEach((value, name) => reply.header(name, value));
  const headers = mergePublicationAntiDiscoveryHeaders({
    Vary: mergeVary(reply.getHeader('Vary'), directoryVary(request).split(',')),
  });
  headers.forEach((value, name) => reply.header(name, value));
  if (response.body === null) return reply.send();
  return reply.send(Buffer.from(await response.arrayBuffer()));
}

function directoryVary(request: FastifyRequest): string {
  const names = ['Accept', 'Collection-Protocol-Version', 'Cookie', 'Authorization'];
  if (request.headers.origin !== undefined) names.push('Origin');
  return names.join(', ');
}

function mergeVary(current: string | number | string[] | undefined, additions: readonly string[]): string {
  const values = new Map<string, string>();
  const existing = Array.isArray(current) ? current : current === undefined ? [] : [String(current)];
  for (const value of [...existing.flatMap((entry) => entry.split(',')), ...additions]) {
    const trimmed = value.trim();
    if (trimmed !== '') values.set(trimmed.toLowerCase(), trimmed);
  }
  if (values.has('*')) return '*';
  return [...values.values()].join(', ');
}
