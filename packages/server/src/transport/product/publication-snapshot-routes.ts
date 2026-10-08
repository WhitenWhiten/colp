import { createValidatorRegistry } from '@know-n/colp/schema';
import {
  composePublicationHttpRead,
  projectPublicationPublicWire,
  createPublicationProblemDescriptor,
  mergePublicationAntiDiscoveryHeaders,
  mergePublicationSnapshotNextLinkHeaders,
  PUBLICATION_SNAPSHOT_MEDIA_TYPE,
} from '@know-n/colp/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  getPublicationSnapshotPage,
  PublicationNotFoundError,
  PublicationSnapshotExpiredError,
  type PublicationSnapshotPageResult,
  type PublicationSnapshotQueryInput,
  type PublicationSnapshotQueryPorts,
} from '../../modules/publication/index.js';
import type { PublicationConfig } from '../../bootstrap/config.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import { CacheFallbackRejectedError, isCacheAbortError } from '../../infrastructure/cache/index.js';
import type { SearchRateLimiter } from '../../infrastructure/rate-limit/index.js';
import { optionalSessionActor } from '../session-auth.js';
import { negotiatePublicationRead } from './publication-read-negotiation.js';
import { abortPublicationRead, requestCancellation } from './publication-request-cancel.js';
import { ProductHttpError } from '../product-error.js';
import {
  admitExploreDirectoryRateLimit,
  exploreDirectoryAccountSubject,
  exploreDirectoryAnonymousSubject,
} from './explore-directory-rate-limit.js';

