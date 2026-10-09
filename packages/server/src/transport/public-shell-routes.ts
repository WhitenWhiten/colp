import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isCanonicalPublicProfileHandle, type IdentityUnitOfWork } from '../modules/identity/index.js';
import {
  isCanonicalProductPublicCollectionSlug,
  isHiddenPublicCollection,
  isRestrictedPublicCollection,
  type PublicationMetadataQueryPorts,
} from '../modules/publication/index.js';
import type { SearchRateLimiter } from '../infrastructure/rate-limit/index.js';
import {
  buildPublicCollectionMarkdown,
  buildPublicCollectionMarkdownNotFound,
  decidePublicShellVisibility,
  FALLBACK_CURATOR,
  injectPublicCollectionShell,
  PUBLIC_SHELL_MARKDOWN_CONTENT_TYPE,
  type PublicShellCollectionHeader,
  type PublicShellMarkdownNode,
  type PublicShellSurface,
  type WebShellCache,
} from '../infrastructure/http/index.js';
import type { PublicShellMetaConfig } from '../bootstrap/config.js';
import { publicHtmlEtag, publicHtmlMatches } from '../infrastructure/http/public-shell/html-validator.js';
import { optionalSessionActor } from './session-auth.js';
import { sendPublicationProblem, sendPublicationRateLimitProblem } from './product/publication-snapshot-routes.js';
import { abortPublicationRead, requestCancellation } from './product/publication-request-cancel.js';
import {
  admitExploreDirectoryRateLimit,
  exploreDirectoryAccountSubject,
  exploreDirectoryAnonymousSubject,
} from './product/explore-directory-rate-limit.js';

export const PUBLIC_SHELL_CONTENT_TYPE = 'text/html; charset=utf-8';
export const PUBLIC_SHELL_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
export const PUBLIC_SHELL_CDN_CACHE_CONTROL = 'max-age=60';
export const PUBLIC_SHELL_VARY = 'Accept, Accept-Encoding';

const SHARE_ROUTE = '/share/:publicationSlug';
const PATH_ROUTE = '/path/:publicationSlug';
const GRAPH_ROUTE = '/graph/:publicationSlug';
const WRAPPER_ROUTES = [[SHARE_ROUTE, 'share'], [PATH_ROUTE, 'path'], [GRAPH_ROUTE, 'graph']] as const;

export interface PublicShellRoutePorts {
  readonly cache: WebShellCache;
  readonly loadNodeCountBySlug: (slug: string) => Promise<number | null>;
  readonly loadOwnerDisplayName: (ownerSubjectId: string) => Promise<string | null>;
  /**
   * Owner's public Profile facts in one lookup. When present it supersedes
   * `loadOwnerDisplayName` and lets the HTML link `Curated by` to `/u/{handle}`.
   */
  readonly loadOwnerPublicProfile?: (
    ownerSubjectId: string,
  ) => Promise<{ readonly displayName: string; readonly handle: string } | null>;
  /**
   * T-21: one snapshot page (limit 500). Composition wraps
   * `getPublicationSnapshotPage`. Missing on HTML-only test doubles. Since
   * 2026-09-02 the HTML path reads it too, for the no-JS outline.
   */
  readonly loadSnapshotNodes?: (
    collectionId: string,
    signal?: AbortSignal,
  ) => Promise<readonly PublicShellMarkdownNode[] | null>;
  /**
   * Seed-registered collections among `collectionIds` (demo fixtures). They
   * render normally but carry `noindex`; absent on doubles → nothing excluded.
   */
  readonly excludedCollectionIds?: (
    collectionIds: readonly string[],
    signal?: AbortSignal,
  ) => Promise<ReadonlySet<string>>;
}

export async function searchIndexingExcluded(
  ports: Pick<PublicShellRoutePorts, 'excludedCollectionIds'> | undefined,
  collectionIds: readonly string[],
  signal?: AbortSignal,
): Promise<ReadonlySet<string>> {
  if (ports?.excludedCollectionIds === undefined) return new Set<string>();
  return ports.excludedCollectionIds(collectionIds, signal);
}

/**
 * R15-24: a browser that mistypes a public URL (non-canonical slug or handle,
 * unknown digest) gets the hydratable shell with 404, which renders the app's
 * own not-found page, instead of application/problem+json. Without a shell
 * the problem document is still the honest answer.
 */
