import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../bootstrap/config.js';
import {
  BOOKMARK_FAVICON_MAX_BYTES,
  BookmarkFaviconCommandError,
  BookmarkFaviconImageError,
  BookmarkFaviconValidationError,
  CollectionAuthorizationError,
  assertBookmarkFaviconImage,
  deleteBookmarkFavicon,
  uploadBookmarkFavicon,
  type BookmarkFaviconObjectStore,
  type CollectionsUnitOfWork,
} from '../../modules/collections/index.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import { readCollectionIdParam, readKnownCommandId, readNodeIdParam } from './collection-route-helpers.js';
import type { ExtensionCollectionRouteDependencies } from '../colp-sync/extension-collection-routes.js';
import { mapAuthorizationOutcome } from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import {
  admitPublicObjectGet,
  createPublicObjectRateLimiter,
  type PublicObjectRateLimiter,
} from './public-object-rate-limit.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { authenticationRequired, requireSessionActor } from '../session-auth.js';
import { requireMutationActor } from '../mutation-actor.js';

// A favicon can be withdrawn when its bookmark/collection publication state
// changes. Keep shared caches on a short revalidation window so the positive
// liveness check is consulted promptly after a withdrawal.
const FAVICON_OBJECT_CACHE_CONTROL = 'public, max-age=30, must-revalidate';
const FAVICON_MISSING_CACHE_CONTROL = 'public, max-age=60';
const FAVICON_ID_PATTERN = /^[a-f0-9-]{36}$/iu;
const PRODUCT_FAVICON_ROUTE = '/api/v1/collections/:collectionId/nodes/:nodeId/favicon';
const FAVICON_ACCEPTED_MEDIA_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'application/octet-stream',
]);

export interface BookmarkFaviconRouteDependencies {
  readonly config: AppConfig;
  readonly faviconStore?: BookmarkFaviconObjectStore;
  readonly identityUnitOfWork?: IdentityUnitOfWork;
  readonly collectionsUnitOfWork?: CollectionsUnitOfWork;
  readonly extensionCollectionRoutes?: ExtensionCollectionRouteDependencies;
  readonly metrics?: { increment(name: string, value?: number): void };
  /** Positive current-public binding check for the requested object. */
  readonly faviconPublicAccess?: { isPubliclyAccessible(objectId: string): Promise<boolean> };
  /**
   * Optional in-process limiter for public GET /api/v1/favicon/:faviconId.
   * Defaults to a per-process `public-object` family. Not the auth `me`
   * family. AUTH_API_REPLICAS>1 does not share this budget across replicas.
   */
  readonly publicObjectRateLimiter?: PublicObjectRateLimiter;
}

function faviconNotFound(): ProductHttpError {
  return new ProductHttpError({
    statusCode: 404,
    code: 'resource_not_found',
    message: 'Favicon was not found.',
    recovery: 'none',
    headers: { 'Cache-Control': FAVICON_MISSING_CACHE_CONTROL },
  });
}

function featureUnavailable(message: string): ProductHttpError {
  return new ProductHttpError({
    statusCode: 503,
    code: 'feature_temporarily_unavailable',
    message,
    recovery: 'none',
  });
}

function addFaviconBodyParser(app: FastifyInstance, type: string): void {
  if (app.hasContentTypeParser(type)) return;
  app.addContentTypeParser(type, { parseAs: 'buffer' }, (_request, body, done) => {
    if (!Buffer.isBuffer(body)) {
      done(new ProductHttpError({
        statusCode: 400,
        code: 'invalid_request',
        message: 'Favicon body must be a buffer.',
        recovery: 'user_action',
      }), undefined);
      return;
    }
    done(null, body);
  });
}

function increment(metrics: BookmarkFaviconRouteDependencies['metrics'], name: string): void {
  try {
    metrics?.increment(name);
  } catch {
    // Telemetry must not alter product behavior.
  }
}

function mapFaviconWriteError(error: unknown): never {
  if (error instanceof ProductHttpError) throw error;
  if (error instanceof CollectionAuthorizationError) {
    throw mapAuthorizationOutcome(error.outcome);
  }
  if (error instanceof BookmarkFaviconValidationError) {
    throw new ProductHttpError({
      statusCode: 400,
      code: 'invalid_request',
      message: error.message,
      recovery: 'user_action',
    });
  }
  if (error instanceof BookmarkFaviconCommandError) {
    throw new ProductHttpError({
      statusCode: error.code === 'payload_too_large' ? 413 : 400,
      code: error.code,
      message: error.message,
      recovery: 'user_action',
    });
  }
  throw error;
}

