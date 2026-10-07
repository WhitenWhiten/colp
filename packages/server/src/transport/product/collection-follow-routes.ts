import { BookmarkSubscriptionError } from '../../modules/bookmark-subscriptions/index.js';
import { mapSubscriptionError } from './bookmark-subscription-routes.js';
import { readSubscriptionExitPreview, prepareSubscriptionExitSession } from './subscription-exit-header.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { observeBestEffort } from '../../infrastructure/async/best-effort.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import {
  CollectionFollowCommandError,
  FOLLOWED_COLLECTIONS_PAGE_MAX_LIMIT,
  FollowedCollectionsCursorError,
  followCollection,
  queryCollectionFollowState,
  queryFollowedCollections,
  unfollowCollection,
  type CollectionFollowCommandErrorCode,
  type CollectionFollowCommandPorts,
  type CollectionFollowCommandResult,
  type CollectionFollowCombinedQueryPorts,
  type CollectionFollowStateResult,
  type FollowedCollectionFact,
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

const FOLLOW = '/api/v1/collections/:collectionId/follow';
const LIST = '/api/v1/me/followed-collections';
const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

export interface CollectionFollowRoutesDependencies {
  readonly enabled: boolean;
  readonly allowedOrigins: readonly string[];
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly commandUnitOfWork: {
    execute<Result>(
      work: (ports: CollectionFollowCommandPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  readonly queryUnitOfWork: {
    execute<Result>(
      work: (ports: CollectionFollowCombinedQueryPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  readonly rateLimiter: ProductAdmissionRateLimiter;
  readonly timeoutMs: number;
  readonly csrfMatches?: (raw: string, expectedHash: string) => boolean;
  readonly command?: (
    ports: CollectionFollowCommandPorts,
    input: Parameters<typeof followCollection>[1] & { action: 'follow' | 'unfollow' },
  ) => Promise<CollectionFollowCommandResult>;
  readonly query?: typeof queryCollectionFollowState;
  readonly listQuery?: typeof queryFollowedCollections;
}

export function registerCollectionFollowRoutes(
  app: FastifyInstance,
  deps: CollectionFollowRoutesDependencies,
): void {
  if (!Number.isInteger(deps.timeoutMs) || deps.timeoutMs < 1 || deps.timeoutMs > 30_000) {
    throw new TypeError('Collection Follow route timeout is outside the application budget.');
  }
  for (const [method, action] of [['PUT', 'follow'], ['DELETE', 'unfollow']] as const) {
    app.route({
      method,
      url: FOLLOW,
      exposeHeadRoute: false,
      config: {
        ...productRouteMetadata(method, FOLLOW),
        productTransport: {
          allowedQuery: [],
          acceptedMediaTypes: [],
          bodyLimitBytes: 1,
          cacheControl: 'private-no-store',
        },
      },
      onRequest: admission(deps, FOLLOW),
      handler: async (request, reply) => {
        if(action==='unfollow')await prepareSubscriptionExitSession(request,reply,deps.identityUnitOfWork);
        const identity = await requireMutationActor(request, {
          identityUnitOfWork: deps.identityUnitOfWork,
          allowedOrigins: deps.allowedOrigins,
          csrfMatches: deps.csrfMatches,
        });
        const {account}=identity;
        if(action==='unfollow'&&request.headers['known-subscription-exit-preview']!==undefined&&'session'in identity)reply.header('Known-Subscription-Session',identity.session.id);
        if (!deps.enabled) throw notFound();
        const input = {
          actor: {
            principalId: account.id,
            profileId: account.id,
            subjectId: account.subjectId,
          },
          collectionId: collectionId(request),
          commandId: readKnownCommandId(request),
          action,
          ...(action === 'unfollow' ? readSubscriptionExitPreview(request) : {}),
        } as const;
        try {
          const outcome = await withCancellation(request, deps.timeoutMs, (signal) =>
            deps.commandUnitOfWork.execute((ports) =>
              deps.command
                ? deps.command(ports, input)
                : action === 'follow'
                  ? followCollection(ports, input)
                  : unfollowCollection(ports, input),
            { signal }));
          if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
          return sendState(reply, outcome.state);
        } catch (error) {
          throw mapCollectionFollowError(error);
        }
      },
    });
  }

  app.get(FOLLOW, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', FOLLOW),
      productTransport: {
        allowedQuery: [],
        cacheControl: 'private-no-store',
      },
    },
    onRequest: admission(deps, FOLLOW),
  }, async (request, reply) => {
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    if (!deps.enabled) throw notFound();
    try {
      const state = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.queryUnitOfWork.execute((ports) =>
          (deps.query ?? queryCollectionFollowState)(ports, {
            actorProfileId: account.id,
            actorSubjectId: account.subjectId,
            collectionId: collectionId(request),
          }), { signal }));
      if (state === null) throw notFound();
      return sendState(reply, state);
    } catch (error) {
      throw mapCollectionFollowError(error);
    }
  });

  app.get(LIST, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', LIST),
      productTransport: {
        allowedQuery: ['cursor', 'limit'],
        duplicateQueryErrorCode: 'invalid_request',
        queryErrorCode: 'invalid_request',
        cacheControl: 'private-no-store',
      },
    },
    onRequest: admission(deps, LIST),
  }, async (request, reply) => {
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    if (!deps.enabled) throw notFound();
    try {
      const page = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.queryUnitOfWork.execute((ports) =>
          (deps.listQuery ?? queryFollowedCollections)(ports, {
            principalId: account.id,
            ...parseListQuery(request.query as Record<string, string>),
            signal,
          }), { signal }));
      return sendPage(reply, page);
    } catch (error) {
      throw mapCollectionFollowError(error);
    }
  });
}

function admission(deps: CollectionFollowRoutesDependencies, path: string) {
  return async (request: FastifyRequest) => {
    const decision = await consumeProductAdmission(deps.rateLimiter, rateLimitClientKey(request, path));
    if (decision.kind === 'failed') throw unavailable();
    if (decision.kind === 'denied') {
      throw new ProductHttpError({
        statusCode: 429,
        code: 'rate_limited',
        message: 'Too many Collection Follow requests. Please try again later.',
        recovery: 'same_request',
        sameRequestRetrySafe: true,
        retryAfterSeconds: decision.retryAfterSeconds,
        headers: { 'Retry-After': String(decision.retryAfterSeconds) },
      });
    }
  };
}

function collectionId(request: FastifyRequest): string {
  const value = (request.params as { collectionId?: string }).collectionId;
  if (!value || !OPAQUE_ID.test(value)) throw invalidRequest();
  return value;
}

function parseListQuery(query: Record<string, string>): { cursor?: string; limit?: number } {
  if (query.cursor !== undefined && (!query.cursor || query.cursor.length > 2048 || query.limit !== undefined)) {
    throw invalidRequest();
  }
  if (query.limit === undefined) return query.cursor ? { cursor: query.cursor } : {};
  if (!/^[1-9][0-9]*$/u.test(query.limit) || Number(query.limit) > FOLLOWED_COLLECTIONS_PAGE_MAX_LIMIT) {
    throw invalidRequest();
  }
  return { limit: Number(query.limit) };
}

function sendPage(reply: FastifyReply, page: { items: readonly FollowedCollectionFact[]; nextCursor: string | null }) {
  return reply
    .code(200)
    .type('application/json; charset=utf-8')
    .header('cache-control', 'private, no-store')
    .send({
      items: page.items.map((item) => ({
        collectionId: item.collectionId,
        slug: item.slug,
        title: item.title,
        summary: item.summary,
        kind: item.kind,
        owner: item.owner,
        updatedAt: item.updatedAt.toISOString(),
        followedAt: item.followedAt.toISOString(),
        availability: item.availability,
      })),
      nextCursor: page.nextCursor,
    });
}

function sendState(reply: FastifyReply, value: CollectionFollowStateResult) {
  return reply
    .code(200)
    .type('application/json; charset=utf-8')
    .header('cache-control', 'private, no-store')
    .send({
      following: value.following,
      followerCount: value.followerCount,
      followedAt: value.followedAt === null ? null : value.followedAt.toISOString(),
    });
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

const COLLECTION_FOLLOW_COMMAND_ERROR_MAP = {
  resource_not_found: notFound,
  invalid_request: (error: CollectionFollowCommandError) => new ProductHttpError({
    statusCode: productErrorStatus('invalid_request'),
    code: 'invalid_request',
    message: error.message,
  }),
} as const satisfies Readonly<
  Record<CollectionFollowCommandErrorCode, (error: CollectionFollowCommandError) => ProductHttpError>
>;

export function mapCollectionFollowError(error: unknown): ProductHttpError {
  if (error instanceof BookmarkSubscriptionError) mapSubscriptionError(error);
  if (error instanceof ProductHttpError) return error;
  if (error instanceof FollowedCollectionsCursorError) {
    return new ProductHttpError({
      statusCode: productErrorStatus('invalid_cursor'),
      code: 'invalid_cursor',
      message: 'The Followed collections cursor is invalid.',
      recovery: 'restart_from_first_page',
    });
  }
  if (error instanceof CollectionFollowCommandError) {
    return COLLECTION_FOLLOW_COMMAND_ERROR_MAP[error.code](error);
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
    message: 'The Collection Follow request could not be completed.',
    recovery: 'same_request',
  });
}

function invalidRequest() {
  return new ProductHttpError({
    statusCode: productErrorStatus('invalid_request'),
    code: 'invalid_request',
    message: 'The Collection Follow request is invalid.',
  });
}

function notFound() {
  return new ProductHttpError({
    statusCode: productErrorStatus('resource_not_found'),
    code: 'resource_not_found',
    message: 'The requested resource was not found.',
    recovery: 'none',
  });
}

function unavailable() {
  return new ProductHttpError({
    statusCode: productErrorStatus('feature_temporarily_unavailable'),
    code: 'feature_temporarily_unavailable',
    message: 'Collection Follow is temporarily unavailable.',
    recovery: 'same_request',
    sameRequestRetrySafe: true,
    retryAfterSeconds: 1,
    headers: { 'Retry-After': '1' },
  });
}
