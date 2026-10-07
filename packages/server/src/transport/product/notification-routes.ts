import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import {
  getNotificationPreferences, markNotificationRead, markNotificationsRead,
  NotificationInboxCursorError, NotificationPreferenceCommandError,
  NotificationReadCommandError, NOTIFICATION_INBOX_PAGE_MAX_LIMIT,
  NOTIFICATION_READ_BULK_MAX_ITEMS, queryCurrentNotificationInbox,
  updateNotificationPreference,
  type MarkNotificationReadResult, type MarkNotificationsReadResult,
  type NotificationInboxQueryPage, type NotificationInboxQueryPorts,
  type NotificationPreferenceCommandErrorCode,
  type NotificationPreferenceCommandPorts, type NotificationPreferenceReadPort,
  type NotificationReadCommandErrorCode,
  type ProductNotificationPreference, type ProductNotificationPreferences,
  type UpdateNotificationPreferenceResult,
  type NotificationReadCommandPorts,
} from '../../modules/notifications/index.js';
import { readKnownCommandId } from './collection-route-helpers.js';
import type { ProductAdmissionRateLimiter } from '../http-security.js';
import { consumeProductAdmission } from '../http-security.js';
import { sendProductCommandReceiptOutcome } from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireSessionActor } from '../session-auth.js';
import { requireMutationActor } from '../mutation-actor.js';
import { productErrorStatus } from '../product-codes.js';

const LIST = '/api/v1/notifications';
const ONE = '/api/v1/notifications/:notificationId/read';
const BULK = '/api/v1/notifications/read';
const PREFERENCES = '/api/v1/notification-preferences';
const PREFERENCE = '/api/v1/notification-preferences/:channel';
// FIX-H-004: frozen Phase 5 compatibility paths. Each alias below executes the
// same application handler as its successor path and keeps identical auth,
// Origin/CSRF, per-principal rate-limit family, Cache-Control, ETag, and
// Problem behavior.
const ME_LIST = '/api/v1/me/notifications';
const ME_BULK = '/api/v1/me/notifications/read';
const ME_PREFERENCES = '/api/v1/me/notification-preferences';
const ID = /^[A-Za-z0-9._~-]{1,128}$/u;

export interface NotificationRoutesDependencies {
  readonly enabled: boolean;
  readonly allowedOrigins: readonly string[];
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly queryUnitOfWork: { execute<Result>(work: (ports: NotificationInboxQueryPorts) => Promise<Result>): Promise<Result> };
  readonly readCommandUnitOfWork: { execute<Result>(work: (ports: NotificationReadCommandPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal }): Promise<Result> };
  readonly preferenceRead: NotificationPreferenceReadPort;
  readonly preferenceCommandUnitOfWork: { execute<Result>(work: (ports: NotificationPreferenceCommandPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal }): Promise<Result> };
  /**
   * P5-30 additive email runtime view. Absent/unconfigured -> email channel is
   * reported unavailable (never fake-usable).
   */
  readonly emailRuntime?: { readonly verifiedSender: string | null; readonly emailAvailable: boolean };
  readonly rateLimiter: ProductAdmissionRateLimiter;
  readonly timeoutMs: number;
  readonly csrfMatches?: (raw: string, expectedHash: string) => boolean;
  readonly query?: (...args: Parameters<typeof queryCurrentNotificationInbox>) => Promise<NotificationInboxQueryPage>;
  readonly markOne?: (...args: Parameters<typeof markNotificationRead>) => Promise<MarkNotificationReadResult>;
  readonly markMany?: (...args: Parameters<typeof markNotificationsRead>) => Promise<MarkNotificationsReadResult>;
  readonly readPreference?: (...args: Parameters<typeof getNotificationPreferences>) => Promise<ProductNotificationPreferences>;
  readonly updatePreference?: (...args: Parameters<typeof updateNotificationPreference>) => Promise<UpdateNotificationPreferenceResult>;
}

