import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  FollowCursorError,
  createFollowCursorKeyring,
  queryFollowRelations,
  type FollowPageReadInput,
  type FollowPageReadPort,
  type FollowProfileFact,
} from '../../../src/modules/social/index.js';

const NOW = new Date('2026-07-29T00:00:00.000Z');
const CURRENT = { id: 'social-current', secret: Buffer.alloc(32, 7).toString('base64') };
const OLD = { id: 'social-old', secret: Buffer.alloc(32, 8).toString('base64') };

function fact(profileId: string, second: number): FollowProfileFact {
  return { profile: { profileId, handle: `h_${profileId}`, displayName: `Name ${profileId}`, avatarUrl: null },
    followedAt: new Date(NOW.getTime() - second * 1000) };
}

function fixturePort(rows: FollowProfileFact[]): FollowPageReadPort {
  const read = async (input: FollowPageReadInput): Promise<readonly FollowProfileFact[] | null> => {
    if (input.targetProfileId === 'missing') return null;
    return rows.filter((row) => !input.after || row.followedAt < input.after.followedAt
      || (row.followedAt.getTime() === input.after.followedAt.getTime()
        && row.profile.profileId < input.after.profileId)).slice(0, input.limit + 1);
  };
  return { listFollowers: read, listFollowing: read };
}

function ports(rows: FollowProfileFact[], keyring = createFollowCursorKeyring({ active: CURRENT, retained: [] }), now = NOW) {
  return { reads: fixturePort(rows), cursors: keyring, clock: { now: async () => now } };
}

