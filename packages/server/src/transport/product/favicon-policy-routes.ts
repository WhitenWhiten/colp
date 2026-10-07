import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import { withCancellation } from './request-timeout.js';
export { withCancellation };
import {
  CollectionAuthorizationError,
  FaviconPolicyCommandError,
  FaviconRefreshCommandError,
  FaviconSourceCommandError,
  enqueueBookmarkFaviconRefresh,
  getBookmarkFaviconSource,
  getMyFaviconPolicy,
  iconSourceEtag,
  faviconPolicyEtag,
  parseFaviconPolicyPatch,
  setBookmarkFaviconSource,
  toFaviconPolicyDto,
  toIconSourceDto,
  toPolicyResultDto,
  updateMyFaviconPolicy,
  type BookmarkIconSourceWritePort,
  type CollectionsUnitOfWork,
  type CollectionsWritePorts,
  type FaviconJobReadPort,
  type FaviconJobWritePort,
  type FaviconPolicyCommandPorts,
  type FaviconPolicyRow,
  type FaviconPolicyWritePort,
  type FaviconRefreshEnqueuePorts,
  type FaviconSourceMembershipReadPort,
  type GetBookmarkFaviconSourcePorts,
  type IconSourceView,
  type SetBookmarkFaviconSourcePorts,
} from '../../modules/collections/index.js';
import type { ProductAdmissionRateLimiter } from '../http-security.js';
import { consumeProductAdmission, rateLimitClientKey } from '../http-security.js';
import { mapAuthorizationOutcome, sendProductCommandReceiptOutcome } from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import { productErrorStatus } from '../product-codes.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { readCollectionIdParam, readKnownCommandId, readNodeIdParam, readRequiredIfMatch } from './collection-route-helpers.js';
import { requireMutationActor } from '../mutation-actor.js';
import { requireSessionActor } from '../session-auth.js';

const POLICY = '/api/v1/me/favicon-policy';
const SOURCE = '/api/v1/collections/:collectionId/nodes/:nodeId/favicon-source';
const REFRESH = '/api/v1/collections/:collectionId/nodes/:nodeId/favicon-refresh';

export interface FaviconPolicyRouteDependencies {
  readonly enabled: boolean;
  readonly allowedOrigins: readonly string[];
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly collectionsUnitOfWork: CollectionsUnitOfWork;
  readonly rateLimiter: ProductAdmissionRateLimiter;
  readonly timeoutMs: number;
  readonly productOrigin: string;
}

type SourcePorts = CollectionsWritePorts & {
  readonly faviconSources: NonNullable<CollectionsWritePorts['faviconSources']>;
  readonly faviconPolicies: NonNullable<CollectionsWritePorts['faviconPolicies']>;
  readonly bookmarkIcons: NonNullable<CollectionsWritePorts['bookmarkIcons']>;
  readonly faviconJobs: NonNullable<CollectionsWritePorts['faviconJobs']>;
  readonly faviconJobsRead: NonNullable<CollectionsWritePorts['faviconJobsRead']>;
  readonly faviconGc: NonNullable<CollectionsWritePorts['faviconGc']>;
  readonly faviconSourceMembership: NonNullable<CollectionsWritePorts['faviconSourceMembership']>;
  /**
   * F-A8: pending force-restore lookup (restorable projection). The write
   * port carries the per-node `findByNodeId` the icon-source projection needs
   * (`faviconRestoreRead` only lists by account — it backs the batch jobs
   * instead); absent ⇒ fail closed with restorable false.
   */
  readonly faviconRestores: import('../../modules/collections/index.js').FaviconSourceRestoreWritePort;
};
type PolicyPorts = CollectionsWritePorts & {
  readonly faviconPolicies: import('../../modules/collections/index.js').FaviconPolicyWritePort;
  readonly faviconBatchJobs: import('../../modules/collections/index.js').FaviconBatchJobWritePort;
  readonly faviconBatchCandidates: import('../../modules/collections/index.js').FaviconBatchCandidatePort;
  readonly faviconRestoreRead: import('../../modules/collections/index.js').FaviconSourceRestoreReadPort;
};

