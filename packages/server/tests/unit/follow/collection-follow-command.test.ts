import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COLLECTION_FOLLOW_COMMAND_CONTRACT_VERSION,
  CollectionFollowCommandError,
  collectionFollowCommandFingerprint,
  followCollection,
  unfollowCollection,
  type CollectionFollowCommandInput,
  type CollectionFollowCommandPorts,
} from '../../../src/modules/social/index.js';

const ACTOR = 'profile-actor';
const SUBJECT = 'subject-actor';
const OWNER_SUBJECT = 'subject-owner';
const COLLECTION = 'collection-target';
const PRINCIPAL = ACTOR;
const COMMAND_ID = '019fa956-0c4e-4190-94df-484c41fd9683';
const NOW = new Date('2026-08-26T08:00:00.000Z');
const OWNER_MESSAGE = 'A Collection owner cannot follow their own collection.';

interface Effects {
  authority: number;
  audit: number;
  completed: number;
  lockFollowable: number;
}

function input(overrides: Partial<CollectionFollowCommandInput> = {}): CollectionFollowCommandInput {
  return {
    actor: { principalId: PRINCIPAL, profileId: ACTOR, subjectId: SUBJECT },
    collectionId: COLLECTION,
    commandId: COMMAND_ID,
    ...overrides,
  };
}

