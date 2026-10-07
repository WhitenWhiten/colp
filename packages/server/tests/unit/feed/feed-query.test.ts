import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  FeedCursorError,
  FollowCursorError,
  createFeedCursorKeyring,
  createFollowCursorKeyring,
  queryCurrentFeed,
  type FeedPageReadInput,
  type FeedPageReadPort,
  type FeedQueryFact,
} from '../../../src/modules/social/index.js';

const NOW = new Date('2026-07-29T12:00:00.000Z');
const CURRENT = { id: 'feed-current', secret: Buffer.alloc(32, 21).toString('base64') };
const OLD = { id: 'feed-old', secret: Buffer.alloc(32, 22).toString('base64') };

const FEED_ITEM_KEYS = ['actor', 'collectionId', 'collectionTitle', 'feedItemId', 'kind',
  'publicationSlug', 'publishedAt', 'summary'];

function fact(index: number, kind: FeedQueryFact['kind'] = 'collection_change'): FeedQueryFact {
  const value = String(index).padStart(4, '0');
  return {
    feedItemId: `item-${value}`,
    sourceEventId: `event-${value}`,
    kind,
    actor: { profileId: `actor-${value}`, handle: `actor_${value}`,
      displayName: `Actor ${value}`, avatarUrl: null },
    collectionId: `collection-${value}`,
    publishedAt: new Date(NOW.getTime() - index * 1000),
    collectionTitle: kind === 'collection_change' ? `Title ${value}` : null,
    publicationSlug: kind === 'collection_change' ? `title-${value}` : null,
    hiddenPublic: false,
    summary: null,
  };
}

function readPort(rows: FeedQueryFact[]): FeedPageReadPort {
  return { async loadPage(input: FeedPageReadInput) {
    return rows.filter((row) => (!input.kind || row.kind === input.kind)
      && (!input.after || row.publishedAt < input.after.publishedAt
        || (row.publishedAt.getTime() === input.after.publishedAt.getTime()
          && (row.sourceEventId < input.after.sourceEventId
            || (row.sourceEventId === input.after.sourceEventId
              && row.feedItemId < input.after.feedItemId)))))
      .slice(0, input.limit + 1);
  } };
}

function ports(rows: FeedQueryFact[], cursors = createFeedCursorKeyring({ active: CURRENT,
  retained: [] }), now = NOW) {
  return { reads: readPort(rows), cursors, clock: { now: async () => now } };
}

