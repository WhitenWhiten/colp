import { createValidatorRegistry } from '@know-n/colp/schema';
import {
  composePublicationHttpRead,
  createPublicationDeletedCollectionGoneResponse,
  createPublicationDeletedCollectionTombstone,
  mergePublicationCollectionMetadataLinkHeaders,
  PUBLICATION_COLLECTION_METADATA_MEDIA_TYPE,
} from '@know-n/colp/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import { CacheFallbackRejectedError, isCacheAbortError } from '../../infrastructure/cache/index.js';
import {
  getPublicationCollectionMetadata,
  isCanonicalProductPublicCollectionSlug,
  PublicationMetadataNotFoundError,
  type PublicationMetadataQueryInput,
  type PublicationMetadataQueryPorts,
  type PublicationMetadataResult,
} from '../../modules/publication/index.js';
import type { PublicationConfig, PublicShellMetaConfig } from '../../bootstrap/config.js';
import { wantsColpCanonicalTombstone, wantsPublicShellMarkdown } from '../../infrastructure/http/index.js';
import { optionalSessionActor } from '../session-auth.js';
import { ProductHttpError } from '../product-error.js';
import { sendPublicationProblem, sendPublicationRateLimitProblem } from './publication-snapshot-routes.js';
import { negotiatePublicationRead } from './publication-read-negotiation.js';
import { abortPublicationRead, requestCancellation } from './publication-request-cancel.js';
import type { SearchRateLimiter } from '../../infrastructure/rate-limit/index.js';
import {
  admitExploreDirectoryRateLimit,
  exploreDirectoryAccountSubject,
  exploreDirectoryAnonymousSubject,
} from './explore-directory-rate-limit.js';
import {
  respondWithPublicShellHtml,
  respondWithPublicShellMarkdown,
  sendPublicShellHtmlNotFound,
  sendPublicShellMarkdownNotFound,
  type PublicShellRoutePorts,
} from '../public-shell-routes.js';

const METADATA_ROUTE = '/colp/v0.1/collections/:collectionId';
const CANONICAL_ROUTE = '/c/:publicationSlug';
const METADATA_MEDIA_TYPE = `${PUBLICATION_COLLECTION_METADATA_MEDIA_TYPE};version=0.1`;
const METADATA_PROTOCOL_VERSION = '0.1';
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/u;
const validators = createValidatorRegistry();

/** T10 optional cache-aware reader (same call surface as getPublicationCollectionMetadata). */
export type PublicationMetadataRouteReader = (
  ports: PublicationMetadataQueryPorts,
  input: PublicationMetadataQueryInput,
  signal?: AbortSignal,
) => Promise<PublicationMetadataResult>;