function ports(options: {
  claim?: Awaited<ReturnType<CollectionFollowCommandPorts['receipts']['claim']>>;
  target?: 'followable' | 'private' | 'protected' | 'soft-deleted' | 'missing';
  ownerSubjectId?: string;
  actorActive?: boolean;
  existingFollow?: boolean;
  followerCount?: number;
} = {}): { ports: CollectionFollowCommandPorts; effects: Effects } {
  const effects: Effects = { authority: 0, audit: 0, completed: 0, lockFollowable: 0 };
  let following = options.existingFollow ?? false;
  const ownerSubjectId = options.ownerSubjectId ?? OWNER_SUBJECT;
  return {
    effects,
    ports: {
      receipts: {
        async claim() { return options.claim ?? { kind: 'claimed' }; },
        async complete(_binding, _fingerprint, receipt) {
          effects.completed += 1;
          assert.equal(receipt.contractVersion, COLLECTION_FOLLOW_COMMAND_CONTRACT_VERSION);
          assert.equal(receipt.targetIdentity, COLLECTION);
        },
        async purgeExpired() { return 0; },
        async deletePrincipalReceipts() { return 0; },
      },
      actor: {
        async lockActiveProfile(binding) {
          return binding.actorProfileId === ACTOR
            && binding.actorPrincipalId === binding.actorProfileId
            && options.actorActive !== false;
        },
      },
      collection: {
        async lockFollowable(collectionId) {
          effects.lockFollowable += 1;
          if (collectionId !== COLLECTION) return { kind: 'not_found' };
          if (options.target === 'missing' || options.target === 'private'
            || options.target === 'protected' || options.target === 'soft-deleted') {
            return { kind: 'not_found' };
          }
          return { kind: 'followable', ownerSubjectId };
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
        async countFollowers() {
          return options.followerCount ?? (following ? 1 : 0);
        },
      },
      audit: { async append(event) {
        effects.audit += 1;
        assert.deepEqual(Object.keys(event).sort(), [
          'action', 'actorProfileId', 'changed', 'collectionId', 'createdAt', 'principalId',
        ]);
      } },
      clock: { async now() { return NOW; } },
    },
  };
}

test('first Follow persists authority, Audit and receipt without Outbox events', async () => {
  const fixture = ports({ followerCount: 1 });
  const result = await followCollection(fixture.ports, input());
  assert.deepEqual(result, {
    kind: 'succeeded',
    state: { following: true, followerCount: 1, followedAt: NOW },
  });
  assert.deepEqual(fixture.effects, { authority: 1, audit: 1, completed: 1, lockFollowable: 1 });
});

test('first Unfollow completes the receipt and reports the visible target count', async () => {
  const fixture = ports({ existingFollow: true, followerCount: 3 });
  const result = await unfollowCollection(fixture.ports, input());
  assert.equal(result.kind, 'succeeded');
  assert.equal(result.kind === 'succeeded' && result.state.following, false);
  assert.equal(result.kind === 'succeeded' && result.state.followerCount, 3);
  assert.equal(result.kind === 'succeeded' && result.state.followedAt, null);
  assert.deepEqual(fixture.effects, { authority: 1, audit: 1, completed: 1, lockFollowable: 1 });
});

test('exact replay returns the first immutable response without authority or Audit writes', async () => {
  const replay = {
    status: 200,
    body: Buffer.from('{"following":true,"followerCount":1,"followedAt":"2026-08-26T08:00:00.000Z"}'),
    stableHeaders: { 'cache-control': 'private, no-store', 'content-type': 'application/json' },
    mediaType: 'application/json',
    contractVersion: COLLECTION_FOLLOW_COMMAND_CONTRACT_VERSION,
    targetIdentity: COLLECTION,
  } as const;
  const fixture = ports({ claim: { kind: 'replay', result: replay } });
  assert.deepEqual(await followCollection(fixture.ports, input()), { kind: 'replay', ...replay });
  assert.deepEqual(fixture.effects, { authority: 0, audit: 0, completed: 0, lockFollowable: 0 });
});

test('fingerprint binds actor principal/profile, collection, action and contract version', () => {
  const base = input();
  const digest = collectionFollowCommandFingerprint('follow', base);
  assert.equal(digest, collectionFollowCommandFingerprint('follow', base));
  assert.notEqual(digest, collectionFollowCommandFingerprint('unfollow', base));
  assert.notEqual(digest, collectionFollowCommandFingerprint('follow', input({
    actor: { principalId: 'principal-other', profileId: ACTOR, subjectId: SUBJECT },
  })));
  assert.notEqual(digest, collectionFollowCommandFingerprint('follow', input({
    actor: { principalId: PRINCIPAL, profileId: 'profile-other', subjectId: SUBJECT },
  })));
  assert.notEqual(digest, collectionFollowCommandFingerprint('follow', input({
    collectionId: 'collection-other',
  })));
});

test('same command id with a different digest rejects before mutation', async () => {
  const reused = ports({ claim: { kind: 'reused' } });
  assert.deepEqual(await followCollection(reused.ports, input()), { kind: 'reused' });
  assert.deepEqual(reused.effects, { authority: 0, audit: 0, completed: 0, lockFollowable: 0 });
});

test('in_progress claim is returned without authority writes', async () => {
  const fixture = ports({ claim: { kind: 'in_progress', retryAfterSeconds: 1 } });
  assert.deepEqual(await followCollection(fixture.ports, input()), {
    kind: 'in_progress', retryAfterSeconds: 1,
  });
  assert.deepEqual(fixture.effects, { authority: 0, audit: 0, completed: 0, lockFollowable: 0 });
});

test('private, protected, soft-deleted and missing targets share resource_not_found', async () => {
  for (const target of ['private', 'protected', 'soft-deleted', 'missing'] as const) {
    const fixture = ports({ target });
    await assert.rejects(() => followCollection(fixture.ports, input()),
      (error: unknown) => error instanceof CollectionFollowCommandError
        && error.code === 'resource_not_found');
    assert.deepEqual(fixture.effects, { authority: 0, audit: 0, completed: 0, lockFollowable: 1 });
  }
});

test('owner self-follow is invalid_request with the locked message', async () => {
  const fixture = ports({ ownerSubjectId: SUBJECT });
  await assert.rejects(() => followCollection(fixture.ports, input()),
    (error: unknown) => error instanceof CollectionFollowCommandError
      && error.code === 'invalid_request'
      && error.message === OWNER_MESSAGE);
  assert.deepEqual(fixture.effects, { authority: 0, audit: 0, completed: 0, lockFollowable: 1 });
});

test('DELETE stays lenient but conceals the follower count of an invisible target', async () => {
  // followerCount 7 would be the live count; an invisible target must never
  // reveal it — DELETE otherwise bypasses the 404 concealment of PUT/GET.
  for (const target of ['private', 'protected', 'soft-deleted', 'missing'] as const) {
    const fixture = ports({ existingFollow: true, target, followerCount: 7 });
    const result = await unfollowCollection(fixture.ports, input());
    assert.equal(result.kind, 'succeeded', target);
    assert.equal(result.kind === 'succeeded' && result.state.following, false, target);
    assert.equal(result.kind === 'succeeded' && result.state.followerCount, 0, target);
    assert.deepEqual(fixture.effects, { authority: 1, audit: 1, completed: 1, lockFollowable: 1 }, target);
  }
});

test('no-op Follow/Unfollow completes its receipt without inventing a transition', async () => {
  const alreadyFollowing = ports({ existingFollow: true, followerCount: 1 });
  await followCollection(alreadyFollowing.ports, input());
  assert.deepEqual(alreadyFollowing.effects, { authority: 1, audit: 1, completed: 1, lockFollowable: 1 });

  const alreadyAbsent = ports({ followerCount: 0 });
  await unfollowCollection(alreadyAbsent.ports, input());
  assert.deepEqual(alreadyAbsent.effects, { authority: 1, audit: 1, completed: 1, lockFollowable: 1 });
});

test('inactive actor is concealed as resource_not_found', async () => {
  const fixture = ports({ actorActive: false });
  await assert.rejects(() => followCollection(fixture.ports, input()),
    (error: unknown) => error instanceof CollectionFollowCommandError
      && error.code === 'resource_not_found');
  assert.deepEqual(fixture.effects, { authority: 0, audit: 0, completed: 0, lockFollowable: 0 });
});