test('empty and full pages traverse the complete stable tuple without private fields', async () => {
  const empty = await queryCurrentFeed(ports([]), { principalId: 'principal', limit: 10 });
  assert.deepEqual(empty, { items: [], nextCursor: null });
  const rows = Array.from({ length: 207 }, (_, index) => fact(index));
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await queryCurrentFeed(ports(rows), { principalId: 'principal', limit: 17,
      ...(cursor ? { cursor } : {}) });
    seen.push(...page.items.map((item) => item.feedItemId));
    assert.deepEqual(Object.keys(page.items[0] ?? {}).sort(),
      page.items.length ? FEED_ITEM_KEYS : []);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(seen, rows.map((row) => row.feedItemId));
  assert.equal(new Set(seen).size, rows.length);
  assert.equal(JSON.stringify(seen).includes('secret'), false);
  const first = await queryCurrentFeed(ports(rows), { principalId: 'principal', limit: 1 });
  assert.equal(first.items[0]!.summary, 'public_collection_updated');
  assert.doesNotMatch(JSON.stringify(first.items), /"details"|nodeIds|https?:\/\//u);
});

test('normalizes kind filters and defines insertion/deletion behavior after a fence', async () => {
  const rows = [fact(0), fact(1, 'follow_activity'), fact(2), fact(3)];
  const shared = ports(rows);
  const first = await queryCurrentFeed(shared, { principalId: 'p', limit: 1,
    kind: '  COLLECTION_CHANGE  ' });
  rows.unshift(fact(-1));
  rows.splice(rows.findIndex((row) => row.feedItemId === 'item-0002'), 1);
  const final = await queryCurrentFeed(shared, { principalId: 'p', cursor: first.nextCursor!,
    kind: 'collection_change' });
  assert.deepEqual(first.items.map((row) => row.feedItemId), ['item-0000']);
  assert.deepEqual(final.items.map((row) => row.feedItemId), ['item-0003']);
  await assert.rejects(() => queryCurrentFeed(shared, { principalId: 'p', kind: 'private' }),
    /invalid Feed kind/u);
});

test('traverses equal timestamps by source event and feed item DESC tie-breaks', async () => {
  const tiedAt = new Date('2026-07-29T11:59:00.000Z');
  const rows = [
    { ...fact(0), sourceEventId: 'event-c', feedItemId: 'item-a', publishedAt: tiedAt },
    { ...fact(0), sourceEventId: 'event-b', feedItemId: 'item-c', publishedAt: tiedAt },
    { ...fact(0), sourceEventId: 'event-b', feedItemId: 'item-b', publishedAt: tiedAt },
  ];
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await queryCurrentFeed(ports(rows), { principalId: 'p', limit: 1,
      ...(cursor ? { cursor } : {}) });
    seen.push(...page.items.map((item) => item.feedItemId));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(seen, ['item-a', 'item-c', 'item-b']);
});

test('cursor enforces principal, filter, limit, purpose, expiry, tamper and key rotation', async () => {
  const rows = [fact(0), fact(1), fact(2)];
  const old = createFeedCursorKeyring({ active: OLD, retained: [] });
  const first = await queryCurrentFeed(ports(rows, old), { principalId: 'p1', limit: 1 });
  const token = first.nextCursor!;
  const repeated = await queryCurrentFeed(ports(rows, old), { principalId: 'p1', limit: 1 });
  assert.notEqual(repeated.nextCursor, token, 'identical payloads must use independent IVs');
  assert.match(token, /^sfeed1\.feed-old\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/u);
  const rotated = createFeedCursorKeyring({ active: CURRENT, retained: [{ ...OLD,
    lastIssuedAt: NOW.toISOString(), retainUntil: new Date(NOW.getTime() + 900_000).toISOString() }] });
  assert.deepEqual((await queryCurrentFeed(ports(rows, rotated), {
    principalId: 'p1', limit: 1, cursor: token })).items.map((item) => item.feedItemId), ['item-0001']);
  assert.deepEqual((await queryCurrentFeed(ports(rows, rotated), {
    principalId: 'p1', limit: 1, cursor: repeated.nextCursor! })).items.map((item) => item.feedItemId), ['item-0001']);
  assert.match((await queryCurrentFeed(ports(rows, rotated), {
    principalId: 'p1', limit: 1, cursor: token })).nextCursor!, /^sfeed1\.feed-current\./u);
  const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
  for (const input of [
    { principalId: 'p2', limit: 1, cursor: token },
    { principalId: 'p1', limit: 2, cursor: token },
    { principalId: 'p1', limit: 1, kind: 'collection_change', cursor: token },
    { principalId: 'p1', limit: 1, cursor: tampered },
  ]) await assert.rejects(() => queryCurrentFeed(ports(rows, rotated), input), FeedCursorError);
  await assert.rejects(() => queryCurrentFeed(ports(rows, rotated,
    new Date(NOW.getTime() + 900_000)), { principalId: 'p1', limit: 1, cursor: token }),
  FeedCursorError);
  const followKeys = createFollowCursorKeyring({ active: CURRENT, retained: [] });
  assert.throws(() => followKeys.followers.verify(token, NOW), FollowCursorError);
});

test('follow_activity facts without a Collection pass the safe projection contract', async () => {
  const rows = [{ ...fact(0, 'follow_activity'), collectionId: null }];
  const page = await queryCurrentFeed(ports(rows), { principalId: 'p', limit: 10,
    kind: 'follow_activity' });
  assert.equal(page.items.length, 1);
  assert.deepEqual(Object.keys(page.items[0]!).sort(), FEED_ITEM_KEYS);
  assert.equal(page.items[0]!.kind, 'follow_activity');
  assert.equal(page.items[0]!.collectionId, null);
  assert.equal(page.items[0]!.collectionTitle, null);
  assert.equal(page.items[0]!.publicationSlug, null);
  assert.equal(page.items[0]!.summary, 'new_follower');
  assert.equal(page.items[0]!.actor.profileId, 'actor-0000');
});

test('rejects follow_activity facts that carry collection locators', async () => {
  await assert.rejects(() => queryCurrentFeed(ports([{ ...fact(0, 'follow_activity'),
    collectionId: null, collectionTitle: 'should-not-come-from-follow' }]), { principalId: 'p' }),
    /invalid Feed safe projection/u);
  await assert.rejects(() => queryCurrentFeed(ports([{ ...fact(0, 'follow_activity'),
    collectionId: null, publicationSlug: 'should-not-come-from-follow' }]), { principalId: 'p' }),
    /invalid Feed safe projection/u);
});

test('rejects unsafe adapter facts and comparator violations without reflecting markers', async () => {
  const unsafe = { ...fact(0), actor: { ...fact(0).actor,
    avatarUrl: 'javascript:feed-query-secret-marker' } };
  await assert.rejects(() => queryCurrentFeed(ports([unsafe]), { principalId: 'p' }),
    /invalid Feed safe projection/u);
  await assert.rejects(() => queryCurrentFeed(ports([fact(1), fact(0)]), { principalId: 'p' }),
    /violated comparator/u);
});

test('emits closed summary tokens from kind and locator visibility', async () => {
  const change = await queryCurrentFeed(ports([fact(0)]), { principalId: 'p', limit: 10 });
  assert.equal(change.items[0]!.summary, 'public_collection_updated');
  const hidden = await queryCurrentFeed(ports([{
    ...fact(0), collectionTitle: null, publicationSlug: null,
  }]), { principalId: 'p', limit: 10 });
  assert.equal(hidden.items[0]!.summary, null);
  const follow = await queryCurrentFeed(ports([{ ...fact(0, 'follow_activity'), collectionId: null }]), {
    principalId: 'p', limit: 10, kind: 'follow_activity',
  });
  assert.equal(follow.items[0]!.summary, 'new_follower');
  assert.doesNotMatch(JSON.stringify([...change.items, ...hidden.items, ...follow.items]),
    /"details"|nodeIds|https?:\/\//u);
});

test('tombstones hide_public collection_change rows (#21)', async () => {
  const tombstoned = await queryCurrentFeed(ports([{ ...fact(0), hiddenPublic: true }]),
    { principalId: 'p', limit: 10 });
  assert.equal(tombstoned.items[0]!.hiddenPublic, true);
  assert.equal(tombstoned.items[0]!.collectionTitle, 'Collection hidden');
  assert.equal(tombstoned.items[0]!.publicationSlug, null);
  assert.equal(tombstoned.items[0]!.summary, null);
  assert.equal(tombstoned.items[0]!.actor.profileId, 'actor-0000');
  assert.deepEqual(Object.keys(tombstoned.items[0]!).sort(), [...FEED_ITEM_KEYS, 'hiddenPublic'].sort());
  const listed = await queryCurrentFeed(ports([fact(0)]), { principalId: 'p', limit: 10 });
  assert.equal(Object.hasOwn(listed.items[0]!, 'hiddenPublic'), false);
  assert.equal(listed.items[0]!.collectionTitle, 'Title 0000');
  assert.equal(listed.items[0]!.summary, 'public_collection_updated');
});
