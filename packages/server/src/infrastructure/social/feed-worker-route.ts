import {
  SOCIAL_IDENTITY_MAX_LENGTH,
  assertSocialFeedFanoutBound,
  recordFeedFanoutDisposition,
  type SocialCollectionChangeConsumerEvent,
  type SocialFeedWorkerRepository,
} from '../../modules/social/index.js';
import {
  defineClosedPayloadValidator,
  InvalidEventEnvelopeError,
  type EventPayloadRegistration,
  type VersionedEventEnvelope,
} from '../outbox/envelope.js';
import {
  OutboxContinuationRequested,
  OutboxDeliveryError,
  type OutboxHandlerContext,
  type OutboxRoute,
} from '../outbox/router.js';
import {
  SOCIAL_COLLECTION_CHANGE_EVENT_TYPE,
  SOCIAL_COLLECTION_CHANGE_HANDLER_MODE,
  SOCIAL_COLLECTION_CHANGE_HANDLER_NAME,
} from '../outbox/social-collection-change.js';

const ID = /^[A-Za-z0-9_-]{21}[AQgw]$/u;
const DECIMAL = /^[1-9][0-9]*$/u;
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0
  && value.length <= SOCIAL_IDENTITY_MAX_LENGTH && value.trim() === value;
const id = (value: unknown): value is string => text(value) && ID.test(value);
const recheck = (value: unknown): value is string =>
  text(value) && value.startsWith('publication.collection:');

const validateV1 = defineClosedPayloadValidator({
  collectionId: id,
  ownerProfileId: id,
  publicationRevision: text,
  discoverabilityRecheckKey: recheck,
});
const validateV2 = defineClosedPayloadValidator({
  collectionId: id,
  ownerProfileId: id,
  publicationRevision: text,
  discoverabilityRecheckKey: recheck,
  producerDiscoverability: (value) => value === 'public_candidate' || value === 'remove',
});

export const socialCollectionChangeEnvelopeRegistrations: readonly EventPayloadRegistration[] =
  Object.freeze([
    Object.freeze({ eventType: SOCIAL_COLLECTION_CHANGE_EVENT_TYPE, eventVersion: 1,
      validatePayload: validateV1 }),
    Object.freeze({ eventType: SOCIAL_COLLECTION_CHANGE_EVENT_TYPE, eventVersion: 2,
      validatePayload: validateV2 }),
  ]);

export function createSocialFeedWorkerRoutes(options: {
  readonly repository: SocialFeedWorkerRepository;
  readonly maxRecipientsPerEvent?: number;
  readonly metrics?: { readonly increment: (name: string, value?: number) => void };
}): readonly OutboxRoute[] {
  const maxRecipients = options.maxRecipientsPerEvent ?? 500;
  assertSocialFeedFanoutBound(maxRecipients);
  return Object.freeze([1, 2].map((eventVersion): OutboxRoute => Object.freeze({
    handlerName: SOCIAL_COLLECTION_CHANGE_HANDLER_NAME,
    handlerMode: SOCIAL_COLLECTION_CHANGE_HANDLER_MODE,
    eventType: SOCIAL_COLLECTION_CHANGE_EVENT_TYPE,
    eventVersion,
    sideEffectDurability: 'durable',
    routeClass: 'projection',
    async handle(context: OutboxHandlerContext): Promise<void> {
      context.signal.throwIfAborted();
      if (!context.attempt) {
        throw new OutboxDeliveryError('retryable', 'social Feed projection attempt fence is missing');
      }
      const event = normalizeSocialCollectionChange(context.envelope);
      const result = await options.repository.projectCollectionChange({
        event,
        attempt: context.attempt,
        maxRecipients,
        signal: context.signal,
      });
      recordFeedFanoutDisposition(options.metrics, result.disposition);
      if (result.disposition === 'lease_lost') {
        throw new OutboxDeliveryError('retryable', 'social Feed projection attempt lease was lost');
      }
      if (result.disposition === 'continued') {
        throw new OutboxContinuationRequested();
      }
    },
  })));
}

export function normalizeSocialCollectionChange(
  envelope: VersionedEventEnvelope,
): SocialCollectionChangeConsumerEvent {
  const payload = envelope.payload as Record<string, unknown>;
  const scope = envelope.aggregate_identity.aggregate_scope;
  if (envelope.aggregate_identity.aggregate_type !== 'collection'
      || scope === null || scope !== envelope.aggregate_identity.aggregate_id
      || scope !== payload.collectionId) {
    throw new InvalidEventEnvelopeError('social collection change aggregate scope is invalid');
  }
  if (envelope.aggregate_revision === null
      || envelope.aggregate_revision !== payload.publicationRevision) {
    throw new InvalidEventEnvelopeError('social collection change aggregate revision is invalid');
  }
  if (payload.discoverabilityRecheckKey !== `publication.collection:${scope}`) {
    throw new InvalidEventEnvelopeError('social collection change recheck binding is invalid');
  }
  if (envelope.commit_ordinal === null || !DECIMAL.test(envelope.commit_ordinal)) {
    throw new InvalidEventEnvelopeError('social collection change commit ordinal is invalid');
  }
  if (envelope.event_version !== 1 && envelope.event_version !== 2) {
    throw new InvalidEventEnvelopeError('social collection change version is invalid');
  }
  return Object.freeze({
    eventId: envelope.event_id,
    eventVersion: envelope.event_version,
    collectionId: scope,
    ownerProfileId: payload.ownerProfileId as string,
    publicationRevision: payload.publicationRevision as string,
    discoverabilityRecheckKey: payload.discoverabilityRecheckKey as string,
    producerDiscoverability: envelope.event_version === 2
      ? payload.producerDiscoverability as 'public_candidate' | 'remove' : null,
    commitOrdinal: envelope.commit_ordinal,
    occurredAt: new Date(envelope.occurred_at),
  });
}