export function registerNotificationRoutes(app: FastifyInstance, deps: NotificationRoutesDependencies): void {
  if (!Number.isInteger(deps.timeoutMs) || deps.timeoutMs < 1 || deps.timeoutMs > 30_000) throw new TypeError('Notification route timeout is invalid.');
  const privateTransport = { duplicateQueryErrorCode: 'invalid_request', queryErrorCode: 'invalid_request',
    cacheControl: 'private-no-store' } as const;
  app.get(LIST, { config: { ...productRouteMetadata('GET', LIST), productTransport: {
    ...privateTransport, allowedQuery: ['state', 'cursor', 'limit'], acceptedMediaTypes: [], bodyLimitBytes: 1 } }, onRequest: exposure(deps) },
  async (request, reply) => {
    const accountId = await actor(request, deps, false, LIST);
    const input = parseList(request.query as Record<string, string | undefined>);
    try {
      const page = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.queryUnitOfWork.execute((ports) => (deps.query ?? queryCurrentNotificationInbox)(ports,
          { principalId: accountId, ...input, signal })));
      return reply.code(200).type('application/json; charset=utf-8').send(page);
    } catch (error) { throw mapNotificationError(error); }
  });
  app.put(ONE, { config: { ...productRouteMetadata('PUT', ONE), productTransport: {
    ...privateTransport, allowedQuery: [], acceptedMediaTypes: [], bodyLimitBytes: 1 } }, onRequest: exposure(deps) },
  async (request, reply) => {
    const accountId = await mutationActor(request, deps, ONE);
    try {
      const outcome = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.readCommandUnitOfWork.execute((ports) => (deps.markOne ?? markNotificationRead)(ports, {
          principalId: accountId, notificationId: notificationId(request),
          expectedStateRevision: readRevision(request, 'notification'), commandId: readKnownCommandId(request),
        }), { signal }));
      if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
      if (outcome.outcome === 'not_found') return reply.code(200).send(outcome);
      reply.header('ETag', etag('notification', outcome.stateRevision));
      return reply.code(200).send({ ...outcome, stateRevision: outcome.stateRevision.toString() });
    } catch (error) { throw mapNotificationError(error); }
  });
  app.post(BULK, { config: { ...productRouteMetadata('POST', BULK), productTransport: {
    ...privateTransport, allowedQuery: [], acceptedMediaTypes: ['application/json'], bodyLimitBytes: 16_384 } },
  onRequest: exposure(deps) }, async (request, reply) => {
    const accountId = await mutationActor(request, deps, BULK);
    const ids = parseBulk(request.body);
    try {
      const outcome = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.readCommandUnitOfWork.execute((ports) => (deps.markMany ?? markNotificationsRead)(ports,
          { principalId: accountId, notificationIds: ids, commandId: readKnownCommandId(request) }), { signal }));
      if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
      return reply.code(200).send(outcome);
    } catch (error) { throw mapNotificationError(error); }
  });
  app.get(PREFERENCES, { config: { ...productRouteMetadata('GET', PREFERENCES), productTransport: {
    ...privateTransport, allowedQuery: [], acceptedMediaTypes: [], bodyLimitBytes: 1 } }, onRequest: exposure(deps) }, async (request, reply) => {
    const accountId = await actor(request, deps, false, PREFERENCES);
    try {
      const value = await withCancellation(request, deps.timeoutMs, (signal) =>
        (deps.readPreference ?? getNotificationPreferences)(deps.preferenceRead, { principalId: accountId, signal }, deps.emailRuntime));
      // FIX-M-023: the aggregate GET ETag is a whole-representation cache
      // validator only; per-channel PUT preconditions are the channel-scoped
      // validators built from the body revisions below.
      reply.header('ETag', etag('notification-preferences:all', value.revision));
      return reply.code(200).send(preferenceDto(value));
    } catch (error) { throw mapNotificationError(error); }
  });
  app.put(PREFERENCE, { config: { ...productRouteMetadata('PUT', PREFERENCE), productTransport: {
    ...privateTransport, allowedQuery: [], acceptedMediaTypes: ['application/json'], bodyLimitBytes: 1024 } },
  onRequest: exposure(deps) }, async (request, reply) => {
    const accountId = await mutationActor(request, deps, PREFERENCE);
    const channel = (request.params as { channel?: string }).channel;
    if (channel !== 'in_app' && channel !== 'email') throw invalid();
    const body = parsePreference(request.body);
    try {
      const outcome = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.preferenceCommandUnitOfWork.execute((ports) => (deps.updatePreference ?? updateNotificationPreference)(ports, {
          principalId: accountId, channel, ...body,
          expectedRevision: readPreferenceRevision(request, channel), commandId: readKnownCommandId(request),
        }), { signal }));
      if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
      reply.header('ETag', etag(`notification-preference:${channel}`, outcome.revision));
      return reply.code(200).send({ kind: outcome.kind, ...preferenceChannelDto(outcome), changed: outcome.changed });
    } catch (error) { throw mapNotificationError(error); }
  });
  app.get(ME_LIST, { config: { ...productRouteMetadata('GET', ME_LIST), productTransport: {
    ...privateTransport, allowedQuery: ['read', 'cursor', 'limit'], acceptedMediaTypes: [], bodyLimitBytes: 1 } },
  onRequest: exposure(deps) }, async (request, reply) => {
    const accountId = await actor(request, deps, false, LIST);
    const input = parseMeList(request.query as Record<string, string | undefined>);
    try {
      const page = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.queryUnitOfWork.execute((ports) => (deps.query ?? queryCurrentNotificationInbox)(ports,
          { principalId: accountId, ...input, signal })));
      return reply.code(200).type('application/json; charset=utf-8').send(frozenNotificationPage(page));
    } catch (error) { throw mapNotificationError(error); }
  });
  app.post(ME_BULK, { config: { ...productRouteMetadata('POST', ME_BULK), productTransport: {
    ...privateTransport, allowedQuery: [], acceptedMediaTypes: ['application/json'], bodyLimitBytes: 16_384 } },
  onRequest: exposure(deps) }, async (request, reply) => {
    const accountId = await mutationActor(request, deps, BULK);
    const ids = parseBulk(request.body);
    try {
      const outcome = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.readCommandUnitOfWork.execute((ports) => (deps.markMany ?? markNotificationsRead)(ports,
          { principalId: accountId, notificationIds: ids, commandId: readKnownCommandId(request) }), { signal }));
      if (outcome.kind === 'replay') {
        const stored = JSON.parse(Buffer.from(outcome.body).toString('utf8')) as { kind?: unknown };
        if (stored.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
        return reply.code(outcome.status).type(outcome.mediaType)
          .send(await frozenMarkReadResult(request, deps, ids));
      }
      if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
      return reply.code(200).type('application/json; charset=utf-8')
        .send(await frozenMarkReadResult(request, deps, ids));
    } catch (error) { throw mapNotificationError(error); }
  });
  app.get(ME_PREFERENCES, { config: { ...productRouteMetadata('GET', ME_PREFERENCES), productTransport: {
    ...privateTransport, allowedQuery: [], acceptedMediaTypes: [], bodyLimitBytes: 1 } },
  onRequest: exposure(deps) }, async (request, reply) => {
    const accountId = await actor(request, deps, false, PREFERENCES);
    try {
      const value = await withCancellation(request, deps.timeoutMs, (signal) =>
        (deps.readPreference ?? getNotificationPreferences)(deps.preferenceRead,
          { principalId: accountId, signal }, deps.emailRuntime));
      reply.header('ETag', etag('notification-preference', value.revision));
      return reply.code(200).send(frozenPreferenceDto(value));
    } catch (error) { throw mapNotificationError(error); }
  });
  app.put(ME_PREFERENCES, { config: { ...productRouteMetadata('PUT', ME_PREFERENCES), productTransport: {
    ...privateTransport, allowedQuery: [], acceptedMediaTypes: ['application/json'], bodyLimitBytes: 1024 } },
  onRequest: exposure(deps) }, async (request, reply) => {
    const accountId = await mutationActor(request, deps, PREFERENCES);
    const update = parseFrozenPreferenceUpdate(request.body);
    try {
      const outcome = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.preferenceCommandUnitOfWork.execute((ports) => (deps.updatePreference ?? updateNotificationPreference)(ports, {
          principalId: accountId, channel: 'in_app', mode: update.mode, enabled: update.enabled,
          expectedRevision: update.expectedRevision, commandId: readKnownCommandId(request),
        }), { signal }));
      if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
      reply.header('ETag', etag('notification-preference', outcome.revision));
      return reply.code(200).send(frozenPreferenceChannelDto(outcome));
    } catch (error) { throw mapNotificationError(error); }
  });
}

