/**
 * performance-08: an idle sync pass must not redo whole-library work.
 *
 * The durable engine checks for leftover local projection several times per
 * wake. Only a `recovery:` mapping or a live projection intent can need that
 * work, so a quiet wake answers from index probes instead of reading, cloning
 * and graph-walking every mapping and scanning every issue store. The worker
 * pass likewise skips the whole-tree metadata reconcile on an alarm that moved
 * no cursor, and still refreshes remote-only notes on a bounded interval.
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { ack, emptyPullPage, json, scope, setup } from './durable-sync-engine-harness.js';
import { METADATA_QUIET_REFRESH_MS, metadataPassDue, recordMetadataPass } from '../src/sw/metadata-pass.js';
import type { createSyncStateStore } from '../src/sync-state-store.js';

type Store = ReturnType<typeof createSyncStateStore>;

function countingStore(calls: Map<string, number>, counting: () => boolean) {
  return (store: Store) => Object.fromEntries(Object.entries(store).map(([key, value]) =>
    [key, typeof value !== 'function' ? value : (...args: unknown[]) => {
      if (counting()) calls.set(key, (calls.get(key) ?? 0) + 1);
      return (value as (...input: unknown[]) => unknown).apply(store, args);
    }])) as Store;
}

async function idleFixture(extraMappings: number) {
  const calls = new Map<string, number>(); let counting = false;
  const fixture = await setup({ instrumentStore: countingStore(calls, () => counting) });
  for (let index = 0; index < extraMappings; index += 1) {
    await fixture.store.putMapping(scope, { nativeId: `native-${index}`, colpId: `node-${index}`,
      parentColpId: 'root-old', parentNativeId: 'native-root', rootNativeId: 'native-root', nodeKind: 'bookmark',
      projection: { revision: 'revision-0', digest: `sha256:node-${index}`,
        content: { title: `Bookmark ${index}`, url: `https://example.test/${index}` } } });
  }
  fixture.pullResponses.push(json(200, emptyPullPage('cursor-1'))); fixture.ackResponses.push(json(200, ack('cursor-1')));
  await fixture.engine.wake('manual');
  assert.equal((await fixture.store.getEngineState(scope))?.lastAckedCursor, 'cursor-1');
  return { fixture, calls, async idleWake() {
    fixture.clock.now += 31_000; calls.clear();
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-1')));
    counting = true;
    try { await fixture.engine.wake('alarm'); } finally { counting = false; }
  } };
}

describe('an idle durable engine wake stays off whole-library reads', () => {
  test('a quiet alarm wake pulls without reading every mapping', async () => {
    const { fixture, calls, idleWake } = await idleFixture(500);
    await idleWake();
    assert.deepEqual(fixture.order.slice(-4), ['resume', 'pull:cursor-1', 'stage:cursor-1', 'resume']);
    assert.equal((await fixture.store.getEngineState(scope))?.phase, 'sleeping');
    assert.equal(calls.get('listMappings') ?? 0, 0, 'no leftover-projection check may read the whole library');
    assert.equal(calls.get('exportScope') ?? 0, 0);
    // The issue-ceiling gates still run; the projection checks no longer add their own scans.
    assert.ok((calls.get('listLocalIssues') ?? 0) <= 4, `issue scans: ${calls.get('listLocalIssues')}`);
    assert.ok((calls.get('hasMappingNativePrefix') ?? 0) >= 1);
  });

  test('a leftover recovery mapping still makes the wake read the library and project it', async () => {
    const { fixture, calls, idleWake } = await idleFixture(20);
    await fixture.store.putMapping(scope, { nativeId: 'recovery:child', colpId: 'child-remote', parentColpId: 'root-old',
      rootNativeId: 'native-root', nodeKind: 'bookmark',
      projection: { revision: 'revision-0', digest: 'sha256:child-remote',
        content: { title: 'Remote child', url: 'https://example.test/remote' } } });
    assert.equal(await fixture.store.hasMappingNativePrefix(scope, 'recovery:'), true);
    assert.equal(await fixture.store.hasMappingNativePrefix(scope, 'unmounted:'), false);
    await idleWake();
    assert.ok((calls.get('listMappings') ?? 0) >= 1, 'a projectable mapping keeps the full projection path');
  });
});

describe('the worker metadata reconcile is due only when something can have changed', () => {
  const area = new Map<string, unknown>();
  beforeEach(() => {
    area.clear();
    vi.stubGlobal('chrome', { storage: { session: {
      get: async (key: string) => (area.has(key) ? { [key]: area.get(key) } : {}),
      set: async (items: Record<string, unknown>) => { for (const [key, value] of Object.entries(items)) area.set(key, value); },
    } } });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  test('an alarm pass at the reconciled cursor skips until the quiet refresh is due', async () => {
    const now = 1_000_000;
    assert.equal(await metadataPassDue(scope, 'alarm', 'cursor-1', now), true, 'never reconciled');
    await recordMetadataPass(scope, 'cursor-1', now);
    assert.equal(await metadataPassDue(scope, 'alarm', 'cursor-1', now + 30_000), false);
    assert.equal(await metadataPassDue(scope, 'alarm', 'cursor-1', now + METADATA_QUIET_REFRESH_MS - 1), false);
    assert.equal(await metadataPassDue(scope, 'alarm', 'cursor-1', now + METADATA_QUIET_REFRESH_MS), true,
      'remote notes travel outside the cursor');
    assert.equal(await metadataPassDue(scope, 'alarm', 'cursor-1', now - 1), true, 'a clock rollback never extends a skip');
  });

  test('local edits, start-up, reconnects and new remote facts always reconcile', async () => {
    const now = 2_000_000;
    await recordMetadataPass(scope, 'cursor-1', now);
    for (const reason of ['manual', 'startup', 'online']) {
      assert.equal(await metadataPassDue(scope, reason, 'cursor-1', now + 1), true, reason);
    }
    assert.equal(await metadataPassDue(scope, 'alarm', 'cursor-2', now + 1), true, 'a new acknowledged cursor');
    assert.equal(await metadataPassDue(scope, 'alarm', undefined, now + 1), true, 'no acknowledged cursor yet');
    assert.equal(await metadataPassDue({ ...scope, replicaId: 'replica-other' }, 'alarm', 'cursor-1', now + 1), true);
  });

  test('unreadable session storage reconciles rather than skipping', async () => {
    vi.stubGlobal('chrome', { storage: { session: { get: async () => { throw new Error('storage_unavailable'); },
      set: async () => { throw new Error('storage_unavailable'); } } } });
    await recordMetadataPass(scope, 'cursor-1', 1);
    assert.equal(await metadataPassDue(scope, 'alarm', 'cursor-1', 2), true);
  });
});
