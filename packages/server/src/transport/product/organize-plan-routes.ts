import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { observeBestEffort } from '../../infrastructure/async/best-effort.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import {
  applyCollectionOrganizePlan,
  createCollectionOrganizePlan,
  getCollectionOrganizePlan,
  normalizeOrganizePlanActionIds,
  OrganizePlanInnerCommandError,
  OrganizePlanInputError,
  OrganizePlanNotFoundError,
  OrganizePlanRateLimitError,
  type ApplyCollectionOrganizePlanPorts,
  type OrganizePlanApplyReceiptDto,
  type OrganizePlanDto,
  type OrganizePlanReadPort,
  type OrganizePlanner,
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

const COLLECTION = '/api/v1/collections/:collectionId/organize-plans';
const ITEM = '/api/v1/collections/:collectionId/organize-plans/:planId';
const APPLY = '/api/v1/collections/:collectionId/organize-plans/:planId/apply';
const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

export interface OrganizePlanRoutesDependencies {
  readonly enabled: boolean;
  readonly allowedOrigins: readonly string[];
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly reads: OrganizePlanReadPort;
  readonly mutations: {
    execute<Result>(
      work: (ports: ApplyCollectionOrganizePlanPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  readonly planner: OrganizePlanner;
  readonly rateLimiter: ProductAdmissionRateLimiter;
  readonly timeoutMs: number;
  readonly clock?: { now(): Date };
  readonly csrfMatches?: (raw: string, expectedHash: string) => boolean;
}

export function registerOrganizePlanRoutes(app: FastifyInstance, deps: OrganizePlanRoutesDependencies): void {
  if (!Number.isInteger(deps.timeoutMs) || deps.timeoutMs < 1 || deps.timeoutMs > 30_000) {
    throw new TypeError('Organize-plan route timeout is invalid.');
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
    const collectionId = collectionIdParam(request);
    try {
      const outcome = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.mutations.execute((ports) => createCollectionOrganizePlan({
          ...ports,
          planner: deps.planner,
        }, {
          actor: { principalId: account.id, subjectId: account.subjectId },
          commandId,
          collectionId,
          sourceFolderIds: readSourceFolderIds(request.body),
        }), { signal }));
      if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
      return sendPlan(reply, 201, outcome.plan, collectionId);
    } catch (error: unknown) {
      throw mapOrganizeError(error);
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
    await admit(deps.rateLimiter, `organize-plan:principal:${account.id}`);
    const plan = await getCollectionOrganizePlan(deps.reads, {
      actor: { principalId: account.id, subjectId: account.subjectId },
      collectionId: collectionIdParam(request),
      planId: planIdParam(request),
    }, clock);
    if (!plan) throw notFound();
    return sendPlan(reply, 200, plan);
  });

  app.post(APPLY, {
    config: {
      ...productRouteMetadata('POST', APPLY),
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
    await admit(deps.rateLimiter, `${APPLY}:principal:${account.id}`);
    const commandId = readKnownCommandId(request);
    const ifMatch = readRequiredIfMatch(request);
    const collectionId = collectionIdParam(request);
    const planId = planIdParam(request);
    try {
      const actionIds = readActionIds(request.body);
      const outcome = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.mutations.execute((ports) => applyCollectionOrganizePlan(ports, {
          actor: { principalId: account.id, subjectId: account.subjectId },
          commandId,
          collectionId,
          planId,
          ifMatch,
          actionIds,
        }), { signal }));
      if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
      return sendApplyReceipt(reply, outcome.receipt);
    } catch (error: unknown) {
      if (error instanceof OrganizePlanInnerCommandError) {
        return sendProductCommandReceiptOutcome(reply, error.outcome);
      }
      throw mapOrganizeError(error);
    }
  });
}

function sendPlan(reply: FastifyReply, status: number, plan: OrganizePlanDto, collectionId?: string) {
  reply
    .code(status)
    .type('application/json; charset=utf-8')
    .header('etag', plan.etag)
    .header('cache-control', 'private, no-store');
  if (status === 201 && collectionId) {
    reply.header('location', `/api/v1/collections/${collectionId}/organize-plans/${plan.planId}`);
  }
  return reply.send(plan);
}

function sendApplyReceipt(reply: FastifyReply, receipt: OrganizePlanApplyReceiptDto) {
  return reply
    .code(200)
    .type('application/json; charset=utf-8')
    .header('cache-control', 'private, no-store')
    .send(receipt);
}

function collectionIdParam(request: FastifyRequest): string {
  const params = request.params as { collectionId?: string };
  return typeof params.collectionId === 'string' ? params.collectionId : '';
}

function planIdParam(request: FastifyRequest): string {
  const params = request.params as { planId?: string };
  return typeof params.planId === 'string' ? params.planId : '';
}

function readSourceFolderIds(body: unknown): readonly string[] | undefined {
  if (body === undefined || body === null || body === '') return undefined;
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new OrganizePlanInputError('Request body is invalid.');
  }
  const record = body as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => key !== 'sourceFolderIds');
  if (extra.length > 0) throw new OrganizePlanInputError('Request body is invalid.');
  if (!Object.hasOwn(record, 'sourceFolderIds')) return undefined;
  const raw = record.sourceFolderIds;
  if (!Array.isArray(raw)) throw new OrganizePlanInputError('sourceFolderIds is invalid.');
  return raw.map((item) => {
    if (typeof item !== 'string' || !OPAQUE_ID.test(item)) {
      throw new OrganizePlanInputError('sourceFolderIds is invalid.');
    }
    return item;
  });
}

function readActionIds(body: unknown): readonly string[] {
  if (body === undefined || body === null || body === ''
    || typeof body !== 'object' || Array.isArray(body)) {
    throw new OrganizePlanInputError('actionIds is invalid.');
  }
  const record = body as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => key !== 'actionIds');
  if (extra.length > 0) throw new OrganizePlanInputError('Request body is invalid.');
  try {
    return normalizeOrganizePlanActionIds(record.actionIds);
  } catch (error: unknown) {
    if (error instanceof OrganizePlanInputError) throw error;
    throw new OrganizePlanInputError('actionIds is invalid.');
  }
}

async function admit(limiter: ProductAdmissionRateLimiter, key: string): Promise<void> {
  const decision = await consumeProductAdmission(limiter, key);
  if (decision.kind === 'failed') throw unavailable();
  if (decision.kind === 'denied') {
    throw new ProductHttpError({
      statusCode: 429, code: 'rate_limited',
      message: 'Too many organize-plan requests.', recovery: 'same_request',
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

function mapOrganizeError(error: unknown): ProductHttpError {
  if (error instanceof ProductHttpError) return error;
  if (error instanceof OrganizePlanNotFoundError) return notFound();
  if (error instanceof OrganizePlanRateLimitError) {
    return new ProductHttpError({
      statusCode: 429, code: 'rate_limited',
      message: error.message, recovery: 'same_request',
      sameRequestRetrySafe: true,
    });
  }
  if (error instanceof OrganizePlanInputError) {
    return new ProductHttpError({
      statusCode: 400, code: 'invalid_request', message: error.message,
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
    message: 'The organize-plan service is temporarily unavailable.', recovery: 'same_request',
  });
}
