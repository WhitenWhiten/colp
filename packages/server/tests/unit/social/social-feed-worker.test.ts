import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  rebuildSocialFeedProjection,
  type SocialFeedWorkerRepository,
} from '../../../src/modules/social/index.js';
import { EventEnvelopeRegistry, OutboxDeliveryError } from '../../../src/infrastructure/outbox/index.js';
import {
  createSocialFeedFollowActivityWorkerRoutes,
  createSocialFeedWorkerRoutes,
  socialCollectionChangeEnvelopeRegistrations,
  socialFollowEventEnvelopeRegistrations,
} from '../../../src/infrastructure/social/index.js';

const envelope = Object.freeze({
  event_id: 'CAgICAgICAgICAgICAgICA',
  event_type: 'social.collection-change',
  event_version: 2,
  aggregate_identity: Object.freeze({
    aggregate_type: 'collection', aggregate_id: 'Dw8PDw8PDw8PDw8PDw8PDw',
    aggregate_scope: 'Dw8PDw8PDw8PDw8PDw8PDw',
  }),
  aggregate_revision: 'publication-revision-101',
  commit_ordinal: '101',
  occurred_at: '2026-07-29T10:01:00.000Z',
  payload: Object.freeze({
    collectionId: 'Dw8PDw8PDw8PDw8PDw8PDw',
    ownerProfileId: 'IiIiIiIiIiIiIiIiIiIiIg',
    publicationRevision: 'publication-revision-101',
    discoverabilityRecheckKey: 'publication.collection:Dw8PDw8PDw8PDw8PDw8PDw',
    producerDiscoverability: 'public_candidate',
  }),
});

function repository(overrides: Partial<SocialFeedWorkerRepository> = {}) {
  const projected: unknown[] = [];
  const followed: unknown[] = [];
  const rebuilt: unknown[] = [];
  const value: SocialFeedWorkerRepository = {
    async projectCollectionChange(input) { projected.push(input); return { disposition: 'applied', itemCount: 1 }; },
    async projectFollowActivity(input) { followed.push(input); return { disposition: 'applied', itemCount: 1 }; },
    async rebuildCollectionScope(input) { rebuilt.push(input); return { eventCount: 1, itemCount: 1, highCommitOrdinal: '101' }; },
    ...overrides,
  };
  return { value, projected, followed, rebuilt };
}

const followEnvelope = Object.freeze({
  event_id: 'CAgICAgICAgICAgICAgICA',
  event_type: 'social.follow-created',
  event_version: 1,
  aggregate_identity: Object.freeze({
    aggregate_type: 'profile-follow', aggregate_id: 'actor-1', aggregate_scope: 'target-1',
  }),
  aggregate_revision: null,
  commit_ordinal: null,
  occurred_at: '2026-07-29T10:01:00.000Z',
  payload: Object.freeze({ actorProfileId: 'actor-1', targetProfileId: 'target-1' }),
});

test('P5-11 registers version-aware durable N/N-1 routes and closed validators', async () => {
  const seen = repository();
  const routes = createSocialFeedWorkerRoutes({ repository: seen.value, maxRecipientsPerEvent: 25 });
  assert.deepEqual(routes.map((route) => `${route.handlerName}/${route.eventType}@${route.eventVersion}`), [
    'social.publish-collection-change/social.collection-change@1',
    'social.publish-collection-change/social.collection-change@2',
  ]);
  assert.ok(routes.every((route) => route.sideEffectDurability === 'durable'));
  const registry = new EventEnvelopeRegistry(socialCollectionChangeEnvelopeRegistrations);
  const current = registry.validate(envelope);
  const previous = registry.validate({ ...envelope, event_version: 1,
    payload: (({ producerDiscoverability: _omitted, ...payload }) => payload)(envelope.payload) });
  assert.equal(current.event_version, 2);
  assert.equal(previous.event_version, 1);
  assert.throws(() => registry.validate({ ...envelope, event_version: 3 }), /unsupported outbox event/u);
  assert.throws(() => registry.validate({ ...envelope,
    payload: { ...envelope.payload, privateTitle: 'P511_SECRET' } }), /invalid closed payload/u);
});

