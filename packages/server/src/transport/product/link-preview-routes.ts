/**
 * LP-04 GET /api/v1/link-preview/:previewId — the same-origin copy of a
 * bookmark page's own sharing image. Shared public-object admission, then a
 * live attribution check: a bookmark that anonymous readers can see, or a
 * signed-in reader's own collection. A stored UUID is not enough: a private
 * collection, hide_public or a removed URL must 404 at the origin. Cached
 * successes may remain usable for one day after access is revoked.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import {
  LINK_PREVIEW_CACHE_MAX_AGE_SECONDS,
  sniffBookmarkFaviconCanonicalMime,
  type LinkPreviewObjectStore,
} from '../../modules/collections/index.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireBrowserSessionActor } from '../session-auth.js';
import { admitPublicObjectGet, type PublicObjectRateLimiter } from './public-object-rate-limit.js';
import { abortPublicationRead, productReadDeadlineMs, requestCancellation } from './publication-request-cancel.js';

const LINK_PREVIEW_OBJECT_CACHE_CONTROL = `public, max-age=${LINK_PREVIEW_CACHE_MAX_AGE_SECONDS}, must-revalidate`;
const LINK_PREVIEW_PRIVATE_CACHE_CONTROL = `private, max-age=${LINK_PREVIEW_CACHE_MAX_AGE_SECONDS}, must-revalidate`;
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

function linkPreviewNotFound(privateRead: boolean): ProductHttpError {
  return new ProductHttpError({
    statusCode: 404,
    code: 'resource_not_found',
    message: 'Preview image was not found.',
    recovery: 'none',
    headers: { 'Cache-Control': privateRead ? 'private, no-store' : LINK_PREVIEW_MISSING_CACHE_CONTROL, Vary: 'Cookie' },
  });
}

export function registerLinkPreviewRoutes(app: FastifyInstance, deps: LinkPreviewRouteDependencies): void {
  app.get('/api/v1/link-preview/:previewId', {
    config: {
      ...productRouteMetadata('GET', '/api/v1/link-preview/{previewId}'),
      productTransport: { allowedQuery: [], cacheControl: 'public-revalidate' },
    },
  }, async (request, reply) => {
    await admitPublicObjectGet(deps.publicObjectRateLimiter, request);
    const privateRead = Boolean(request.headers.cookie);
    const previewId = (request.params as { previewId?: string }).previewId ?? '';
    if (!LINK_PREVIEW_ID_PATTERN.test(previewId)) throw linkPreviewNotFound(privateRead);
    const cancellation = requestCancellation(request, reply, productReadDeadlineMs(deps.requestTimeoutMs));
    let stored;
    let publicAccess: boolean;
    try {
      publicAccess = await deps.publicAccess.isServable(previewId, cancellation.signal);
      if (!publicAccess) {
        // A private Gallery: the signed-in owner or a member of a collection
        // holding a bookmark with this URL.
        if (!privateRead || deps.identityUnitOfWork === undefined) throw linkPreviewNotFound(privateRead);
        let subjectId: string;
        try {
          subjectId = (await requireBrowserSessionActor(request, deps.identityUnitOfWork, { touch: false })).account.subjectId;
        } catch (error) {
          if (error instanceof ProductHttpError && (error.statusCode === 401 || error.statusCode === 403)) {
            throw linkPreviewNotFound(true);
          }
          throw error;
        }
        if (!await deps.publicAccess.isReadableBySubject(previewId, subjectId)) throw linkPreviewNotFound(true);
      }
      stored = await deps.store.get(previewId, { signal: cancellation.signal });
    } catch (error) {
      if (cancellation.signal.aborted) return abortPublicationRead(reply);
      throw error;
    } finally {
      cancellation.dispose();
    }
    if (!stored) throw linkPreviewNotFound(privateRead);
    // Declared Content-Type is ignored; only magic bytes decide what is served.
    const mime = sniffBookmarkFaviconCanonicalMime(stored.body);
    if (mime === null || !SERVABLE_MIME.has(mime)) throw linkPreviewNotFound(privateRead);
    const etag = `"${createHash('sha256').update(stored.body).digest('hex')}"`;
    reply
      .header('content-type', mime)
      .header('cache-control', publicAccess ? LINK_PREVIEW_OBJECT_CACHE_CONTROL : LINK_PREVIEW_PRIVATE_CACHE_CONTROL)
      .header('etag', etag)
      .header('vary', 'Cookie')
      .header('x-content-type-options', 'nosniff');
    // Authorization and stored-image validation must precede every 304.
    if (matchesPreviewEtag(request.headers['if-none-match'], etag)) return reply.code(304).send();
    return reply.send(stored.body);
  });
}

/** GET uses weak comparison. Ignore malformed validators rather than accepting a partial match. */
function matchesPreviewEtag(value: string | undefined, etag: string): boolean {
  if (value === undefined) return false;
  if (value.trim() === '*') return true;
  const validators: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '"') quoted = !quoted;
    if (value[index] === ',' && !quoted) {
      validators.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quoted) return false;
  validators.push(value.slice(start).trim());
  return validators.every((item) => /^(?:W\/)?"[\x21\x23-\x7E\u0080-\u00FF]*"$/u.test(item))
    && validators.some((item) => item.replace(/^W\//u, '') === etag);
}
