import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  queryCollectionFollowState,
  type CollectionFollowStateReadPort,
  type CollectionFollowStateResult,
} from '../../../src/modules/social/index.js';

const ACTOR = 'profile-actor';
const SUBJECT = 'subject-actor';
const COLLECTION = 'collection-target';
const NOW = new Date('2026-08-26T08:00:00.000Z');
// Owner GET (following: false, followerCount still counted) is locked in
// tests/integration/follow/collection-follow-postgres.integration.test.ts.

function ports(read: CollectionFollowStateReadPort) {
  return { reads: read };
}

test('visible collection returns following, followerCount and followedAt', async () => {
  const state: CollectionFollowStateResult = {
    following: true, followerCount: 4, followedAt: NOW,
  };
  const page = await queryCollectionFollowState(ports({
    async readState(input) {
      assert.equal(input.actorProfileId, ACTOR);
      assert.equal(input.actorSubjectId, SUBJECT);
      assert.equal(input.collectionId, COLLECTION);
      return state;
    },
  }), { actorProfileId: ACTOR, actorSubjectId: SUBJECT, collectionId: COLLECTION });
  assert.deepEqual(page, state);
});

test('invisible targets return null so HTTP can conceal them as 404', async () => {
  const missing = await queryCollectionFollowState(ports({
    async readState() { return null; },
  }), { actorProfileId: ACTOR, actorSubjectId: SUBJECT, collectionId: COLLECTION });
  assert.equal(missing, null);
});

test('query rejects invalid identities', async () => {
  const reads: CollectionFollowStateReadPort = {
    async readState() { throw new Error('should not read'); },
  };
  await assert.rejects(() => queryCollectionFollowState({ reads }, {
    actorProfileId: '', actorSubjectId: SUBJECT, collectionId: COLLECTION,
  }), TypeError);
  await assert.rejects(() => queryCollectionFollowState({ reads }, {
    actorProfileId: ACTOR, actorSubjectId: '  padded  ', collectionId: COLLECTION,
  }), TypeError);
  await assert.rejects(() => queryCollectionFollowState({ reads }, {
    actorProfileId: ACTOR, actorSubjectId: SUBJECT, collectionId: 'bad/id',
  }), TypeError);
});