const SNAPSHOT_ROUTE = '/colp/v0.1/collections/:collectionId/snapshot';
const SNAPSHOT_MEDIA_TYPE = `${PUBLICATION_SNAPSHOT_MEDIA_TYPE};version=0.1`;
const SNAPSHOT_PROTOCOL_VERSION = '0.1';
const CURSOR_PATTERN = /^psc1\.p[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/u;
const validators = createValidatorRegistry();

/** T10 optional cache-aware reader (same call surface as getPublicationSnapshotPage). */
export type PublicationSnapshotRouteReader = (
  ports: PublicationSnapshotQueryPorts,
  input: PublicationSnapshotQueryInput,
  signal?: AbortSignal,
) => Promise<Omit<PublicationSnapshotPageResult, 'ownerSubjectId'>>;

export interface PublicationSnapshotRouteDependencies {
  readonly config: PublicationConfig;
  readonly query: PublicationSnapshotQueryPorts;
  readonly identityUnitOfWork?: IdentityUnitOfWork;
  /** T10 cache seam: defaults to the authoritative PostgreSQL reader. */
  readonly reader?: PublicationSnapshotRouteReader;
  readonly rateLimiter?: SearchRateLimiter;
}

export function registerPublicationSnapshotRoutes(
  app: FastifyInstance,
  dependencies: PublicationSnapshotRouteDependencies,
): void {
  app.route({
    method: ['GET', 'HEAD'],
    url: SNAPSHOT_ROUTE,
    config: {
      productTransport: {
        allowedQuery: ['root', 'depth', 'include', 'limit', 'pageCursor'],
        repeatableQuery: ['include'],
        cacheControl: 'public-revalidate',
      },
    },
    handler: async (request, reply) => {
      const accept = negotiatePublicationRead({
        accept: request.headers.accept,
        protocolVersion: request.headers['collection-protocol-version'],
        mediaType: PUBLICATION_SNAPSHOT_MEDIA_TYPE,
        version: SNAPSHOT_PROTOCOL_VERSION,
      });
      if (!accept) {
        return sendPublicationProblem(reply, request.method, {
          code: 'unsupported_version',
          recovery: { supportedVersions: ['0.1'] },
        });
      }
      const collectionId = (request.params as { collectionId?: unknown }).collectionId;
      if (typeof collectionId !== 'string' || !OPAQUE_ID_PATTERN.test(collectionId)) {
        return sendPublicationProblem(reply, request.method, { code: 'resource_not_found' });
      }
      const session = await optionalSessionActor(request, dependencies.identityUnitOfWork, { bearer: 'ignore' });
      const cancellation = requestCancellation(request, reply);
      try {
        await admitExploreDirectoryRateLimit(
          dependencies.rateLimiter,
          session
            ? exploreDirectoryAccountSubject(session.account.id)
            : exploreDirectoryAnonymousSubject(request),
          'Too many Snapshot requests. Please try again later.',
        );
        const common = {
          endpoint: 'snapshot',
          method: request.method as 'GET' | 'HEAD',
          rawSearch: rawSearch(request),
          validators,
          ifNoneMatch: singleHeader(request.headers['if-none-match']),
          async resolveRepresentation(decoded: Readonly<Record<string, unknown>>) {
            const pageCursor = decoded.pageCursor;
            if (pageCursor !== undefined && (typeof pageCursor !== 'string' || !CURSOR_PATTERN.test(pageCursor))) {
              throw new InvalidPublicationCursorError();
            }
            const result = await (dependencies.reader ?? getPublicationSnapshotPage)(dependencies.query, {
              collectionId,
              principal: session
                ? { kind: 'account', principalId: session.account.id, subjectId: session.account.subjectId }
                : { kind: 'anonymous' },
              query: decoded,
            }, cancellation.signal);
            if (!session && result.projection !== 'public') {
              throw new Error('Anonymous snapshots require the public scope projection.');
            }
            const wire = session ? result.snapshot : projectPublicationPublicWire(result.snapshot);
            const nextUrl = result.nextCursor === null
              ? null
              : createNextUrl(dependencies.config, collectionId, decoded, result.nextCursor);
            return {
              value: wire,
              principalScope: session ? `account:${session.account.id}` : `anonymous:${collectionId}`,
              revision: result.snapshot.revision,
              projectionKey: result.projection === 'member' ? 'member-snapshot' : 'anonymous-public',
              protocolVersion: SNAPSHOT_PROTOCOL_VERSION,
              lastModified: new Date(result.snapshot.generatedAt),
              negotiatedMediaType: SNAPSHOT_MEDIA_TYPE,
              snapshotIdentity: {
                snapshotId: result.snapshot.snapshotId,
                sequence: result.snapshot.page.sequence,
              },
              pageIdentity: {
                ...(typeof decoded.pageCursor === 'string' ? { pageCursor: decoded.pageCursor } : {}),
                pageNumber: result.snapshot.page.sequence,
              },
              headers: mergePublicationSnapshotNextLinkHeaders(wire, nextUrl, {
                Vary: snapshotVary(request),
              }, 'authorized-private'),
            };
          },
        } as const;
        // The producer checks the complete database scope, including ancestors
        // and sidecar endpoints on earlier pages. Serialize that authorized
        // projection, with public redaction applied to anonymous responses.
        const response = await composePublicationHttpRead({
          ...common,
          access: 'authorized-private',
          async authorize(decoded) {
            return { allowed: true, context: await common.resolveRepresentation(decoded) };
          },
          resolveRepresentation: (_decoded, representation) => representation,
        });
        if (!session && (response.status === 200 || response.status === 304)) {
          response.headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
        }
        return sendFetchResponse(reply, response, request);
      } catch (error) {
        const limited = sendPublicationRateLimitProblem(reply, request, error);
        if (limited !== undefined) return limited;
        if (isCacheAbortError(error) || cancellation.signal.aborted) return abortPublicationRead(reply);
        if (error instanceof InvalidPublicationCursorError) {
          return sendPublicationProblem(reply, request.method, { code: 'invalid_cursor_scope' });
        }
        if (error instanceof PublicationSnapshotExpiredError) {
          return sendPublicationProblem(reply, request.method, {
            code: 'snapshot_expired',
            recovery: { snapshotUrl: createSnapshotUrl(dependencies.config, collectionId) },
          });
        }
        if (error instanceof PublicationNotFoundError) {
          return sendPublicationProblem(reply, request.method, { code: 'resource_not_found' });
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

class InvalidPublicationCursorError extends Error {}

/** Maps Explore-family ProductHttpError onto COLP problem+json (Directory pattern). */
export function sendPublicationRateLimitProblem(
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


function snapshotVary(request: FastifyRequest): string {
  const names = ['Accept', 'Collection-Protocol-Version', 'Cookie', 'Authorization'];
  if (request.headers.origin !== undefined) names.push('Origin');
  return names.join(', ');
}

function rawSearch(request: FastifyRequest): string {
  const index = request.raw.url?.indexOf('?') ?? -1;
  return index < 0 ? '' : request.raw.url!.slice(index);
}

function singleHeader(value: string | readonly string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function createSnapshotUrl(config: PublicationConfig, collectionId: string): string {
  return config.endpoints.snapshot.replace('{collectionId}', encodeURIComponent(collectionId));
}

function createNextUrl(
  config: PublicationConfig,
  collectionId: string,
  query: Readonly<Record<string, unknown>>,
  cursor: string,
): string {
  const next = new URL(createSnapshotUrl(config, collectionId));
  if (typeof query.root === 'string') next.searchParams.set('root', query.root);
  if (typeof query.depth === 'number') next.searchParams.set('depth', String(query.depth));
  if (Array.isArray(query.include)) {
    for (const include of [...query.include].filter((value): value is string => typeof value === 'string').sort()) {
      next.searchParams.append('include', include);
    }
  }
  if (typeof query.limit === 'number') next.searchParams.set('limit', String(query.limit));
  next.searchParams.set('pageCursor', cursor);
  return next.toString();
}

async function sendFetchResponse(
  reply: FastifyReply,
  response: Response,
  request: FastifyRequest,
): Promise<FastifyReply> {
  reply.code(response.status);
  response.headers.forEach((value, name) => reply.header(name, value));
  if (response.status >= 400) {
    reply.header('Vary', mergeVary(reply.getHeader('Vary'), snapshotProblemVary(request)));
  }
  if (response.body === null) return reply.send();
  return reply.send(Buffer.from(await response.arrayBuffer()));
}

export function sendPublicationProblem(
  reply: FastifyReply,
  method: string,
  input: Parameters<typeof createPublicationProblemDescriptor>[0],
): FastifyReply {
  const descriptor = createPublicationProblemDescriptor(input);
  const body = Buffer.from(JSON.stringify(descriptor.problem), 'utf8');
  reply.code(descriptor.status)
    .header('Content-Type', descriptor.headers['content-type'])
    .header('Cache-Control', 'no-store');
  if (isDirectoryRequest(reply.request.url)) {
    const headers = mergePublicationAntiDiscoveryHeaders({
      Vary: mergeVary(reply.getHeader('Vary'), directoryProblemVary(reply.request)),
    });
    headers.forEach((value, name) => reply.header(name, value));
  } else if (isSnapshotRequest(reply.request.url)) {
    reply.header('Vary', mergeVary(reply.getHeader('Vary'), snapshotProblemVary(reply.request)));
  } else if (isMetadataRequest(reply.request.url)) {
    reply.header('Vary', mergeVary(reply.getHeader('Vary'), metadataProblemVary(reply.request)));
  } else if (isManifestRequest(reply.request.url)) {
    reply.header('Vary', mergeVary(reply.getHeader('Vary'), manifestProblemVary(reply.request)));
  }
  reply.header('Content-Length', String(body.byteLength));
  return method === 'HEAD' ? reply.send() : reply.send(body);
}

function isDirectoryRequest(url: string): boolean {
  return url.split('?', 1)[0] === '/colp/v0.1/directory';
}

function isSnapshotRequest(url: string): boolean {
  return url.split('?', 1)[0]?.endsWith('/snapshot') === true;
}

function isMetadataRequest(url: string): boolean {
  const pathname = url.split('?', 1)[0] ?? '';
  return pathname.startsWith('/colp/v0.1/collections/') || pathname.startsWith('/c/');
}

function isManifestRequest(url: string): boolean {
  return url.split('?', 1)[0] === '/.well-known/collection-protocol';
}

function manifestProblemVary(request: FastifyRequest): readonly string[] {
  const names = ['Accept', 'Collection-Protocol-Version'];
  if (request.headers.origin !== undefined) names.push('Origin');
  return names;
}

function metadataProblemVary(request: FastifyRequest): readonly string[] {
  const names = ['Accept', 'Collection-Protocol-Version', 'Cookie', 'Authorization'];
  if (request.headers.origin !== undefined) names.push('Origin');
  return names;
}

function snapshotProblemVary(request: FastifyRequest): readonly string[] {
  const names = ['Accept', 'Collection-Protocol-Version', 'Cookie', 'Authorization'];
  if (request.headers.origin !== undefined) names.push('Origin');
  return names;
}

function directoryProblemVary(request: FastifyRequest): readonly string[] {
  const names = ['Accept', 'Collection-Protocol-Version', 'Cookie', 'Authorization'];
  if (request.headers.origin !== undefined) names.push('Origin');
  return names;
}

function mergeVary(
  current: string | number | string[] | undefined,
  additions: readonly string[],
): string {
  const values = new Map<string, string>();
  const currentValues = Array.isArray(current) ? current : current === undefined ? [] : [String(current)];
  for (const value of [...currentValues.flatMap((entry) => entry.split(',')), ...additions]) {
    const trimmed = value.trim();
    if (trimmed !== '') values.set(trimmed.toLowerCase(), trimmed);
  }
  if (values.has('*')) return '*';
  return [...values.values()].join(', ');
}

export function sendPublicationFrameworkError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: { readonly statusCode?: number; readonly allowedMethods?: readonly string[] },
): FastifyReply {
  if (error.statusCode === 400) {
    return sendPublicationProblem(reply, request.method, { code: 'invalid_query' });
  }
  if (error.statusCode === 404) {
    return sendPublicationProblem(reply, request.method, { code: 'resource_not_found' });
  }
  if (error.statusCode === 405) {
    if (error.allowedMethods && error.allowedMethods.length > 0) {
      reply.header('Allow', error.allowedMethods.join(', '));
    }
    return sendPublicationProblem(reply, request.method, { code: 'method_not_allowed' });
  }
  return sendPublicationProblem(reply, request.method, { code: 'internal_error' });
}
