import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { observeBestEffort } from '../../infrastructure/async/best-effort.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import { FeedCursorError, FEED_PAGE_MAX_LIMIT, queryCurrentFeed,
  type FeedQueryPorts } from '../../modules/social/index.js';
import type { ProductAdmissionRateLimiter } from '../http-security.js';
import { consumeProductAdmission, rateLimitClientKey } from '../http-security.js';
import { ProductHttpError } from '../product-error.js';
import { requireSessionActor } from '../session-auth.js';

const FEED = '/api/v1/feed';
// FIX-H-004: frozen Phase 5 compatibility path. Additive alias served by the
// same application handler and admission as the successor path above.
const ME_FEED = '/api/v1/me/feed';

export interface FeedRoutesDependencies {
  readonly enabled: boolean;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly queryUnitOfWork: { execute<Result>(work: (ports: FeedQueryPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal }): Promise<Result> };
  readonly rateLimiter: ProductAdmissionRateLimiter;
  readonly timeoutMs: number;
}

export function registerFeedRoutes(app: FastifyInstance, deps: FeedRoutesDependencies): void {
  if (!Number.isInteger(deps.timeoutMs) || deps.timeoutMs < 1 || deps.timeoutMs > 30_000) {
    throw new TypeError('Feed route timeout is outside the application budget.');
  }
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    const query = parseQuery(request.query as Record<string, string | undefined>);
    try {
      const page = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.queryUnitOfWork.execute((ports) => queryCurrentFeed(ports,
          { principalId: account.id, ...query, signal }), { signal }));
      const body = JSON.stringify(page);
      reply.header('Content-Length', Buffer.byteLength(body));
      if (request.method === 'HEAD') return reply.code(200).send();
      return reply.code(200).type('application/json; charset=utf-8').send(body);
    } catch (error: unknown) {
      throw mapError(error);
    }
  };
  const transport = { allowedQuery: ['kind', 'cursor', 'limit'], duplicateQueryErrorCode: 'invalid_request',
    queryErrorCode: 'invalid_request', cacheControl: 'private-no-store' } as const;
  app.get(FEED, { exposeHeadRoute: false, config: { productTransport: transport },
    onRequest: admission(deps) }, handler);
  app.head(FEED, { config: { productTransport: transport }, onRequest: admission(deps),
    onSend: async (_request, _reply, payload) => payload === undefined ? payload : null }, handler);
  app.get(ME_FEED, { exposeHeadRoute: false, config: { productTransport: transport },
    onRequest: admission(deps) }, handler);
  app.head(ME_FEED, { config: { productTransport: transport }, onRequest: admission(deps),
    onSend: async (_request, _reply, payload) => payload === undefined ? payload : null }, handler);
}

function admission(deps: FeedRoutesDependencies) {
  return async (request: FastifyRequest) => {
    if (!deps.enabled) throw new ProductHttpError({ statusCode: 404, code: 'resource_not_found',
      message: 'The requested resource was not found.', recovery: 'none' });
    const decision = await consumeProductAdmission(deps.rateLimiter, rateLimitClientKey(request, FEED));
    if (decision.kind === 'failed') throw unavailable();
    if (decision.kind === 'denied') throw new ProductHttpError({ statusCode: 429, code: 'rate_limited',
      message: 'Too many Feed requests. Please try again later.', recovery: 'same_request',
      sameRequestRetrySafe: true, retryAfterSeconds: decision.retryAfterSeconds,
      headers: { 'Retry-After': String(decision.retryAfterSeconds) } });
  };
}

function parseQuery(query: Record<string, string | undefined>): {
  readonly kind?: string; readonly cursor?: string; readonly limit?: number;
} {
  if (query.cursor !== undefined && (!query.cursor || query.cursor.length > 2048 || query.limit !== undefined)) {
    throw invalidRequest();
  }
  let limit: number | undefined;
  if (query.limit !== undefined) {
    if (!/^[1-9][0-9]*$/u.test(query.limit) || Number(query.limit) > FEED_PAGE_MAX_LIMIT) throw invalidRequest();
    limit = Number(query.limit);
  }
  const kind = query.kind;
  if (kind !== undefined && (!kind || kind.length > 64)) throw invalidRequest();
  return { ...(kind !== undefined ? { kind } : {}),
    ...(query.cursor !== undefined ? { cursor: query.cursor } : {}), ...(limit !== undefined ? { limit } : {}) };
}

async function withCancellation<T>(request: FastifyRequest, timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>): Promise<T> {
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
  try {
    return await Promise.race([work(controller.signal), cancellation]);
  } finally {
    clearTimeout(timeout);
    request.raw.off('aborted', abort);
    request.raw.socket.off('close', abort);
  }
}

function mapError(error: unknown): unknown {
  if (error instanceof ProductHttpError) return error;
  if (error instanceof FeedCursorError) return new ProductHttpError({ statusCode: 400, code: 'invalid_cursor',
    message: 'The Feed cursor is invalid.', recovery: 'restart_from_first_page' });
  if (error instanceof TypeError) return invalidRequest();
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '57014' || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT') {
    return unavailable();
  }
  const kind = (error as { kind?: unknown } | null)?.kind;
  if (kind === 'serialization_failure' || kind === 'deadlock' || kind === 'lock_timeout' || kind === 'unavailable') {
    return unavailable();
  }
  return new ProductHttpError({ statusCode: 500, code: 'internal_error',
    message: 'The Feed request could not be completed.', recovery: 'same_request' });
}

function invalidRequest(): ProductHttpError {
  return new ProductHttpError({ statusCode: 400, code: 'invalid_request', message: 'The Feed request is invalid.' });
}
function unavailable(): ProductHttpError {
  return new ProductHttpError({ statusCode: 503, code: 'feature_temporarily_unavailable',
    message: 'Feed is temporarily unavailable.', recovery: 'same_request', sameRequestRetrySafe: true,
    retryAfterSeconds: 1, headers: { 'Retry-After': '1' } });
}
