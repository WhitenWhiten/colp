import { randomBytes } from 'node:crypto';
import {
  COMMUNITY_TARGET_KINDS,
  type CommunityCommentRecord,
  type CommunityNotificationWorkerRepository,
  type CommunityCommentNotificationEvent,
} from '../../modules/community/index.js';
import { databaseNow } from '../database/time.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import {
  defineClosedPayloadValidator,
  InvalidEventEnvelopeError,
  type EventPayloadRegistration,
  type VersionedEventEnvelope,
} from '../outbox/envelope.js';
import {
  OutboxDeliveryError,
  type OutboxHandlerContext,
  type OutboxRoute,
} from '../outbox/router.js';

/**
 * CS-05 durable reply-notification outbox event.
 *
 * The comment-create transaction appends one `community.comment-created`
 * event per eligible recipient (target owner + parent comment author,
 * minus the replying actor) inside the same commit that writes the comment
 * row — the event is durable with the comment, never emitted from a
 * process-local queue. One `community_comment_notification` handler
 * identity per event delivers exactly one `comment_reply` notification
 * (`delivery_each_event`, `routeClass: 'projection'`); the aggregate scope
 * is the recipient account and `aggregate_revision` pins the producer
 * contract version so a mismatched event fails closed.
 *
 * The payload carries immutable locators only (comment id, reply parent,
 * closed target identity + pinned generation, actor, recipient) — never
 * the comment body; the worker re-reads every fact from authority before
 * projecting.
 */
export const COMMUNITY_COMMENT_NOTIFICATION_EVENT_TYPE = 'community.comment-created' as const;
export const COMMUNITY_COMMENT_NOTIFICATION_EVENT_VERSION = 1 as const;
export const COMMUNITY_COMMENT_NOTIFICATION_HANDLER_NAME = 'community_comment_notification' as const;
export const COMMUNITY_COMMENT_NOTIFICATION_HANDLER_MODE = 'delivery_each_event' as const;
export const COMMUNITY_COMMENT_NOTIFICATION_AGGREGATE_TYPE = 'community-comment' as const;
export const COMMUNITY_COMMENT_NOTIFICATION_AGGREGATE_REVISION = 'ccn-v1' as const;

const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

function generateOutboxId(): string {
  return randomBytes(16).toString('base64url');
}

interface CommunityCommentNotificationPayload {
  readonly commentId: string;
  readonly replyToId: string | null;
  readonly targetKind: string;
  readonly targetId: string;
  readonly targetCollectionId: string | null;
  readonly targetSeriesId: string | null;
  readonly targetGeneration: string;
  readonly actorAccountId: string;
  readonly recipientAccountId: string;
}

/**
 * Append one reply-notification event for one recipient inside the
 * comment-create transaction. Called once per recipient; ids are reserved
 * in `resource_id_ledger` like every durable outbox row.
 */
export async function appendCommunityCommentNotificationOutbox(
  transaction: DatabaseTransaction,
  input: {
    readonly comment: CommunityCommentRecord;
    readonly recipientAccountId: string;
  },
  options: { readonly outboxIdGenerator?: () => string; readonly occurredAt?: Date } = {},
): Promise<void> {
  const { comment, recipientAccountId } = input;
  const occurredAt = options.occurredAt ?? await databaseNow(transaction);
  const outboxId = (options.outboxIdGenerator ?? generateOutboxId)();
  const domainEventId = (options.outboxIdGenerator ?? generateOutboxId)();
  const payload: CommunityCommentNotificationPayload = {
    commentId: comment.id,
    replyToId: comment.replyToId,
    targetKind: comment.target.kind,
    targetId: comment.target.id,
    targetCollectionId: comment.target.collectionId,
    targetSeriesId: comment.target.seriesId,
    targetGeneration: comment.targetGeneration,
    actorAccountId: comment.authorAccountId,
    recipientAccountId,
  };
  await transaction.insertInto('resource_id_ledger').values({
    resource_id: outboxId,
    resource_type: 'outbox',
  }).execute();
  await transaction.insertInto('resource_id_ledger').values({
    resource_id: domainEventId,
    resource_type: 'domain-event',
  }).execute();
  await transaction.insertInto('outbox_events').values({
    outbox_id: outboxId,
    domain_event_id: domainEventId,
    event_type: COMMUNITY_COMMENT_NOTIFICATION_EVENT_TYPE,
    event_version: COMMUNITY_COMMENT_NOTIFICATION_EVENT_VERSION,
    handler_name: COMMUNITY_COMMENT_NOTIFICATION_HANDLER_NAME,
    handler_mode: COMMUNITY_COMMENT_NOTIFICATION_HANDLER_MODE,
    aggregate_type: COMMUNITY_COMMENT_NOTIFICATION_AGGREGATE_TYPE,
    aggregate_id: comment.id,
    aggregate_scope: recipientAccountId,
    aggregate_revision: COMMUNITY_COMMENT_NOTIFICATION_AGGREGATE_REVISION,
    commit_ordinal: null,
    occurred_at: occurredAt,
    payload_json: payload as unknown as Record<string, unknown>,
    state: 'pending',
    attempt_count: 0,
    available_at: occurredAt,
    locked_until: null,
    lease_generation: 0n,
    completed_at: null,
    last_error: null,
    dead_lettered_at: null,
  }).execute();
}

const isOpaqueId = (value: unknown): value is string =>
  typeof value === 'string' && OPAQUE_ID.test(value);
