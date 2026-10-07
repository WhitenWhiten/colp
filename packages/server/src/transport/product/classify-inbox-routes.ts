import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { observeBestEffort } from '../../infrastructure/async/best-effort.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import {
  ClassifyInboxAcceptError,
  ClassifyInboxCursorError,
  ClassifyInboxInputError,
  ClassifyInboxSkipError,
  acceptClassifyInboxItem,
  getMyClassifyInboxPage,
  parseClassifyInboxAcceptBody,
  parseClassifyInboxSkipBody,
  skipClassifyInboxItem,
  type AcceptClassifyInboxItemPorts,
  type ClassifyInboxDecisionReceipt,
  type GetMyClassifyInboxPagePorts,
  type SkipClassifyInboxItemPorts,
} from '../../modules/collections/index.js';
import type { ProductAdmissionRateLimiter } from '../http-security.js';
import { consumeProductAdmission } from '../http-security.js';
import { readKnownCommandId, readNodeIdParam, readRequiredIfMatch } from './collection-route-helpers.js';
import { rethrowCollectionMutationError, sendProductCommandReceiptOutcome } from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireSessionActor } from '../session-auth.js';
import { requireMutationActor } from '../mutation-actor.js';

const ROUTE = '/api/v1/me/classify-inbox';
const SKIP = '/api/v1/me/classify-inbox/:nodeId/skip';
const ACCEPT = '/api/v1/me/classify-inbox/:nodeId/accept';
const CANONICAL_ORDER = ['limit', 'cursor'] as const;