export function registerPublicationMetadataRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly config: PublicationConfig;
    readonly query: PublicationMetadataQueryPorts;
    readonly identityUnitOfWork?: IdentityUnitOfWork;
    /** T10 cache seam: defaults to the authoritative PostgreSQL reader. */
    readonly reader?: PublicationMetadataRouteReader;
    readonly rateLimiter?: SearchRateLimiter;
    readonly publicShellMeta?: PublicShellMetaConfig;
    readonly publicShell?: PublicShellRoutePorts;
    /** Governed mode revalidates controlled HTML at the edge on every request. */
    readonly contentGovernanceEnabled?: boolean;
  },
): void {
  app.route({
    method: ['GET', 'HEAD'],
    url: METADATA_ROUTE,
    config: { productTransport: { allowedQuery: [], cacheControl: 'public-revalidate' } },
    handler: async (request, reply) => {
      if (!negotiatePublicationRead({
        accept: request.headers.accept,
        protocolVersion: request.headers['collection-protocol-version'],
        mediaType: PUBLICATION_COLLECTION_METADATA_MEDIA_TYPE,
        version: METADATA_PROTOCOL_VERSION,
      })) {
        return sendPublicationProblem(reply, request.method, {
          code: 'unsupported_version', recovery: { supportedVersions: ['0.1'] },
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
          'Too many Metadata requests. Please try again later.',
        );
        const result = await (dependencies.reader ?? getPublicationCollectionMetadata)(dependencies.query, {
          collectionId,
          principal: session
            ? { kind: 'account', principalId: session.account.id, subjectId: session.account.subjectId }
            : { kind: 'anonymous' },
        }, cancellation.signal);
        if (result.kind === 'gone') {
          return sendPublicationProblem(reply, request.method, { code: 'resource_not_found' });
        }
        const representation = {
          value: result.metadata,
          revision: result.revision,
          projectionKey: result.projection === 'member' ? 'member-metadata' : 'anonymous-public-metadata',
          protocolVersion: METADATA_PROTOCOL_VERSION,
          lastModified: new Date(result.updatedAt),
          negotiatedMediaType: METADATA_MEDIA_TYPE,
          headers: mergePublicationCollectionMetadataLinkHeaders(result.metadata, {
            Vary: metadataVary(request),
          }),
        };
        const common = {
          endpoint: 'metadata' as const,
          method: request.method as 'GET' | 'HEAD',
          rawSearch: '',
          validators,
          ifNoneMatch: typeof request.headers['if-none-match'] === 'string'
            ? request.headers['if-none-match']
            : null,
        };
        const response = result.projection === 'member' && session
          ? await composePublicationHttpRead({
              ...common,
              access: 'authorized-private',
              authorize: () => ({ allowed: true, context: null }),
              resolveRepresentation: () => ({
                ...representation,
                principalScope: `account:${session.account.id}`,
              }),
            })
          : await composePublicationHttpRead({
              ...common,
              access: 'anonymous-public',
              resolveRepresentation: () => representation,
            });
        return sendFetchResponse(reply, response, request);
      } catch (error) {
        const limited = sendPublicationRateLimitProblem(reply, request, error);
        if (limited !== undefined) return limited;
        if (error instanceof PublicationMetadataNotFoundError) {
          return sendPublicationProblem(reply, request.method, { code: 'resource_not_found' });
        }
        if (isCacheAbortError(error) || cancellation.signal.aborted) return abortPublicationRead(reply);
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

  app.route({
    method: ['GET', 'HEAD'],
    url: CANONICAL_ROUTE,
    config: { productTransport: { cacheControl: 'private-no-store' } },
    handler: async (request, reply) => {
      const publicationSlug = (request.params as { publicationSlug?: unknown }).publicationSlug;
      const accept = singleAccept(request.headers.accept);
      const markdown = wantsPublicShellMarkdown(accept);
      const colp = wantsColpCanonicalTombstone({
        accept,
        protocolVersion: request.headers['collection-protocol-version'],
      });
      if (colp && Object.keys(request.query as object).length > 0) {
        throw new ProductHttpError({
          statusCode: 400,
          code: 'invalid_query',
          message: 'The query contains an unsupported parameter.',
        });
      }
      if (typeof publicationSlug !== 'string' || !isCanonicalProductPublicCollectionSlug(publicationSlug)) {
        if (markdown && !colp) {
          return sendPublicShellMarkdownNotFound(reply, request.method, dependencies.contentGovernanceEnabled === true);
        }
        if (!colp && dependencies.publicShellMeta?.enabled === true) {
          return sendPublicShellHtmlNotFound(
            request,
            reply,
            dependencies.publicShell?.cache,
            dependencies.contentGovernanceEnabled === true,
            dependencies.rateLimiter,
          );
        }
        return sendPublicationProblem(reply, request.method, { code: 'resource_not_found' });
      }
      if (!colp) {
        if (dependencies.publicShellMeta?.enabled !== true) {
          return markdown
            ? sendPublicShellMarkdownNotFound(reply, request.method, dependencies.contentGovernanceEnabled === true)
            : sendPublicationProblem(reply, request.method, { code: 'resource_not_found' });
        }
        if (markdown) {
          return respondWithPublicShellMarkdown(request, reply, {
            slug: publicationSlug,
            query: dependencies.query,
            ...(dependencies.publicShell === undefined ? {} : { publicShell: dependencies.publicShell }),
            ...(dependencies.identityUnitOfWork === undefined
              ? {}
              : { identityUnitOfWork: dependencies.identityUnitOfWork }),
            rateLimiter: dependencies.rateLimiter,
            contentGovernanceEnabled: dependencies.contentGovernanceEnabled === true,
          });
        }
        return respondWithPublicShellHtml(request, reply, {
          surface: 'c',
          slug: publicationSlug,
          query: dependencies.query,
          ...(dependencies.publicShell === undefined ? {} : { publicShell: dependencies.publicShell }),
          ...(dependencies.identityUnitOfWork === undefined
            ? {}
            : { identityUnitOfWork: dependencies.identityUnitOfWork }),
          rateLimiter: dependencies.rateLimiter,
          contentGovernanceEnabled: dependencies.contentGovernanceEnabled === true,
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
          'Too many Metadata requests. Please try again later.',
        );
        const result = await (dependencies.reader ?? getPublicationCollectionMetadata)(dependencies.query, {
          publicationSlug,
          principal: session
            ? { kind: 'account', principalId: session.account.id, subjectId: session.account.subjectId }
            : { kind: 'anonymous' },
        }, cancellation.signal);
        if (result.kind !== 'gone') {
          return sendPublicationProblem(reply, request.method, { code: 'resource_not_found' });
        }
        const response = createPublicationDeletedCollectionGoneResponse(
          new Request(result.canonicalUrl, { method: request.method }),
          createPublicationDeletedCollectionTombstone({
            canonicalUrl: result.canonicalUrl,
            deletedAt: new Date(result.deletedAt),
          }),
          { now: () => dependencies.query.now?.() ?? new Date() },
        );
        if (response === null) return sendPublicationProblem(reply, request.method, { code: 'resource_not_found' });
        return sendFetchResponse(reply, response, request);
      } catch (error) {
        const limited = sendPublicationRateLimitProblem(reply, request, error);
        if (limited !== undefined) return limited;
        if (error instanceof PublicationMetadataNotFoundError) {
          return sendPublicationProblem(reply, request.method, { code: 'resource_not_found' });
        }
        if (isCacheAbortError(error) || cancellation.signal.aborted) return abortPublicationRead(reply);
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

function singleAccept(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.join(',');
  return value;
}

function metadataVary(request: FastifyRequest): string {
  const names = ['Accept', 'Collection-Protocol-Version', 'Cookie', 'Authorization'];
  if (request.headers.origin !== undefined) names.push('Origin');
  return names.join(', ');
}

async function sendFetchResponse(
  reply: FastifyReply,
  response: Response,
  request: FastifyRequest,
): Promise<FastifyReply> {
  reply.code(response.status);
  response.headers.forEach((value, name) => reply.header(name, value));
  reply.header('Vary', mergeVary(reply.getHeader('Vary'), metadataVary(request)));
  if (response.body === null) return reply.send();
  return reply.send(Buffer.from(await response.arrayBuffer()));
}

function mergeVary(current: string | number | string[] | undefined, additions: string): string {
  const values = new Map<string, string>();
  const existing = Array.isArray(current) ? current : current === undefined ? [] : [String(current)];
  for (const value of [...existing.flatMap((entry) => entry.split(',')), ...additions.split(',')]) {
    const trimmed = value.trim();
    if (trimmed !== '') values.set(trimmed.toLowerCase(), trimmed);
  }
  return [...values.values()].join(', ');
}
