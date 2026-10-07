import type { Metrics } from '../telemetry/index.js';
import {
  defineClosedPayloadValidator,
  InvalidEventEnvelopeError,
  type EventPayloadRegistration,
  type PayloadValidator,
  type VersionedEventEnvelope,
} from '../outbox/envelope.js';
import { OutboxDeliveryError, type OutboxHandlerContext, type OutboxRoute } from '../outbox/router.js';
import {
  SOCIAL_IDENTITY_MAX_LENGTH,
  type SocialNotificationEvent, type SocialNotificationWorkerRepository,
} from '../../modules/notifications/index.js';

export const SOCIAL_FOLLOW_NOTIFICATION_HANDLER = 'social_follow_activity' as const;
export const SOCIAL_FEED_ITEM_NOTIFICATION_HANDLER = 'social_feed_item_notification' as const;
export const SOCIAL_FEED_ITEM_PUBLISHED_EVENT = 'social.feed-item-published' as const;
const MAX_PAYLOAD_BYTES = 2_048;
const identity = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= SOCIAL_IDENTITY_MAX_LENGTH && value.trim() === value;
const recheck = (value: unknown): value is string => identity(value)
  && value.startsWith('publication.collection:');

function budgeted(validator: PayloadValidator): PayloadValidator {
  return (payload: unknown): payload is Readonly<Record<string, never>> => validator(payload)
    && Buffer.byteLength(JSON.stringify(payload), 'utf8') <= MAX_PAYLOAD_BYTES;
}

const followPayload = budgeted(defineClosedPayloadValidator({
  actorProfileId: identity, targetProfileId: identity,
}));
const feedItemPayload = budgeted(defineClosedPayloadValidator({
  feedItemId: identity, recipientProfileId: identity, sourceEventId: identity,
  collectionId: identity, discoverabilityRecheckKey: recheck,
}));

export const socialNotificationEnvelopeRegistrations: readonly EventPayloadRegistration[] = Object.freeze([
  Object.freeze({ eventType: 'social.follow-created', eventVersion: 1, validatePayload: followPayload }),
  Object.freeze({ eventType: 'social.follow-removed', eventVersion: 1, validatePayload: followPayload }),
  Object.freeze({ eventType: SOCIAL_FEED_ITEM_PUBLISHED_EVENT, eventVersion: 1,
    validatePayload: feedItemPayload }),
]);

export function createSocialNotificationWorkerRoutes(options: {
  readonly repository: SocialNotificationWorkerRepository;
  readonly metrics?: Metrics;
}): readonly OutboxRoute[] {
  const registrations = [
    { handlerName: SOCIAL_FOLLOW_NOTIFICATION_HANDLER,
      eventType: 'social.follow-created', eventVersion: 1 },
    { handlerName: SOCIAL_FOLLOW_NOTIFICATION_HANDLER,
      eventType: 'social.follow-removed', eventVersion: 1 },
    { handlerName: SOCIAL_FEED_ITEM_NOTIFICATION_HANDLER,
      eventType: SOCIAL_FEED_ITEM_PUBLISHED_EVENT, eventVersion: 1 },
  ] as const;
  return Object.freeze(registrations.map((registration): OutboxRoute => Object.freeze({
    ...registration,
    handlerMode: 'delivery_each_event',
    sideEffectDurability: 'durable',
    routeClass: 'projection',
    async handle(context: OutboxHandlerContext): Promise<void> {
      context.signal.throwIfAborted();
      if (!context.attempt) {
        throw new OutboxDeliveryError('retryable',
          'social Notification projection attempt fence is missing');
      }
      const result = await options.repository.project({
        event: normalize(context.envelope), attempt: context.attempt, signal: context.signal,
      });
      recordDisposition(options.metrics, result.disposition);
      if (result.notificationCreated) options.metrics?.increment('notification.social.created');
      if (result.deliveryIntentCreated) {
        options.metrics?.increment('notification.social.delivery_intent_created');
      }
      if (result.disposition === 'lease_lost') {
        throw new OutboxDeliveryError('retryable',
          'social Notification projection attempt lease was lost');
      }
    },
  })));
}

function recordDisposition(metrics: Metrics | undefined,
  disposition: 'applied' | 'duplicate' | 'ineligible'
    | 'preference_disabled' | 'lease_lost'): void {
  if (!metrics) return;
  switch (disposition) {
    case 'applied': metrics.increment('notification.social.applied'); break;
    case 'duplicate': metrics.increment('notification.social.duplicate'); break;
    case 'ineligible': metrics.increment('notification.social.ineligible'); break;
    case 'preference_disabled':
      metrics.increment('notification.social.preference_disabled'); break;
    case 'lease_lost': metrics.increment('notification.social.lease_lost'); break;
  }
}

function normalize(envelope: VersionedEventEnvelope): SocialNotificationEvent {
  if (envelope.event_version !== 1) {
    throw new InvalidEventEnvelopeError('social Notification event version is invalid');
  }
  const payload = envelope.payload as Record<string, string>;
  const aggregate = envelope.aggregate_identity;
  const occurredAt = new Date(envelope.occurred_at);
  if (envelope.event_type === 'social.follow-created' || envelope.event_type === 'social.follow-removed') {
    if (aggregate.aggregate_type !== 'profile-follow'
        || aggregate.aggregate_id !== payload.actorProfileId
        || aggregate.aggregate_scope !== payload.targetProfileId) {
      throw new InvalidEventEnvelopeError('social Follow notification identity binding is invalid');
    }
    return Object.freeze({
      kind: envelope.event_type === 'social.follow-created' ? 'follow_created' : 'follow_removed',
      eventId: envelope.event_id, eventVersion: 1,
      actorProfileId: payload.actorProfileId!, recipientProfileId: payload.targetProfileId!, occurredAt,
    });
  }
  if (envelope.event_type === SOCIAL_FEED_ITEM_PUBLISHED_EVENT) {
    if (aggregate.aggregate_type !== 'social-feed-item'
        || aggregate.aggregate_id !== payload.feedItemId
        || aggregate.aggregate_scope !== payload.recipientProfileId
        || payload.discoverabilityRecheckKey !== `publication.collection:${payload.collectionId}`) {
      throw new InvalidEventEnvelopeError('social Feed notification recipient binding is invalid');
    }
    return Object.freeze({ kind: 'feed_item_published', eventId: envelope.event_id,
      eventVersion: 1, feedItemId: payload.feedItemId!,
      recipientProfileId: payload.recipientProfileId!, sourceEventId: payload.sourceEventId!,
      collectionId: payload.collectionId!, discoverabilityRecheckKey: payload.discoverabilityRecheckKey!,
      occurredAt });
  }
  throw new InvalidEventEnvelopeError('social Notification event type is invalid');
}
