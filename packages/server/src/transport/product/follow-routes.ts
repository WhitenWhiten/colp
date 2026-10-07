import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { observeBestEffort } from '../../infrastructure/async/best-effort.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import {
  FollowCommandError, FollowCursorError, FOLLOW_PAGE_MAX_LIMIT,
  followProfile, queryFollowRelations, unfollowProfile,
  type FollowCommandErrorCode, type FollowCommandPorts, type FollowCommandResult, type FollowQueryPorts,
} from '../../modules/social/index.js';
import type { ProductAdmissionRateLimiter } from '../http-security.js';
import { consumeProductAdmission, rateLimitClientKey } from '../http-security.js';
import { readKnownCommandId } from './collection-route-helpers.js';
import { sendProductCommandReceiptOutcome } from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireSessionActor } from '../session-auth.js';
import { requireMutationActor } from '../mutation-actor.js';
import { productErrorStatus } from '../product-codes.js';

const FOLLOW = '/api/v1/profiles/:profileId/follow';
const FOLLOWERS = '/api/v1/profiles/:profileId/followers';
const FOLLOWING = '/api/v1/profiles/:profileId/following';
const CANONICAL_PROFILE_ID = /^[A-Za-z0-9_-]{21}[AQgw]$/u;

export interface FollowRoutesDependencies {
  readonly enabled: boolean;
  readonly allowedOrigins: readonly string[];
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly commandUnitOfWork: { execute<Result>(work: (ports: FollowCommandPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal }): Promise<Result> };
  readonly queryUnitOfWork: { execute<Result>(work: (ports: FollowQueryPorts) => Promise<Result>): Promise<Result> };
  readonly rateLimiter: ProductAdmissionRateLimiter;
  readonly timeoutMs: number;
  readonly csrfMatches?: (raw: string, expectedHash: string) => boolean;
  readonly command?: (ports: FollowCommandPorts, input: Parameters<typeof followProfile>[1] & { action: 'follow'|'unfollow' }) => Promise<FollowCommandResult>;
  readonly query?: typeof queryFollowRelations;
}

export function registerFollowRoutes(app: FastifyInstance, deps: FollowRoutesDependencies): void {
  if (!Number.isInteger(deps.timeoutMs) || deps.timeoutMs < 1 || deps.timeoutMs > 30_000) {
    throw new TypeError('Follow route timeout is outside the application budget.');
  }
  for (const [method, action] of [['PUT', 'follow'], ['DELETE', 'unfollow']] as const) {
    app.route({ method, url: FOLLOW, exposeHeadRoute: false, config: {
      ...productRouteMetadata(method, FOLLOW),
      productTransport: { allowedQuery: [], acceptedMediaTypes: [], bodyLimitBytes: 1,
        cacheControl: 'private-no-store' },
    }, onRequest: admission(deps, FOLLOW), handler: async (request, reply) => {
      const { account } = await requireMutationActor(request, {
        identityUnitOfWork: deps.identityUnitOfWork,
        allowedOrigins: deps.allowedOrigins,
        csrfMatches: deps.csrfMatches,
      });
      const input = { actor: { principalId: account.id, profileId: account.id },
        targetProfileId: profileId(request), commandId: readKnownCommandId(request), action } as const;
      try {
        const outcome = await withCancellation(request, deps.timeoutMs, (signal) => deps.commandUnitOfWork.execute((ports) =>
          deps.command ? deps.command(ports, input) : action === 'follow' ? followProfile(ports, input) : unfollowProfile(ports, input),
        { signal }));
        if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
        return reply.code(200).type('application/json; charset=utf-8').send(relationDto(outcome.relation));
      } catch (error) { throw mapFollowError(error); }
    } });
  }
  registerList(app, deps, FOLLOWERS, 'followers');
  registerList(app, deps, FOLLOWING, 'following');
}

function registerList(app: FastifyInstance, deps: FollowRoutesDependencies, path: string,
  direction: 'followers'|'following'): void {
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    const query = parseQuery(request.query as Record<string, string>);
    try {
      const page = await withCancellation(request, deps.timeoutMs, (signal) => deps.queryUnitOfWork.execute((ports) =>
        (deps.query ?? queryFollowRelations)(ports, { principalId: account.id,
          targetProfileId: profileId(request), direction, ...query, signal })));
      if (page === null) throw notFound();
      const body = JSON.stringify(page);
      reply.header('Content-Length', Buffer.byteLength(body));
      if (request.method === 'HEAD') return reply.code(200).send();
      return reply.code(200).type('application/json; charset=utf-8').send(body);
    } catch (error) { throw mapFollowError(error); }
  };
  app.get(path, { exposeHeadRoute: false, config: { ...productRouteMetadata('GET', path),
    productTransport: { allowedQuery: ['cursor', 'limit'], duplicateQueryErrorCode: 'invalid_request', queryErrorCode: 'invalid_request',
      cacheControl: 'private-no-store' } }, onRequest: admission(deps, path) }, handler);
  app.head(path, { config: { ...productRouteMetadata('HEAD', path),
    productTransport: { allowedQuery: ['cursor', 'limit'], duplicateQueryErrorCode: 'invalid_request', queryErrorCode: 'invalid_request',
      cacheControl: 'private-no-store' } }, onRequest: admission(deps, path),
    onSend: async (_request, _reply, payload) => payload === undefined ? payload : null }, handler);
}

