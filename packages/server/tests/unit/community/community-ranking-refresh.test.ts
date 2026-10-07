import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COMMUNITY_RANK_REFRESH_SECONDS,
  COMMUNITY_RANK_SNAPSHOT_RETENTION_MS,
  refreshCommunityRanking,
  type CommunityRankCandidate,
  type CommunityRankedWriteEntry,
  type CommunityRankingRefreshPorts,
} from '../../../src/modules/community/index.js';
import {
  COMMUNITY_STATIC_GENERATION,
  type CommunityTarget,
} from '../../../src/modules/community/index.js';
import { computeCommunityHotScore } from '../../../src/modules/community/community-hot-score.js';

const NOW = new Date('2026-10-02T00:00:00.000Z');

function target(kind: CommunityTarget['kind'], id: string): CommunityTarget {
  return { kind, id, collectionId: null, seriesId: null, generation: COMMUNITY_STATIC_GENERATION };
}

function candidate(id: string, kind: CommunityTarget['kind'], up: number, down: number,
  ageHours = 1): CommunityRankCandidate {
  return {
    target: target(kind, id),
    title: `Title ${id}`,
    href: `/${id}`,
    tags: ['design'],
    language: 'en',
    up,
    down,
    firstVoteAt: up + down > 0 ? new Date(NOW.getTime() - ageHours * 3_600_000) : null,
  };
}

function ports(input: {
  candidates: readonly CommunityRankCandidate[];
  written?: { entries?: readonly CommunityRankedWriteEntry[]; scoreVersion?: string; createdAt?: Date };
  prunedBefore?: { value?: Date };
}): CommunityRankingRefreshPorts {
  return {
    sources: { listCandidates: async () => input.candidates },
    snapshots: {
      writeSnapshot: async (write) => {
        if (input.written) {
          input.written.entries = write.entries;
          input.written.scoreVersion = write.scoreVersion;
          input.written.createdAt = write.createdAt;
        }
        return 'snap-1';
      },
      pruneSnapshots: async ({ createdBefore }) => {
        if (input.prunedBefore) input.prunedBefore.value = createdBefore;
        return 2;
      },
    },
    clock: { now: async () => NOW },
  };
}

test('refresh cadence and snapshot retention are contract-frozen', () => {
  assert.equal(COMMUNITY_RANK_REFRESH_SECONDS, 60);
  // Retention covers the whole 900s cursor TTL twice over.
  assert.equal(COMMUNITY_RANK_SNAPSHOT_RETENTION_MS, 1_800_000);
});

test('refresh scores with hot-v1, sorts hot DESC/kind ASC/id ASC and persists contiguously', async () => {
  const candidates = [
    candidate('cold', 'collection', 1, 9),
    candidate('hot-z', 'collection', 9, 1),
    candidate('hot-a', 'collection', 9, 1),
    candidate('hot-bookmark', 'bookmark', 9, 1),
    candidate('hot-edition', 'digest_edition', 9, 1),
    candidate('hot-series', 'digest_series', 9, 1),
    candidate('zero', 'digest_series', 0, 0),
  ];
  const written: { entries?: readonly CommunityRankedWriteEntry[]; scoreVersion?: string; createdAt?: Date } = {};
  const pruned: { value?: Date } = {};
  const result = await refreshCommunityRanking(ports({ candidates, written, prunedBefore: pruned }));

  assert.equal(result.scoreVersion, 'hot-v1');
  assert.equal(result.itemCount, 7);
  assert.equal(result.prunedSnapshots, 2);
  assert.equal(written.scoreVersion, 'hot-v1');
  assert.equal(written.createdAt?.toISOString(), NOW.toISOString());
  assert.equal(pruned.value?.getTime(), NOW.getTime() - COMMUNITY_RANK_SNAPSHOT_RETENTION_MS);

  const entries = written.entries!;
  // Equal hot ties break kind ASC — the contract's target_type ASC is
  // lexicographic (bookmark < collection < digest_edition < digest_series)
  // — then id ASC; the zero-vote row scores 0 and still outranks the
  // negative-score row.
  const expectedHot = computeCommunityHotScore({ up: 9, down: 1,
    firstVoteAt: new Date(NOW.getTime() - 3_600_000), now: NOW });
  assert.deepEqual(entries.map((row) => [row.position, row.target.id]), [
    [1, 'hot-bookmark'],
    [2, 'hot-a'],
    [3, 'hot-z'],
    [4, 'hot-edition'],
    [5, 'hot-series'],
    [6, 'zero'],
    [7, 'cold'],
  ]);
  assert.equal(entries[0]!.hot, expectedHot);
  assert.equal(entries[5]!.hot, 0);
  assert.equal(entries[5]!.firstVoteAt, null);
});

test('refresh derives entries verbatim from candidate rows (no rescore drift)', async () => {
  const written: { entries?: readonly CommunityRankedWriteEntry[] } = {};
  const row = candidate('only', 'digest_edition', 3, 0, 2);
  await refreshCommunityRanking(ports({ candidates: [row], written }));
  const [persisted] = written.entries!;
  assert.equal(persisted.position, 1);
  assert.equal(persisted.title, row.title);
  assert.equal(persisted.href, row.href);
  assert.deepEqual(persisted.tags, row.tags);
  assert.equal(persisted.language, 'en');
  assert.equal(persisted.up, 3);
  assert.equal(persisted.down, 0);
  assert.equal(persisted.hot, computeCommunityHotScore({
    up: 3, down: 0, firstVoteAt: row.firstVoteAt, now: NOW }));
});

test('a zero-vote target with a retained first-vote ledger row emits firstVoteAt=null', async () => {
  // After every vote is retracted the ledger row survives (the original age
  // anchor is kept for a later revote), but the contract forbids emitting a
  // firstVoteAt while no accepted vote remains.
  const written: { entries?: readonly CommunityRankedWriteEntry[] } = {};
  const stale = candidate('unvoted', 'collection', 0, 0);
  await refreshCommunityRanking(ports({
    candidates: [{ ...stale, firstVoteAt: new Date(NOW.getTime() - 3_600_000) }],
    written,
  }));
  const [persisted] = written.entries!;
  assert.equal(persisted.firstVoteAt, null);
  assert.equal(persisted.hot, 0);
});

test('an empty candidate set still writes a durable empty snapshot', async () => {
  const written: { entries?: readonly CommunityRankedWriteEntry[] } = {};
  const result = await refreshCommunityRanking(ports({ candidates: [], written }));
  assert.equal(result.itemCount, 0);
  assert.deepEqual(written.entries, []);
});