test('P5-11 handler forwards lease attempt fence, signal and configured fan-out cap', async () => {
  const seen = repository();
  const route = createSocialFeedWorkerRoutes({ repository: seen.value, maxRecipientsPerEvent: 7 })[1]!;
  const controller = new AbortController();
  await route.handle({ envelope, idempotencyKey: envelope.event_id, signal: controller.signal,
    attempt: { outboxId: 'outbox-1', leaseGeneration: '9' } });
  assert.deepEqual(seen.projected, [{
    event: {
      eventId: envelope.event_id, eventVersion: 2,
      collectionId: envelope.payload.collectionId,
      ownerProfileId: envelope.payload.ownerProfileId,
      publicationRevision: envelope.payload.publicationRevision,
      discoverabilityRecheckKey: envelope.payload.discoverabilityRecheckKey,
      producerDiscoverability: 'public_candidate', commitOrdinal: '101',
      occurredAt: new Date(envelope.occurred_at),
    },
    attempt: { outboxId: 'outbox-1', leaseGeneration: '9' },
    maxRecipients: 7, signal: controller.signal,
  }]);
});

test('P5-11 accepts only bounded recipient page sizes from 1 through 1000', () => {
  const seen = repository();
  assert.equal(createSocialFeedWorkerRoutes({
    repository: seen.value, maxRecipientsPerEvent: 1,
  }).length, 2);
  assert.equal(createSocialFeedWorkerRoutes({
    repository: seen.value, maxRecipientsPerEvent: 1_000,
  }).length, 2);
  assert.throws(() => createSocialFeedWorkerRoutes({
    repository: seen.value, maxRecipientsPerEvent: 0,
  }), /between 1 and 1000/u);
  assert.throws(() => createSocialFeedWorkerRoutes({
    repository: seen.value, maxRecipientsPerEvent: 1_001,
  }), /between 1 and 1000/u);
});

test('P5-11 treats malformed bindings and repository failures as replayable failures', async () => {
  const overflow = repository({
    async projectCollectionChange() {
      throw new OutboxDeliveryError('retryable', 'social feed projection dependency unavailable');
    },
  });
  const route = createSocialFeedWorkerRoutes({ repository: overflow.value, maxRecipientsPerEvent: 2 })[1]!;
  await assert.rejects(route.handle({ envelope, idempotencyKey: envelope.event_id,
    signal: new AbortController().signal,
    attempt: { outboxId: 'outbox-2', leaseGeneration: '1' } }),
  /dependency unavailable/u);
  await assert.rejects(route.handle({ envelope: { ...envelope,
    aggregate_identity: { ...envelope.aggregate_identity, aggregate_scope: 'other' } },
  idempotencyKey: envelope.event_id, signal: new AbortController().signal,
  attempt: { outboxId: 'outbox-2', leaseGeneration: '1' } }), /aggregate scope/u);
});

test('P5-11 registers the durable delivery_each_event follow-activity route with a closed identity binding', async () => {
  const seen = repository();
  const routes = createSocialFeedFollowActivityWorkerRoutes({ repository: seen.value });
  assert.equal(routes.length, 1);
  assert.deepEqual({
    handlerName: routes[0]!.handlerName,
    eventType: routes[0]!.eventType,
    eventVersion: routes[0]!.eventVersion,
    handlerMode: routes[0]!.handlerMode,
    sideEffectDurability: routes[0]!.sideEffectDurability,
    routeClass: routes[0]!.routeClass,
  }, {
    handlerName: 'social_feed_follow_activity',
    eventType: 'social.follow-created',
    eventVersion: 1,
    handlerMode: 'delivery_each_event',
    sideEffectDurability: 'durable',
    routeClass: 'projection',
  });
  const registry = new EventEnvelopeRegistry(socialFollowEventEnvelopeRegistrations);
  const validated = registry.validate(followEnvelope);
  assert.equal(validated.event_type, 'social.follow-created');
  assert.throws(() => registry.validate({ ...followEnvelope,
    payload: { ...followEnvelope.payload, privateMarker: 'P5024_SECRET' } }),
  /invalid closed payload/u);
});