export async function sendPublicShellHtmlNotFound(
  request: FastifyRequest,
  reply: FastifyReply,
  cache: WebShellCache | undefined,
  governed: boolean,
  rateLimiter?: SearchRateLimiter,
): Promise<FastifyReply> {
  // A mistyped public URL still renders the SPA shell. Charge the same
  // anonymous Explore budget before touching the shell cache or origin.
  if (cache !== undefined) {
    await admitExploreDirectoryRateLimit(
      rateLimiter,
      exploreDirectoryAnonymousSubject(request),
      'Too many public collection requests. Please try again later.',
    );
  }
  const loaded = cache === undefined ? undefined : await cache.load();
  if (loaded === undefined || loaded.kind === 'unavailable' || loaded.body === undefined) {
    return sendPublicationProblem(reply, request.method, { code: 'resource_not_found' });
  }
  applyPublicShellHeaders(reply, undefined, governed);
  return sendPublicShellBody(reply, request.method, 404, loaded.body);
}

export function registerPublicShellRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly publicShellMeta: PublicShellMetaConfig;
    readonly query: PublicationMetadataQueryPorts;
    readonly identityUnitOfWork?: IdentityUnitOfWork;
    readonly publicShell?: PublicShellRoutePorts;
    readonly rateLimiter?: SearchRateLimiter;
    /** Governed mode revalidates controlled HTML at the edge on every request. */
    readonly contentGovernanceEnabled?: boolean;
  },
): void {
  for (const [url, surface] of WRAPPER_ROUTES) {
    app.route({
      method: ['GET', 'HEAD'],
      url,
      handler: async (request, reply) => {
        const publicationSlug = (request.params as { publicationSlug?: unknown }).publicationSlug;
        if (typeof publicationSlug !== 'string' || !isCanonicalProductPublicCollectionSlug(publicationSlug)) {
          return sendPublicShellHtmlNotFound(
            request,
            reply,
            dependencies.publicShellMeta.enabled ? dependencies.publicShell?.cache : undefined,
            dependencies.contentGovernanceEnabled === true,
            dependencies.rateLimiter,
          );
        }
        if (!dependencies.publicShellMeta.enabled) {
          return sendPublicationProblem(reply, request.method, { code: 'resource_not_found' });
        }
        return respondWithPublicShellHtml(request, reply, {
          surface,
          slug: publicationSlug,
          query: dependencies.query,
          publicShell: dependencies.publicShell,
          identityUnitOfWork: dependencies.identityUnitOfWork,
          rateLimiter: dependencies.rateLimiter,
          contentGovernanceEnabled: dependencies.contentGovernanceEnabled === true,
        });
      },
    });
  }
}

export async function respondWithPublicShellHtml(
  request: FastifyRequest,
  reply: FastifyReply,
  input: {
    readonly surface: PublicShellSurface;
    readonly slug: string;
    readonly query: PublicationMetadataQueryPorts;
    readonly publicShell?: PublicShellRoutePorts;
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
      'Too many public collection requests. Please try again later.',
    );
    if (input.publicShell === undefined) {
      reply.header('Retry-After', '1');
      return sendPublicationProblem(reply, request.method, { code: 'service_unavailable' });
    }
    const shell = await input.publicShell.cache.load(cancellation.signal);
    if (shell.kind === 'unavailable' || shell.body === undefined) {
      reply.header('Retry-After', '1');
      return sendPublicationProblem(reply, request.method, { code: 'service_unavailable' });
    }
    const header = await loadPublicCollectionHeader(input.query, input.slug, cancellation.signal);
    const decision = decidePublicShellVisibility(header);
    applyPublicShellHeaders(reply, undefined, input.contentGovernanceEnabled === true);
    if (decision.kind === 'generic-404') {
      return sendPublicShellBody(reply, request.method, 404, shell.body);
    }
    const [itemCount, owner, nodes, excluded] = await Promise.all([
      input.publicShell.loadNodeCountBySlug(input.slug),
      loadOwner(input.publicShell, header!.ownerSubjectId),
      input.publicShell.loadSnapshotNodes === undefined
        ? Promise.resolve(null)
        : input.publicShell.loadSnapshotNodes(header!.id, cancellation.signal),
      searchIndexingExcluded(input.publicShell, [header!.id], cancellation.signal),
    ]);
    const html = injectPublicCollectionShell(shell.body, {
      surface: input.surface,
      slug: input.slug,
      collectionId: header!.id,
      title: header!.title,
      summary: header!.summary,
      curator: owner.displayName,
      curatorHandle: owner.handle,
      itemCount: itemCount ?? 0,
      updatedAt: header!.updatedAt,
      visibility: decision.visibility,
      searchIndexable: !excluded.has(header!.id),
      language: header!.language,
      nodes,
    });
    applyPublicShellLastModified(reply, header!.updatedAt);
    return sendPublicShellBody(reply, request.method, 200, html);
  } catch (error) {
    const limited = sendPublicationRateLimitProblem(reply, request, error);
    if (limited !== undefined) return limited;
    if (cancellation.signal.aborted) return abortPublicationRead(reply);
    throw error;
  } finally {
    cancellation.dispose();
  }
}

