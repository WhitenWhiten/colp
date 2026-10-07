import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COMMUNITY_COMMENT_NOTIFICATION_AGGREGATE_REVISION,
  COMMUNITY_COMMENT_NOTIFICATION_AGGREGATE_TYPE,
  COMMUNITY_COMMENT_NOTIFICATION_EVENT_TYPE,
  COMMUNITY_COMMENT_NOTIFICATION_EVENT_VERSION,
  COMMUNITY_COMMENT_NOTIFICATION_HANDLER_MODE,
  COMMUNITY_COMMENT_NOTIFICATION_HANDLER_NAME,
  communityCommentNotificationEnvelopeRegistrations,
  createCommunityNotificationWorkerRoutes,
  normalizeCommunityCommentNotificationEvent,
} from '../../../src/infrastructure/community/community-notification-outbox.js';
import { InvalidEventEnvelopeError } from '../../../src/infrastructure/outbox/envelope.js';
import { OutboxDeliveryError } from '../../../src/infrastructure/outbox/router.js';
import type { CommunityNotificationWorkerRepository } from '../../../src/modules/community/index.js';

const OCCURRED_AT = '2026-10-05T12:00:00.000Z';

function payload(overrides: Record<string, unknown> = {}) {
  return {
    commentId: 'comment-1',
    replyToId: 'comment-root',
    targetKind: 'collection',
    targetId: 'col-1',
    targetCollectionId: null,
    targetSeriesId: null,
    targetGeneration: 'static',
    actorAccountId: 'a-actor',
    recipientAccountId: 'a-owner',
    ...overrides,
  };
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    event_id: 'evt-1',
    event_type: COMMUNITY_COMMENT_NOTIFICATION_EVENT_TYPE,
    event_version: COMMUNITY_COMMENT_NOTIFICATION_EVENT_VERSION,
    aggregate_identity: {
      aggregate_type: COMMUNITY_COMMENT_NOTIFICATION_AGGREGATE_TYPE,
      aggregate_id: 'comment-1',
      aggregate_scope: 'a-owner',
    },
    aggregate_revision: COMMUNITY_COMMENT_NOTIFICATION_AGGREGATE_REVISION,
    commit_ordinal: null,
    occurred_at: OCCURRED_AT,
    payload: payload(),
    ...overrides,
  };
}

test('envelope normalization binds identity, revision, and closed payload', () => {
  const event = normalizeCommunityCommentNotificationEvent(envelope() as never);
  assert.equal(event.kind, 'comment_created');
  assert.equal(event.commentId, 'comment-1');
  assert.equal(event.replyToId, 'comment-root');
  assert.deepEqual(event.target, {
    kind: 'collection', id: 'col-1', collectionId: null, seriesId: null,
  });
  assert.equal(event.actorAccountId, 'a-actor');
  assert.equal(event.recipientAccountId, 'a-owner');
  assert.equal(event.occurredAt.toISOString(), OCCURRED_AT);
});

test('envelope normalization fails closed on identity, revision, or payload drift', () => {
  for (const bad of [
    envelope({ aggregate_revision: 'ccn-v2' }),
    envelope({ commit_ordinal: '7' }),
    envelope({ aggregate_identity: { aggregate_type: 'other', aggregate_id: 'comment-1', aggregate_scope: 'a-owner' } }),
    envelope({ aggregate_identity: { aggregate_type: COMMUNITY_COMMENT_NOTIFICATION_AGGREGATE_TYPE, aggregate_id: 'comment-2', aggregate_scope: 'a-owner' } }),
    envelope({ aggregate_identity: { aggregate_type: COMMUNITY_COMMENT_NOTIFICATION_AGGREGATE_TYPE, aggregate_id: 'comment-1', aggregate_scope: 'a-other' } }),
    envelope({ payload: payload({ replyToId: 'bad id!' }) }),
    envelope({ payload: payload({ targetKind: 'unknown' }) }),
    envelope({ payload: { ...payload(), extra: 1 } }),
    // A collection target must not pin parent locators.
    envelope({ payload: payload({ targetCollectionId: 'col-parent' }) }),
    // A bookmark target must pin its collection.
    envelope({ payload: payload({ targetKind: 'bookmark', targetId: 'bm-1' }) }),
  ]) {
    assert.throws(
      () => normalizeCommunityCommentNotificationEvent(bad as never),
      InvalidEventEnvelopeError,
    );
  }
});

