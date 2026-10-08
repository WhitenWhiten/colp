import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { observeBestEffort } from '../../infrastructure/async/best-effort.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import {
  enqueueMyLinkHealthChecks,
  getMyLinkHealthPage,
  LinkHealthChecksError,
  LinkHealthCursorError,
  LinkHealthInputError,
  parseLinkHealthChecksFilter,
  type EnqueueMyLinkHealthChecksPorts,
  type GetMyLinkHealthPagePorts,
  type LinkHealthScope,
  type LinkHealthStatus,
} from '../../modules/collections/index.js';
import type { ProductAdmissionRateLimiter } from '../http-security.js';
import { consumeProductAdmission } from '../http-security.js';
import { readKnownCommandId } from './collection-route-helpers.js';
import { sendProductCommandReceiptOutcome } from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireSessionActor } from '../session-auth.js';
import { requireMutationActor } from '../mutation-actor.js';

const ROUTE = '/api/v1/me/link-health';
const CHECKS = '/api/v1/me/link-health/checks';
const STATUSES = new Set<LinkHealthStatus>(['pending', 'healthy', 'redirect', 'broken']);
const SCOPES = new Set<LinkHealthScope>(['owned', 'shared', 'all']);
const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;
const CANONICAL_ORDER = ['scope', 'status', 'collectionId', 'duplicate', 'limit', 'cursor'] as const;

