import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SearchRateLimiter } from '../infrastructure/rate-limit/index.js';
import {
  buildCollectionsSitemapUrlset,
  buildProfilesSitemapUrlset,
  type CollectionsSitemapEntry,
  type ProfilesSitemapEntry,
} from '../infrastructure/http/index.js';
import { sendPublicationRateLimitProblem } from './product/publication-snapshot-routes.js';
import { abortPublicationRead, requestCancellation } from './product/publication-request-cancel.js';
import {
  admitExploreDirectoryRateLimit,
  exploreDirectoryAnonymousSubject,
} from './product/explore-directory-rate-limit.js';

export const COLLECTIONS_SITEMAP_ROUTE = '/sitemap-collections.xml';
export const COLLECTIONS_SITEMAP_CONTENT_TYPE = 'application/xml; charset=utf-8';
export const COLLECTIONS_SITEMAP_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
export const COLLECTIONS_SITEMAP_CDN_CACHE_CONTROL = 'max-age=60';
export const COLLECTIONS_SITEMAP_VARY = 'Accept-Encoding';

export interface PublicationSitemapQueryPort {
  listIndexable(signal?: AbortSignal): Promise<readonly CollectionsSitemapEntry[]>;
}

export const PROFILES_SITEMAP_ROUTE = '/sitemap-profiles.xml';
export const PROFILES_SITEMAP_CONTENT_TYPE = COLLECTIONS_SITEMAP_CONTENT_TYPE;
export const PROFILES_SITEMAP_CACHE_CONTROL = COLLECTIONS_SITEMAP_CACHE_CONTROL;
export const PROFILES_SITEMAP_CDN_CACHE_CONTROL = COLLECTIONS_SITEMAP_CDN_CACHE_CONTROL;
export const PROFILES_SITEMAP_VARY = COLLECTIONS_SITEMAP_VARY;

export interface ProfileSitemapQueryPort {
  listIndexable(signal?: AbortSignal): Promise<readonly ProfilesSitemapEntry[]>;
}

export function registerCollectionsSitemapRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly query: PublicationSitemapQueryPort;
    readonly rateLimiter?: SearchRateLimiter;
    /** Governed mode revalidates at the edge on every request. */
    readonly contentGovernanceEnabled?: boolean;
  },
): void {
  app.route({
    method: ['GET', 'HEAD'],
    url: COLLECTIONS_SITEMAP_ROUTE,
    handler: async (request, reply) => {
      const cancellation = requestCancellation(request, reply);
      try {
        await admitExploreDirectoryRateLimit(
          dependencies.rateLimiter,
          exploreDirectoryAnonymousSubject(request),
          'Too many sitemap requests. Please try again later.',
        );
        const entries = await dependencies.query.listIndexable(cancellation.signal);
        const xml = buildCollectionsSitemapUrlset(entries);
        return sendSitemapBody(reply, request, xml, COLLECTIONS_SITEMAP_CONTENT_TYPE,
          dependencies.contentGovernanceEnabled === true);
      } catch (error) {
        const limited = sendPublicationRateLimitProblem(reply, request, error);
        if (limited !== undefined) return limited;
        if (cancellation.signal.aborted) return abortPublicationRead(reply);
        throw error;
      } finally {
        cancellation.dispose();
      }
    },
  });
}

export function registerProfilesSitemapRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly query: ProfileSitemapQueryPort;
    readonly rateLimiter?: SearchRateLimiter;
    /** Governed mode revalidates at the edge on every request. */
    readonly contentGovernanceEnabled?: boolean;
  },
): void {
  app.route({
    method: ['GET', 'HEAD'],
    url: PROFILES_SITEMAP_ROUTE,
    handler: async (request, reply) => {
      const cancellation = requestCancellation(request, reply);
      try {
        await admitExploreDirectoryRateLimit(
          dependencies.rateLimiter,
          exploreDirectoryAnonymousSubject(request),
          'Too many sitemap requests. Please try again later.',
        );
        const entries = await dependencies.query.listIndexable(cancellation.signal);
        const xml = buildProfilesSitemapUrlset(entries);
        return sendSitemapBody(reply, request, xml, PROFILES_SITEMAP_CONTENT_TYPE,
          dependencies.contentGovernanceEnabled === true);
      } catch (error) {
        const limited = sendPublicationRateLimitProblem(reply, request, error);
        if (limited !== undefined) return limited;
        if (cancellation.signal.aborted) return abortPublicationRead(reply);
        throw error;
      } finally {
        cancellation.dispose();
      }
    },
  });
}

function sendCollectionsSitemapBody(
  reply: FastifyReply,
  request: FastifyRequest,
  body: string,
): FastifyReply {
  return sendSitemapBody(reply, request, body, COLLECTIONS_SITEMAP_CONTENT_TYPE);
}

function sendSitemapBody(
  reply: FastifyReply,
  request: FastifyRequest,
  body: string,
  contentType: string,
  governed = false,
): FastifyReply {
  const buffer = Buffer.from(body, 'utf8');
  reply
    .code(200)
    .header('Content-Type', contentType)
    .header('Cache-Control', COLLECTIONS_SITEMAP_CACHE_CONTROL)
    .header('Vary', COLLECTIONS_SITEMAP_VARY)
    .header('Content-Length', String(buffer.byteLength));
  // Governed mode drops the Cloudflare CDN freshness override so the edge
  // falls back to `public, max-age=0, must-revalidate` and never serves a
  // pre-hide/delist URL list.
  if (!governed) reply.header('Cloudflare-CDN-Cache-Control', COLLECTIONS_SITEMAP_CDN_CACHE_CONTROL);
  return request.method === 'HEAD' ? reply.send() : reply.send(buffer);
}