function exposure(deps: NotificationRoutesDependencies) {
  return async () => { if (!deps.enabled) throw new ProductHttpError({ statusCode: 404,
    code: 'resource_not_found', message: 'The requested resource was not found.', recovery: 'none' }); };
}
async function actor(request: FastifyRequest, deps: NotificationRoutesDependencies, touch: boolean, family: string) {
  const value = await requireSessionActor(request, deps.identityUnitOfWork, { touch });
  const decision = await consumeProductAdmission(deps.rateLimiter, `${family}:principal:${value.account.id}`);
  if (decision.kind === 'failed') throw unavailable();
  if (decision.kind === 'denied') throw new ProductHttpError({ statusCode: 429, code: 'rate_limited',
    message: 'Too many Notification requests.', recovery: 'same_request', sameRequestRetrySafe: true,
    retryAfterSeconds: decision.retryAfterSeconds, headers: { 'Retry-After': String(decision.retryAfterSeconds) } });
  return value.account.id;
}
async function mutationActor(request: FastifyRequest, deps: NotificationRoutesDependencies, family: string) {
  const { account } = await requireMutationActor(request, {
    identityUnitOfWork: deps.identityUnitOfWork,
    allowedOrigins: deps.allowedOrigins,
    csrfMatches: deps.csrfMatches,
  });
  const decision = await consumeProductAdmission(deps.rateLimiter, `${family}:principal:${account.id}`);
  if (decision.kind === 'failed') throw unavailable();
  if (decision.kind === 'denied') throw new ProductHttpError({ statusCode: 429, code: 'rate_limited',
    message: 'Too many Notification requests.', recovery: 'same_request', sameRequestRetrySafe: true,
    retryAfterSeconds: decision.retryAfterSeconds, headers: { 'Retry-After': String(decision.retryAfterSeconds) } });
  return account.id;
}
function parseList(query: Record<string, string | undefined>) {
  if (query.cursor !== undefined && (!query.cursor || query.cursor.length > 2048 || query.limit !== undefined)) throw invalid();
  if (query.state !== undefined && !['all', 'read', 'unread'].includes(query.state)) throw invalid();
  let limit: number | undefined;
  if (query.limit !== undefined) {
    if (!/^[1-9][0-9]*$/u.test(query.limit) || Number(query.limit) > NOTIFICATION_INBOX_PAGE_MAX_LIMIT) throw invalid();
    limit = Number(query.limit);
  }
  return { ...(query.state !== undefined ? { state: query.state } : {}),
    ...(query.cursor !== undefined ? { cursor: query.cursor } : {}), ...(limit ? { limit } : {}) };
}
function parseBulk(value: unknown): readonly string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).join('|') !== 'notificationIds') throw invalidDocument();
  const ids = (value as { notificationIds?: unknown }).notificationIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > NOTIFICATION_READ_BULK_MAX_ITEMS
    || ids.some((id) => typeof id !== 'string' || !ID.test(id)) || new Set(ids).size !== ids.length) throw invalidDocument();
  return Object.freeze([...ids]) as readonly string[];
}
function parsePreference(value: unknown): { mode: 'set'; enabled: boolean } | { mode: 'reset' } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidDocument();
  const body = value as Record<string, unknown>; const keys = Object.keys(body).sort().join('|');
  if (body.mode === 'reset' && keys === 'mode') return { mode: 'reset' };
  if (body.mode === 'set' && typeof body.enabled === 'boolean' && keys === 'enabled|mode') return { mode: 'set', enabled: body.enabled };
  throw invalidDocument();
}
function parseMeList(query: Record<string, string | undefined>): {
  state?: 'read' | 'unread'; cursor?: string; limit?: number;
} {
  if (query.cursor !== undefined && (!query.cursor || query.cursor.length > 2048 || query.limit !== undefined)) throw invalid();
  if (query.read !== undefined && query.read !== 'true' && query.read !== 'false') throw invalid();
  let limit: number | undefined;
  if (query.limit !== undefined) {
    if (!/^[1-9][0-9]*$/u.test(query.limit) || Number(query.limit) > NOTIFICATION_INBOX_PAGE_MAX_LIMIT) throw invalid();
    limit = Number(query.limit);
  }
  const state = query.read === 'true' ? 'read' as const : query.read === 'false' ? 'unread' as const : undefined;
  return { ...(state !== undefined ? { state } : {}),
    ...(query.cursor !== undefined ? { cursor: query.cursor } : {}), ...(limit ? { limit } : {}) };
}
function frozenNotificationPage(page: NotificationInboxQueryPage) {
  return { items: page.items.map((item) => ({
    notificationId: item.notificationId,
    kind: item.notificationType === 'follow_activity' ? 'new_follower' : 'followed_collection_changed',
    createdAt: item.occurredAt,
    readAt: item.readAt,
    // The shared inbox handler exposes only actorProfileId, never a profile
    // summary; the frozen DTO permits null and the successor path keeps the
    // full per-item view.
    actor: null,
    collectionId: item.subject.type === 'collection' ? item.subject.id : null,
  })), nextCursor: page.nextCursor, unreadCount: page.unreadCount };
}
async function frozenMarkReadResult(request: FastifyRequest, deps: NotificationRoutesDependencies,
  ids: readonly string[]): Promise<{ notificationIds: readonly string[]; readAt: string }> {
  // The shared bulk-read handler returns only counts. The frozen v1 result
  // echoes the processed IDs and reads the same authoritative PostgreSQL clock
  // the read command uses for read_at; an exact replay re-derives the projection.
  const readAt = await withCancellation(request, deps.timeoutMs, (signal) =>
    deps.readCommandUnitOfWork.execute((ports) => ports.clock.now(), { signal }));
  return { notificationIds: ids, readAt: readAt.toISOString() };
}
function parseFrozenPreferenceUpdate(value: unknown): {
  mode: 'set'; enabled: boolean; expectedRevision: bigint;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidDocument();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).sort().join('|') !== 'inAppFollowedCollectionChanged|inAppNewFollower|revision') {
    throw invalidDocument();
  }
  const { revision, inAppNewFollower, inAppFollowedCollectionChanged } = body;
  if (typeof revision !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(revision)
    || typeof inAppNewFollower !== 'boolean' || typeof inAppFollowedCollectionChanged !== 'boolean') {
    throw invalidDocument();
  }
  // The successor model owns one in-app channel; the frozen aggregate update
  // must keep both kinds aligned or fail closed on the closed error catalog.
  if (inAppNewFollower !== inAppFollowedCollectionChanged) throw invalid();
  return { mode: 'set', enabled: inAppNewFollower, expectedRevision: BigInt(revision) };
}
function frozenPreferenceDto(value: ProductNotificationPreferences) {
  return { revision: value.revision.toString(), inAppNewFollower: value.enabled,
    inAppFollowedCollectionChanged: value.enabled };
}
function frozenPreferenceChannelDto(value: ProductNotificationPreference) {
  return { revision: value.revision.toString(), inAppNewFollower: value.enabled,
    inAppFollowedCollectionChanged: value.enabled };
}
function notificationId(request: FastifyRequest) {
  const value = (request.params as { notificationId?: string }).notificationId;
  if (!value || !ID.test(value)) throw invalid(); return value;
}
function readRevision(request: FastifyRequest, scope: 'notification'): bigint {
  const value = request.headers['if-match'];
  if (value === undefined) throw new ProductHttpError({ statusCode: productErrorStatus('precondition_required'), code: 'precondition_required',
    message: 'If-Match is required.', recovery: 'refresh_and_retry', precondition: 'resource' });
  const match = new RegExp(`^"${scope}:([0-9]+)"$`, 'u').exec(value);
  if (!match) throw invalid();
  try { return BigInt(match[1]!); } catch { throw invalid(); }
}
/**
 * FIX-M-023: preference PUT preconditions are channel-scoped. If-Match must be
 * the strong validator the server publishes for the path channel,
 * "notification-preference:<channel>:<revision>", and is bound to that channel.
 * The pre-FIX-M-023 aggregate validator ("notification-preference:<revision>")
 * stays accepted for in_app during the compatibility window because it was
 * derived from the in_app channel revision; it is never accepted for email, so
 * the old aggregate validator can never be replayed across channels.
 */