function admission(deps: FollowRoutesDependencies, path: string) {
  return async (request: FastifyRequest) => {
    if (!deps.enabled) throw new ProductHttpError({ statusCode: 404, code: 'resource_not_found',
      message: 'The requested resource was not found.', recovery: 'none' });
    const decision = await consumeProductAdmission(deps.rateLimiter, rateLimitClientKey(request, path));
    if (decision.kind === 'failed') throw unavailable();
    if (decision.kind === 'denied') throw new ProductHttpError({ statusCode: 429, code: 'rate_limited',
      message: 'Too many Follow requests. Please try again later.', recovery: 'same_request',
      sameRequestRetrySafe: true, retryAfterSeconds: decision.retryAfterSeconds,
      headers: { 'Retry-After': String(decision.retryAfterSeconds) } });
  };
}

function profileId(request: FastifyRequest): string {
  const value = (request.params as { profileId?: string }).profileId;
  if (!value || !CANONICAL_PROFILE_ID.test(value)) {
    throw invalidRequest();
  }
  return value;
}
function parseQuery(query: Record<string, string>): { cursor?: string; limit?: number } {
  if (query.cursor !== undefined && (!query.cursor || query.cursor.length > 2048 || query.limit !== undefined)) throw invalidRequest();
  if (query.limit === undefined) return query.cursor ? { cursor: query.cursor } : {};
  if (!/^[1-9][0-9]*$/u.test(query.limit) || Number(query.limit) > FOLLOW_PAGE_MAX_LIMIT) throw invalidRequest();
  return { limit: Number(query.limit) };
}
function relationDto(value: { actorProfileId: string; targetProfileId: string; following: boolean; changedAt: Date }) {
  return { actorProfileId: value.actorProfileId, targetProfileId: value.targetProfileId,
    following: value.following, changedAt: value.changedAt.toISOString() };
}
async function withCancellation<T>(request: FastifyRequest, timeoutMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let rejectAbort!: (error: Error) => void;
  const cancellation = new Promise<never>((_, reject) => { rejectAbort = reject; });
  observeBestEffort(cancellation,
    'the route race owns cancellation and must observe a rejection before race setup');
  const timeout = setTimeout(() => { controller.abort(); rejectAbort(unavailable()); }, timeoutMs); timeout.unref?.();
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
const FOLLOW_COMMAND_ERROR_MAP = {
  resource_not_found: notFound,
  invalid_request: invalidRequest,
} as const satisfies Readonly<Record<FollowCommandErrorCode, () => ProductHttpError>>;

export function mapFollowError(error: unknown): ProductHttpError {
  if (error instanceof ProductHttpError) return error;
  if (error instanceof FollowCursorError) return new ProductHttpError({ statusCode: productErrorStatus('invalid_cursor'),
    code: 'invalid_cursor', message: 'The Follow cursor is invalid.', recovery: 'restart_from_first_page' });
  if (error instanceof FollowCommandError) return FOLLOW_COMMAND_ERROR_MAP[error.code]();
  if (error instanceof TypeError) return invalidRequest();
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '57014' || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT') return unavailable();
  const kind = (error as { kind?: unknown } | null)?.kind;
  if (kind === 'serialization_failure' || kind === 'deadlock' || kind === 'lock_timeout' || kind === 'unavailable') return unavailable();
  return new ProductHttpError({ statusCode: productErrorStatus('internal_error'), code: 'internal_error',
    message: 'The Follow request could not be completed.', recovery: 'same_request' });
}
function invalidRequest() { return new ProductHttpError({ statusCode: productErrorStatus('invalid_request'), code: 'invalid_request', message: 'The Follow request is invalid.' }); }
function notFound() { return new ProductHttpError({ statusCode: productErrorStatus('resource_not_found'), code: 'resource_not_found', message: 'The requested Profile was not found.', recovery: 'none' }); }
function unavailable() { return new ProductHttpError({ statusCode: productErrorStatus('feature_temporarily_unavailable'), code: 'feature_temporarily_unavailable',
  message: 'Follow is temporarily unavailable.', recovery: 'same_request', sameRequestRetrySafe: true,
  retryAfterSeconds: 1, headers: { 'Retry-After': '1' } }); }