function requireSourcePorts(ports: CollectionsWritePorts): asserts ports is SourcePorts {
  const candidate = ports as SourcePorts;
  if (candidate.faviconSources === undefined || candidate.faviconPolicies === undefined
      || candidate.bookmarkIcons === undefined || candidate.faviconJobs === undefined
      || candidate.faviconJobsRead === undefined || candidate.faviconGc === undefined
      || candidate.faviconSourceMembership === undefined
      || candidate.faviconRestores === undefined) {
    throw featureUnavailable();
  }
}

function requirePolicyPorts(ports: CollectionsWritePorts): asserts ports is PolicyPorts {
  const candidate = ports as PolicyPorts;
  if (candidate.faviconPolicies === undefined || candidate.faviconBatchJobs === undefined
      || candidate.faviconBatchCandidates === undefined || candidate.faviconRestoreRead === undefined) {
    throw featureUnavailable();
  }
}

function sourceQueryPorts(ports: SourcePorts): GetBookmarkFaviconSourcePorts {
  return {
    collections: ports.collections,
    nodes: ports.nodes,
    accessPolicy: ports.accessPolicyFacts,
    sources: ports.faviconSources,
    policies: ports.faviconPolicies,
    bookmarkIcons: ports.bookmarkIcons,
    jobs: ports.faviconJobsRead,
    collectionMembers: ports.faviconSourceMembership,
    // F-A8: pending force-restore lookup drives the restorable projection.
    restores: ports.faviconRestores,
  };
}

function sourceCommandPorts(ports: SourcePorts): SetBookmarkFaviconSourcePorts {
  return {
    receipts: ports.receipts,
    clock: ports.clock,
    collections: ports.collections,
    nodes: ports.nodes,
    accessPolicy: ports.accessPolicyFacts,
    sources: ports.faviconSources,
    policies: ports.faviconPolicies,
    bookmarkIcons: ports.bookmarkIcons,
    gc: ports.faviconGc,
    jobs: ports.faviconJobsRead,
    collectionMembers: ports.faviconSourceMembership,
    // F-A8: pending force-restore lookup drives the restorable projection.
    restores: ports.faviconRestores,
  };
}

function refreshEnqueuePorts(ports: SourcePorts): FaviconRefreshEnqueuePorts {
  return {
    receipts: ports.receipts,
    clock: ports.clock,
    collections: ports.collections,
    nodes: ports.nodes,
    accessPolicy: ports.accessPolicyFacts,
    sources: ports.faviconSources,
    policies: ports.faviconPolicies,
    jobs: ports.faviconJobs,
  };
}

function policyCommandPorts(ports: PolicyPorts): FaviconPolicyCommandPorts {
  return {
    receipts: ports.receipts,
    clock: ports.clock,
    policies: ports.faviconPolicies,
    batchJobs: {
      jobs: ports.faviconBatchJobs,
      candidates: ports.faviconBatchCandidates,
      restores: ports.faviconRestoreRead,
    },
  };
}