function readPreferenceRevision(request: FastifyRequest, channel: 'in_app'|'email'): bigint {
  const value = request.headers['if-match'];
  if (value === undefined) throw new ProductHttpError({ statusCode: productErrorStatus('precondition_required'), code: 'precondition_required',
    message: 'If-Match is required.', recovery: 'refresh_and_retry', precondition: 'resource' });
  const match = new RegExp(`^"notification-preference:${channel}:([0-9]+)"$`, 'u').exec(value);
  if (match) { try { return BigInt(match[1]!); } catch { throw invalid(); } }
  if (channel === 'in_app') {
    const legacy = new RegExp('^"notification-preference:([0-9]+)"$', 'u').exec(value);
    if (legacy) { try { return BigInt(legacy[1]!); } catch { throw invalid(); } }
  }
  throw invalid();
}
function etag(scope: string, revision: bigint) { return `"${scope}:${revision}" `.trim(); }
function preferenceDto(value: ProductNotificationPreferences) {
  return { channel: value.channel, enabled: value.enabled, revision: value.revision.toString(), updatedAt: value.updatedAt,
    email: { enabled: value.email.enabled, revision: value.email.revision.toString(),
      updatedAt: value.email.updatedAt, verifiedSender: value.email.verifiedSender,
      emailSuppressed: value.email.emailSuppressed, emailAvailable: value.email.emailAvailable } };
}
function preferenceChannelDto(value: ProductNotificationPreference) {
  return { channel: value.channel, enabled: value.enabled, revision: value.revision.toString(), updatedAt: value.updatedAt };
}
async function withCancellation<T>(request: FastifyRequest, timeoutMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController(); let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(unavailable()); }, timeoutMs); timeout.unref?.();
  const abort = () => controller.abort(unavailable());
  request.raw.once('aborted', abort); request.raw.socket.once('close', abort);
  try { const result = await work(controller.signal); if (timedOut || controller.signal.aborted) throw unavailable(); return result; }
  finally { clearTimeout(timeout); request.raw.off('aborted', abort); request.raw.socket.off('close', abort); }
}
const NOTIFICATION_PREFERENCE_ERROR_MAP = {
  stale_revision: () => new ProductHttpError({ statusCode: productErrorStatus('precondition_failed'),
    code: 'precondition_failed', message: 'The preference revision changed.', recovery: 'refresh_and_retry', precondition: 'resource' }),
  invalid_request: invalidDocument,
} as const satisfies Readonly<Record<NotificationPreferenceCommandErrorCode, () => ProductHttpError>>;

