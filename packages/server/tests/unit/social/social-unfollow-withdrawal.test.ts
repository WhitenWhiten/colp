import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  SOCIAL_FEED_WITHDRAWAL_HANDLER,
  createSocialFeedWithdrawalWorkerRoutes,
} from '../../../src/infrastructure/social/feed-withdrawal-worker-route.js';
import {
  FollowCommandError,
  followProfile,
  unfollowProfile,
  type FollowCommandPorts,
  type FollowCommandInput,
  type FollowOutboxEvent,
} from '../../../src/modules/social/index.js';

const ACTOR = 'profile-actor';
const TARGET = 'profile-target';
const PRINCIPAL = ACTOR;
const COMMAND_ID = '019fa956-0c4e-4190-94df-484c41fd9683';
const NOW = new Date('2026-07-29T08:00:00.000Z');

function input(overrides: Partial<FollowCommandInput> = {}): FollowCommandInput {
  return {
    actor: { principalId: PRINCIPAL, profileId: ACTOR },
    targetProfileId: TARGET,
    commandId: COMMAND_ID,
    ...overrides,
  };
}

function ports(options: {
  existingFollow?: boolean;
} = {}): {
  ports: FollowCommandPorts;
  events: FollowOutboxEvent[];
} {
  const events: FollowOutboxEvent[] = [];
  let following = options.existingFollow ?? false;
  let eventSeq = 0;
  let outboxSeq = 0;
  return {
    events,
    ports: {
      receipts: {
        async claim() { return { kind: 'claimed' }; },
        async complete() {},
        async purgeExpired() { return 0; },
        async deletePrincipalReceipts() { return 0; },
      },
      profiles: {
        async lockEligiblePair(binding) {
          return binding.actorProfileId === ACTOR
            && binding.actorPrincipalId === binding.actorProfileId
            && binding.targetProfileId === TARGET;
        },
      },
      follows: {
        async save(binding) {
          if (following) return { follow: { ...binding, followedAt: NOW }, inserted: false };
          following = true;
          return { follow: { ...binding, followedAt: NOW }, inserted: true };
        },
        async remove() {
          const changed = following;
          following = false;
          return changed;
        },
      },
      audit: { async append() {} },
      outbox: {
        async appendAll(batch) {
          events.push(...batch);
        },
      },
      clock: { async now() { return NOW; } },
      ids: {
        nextEventId() { eventSeq += 1; return `event-${eventSeq}`; },
        nextOutboxId() { outboxSeq += 1; return `outbox-${outboxSeq}`; },
      },
    },
  };
}

test('R5-06 Follow appendAll emits notification and Feed follow-activity outbox rows', async () => {
  const fixture = ports();
  await followProfile(fixture.ports, input());
  assert.equal(fixture.events.length, 2);
  assert.deepEqual(
    fixture.events.map((event) => event.handlerName).sort(),
    ['social_feed_follow_activity', 'social_follow_activity'],
  );
  assert.equal(fixture.events[0]?.eventType, 'social.follow-created');
  assert.equal(fixture.events[0]?.eventId, fixture.events[1]?.eventId);
  assert.equal(fixture.events[0]?.eventId, 'event-1');
  assert.notEqual(fixture.events[0]?.outboxId, fixture.events[1]?.outboxId);
  for (const event of fixture.events) {
    assert.equal(event.eventType, 'social.follow-created');
    assert.equal(event.eventVersion, 1);
    assert.equal(event.handlerMode, 'delivery_each_event');
    assert.deepEqual(event.payload, { actorProfileId: ACTOR, targetProfileId: TARGET });
  }
});

test('R5-06 Unfollow appendAll shares one domain event id across two independent outbox ids', async () => {
  const fixture = ports({ existingFollow: true });
  await unfollowProfile(fixture.ports, input());
  assert.equal(fixture.events.length, 2);
  assert.deepEqual(
    fixture.events.map((event) => event.handlerName).sort(),
    ['social_feed_withdrawal', 'social_follow_activity'],
  );
  assert.equal(fixture.events[0]?.eventId, fixture.events[1]?.eventId);
  assert.equal(fixture.events[0]?.eventId, 'event-1');
  assert.notEqual(fixture.events[0]?.outboxId, fixture.events[1]?.outboxId);
  for (const event of fixture.events) {
    assert.equal(event.eventType, 'social.follow-removed');
    assert.equal(event.eventVersion, 1);
    assert.equal(event.handlerMode, 'delivery_each_event');
    assert.deepEqual(event.payload, { actorProfileId: ACTOR, targetProfileId: TARGET });
  }
});

test('R5-06 no-op Unfollow does not invent outbox rows', async () => {
  const fixture = ports();
  await unfollowProfile(fixture.ports, input());
  assert.deepEqual(fixture.events, []);
});

test('R5-06 withdrawal route binds social.follow-removed to social_feed_withdrawal', () => {
  assert.equal(SOCIAL_FEED_WITHDRAWAL_HANDLER, 'social_feed_withdrawal');
  const routes = createSocialFeedWithdrawalWorkerRoutes({
    repository: {
      async project() {
        return { disposition: 'applied', withdrawnCount: 0 };
      },
    },
  });
  assert.equal(routes.length, 1);
  assert.deepEqual({
    handlerName: routes[0]!.handlerName,
    eventType: routes[0]!.eventType,
    eventVersion: routes[0]!.eventVersion,
    handlerMode: routes[0]!.handlerMode,
    sideEffectDurability: routes[0]!.sideEffectDurability,
  }, {
    handlerName: 'social_feed_withdrawal',
    eventType: 'social.follow-removed',
    eventVersion: 1,
    handlerMode: 'delivery_each_event',
    sideEffectDurability: 'durable',
  });
});

test('R5-06 Follow command still conceals missing targets without outbox writes', async () => {
  const events: FollowOutboxEvent[] = [];
  const missing: FollowCommandPorts = {
    receipts: {
      async claim() { return { kind: 'claimed' }; },
      async complete() {},
      async purgeExpired() { return 0; },
      async deletePrincipalReceipts() { return 0; },
    },
    profiles: { async lockEligiblePair() { return false; } },
    follows: {
      async save() { throw new Error('unreachable'); },
      async remove() { throw new Error('unreachable'); },
    },
    audit: { async append() { throw new Error('unreachable'); } },
    outbox: { async appendAll(batch) { events.push(...batch); } },
    clock: { async now() { return NOW; } },
    ids: { nextEventId() { return 'event'; }, nextOutboxId() { return 'outbox'; } },
  };
  await assert.rejects(() => unfollowProfile(missing, input()),
    (error: unknown) => error instanceof FollowCommandError && error.code === 'resource_not_found');
  assert.deepEqual(events, []);
});
