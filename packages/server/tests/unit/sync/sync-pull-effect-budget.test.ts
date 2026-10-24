import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';
import type { SyncPullEventV02 } from '@know-n/colp/types';
import { byteAwareEventCount } from '../../../src/infrastructure/sync/postgres/sync-pull-postgres.js';
import { resolveEffectAggregateBudget } from '../../../src/infrastructure/sync/sync-transport-budget.js';
import { SyncPullReadError } from '../../../src/modules/sync/index.js';

/**
 * B-15: a subtree deletion is delivered as a small Pull event plus effect pages (its member ids, 512 to a page) that the
 * client downloads against the session's effect budget. The page cut counted only the event, so several large deletions
 * landed on one page and a deletion above the operator-raised limit could never be downloaded: the replica froze.
 */
const BODY = 512 * 1024;
const EFFECT = 512 * 1024;

const deletion = (id: string, memberCount: number): SyncPullEventV02 => ({
  cursor: `cursor-${id}`, kind: 'operation',
  operation: { type: 'delete_subtree', opId: `op-${id}` },
  effect: { kind: 'subtree_deleted', effectId: `op-${id}`, memberCount,
    effectRef: { pageCount: Math.ceil(memberCount / 512), memberCount, memberDigest: 'd', firstPageDigest: 'd' } },
} as unknown as SyncPullEventV02);
const bookmark = (id: string): SyncPullEventV02 => ({
  cursor: `cursor-${id}`, kind: 'operation', operation: { type: 'create_node', opId: `op-${id}` },
  effect: { kind: 'node_created', effectId: `op-${id}` },
} as unknown as SyncPullEventV02);

describe('a Pull page and the effect pages that come with it', () => {
  test('without an effect budget the cut is the body budget alone, as before', () => {
    assert.equal(byteAwareEventCount([deletion('a', 10_000), deletion('b', 10_000), deletion('c', 10_000)], BODY), 3);
    assert.equal(byteAwareEventCount([bookmark('a'), bookmark('b')], BODY, EFFECT), 2);
  });

  test('a deletion of the default limit fits a page alone', () => {
    assert.equal(byteAwareEventCount([deletion('a', 10_000)], BODY, EFFECT), 1);
  });

  test('two large deletions do not share a page; what follows them waits too', () => {
    assert.equal(byteAwareEventCount([deletion('a', 10_000), deletion('b', 10_000)], BODY, EFFECT), 1);
    assert.equal(byteAwareEventCount([bookmark('x'), deletion('a', 6_000), deletion('b', 6_000), bookmark('y')], BODY, EFFECT), 2);
    assert.equal(byteAwareEventCount([deletion('a', 4_000), deletion('b', 4_000), bookmark('y')], BODY, EFFECT), 3);
  });

  test('a deletion that cannot fit even alone escalates like an oversized head event', () => {
    assert.throws(() => byteAwareEventCount([deletion('a', 20_000)], BODY, EFFECT),
      (error: unknown) => error instanceof SyncPullReadError && error.code === 'payload_too_large');
    // not at the head: the page ends before it, and it is the head of the next page
    assert.equal(byteAwareEventCount([bookmark('x'), deletion('a', 20_000)], BODY, EFFECT), 1);
  });

  test('a deletion with its members inline (no effect pages) is only its own bytes', () => {
    const small = { ...deletion('s', 3), effect: { kind: 'subtree_deleted', effectId: 'op-s', members: ['a', 'b', 'c'] } } as unknown as SyncPullEventV02;
    assert.equal(byteAwareEventCount([small, small, small], BODY, EFFECT), 3);
  });

  test('a larger session budget carries larger deletions and more of them', () => {
    assert.equal(byteAwareEventCount([deletion('a', 20_000)], BODY, 2 * 1024 * 1024), 1);
    assert.equal(byteAwareEventCount([deletion('a', 20_000), deletion('b', 20_000), deletion('c', 20_000)], BODY, 2 * 1024 * 1024), 2);
  });

  test('a budget that is not a positive integer is an integrity failure, not a silent no-op', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => byteAwareEventCount([bookmark('a')], BODY, bad),
        (error: unknown) => error instanceof SyncPullReadError && error.code === 'integrity_failure');
    }
  });
});

describe('the session budget the page is cut against', () => {
  test('is the negotiated effect aggregate bound to the session, legacy 2 MiB without one', () => {
    const bound = { transportBudget: { pullResponseBytes: BODY, snapshotPageBytes: BODY, effectPageBytes: 262_144,
      effectAggregateBytes: EFFECT } };
    assert.equal(resolveEffectAggregateBudget(bound), EFFECT);
    assert.equal(resolveEffectAggregateBudget({}), 2 * 1024 * 1024);
    assert.equal(resolveEffectAggregateBudget(undefined), 2 * 1024 * 1024);
    assert.equal(resolveEffectAggregateBudget({ transportBudget: { nonsense: true } }), 2 * 1024 * 1024);
  });

  test('the Postgres read port cuts against it', async () => {
    const source = await readFile(new URL('../../../src/infrastructure/sync/postgres/sync-pull-postgres.ts', import.meta.url), 'utf8');
    assert.match(source, /resolveEffectAggregateBudget\(sessionBinding\?\.binding_json\)/u);
    assert.match(source, /byteAwareEventCount\(candidateEvents, pullBudget, effectBudget\)/u);
  });
});
