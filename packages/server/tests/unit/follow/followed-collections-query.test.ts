import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  FollowedCollectionsCursorError,
  createFollowedCollectionsCursorKeyring,
  queryFollowedCollections,
  type FollowedCollectionFact,
  type FollowedCollectionsReadInput,
  type FollowedCollectionsReadPort,
} from '../../../src/modules/social/index.js';

const NOW = new Date('2026-08-26T00:00:00.000Z');
const CURRENT = { id: 'followed-collections-current', secret: Buffer.alloc(32, 11).toString('base64') };
const OLD = { id: 'followed-collections-old', secret: Buffer.alloc(32, 12).toString('base64') };

function fact(collectionId: string, second: number): FollowedCollectionFact {
  return {
    collectionId,
    slug: `slug-${collectionId}`,
    title: `Title ${collectionId}`,
    summary: `Summary ${collectionId}`,
    kind: 'bookmarks',
    owner: {
      profileId: `owner-${collectionId}`,
      handle: `h_${collectionId}`,
      displayName: `Owner ${collectionId}`,
      avatarUrl: null,
    },
    updatedAt: new Date(NOW.getTime() - second * 500),
    followedAt: new Date(NOW.getTime() - second * 1000),
    availability: 'available',
  };
}

function unavailableFact(collectionId: string, second: number): FollowedCollectionFact {
  return { ...fact(collectionId, second), availability: 'unavailable', summary: null };
}

function fixturePort(rows: FollowedCollectionFact[]): FollowedCollectionsReadPort {
  return {
    async listFollowedCollections(input: FollowedCollectionsReadInput) {
      return rows.filter((row) => !input.after || row.followedAt < input.after.followedAt
        || (row.followedAt.getTime() === input.after.followedAt.getTime()
          && row.collectionId < input.after.collectionId)).slice(0, input.limit + 1);
    },
  };
}

function ports(
  rows: FollowedCollectionFact[],
  keyring = createFollowedCollectionsCursorKeyring({ active: CURRENT, retained: [] }),
  now = NOW,
) {
  return { reads: fixturePort(rows), cursors: keyring, clock: { now: async () => now } };
}

test('followed collections traverse the exclusive keyset without duplicate or omission', async () => {
  const rows = Array.from({ length: 207 }, (_, index) =>
    fact(String(207 - index).padStart(4, '0'), Math.floor(index / 3)));
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await queryFollowedCollections(ports(rows), {
      principalId: 'principal-a', limit: 17, ...(cursor ? { cursor } : {}),
    });
    seen.push(...page.items.map((item) => item.collectionId));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(seen.length, rows.length);
  assert.equal(new Set(seen).size, rows.length);
  assert.deepEqual(seen, rows.map((row) => row.collectionId));
});

test('unavailable collections keep their slot as grey tombstones instead of vanishing', async () => {
  const rows = [fact('c', 0), unavailableFact('gone', 1), fact('b', 2), fact('a', 3)];
  const shared = ports(rows);
  const first = await queryFollowedCollections(shared, { principalId: 'p', limit: 2 });
  const rest = await queryFollowedCollections(shared, { principalId: 'p', limit: 2, cursor: first.nextCursor! });
  assert.deepEqual(first.items.map((item) => item.collectionId), ['c', 'gone']);
  assert.deepEqual(first.items.map((item) => item.availability), ['available', 'unavailable']);
  assert.deepEqual(rest.items.map((item) => item.collectionId), ['b', 'a']);
  assert.equal(rest.nextCursor, null);
  assert.equal(JSON.stringify(first).includes('followerCount'), false);
  const tombstone = first.items[1]!;
  assert.equal(tombstone.summary, null);
  assert.equal(tombstone.title, 'Title gone');
  assert.equal(tombstone.slug, 'slug-gone');
});

test('an unavailable row leaking a summary is rejected fail-closed', async () => {
  const leaking = { ...unavailableFact('leak', 0), summary: 'written while private' };
  await assert.rejects(() => queryFollowedCollections(ports([leaking]), {
    principalId: 'p',
  }), /invalid Followed Collection projection/u);
});

test('a row without a lawful availability value is rejected', async () => {
  const wrong = { ...fact('w', 0), availability: 'shadowbanned' as FollowedCollectionFact['availability'] };
  await assert.rejects(() => queryFollowedCollections(ports([wrong]), {
    principalId: 'p',
  }), /invalid Followed Collection projection/u);
});

test('cursor rejects tamper, expiry, retired keys and a swapped principal', async () => {
  const rows = [fact('c', 0), fact('b', 1), fact('a', 2)];
  const oldKeys = createFollowedCollectionsCursorKeyring({ active: OLD, retained: [] });
  const first = await queryFollowedCollections(ports(rows, oldKeys), {
    principalId: 'p1', limit: 1,
  });
  const token = first.nextCursor!;
  const rotated = createFollowedCollectionsCursorKeyring({
    active: CURRENT,
    retained: [{
      ...OLD,
      lastIssuedAt: NOW.toISOString(),
      retainUntil: new Date(NOW.getTime() + 900_000).toISOString(),
    }],
  });
  const rotatedPage = await queryFollowedCollections(ports(rows, rotated), {
    principalId: 'p1', limit: 1, cursor: token,
  });
  assert.deepEqual(rotatedPage.items.map((item) => item.collectionId), ['b']);
  assert.match(rotatedPage.nextCursor!, /^sfcc1\.followed-collections-current\./u);
  const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
  for (const input of [
    { principalId: 'p1', limit: 1, cursor: tampered },
    { principalId: 'p2', limit: 1, cursor: token },
    { principalId: 'p1', limit: 2, cursor: token },
  ]) {
    await assert.rejects(() => queryFollowedCollections(ports(rows, rotated), input), FollowedCollectionsCursorError);
  }
  await assert.rejects(() => queryFollowedCollections(ports(rows, rotated, new Date(NOW.getTime() + 900_000)), {
    principalId: 'p1', limit: 1, cursor: token,
  }), FollowedCollectionsCursorError);
  const retired = createFollowedCollectionsCursorKeyring({ active: CURRENT, retained: [] });
  await assert.rejects(() => queryFollowedCollections(ports(rows, retired), {
    principalId: 'p1', limit: 1, cursor: token,
  }), FollowedCollectionsCursorError);
});

test('purpose is cryptographic and an empty list is a 200-shaped page', async () => {
  const keys = createFollowedCollectionsCursorKeyring({ active: CURRENT, retained: [] });
  const first = await queryFollowedCollections(ports([fact('b', 0), fact('a', 1)], keys), {
    principalId: 'p', limit: 1,
  });
  assert.equal(first.nextCursor!.includes('principalId'), false);
  assert.equal(first.nextCursor!.includes('"p"'), false);
  assert.throws(() => JSON.parse(Buffer.from(first.nextCursor!.split('.')[3]!, 'base64url').toString('utf8')));
  const empty = await queryFollowedCollections(ports([], keys), { principalId: 'p' });
  assert.deepEqual(empty, { items: [], nextCursor: null });
});

test('application rejects a limit above 50 and an unsafe owner projection', async () => {
  await assert.rejects(() => queryFollowedCollections(ports([fact('a', 0)]), {
    principalId: 'p', limit: 51,
  }), TypeError);
  const unsafe = fact('unsafe', 0);
  Object.assign(unsafe.owner, { avatarUrl: 'javascript:secret-marker' });
  await assert.rejects(() => queryFollowedCollections(ports([unsafe]), {
    principalId: 'p',
  }), /invalid Followed Collection projection/u);
});