export interface ClassifyInboxRoutesDependencies {
  readonly enabled: boolean;
  readonly classificationTagsEnabled?: boolean;
  readonly allowedOrigins: readonly string[];
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly query: GetMyClassifyInboxPagePorts;
  readonly skip: {
    execute<Result>(
      work: (ports: SkipClassifyInboxItemPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  readonly accept: {
    execute<Result>(
      work: (ports: AcceptClassifyInboxItemPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  readonly rateLimiter: ProductAdmissionRateLimiter;
  readonly timeoutMs: number;
  readonly csrfMatches?: (raw: string, expectedHash: string) => boolean;
}

export function registerClassifyInboxRoutes(app: FastifyInstance, deps: ClassifyInboxRoutesDependencies): void {
  if (!Number.isInteger(deps.timeoutMs) || deps.timeoutMs < 1 || deps.timeoutMs > 30_000) {
    throw new TypeError('Classify-inbox route timeout is invalid.');
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
    await admit(deps.rateLimiter, `classify-inbox:principal:${account.id}`);
    const query = parseClassifyInboxQuery(request);
    try {
      const page = await getMyClassifyInboxPage(deps.query, {
        actor: { subjectId: account.subjectId }, ...query,
      });
      return reply.code(200).type('application/json; charset=utf-8').send(page);
    } catch (error: unknown) {
      if (error instanceof ClassifyInboxCursorError) throw invalidCursor();
      if (error instanceof ClassifyInboxInputError) throw invalidQuery();
      throw error;
    }
  });

  app.post(SKIP, {
    config: {
      ...productRouteMetadata('POST', SKIP),
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
    await admit(deps.rateLimiter, `classify-inbox-skip:principal:${account.id}`);
    const commandId = readKnownCommandId(request);
    const nodeId = readNodeIdParam(request);
    try {
      parseClassifyInboxSkipBody(request.body);
    } catch (error: unknown) {
      throw mapSkipError(error);
    }
    try {
      const outcome = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.skip.execute((ports) => skipClassifyInboxItem(ports, {
          actor: { principalId: account.id, subjectId: account.subjectId },
          commandId,
          nodeId,
          body: request.body,
        }), { signal }));
      if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
      return sendSkipReceipt(reply, outcome.receipt);
    } catch (error: unknown) {
      throw mapSkipError(error);
    }
  });

  app.post(ACCEPT, {
    config: {
      ...productRouteMetadata('POST', ACCEPT),
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
    await admit(deps.rateLimiter, `classify-inbox-accept:principal:${account.id}`);
    const commandId = readKnownCommandId(request);
    const nodeId = readNodeIdParam(request);
    const ifMatch = readRequiredIfMatch(request);
    try {
      const parsed=parseClassifyInboxAcceptBody(request.body);
      if(deps.classificationTagsEnabled===false&&parsed.addTags?.length)throw notFound();
    } catch (error: unknown) {
      throw mapAcceptError(error);
    }
    try {
      const outcome = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.accept.execute((ports) => acceptClassifyInboxItem(ports, {
          actor: { principalId: account.id, subjectId: account.subjectId },
          commandId,
          nodeId,
          ifMatch,
          body: request.body,
        }), { signal }));
      if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
      return sendAcceptReceipt(reply, outcome.receipt);
    } catch (error: unknown) {
      throw mapAcceptError(error);
    }
  });
}

function sendSkipReceipt(reply: FastifyReply, receipt: ClassifyInboxDecisionReceipt) {
  return reply.code(200).type('application/json; charset=utf-8').send(receipt);
}

function sendAcceptReceipt(reply: FastifyReply, receipt: ClassifyInboxDecisionReceipt) {
  return reply.code(200).type('application/json; charset=utf-8').send(receipt);
}

async function admit(limiter: ProductAdmissionRateLimiter, key: string): Promise<void> {
  const decision = await consumeProductAdmission(limiter, key);
  if (decision.kind === 'failed') throw unavailable();
  if (decision.kind === 'denied') {
    throw new ProductHttpError({
      statusCode: 429, code: 'rate_limited',
      message: 'Too many classify-inbox requests.', recovery: 'same_request',
      sameRequestRetrySafe: true, retryAfterSeconds: decision.retryAfterSeconds,
      headers: { 'Retry-After': String(decision.retryAfterSeconds) },
    });
  }
}

function parseClassifyInboxQuery(request: FastifyRequest): {
  readonly limit?: number;
  readonly cursor?: string;
} {
  const query = request.query as Record<string, string>;
  assertCanonicalRawQuery(request.raw.url ?? request.url, query);
  const present = (name: string) => Object.hasOwn(query, name);
  if (present('cursor')) {
    if (present('limit')) throw invalidQuery();
    if (typeof query.cursor !== 'string' || query.cursor.length < 1) throw invalidQuery();
    return { cursor: query.cursor };
  }
  if (present('limit')) {
    if (typeof query.limit !== 'string' || !/^(?:[1-9]|[1-4][0-9]|50)$/u.test(query.limit)) throw invalidQuery();
    return { limit: Number(query.limit) };
  }
  return {};
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

function mapSkipError(error: unknown): ProductHttpError {
  if (error instanceof ProductHttpError) return error;
  if (error instanceof ClassifyInboxSkipError) {
    if (error.code === 'invalid_document') {
      return new ProductHttpError({
        statusCode: 422, code: 'invalid_document',
        message: error.message, recovery: 'user_action',
      });
    }
    if (error.code === 'resource_not_found') return notFound();
    return new ProductHttpError({
      statusCode: 400, code: 'invalid_request', message: error.message,
    });
  }
  throw error;
}

function mapAcceptError(error: unknown): ProductHttpError {
  if (error instanceof ProductHttpError) return error;
  if (error instanceof ClassifyInboxAcceptError) {
    if (error.code === 'invalid_document') {
      return new ProductHttpError({
        statusCode: 422, code: 'invalid_document',
        message: error.message, recovery: 'user_action',
      });
    }
    if (error.code === 'resource_not_found') return notFound();
    return new ProductHttpError({
      statusCode: 400, code: 'invalid_request', message: error.message,
    });
  }
  rethrowCollectionMutationError(error, 'node-update-or-move');
}

function invalidQuery() {
  return new ProductHttpError({
    statusCode: 400, code: 'invalid_query', message: 'The classify-inbox query is invalid.',
  });
}
function invalidCursor() {
  return new ProductHttpError({
    statusCode: 400, code: 'invalid_cursor', message: 'The classify-inbox cursor is invalid.',
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
    message: 'The classify-inbox service is temporarily unavailable.', recovery: 'same_request',
  });
}
