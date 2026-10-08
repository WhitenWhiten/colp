import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { observeBestEffort } from '../../infrastructure/async/best-effort.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import {
  LIBRARY_ORDER_MAX_ITEMS,
  LIBRARY_ORDER_SECTIONS,
  LibraryOrderCommandError,
  queryLibraryOrder,
  updateLibraryOrder,
  type LibraryOrderCommandPorts,
  type LibraryOrderQueryPorts,
  type LibraryOrderSection,
  type LibraryOrderView,
} from '../../modules/collections/index.js';
import type { ProductAdmissionRateLimiter } from '../http-security.js';
import { consumeProductAdmission, rateLimitClientKey } from '../http-security.js';
import { readKnownCommandId } from './collection-route-helpers.js';
import { sendProductCommandReceiptOutcome } from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireSessionActor } from '../session-auth.js';
import { requireMutationActor } from '../mutation-actor.js';
import { productErrorStatus } from '../product-codes.js';

const READ = '/api/v1/me/library-order';
const UPDATE = '/api/v1/me/library-order/:section';
const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;
/** 200 ids x up to 128 chars plus JSON overhead stays well inside this limit. */
const UPDATE_BODY_LIMIT_BYTES = 32_768;

export interface LibraryOrderRoutesDependencies {
  readonly allowedOrigins: readonly string[];
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly commandUnitOfWork: {
    execute<Result>(
      work: (ports: LibraryOrderCommandPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  readonly queryUnitOfWork: {
    execute<Result>(
      work: (ports: LibraryOrderQueryPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  readonly rateLimiter: ProductAdmissionRateLimiter;
  readonly timeoutMs: number;
  readonly csrfMatches?: (raw: string, expectedHash: string) => boolean;
  readonly command?: typeof updateLibraryOrder;
  readonly query?: typeof queryLibraryOrder;
}

export function registerLibraryOrderRoutes(
  app: FastifyInstance,
  deps: LibraryOrderRoutesDependencies,
): void {
  if (!Number.isInteger(deps.timeoutMs) || deps.timeoutMs < 1 || deps.timeoutMs > 30_000) {
    throw new TypeError('Library order route timeout is outside the application budget.');
  }

  app.get(READ, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', READ),
      productTransport: {
        allowedQuery: [],
        cacheControl: 'private-no-store',
      },
    },
    onRequest: admission(deps, READ),
  }, async (request, reply) => {
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    try {
      const view = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.queryUnitOfWork.execute((ports) =>
          (deps.query ?? queryLibraryOrder)(ports, { subjectId: account.subjectId }), { signal }));
      return sendView(reply, view);
    } catch (error) {
      throw mapLibraryOrderError(error);
    }
  });

  app.put(UPDATE, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('PUT', UPDATE),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: UPDATE_BODY_LIMIT_BYTES,
        cacheControl: 'private-no-store',
      },
    },
    onRequest: admission(deps, READ),
  }, async (request, reply) => {
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork,
      allowedOrigins: deps.allowedOrigins,
      csrfMatches: deps.csrfMatches,
    });
    const input = {
      actor: { principalId: account.id, subjectId: account.subjectId },
      section: sectionParam(request),
      collectionIds: parseUpdateBody(request.body),
      commandId: readKnownCommandId(request),
    } as const;
    try {
      const outcome = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.commandUnitOfWork.execute((ports) =>
          (deps.command ?? updateLibraryOrder)(ports, input),
        { signal }));
      if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
      return sendOrder(reply, outcome.order);
    } catch (error) {
      throw mapLibraryOrderError(error);
    }
  });
}

