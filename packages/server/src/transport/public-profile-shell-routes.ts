import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IdentityUnitOfWork } from '../modules/identity/index.js';
import { isCanonicalPublicProfileHandle } from '../modules/identity/index.js';
import type { SearchRateLimiter } from '../infrastructure/rate-limit/index.js';
import {
  buildPublicProfileMarkdown,
  buildPublicProfileMarkdownNotFound,
  injectPublicProfileShell,
  PUBLIC_SHELL_MARKDOWN_CONTENT_TYPE,
  wantsPublicShellMarkdown,
  type PublicProfileShellCollection,
  type WebShellCache,
} from '../infrastructure/http/index.js';
import type { PublicShellMetaConfig } from '../bootstrap/config.js';
import { optionalSessionActor } from './session-auth.js';
import { sendPublicationProblem, sendPublicationRateLimitProblem } from './product/publication-snapshot-routes.js';
import { abortPublicationRead, requestCancellation } from './product/publication-request-cancel.js';
import {
  admitExploreDirectoryRateLimit,
  exploreDirectoryAccountSubject,
  exploreDirectoryAnonymousSubject,
} from './product/explore-directory-rate-limit.js';
import type { PublicProfileProjection as ProductPublicProfileProjection } from '../bootstrap/public-profile-projection.js';

interface ProductPublicProfileQuery {
  get(input: { readonly handle: string; readonly limit?: number }): Promise<ProductPublicProfileProjection>;
}
import {
  applyPublicShellHeaders,
  applyPublicShellLastModified,
  newestInstant,
  searchIndexingExcluded,
  sendPublicShellBody,
  sendPublicShellHtmlNotFound,
  sendPublicShellMarkdownBody,
} from './public-shell-routes.js';

const PUBLIC_PROFILE_ROUTE = '/u/:handle';
const LEGACY_PROFILE_ROUTE = '/profile/:handle';
const PUBLIC_PROFILE_COLLECTION_LIMIT = 100;

export interface PublicProfileShellRoutePorts {
  readonly cache: WebShellCache;
  /** Seed-registered collection ids: listed on the Profile but not counted for indexability. */
  readonly excludedCollectionIds?: (
    collectionIds: readonly string[],
    signal?: AbortSignal,
  ) => Promise<ReadonlySet<string>>;
}

export function registerPublicProfileShellRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly config: PublicShellMetaConfig;
    readonly query: ProductPublicProfileQuery;
    readonly publicShell?: PublicProfileShellRoutePorts;
    readonly identityUnitOfWork?: IdentityUnitOfWork;
    readonly rateLimiter?: SearchRateLimiter;
    /** Governed mode revalidates controlled HTML at the edge on every request. */
    readonly contentGovernanceEnabled?: boolean;
  },
): void {
  app.route({
    method: ['GET', 'HEAD'],
    url: PUBLIC_PROFILE_ROUTE,
    handler: async (request, reply) => {
      const handle = canonicalHandle(request);
      if (!dependencies.config.enabled) return sendProfileNotFound(request, reply);
      if (handle === null) return sendProfileNotFound(request, reply, dependencies);
      return respondWithPublicProfileShell(request, reply, {
        handle,
        ...dependencies,
      });
    },
  });

  app.route({
    method: ['GET', 'HEAD'],
    url: LEGACY_PROFILE_ROUTE,
    handler: async (request, reply) => {
      const handle = canonicalHandle(request);
      if (!dependencies.config.enabled) return sendProfileNotFound(request, reply);
      if (handle === null) return sendProfileNotFound(request, reply, dependencies);
      const location = `/u/${encodeURIComponent(handle)}`;
      const body = Buffer.from(`Moved permanently to ${location}\n`, 'utf8');
      reply
        .code(301)
        .header('Location', location)
        .header('Content-Type', 'text/plain; charset=utf-8')
        .header('Content-Length', String(body.byteLength));
      return request.method === 'HEAD' ? reply.send() : reply.send(body);
    },
  });
}

