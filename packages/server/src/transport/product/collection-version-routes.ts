import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { observeBestEffort } from '../../infrastructure/async/best-effort.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import {
  CollectionVersionCursorError,
  CollectionVersionInputError,
  CollectionVersionNodeLimitError,
  CollectionVersionNotFoundError,
  CollectionVersionRateLimitError,
  CollectionVersionRestoreReceiptConflictError,
  createCollectionVersion,
  getCollectionVersion,
  listCollectionVersions,
  restoreCollectionVersion,
  RestoreCollectionVersionInnerCommandError,
  type CreateCollectionVersionPorts,
  type ProductCollectionVersionCursorSignerPort,
  type RestoreCollectionVersionPorts,
} from '../../modules/collections/index.js';
import type { ProductAdmissionRateLimiter } from '../http-security.js';
import { consumeProductAdmission } from '../http-security.js';
import { readKnownCommandId, readRequiredIfMatch } from './collection-route-helpers.js';
import {
  mapCollectionMutationError,
  sendProductCommandReceiptOutcome,
} from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireSessionActor } from '../session-auth.js';
import { requireMutationActor } from '../mutation-actor.js';

const COLLECTION = '/api/v1/collections/:collectionId/versions';
const ITEM = '/api/v1/collections/:collectionId/versions/:versionId';
const RESTORE = '/api/v1/collections/:collectionId/versions/:versionId/restore';
const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