export async function respondWithPublicShellMarkdown(
  request: FastifyRequest,
  reply: FastifyReply,
  input: {
    readonly slug: string;
    readonly query: PublicationMetadataQueryPorts;
    readonly publicShell?: PublicShellRoutePorts;
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
      'Too many public collection requests. Please try again later.',
    );
    const governed = input.contentGovernanceEnabled === true;
    const header = await loadPublicCollectionHeader(input.query, input.slug, cancellation.signal);
    const decision = decidePublicShellVisibility(header);
    if (decision.kind === 'generic-404') {
      return sendPublicShellMarkdownNotFound(reply, request.method, governed);
    }
    if (input.publicShell?.loadSnapshotNodes === undefined) {
      reply.header('Retry-After', '1');
      return sendPublicationProblem(reply, request.method, { code: 'service_unavailable' });
    }
    const [itemCount, owner, nodes, excluded] = await Promise.all([
      input.publicShell.loadNodeCountBySlug(input.slug),
      loadOwner(input.publicShell, header!.ownerSubjectId),
      input.publicShell.loadSnapshotNodes(header!.id, cancellation.signal),
      searchIndexingExcluded(input.publicShell, [header!.id], cancellation.signal),
    ]);
    if (nodes === null) {
      return sendPublicShellMarkdownNotFound(reply, request.method, governed);
    }
    const markdown = buildPublicCollectionMarkdown({
      collectionId: header!.id,
      title: header!.title,
      summary: header!.summary,
      curator: owner.displayName,
      updatedAt: header!.updatedAt,
      visibility: decision.visibility,
      searchIndexable: !excluded.has(header!.id),
      nodes,
      nodeCount: itemCount ?? nodes.length,
    });
    applyPublicShellLastModified(reply, header!.updatedAt);
    return sendPublicShellMarkdownBody(reply, request.method, 200, markdown);
  } catch (error) {
    const limited = sendPublicationRateLimitProblem(reply, request, error);
    if (limited !== undefined) return limited;
    if (cancellation.signal.aborted) return abortPublicationRead(reply);
    throw error;
  } finally {
    cancellation.dispose();
  }
}

/** Display name bounded like before (1–120 chars, else the Know-N fallback); handle only when canonical. */
export async function loadOwner(
  ports: PublicShellRoutePorts,
  ownerSubjectId: string,
): Promise<{ readonly displayName: string; readonly handle: string | null }> {
  if (ports.loadOwnerPublicProfile !== undefined) {
    const owner = await ports.loadOwnerPublicProfile(ownerSubjectId);
    const displayName = owner?.displayName ?? null;
    return {
      displayName: boundedCurator(displayName),
      handle: owner !== null && isCanonicalPublicProfileHandle(owner.handle) ? owner.handle : null,
    };
  }
  return { displayName: boundedCurator(await ports.loadOwnerDisplayName(ownerSubjectId)), handle: null };
}

function boundedCurator(displayName: string | null): string {
  return displayName && displayName.length >= 1 && displayName.length <= 120 ? displayName : FALLBACK_CURATOR;
}

export function sendPublicShellMarkdownNotFound(
  reply: FastifyReply,
  method: string,
  governed = false,
): FastifyReply {
  return sendPublicShellMarkdownBody(reply, method, 404, buildPublicCollectionMarkdownNotFound(), governed);
}

export async function loadPublicCollectionHeader(
  query: PublicationMetadataQueryPorts,
  slug: string,
  signal: AbortSignal,
): Promise<PublicShellCollectionHeader | null> {
  const record = await query.reads.load({ publicationSlug: slug, signal });
  if (record === null) return null;
  if (await isHiddenPublicCollection(query.collectionControl, record.id, 'public')) return null;
  if (await isRestrictedPublicCollection(query.collectionControl, record.id, 'public')) return null;
  return mapHeader(record);
}

function mapHeader(record: {
  readonly id: string;
  readonly title: string;
  readonly summary: string | null;
  readonly visibility: 'private' | 'protected' | 'public' | 'unlisted';
  readonly ownerSubjectId: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly publicationSlug: string | null;
  readonly rootAvailable: boolean;
  readonly language: string | null;
}): PublicShellCollectionHeader {
  return {
    id: record.id,
    title: record.title,
    summary: record.summary,
    visibility: record.visibility,
    ownerSubjectId: record.ownerSubjectId,
    updatedAt: record.updatedAt,
    deletedAt: record.deletedAt,
    publicationSlug: record.publicationSlug,
    rootAvailable: record.rootAvailable,
    language: record.language,
  };
}

