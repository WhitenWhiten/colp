import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { observeBestEffort } from '../../infrastructure/async/best-effort.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import {
  CommunityCommentError,
  CommunityNotificationError,
  CommunityRankingError,
  CommunityTargetError,
  CommunityVoteCommandError,
  communityTargetViewEtag,
  createCommunityRankingCursorCodec,
  listCommunityRanking,
  parseCommunityRankingQuery,
  parseCommunityTarget,
  parseCommunityTargetQuery,
  resolveCommunityTargetView,
  setCommunityVote,
  type CommunityRankingPageView,
  type CommunityRankingQueryPorts,
  type CommunityTargetQueryPorts,
  type CommunityTargetView,
  type CommunityVoteCommandPorts,
  type CommunityVoteCommandResult,
  type CommunityVoteState,
} from '../../modules/community/index.js';
import type { CommunityRateLimitFamily, CommunityRateLimiters } from '../http-security.js';
import { consumeProductAdmission } from '../http-security.js';
import { readKnownCommandId } from './collection-route-helpers.js';
import { sendProductCommandReceiptOutcome } from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { optionalSessionActor, type ProductActor } from '../session-auth.js';
import { requireMutationActor } from '../mutation-actor.js';
import { productErrorStatus } from '../product-codes.js';

const TARGET = '/api/v1/community/target';
const VOTE = '/api/v1/community/vote';
const RANKING = '/api/v1/community/ranking';
const VOTE_BODY_LIMIT_BYTES = 32_768;

export interface CommunityRoutesDependencies {
  readonly enabled: boolean;
  readonly allowedOrigins: readonly string[];
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly commandUnitOfWork: {
    execute<Result>(
      work: (ports: CommunityVoteCommandPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  readonly queryUnitOfWork: {
    execute<Result>(
      work: (ports: CommunityTargetQueryPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  /** CS-02: durable hot-ranking snapshot query port. */
  readonly rankingQueryUnitOfWork: {
    execute<Result>(
      work: (ports: CommunityRankingQueryPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  /** CS contract families: TARGET/RANKING consume `publicReads`, VOTE consumes `vote`. */
  readonly rateLimits: CommunityRateLimiters;
  readonly timeoutMs: number;
  /** COMMUNITY_CURSOR_HMAC_KEY: keyed ETag + ranking cursor derivation. */
  readonly etagHmacKey: Buffer;
  readonly csrfMatches?: (raw: string, expectedHash: string) => boolean;
  readonly command?: typeof setCommunityVote;
  readonly query?: typeof resolveCommunityTargetView;
  readonly rankingQuery?: typeof listCommunityRanking;
}

export function registerCommunityRoutes(
  app: FastifyInstance,
  deps: CommunityRoutesDependencies,
): void {
  if (!Number.isInteger(deps.timeoutMs) || deps.timeoutMs < 1 || deps.timeoutMs > 30_000) {
    throw new TypeError('Community route timeout is outside the application budget.');
  }
  if (!(deps.etagHmacKey instanceof Buffer) || deps.etagHmacKey.length < 16) {
    throw new TypeError('Community routes require a configured ETag HMAC key.');
  }

  app.get(TARGET, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', TARGET),
      productTransport: {
        allowedQuery: ['kind', 'id', 'collectionId', 'seriesId'],
        duplicateQueryErrorCode: 'invalid_query',
        queryErrorCode: 'invalid_query',
        cacheControl: 'private-no-store',
      },
    },
    onRequest: communityAdmission(deps, 'publicReads'),
  }, async (request, reply) => {
    if (!deps.enabled) throw communityNotFound();
    const session = await communitySessionActor(request, deps.identityUnitOfWork);
    const viewer = session === null
      ? { accountId: null, subjectId: null }
      : { accountId: session.account.id, subjectId: session.account.subjectId };
    let targetQuery;
    try {
      targetQuery = parseCommunityTargetQuery(request.query as Record<string, unknown>);
    } catch (error) {
      throw mapCommunityError(error);
    }
    try {
      const view = await withCommunityCancellation(request, deps.timeoutMs, (signal) =>
        deps.queryUnitOfWork.execute((ports) =>
          (deps.query ?? resolveCommunityTargetView)(ports, { viewer, query: targetQuery }), { signal }));
      return sendView(reply, view, deps.etagHmacKey);
    } catch (error) {
      throw mapCommunityError(error);
    }
  });

  app.put(VOTE, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('PUT', VOTE),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: VOTE_BODY_LIMIT_BYTES,
        cacheControl: 'private-no-store',
      },
    },
    onRequest: communityAdmission(deps, 'vote'),
  }, async (request, reply) => {
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork,
      allowedOrigins: deps.allowedOrigins,
      csrfMatches: deps.csrfMatches,
    });
    if (!deps.enabled) throw communityNotFound();
    const body = parseVoteBody(request.body);
    const input = {
      actor: { principalId: account.id, subjectId: account.subjectId },
      target: body.target,
      value: body.value,
      commandId: readKnownCommandId(request),
    } as const;
    try {
      const outcome = await withCommunityCancellation(request, deps.timeoutMs, (signal) =>
        deps.commandUnitOfWork.execute((ports) =>
          (deps.command ?? setCommunityVote)(ports, input),
        { signal }));
      if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
      return sendState(reply, outcome.state);
    } catch (error) {
      throw mapCommunityError(error);
    }
  });

  const rankingCursorCodec = createCommunityRankingCursorCodec(deps.etagHmacKey);
  app.get(RANKING, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', RANKING),
      productTransport: {
        allowedQuery: ['kind', 'collectionId', 'q', 'tag', 'language', 'limit', 'cursor'],
        duplicateQueryErrorCode: 'invalid_query',
        queryErrorCode: 'invalid_query',
        cacheControl: 'private-no-store',
      },
    },
    onRequest: communityAdmission(deps, 'publicReads'),
  }, async (request, reply) => {
    if (!deps.enabled) throw communityNotFound();
    const session = await communitySessionActor(request, deps.identityUnitOfWork);
    const viewer = session === null
      ? { accountId: null, subjectId: null }
      : { accountId: session.account.id, subjectId: session.account.subjectId };
    let query;
    try {
      query = parseCommunityRankingQuery(request.query as Record<string, unknown>);
    } catch (error) {
      throw mapCommunityError(error);
    }
    try {
      const page = await withCommunityCancellation(request, deps.timeoutMs, (signal) =>
        deps.rankingQueryUnitOfWork.execute((ports) =>
          (deps.rankingQuery ?? listCommunityRanking)(ports, {
            viewer, query, cursorCodec: rankingCursorCodec,
          }), { signal }));
      return sendPage(reply, page);
    } catch (error) {
      throw mapCommunityError(error);
    }
  });
}