export function registerFaviconPolicyRoutes(
  app: FastifyInstance,
  deps: FaviconPolicyRouteDependencies,
): void {
  if (!Number.isInteger(deps.timeoutMs) || deps.timeoutMs < 1 || deps.timeoutMs > 30_000) {
    throw new TypeError('Favicon policy route timeout is outside the application budget.');
  }
  const exposure = async (): Promise<void> => {
    // FO-01 feature flag off => 404 with no new feature resources exposed.
    if (!deps.enabled) throw notFound();
  };
  const privateTransport = {
    duplicateQueryErrorCode: 'invalid_query' as const,
    queryErrorCode: 'invalid_query' as const,
    allowedQuery: [] as const,
    acceptedMediaTypes: ['application/json'] as const,
    bodyLimitBytes: 32_768,
    cacheControl: 'private-no-store' as const,
  };
  const policyAdmission = admission(deps, POLICY);
  const sourceAdmission = admission(deps, SOURCE);

  app.get(POLICY, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', POLICY),
      productTransport: privateTransport,
    },
    onRequest: policyAdmission,
  }, async (request, reply) => {
    await exposure();
    rejectNonemptyBody(request);
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    try {
      const row = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.collectionsUnitOfWork.execute((ports) => {
          requirePolicyPorts(ports);
          return getMyFaviconPolicy(
            { policies: ports.faviconPolicies },
            { principalId: account.id, virtualUpdatedAt: account.createdAt },
          );
        }, { signal }));
      return sendPolicyView(reply, row);
    } catch (error) {
      throw mapFaviconPolicyRouteError(error);
    }
  });

  app.patch(POLICY, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('PATCH', POLICY),
      productTransport: privateTransport,
    },
    onRequest: policyAdmission,
  }, async (request, reply) => {
    await exposure();
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork,
      allowedOrigins: deps.allowedOrigins,
    });
    const commandId = readKnownCommandId(request);
    const ifMatch = readRequiredIfMatch(request);
    let patch: ReturnType<typeof parseFaviconPolicyPatch>;
    try {
      patch = parseFaviconPolicyPatch(request.body);
    } catch (error) {
      throw mapFaviconPolicyRouteError(error);
    }
    try {
      const outcome = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.collectionsUnitOfWork.execute((ports) => {
          requirePolicyPorts(ports);
          return updateMyFaviconPolicy(policyCommandPorts(ports), {
            actor: { principalId: account.id, subjectId: account.subjectId },
            commandId,
            expectedEtag: ifMatch,
            patch,
            // Contract singletonInitialization: the virtual policy updatedAt
            // is the stable account creation time, never request time.
            virtualUpdatedAt: account.createdAt,
          });
        }, { signal }));
      if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
      return sendPolicyResult(reply, outcome.policy, outcome.jobId);
    } catch (error) {
      throw mapFaviconPolicyRouteError(error);
    }
  });

  app.get(SOURCE, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', SOURCE),
      productTransport: privateTransport,
    },
    onRequest: sourceAdmission,
  }, async (request, reply) => {
    await exposure();
    rejectNonemptyBody(request);
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    const collectionId = readCollectionIdParam(request);
    const nodeId = readNodeIdParam(request);
    try {
      const view = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.collectionsUnitOfWork.execute((ports) => {
          requireSourcePorts(ports);
          return getBookmarkFaviconSource(sourceQueryPorts(ports), {
            actor: { principalId: account.id, subjectId: account.subjectId },
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

  app.put(SOURCE, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('PUT', SOURCE),
      productTransport: privateTransport,
    },
    onRequest: sourceAdmission,
  }, async (request, reply) => {
    await exposure();
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork,
      allowedOrigins: deps.allowedOrigins,
    });
    const commandId = readKnownCommandId(request);
    const ifMatch = readRequiredIfMatch(request);
    const collectionId = readCollectionIdParam(request);
    const nodeId = readNodeIdParam(request);
    let sourceMode: 'inherit' | 'none' | 'online';
    try {
      sourceMode = parseSetIconSourceBody(request.body);
    } catch (error) {
      throw mapFaviconSourceRouteError(error);
    }
    try {
      const outcome = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.collectionsUnitOfWork.execute((ports) => {
          requireSourcePorts(ports);
          return setBookmarkFaviconSource(sourceCommandPorts(ports), {
            actor: { principalId: account.id, subjectId: account.subjectId },
            commandId,
            expectedEtag: ifMatch,
            collectionId,
            nodeId,
            sourceMode,
            productOrigin: deps.productOrigin,
          });
        }, { signal }));
      if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
      return sendSource(reply, outcome.view);
    } catch (error) {
      throw mapFaviconSourceRouteError(error);
    }
  });

  app.post(REFRESH, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('POST', REFRESH),
      productTransport: privateTransport,
    },
    onRequest: sourceAdmission,
  }, async (request, reply) => {
    await exposure();
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork,
      allowedOrigins: deps.allowedOrigins,
    });
    const commandId = readKnownCommandId(request);
    const ifMatch = readRequiredIfMatch(request);
    const collectionId = readCollectionIdParam(request);
    const nodeId = readNodeIdParam(request);
    rejectNonemptyBody(request);
    try {
      const outcome = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.collectionsUnitOfWork.execute((ports) => {
          requireSourcePorts(ports);
          return enqueueBookmarkFaviconRefresh(refreshEnqueuePorts(ports), {
            actor: { principalId: account.id, subjectId: account.subjectId },
            commandId,
            expectedEtag: ifMatch,
            collectionId,
            nodeId,
          });
        }, { signal }));
      if (outcome.kind !== 'accepted') return sendProductCommandReceiptOutcome(reply, outcome);
      return reply
        .code(202)
        .type('application/json; charset=utf-8')
        .header('cache-control', 'private, no-store')
        .header('ETag', outcome.etag)
        .send({ jobId: outcome.jobId });
    } catch (error) {
      throw mapFaviconRefreshRouteError(error);
    }
  });
}