export interface CollectionVersionRoutesDependencies {
  readonly enabled: boolean;
  readonly allowedOrigins: readonly string[];
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly unitOfWork: {
    execute<Result>(
      work: (ports: CreateCollectionVersionPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  readonly cursors: ProductCollectionVersionCursorSignerPort;
  readonly rateLimiter: ProductAdmissionRateLimiter;
  readonly timeoutMs: number;
  readonly clock?: { now(): Date };
  readonly csrfMatches?: (raw: string, expectedHash: string) => boolean;
}

export function registerCollectionVersionRoutes(
  app: FastifyInstance,
  deps: CollectionVersionRoutesDependencies,
): void {
  if (!Number.isInteger(deps.timeoutMs) || deps.timeoutMs < 1 || deps.timeoutMs > 30_000) {
    throw new TypeError('Collection-version route timeout is invalid.');
  }
  const clock = deps.clock ?? { now: () => new Date() };

  app.post(COLLECTION, {
    config: {
      ...productRouteMetadata('POST', COLLECTION),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: 16_384,
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork,
      allowedOrigins: deps.allowedOrigins,
      csrfMatches: deps.csrfMatches,
    });
    if (!deps.enabled) throw notFound();
    await admit(deps.rateLimiter, `${COLLECTION}:principal:${account.id}`);
    const commandId = readKnownCommandId(request);
    const ifMatch = readRequiredIfMatch(request);
    const collectionId = collectionIdParam(request);
    try {
      const outcome = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.unitOfWork.execute((ports) => createCollectionVersion(ports, {
          actor: { principalId: account.id, subjectId: account.subjectId },
          commandId,
          collectionId,
          ifMatch,
          label: readLabel(request.body),
        }), { signal }));
      if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
      return sendVersion(reply, outcome.status, outcome.version, collectionId);
    } catch (error: unknown) {
      throw mapVersionError(error);
    }
  });

  app.get(COLLECTION, {
    config: {
      ...productRouteMetadata('GET', COLLECTION),
      productTransport: {
        allowedQuery: ['limit', 'cursor'],
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    if (!deps.enabled) throw notFound();
    await admit(deps.rateLimiter, `collection-versions:principal:${account.id}`);
    const query = request.query as { limit?: string; cursor?: string };
    try {
      const page = await deps.unitOfWork.execute((ports) => listCollectionVersions({
        versions: ports.versions,
        cursors: deps.cursors,
        clock,
      }, {
        actor: { principalId: account.id, subjectId: account.subjectId },
        collectionId: collectionIdParam(request),
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        ...(query.limit !== undefined ? { limit: Number(query.limit) } : {}),
      }));
      return reply
        .code(200)
        .type('application/json; charset=utf-8')
        .header('cache-control', 'private, no-store')
        .send(page);
    } catch (error: unknown) {
      throw mapVersionError(error);
    }
  });

  app.get(ITEM, {
    config: {
      ...productRouteMetadata('GET', ITEM),
      productTransport: {
        allowedQuery: [],
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    if (!deps.enabled) throw notFound();
    await admit(deps.rateLimiter, `collection-versions:principal:${account.id}`);
    try {
      const version = await deps.unitOfWork.execute((ports) => getCollectionVersion({
        versions: ports.versions,
      }, {
        actor: { principalId: account.id, subjectId: account.subjectId },
        collectionId: collectionIdParam(request),
        versionId: versionIdParam(request),
      }));
      return reply
        .code(200)
        .type('application/json; charset=utf-8')
        .header('etag', version.etag)
        .header('cache-control', 'private, no-store')
        .send(version);
    } catch (error: unknown) {
      throw mapVersionError(error);
    }
  });

  app.post(RESTORE, {
    config: {
      ...productRouteMetadata('POST', RESTORE),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: 16_384,
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork,
      allowedOrigins: deps.allowedOrigins,
      csrfMatches: deps.csrfMatches,
    });
    if (!deps.enabled) throw notFound();
    await admit(deps.rateLimiter, `${RESTORE}:principal:${account.id}`);
    const commandId = readKnownCommandId(request);
    const ifMatch = readRequiredIfMatch(request);
    const collectionId = collectionIdParam(request);
    const versionId = versionIdParam(request);
    readEmptyRestoreBody(request.body);
    try {
      const outcome = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.unitOfWork.execute((ports) => restoreCollectionVersion(asRestorePorts(ports), {
          actor: { principalId: account.id, subjectId: account.subjectId },
          commandId,
          collectionId,
          versionId,
          ifMatch,
        }), { signal }));
      if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
      return reply
        .code(200)
        .type('application/json; charset=utf-8')
        .header('cache-control', 'private, no-store')
        .send(outcome.receipt);
    } catch (error: unknown) {
      if (error instanceof RestoreCollectionVersionInnerCommandError) {
        return sendProductCommandReceiptOutcome(reply, error.outcome);
      }
      throw mapVersionError(error);
    }
  });
}

function sendVersion(
  reply: FastifyReply,
  status: 200 | 201,
  version: { etag: string; versionId: string },
  collectionId: string,
) {
  return reply
    .code(status)
    .type('application/json; charset=utf-8')
    .header('etag', version.etag)
    .header('location', `/api/v1/collections/${collectionId}/versions/${version.versionId}`)
    .header('cache-control', 'private, no-store')
    .send(version);
}

function collectionIdParam(request: FastifyRequest): string {
  const params = request.params as { collectionId?: string };
  const collectionId = typeof params.collectionId === 'string' ? params.collectionId : '';
  if (!OPAQUE_ID.test(collectionId)) throw notFound();
  return collectionId;
}

function versionIdParam(request: FastifyRequest): string {
  const params = request.params as { versionId?: string };
  const versionId = typeof params.versionId === 'string' ? params.versionId : '';
  if (!OPAQUE_ID.test(versionId)) throw notFound();
  return versionId;
}

function asRestorePorts(ports: CreateCollectionVersionPorts): RestoreCollectionVersionPorts {
  const candidate = ports as RestoreCollectionVersionPorts;
  if (!candidate.mutations || !candidate.restoreReceipts) {
    throw new TypeError('Collection-version restore ports are not configured.');
  }
  return candidate;
}

function readEmptyRestoreBody(body: unknown): void {
  if (body === undefined || body === null || body === '') {
    throw new CollectionVersionInputError('Request body is invalid.');
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new CollectionVersionInputError('Request body is invalid.');
  }
  if (Object.keys(body as Record<string, unknown>).length > 0) {
    throw new CollectionVersionInputError('Request body is invalid.');
  }
}

function readLabel(body: unknown): string | undefined {
  if (body === undefined || body === null || body === '') return undefined;
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new CollectionVersionInputError('Request body is invalid.');
  }
  const record = body as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => key !== 'label');
  if (extra.length > 0) throw new CollectionVersionInputError('Request body is invalid.');
  if (!Object.hasOwn(record, 'label')) return undefined;
  if (typeof record.label !== 'string') throw new CollectionVersionInputError('label is invalid.');
  return record.label;
}

async function admit(limiter: ProductAdmissionRateLimiter, key: string): Promise<void> {
  const decision = await consumeProductAdmission(limiter, key);
  if (decision.kind === 'failed') throw unavailable();
  if (decision.kind === 'denied') {
    throw new ProductHttpError({
      statusCode: 429, code: 'rate_limited',
      message: 'Too many collection-version requests.', recovery: 'same_request',
      sameRequestRetrySafe: true, retryAfterSeconds: decision.retryAfterSeconds,
      headers: { 'Retry-After': String(decision.retryAfterSeconds) },
    });
  }
}

async function withCancellation<T>(
  request: FastifyRequest, timeoutMs: number, work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let rejectAbort!: (error: Error) => void;
  const cancellation = new Promise<never>((_, reject) => { rejectAbort = reject; });
  observeBestEffort(cancellation,
    'the route race owns cancellation and must observe a rejection before race setup');
  const timeout = setTimeout(() => { controller.abort(); rejectAbort(unavailable()); }, timeoutMs);
  timeout.unref?.();
  const abort = () => { controller.abort(); rejectAbort(unavailable()); };
  request.raw.once('aborted', abort);
  request.raw.socket.once('close', abort);
  try { return await Promise.race([work(controller.signal), cancellation]); }
  finally {
    clearTimeout(timeout);
    request.raw.off('aborted', abort);
    request.raw.socket.off('close', abort);
  }
}

function mapVersionError(error: unknown): ProductHttpError {
  if (error instanceof ProductHttpError) return error;
  if (error instanceof CollectionVersionNotFoundError) return notFound();
  if (error instanceof CollectionVersionCursorError) {
    return new ProductHttpError({
      statusCode: 400, code: 'invalid_request', message: 'cursor is invalid.',
    });
  }
  if (error instanceof CollectionVersionRateLimitError) {
    return new ProductHttpError({
      statusCode: 429, code: 'rate_limited',
      message: error.message, recovery: 'same_request',
      sameRequestRetrySafe: true,
    });
  }
  if (error instanceof CollectionVersionNodeLimitError || error instanceof CollectionVersionInputError) {
    return new ProductHttpError({
      statusCode: 400, code: 'invalid_request', message: error.message,
    });
  }
  if (error instanceof CollectionVersionRestoreReceiptConflictError) {
    // The command id already owns a restore for another Collection/Version.
    return new ProductHttpError({
      statusCode: 409, code: 'command_id_reused',
      message: 'This command id was already used with a different request.',
      recovery: 'user_action',
    });
  }
  const mapped = mapCollectionMutationError(error);
  if (mapped) return mapped;
  throw error;
}

function notFound() {
  return new ProductHttpError({
    statusCode: 404, code: 'resource_not_found',
    message: 'The requested resource was not found.', recovery: 'none',
  });
}

function unavailable() {
  return new ProductHttpError({
    statusCode: 503, code: 'feature_temporarily_unavailable',
    message: 'The collection-version service is temporarily unavailable.', recovery: 'same_request',
    sameRequestRetrySafe: true,
  });
}
