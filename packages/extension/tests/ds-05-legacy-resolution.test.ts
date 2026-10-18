import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { canonicalOperationDigest, canonicalAuthoritativeEffectDigest } from '@know-n/colp/sync';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { needsReplicaRebuild } from '../src/sync-failure-class.js';
import { seedMappedNode, setupT03, t03Scope } from './srg-t03-delete-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

test('DS-05 historical resolution collision preserves queued work and exposes rebuild', async () => {
  const f = await setupT03();
  await seedMappedNode(f, { nativeId: 'native-node', colpId: 'node-1', parentNativeId: 'native-root',
    parentColpId: 'root-colp', nodeKind: 'bookmark', title: 'Local title', url: 'https://example.test/' });
  const queue = createBookmarkEventQueue({ store: f.store, scope: t03Scope, autoFlush: false,
    api: { get: async id => (await f.api.get(id)).map(row => ({ ...row, title: row.title ?? '' })),
      getChildren: async id => (await f.api.getChildren(id)).map(row => ({ ...row, title: row.title ?? '' })) } });
  await queue.changed('native-node', { title: 'Local title' }); await queue.flush();
  const before = await f.store.listQueue(t03Scope);
  assert.equal(before.length, 1);
  const event = pullFixtures.mutationEvent({ kind: 'update', sequence: 1, collectionId: t03Scope.collectionId,
    targetId: 'node-1', parentId: 'root-colp', replicaId: t03Scope.replicaId });
  const operation = { ...event.operation, source: { adapterProfile: 'known-conflict-resolution' } };
  const effect = { ...event.effect, operationDigest: canonicalOperationDigest(operation), effectDigest: '' };
  effect.effectDigest = canonicalAuthoritativeEffectDigest(effect);
  await assert.rejects(f.applier.stage(f.page([{ ...event, operation, effect }])), /legacy_resolution_sequence_collision/);
  assert.deepEqual(await f.store.listQueue(t03Scope), before);
  assert.equal(f.api.getNode('native-node')?.title, 'Local title');
  const engine = await f.store.getEngineState(t03Scope);
  assert.equal(engine?.recoveryFrozen, true);
  assert.equal(needsReplicaRebuild(engine?.lastError), true);
});