function admission(deps: LibraryOrderRoutesDependencies, path: string) {
  return async (request: FastifyRequest) => {
    const decision = await consumeProductAdmission(deps.rateLimiter, rateLimitClientKey(request, path));
    if (decision.kind === 'failed') throw unavailable();
    if (decision.kind === 'denied') {
      throw new ProductHttpError({
        statusCode: 429,
        code: 'rate_limited',
        message: 'Too many Library order requests. Please try again later.',
        recovery: 'same_request',
        sameRequestRetrySafe: true,
        retryAfterSeconds: decision.retryAfterSeconds,
        headers: { 'Retry-After': String(decision.retryAfterSeconds) },
      });
    }
  };
}

function sectionParam(request: FastifyRequest): LibraryOrderSection {
  const value = (request.params as { section?: string }).section;
  if (!value || !(LIBRARY_ORDER_SECTIONS as readonly string[]).includes(value)) {
    throw invalidRequest();
  }
  return value as LibraryOrderSection;
}

function parseUpdateBody(body: unknown): readonly string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalidRequest();
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== 'collectionIds') throw invalidRequest();
  const ids = (body as { collectionIds: unknown }).collectionIds;
  if (!Array.isArray(ids) || ids.length > LIBRARY_ORDER_MAX_ITEMS) throw invalidRequest();
  for (const id of ids) {
    if (typeof id !== 'string' || !OPAQUE_ID.test(id)) throw invalidRequest();
  }
  if (new Set(ids).size !== ids.length) throw invalidRequest();
  return ids as readonly string[];
}

function sendView(reply: FastifyReply, view: LibraryOrderView) {
  return reply
    .code(200)
    .type('application/json; charset=utf-8')
    .header('cache-control', 'private, no-store')
    .send({
      sections: {
        mine: view.sections.mine,
        shared: view.sections.shared,
        following: view.sections.following,
      },
    });
}

function sendOrder(
  reply: FastifyReply,
  order: { readonly section: LibraryOrderSection; readonly collectionIds: readonly string[] },
) {
  return reply
    .code(200)
    .type('application/json; charset=utf-8')
    .header('cache-control', 'private, no-store')
    .send({ section: order.section, collectionIds: order.collectionIds });
}

async function withCancellation<T>(
  request: FastifyRequest,
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let rejectAbort!: (error: Error) => void;
  const cancellation = new Promise<never>((_, reject) => { rejectAbort = reject; });
  observeBestEffort(cancellation,
    'the route race owns cancellation and must observe a rejection before race setup');
  const timeout = setTimeout(() => {
    controller.abort(unavailable());
    rejectAbort(unavailable());
  }, timeoutMs);
  timeout.unref?.();
  const abort = () => {
    controller.abort(unavailable());
    rejectAbort(unavailable());
  };
  request.raw.once('aborted', abort);
  request.raw.socket.once('close', abort);
  const running = work(controller.signal);
  try {
    return await Promise.race([running, cancellation]);
  } finally {
    clearTimeout(timeout);
    request.raw.off('aborted', abort);
    request.raw.socket.off('close', abort);
    observeBestEffort(running,
      'the route cancellation result is authoritative over a late operation rejection');
  }
}

export function mapLibraryOrderError(error: unknown): ProductHttpError {
  if (error instanceof ProductHttpError) return error;
  if (error instanceof LibraryOrderCommandError) {
    return new ProductHttpError({
      statusCode: productErrorStatus('invalid_request'),
      code: 'invalid_request',
      message: error.message,
    });
  }
  if (error instanceof TypeError) return invalidRequest();
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
    message: 'The Library order request could not be completed.',
    recovery: 'same_request',
  });
}

function invalidRequest() {
  return new ProductHttpError({
    statusCode: productErrorStatus('invalid_request'),
    code: 'invalid_request',
    message: 'The Library order request is invalid.',
  });
}

function unavailable() {
  return new ProductHttpError({
    statusCode: productErrorStatus('feature_temporarily_unavailable'),
    code: 'feature_temporarily_unavailable',
    message: 'Library order is temporarily unavailable.',
    recovery: 'same_request',
    sameRequestRetrySafe: true,
    retryAfterSeconds: 1,
    headers: { 'Retry-After': '1' },
  });
}