async function respondWithPublicProfileShell(
  request: FastifyRequest,
  reply: FastifyReply,
  input: {
    readonly handle: string;
    readonly query: ProductPublicProfileQuery;
    readonly publicShell?: PublicProfileShellRoutePorts;
    readonly identityUnitOfWork?: IdentityUnitOfWork;
    readonly rateLimiter?: SearchRateLimiter;
    readonly contentGovernanceEnabled?: boolean;
  },
): Promise<FastifyReply> {
  const session = await optionalSessionActor(request, input.identityUnitOfWork, { bearer: 'ignore' });
  const cancellation = requestCancellation(request, reply);
  try {
    await admitExploreDirectoryRateLimit(
      input.rateLimiter,
      session
        ? exploreDirectoryAccountSubject(session.account.id)
        : exploreDirectoryAnonymousSubject(request),
      'Too many public Profile requests. Please try again later.',
    );
    const markdown = wantsPublicShellMarkdown(singleAccept(request));
    let shell: string | undefined;
    if (!markdown) {
      if (input.publicShell === undefined) {
        reply.header('Retry-After', '1');
        return sendPublicationProblem(reply, request.method, { code: 'service_unavailable' });
      }
      const loaded = await input.publicShell.cache.load(cancellation.signal);
      if (loaded.kind === 'unavailable' || loaded.body === undefined) {
        reply.header('Retry-After', '1');
        return sendPublicationProblem(reply, request.method, { code: 'service_unavailable' });
      }
      shell = loaded.body;
    }

    let projection: ProductPublicProfileProjection;
    try {
      projection = await input.query.get({
        handle: input.handle,
        limit: PUBLIC_PROFILE_COLLECTION_LIMIT,
      });
    } catch (error) {
      if (hasErrorCode(error, 'resource_not_found')) {
        if (markdown) return sendProfileMarkdownNotFound(reply, request.method, input.contentGovernanceEnabled === true);
        applyPublicShellHeaders(reply, undefined, input.contentGovernanceEnabled === true);
        return sendPublicShellBody(reply, request.method, 404, shell!);
      }
      throw error;
    }
    if (projection.profile.handle !== input.handle
        || !isCanonicalPublicProfileHandle(projection.profile.handle)) {
      throw new Error('public Profile authority returned a mismatched canonical handle');
    }
    const excluded = await searchIndexingExcluded(
      input.publicShell,
      projection.collections.map((collection) => collection.id),
      cancellation.signal,
    );
    const profile = {
      handle: projection.profile.handle,
      displayName: projection.profile.displayName,
      bio: projection.profile.about,
      collections: projection.collections.map((collection) => mapCollection(collection, excluded)),
      hasMoreCollections: projection.page.hasMore,
    };
    // The Profile document changes when its newest public collection changes.
    applyPublicShellLastModified(reply, newestInstant(profile.collections.map((collection) => collection.updatedAt)));
    if (markdown) {
      return sendPublicShellMarkdownBody(
        reply,
        request.method,
        200,
        buildPublicProfileMarkdown(profile),
        input.contentGovernanceEnabled === true,
      );
    }
    applyPublicShellHeaders(reply, undefined, input.contentGovernanceEnabled === true);
    return sendPublicShellBody(
      reply,
      request.method,
      200,
      injectPublicProfileShell(shell!, profile),
    );
  } catch (error) {
    const limited = sendPublicationRateLimitProblem(reply, request, error);
    if (limited !== undefined) return limited;
    if (cancellation.signal.aborted) return abortPublicationRead(reply);
    throw error;
  } finally {
    cancellation.dispose();
  }
}

function canonicalHandle(request: FastifyRequest): string | null {
  const handle = (request.params as { handle?: unknown }).handle;
  return typeof handle === 'string' && isCanonicalPublicProfileHandle(handle) ? handle : null;
}

function mapCollection(
  collection: ProductPublicProfileProjection['collections'][number],
  excluded: ReadonlySet<string>,
): PublicProfileShellCollection {
  return {
    slug: collection.slug,
    title: collection.title,
    updatedAt: collection.updatedAt,
    ...(excluded.has(collection.id) ? { searchIndexable: false as const } : {}),
  };
}

/** With `shellFor`, an HTML request gets the styled shell 404 (R15-24). */
function sendProfileNotFound(
  request: FastifyRequest,
  reply: FastifyReply,
  shellFor?: {
    readonly publicShell?: PublicProfileShellRoutePorts;
    readonly contentGovernanceEnabled?: boolean;
    readonly rateLimiter?: SearchRateLimiter;
  },
): FastifyReply | Promise<FastifyReply> {
  if (wantsPublicShellMarkdown(singleAccept(request))) return sendProfileMarkdownNotFound(reply, request.method);
  if (shellFor !== undefined) {
    return sendPublicShellHtmlNotFound(
      request,
      reply,
      shellFor.publicShell?.cache,
      shellFor.contentGovernanceEnabled === true,
      shellFor.rateLimiter,
    );
  }
  return sendPublicationProblem(reply, request.method, { code: 'resource_not_found' });
}

function sendProfileMarkdownNotFound(reply: FastifyReply, method: string, governed = false): FastifyReply {
  applyPublicShellHeaders(reply, PUBLIC_SHELL_MARKDOWN_CONTENT_TYPE, governed);
  return sendPublicShellBody(reply, method, 404, buildPublicProfileMarkdownNotFound());
}

function singleAccept(request: FastifyRequest): string | undefined {
  const accept = request.headers.accept;
  return typeof accept === 'string' ? accept : undefined;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { readonly code?: unknown }).code === code;
}
