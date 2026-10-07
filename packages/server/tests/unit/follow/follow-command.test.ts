import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  FOLLOW_COMMAND_CONTRACT_VERSION,
  FollowCommandError,
  followCommandFingerprint,
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

interface Effects {
  authority: number;
  audit: number;
  outbox: number;
  completed: number;
}

function input(overrides: Partial<FollowCommandInput> = {}): FollowCommandInput {
  return {
    actor: { principalId: PRINCIPAL, profileId: ACTOR },
    targetProfileId: TARGET,
    commandId: COMMAND_ID,
    ...overrides,
  };
}

function ports(options: {
  claim?: Awaited<ReturnType<FollowCommandPorts['receipts']['claim']>>;
  target?: 'active' | 'hidden' | 'missing';
  actorActive?: boolean;
  existingFollow?: boolean;
} = {}): { ports: FollowCommandPorts; effects: Effects; events: FollowOutboxEvent[] } {
  const effects: Effects = { authority: 0, audit: 0, outbox: 0, completed: 0 };
  const events: FollowOutboxEvent[] = [];
  let following = options.existingFollow ?? false;
  let eventSeq = 0;
  let outboxSeq = 0;
  return {
    effects,
    events,
    ports: {
      receipts: {
        async claim() { return options.claim ?? { kind: 'claimed' }; },
        async complete(_binding, _fingerprint, receipt) {
          effects.completed += 1;
          assert.equal(receipt.contractVersion, FOLLOW_COMMAND_CONTRACT_VERSION);
          assert.equal(receipt.targetIdentity, TARGET);
        },
        async purgeExpired() { return 0; },
        async deletePrincipalReceipts() { return 0; },
      },
      profiles: {
        async lockEligiblePair(binding) {
          return binding.actorProfileId === ACTOR
            && binding.actorPrincipalId === binding.actorProfileId
            && binding.targetProfileId === TARGET
            && options.actorActive !== false
            && options.target !== 'missing'
            && options.target !== 'hidden';
        },
      },
      follows: {
        async save(binding) {
          effects.authority += 1;
          if (following) return { follow: { ...binding, followedAt: NOW }, inserted: false };
          following = true;
          return { follow: { ...binding, followedAt: NOW }, inserted: true };
        },
        async remove() {
          effects.authority += 1;
          const changed = following;
          following = false;
          return changed;
        },
      },
      audit: { async append(event) {
        effects.audit += 1;
        assert.deepEqual(Object.keys(event).sort(), [
          'action', 'actorProfileId', 'changed', 'createdAt', 'principalId', 'targetProfileId',
        ]);
      } },
      outbox: { async appendAll(batch) {
        effects.outbox += batch.length;
        events.push(...batch);
        for (const event of batch) {
          assert.equal(event.eventVersion, 1);
          assert.equal(event.handlerMode, 'delivery_each_event');
          assert.deepEqual(event.payload, { actorProfileId: ACTOR, targetProfileId: TARGET });
        }
      } },
      clock: { async now() { return NOW; } },
      ids: {
        nextEventId() { eventSeq += 1; return `event-${eventSeq}`; },
        nextOutboxId() { outboxSeq += 1; return `outbox-${outboxSeq}`; },
      },
    },
  };
}

test('Follow first success persists authority, minimal Audit, notification+Feed events and receipt result', async () => {
  const fixture = ports();
  const result = await followProfile(fixture.ports, input());
  assert.deepEqual(result, {
    kind: 'succeeded',
    relation: { actorProfileId: ACTOR, targetProfileId: TARGET, following: true, changedAt: NOW },
  });
  assert.deepEqual(fixture.effects, { authority: 1, audit: 1, outbox: 2, completed: 1 });
  assert.deepEqual(
    fixture.events.map((event) => event.handlerName).sort(),
    ['social_feed_follow_activity', 'social_follow_activity'],
  );
  assert.equal(fixture.events[0]?.eventId, fixture.events[1]?.eventId);
  assert.notEqual(fixture.events[0]?.outboxId, fixture.events[1]?.outboxId);
  for (const event of fixture.events) {
    assert.equal(event.eventType, 'social.follow-created');
    assert.equal(event.eventVersion, 1);
    assert.equal(event.handlerMode, 'delivery_each_event');
    assert.deepEqual(event.payload, { actorProfileId: ACTOR, targetProfileId: TARGET });
  }
});