function sendFaviconCommandResult(
  reply: FastifyReply,
  result: Awaited<ReturnType<typeof uploadBookmarkFavicon>>,
): FastifyReply {
  if (result.kind === 'created') {
    return reply.code(200).header('cache-control', 'private, no-store').send(result.view);
  }
  if (result.kind === 'replay') {
    for (const [name, value] of Object.entries(result.result.stableHeaders)) {
      reply.header(name, value);
    }
    return reply.code(result.result.status).send(Buffer.from(result.result.body));
  }
  if (result.kind === 'in_progress') {
    throw new ProductHttpError({
      statusCode: 429,
      code: 'rate_limited',
      message: 'This favicon command is still in progress. Please retry the request.',
      recovery: 'same_request',
      sameRequestRetrySafe: true,
      retryAfterSeconds: result.retryAfterSeconds,
      headers: { 'Retry-After': String(result.retryAfterSeconds) },
    });
  }
  if (result.kind === 'reused') {
    throw new ProductHttpError({
      statusCode: 409,
      code: 'command_id_reused',
      message: 'This command id was already used with a different favicon request.',
      recovery: 'user_action',
    });
  }
  throw new ProductHttpError({
    statusCode: 410,
    code: 'command_result_expired',
    message: 'The stored result for this favicon command has expired.',
    recovery: 'user_action',
  });
}

function requireFaviconWriteDeps(deps: BookmarkFaviconRouteDependencies): {
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly collectionsUnitOfWork: CollectionsUnitOfWork;
  readonly faviconStore: BookmarkFaviconObjectStore;
} {
  if (!deps.faviconStore) {
    throw featureUnavailable('Bookmark favicon storage is not available on this deployment.');
  }
  if (!deps.identityUnitOfWork || !deps.collectionsUnitOfWork) {
    throw featureUnavailable('Bookmark favicon writes are not available on this deployment.');
  }
  return {
    identityUnitOfWork: deps.identityUnitOfWork,
    collectionsUnitOfWork: deps.collectionsUnitOfWork,
    faviconStore: deps.faviconStore,
  };
}