function sendPolicyView(reply: FastifyReply, row: FaviconPolicyRow): FastifyReply {
  return reply
    .code(200)
    .type('application/json; charset=utf-8')
    .header('cache-control', 'private, no-store')
    .header('ETag', faviconPolicyEtag(row.revision))
    .send(toFaviconPolicyDto(row));
}

function sendPolicyResult(reply: FastifyReply, row: FaviconPolicyRow, jobId: string | null): FastifyReply {
  return reply
    .code(200)
    .type('application/json; charset=utf-8')
    .header('cache-control', 'private, no-store')
    .header('ETag', faviconPolicyEtag(row.revision))
    .send(toPolicyResultDto(toFaviconPolicyDto(row), jobId));
}

function sendSource(reply: FastifyReply, view: IconSourceView): FastifyReply {
  return reply
    .code(200)
    .type('application/json; charset=utf-8')
    .header('cache-control', 'private, no-store')
    .header('ETag', iconSourceEtag(view.nodeResourceRevision, view.revision))
    .send(toIconSourceDto(view));
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

export { rejectNonemptyBody };

function parseSetIconSourceBody(value: unknown): 'inherit' | 'none' | 'online' {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new FaviconSourceCommandError('invalid_request', 'The favicon source request must be a JSON object.');
  }
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'sourceMode') {
    throw new FaviconSourceCommandError(
      'invalid_request',
      'The favicon source request must contain exactly the sourceMode field.',
    );
  }
  if (body.sourceMode === 'inherit') return 'inherit';
  if (body.sourceMode === 'none') return 'none';
  if (body.sourceMode === 'online') return 'online';
  throw new FaviconSourceCommandError(
    'invalid_request',
    'sourceMode must be exactly "inherit", "online" or "none".',
  );
}

function admission(deps: FaviconPolicyRouteDependencies, path: string) {
  return async (request: FastifyRequest) => {
    const decision = await consumeProductAdmission(deps.rateLimiter, rateLimitClientKey(request, path));
    if (decision.kind === 'failed') throw unavailable();
    if (decision.kind === 'denied') {
      throw new ProductHttpError({
        statusCode: 429,
        code: 'rate_limited',
        message: 'Too many favicon policy requests. Please try again later.',
        recovery: 'same_request',
        sameRequestRetrySafe: true,
        retryAfterSeconds: decision.retryAfterSeconds,
        headers: { 'Retry-After': String(decision.retryAfterSeconds) },
      });
    }
  };
}

export function mapFaviconPolicyRouteError(error: unknown): ProductHttpError {
  if (error instanceof ProductHttpError) return error;
  if (error instanceof FaviconPolicyCommandError) {
    return new ProductHttpError({
      statusCode: productErrorStatus('invalid_request'),
      code: 'invalid_request',
      message: error.message,
    });
  }
  if (isPreconditionError(error)) {
    return new ProductHttpError({
      statusCode: 412,
      code: 'precondition_failed',
      message: error.message ?? 'The favicon policy ETag does not match the current representation.',
      recovery: 'refresh_and_retry',
      precondition: 'resource',
      currentEtag: error.currentEtag,
    });
  }
  return mapRouteDatabaseError(error, 'The favicon policy request could not be completed.');
}