test('followers and following traverse the complete exclusive tuple in strict order', async () => {
  const rows = Array.from({ length: 207 }, (_, index) => fact(String(207 - index).padStart(4, '0'), Math.floor(index / 3)));
  for (const direction of ['followers', 'following'] as const) {
    const seen: FollowProfileFact[] = [];
    let cursor: string | undefined;
    do {
      const page = await queryFollowRelations(ports(rows), { principalId: 'principal-a', targetProfileId: 'target-a',
        direction, limit: 17, ...(cursor ? { cursor } : {}) });
      assert.ok(page);
      seen.push(...page.items.map((profile, index) => ({ profile,
        followedAt: rows.find((row) => row.profile.profileId === profile.profileId)!.followedAt })));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(seen.length, rows.length);
    assert.equal(new Set(seen.map((row) => row.profile.profileId)).size, rows.length);
    assert.deepEqual(seen.map((row) => row.profile.profileId), rows.map((row) => row.profile.profileId));
  }
});

test('live keyset pagination has defined insertion and deletion behavior', async () => {
  const rows = [fact('d', 0), fact('c', 1), fact('b', 2), fact('a', 3)];
  const shared = ports(rows);
  const first = await queryFollowRelations(shared, { principalId: 'p', targetProfileId: 't', direction: 'followers', limit: 2 });
  assert.ok(first);
  rows.unshift(fact('newer', -1));
  rows.splice(rows.findIndex((row) => row.profile.profileId === 'b'), 1);
  const final = await queryFollowRelations(shared, { principalId: 'p', targetProfileId: 't', direction: 'followers', limit: 2,
    cursor: first.nextCursor! });
  assert.ok(final);
  assert.deepEqual(first.items.map((row) => row.profileId), ['d', 'c']);
  assert.deepEqual(final.items.map((row) => row.profileId), ['a']);
});

test('cursor rejects tamper, expiry, retired keys and every scope replay', async () => {
  const rows = [fact('c', 0), fact('b', 1), fact('a', 2)];
  const oldKeys = createFollowCursorKeyring({ active: OLD, retained: [] });
  const first = await queryFollowRelations(ports(rows, oldKeys), { principalId: 'p1', targetProfileId: 't1',
    direction: 'followers', limit: 1, filter: '' });
  assert.ok(first);
  const token = first.nextCursor!;
  const rotated = createFollowCursorKeyring({ active: CURRENT, retained: [{ ...OLD,
    lastIssuedAt: NOW.toISOString(), retainUntil: new Date(NOW.getTime() + 900_000).toISOString() }] });
  const rotatedPage = await queryFollowRelations(ports(rows, rotated), { principalId: 'p1', targetProfileId: 't1',
    direction: 'followers', limit: 1, filter: '', cursor: token });
  assert.ok(rotatedPage);
  assert.deepEqual(rotatedPage.items.map((row) => row.profileId), ['b']);
  assert.match(rotatedPage.nextCursor!, /^sfc1\.social-current\./u);
  const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
  const invalid = [
    { principalId: 'p1', targetProfileId: 't1', direction: 'followers' as const, limit: 1, filter: '', cursor: tampered },
    { principalId: 'p2', targetProfileId: 't1', direction: 'followers' as const, limit: 1, filter: '', cursor: token },
    { principalId: 'p1', targetProfileId: 't2', direction: 'followers' as const, limit: 1, filter: '', cursor: token },
    { principalId: 'p1', targetProfileId: 't1', direction: 'following' as const, limit: 1, filter: '', cursor: token },
    { principalId: 'p1', targetProfileId: 't1', direction: 'followers' as const, limit: 2, filter: '', cursor: token },
    { principalId: 'p1', targetProfileId: 't1', direction: 'followers' as const, limit: 1, filter: 'x', cursor: token },
  ];
  for (const input of invalid) await assert.rejects(() => queryFollowRelations(ports(rows, rotated), input), FollowCursorError);
  const unknownKey = token.replace('.social-old.', '.unknown-key.');
  await assert.rejects(() => queryFollowRelations(ports(rows, rotated), { principalId: 'p1', targetProfileId: 't1',
    direction: 'followers', limit: 1, filter: '', cursor: unknownKey }), FollowCursorError);
  await assert.rejects(() => queryFollowRelations(ports(rows, rotated, new Date(NOW.getTime() + 900_000)),
    { principalId: 'p1', targetProfileId: 't1', direction: 'followers', limit: 1, filter: '', cursor: token }), FollowCursorError);
  const retired = createFollowCursorKeyring({ active: CURRENT, retained: [] });
  await assert.rejects(() => queryFollowRelations(ports(rows, retired), { principalId: 'p1', targetProfileId: 't1',
    direction: 'followers', limit: 1, filter: '', cursor: token }), FollowCursorError);
  const expiredRetention = createFollowCursorKeyring({ active: CURRENT, retained: [{ ...OLD,
    lastIssuedAt: new Date(NOW.getTime() - 1_800_000).toISOString(), retainUntil: new Date(NOW.getTime() - 900_000).toISOString() }] });
  await assert.rejects(() => queryFollowRelations(ports(rows, expiredRetention), { principalId: 'p1', targetProfileId: 't1',
    direction: 'followers', limit: 1, filter: '', cursor: token }), FollowCursorError);
});

test('purpose separation is cryptographic and target lifecycle absence is concealed', async () => {
  const keys = createFollowCursorKeyring({ active: CURRENT, retained: [] });
  const first = await queryFollowRelations(ports([fact('b', 0), fact('a', 1)], keys), { principalId: 'p', targetProfileId: 't',
    direction: 'followers', limit: 1 });
  assert.ok(first);
  assert.equal(first.nextCursor!.includes('principalId'), false);
  assert.equal(first.nextCursor!.includes('targetProfileId'), false);
  assert.equal(first.nextCursor!.includes('"p"'), false);
  assert.throws(() => JSON.parse(Buffer.from(first.nextCursor!.split('.')[3]!, 'base64url').toString('utf8')));
  assert.throws(() => keys.following.verify(first.nextCursor!, NOW), FollowCursorError);
  const missing = await queryFollowRelations(ports([], keys), { principalId: 'p', targetProfileId: 'missing', direction: 'followers' });
  assert.equal(missing, null);
});

test('application rejects a read port that bypasses the safe Profile projection', async () => {
  const source = fact('unsafe', 0);
  const unsafe: FollowProfileFact = { ...source,
    profile: { ...source.profile, avatarUrl: 'javascript:secret-marker' } };
  await assert.rejects(() => queryFollowRelations(ports([unsafe]), {
    principalId: 'p', targetProfileId: 't', direction: 'followers',
  }), /invalid Follow Profile projection/u);
});