function declaredContentType(request: FastifyRequest): string {
  return (request.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

export function registerBookmarkFaviconRoutes(
  app: FastifyInstance,
  deps: BookmarkFaviconRouteDependencies,
): void {
  if (deps.config.productRouteRateLimitShared.enabled && deps.publicObjectRateLimiter === undefined) {
    throw new Error(
      'Bookmark favicon routes require an injected public-object limiter when PRODUCT_ROUTE_RATE_LIMIT_SHARED=true',
    );
  }
  const publicObjectRateLimiter =
    deps.publicObjectRateLimiter ?? createPublicObjectRateLimiter();
  for (const type of FAVICON_ACCEPTED_MEDIA_TYPES) {
    addFaviconBodyParser(app, type);
  }

  const uploadTransport = {
    allowedQuery: [] as const,
    acceptedMediaTypes: [...FAVICON_ACCEPTED_MEDIA_TYPES],
    bodyLimitBytes: BOOKMARK_FAVICON_MAX_BYTES,
    cacheControl: 'private-no-store' as const,
  };

  if (deps.faviconStore) {
    const faviconStore = deps.faviconStore;
    app.get('/api/v1/favicon/:faviconId', {
      config: {
        ...productRouteMetadata('GET', '/api/v1/favicon/{faviconId}'),
        productTransport: {
          allowedQuery: [],
          cacheControl: 'public-revalidate',
        },
      },
    }, async (request, reply) => {
      await admitPublicObjectGet(publicObjectRateLimiter, request);
      const faviconId = (request.params as { faviconId?: string }).faviconId ?? '';
      if (!faviconId || !FAVICON_ID_PATTERN.test(faviconId)) {
        throw faviconNotFound();
      }
      // A historical object id is never sufficient for public access. The
      // injected authority must confirm the object is still bound to a live,
      // publicly visible bookmark/collection/ancestor chain.
      if (!deps.faviconPublicAccess || !(await deps.faviconPublicAccess.isPubliclyAccessible(faviconId))) {
        throw faviconNotFound();
      }
      const stored = await faviconStore.get(faviconId);
      if (!stored) {
        throw faviconNotFound();
      }
      let contentType: string;
      try {
        contentType = assertBookmarkFaviconImage(stored.body);
      } catch (error: unknown) {
        if (error instanceof BookmarkFaviconImageError) {
          throw faviconNotFound();
        }
        throw error;
      }
      return reply
        .header('content-type', contentType)
        .header('cache-control', FAVICON_OBJECT_CACHE_CONTROL)
        .header('x-content-type-options', 'nosniff')
        .send(stored.body);
    });
  }

  app.post(PRODUCT_FAVICON_ROUTE, {
    config: {
      ...productRouteMetadata('POST', PRODUCT_FAVICON_ROUTE),
      productTransport: uploadTransport,
    },
  }, async (request, reply) => {
    await handleProductUpload(request, reply, deps);
  });

  app.delete(PRODUCT_FAVICON_ROUTE, {
    config: {
      ...productRouteMetadata('DELETE', PRODUCT_FAVICON_ROUTE),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: [],
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    await handleProductDelete(request, reply, deps);
  });
}

async function handleProductUpload(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: BookmarkFaviconRouteDependencies,
): Promise<FastifyReply> {
  if (!deps.identityUnitOfWork) throw authenticationRequired();
  const { account } = await requireMutationActor(request, {
    identityUnitOfWork: deps.identityUnitOfWork,
    allowedOrigins: deps.config.allowedOrigins,
  });
  const writes = requireFaviconWriteDeps(deps);
  const commandId = readKnownCommandId(request);
  const collectionId = readCollectionIdParam(request);
  const nodeId = readNodeIdParam(request);
  const body = request.body;
  if (!Buffer.isBuffer(body)) {
    throw new ProductHttpError({
      statusCode: 400,
      code: 'invalid_request',
      message: 'Favicon body must be a buffer.',
      recovery: 'user_action',
    });
  }
  try {
    const result = await writes.collectionsUnitOfWork.execute(async (ports) => {
      if (!ports.bookmarkIcons || !ports.faviconGc) {
        throw featureUnavailable('Bookmark favicon bindings are not available on this deployment.');
      }
      return uploadBookmarkFavicon({
        receipts: ports.receipts,
        clock: ports.clock,
        collections: ports.collections,
        nodes: ports.nodes,
        accessPolicy: ports.accessPolicyFacts,
        bookmarkIcons: ports.bookmarkIcons,
        faviconSources: ports.faviconSources,
        faviconGc: ports.faviconGc,
        faviconStore: writes.faviconStore,
        onOrphanCleanupFailure: () => increment(deps.metrics, 'bookmark_favicon.r2_delete.failed'),
        // FO-C-02: an object that never became a binding must be retired in a
        // FRESH transaction — the command transaction is aborted/rolled back
        // on every path that reaches this runner (F-A1 semantics).
        orphanLedger: async (input) => {
          await writes.collectionsUnitOfWork.execute(async (tx) => {
            const current = await tx.bookmarkIcons?.findByNodeId(input.nodeId);
            if (current !== null && current !== undefined && current.objectId === input.objectId) return;
            await tx.faviconGc?.recordRetired({
              objectId: input.objectId,
              nodeId: input.nodeId,
              collectionId: input.collectionId,
              retiredAt: input.at,
              deletableAt: input.at,
            });
          });
        },
      }, {
        actor: { principalId: account.id, subjectId: account.subjectId },
        commandId,
        collectionId,
        nodeId,
        body,
        contentType: declaredContentType(request),
        productOrigin: deps.config.productOrigin,
      });
    });
    if (result.kind === 'created' || result.kind === 'replay') {
      increment(deps.metrics, 'bookmark_favicon.result.ok');
    }
    return sendFaviconCommandResult(reply, result);
  } catch (error: unknown) {
    recordFaviconFailure(deps.metrics, error);
    mapFaviconWriteError(error);
  }
}

async function handleProductDelete(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: BookmarkFaviconRouteDependencies,
): Promise<FastifyReply> {
  if (!deps.identityUnitOfWork) throw authenticationRequired();
  const { account } = await requireMutationActor(request, {
    identityUnitOfWork: deps.identityUnitOfWork,
    allowedOrigins: deps.config.allowedOrigins,
  });
  const writes = requireFaviconWriteDeps(deps);
  const commandId = readKnownCommandId(request);
  const collectionId = readCollectionIdParam(request);
  const nodeId = readNodeIdParam(request);
  try {
    const result = await writes.collectionsUnitOfWork.execute(async (ports) => {
      if (!ports.bookmarkIcons || !ports.faviconGc) {
        throw featureUnavailable('Bookmark favicon bindings are not available on this deployment.');
      }
      return deleteBookmarkFavicon({
        receipts: ports.receipts,
        clock: ports.clock,
        collections: ports.collections,
        nodes: ports.nodes,
        accessPolicy: ports.accessPolicyFacts,
        bookmarkIcons: ports.bookmarkIcons,
        faviconSources: ports.faviconSources,
        faviconGc: ports.faviconGc,
        faviconStore: writes.faviconStore,
        onOrphanCleanupFailure: () => increment(deps.metrics, 'bookmark_favicon.r2_delete.failed'),
        orphanLedger: async (input) => {
          await writes.collectionsUnitOfWork.execute(async (tx) => {
            const current = await tx.bookmarkIcons?.findByNodeId(input.nodeId);
            if (current !== null && current !== undefined && current.objectId === input.objectId) return;
            await tx.faviconGc?.recordRetired({
              objectId: input.objectId,
              nodeId: input.nodeId,
              collectionId: input.collectionId,
              retiredAt: input.at,
              deletableAt: input.at,
            });
          });
        },
      }, {
        actor: { principalId: account.id, subjectId: account.subjectId },
        commandId,
        collectionId,
        nodeId,
        productOrigin: deps.config.productOrigin,
      });
    });
    if (result.kind === 'created' || result.kind === 'replay') {
      increment(deps.metrics, 'bookmark_favicon.result.ok');
    }
    return sendFaviconCommandResult(reply, result);
  } catch (error: unknown) {
    recordFaviconFailure(deps.metrics, error);
    mapFaviconWriteError(error);
  }
}

function recordFaviconFailure(
  metrics: BookmarkFaviconRouteDependencies['metrics'],
  error: unknown,
): void {
  if (error instanceof BookmarkFaviconCommandError && error.code === 'payload_too_large') {
    increment(metrics, 'bookmark_favicon.result.too_large');
    return;
  }
  if (error instanceof CollectionAuthorizationError) {
    increment(metrics, 'bookmark_favicon.result.denied');
  }
}
