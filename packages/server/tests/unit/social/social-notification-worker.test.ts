import assert from 'node:assert/strict';
import { test } from 'vitest';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import { EventEnvelopeRegistry, OutboxDeliveryError } from '../../../src/infrastructure/outbox/index.js';
import {
  createSocialNotificationWorkerRoutes,
  socialNotificationEnvelopeRegistrations,
} from '../../../src/infrastructure/notifications/index.js';
import type { SocialNotificationWorkerRepository } from '../../../src/modules/notifications/index.js';

const FOLLOW = Object.freeze({
  event_id: 'follow-event-1', event_type: 'social.follow-created', event_version: 1,
  aggregate_identity: Object.freeze({ aggregate_type: 'profile-follow',
    aggregate_id: 'actor-profile', aggregate_scope: 'recipient-profile' }),
  aggregate_revision: '1', commit_ordinal: '101',
  occurred_at: '2026-07-29T11:00:00.000Z',
  payload: Object.freeze({ actorProfileId: 'actor-profile', targetProfileId: 'recipient-profile' }),
});

const FEED_ITEM = Object.freeze({
  event_id: 'feed-intent-1', event_type: 'social.feed-item-published', event_version: 1,
  aggregate_identity: Object.freeze({ aggregate_type: 'social-feed-item',
    aggregate_id: 'feed-item-1', aggregate_scope: 'recipient-profile' }),
  aggregate_revision: '1', commit_ordinal: '104',
  occurred_at: '2026-07-29T11:01:00.000Z',
  payload: Object.freeze({ feedItemId: 'feed-item-1', recipientProfileId: 'recipient-profile',
    sourceEventId: 'collection-event-1', collectionId: 'collection-1',
    discoverabilityRecheckKey: 'publication.collection:collection-1' }),
});

function repository(result: Awaited<ReturnType<SocialNotificationWorkerRepository['project']>> = {
  disposition: 'applied', notificationCreated: true, deliveryIntentCreated: false,
}) {
  const projected: unknown[] = [];
  const value: SocialNotificationWorkerRepository = {
    async project(input) { projected.push(input); return result; },
  };
  return { value, projected };
}

test('P5-17 registers version-aware durable Follow and Feed notification routes', () => {
  const seen = repository();
  const routes = createSocialNotificationWorkerRoutes({ repository: seen.value });
  assert.deepEqual(routes.map((route) =>
    `${route.handlerName}/${route.eventType}@${route.eventVersion}`), [
    'social_follow_activity/social.follow-created@1',
    'social_follow_activity/social.follow-removed@1',
    'social_feed_item_notification/social.feed-item-published@1',
  ]);
  assert.ok(routes.every((route) => route.handlerMode === 'delivery_each_event'
    && route.sideEffectDurability === 'durable' && route.routeClass === 'projection'));
  const registry = new EventEnvelopeRegistry(socialNotificationEnvelopeRegistrations);
  assert.equal(registry.validate(FOLLOW).event_version, 1);
  assert.equal(registry.validate(FEED_ITEM).event_type, 'social.feed-item-published');
  assert.throws(() => registry.validate({ ...FOLLOW, event_version: 2 }), /unsupported outbox event/u);
  assert.throws(() => registry.validate({ ...FOLLOW,
    payload: { ...FOLLOW.payload, privateEmail: 'P517_SECRET@example.invalid' } }),
  /invalid closed payload/u);
});

