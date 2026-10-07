import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../bootstrap/config.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import {
  BOOKMARK_FAVICON_MAX_BYTES,
  CollectionAuthorizationError,
  CollectionPreconditionError,
  FaviconHelperCaptureCommandError,
  FaviconSourceCommandError,
  captureBookmarkFavicon,
  clearCapturedBookmarkFavicon,
  getBookmarkFaviconSource,
  getMyFaviconPolicy,
  iconSourceEtag,
  INITIAL_FAVICON_SOURCE_REVISION,
  faviconPolicyEtag,
  toFaviconPolicyDto,
  toIconSourceDto,
  type BookmarkFaviconObjectStore,
  type CollectionsUnitOfWork,
  type CollectionsWritePorts,
  type FaviconPolicyRow,
  type GetBookmarkFaviconSourcePorts,
  type IconSourceView,
  type FaviconHelperCapturePorts,
} from '../../modules/collections/index.js';
import { ExtensionAuthError, type VerifiedExtensionCredential } from '../../modules/identity/index.js';
import type { ProductAdmissionRateLimiter } from '../http-security.js';
import { consumeProductAdmission, rateLimitClientKey } from '../http-security.js';
import { mapAuthorizationOutcome } from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import { mapFaviconPolicyRouteError, mapFaviconSourceRouteError, withCancellation } from '../product/favicon-policy-routes.js';
import { readCollectionIdParam, readKnownCommandId, readNodeIdParam, readRequiredIfMatch } from '../product/collection-route-helpers.js';
import type { ExtensionCollectionRouteDependencies } from './extension-collection-routes.js';
import { colpAuthorizationFromRawHeaders } from './sync-colp-authorization.js';

export const EXTENSION_FAVICON_POLICY_PATH = '/colp/v0.1/sync/favicon-policy';
export const EXTENSION_FAVICON_SOURCE_PATH = '/colp/v0.1/sync/collections/:collectionId/nodes/:nodeId/favicon-source';
export const EXTENSION_FAVICON_CAPTURE_PATH = '/colp/v0.1/sync/collections/:collectionId/nodes/:nodeId/favicon';

const POLICY_REVISION_PATTERN = /^[1-9][0-9]{0,18}$/u;
const FAVICON_ACCEPTED_MEDIA_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'application/octet-stream',
]);

export interface SyncFaviconHelperRouteDependencies {
  /** KNOWN_FEATURE_FAVICON_POLICY gate; false => every helper operation 404. */
  readonly enabled: boolean;
  readonly extensionCollectionRoutes?: ExtensionCollectionRouteDependencies;
  readonly identityUnitOfWork?: IdentityUnitOfWork;
  readonly collectionsUnitOfWork?: CollectionsUnitOfWork;
  readonly faviconStore?: BookmarkFaviconObjectStore;
  readonly productOrigin: string;
  /**
   * Shared Product admission limiter. Optional like the sync admission policy:
   * SYNC-Q-014 forbids COLP-sync routes minting a route-local fixed-window
   * limiter, so an absent shared limiter means the helper runs without local
   * rate limiting (the deployment injects the Redis adapter when
   * PRODUCT_ROUTE_RATE_LIMIT_SHARED=true).
   */
  readonly rateLimiter?: ProductAdmissionRateLimiter;
  readonly timeoutMs: number;
  readonly metrics?: { increment(name: string, value?: number): void };
}

type HelperPorts = CollectionsWritePorts & {
  readonly faviconSources: NonNullable<CollectionsWritePorts['faviconSources']>;
  readonly faviconPolicies: NonNullable<CollectionsWritePorts['faviconPolicies']>;
  readonly bookmarkIcons: NonNullable<CollectionsWritePorts['bookmarkIcons']>;
  readonly faviconGc: NonNullable<CollectionsWritePorts['faviconGc']>;
  /**
   * F-A8: pending force-restore lookup (restorable projection). The write
   * port carries the per-node `findByNodeId` the icon-source projection needs
   * (`faviconRestoreRead` only lists by account); absent ⇒ fail closed.
   */
  readonly faviconRestores: import('../../modules/collections/index.js').FaviconSourceRestoreWritePort;
};