/**
 * Per-request memoized optional session: admission consumes the resolved
 * account (or trusted client) and the read handlers reuse the same
 * resolution, so a community request never pays two session lookups.
 */
const communitySessionCache = new WeakMap<FastifyRequest, Promise<ProductActor | null>>();

export function communitySessionActor(
  request: FastifyRequest,
  identityUnitOfWork: IdentityUnitOfWork | undefined,
): Promise<ProductActor | null> {
  const cached = communitySessionCache.get(request);
  if (cached !== undefined) return cached;
  const pending = optionalSessionActor(request, identityUnitOfWork);
  communitySessionCache.set(request, pending);
  // A mutation route may never re-await the cached resolution; the
  // rejection still reaches every actual caller, but it must not count as
  // unhandled when nobody awaits it.
  observeBestEffort(pending,
    'community admission session resolution is shared with the read handler');
  return pending;
}

/**
 * Contract COMMUNITY_RATE_LIMITS admission: each family is an independent
 * counter consumed BEFORE the handler runs — denied targets, validation
 * rejections, auth refusals and retries all spend the family quota.
 * Subjects: `account:<id>` when a session resolves, `ip:<trusted client>`
 * otherwise (request.ip is trusted-ingress resolved, never raw headers).
 * A session-resolution failure cannot mint an identity: the request
 * consumes the client bucket and the handler surfaces the real error.
 */
export function communityAdmission(
  deps: {
    readonly rateLimits: CommunityRateLimiters;
    readonly identityUnitOfWork?: IdentityUnitOfWork;
  },
  family: CommunityRateLimitFamily,
) {
  return async (request: FastifyRequest) => {
    let session: ProductActor | null = null;
    try {
      session = await communitySessionActor(request, deps.identityUnitOfWork);
    } catch {
      session = null;
    }
    const ip = typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : 'unknown';
    const subject = session === null ? `ip:${ip}` : `account:${session.account.id}`;
    const decision = await consumeProductAdmission(deps.rateLimits[family], subject);
    if (decision.kind === 'failed') throw communityUnavailable();
    if (decision.kind === 'denied') {
      throw new ProductHttpError({
        statusCode: 429,
        code: 'rate_limited',
        message: 'Too many community requests. Please try again later.',
        recovery: 'same_request',
        sameRequestRetrySafe: true,
        retryAfterSeconds: decision.retryAfterSeconds,
        headers: { 'Retry-After': String(decision.retryAfterSeconds) },
      });
    }
  };
}

