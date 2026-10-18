import { pullAckWarnings } from '../src/pull-item-set-aside.js';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { canonicalAuthoritativeEffectDigest, canonicalOperationDigest } from '@know-n/colp/sync';
import { MemoryStorageArea } from '../src/credential-store.js';
import { projectReplicaHealth, replicaIssuesFromPull, sendReplicaHealthReport } from '../src/sw/replica-health-report.js';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';
import { installKns05IndexedDb, scope, setup } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { freezeScopeRecovery } from '../src/pull-recovery-freeze.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { installOutboundPushIndexedDb, setup as pushSetup, scope as pushScope, json } from './outbound-push-worker-harness.js';

installKns05IndexedDb();
installOutboundPushIndexedDb();
const id = (n: number) => `node-created-${n}`;
const create = (n: number, parentId = 'root-colp', kind: 'Bookmark' | 'Folder' = 'Bookmark') =>
  pullFixtures.createEvent({ sequence: n, parentId, kind, collectionId: scope.collectionId });
function update(n: number, targetId: string, parentId: string, long = false, targetKind: 'bookmark' | 'folder' = 'bookmark') {
  const event: any = pullFixtures.mutationEvent({ sequence: n, kind: 'update', targetId, parentId, targetKind,
    collectionId: scope.collectionId });
  if (long) {
    event.effect.node.title = 'x'.repeat(300_000);
    event.operation.payload.value.title = event.effect.node.title;
    event.effect.operationDigest = canonicalOperationDigest(event.operation);
    event.effect.effectDigest = canonicalAuthoritativeEffectDigest(event.effect);
  }
  return event;
}
async function apply(f: Awaited<ReturnType<typeof setup>>, events: any[], cursor: string) {
  await f.applier.stage(f.page(events, cursor)); await f.applier.resume();
}

test('review: a missing anchor must not block unrelated events at staging', async () => {
  const f = await setup();
  try {
    await apply(f, [create(91), pullFixtures.createEvent({ sequence: 92, parentId: 'root-colp', kind: 'Bookmark',
      collectionId: scope.collectionId, afterId: 'missing-anchor' }), create(93)], 'cursor-1');
    assert.ok(await f.store.getMappingByColpId(scope, id(91)));
    assert.ok(await f.store.getMappingByColpId(scope, id(93)));
    assert.equal(await f.store.getMappingByColpId(scope, id(92)), null);
    assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-1');
    assert.deepEqual((await f.store.listPullIssues(scope)).map(row => [row.nodeId, row.code]), [[id(92), 'anchor_mapping_missing']]);
    const warnings = await pullAckWarnings(f.store, scope);
    assert.deepEqual(warnings.map(warning => warning.path), [`/nodes/${id(92)}`]);
  } finally { f.store.close(); }
});


test('an anchor created later in the page remains a rejected damaged ordering', async () => {
  const f = await setup();
  try {
    const before = pullFixtures.createEvent({ sequence: 91, parentId: 'root-colp', kind: 'Bookmark',
      collectionId: scope.collectionId, afterId: id(92) });
    await assert.rejects(f.applier.stage(f.page([before, create(92)], 'cursor-1')), /anchor_mapping_missing/);
    assert.equal(f.api.calls.length, 0);
    assert.equal((await f.store.listPullIssues(scope)).length, 0);
    assert.notEqual((await f.store.getCursor(scope))?.cursor, 'cursor-1');
  } finally { f.store.close(); }
});