function requireHelperPorts(ports: CollectionsWritePorts): asserts ports is HelperPorts {
  const candidate = ports as HelperPorts;
  if (candidate.faviconSources === undefined || candidate.faviconPolicies === undefined
      || candidate.bookmarkIcons === undefined || candidate.faviconGc === undefined
      || candidate.faviconRestores === undefined) {
    throw featureUnavailable('Bookmark favicon helper storage is not available on this deployment.');
  }
}

/** FO-04: the four helper operations reuse the COLP extension credential authority. */
export function registerSyncFaviconHelperRoutes(
  app: FastifyInstance,
  deps: SyncFaviconHelperRouteDependencies,
): void {
  if (!Number.isInteger(deps.timeoutMs) || deps.timeoutMs < 1 || deps.timeoutMs > 30_000) {
    throw new TypeError('Favicon helper route timeout is outside the application budget.');
  }
  const exposure = async (): Promise<void> => {
    // FO-04 feature flag off => 404 with no new feature resources exposed.
    if (!deps.enabled) throw notFound();
  };
  const privateTransport = {
    duplicateQueryErrorCode: 'invalid_query' as const,
    queryErrorCode: 'invalid_query' as const,
    allowedQuery: [] as const,
    cacheControl: 'private-no-store' as const,
  };
  const policyAdmission = admission(deps, EXTENSION_FAVICON_POLICY_PATH);
  const sourceAdmission = admission(deps, EXTENSION_FAVICON_SOURCE_PATH);
  const captureAdmission = admission(deps, EXTENSION_FAVICON_CAPTURE_PATH);

  app.get(EXTENSION_FAVICON_POLICY_PATH, {
    exposeHeadRoute: false,
    config: {
      productTransport: privateTransport,
    },
    onRequest: policyAdmission,
  }, async (request, reply) => {
    await exposure();
    rejectNonemptyBody(request);
    const actor = await helperActor(request, deps);
    try {
      const row: FaviconPolicyRow = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.collectionsUnitOfWork!.execute((ports) => {
          requireHelperPorts(ports);
          return getMyFaviconPolicy(
            { policies: ports.faviconPolicies },
            { principalId: actor.principalId, virtualUpdatedAt: actor.createdAt },
          );
        }, { signal }));
      return reply
        .code(200)
        .header('cache-control', 'private, no-store')
        .header('ETag', faviconPolicyEtag(row.revision))
        .send(toFaviconPolicyDto(row));
    } catch (error) {
      throw mapFaviconPolicyRouteError(error);
    }
  });

  app.get(EXTENSION_FAVICON_SOURCE_PATH, {
    exposeHeadRoute: false,
    config: {
      productTransport: privateTransport,
    },
    onRequest: sourceAdmission,
  }, async (request, reply) => {
    await exposure();
    rejectNonemptyBody(request);
    const actor = await helperActor(request, deps);
    const collectionId = readCollectionIdParam(request);
    const nodeId = readNodeIdParam(request);
    try {
      const view: IconSourceView = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.collectionsUnitOfWork!.execute((ports) => {
          requireHelperPorts(ports);
          return getBookmarkFaviconSource(sourceQueryPorts(ports), {
            actor,
            collectionId,
            nodeId,
            productOrigin: deps.productOrigin,
          });
        }, { signal }));
      return sendSource(reply, view);
    } catch (error) {
      throw mapFaviconSourceRouteError(error);
    }
  });

  app.post(EXTENSION_FAVICON_CAPTURE_PATH, {
    exposeHeadRoute: false,
    config: {
      productTransport: {
        ...privateTransport,
        acceptedMediaTypes: [...FAVICON_ACCEPTED_MEDIA_TYPES],
        bodyLimitBytes: BOOKMARK_FAVICON_MAX_BYTES,
      },
    },
    onRequest: captureAdmission,
  }, async (request, reply) => {
    await exposure();
    const actor = await helperActor(request, deps);
    const commandId = readKnownCommandId(request);
    const ifMatch = readRequiredIfMatch(request);
    const policyRevision = readRequiredPolicyRevision(request);
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
      const result = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.collectionsUnitOfWork!.execute(async (ports) => {
          requireHelperPorts(ports);
          const outcome = await captureBookmarkFavicon(capturePorts(ports, deps), {
            actor,
            commandId,
            collectionId,
            nodeId,
            body,
            contentType: declaredContentType(request),
            productOrigin: deps.productOrigin,
            expectedSourceEtag: ifMatch,
            expectedPolicyRevision: policyRevision,
          });
          return { outcome, etag: await helperResponseEtag(ports, outcome, collectionId, nodeId) };
        }, { signal }));
      return sendHelperCommandResult(reply, result.outcome, result.etag);
    } catch (error) {
      throw mapFaviconHelperRouteError(error);
    }
  });

  app.delete(EXTENSION_FAVICON_CAPTURE_PATH, {
    exposeHeadRoute: false,
    config: {
      productTransport: {
        ...privateTransport,
        acceptedMediaTypes: [],
      },
    },
    onRequest: captureAdmission,
  }, async (request, reply) => {
    await exposure();
    const actor = await helperActor(request, deps);
    const commandId = readKnownCommandId(request);
    const ifMatch = readRequiredIfMatch(request);
    const policyRevision = readRequiredPolicyRevision(request);
    const collectionId = readCollectionIdParam(request);
    const nodeId = readNodeIdParam(request);
    rejectNonemptyBody(request);
    try {
      const result = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.collectionsUnitOfWork!.execute(async (ports) => {
          requireHelperPorts(ports);
          const outcome = await clearCapturedBookmarkFavicon(capturePorts(ports, deps), {
            actor,
            commandId,
            collectionId,
            nodeId,
            productOrigin: deps.productOrigin,
            expectedSourceEtag: ifMatch,
            expectedPolicyRevision: policyRevision,
          });
          return { outcome, etag: await helperResponseEtag(ports, outcome, collectionId, nodeId) };
        }, { signal }));
      return sendHelperCommandResult(reply, result.outcome, result.etag);
    } catch (error) {
      throw mapFaviconHelperRouteError(error);
    }
  });
}