export interface LinkHealthRoutesDependencies {
  readonly enabled: boolean;
  readonly allowedOrigins: readonly string[];
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly query: GetMyLinkHealthPagePorts;
  readonly enqueue: {
    execute<Result>(
      work: (ports: EnqueueMyLinkHealthChecksPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  readonly rateLimiter: ProductAdmissionRateLimiter;
  readonly timeoutMs: number;
  readonly csrfMatches?: (raw: string, expectedHash: string) => boolean;
}

export function registerLinkHealthRoutes(app: FastifyInstance, deps: LinkHealthRoutesDependencies): void {
  if (!Number.isInteger(deps.timeoutMs) || deps.timeoutMs < 1 || deps.timeoutMs > 30_000) {
    throw new TypeError('Link-health route timeout is invalid.');
  }
  app.get(ROUTE, {
    config: {
      ...productRouteMetadata('GET', ROUTE),
      productTransport: {
        allowedQuery: [...CANONICAL_ORDER],
        duplicateQueryErrorCode: 'invalid_query',
        queryErrorCode: 'invalid_query',
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    if (!deps.enabled) throw notFound();
    await admit(deps.rateLimiter, `${ROUTE}:principal:${account.id}`);
    const query = parseLinkHealthQuery(request);
    try {
      const page = await getMyLinkHealthPage(deps.query, {
        actor: { subjectId: account.subjectId }, ...query,
      });
      return reply.code(200).type('application/json; charset=utf-8').send(page);
    } catch (error: unknown) {
      if (error instanceof LinkHealthCursorError) throw invalidCursor();
      if (error instanceof LinkHealthInputError) throw invalidQuery();
      throw error;
    }
  });

  app.post(CHECKS, {
    config: {
      ...productRouteMetadata('POST', CHECKS),
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
    await admit(deps.rateLimiter, `${CHECKS}:principal:${account.id}`);
    const commandId = readKnownCommandId(request);
    let filter;
    try {
      filter = parseLinkHealthChecksFilter(request.body);
    } catch (error: unknown) {
      throw mapChecksError(error);
    }
    try {
      const outcome = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.enqueue.execute((ports) => enqueueMyLinkHealthChecks(ports, {
          actor: { principalId: account.id, subjectId: account.subjectId },
          commandId,
          filter,
        }), { signal }));
      if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
      return sendChecksReceipt(reply, outcome.queued);
    } catch (error: unknown) {
      throw mapChecksError(error);
    }
  });
}

function sendChecksReceipt(reply: FastifyReply, queued: number) {
  return reply.code(200).type('application/json; charset=utf-8').send({ queued });
}

async function admit(limiter: ProductAdmissionRateLimiter, key: string): Promise<void> {
  const decision = await consumeProductAdmission(limiter, key);
  if (decision.kind === 'failed') throw unavailable();
  if (decision.kind === 'denied') {
    throw new ProductHttpError({
      statusCode: 429, code: 'rate_limited',
      message: 'Too many link-health requests.', recovery: 'same_request',
      sameRequestRetrySafe: true, retryAfterSeconds: decision.retryAfterSeconds,
      headers: { 'Retry-After': String(decision.retryAfterSeconds) },
    });
  }
}

function parseLinkHealthQuery(request: FastifyRequest): {
  readonly status?: LinkHealthStatus;
  readonly collectionId?: string;
  readonly duplicate?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
  readonly scope?: LinkHealthScope;
} {
  const query = request.query as Record<string, string>;
  assertCanonicalRawQuery(request.raw.url ?? request.url, query);
  const present = (name: string) => Object.hasOwn(query, name);
  if (present('cursor')) {
    if (present('scope') || present('status') || present('collectionId') || present('duplicate') || present('limit')) {
      throw invalidQuery();
    }
    if (typeof query.cursor !== 'string' || query.cursor.length < 1) throw invalidQuery();
    return { cursor: query.cursor };
  }
  const result: {
    status?: LinkHealthStatus; collectionId?: string; duplicate?: boolean; limit?: number;
    scope?: LinkHealthScope;
  } = {};
  if (present('scope')) {
    if (typeof query.scope !== 'string' || !SCOPES.has(query.scope as LinkHealthScope)) throw invalidQuery();
    result.scope = query.scope as LinkHealthScope;
  }
  if (present('status')) {
    if (typeof query.status !== 'string' || !STATUSES.has(query.status as LinkHealthStatus)) throw invalidQuery();
    result.status = query.status as LinkHealthStatus;
  }
  if (present('collectionId')) {
    if (typeof query.collectionId !== 'string' || !OPAQUE_ID.test(query.collectionId)) throw invalidQuery();
    result.collectionId = query.collectionId;
  }
  if (present('duplicate')) {
    if (query.duplicate !== 'true' && query.duplicate !== 'false') throw invalidQuery();
    result.duplicate = query.duplicate === 'true';
  }
  if (present('limit')) {
    if (typeof query.limit !== 'string' || !/^(?:[1-9]|[1-9][0-9]|100)$/u.test(query.limit)) throw invalidQuery();
    result.limit = Number(query.limit);
  }
  return result;
}

function assertCanonicalRawQuery(url: string, parsed: Record<string, string>): void {
  const marker = url.indexOf('?');
  if (marker < 0) return;
  const raw = url.slice(marker + 1);
  if (raw.length === 0) throw invalidQuery();
  let previousIndex = -1;
  const seen = new Set<string>();
  for (const entry of raw.split('&')) {
    const separator = entry.indexOf('=');
    if (separator < 1) throw invalidQuery();
    const rawName = entry.slice(0, separator); const rawValue = entry.slice(separator + 1);
    let name: string; let value: string;
    try { name = decodeURIComponent(rawName); value = decodeURIComponent(rawValue); }
    catch { throw invalidQuery(); }
    const orderIndex = CANONICAL_ORDER.indexOf(name as typeof CANONICAL_ORDER[number]);
    if (orderIndex < 0 || orderIndex <= previousIndex || seen.has(name)
      || rawName !== encodeURIComponent(name) || rawValue !== encodeURIComponent(value)
      || parsed[name] !== value) throw invalidQuery();
    seen.add(name);
    previousIndex = orderIndex;
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

function mapChecksError(error: unknown): ProductHttpError {
  if (error instanceof ProductHttpError) return error;
  if (error instanceof LinkHealthChecksError) {
    if (error.code === 'invalid_document') {
      return new ProductHttpError({
        statusCode: 422, code: 'invalid_document',
        message: error.message, recovery: 'user_action',
      });
    }
    return new ProductHttpError({
      statusCode: 400, code: 'invalid_request', message: error.message,
    });
  }
  throw error;
}

function invalidQuery() {
  return new ProductHttpError({
    statusCode: 400, code: 'invalid_query', message: 'The link-health query is invalid.',
  });
}
function invalidCursor() {
  return new ProductHttpError({
    statusCode: 400, code: 'invalid_cursor', message: 'The link-health cursor is invalid.',
    recovery: 'restart_from_first_page',
  });
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
    message: 'The link-health service is temporarily unavailable.', recovery: 'same_request',
  });
}
