/**
 * LP-04 anonymous GET /api/v1/link-preview/:previewId — the same-origin
 * copy of a bookmark page's own sharing image. Shared public-object
 * admission, then a live public-attribution check. A stored UUID is not
 * enough: hide_public, a private collection, or a removed URL must 404.
 * Success caching is short and revalidated so a later 404 can take effect.
 */
import type { FastifyInstance } from 'fastify';
import {
  sniffBookmarkFaviconCanonicalMime,
  type BookmarkFaviconObjectStore,
} from '../../modules/collections/index.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { admitPublicObjectGet, type PublicObjectRateLimiter } from './public-object-rate-limit.js';
import { productReadDeadlineMs, requestCancellation } from './publication-request-cancel.js';

const LINK_PREVIEW_OBJECT_CACHE_CONTROL = 'public, max-age=60, must-revalidate';
const LINK_PREVIEW_MISSING_CACHE_CONTROL = 'public, max-age=60';
const LINK_PREVIEW_ID_PATTERN = /^[a-f0-9-]{36}$/u;
const SERVABLE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

export interface LinkPreviewRouteDependencies {
  readonly store: BookmarkFaviconObjectStore;
  readonly publicObjectRateLimiter: PublicObjectRateLimiter;
  /** Absent fails closed. Production wires the Postgres attribution check. */
  readonly linkPreviewPublicAccess?: { isServable(objectId: string, signal?: AbortSignal): Promise<boolean> };
  /** Handler deadline. Defaults to 30s; Fastify requestTimeout is not this deadline. */
  readonly handlerDeadlineMs?: number;
}

function linkPreviewNotFound(): ProductHttpError {
  return new ProductHttpError({
    statusCode: 404,
    code: 'resource_not_found',
    message: 'Preview image was not found.',
    recovery: 'none',
    headers: { 'Cache-Control': LINK_PREVIEW_MISSING_CACHE_CONTROL },
  });
}

export function registerLinkPreviewRoutes(app: FastifyInstance, deps: LinkPreviewRouteDependencies): void {
  app.get('/api/v1/link-preview/:previewId', {
    config: {
      ...productRouteMetadata('GET', '/api/v1/link-preview/{previewId}'),
      productTransport: { allowedQuery: [], cacheControl: 'public-revalidate' },
    },
  }, async (request, reply) => {
    const cancellation = requestCancellation(request, reply, deps.handlerDeadlineMs ?? productReadDeadlineMs(30_000));
    try {
    await admitPublicObjectGet(deps.publicObjectRateLimiter, request);
    const previewId = (request.params as { previewId?: string }).previewId ?? '';
    if (!LINK_PREVIEW_ID_PATTERN.test(previewId)) throw linkPreviewNotFound();
    if (!deps.linkPreviewPublicAccess || !await deps.linkPreviewPublicAccess.isServable(previewId, cancellation.signal)) {
      throw linkPreviewNotFound();
    }
    const stored = await deps.store.get(previewId, { signal: cancellation.signal });
    if (!stored) throw linkPreviewNotFound();
    // Declared Content-Type is ignored; only magic bytes decide what is served.
    const mime = sniffBookmarkFaviconCanonicalMime(stored.body);
    if (mime === null || !SERVABLE_MIME.has(mime)) throw linkPreviewNotFound();
    return reply
      .header('content-type', mime)
      .header('cache-control', LINK_PREVIEW_OBJECT_CACHE_CONTROL)
      .header('x-content-type-options', 'nosniff')
      .send(stored.body);
    } finally { cancellation.dispose(); }
  });
}