test('Unfollow first success emits follow-removed to notification and withdrawal outbox rows', async () => {
  const fixture = ports({ existingFollow: true });
  const result = await unfollowProfile(fixture.ports, input());
  assert.equal(result.kind, 'succeeded');
  assert.equal(result.kind === 'succeeded' && result.relation.following, false);
  assert.deepEqual(fixture.effects, { authority: 1, audit: 1, outbox: 2, completed: 1 });
  assert.deepEqual(
    fixture.events.map((event) => event.handlerName).sort(),
    ['social_feed_withdrawal', 'social_follow_activity'],
  );
  assert.equal(fixture.events[0]?.eventId, fixture.events[1]?.eventId);
  assert.notEqual(fixture.events[0]?.outboxId, fixture.events[1]?.outboxId);
});

test('exact replay returns the first immutable response without authority, Audit or Outbox writes', async () => {
  const replay = {
    status: 200,
    body: Buffer.from('{"actorProfileId":"profile-actor","targetProfileId":"profile-target","following":true,"changedAt":"2026-07-29T08:00:00.000Z"}'),
    stableHeaders: { 'cache-control': 'private, no-store', 'content-type': 'application/json' },
    mediaType: 'application/json',
    contractVersion: FOLLOW_COMMAND_CONTRACT_VERSION,
    targetIdentity: TARGET,
  } as const;
  const fixture = ports({ claim: { kind: 'replay', result: replay } });
  assert.deepEqual(await followProfile(fixture.ports, input()), { kind: 'replay', ...replay });
  assert.deepEqual(fixture.effects, { authority: 0, audit: 0, outbox: 0, completed: 0 });
});

test('fingerprint binds actor principal/profile, stable target, action and contract version', () => {
  const base = input();
  const digest = followCommandFingerprint('follow', base);
  assert.equal(digest, followCommandFingerprint('follow', base));
  assert.notEqual(digest, followCommandFingerprint('unfollow', base));
  assert.notEqual(digest, followCommandFingerprint('follow', input({
    actor: { principalId: 'principal-other', profileId: ACTOR },
  })));
  assert.notEqual(digest, followCommandFingerprint('follow', input({
    actor: { principalId: PRINCIPAL, profileId: 'profile-other' },
  })));
  assert.notEqual(digest, followCommandFingerprint('follow', input({ targetProfileId: 'profile-other' })));
});

test('same command id with a different digest rejects before mutation', async () => {
  const reused = ports({ claim: { kind: 'reused' } });
  assert.deepEqual(await followProfile(reused.ports, input()), { kind: 'reused' });
  assert.deepEqual(reused.effects, { authority: 0, audit: 0, outbox: 0, completed: 0 });
});

test('target missing/hidden and actor lifecycle failures share stable concealment without side effects', async () => {
  for (const fixture of [ports({ target: 'missing' }), ports({ target: 'hidden' }), ports({ actorActive: false })]) {
    await assert.rejects(() => followProfile(fixture.ports, input()),
      (error: unknown) => error instanceof FollowCommandError && error.code === 'resource_not_found');
    assert.deepEqual(fixture.effects, { authority: 0, audit: 0, outbox: 0, completed: 0 });
  }
});

test('no-op Follow/Unfollow completes its receipt but does not invent a transition event', async () => {
  const alreadyFollowing = ports({ existingFollow: true });
  await followProfile(alreadyFollowing.ports, input());
  assert.deepEqual(alreadyFollowing.effects, { authority: 1, audit: 1, outbox: 0, completed: 1 });

  const alreadyAbsent = ports();
  await unfollowProfile(alreadyAbsent.ports, input());
  assert.deepEqual(alreadyAbsent.effects, { authority: 1, audit: 1, outbox: 0, completed: 1 });
});