const NOTIFICATION_READ_ERROR_MAP = {
  stale_state: () => new ProductHttpError({ statusCode: productErrorStatus('precondition_failed'),
    code: 'precondition_failed', message: 'The Notification state changed.', recovery: 'refresh_and_retry', precondition: 'resource' }),
  invalid_request: invalidDocument,
} as const satisfies Readonly<Record<NotificationReadCommandErrorCode, () => ProductHttpError>>;

export function mapNotificationError(error: unknown): ProductHttpError {
  if (error instanceof ProductHttpError) return error;
  if (error instanceof NotificationInboxCursorError) return new ProductHttpError({ statusCode: productErrorStatus('invalid_cursor'),
    code: 'invalid_cursor', message: 'The Notification cursor is invalid.', recovery: 'restart_from_first_page' });
  if (error instanceof NotificationPreferenceCommandError) return NOTIFICATION_PREFERENCE_ERROR_MAP[error.code]();
  if (error instanceof NotificationReadCommandError) return NOTIFICATION_READ_ERROR_MAP[error.code]();
  if (error instanceof TypeError) return invalid();
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '57014' || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT') return unavailable();
  const kind = (error as { kind?: unknown } | null)?.kind;
  if (['serialization_failure', 'deadlock', 'lock_timeout', 'unavailable',
    'commit_outcome_unknown'].includes(String(kind))) return unavailable();
  return new ProductHttpError({ statusCode: productErrorStatus('internal_error'), code: 'internal_error',
    message: 'The Notification request could not be completed.', recovery: 'same_request' });
}
function invalid() { return new ProductHttpError({ statusCode: productErrorStatus('invalid_request'), code: 'invalid_request', message: 'The Notification request is invalid.' }); }
function invalidDocument() { return new ProductHttpError({ statusCode: productErrorStatus('invalid_document'), code: 'invalid_document',
  message: 'The Notification request document is invalid.', recovery: 'user_action' }); }
function unavailable() { return new ProductHttpError({ statusCode: productErrorStatus('feature_temporarily_unavailable'), code: 'feature_temporarily_unavailable',
  message: 'Notifications are temporarily unavailable.', recovery: 'same_request', sameRequestRetrySafe: true,
  retryAfterSeconds: 1, headers: { 'Retry-After': '1' } }); }
