import type {
  SocialFollowActivityConsumerEvent,
  SocialFeedWorkerRepository,
} from '../../modules/social/index.js';
import {
  InvalidEventEnvelopeError,
  type VersionedEventEnvelope,
} from '../outbox/envelope.js';
import { OutboxDeliveryError, type OutboxHandlerContext, type OutboxRoute } from '../outbox/router.js';

export const SOCIAL_FEED_FOLLOW_ACTIVITY_HANDLER = 'social_feed_follow_activity' as const;
export const SOCIAL_FEED_FOLLOW_ACTIVITY_EVENT_TYPE = 'social.follow-created' as const;

/**
 * FIX-M-024 Feed follow_activity producer: consumes the Follow-created domain event written by
 * the real Follow command and projects one stable item to the followed Profile owner.
 */
export function createSocialFeedFollowActivityWorkerRoutes(options: {
  readonly repository: SocialFeedWorkerRepository;
  readonly metrics?: { readonly increment: (name: string, value?: number) => void };
}): readonly OutboxRoute[] {
  return Object.freeze([Object.freeze({
    handlerName: SOCIAL_FEED_FOLLOW_ACTIVITY_HANDLER,
    handlerMode: 'delivery_each_event' as const,
    eventType: SOCIAL_FEED_FOLLOW_ACTIVITY_EVENT_TYPE,
    eventVersion: 1,
    sideEffectDurability: 'durable' as const,
    routeClass: 'projection' as const,
    async handle(context: OutboxHandlerContext): Promise<void> {
      context.signal.throwIfAborted();
      if (!context.attempt) {
        throw new OutboxDeliveryError('retryable',
          'social Feed follow-activity attempt fence is missing');
      }
      const result = await options.repository.projectFollowActivity({
        event: normalize(context.envelope),
        attempt: context.attempt,
        signal: context.signal,
      });
      recordFollowActivityDisposition(options.metrics, result.disposition);
      if (result.disposition === 'lease_lost') {
        throw new OutboxDeliveryError('retryable',
          'social Feed follow-activity attempt lease was lost');
      }
    },
  })]);
}

function recordFollowActivityDisposition(
  metrics: { readonly increment: (name: string, value?: number) => void } | undefined,
  disposition: 'applied' | 'duplicate' | 'ineligible' | 'lease_lost',
): void {
  if (!metrics) return;
  switch (disposition) {
    case 'applied': metrics.increment('feed.follow_activity.applied'); break;
    case 'duplicate': metrics.increment('feed.follow_activity.duplicate'); break;
    case 'ineligible': metrics.increment('feed.follow_activity.ineligible'); break;
    case 'lease_lost': metrics.increment('feed.follow_activity.lease_lost'); break;
  }
}

function normalize(envelope: VersionedEventEnvelope): SocialFollowActivityConsumerEvent {
  if (envelope.event_type !== SOCIAL_FEED_FOLLOW_ACTIVITY_EVENT_TYPE
      || envelope.event_version !== 1) {
    throw new InvalidEventEnvelopeError('social Feed follow-activity event type is invalid');
  }
  const payload = envelope.payload as Record<string, string>;
  const aggregate = envelope.aggregate_identity;
  if (aggregate.aggregate_type !== 'profile-follow'
      || aggregate.aggregate_id !== payload.actorProfileId
      || aggregate.aggregate_scope !== payload.targetProfileId) {
    throw new InvalidEventEnvelopeError('social Feed follow-activity identity binding is invalid');
  }
  if (envelope.commit_ordinal !== null) {
    throw new InvalidEventEnvelopeError('social Feed follow-activity commit ordinal is invalid');
  }
  return Object.freeze({
    eventId: envelope.event_id,
    eventVersion: 1,
    actorProfileId: payload.actorProfileId!,
    targetProfileId: payload.targetProfileId!,
    occurredAt: new Date(envelope.occurred_at),
  });
}
