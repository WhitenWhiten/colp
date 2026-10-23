import { pullAckWarnings } from '../src/pull-item-set-aside.js';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';

import { installKns05IndexedDb, scope, setup } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

import { installOutboundPushIndexedDb } from './outbound-push-worker-harness.js';

installKns05IndexedDb();
installOutboundPushIndexedDb();
const id = (n: number) => `node-created-${n}`;
const create = (n: number, parentId = 'root-colp', kind: 'Bookmark' | 'Folder' = 'Bookmark') =>
  pullFixtures.createEvent({ sequence: n, parentId, kind, collectionId: scope.collectionId });
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
