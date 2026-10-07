import {
  assertSocialFeedFanoutBound,
  type SocialFeedWithdrawalEvent,
  type SocialFeedWithdrawalWorkerRepository,
} from '../../modules/social/index.js';
import {
  InvalidEventEnvelopeError,
  type VersionedEventEnvelope,
} from '../outbox/envelope.js';
import {
  OutboxContinuationRequested,
  OutboxDeliveryError,
  type OutboxHandlerContext,
  type OutboxRoute,
} from '../outbox/router.js';

export const SOCIAL_FEED_WITHDRAWAL_HANDLER = 'social_feed_withdrawal' as const;
export const SOCIAL_FEED_WITHDRAWAL_EVENT_TYPE = 'social.follow-removed' as const;

export function createSocialFeedWithdrawalWorkerRoutes(options: {
  readonly repository: SocialFeedWithdrawalWorkerRepository;
  readonly maxRecipientsPerEvent?: number;
}): readonly OutboxRoute[] {
  const maxRecipients = options.maxRecipientsPerEvent ?? 500;
  assertSocialFeedFanoutBound(maxRecipients);
  return Object.freeze([Object.freeze({
    handlerName: SOCIAL_FEED_WITHDRAWAL_HANDLER,
    handlerMode: 'delivery_each_event' as const,
    eventType: SOCIAL_FEED_WITHDRAWAL_EVENT_TYPE,
    eventVersion: 1,
    sideEffectDurability: 'durable' as const,
    routeClass: 'projection' as const,
    async handle(context: OutboxHandlerContext): Promise<void> {
      context.signal.throwIfAborted();
      if (!context.attempt) {
        throw new OutboxDeliveryError('retryable',
          'social Feed withdrawal attempt fence is missing');
      }
      const result = await options.repository.project({
        event: normalize(context.envelope),
        attempt: context.attempt,
        maxRecipients,
        signal: context.signal,
      });
      if (result.disposition === 'lease_lost') {
        throw new OutboxDeliveryError('retryable',
          'social Feed withdrawal attempt lease was lost');
      }
      if (result.disposition === 'continued') {
        throw new OutboxContinuationRequested();
      }
    },
  })]);
}

function normalize(envelope: VersionedEventEnvelope): SocialFeedWithdrawalEvent {
  if (envelope.event_type !== SOCIAL_FEED_WITHDRAWAL_EVENT_TYPE || envelope.event_version !== 1) {
    throw new InvalidEventEnvelopeError('social Feed withdrawal event type is invalid');
  }
  const payload = envelope.payload as Record<string, string>;
  const aggregate = envelope.aggregate_identity;
  if (aggregate.aggregate_type !== 'profile-follow'
      || aggregate.aggregate_id !== payload.actorProfileId
      || aggregate.aggregate_scope !== payload.targetProfileId) {
    throw new InvalidEventEnvelopeError('social Feed withdrawal identity binding is invalid');
  }
  return Object.freeze({
    eventId: envelope.event_id,
    eventVersion: 1,
    actorProfileId: payload.actorProfileId!,
    targetProfileId: payload.targetProfileId!,
    occurredAt: new Date(envelope.occurred_at),
  });
}