test('P5-17 handlers normalize closed facts and forward the attempt fence without content', async () => {
  const seen = repository();
  const metrics = new InMemoryMetrics();
  const routes = createSocialNotificationWorkerRoutes({ repository: seen.value, metrics });
  await routes[0]!.handle({ envelope: FOLLOW, idempotencyKey: FOLLOW.event_id,
    signal: new AbortController().signal,
    attempt: { outboxId: 'outbox-follow-1', leaseGeneration: '7' } });
  await routes[2]!.handle({ envelope: FEED_ITEM, idempotencyKey: FEED_ITEM.event_id,
    signal: new AbortController().signal,
    attempt: { outboxId: 'outbox-feed-1', leaseGeneration: '8' } });
  assert.equal(seen.projected.length, 2);
  assert.deepEqual((seen.projected[0] as { event: unknown; attempt: unknown }).event,
    { kind: 'follow_created', eventId: 'follow-event-1', eventVersion: 1,
      actorProfileId: 'actor-profile', recipientProfileId: 'recipient-profile',
      occurredAt: new Date(FOLLOW.occurred_at) });
  assert.deepEqual((seen.projected[0] as { attempt: unknown }).attempt,
    { outboxId: 'outbox-follow-1', leaseGeneration: '7' });
  assert.ok((seen.projected[0] as { signal: unknown }).signal instanceof AbortSignal);
  assert.deepEqual((seen.projected[1] as { event: unknown }).event,
    { kind: 'feed_item_published', eventId: 'feed-intent-1', eventVersion: 1,
      feedItemId: 'feed-item-1', recipientProfileId: 'recipient-profile',
      sourceEventId: 'collection-event-1', collectionId: 'collection-1',
      discoverabilityRecheckKey: 'publication.collection:collection-1',
      occurredAt: new Date(FEED_ITEM.occurred_at) });
  assert.deepEqual((seen.projected[1] as { attempt: unknown }).attempt,
    { outboxId: 'outbox-feed-1', leaseGeneration: '8' });
  assert.ok((seen.projected[1] as { signal: unknown }).signal instanceof AbortSignal);
  assert.equal(metrics.get('notification.social.applied'), 2);
  assert.equal(metrics.get('notification.social.created'), 2);
  assert.deepEqual([...new Set(['notification.social.applied', 'notification.social.created'])],
    ['notification.social.applied', 'notification.social.created']);
});

test('P5-17 rejects malformed bindings, missing fences and payloads over 2048 UTF-8 bytes', async () => {
  const seen = repository();
  const routes = createSocialNotificationWorkerRoutes({ repository: seen.value });
  await assert.rejects(routes[0]!.handle({ envelope: FOLLOW, idempotencyKey: FOLLOW.event_id,
    signal: new AbortController().signal }), /attempt fence is missing/u);
  await assert.rejects(routes[2]!.handle({ envelope: { ...FEED_ITEM,
    aggregate_identity: { ...FEED_ITEM.aggregate_identity, aggregate_scope: 'other-recipient' } },
  idempotencyKey: FEED_ITEM.event_id, signal: new AbortController().signal,
  attempt: { outboxId: 'outbox-feed-2', leaseGeneration: '1' } }), /recipient binding/u);
  const registry = new EventEnvelopeRegistry(socialNotificationEnvelopeRegistrations);
  const oversized = { ...FEED_ITEM, payload: { ...FEED_ITEM.payload,
    sourceEventId: `event-${'x'.repeat(2_048)}` } };
  assert.throws(() => registry.validate(oversized), (error: unknown) => {
    assert.doesNotMatch(String(error), /event-xxx/u);
    return true;
  });
});

test('P5-17 maps lease loss to retry and emits only fixed low-cardinality outcomes', async () => {
  const metrics = new InMemoryMetrics();
  const lost = repository({ disposition: 'lease_lost', notificationCreated: false,
    deliveryIntentCreated: false });
  const route = createSocialNotificationWorkerRoutes({ repository: lost.value, metrics })[0]!;
  await assert.rejects(route.handle({ envelope: FOLLOW, idempotencyKey: FOLLOW.event_id,
    signal: new AbortController().signal,
    attempt: { outboxId: 'outbox-secret-marker', leaseGeneration: '2' } }),
  (error: unknown) => error instanceof OutboxDeliveryError && error.failureKind === 'retryable'
    && !error.message.includes('outbox-secret-marker'));
  assert.equal(metrics.get('notification.social.lease_lost'), 1);
  assert.equal(metrics.get('notification.social.applied'), 0);
});