export function mapFaviconSourceRouteError(error: unknown): ProductHttpError {
  if (error instanceof ProductHttpError) return error;
  if (error instanceof FaviconSourceCommandError) {
    return new ProductHttpError({
      statusCode: productErrorStatus('invalid_request'),
      code: 'invalid_request',
      message: error.message,
    });
  }
  if (error instanceof CollectionAuthorizationError) {
    return mapAuthorizationOutcome(error.outcome);
  }
  if (isPreconditionError(error)) {
    return new ProductHttpError({
      statusCode: 412,
      code: 'precondition_failed',
      message: error.message ?? 'The favicon source ETag does not match the current representation.',
      recovery: 'refresh_and_retry',
      precondition: 'resource',
      currentEtag: error.currentEtag,
    });
  }
  return mapRouteDatabaseError(error, 'The favicon source request could not be completed.');
}

export function mapFaviconRefreshRouteError(error: unknown): ProductHttpError {
  if (error instanceof ProductHttpError) return error;
  if (error instanceof FaviconRefreshCommandError) {
    return new ProductHttpError({
      statusCode: productErrorStatus('invalid_request'),
      code: 'invalid_request',
      message: error.message,
    });
  }
  if (error instanceof CollectionAuthorizationError) {
    return mapAuthorizationOutcome(error.outcome);
  }
  if (isPreconditionError(error)) {
    return new ProductHttpError({
      statusCode: 412,
      code: 'precondition_failed',
      message: error.message ?? 'The favicon source ETag does not match the current representation.',
      recovery: 'refresh_and_retry',
      precondition: 'resource',
      currentEtag: error.currentEtag,
    });
  }
  return mapRouteDatabaseError(error, 'The favicon refresh request could not be completed.');
}

function isPreconditionError(error: unknown): error is { readonly message: string; readonly currentEtag: string } {
  return typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === 'precondition_failed'
    && typeof (error as { currentEtag?: unknown }).currentEtag === 'string'
    && typeof (error as { message?: unknown }).message === 'string';
}

function mapRouteDatabaseError(error: unknown, fallback: string): ProductHttpError {
  if (error instanceof TypeError) {
    return new ProductHttpError({
      statusCode: productErrorStatus('invalid_request'),
      code: 'invalid_request',
      message: 'The request is invalid.',
    });
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '57014' || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT') {
    return unavailable();
  }
  const kind = (error as { kind?: unknown } | null)?.kind;
  if (kind === 'serialization_failure' || kind === 'deadlock' || kind === 'lock_timeout' || kind === 'unavailable') {
    return unavailable();
  }
  return new ProductHttpError({
    statusCode: productErrorStatus('internal_error'),
    code: 'internal_error',
    message: fallback,
    recovery: 'same_request',
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

export function notFoundError(): ProductHttpError {
  return notFound();
}

function featureUnavailable(): ProductHttpError {
  return new ProductHttpError({
    statusCode: productErrorStatus('feature_temporarily_unavailable'),
    code: 'feature_temporarily_unavailable',
    message: 'Bookmark favicon policy storage is not available on this deployment.',
    recovery: 'same_request',
    sameRequestRetrySafe: true,
    retryAfterSeconds: 1,
    headers: { 'Retry-After': '1' },
  });
}

function unavailable(): ProductHttpError {
  return new ProductHttpError({
    statusCode: productErrorStatus('feature_temporarily_unavailable'),
    code: 'feature_temporarily_unavailable',
    message: 'Favicon policy is temporarily unavailable.',
    recovery: 'same_request',
    sameRequestRetrySafe: true,
    retryAfterSeconds: 1,
    headers: { 'Retry-After': '1' },
  });
}