test('P5-11 follow-activity handler forwards the normalized event, attempt fence and signal', async () => {
  const seen = repository();
  const route = createSocialFeedFollowActivityWorkerRoutes({ repository: seen.value })[0]!;
  const controller = new AbortController();
  await route.handle({ envelope: followEnvelope, idempotencyKey: followEnvelope.event_id,
    signal: controller.signal, attempt: { outboxId: 'outbox-follow', leaseGeneration: '9' } });
  assert.deepEqual(seen.followed, [{
    event: {
      eventId: followEnvelope.event_id, eventVersion: 1,
      actorProfileId: followEnvelope.payload.actorProfileId,
      targetProfileId: followEnvelope.payload.targetProfileId,
      occurredAt: new Date(followEnvelope.occurred_at),
    },
    attempt: { outboxId: 'outbox-follow', leaseGeneration: '9' },
    signal: controller.signal,
  }]);
});

test('P5-11 follow-activity route treats malformed bindings and lease loss as replayable failures', async () => {
  const missingFence = createSocialFeedFollowActivityWorkerRoutes({
    repository: repository().value,
  })[0]!;
  await assert.rejects(missingFence.handle({ envelope: followEnvelope,
    idempotencyKey: followEnvelope.event_id, signal: new AbortController().signal }),
  /attempt fence is missing/u);

  const lost = repository({ async projectFollowActivity() {
    return { disposition: 'lease_lost', itemCount: 0 };
  } });
  const lostRoute = createSocialFeedFollowActivityWorkerRoutes({ repository: lost.value })[0]!;
  await assert.rejects(lostRoute.handle({ envelope: followEnvelope,
    idempotencyKey: followEnvelope.event_id, signal: new AbortController().signal,
    attempt: { outboxId: 'outbox-lost', leaseGeneration: '1' } }),
  /attempt lease was lost/u);

  const seen = repository();
  const route = createSocialFeedFollowActivityWorkerRoutes({ repository: seen.value })[0]!;
  await assert.rejects(route.handle({ envelope: { ...followEnvelope,
    aggregate_identity: { ...followEnvelope.aggregate_identity, aggregate_scope: 'other-target' } },
  idempotencyKey: followEnvelope.event_id, signal: new AbortController().signal,
  attempt: { outboxId: 'outbox-binding', leaseGeneration: '1' } }), /identity binding/u);
  assert.deepEqual(seen.followed, []);
  await assert.rejects(route.handle({ envelope: { ...followEnvelope, event_version: 2 },
  idempotencyKey: followEnvelope.event_id, signal: new AbortController().signal,
  attempt: { outboxId: 'outbox-version', leaseGeneration: '1' } }), /event type is invalid/u);
});
test('P5-11 rebuild path is bounded and delegates retained-event/current-authority replay', async () => {
  const seen = repository();
  const signal = new AbortController().signal;
  const result = await rebuildSocialFeedProjection({ repository: seen.value,
    aggregateScope: envelope.aggregate_identity.aggregate_scope!, maxEvents: 40,
    maxRecipientsPerEvent: 20, signal });
  assert.deepEqual(result, { eventCount: 1, itemCount: 1, highCommitOrdinal: '101' });
  assert.deepEqual(seen.rebuilt, [{ aggregateScope: envelope.aggregate_identity.aggregate_scope,
    maxEvents: 40, maxRecipients: 20, signal }]);
  await assert.rejects(rebuildSocialFeedProjection({ repository: seen.value,
    aggregateScope: envelope.aggregate_identity.aggregate_scope!, maxEvents: 0,
    maxRecipientsPerEvent: 20 }), /maxEvents/u);
});
