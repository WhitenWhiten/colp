import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { observeBestEffort } from '../../infrastructure/async/best-effort.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import {
  createMyExportJob,
  downloadMyExportJob,
  getMyExportJob,
  listMyExportJobs,
  ExportJobConflictError,
  ExportJobInputError,
  type CreateMyExportJobPorts,
  type ExportJobReadPort,
  type ExportObjectStore,
} from '../../modules/collections/index.js';
import type { ProductAdmissionRateLimiter } from '../http-security.js';
import { consumeProductAdmission } from '../http-security.js';
import { readKnownCommandId } from './collection-route-helpers.js';
import { sendProductCommandReceiptOutcome } from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireSessionActor } from '../session-auth.js';
import { requireMutationActor } from '../mutation-actor.js';

const LIST = '/api/v1/me/export-jobs';
const ITEM = '/api/v1/me/export-jobs/:jobId';
const DOWNLOAD = '/api/v1/me/export-jobs/:jobId/download';

export interface ExportJobRoutesDependencies {
  readonly enabled: boolean;
  readonly allowedOrigins: readonly string[];
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly reads: ExportJobReadPort;
  readonly enqueue: {
    execute<Result>(
      work: (ports: CreateMyExportJobPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  readonly store: ExportObjectStore;
  readonly rateLimiter: ProductAdmissionRateLimiter;
  readonly timeoutMs: number;
  readonly clock?: { now(): Date };
  readonly csrfMatches?: (raw: string, expectedHash: string) => boolean;
}

export function registerExportJobRoutes(app: FastifyInstance, deps: ExportJobRoutesDependencies): void {
  if (!Number.isInteger(deps.timeoutMs) || deps.timeoutMs < 1 || deps.timeoutMs > 30_000) {
    throw new TypeError('Export-job route timeout is invalid.');
  }
  const clock = deps.clock ?? { now: () => new Date() };

  app.get(LIST, {
    config: {
      ...productRouteMetadata('GET', LIST),
      productTransport: {
        allowedQuery: [],
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    if (!deps.enabled) throw notFound();
    await admit(deps.rateLimiter, `${LIST}:principal:${account.id}`);
    const page = await listMyExportJobs(deps.reads, account.subjectId);
    return reply.code(200).type('application/json; charset=utf-8').send(page);
  });

  app.post(LIST, {
    config: {
      ...productRouteMetadata('POST', LIST),
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
    await admit(deps.rateLimiter, `${LIST}:principal:${account.id}`);
    const commandId = readKnownCommandId(request);
    try {
      const outcome = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.enqueue.execute((ports) => createMyExportJob(ports, {
          actor: { principalId: account.id, subjectId: account.subjectId },
          commandId,
        }), { signal }));
      if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
      return sendJob(reply, 201, outcome.job);
    } catch (error: unknown) {
      throw mapExportError(error);
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
    await admit(deps.rateLimiter, `${ITEM}:principal:${account.id}`);
    const job = await getMyExportJob(deps.reads, {
      ownerSubjectId: account.subjectId,
      jobId: jobIdParam(request),
    });
    if (!job) throw notFound();
    return sendJob(reply, 200, job);
  });

  app.get(DOWNLOAD, {
    config: {
      ...productRouteMetadata('GET', DOWNLOAD),
      productTransport: {
        allowedQuery: [],
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    if (!deps.enabled) throw notFound();
    await admit(deps.rateLimiter, `${DOWNLOAD}:principal:${account.id}`);
    const body = await downloadMyExportJob({
      reads: deps.reads,
      store: deps.store,
      clock,
    }, {
      ownerSubjectId: account.subjectId,
      jobId: jobIdParam(request),
    });
    if (!body) throw notFound();
    let document: unknown;
    try {
      document = JSON.parse(body.toString('utf8'));
    } catch {
      throw notFound();
    }
    return reply.code(200)
      .type('application/json; charset=utf-8')
      .header('cache-control', 'private, no-store')
      .send(document);
  });
}

function sendJob(reply: FastifyReply, status: number, job: unknown) {
  return reply.code(status).type('application/json; charset=utf-8').send(job);
}

function jobIdParam(request: FastifyRequest): string {
  const params = request.params as { jobId?: string };
  return typeof params.jobId === 'string' ? params.jobId : '';
}

async function admit(limiter: ProductAdmissionRateLimiter, key: string): Promise<void> {
  const decision = await consumeProductAdmission(limiter, key);
  if (decision.kind === 'failed') throw unavailable();
  if (decision.kind === 'denied') {
    throw new ProductHttpError({
      statusCode: 429, code: 'rate_limited',
      message: 'Too many export-job requests.', recovery: 'same_request',
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

function mapExportError(error: unknown): ProductHttpError {
  if (error instanceof ProductHttpError) return error;
  if (error instanceof ExportJobConflictError) {
    return new ProductHttpError({
      statusCode: 409,
      code: 'command_in_progress',
      message: error.message,
      recovery: 'same_request',
      sameRequestRetrySafe: true,
      retryAfterSeconds: error.retryAfterSeconds,
      headers: { 'Retry-After': String(error.retryAfterSeconds) },
    });
  }
  if (error instanceof ExportJobInputError) {
    return new ProductHttpError({
      statusCode: 400, code: 'invalid_request', message: error.message,
    });
  }
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
    message: 'The export-job service is temporarily unavailable.', recovery: 'same_request',
  });
}