const isNullableOpaqueId = (value: unknown): value is string | null =>
  value === null || isOpaqueId(value);

const validateV1 = defineClosedPayloadValidator({
  commentId: isOpaqueId,
  replyToId: isNullableOpaqueId,
  targetKind: (value): value is string =>
    typeof value === 'string' && (COMMUNITY_TARGET_KINDS as readonly string[]).includes(value),
  targetId: isOpaqueId,
  targetCollectionId: isNullableOpaqueId,
  targetSeriesId: isNullableOpaqueId,
  targetGeneration: isOpaqueId,
  actorAccountId: isOpaqueId,
  recipientAccountId: isOpaqueId,
});

export const communityCommentNotificationEnvelopeRegistrations: readonly EventPayloadRegistration[] =
  Object.freeze([
    Object.freeze({
      eventType: COMMUNITY_COMMENT_NOTIFICATION_EVENT_TYPE,
      eventVersion: COMMUNITY_COMMENT_NOTIFICATION_EVENT_VERSION,
      validatePayload: validateV1,
    }),
  ]);

/** Envelope → normalized event; every binding is re-proved before dispatch. */
export function normalizeCommunityCommentNotificationEvent(
  envelope: VersionedEventEnvelope,
): CommunityCommentNotificationEvent {
  const identity = envelope.aggregate_identity;
  if (identity.aggregate_type !== COMMUNITY_COMMENT_NOTIFICATION_AGGREGATE_TYPE) {
    throw new InvalidEventEnvelopeError('community comment notification aggregate type is invalid');
  }
  if (envelope.aggregate_revision !== COMMUNITY_COMMENT_NOTIFICATION_AGGREGATE_REVISION) {
    throw new InvalidEventEnvelopeError('community comment notification aggregate revision is invalid');
  }
  if (envelope.commit_ordinal !== null) {
    throw new InvalidEventEnvelopeError('community comment notification commit ordinal must be null');
  }
  if (!validateV1(envelope.payload)) {
    throw new InvalidEventEnvelopeError('community comment notification payload is invalid');
  }
  const payload = envelope.payload as unknown as CommunityCommentNotificationPayload;
  if (identity.aggregate_id !== payload.commentId
      || identity.aggregate_scope !== payload.recipientAccountId) {
    throw new InvalidEventEnvelopeError('community comment notification aggregate identity is invalid');
  }
  const kind = payload.targetKind;
  if (kind === 'bookmark' && payload.targetCollectionId === null
      || kind === 'digest_edition' && payload.targetSeriesId === null
      || (kind === 'collection' || kind === 'digest_series')
        && (payload.targetCollectionId !== null || payload.targetSeriesId !== null)) {
    throw new InvalidEventEnvelopeError('community comment notification target identity is invalid');
  }
  return Object.freeze<CommunityCommentNotificationEvent>({
    kind: 'comment_created',
    eventId: envelope.event_id,
    eventVersion: COMMUNITY_COMMENT_NOTIFICATION_EVENT_VERSION,
    commentId: payload.commentId,
    replyToId: payload.replyToId,
    target: Object.freeze({
      kind: payload.targetKind as CommunityCommentNotificationEvent['target']['kind'],
      id: payload.targetId,
      collectionId: payload.targetCollectionId,
      seriesId: payload.targetSeriesId,
    }),
    targetGeneration: payload.targetGeneration,
    actorAccountId: payload.actorAccountId,
    recipientAccountId: payload.recipientAccountId,
    occurredAt: new Date(envelope.occurred_at),
  });
}

export interface CommunityNotificationWorkerRouteOptions {
  readonly repository: CommunityNotificationWorkerRepository;
  readonly metrics?: { readonly increment: (name: string, value?: number) => void };
}

/**
 * The durable worker route: claim → normalize the closed envelope → project
 * inside the repository's transaction → complete. A lost lease (or a
 * missing attempt fence) is retryable — the router's claim fence decides
 * ownership, never a process-local flag.
 */
export function createCommunityNotificationWorkerRoutes(
  options: CommunityNotificationWorkerRouteOptions,
): readonly OutboxRoute[] {
  return Object.freeze([Object.freeze<OutboxRoute>({
    handlerName: COMMUNITY_COMMENT_NOTIFICATION_HANDLER_NAME,
    handlerMode: COMMUNITY_COMMENT_NOTIFICATION_HANDLER_MODE,
    eventType: COMMUNITY_COMMENT_NOTIFICATION_EVENT_TYPE,
    eventVersion: COMMUNITY_COMMENT_NOTIFICATION_EVENT_VERSION,
    sideEffectDurability: 'durable',
    routeClass: 'projection',
    async handle(context: OutboxHandlerContext): Promise<void> {
      context.signal.throwIfAborted();
      if (!context.attempt) {
        throw new OutboxDeliveryError(
          'retryable', 'community comment notification attempt fence is missing');
      }
      const event = normalizeCommunityCommentNotificationEvent(context.envelope);
      const result = await options.repository.project({
        event,
        attempt: context.attempt,
        signal: context.signal,
      });
      options.metrics?.increment(`community.notification.${result.disposition}`);
      if (result.disposition === 'lease_lost') {
        throw new OutboxDeliveryError('retryable', 'community comment notification lease was lost');
      }
      options.metrics?.increment('community.notification.handled');
    },
  })]);
}