function sourceQueryPorts(ports: HelperPorts): GetBookmarkFaviconSourcePorts {
  return {
    collections: ports.collections,
    nodes: ports.nodes,
    accessPolicy: ports.accessPolicyFacts,
    sources: ports.faviconSources,
    policies: ports.faviconPolicies,
    bookmarkIcons: ports.bookmarkIcons,
    // F-A8: pending force-restore lookup drives the restorable projection.
    restores: ports.faviconRestores,
  };
}

function capturePorts(
  ports: HelperPorts,
  deps: SyncFaviconHelperRouteDependencies,
): FaviconHelperCapturePorts {
  return {
    receipts: ports.receipts,
    clock: ports.clock,
    collections: ports.collections,
    nodes: ports.nodes,
    accessPolicy: ports.accessPolicyFacts,
    sources: ports.faviconSources,
    policies: ports.faviconPolicies,
    bookmarkIcons: ports.bookmarkIcons,
    faviconStore: deps.faviconStore!,
    gc: ports.faviconGc,
    onOrphanCleanupFailure: () => deps.metrics?.increment('favicon_helper.r2_delete.failed'),
    // FO-C-02: fresh-transaction ledger; the helper tx is already aborted.
    orphanLedger: async (input) => {
      await deps.collectionsUnitOfWork!.execute(async (tx) => {
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
  };
}

/**
 * FO-04 helper credentials: the original COLP extension credential authority
 * (session cookie preferred, then Bearer), an allowed extension Origin, and
 * an active account bound by ownerSubject, not the raw credential subject.
 * Never a Product session/CSRF surface.
 */
async function helperActor(
  request: FastifyRequest,
  deps: SyncFaviconHelperRouteDependencies,
): Promise<{ readonly principalId: string; readonly subjectId: string; readonly createdAt: Date }> {
  if (!deps.extensionCollectionRoutes || !deps.identityUnitOfWork
      || !deps.collectionsUnitOfWork || !deps.faviconStore) {
    throw featureUnavailable('Bookmark favicon helper is not available on this deployment.');
  }
  const origin = request.headers.origin;
  if (typeof origin !== 'string'
    || !deps.extensionCollectionRoutes.allowedOrigins.includes(origin.replace(/\/$/u, ''))) {
    throw authenticationRequired();
  }
  const fields = collectRawHeaders(request.raw.rawHeaders);
  const admitted = colpAuthorizationFromRawHeaders(fields);
  if ('denial' in admitted) throw authenticationRequired();
  let credential: VerifiedExtensionCredential;
  try {
    credential = await deps.extensionCollectionRoutes.credentialVerifier.verify({
      authorization: admitted.authorization,
    });
  } catch (error: unknown) {
    if (error instanceof ExtensionAuthError) throw authenticationRequired();
    throw error;
  }
  const ownerSubjectId = await deps.extensionCollectionRoutes.ownerSubject.resolveOwnerSubject({
    issuer: credential.issuer, subject: credential.subject,
  });
  if (ownerSubjectId === null) throw authenticationRequired();
  const account = await deps.identityUnitOfWork.execute((ports) => ports.accounts.findBySubjectId(ownerSubjectId));
  if (!account || account.status !== 'active' || account.deletedAt !== null) {
    throw authenticationRequired();
  }
  return {
    principalId: account.id,
    subjectId: account.subjectId,
    // Contract singletonInitialization: the virtual policy updatedAt is the
    // stable account creation time, never request-time Date.now().
    createdAt: account.createdAt,
  };
}

function readRequiredPolicyRevision(request: FastifyRequest): bigint {
  const raw = request.headers['known-favicon-policy-revision'];
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ProductHttpError({
      statusCode: 428,
      code: 'precondition_required',
      message: 'Known-Favicon-Policy-Revision is required for this operation.',
      recovery: 'refresh_and_retry',
      precondition: 'resource',
    });
  }
  if (!POLICY_REVISION_PATTERN.test(raw)) {
    throw new ProductHttpError({
      statusCode: 400,
      code: 'invalid_request',
      message: 'Known-Favicon-Policy-Revision must be a positive decimal revision.',
    });
  }
  const value = BigInt(raw);
  if (value < 1n) {
    throw new ProductHttpError({
      statusCode: 400,
      code: 'invalid_request',
      message: 'Known-Favicon-Policy-Revision must be a positive decimal revision.',
    });
  }
  return value;
}

function sendSource(reply: FastifyReply, view: IconSourceView): FastifyReply {
  return reply
    .code(200)
    .type('application/json; charset=utf-8')
    .header('cache-control', 'private, no-store')
    .header('ETag', iconSourceEtag(view.nodeResourceRevision, view.revision))
    .send(toIconSourceDto(view));
}

/** Response ETag for capture/clear 200s. Created outcomes use the receipt
 * snapshot; live recompute is only for pre-snapshot receipts still in TTL. */
async function helperResponseEtag(
  ports: HelperPorts,
  outcome: Awaited<ReturnType<typeof captureBookmarkFavicon>>,
  collectionId: string,
  nodeId: string,
): Promise<string | null> {
  if (outcome.kind === 'created') return outcome.etag;
  if (outcome.kind !== 'replay') return null;
  if (storedEtag(outcome.result.stableHeaders) !== undefined) return null;
  return helperCommandEtag(ports, outcome, collectionId, nodeId);
}

/** Live composite ETag for pre-snapshot replay receipts still inside TTL.
 * New receipts restore stored headers; null when the node row is gone. */
async function helperCommandEtag(
  ports: HelperPorts,
  outcome: Awaited<ReturnType<typeof captureBookmarkFavicon>>,
  collectionId: string,
  nodeId: string,
): Promise<string | null> {
  if (outcome.kind !== 'created' && outcome.kind !== 'replay') return null;
  const node = await ports.nodes.getNode(collectionId, nodeId);
  if (node === null) return null;
  const source = await ports.faviconSources.findByNodeId(nodeId);
  return iconSourceEtag(node.resourceRevision, source?.revision ?? INITIAL_FAVICON_SOURCE_REVISION);
}

/**
 * Case-insensitive `etag` lookup in stored receipt headers (receipt writers
 * normalize to lowercase; older rows predate the snapshot entirely).
 */
function storedEtag(headers: Readonly<Record<string, string>>): string | undefined {
  return Object.entries(headers).find(([name]) => name.toLowerCase() === 'etag')?.[1];
}

function sendHelperCommandResult(
  reply: FastifyReply,
  result: Awaited<ReturnType<typeof captureBookmarkFavicon>>,
  etag: string | null,
): FastifyReply {
  if (result.kind === 'created') {
    if (etag !== null) reply.header('ETag', etag);
    return reply.code(200).header('cache-control', 'private, no-store').send(result.view);
  }
  if (result.kind === 'replay') {
    for (const [name, value] of Object.entries(result.result.stableHeaders)) {
      reply.header(name, value);
    }
    // New-format receipts restore their stored etag with the loop above.
    // Only receipts written before the ETag snapshot (still inside their
    // TTL) lack one and fall back to the live recompute supplied by the route.
    if (storedEtag(result.result.stableHeaders) === undefined && etag !== null) {
      reply.header('ETag', etag);
    }
    return reply.code(result.result.status).send(Buffer.from(result.result.body));
  }
  if (result.kind === 'in_progress') {
    throw new ProductHttpError({
      statusCode: 429,
      code: 'rate_limited',
      message: 'This favicon capture is still in progress. Please retry the request.',
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

export function mapFaviconHelperRouteError(error: unknown): ProductHttpError {
  if (error instanceof ProductHttpError) return error;
  if (error instanceof FaviconHelperCaptureCommandError) {
    return new ProductHttpError({
      statusCode: error.code === 'payload_too_large' ? 413 : 400,
      code: error.code,
      message: error.message,
      recovery: 'user_action',
    });
  }
  if (error instanceof FaviconSourceCommandError) {
    return new ProductHttpError({
      statusCode: 400,
      code: 'invalid_request',
      message: error.message,
      recovery: 'user_action',
    });
  }
  if (error instanceof CollectionAuthorizationError) {
    return mapAuthorizationOutcome(error.outcome);
  }
  if (error instanceof CollectionPreconditionError) {
    return new ProductHttpError({
      statusCode: 412,
      code: 'precondition_failed',
      message: error.message,
      recovery: 'refresh_and_retry',
      precondition: 'resource',
      currentEtag: error.currentEtag,
    });
  }
  return mapFaviconPolicyRouteError(error);
}

function declaredContentType(request: FastifyRequest): string {
  return (request.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function rejectNonemptyBody(request: FastifyRequest): void {
  if (request.body !== undefined) {
    throw new ProductHttpError({
      statusCode: 400,
      code: 'invalid_request',
      message: 'This operation does not accept a request body.',
    });
  }
}

function admission(deps: SyncFaviconHelperRouteDependencies, path: string) {
  return async (request: FastifyRequest) => {
    // SYNC-Q-014: COLP-sync routes never mint a route-local limiter. Without an
    // injected shared limiter the helper runs unlimited, exactly like the sync
    // routes whose admission policy is absent.
    if (deps.rateLimiter === undefined) return;
    const decision = await consumeProductAdmission(deps.rateLimiter, rateLimitClientKey(request, path));
    if (decision.kind === 'failed') throw unavailable();
    if (decision.kind === 'denied') {
      throw new ProductHttpError({
        statusCode: 429,
        code: 'rate_limited',
        message: 'Too many favicon helper requests. Please try again later.',
        recovery: 'same_request',
        sameRequestRetrySafe: true,
        retryAfterSeconds: decision.retryAfterSeconds,
        headers: { 'Retry-After': String(decision.retryAfterSeconds) },
      });
    }
  };
}

function collectRawHeaders(raw: readonly string[]): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index]!.toLowerCase();
    fields.set(name, [...(fields.get(name) ?? []), raw[index + 1] ?? '']);
  }
  return fields;
}

function authenticationRequired(): ProductHttpError {
  return new ProductHttpError({
    statusCode: 401,
    code: 'authentication_required',
    message: 'Authentication is required for this operation.',
    recovery: 'user_action',
  });
}

function featureUnavailable(message: string): ProductHttpError {
  return new ProductHttpError({
    statusCode: 503,
    code: 'feature_temporarily_unavailable',
    message,
    recovery: 'same_request',
    sameRequestRetrySafe: true,
    retryAfterSeconds: 1,
    headers: { 'Retry-After': '1' },
  });
}

function unavailable(): ProductHttpError {
  return new ProductHttpError({
    statusCode: 503,
    code: 'feature_temporarily_unavailable',
    message: 'Favicon helper is temporarily unavailable.',
    recovery: 'same_request',
    sameRequestRetrySafe: true,
    retryAfterSeconds: 1,
    headers: { 'Retry-After': '1' },
  });
}

function notFound(): ProductHttpError {
  return new ProductHttpError({
    statusCode: 404,
    code: 'resource_not_found',
    message: 'The requested resource was not found.',
    recovery: 'none',
  });
}