function parseVoteBody(body: unknown): { readonly target: unknown; readonly value: unknown } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw communityInvalidRequest();
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.length !== 2 || !keys.includes('target') || !keys.includes('value')) throw communityInvalidRequest();
  const record = body as { target: unknown; value: unknown };
  // Structural validation happens once, here at the wire boundary; the
  // command re-validates before reconciling so a bad body never reaches SQL.
  try {
    parseCommunityTarget(record.target);
  } catch {
    throw communityInvalidRequest();
  }
  if (record.value !== -1 && record.value !== 0 && record.value !== 1) throw communityInvalidRequest();
  return record;
}

function sendView(reply: FastifyReply, view: CommunityTargetView, hmacKey: Buffer) {
  return reply
    .code(200)
    .type('application/json; charset=utf-8')
    .header('cache-control', 'private, no-store')
    .header('etag', communityTargetViewEtag(view, hmacKey))
    .send(view);
}

function sendState(reply: FastifyReply, state: CommunityVoteState) {
  return reply
    .code(200)
    .type('application/json; charset=utf-8')
    .header('cache-control', 'private, no-store')
    .send({
      target: state.target,
      up: state.up,
      down: state.down,
      myVote: state.myVote,
    });
}

function sendPage(reply: FastifyReply, page: CommunityRankingPageView) {
  return reply
    .code(200)
    .type('application/json; charset=utf-8')
    .header('cache-control', 'private, no-store')
    .send({
      items: page.items,
      nextCursor: page.nextCursor,
      asOf: page.asOf,
      scoreVersion: page.scoreVersion,
    });
}

export async function withCommunityCancellation<T>(
  request: FastifyRequest,
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
  unavailableError: () => ProductHttpError = communityUnavailable,
): Promise<T> {
  const controller = new AbortController();
  let rejectAbort!: (error: Error) => void;
  const cancellation = new Promise<never>((_, reject) => { rejectAbort = reject; });
  observeBestEffort(cancellation,
    'the route race owns cancellation and must observe a rejection before race setup');
  const timeout = setTimeout(() => {
    controller.abort(unavailableError());
    rejectAbort(unavailableError());
  }, timeoutMs);
  timeout.unref?.();
  const abort = () => {
    controller.abort(unavailableError());
    rejectAbort(unavailableError());
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

export function mapCommunityError(error: unknown): ProductHttpError {
  if (error instanceof ProductHttpError) return error;
  if (error instanceof CommunityTargetError || error instanceof CommunityVoteCommandError
      || error instanceof CommunityCommentError || error instanceof CommunityNotificationError) {
    const status = productErrorStatus(error.code);
    return new ProductHttpError({
      statusCode: status,
      code: error.code,
      message: error.message,
      ...(error.code === 'revision_conflict'
        ? { recovery: 'refresh_and_retry' as const, precondition: 'content' as const }
        : {}),
      ...((error instanceof CommunityCommentError || error instanceof CommunityNotificationError)
          && error.code === 'precondition_failed'
        ? {
            recovery: 'refresh_and_retry' as const,
            precondition: 'resource' as const,
            currentEtag: error.currentEtag,
          }
        : {}),
    });
  }
  if (error instanceof CommunityRankingError) {
    return new ProductHttpError({
      statusCode: productErrorStatus(error.code),
      code: error.code,
      message: error.message,
      ...(error.code === 'snapshot_expired'
        ? { recovery: 'restart_from_first_page' as const }
        : {}),
    });
  }
  // CS-C04: a TypeError is a server-side defect (a null dereference, a bad
  // argument into a library), not a client error. Mapping it to 400
  // invalid_request masked 500-class faults and corrupted monitoring
  // attribution. The generic internal_error branch below handles it (same
  // stable message, no information leak, recovery 'same_request').
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '57014' || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT') {
    return communityUnavailable();
  }
  const kind = (error as { kind?: unknown } | null)?.kind;
  if (kind === 'serialization_failure' || kind === 'deadlock' || kind === 'lock_timeout' || kind === 'unavailable') {
    return communityUnavailable();
  }
  return new ProductHttpError({
    statusCode: productErrorStatus('internal_error'),
    code: 'internal_error',
    message: 'The community request could not be completed.',
    recovery: 'same_request',
  });
}

export function communityInvalidRequest() {
  return new ProductHttpError({
    statusCode: productErrorStatus('invalid_request'),
    code: 'invalid_request',
    message: 'The community request is invalid.',
  });
}

export function communityNotFound(
  message = 'The community target was not found.',
) {
  return new ProductHttpError({
    statusCode: productErrorStatus('resource_not_found'),
    code: 'resource_not_found',
    message,
  });
}

export function communityUnavailable(
  message = 'Community voting is temporarily unavailable.',
) {
  return new ProductHttpError({
    statusCode: productErrorStatus('feature_temporarily_unavailable'),
    code: 'feature_temporarily_unavailable',
    message,
    recovery: 'same_request',
    sameRequestRetrySafe: true,
    retryAfterSeconds: 1,
    headers: { 'Retry-After': '1' },
  });
}