test('a bookmark event carries its collection parent; root comments carry null replyToId', () => {
  const bookmark = normalizeCommunityCommentNotificationEvent(envelope({
    payload: payload({ targetKind: 'bookmark', targetId: 'bm-1', targetCollectionId: 'col-9' }),
  }) as never);
  assert.deepEqual(bookmark.target, {
    kind: 'bookmark', id: 'bm-1', collectionId: 'col-9', seriesId: null,
  });
  const root = normalizeCommunityCommentNotificationEvent(envelope({
    payload: payload({ replyToId: null }),
  }) as never);
  assert.equal(root.replyToId, null);
});

test('the worker route is durable, projection-classed, and delivery_each_event', () => {
  const repository: CommunityNotificationWorkerRepository = {
    project: async () => ({ disposition: 'applied', notificationCreated: true }),
  };
  const [route] = createCommunityNotificationWorkerRoutes({ repository });
  assert.equal(route!.handlerName, COMMUNITY_COMMENT_NOTIFICATION_HANDLER_NAME);
  assert.equal(route!.handlerName, 'community_comment_notification');
  assert.equal(route!.handlerMode, COMMUNITY_COMMENT_NOTIFICATION_HANDLER_MODE);
  assert.equal(route!.handlerMode, 'delivery_each_event');
  assert.equal(route!.eventType, 'community.comment-created');
  assert.equal(route!.eventVersion, 1);
  assert.equal(route!.sideEffectDurability, 'durable');
  assert.equal(route!.routeClass, 'projection');
});

test('the route projects through the repository and records the disposition metric', async () => {
  const seen: { eventId?: string; attempt?: string } = {};
  const increments: string[] = [];
  const repository: CommunityNotificationWorkerRepository = {
    project: async (input) => {
      seen.eventId = input.event.eventId;
      seen.attempt = input.attempt.outboxId;
      return { disposition: 'applied', notificationCreated: true };
    },
  };
  const [route] = createCommunityNotificationWorkerRoutes({
    repository, metrics: { increment: (name) => { increments.push(name); } },
  });
  await route!.handle({
    envelope: envelope() as never,
    idempotencyKey: 'ik-1',
    signal: new AbortController().signal,
    attempt: { outboxId: 'ob-1', leaseGeneration: '7' },
  });
  assert.equal(seen.eventId, 'evt-1');
  assert.equal(seen.attempt, 'ob-1');
  assert.deepEqual(increments, ['community.notification.applied', 'community.notification.handled']);
});

test('the route retries a missing attempt fence and a lost lease', async () => {
  const repository: CommunityNotificationWorkerRepository = {
    project: async () => ({ disposition: 'lease_lost', notificationCreated: false }),
  };
  const [route] = createCommunityNotificationWorkerRoutes({ repository });
  await assert.rejects(
    () => route!.handle({
      envelope: envelope() as never,
      idempotencyKey: 'ik-1',
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof OutboxDeliveryError
      && (error as OutboxDeliveryError).failureKind === 'retryable',
  );
  await assert.rejects(
    () => route!.handle({
      envelope: envelope() as never,
      idempotencyKey: 'ik-1',
      signal: new AbortController().signal,
      attempt: { outboxId: 'ob-1', leaseGeneration: '7' },
    }),
    (error: unknown) => error instanceof OutboxDeliveryError
      && (error as OutboxDeliveryError).failureKind === 'retryable',
  );
});

test('duplicate, ineligible, and preference-disabled dispositions complete without error', async () => {
  for (const disposition of ['duplicate', 'ineligible', 'preference_disabled'] as const) {
    const repository: CommunityNotificationWorkerRepository = {
      project: async () => ({ disposition, notificationCreated: false }),
    };
    const [route] = createCommunityNotificationWorkerRoutes({ repository });
    await route!.handle({
      envelope: envelope() as never,
      idempotencyKey: 'ik-1',
      signal: new AbortController().signal,
      attempt: { outboxId: 'ob-1', leaseGeneration: '7' },
    });
  }
});

test('the envelope registration pins the event type, version, and closed payload', () => {
  assert.equal(communityCommentNotificationEnvelopeRegistrations.length, 1);
  const registration = communityCommentNotificationEnvelopeRegistrations[0]!;
  assert.equal(registration.eventType, 'community.comment-created');
  assert.equal(registration.eventVersion, 1);
  assert.equal(registration.validatePayload(payload()), true);
  assert.equal(registration.validatePayload(payload({ actorAccountId: 42 })), false);
});
