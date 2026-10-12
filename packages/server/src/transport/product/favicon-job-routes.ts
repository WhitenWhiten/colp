/**
 * FO-03 durable favicon job routes:
 *
 *   createMyFaviconJob  POST   /api/v1/me/favicon-jobs
 *   getMyFaviconJob     GET    /api/v1/me/favicon-jobs/{jobId}
 *   retryMyFaviconJob   POST   /api/v1/me/favicon-jobs/{jobId}/retry
 *
 * All three live behind the same KNOWN_FEATURE_FAVICON_POLICY gate and share
 * the faviconJobs worker runtime (no additional consumer). create/retry are
 * receipts mutations with Known-Command-Id; get is an owner-only read whose
 * missing/foreign job conceals as 404.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import {
  FaviconBatchJobCommandError,
  createMyFaviconJob,
  getMyFaviconJob,
  retryMyFaviconJob,
  type FaviconBatchJobCommandPorts,
  type IconJobDto,
} from '../../modules/collections/index.js';
import type { ProductAdmissionRateLimiter } from '../http-security.js';
import { consumeProductAdmission, rateLimitClientKey } from '../http-security.js';
import { sendProductCommandReceiptOutcome } from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import { productErrorStatus } from '../product-codes.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { readKnownCommandId } from './collection-route-helpers.js';
import { notFoundError, rejectNonemptyBody, withCancellation } from './favicon-policy-routes.js';
import { requireMutationActor } from '../mutation-actor.js';
import { requireSessionActor } from '../session-auth.js';

const JOBS = '/api/v1/me/favicon-jobs';
const JOB_ITEM = '/api/v1/me/favicon-jobs/:jobId';
const JOB_RETRY = '/api/v1/me/favicon-jobs/:jobId/retry';

export interface FaviconJobRouteDependencies {
  readonly enabled: boolean;
  readonly allowedOrigins: readonly string[];
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly collectionsUnitOfWork: import('../../modules/collections/index.js').CollectionsUnitOfWork;
  readonly rateLimiter: ProductAdmissionRateLimiter;
  readonly timeoutMs: number;
}

type JobPorts = import('../../modules/collections/index.js').CollectionsWritePorts & {
  readonly faviconPolicies: import('../../modules/collections/index.js').FaviconPolicyWritePort;
  readonly faviconBatchJobs: import('../../modules/collections/index.js').FaviconBatchJobWritePort;
  readonly faviconBatchCandidates: import('../../modules/collections/index.js').FaviconBatchCandidatePort;
  readonly faviconJobItemsRead: import('../../modules/collections/index.js').FaviconBatchJobReadPort;
  readonly faviconRestoreRead: import('../../modules/collections/index.js').FaviconSourceRestoreReadPort;
};

function requireJobPorts(
  ports: import('../../modules/collections/index.js').CollectionsWritePorts,
): asserts ports is JobPorts {
  const candidate = ports as JobPorts;
  if (candidate.faviconPolicies === undefined || candidate.faviconBatchJobs === undefined
      || candidate.faviconBatchCandidates === undefined || candidate.faviconJobItemsRead === undefined
      || candidate.faviconRestoreRead === undefined) {
    throw featureUnavailable();
  }
}

function jobCommandPorts(ports: JobPorts): FaviconBatchJobCommandPorts {
  return {
    receipts: ports.receipts,
    clock: ports.clock,
    policies: ports.faviconPolicies,
    jobs: ports.faviconBatchJobs,
    items: ports.faviconJobItemsRead,
    candidates: ports.faviconBatchCandidates,
    restores: ports.faviconRestoreRead,
  };
}

export function registerFaviconJobRoutes(
  app: FastifyInstance,
  deps: FaviconJobRouteDependencies,
): void {
  if (!Number.isInteger(deps.timeoutMs) || deps.timeoutMs < 1 || deps.timeoutMs > 30_000) {
    throw new TypeError('Favicon job route timeout is outside the application budget.');
  }
  const exposure = async (): Promise<void> => {
    // Feature flag off => 404 with no new feature resources exposed.
    if (!deps.enabled) throw notFoundError();
  };
  const privateTransport = {
    duplicateQueryErrorCode: 'invalid_query' as const,
    queryErrorCode: 'invalid_query' as const,
    allowedQuery: [] as const,
    acceptedMediaTypes: ['application/json'] as const,
    bodyLimitBytes: 32_768,
    cacheControl: 'private-no-store' as const,
  };
  const admission = async (request: FastifyRequest): Promise<void> => {
    const decision = await consumeProductAdmission(deps.rateLimiter, rateLimitClientKey(request, JOBS));
    if (decision.kind === 'failed') throw unavailable();
    if (decision.kind === 'denied') {
      throw new ProductHttpError({
        statusCode: 429,
        code: 'rate_limited',
        message: 'Too many favicon job requests. Please try again later.',
        recovery: 'same_request',
        sameRequestRetrySafe: true,
        retryAfterSeconds: decision.retryAfterSeconds,
        headers: { 'Retry-After': String(decision.retryAfterSeconds) },
      });
    }
  };

  app.post(JOBS, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('POST', JOBS),
      productTransport: privateTransport,
    },
    onRequest: admission,
  }, async (request, reply) => {
    await exposure();
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork,
      allowedOrigins: deps.allowedOrigins,
    });
    const commandId = readKnownCommandId(request);
    let body: { operation: 'fill_missing' | 'refresh_online'; policyRevision: string };
    try {
      body = parseCreateIconJobBody(request.body);
    } catch (error) {
      throw mapFaviconJobRouteError(error);
    }
    try {
      const outcome = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.collectionsUnitOfWork.execute((ports) => {
          requireJobPorts(ports);
          return createMyFaviconJob(jobCommandPorts(ports), {
            actor: { principalId: account.id, subjectId: account.subjectId },
            commandId,
            operation: body.operation,
            policyRevision: body.policyRevision,
          });
        }, { signal }));
      if (outcome.kind !== 'accepted') return sendProductCommandReceiptOutcome(reply, outcome);
      return reply
        .code(202)
        .type('application/json; charset=utf-8')
        .header('cache-control', 'private, no-store')
        .send({ jobId: outcome.jobId });
    } catch (error) {
      throw mapFaviconJobRouteError(error);
    }
  });

  app.get(JOB_ITEM, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', JOB_ITEM),
      productTransport: privateTransport,
    },
    onRequest: admission,
  }, async (request, reply) => {
    await exposure();
    rejectNonemptyBody(request);
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    const jobId = readJobIdParam(request);
    try {
      const dto = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.collectionsUnitOfWork.execute((ports) => {
          requireJobPorts(ports);
          return getMyFaviconJob(jobCommandPorts(ports), {
            actor: { principalId: account.id },
            jobId,
          });
        }, { signal }));
      if (dto === null) throw notFoundError();
      return sendJob(reply, dto);
    } catch (error) {
      throw mapFaviconJobRouteError(error);
    }
  });

  app.post(JOB_RETRY, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('POST', JOB_RETRY),
      productTransport: privateTransport,
    },
    onRequest: admission,
  }, async (request, reply) => {
    await exposure();
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork,
      allowedOrigins: deps.allowedOrigins,
    });
    const commandId = readKnownCommandId(request);
    const jobId = readJobIdParam(request);
    rejectNonemptyBody(request);
    try {
      const outcome = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.collectionsUnitOfWork.execute((ports) => {
          requireJobPorts(ports);
          return retryMyFaviconJob(jobCommandPorts(ports), {
            actor: { principalId: account.id, subjectId: account.subjectId },
            commandId,
            jobId,
          });
        }, { signal }));
      if (outcome.kind !== 'accepted') return sendProductCommandReceiptOutcome(reply, outcome);
      return reply
        .code(202)
        .type('application/json; charset=utf-8')
        .header('cache-control', 'private, no-store')
        .send({ jobId: outcome.jobId });
    } catch (error) {
      throw mapFaviconJobRouteError(error);
    }
  });
}

function readJobIdParam(request: FastifyRequest): string {
  const jobId = (request.params as { jobId?: string }).jobId;
  // The durable job id is a UUID; anything else conceals as 404 (a non-UUID
  // must never reach the uuid column and surface a SQL error).
  if (typeof jobId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(jobId)) {
    throw notFoundError();
  }
  return jobId;
}

function parseCreateIconJobBody(value: unknown): { operation: 'fill_missing' | 'refresh_online'; policyRevision: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new FaviconBatchJobCommandError('invalid_request', 'The favicon job request must be a JSON object.');
  }
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes('operation') || !keys.includes('policyRevision')) {
    throw new FaviconBatchJobCommandError(
      'invalid_request',
      'The favicon job request must contain exactly operation and policyRevision.',
    );
  }
  if (body.operation !== 'fill_missing' && body.operation !== 'refresh_online') {
    throw new FaviconBatchJobCommandError(
      'invalid_request',
      'operation must be exactly "fill_missing" or "refresh_online".',
    );
  }
  if (typeof body.policyRevision !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(body.policyRevision)) {
    throw new FaviconBatchJobCommandError(
      'invalid_request',
      'policyRevision must be a positive decimal revision string.',
    );
  }
  return { operation: body.operation, policyRevision: body.policyRevision };
}

function sendJob(reply: FastifyReply, dto: IconJobDto): FastifyReply {
  return reply
    .code(200)
    .type('application/json; charset=utf-8')
    .header('cache-control', 'private, no-store')
    .send(dto);
}

export function mapFaviconJobRouteError(error: unknown): ProductHttpError {
  if (error instanceof ProductHttpError) return error;
  if (error instanceof FaviconBatchJobCommandError) {
    if (error.code === 'not_found') return notFoundError();
    if (error.code === 'revision_conflict') {
      return new ProductHttpError({
        statusCode: productErrorStatus('revision_conflict'),
        code: 'revision_conflict',
        message: error.message,
        recovery: 'refresh_and_retry',
      });
    }
    return new ProductHttpError({
      statusCode: productErrorStatus('invalid_request'),
      code: 'invalid_request',
      message: error.message,
    });
  }
  return mapRouteDatabaseError(error, 'The favicon job request could not be completed.');
}

function mapRouteDatabaseError(error: unknown, fallback: string): ProductHttpError {
  const kind = (error as { kind?: unknown } | null)?.kind;
  if (kind === 'serialization_failure' || kind === 'deadlock' || kind === 'lock_timeout' || kind === 'unavailable') {
    return unavailable();
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '57014' || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT') {
    return unavailable();
  }
  return new ProductHttpError({
    statusCode: productErrorStatus('internal_error'),
    code: 'internal_error',
    message: fallback,
    recovery: 'same_request',
  });
}

function featureUnavailable(): ProductHttpError {
  return new ProductHttpError({
    statusCode: productErrorStatus('feature_temporarily_unavailable'),
    code: 'feature_temporarily_unavailable',
    message: 'Favicon job storage is not available on this deployment.',
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
    message: 'Favicon jobs are temporarily unavailable.',
    recovery: 'same_request',
    sameRequestRetrySafe: true,
    retryAfterSeconds: 1,
    headers: { 'Retry-After': '1' },
  });
}