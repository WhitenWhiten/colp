import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IdentityUnitOfWork } from '../modules/identity/index.js';
import {
  isCanonicalProductPublicCollectionSlug,
  type PublicationMetadataQueryPorts,
} from '../modules/publication/index.js';
import type { SearchRateLimiter } from '../infrastructure/rate-limit/index.js';
import {
  decidePublicShellVisibility,
  type CollectionOgImageRenderer,
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
import {
  applyPublicShellLastModified,
  loadOwner,
  loadPublicCollectionHeader,
  type PublicShellRoutePorts,
} from './public-shell-routes.js';

/**
 * Dynamic per-collection OG images (D1). One route serves the card the
 * stamped HTML shell points og:image at; see inject-collection-shell.ts and
 * docs/public-surfaces.md. Visibility, rate limiting, and cache-header
 * policy deliberately mirror the HTML shell: a collection whose HTML is a
 * generic 404 must not leak its title through a rendered image either.
 */
export const PUBLIC_OG_IMAGE_ROUTE = '/og/collections/:publicationSlug.png';
export const PUBLIC_OG_CONTENT_TYPE = 'image/png';
export const PUBLIC_OG_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
/** Same edge window as the HTML shell (PUBLIC_SHELL_CDN_CACHE_CONTROL). */
export const PUBLIC_OG_CDN_CACHE_CONTROL = 'max-age=60';

export function registerPublicOgImageRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly publicShellMeta: PublicShellMetaConfig;
    readonly query: PublicationMetadataQueryPorts;
    readonly renderer: CollectionOgImageRenderer;
    readonly identityUnitOfWork?: IdentityUnitOfWork;
    readonly publicShell?: PublicShellRoutePorts;
    readonly rateLimiter?: SearchRateLimiter;
    readonly contentGovernanceEnabled?: boolean;
  },
): void {
  app.route({
    method: ['GET', 'HEAD'],
    url: PUBLIC_OG_IMAGE_ROUTE,
    handler: async (request, reply) => {
      const publicationSlug = (request.params as { publicationSlug?: unknown }).publicationSlug;
      if (typeof publicationSlug !== 'string' || !isCanonicalProductPublicCollectionSlug(publicationSlug)) {
        return sendPublicationProblem(reply, request.method, { code: 'resource_not_found' });
      }
      if (!dependencies.publicShellMeta.enabled) {
        return sendPublicationProblem(reply, request.method, { code: 'resource_not_found' });
      }
      return respondWithCollectionOgImage(request, reply, dependencies, publicationSlug);
    },
  });
}

async function respondWithCollectionOgImage(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: Parameters<typeof registerPublicOgImageRoutes>[1],
  slug: string,
): Promise<FastifyReply> {
  const session = await optionalSessionActor(request, dependencies.identityUnitOfWork, { bearer: 'ignore' });
  const cancellation = requestCancellation(request, reply);
  try {
    await admitExploreDirectoryRateLimit(
      dependencies.rateLimiter,
      session
        ? exploreDirectoryAccountSubject(session.account.id)
        : exploreDirectoryAnonymousSubject(request),
      'Too many public collection image requests. Please try again later.',
    );
    if (dependencies.publicShell === undefined) {
      reply.header('Retry-After', '1');
      return sendPublicationProblem(reply, request.method, { code: 'service_unavailable' });
    }
    const header = await loadPublicCollectionHeader(dependencies.query, slug, cancellation.signal);
    const decision = decidePublicShellVisibility(header);
    applyPublicOgImageHeaders(reply, dependencies.contentGovernanceEnabled === true);
    if (decision.kind === 'generic-404') {
      return sendPublicationProblem(reply, request.method, { code: 'resource_not_found' });
    }
    const [itemCount, owner] = await Promise.all([
      dependencies.publicShell.loadNodeCountBySlug(slug),
      loadOwner(dependencies.publicShell, header!.ownerSubjectId),
    ]);
    const png = await dependencies.renderer.render({
      slug,
      title: header!.title,
      curator: owner.displayName,
      itemCount: itemCount ?? 0,
      updatedAt: header!.updatedAt,
    });
    applyPublicShellLastModified(reply, header!.updatedAt);
    reply.header('Content-Length', String(png.byteLength));
    if (request.method === 'HEAD') return reply.send();
    return reply.send(png);
  } catch (error) {
    const limited = sendPublicationRateLimitProblem(reply, request, error);
    if (limited !== undefined) return limited;
    if (cancellation.signal.aborted) return abortPublicationRead(reply);
    throw error;
  } finally {
    cancellation.dispose();
  }
}

function applyPublicOgImageHeaders(reply: FastifyReply, governed: boolean): void {
  // Images are documents-adjacent bytes: the API-only CSP/XFO/COOP headers
  // are meaningless on them but harmless; only cache policy matters here.
  reply
    .header('Content-Type', PUBLIC_OG_CONTENT_TYPE)
    .header('Cache-Control', PUBLIC_OG_CACHE_CONTROL);
  if (!governed) reply.header('Cloudflare-CDN-Cache-Control', PUBLIC_OG_CDN_CACHE_CONTROL);
}