/**
 * API-baseline headers (installHttpSecurity onRequest) that must not reach a
 * browser document. `default-src 'none'` blocks the SPA's own script and
 * stylesheet, so every proxied /c, /share, /path, /u page painted blank;
 * X-Frame-Options / frame-ancestors would refuse the `/share/:slug?embed=1`
 * iframe; COOP same-origin severs OAuth popup openers. These API defaults are replaced by a document policy that permits SPA assets
 * while preserving the public share embedding contract.
 */
const API_ONLY_DOCUMENT_HEADERS = [
  'Content-Security-Policy',
  'X-Frame-Options',
  'Cross-Origin-Opener-Policy',
] as const;

export function applyPublicShellHeaders(
  reply: FastifyReply,
  contentType = PUBLIC_SHELL_CONTENT_TYPE,
  governed = false,
): void {
  for (const name of API_ONLY_DOCUMENT_HEADERS) reply.removeHeader(name);
  if (contentType.startsWith('text/html')) {
    const route = reply.request.routeOptions.url;
    const digestEmbed = (route === '/reports/:slug' || route === '/reports/:slug/issues/:editionId')
      && new URLSearchParams(reply.request.url.split('?')[1] ?? '').get('embed') === '1';
    const embeddedShare = route?.startsWith('/share/') === true || digestEmbed;
    reply.header('Content-Security-Policy', DOCUMENT_CSP + `; frame-ancestors ${embeddedShare ? '*' : "'none'"}`);
    if (!embeddedShare) reply.header('X-Frame-Options', 'DENY');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
  // Governed mode drops the Cloudflare CDN freshness override (max-age=60)
  // so the edge falls back to `public, max-age=0, must-revalidate` and
  // revalidates every request: a pre-hide HTML body must never be served
  // after hide_public/delist (x-cache-header-changes).
  reply
    .header('Content-Type', contentType)
    .header('Cache-Control', PUBLIC_SHELL_CACHE_CONTROL)
    .header('Vary', PUBLIC_SHELL_VARY);
  if (!governed) reply.header('Cloudflare-CDN-Cache-Control', PUBLIC_SHELL_CDN_CACHE_CONTROL);
}

/**
 * Timestamp policy for non-HTML representations (markdown, OG images).
 * The HTML sender removes this header: a collection timestamp cannot validate
 * the SPA build or all of the other inputs to an injected document.
 */
export function applyPublicShellLastModified(reply: FastifyReply, updatedAt: string | null | undefined): void {
  if (typeof updatedAt !== 'string') return;
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed)) return;
  reply.header('Last-Modified', new Date(parsed).toUTCString());
}

/** Newest instant among several `updatedAt` values, or null when none parse. */
export function newestInstant(values: readonly string[]): string | null {
  let newest: number | null = null;
  for (const value of values) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && (newest === null || parsed > newest)) newest = parsed;
  }
  return newest === null ? null : new Date(newest).toISOString();
}

export function sendPublicShellBody(
  reply: FastifyReply,
  method: string,
  status: 200 | 404,
  body: string,
): FastifyReply {
  const buffer = Buffer.from(body, 'utf8');
  if (String(reply.getHeader('Content-Type')).startsWith('text/html')) {
    // Collection timestamps do not describe the injected SPA build. In particular,
    // an edge may turn an origin 200 into 304 for a browser's old date validator.
    reply.removeHeader('Last-Modified');
    if (status === 200 && (method === 'GET' || method === 'HEAD')) {
      const etag = publicHtmlEtag(buffer);
      reply.header('ETag', etag);
      const condition = reply.request.headers['if-none-match'];
      if (publicHtmlMatches(typeof condition === 'string' ? condition : undefined, etag)) {
        reply.removeHeader('Content-Length');
        return reply.code(304).send();
      }
    }
  }
  reply.code(status).header('Content-Length', String(buffer.byteLength));
  return method === 'HEAD' ? reply.send() : reply.send(buffer);
}

export function sendPublicShellMarkdownBody(
  reply: FastifyReply,
  method: string,
  status: 200 | 404,
  body: string,
  governed = false,
): FastifyReply {
  applyPublicShellHeaders(reply, PUBLIC_SHELL_MARKDOWN_CONTENT_TYPE, governed);
  return sendPublicShellBody(reply, method, status, body);
}

const DOCUMENT_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; font-src 'self' data:; connect-src 'self' https:; media-src 'self' https: blob:; frame-src https:; object-src 'none'; base-uri 'self'; form-action 'self'";
