/**
 * LP-04 GET /api/v1/link-preview/:previewId — the same-origin copy of a
 * bookmark page's own sharing image. Shared public-object admission, then a
 * live attribution check: a bookmark that anonymous readers can see, or a
 * signed-in reader's own collection. A stored UUID is not enough: a private
 * collection, hide_public or a removed URL must 404 at the origin. Cached
 * successes may remain usable for up to fifteen days after access is revoked.
 */
import { createHash } from 'node:crypto';
import { matchesImageEtag } from './image-cache.js';
import type { FastifyInstance } from 'fastify';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import {
  IMAGE_ID_PATTERN, IMAGE_PUBLIC_MAX_AGE, IMAGE_PRIVATE_MAX_AGE,
  LINK_PREVIEW_CACHE_MAX_AGE_SECONDS,
  LINK_PREVIEW_CACHE_MIN_AGE_SECONDS,
  sniffBookmarkFaviconCanonicalMime,
  type LinkPreviewObjectStore,
} from '../../modules/collections/index.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireBrowserSessionActor } from '../session-auth.js';
import { admitPublicObjectGet, type PublicObjectRateLimiter } from './public-object-rate-limit.js';
import { abortPublicationRead, productReadDeadlineMs, requestCancellation } from './publication-request-cancel.js';

const LINK_PREVIEW_MISSING_CACHE_CONTROL = 'public, max-age=60';
const LINK_PREVIEW_ID_PATTERN = /^[a-f0-9-]{36}$/u;
const SERVABLE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

export interface LinkPreviewPublicAccess {
  isServable(objectId: string, signal?: AbortSignal): Promise<boolean>;
  isReadableBySubject(objectId: string, subjectId: string): Promise<boolean>;
}

export interface LinkPreviewRouteDependencies {
  readonly store: LinkPreviewObjectStore;
  readonly publicAccess: LinkPreviewPublicAccess;
  readonly publicObjectRateLimiter: PublicObjectRateLimiter;
  readonly identityUnitOfWork?: IdentityUnitOfWork;
  readonly requestTimeoutMs: number;
}

function linkPreviewNotFound(privateRead: boolean, uploaded = false): ProductHttpError {
  return new ProductHttpError({
    statusCode: 404,
    code: 'resource_not_found',
    message: 'Preview image was not found.',
    recovery: 'none',
    headers: { 'Cache-Control': privateRead || uploaded ? 'private, no-store' : LINK_PREVIEW_MISSING_CACHE_CONTROL, Vary: 'Cookie' },
  });
}

export function registerLinkPreviewRoutes(app: FastifyInstance, deps: LinkPreviewRouteDependencies): void {
  registerImageDeliveryRoute(app, deps, { path: '/api/v1/link-preview/:previewId', parameter: 'previewId', uploaded: false });
}

/** Shared admission, live authorization, validation and conditional delivery for immutable images. */
export function registerImageDeliveryRoute(
  app: FastifyInstance, deps: LinkPreviewRouteDependencies,
  options: { readonly path: string; readonly parameter: string; readonly uploaded: boolean },
): void {
  const missing = (privateRead: boolean) => linkPreviewNotFound(privateRead, options.uploaded);
  app.get(options.path, {
    config: {
      ...productRouteMetadata('GET', options.path),
      productTransport: { allowedQuery: [], cacheControl: 'public-revalidate' },
    },
  }, async (request, reply) => {
    await admitPublicObjectGet(deps.publicObjectRateLimiter, request);
    const privateRead = Boolean(request.headers.cookie);
    const previewId = (request.params as Record<string, string>)[options.parameter] ?? '';
    if (!(options.uploaded ? IMAGE_ID_PATTERN : LINK_PREVIEW_ID_PATTERN).test(previewId)) throw missing(privateRead);
    const cancellation = requestCancellation(request, reply, productReadDeadlineMs(deps.requestTimeoutMs));
    let stored;
    let publicAccess: boolean;
    try {
      publicAccess = await deps.publicAccess.isServable(previewId, cancellation.signal);
      if (!publicAccess) {
        // A private Gallery: the signed-in owner or a member of a collection
        // holding a bookmark with this URL.
        if (!privateRead || deps.identityUnitOfWork === undefined) throw missing(privateRead);
        let subjectId: string;
        try {
          subjectId = (await requireBrowserSessionActor(request, deps.identityUnitOfWork, { touch: false })).account.subjectId;
        } catch (error) {
          if (error instanceof ProductHttpError && (error.statusCode === 401 || error.statusCode === 403)) {
            throw missing(true);
          }
          throw error;
        }
        if (!await deps.publicAccess.isReadableBySubject(previewId, subjectId)) throw missing(true);
      }
      stored = await deps.store.get(previewId, { signal: cancellation.signal });
    } catch (error) {
      if (cancellation.signal.aborted) return abortPublicationRead(reply);
      throw error;
    } finally {
      cancellation.dispose();
    }
    if (!stored) throw missing(privateRead);
    // Declared Content-Type is ignored; only magic bytes decide what is served.
    const mime = sniffBookmarkFaviconCanonicalMime(stored.body);
    if (mime === null || !SERVABLE_MIME.has(mime)) throw missing(privateRead);
    const etag = `"${createHash('sha256').update(stored.body).digest('hex')}"`;
    // Stable per-object jitter spreads simultaneous loads across 7–15 days,
    // and stays consistent across revalidation, restarts and server replicas.
    const jitterRange = LINK_PREVIEW_CACHE_MAX_AGE_SECONDS - LINK_PREVIEW_CACHE_MIN_AGE_SECONDS + 1;
    const previewMaxAge = LINK_PREVIEW_CACHE_MIN_AGE_SECONDS
      + createHash('sha256').update(previewId).digest().readUInt32BE(0) % jitterRange;
    const maxAge = options.uploaded ? (publicAccess ? IMAGE_PUBLIC_MAX_AGE : IMAGE_PRIVATE_MAX_AGE) : previewMaxAge;
    reply
      .header('content-type', mime)
      .header('cache-control', `${publicAccess ? 'public' : 'private'}, max-age=${maxAge}, ${options.uploaded ? 'immutable' : 'must-revalidate'}`)
      .header('etag', etag)
      .header('vary', 'Cookie')
      .header('x-content-type-options', 'nosniff');
    // Authorization and stored-image validation must precede every 304.
    if (matchesImageEtag(request.headers['if-none-match'], etag)) return reply.code(304).send();
    return reply.send(stored.body);
  });
}
