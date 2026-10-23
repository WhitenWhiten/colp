import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { collectNativeOccupancy } from '../src/native-create-executor.js';
import { rejoinScopeMount } from '../src/scope-commands.js';
import { repairUnmountedRangeMappings } from '../src/unmounted-range-repair.js';
import { setupT03, mapping, t03Scope as scope } from './srg-t03-delete-harness.js';

test('permission loss postpones rejoin without reading or changing the native tree', async () => {
  const f = await setupT03();
  try {
    await f.store.detachMount(scope, 'mount-bar');
    await f.store.setBrowserRootStatus(scope, 'permission_required');
    const result = await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(['native-root']), [], {
      getNative: async () => { assert.fail('permission revoked'); },
      updateNative: async () => { assert.fail('permission revoked'); },
    });
    assert.equal(result.mount.status, 'detached');
    assert.equal(result.classification.verified[0]?.nativeId, 'native-root');
    const plan = await f.store.getScopeCommandPlan(scope, 'rejoin:mount-bar');
    assert.equal(plan?.phase, 'pending');
    assert.equal(plan?.retryReason, 'permission_required');
    assert.deepEqual(f.api.calls, []);
  } finally { f.store.close(); }
});

test('native occupancy protects local-only exclusions without replacing a live canonical owner', async () => {
  const f = await setupT03();
  try {
    for (const [nativeId, priorColpId] of [['kept', 'old-colp'], ['local', undefined],
      ['native-root', 'stale-owner'], ['recovery:virtual', 'virtual-owner']] as const) {
      await f.store.putLocalSyncExclusion(scope, { nativeId, decisionId: `keep:${nativeId}`,
        rootNativeId: 'native-root', generation: scope.generation, ...(priorColpId ? { priorColpId } : {}) });
    }
    const occupied = await collectNativeOccupancy(f.store, scope);
    assert.equal(occupied.get('kept'), 'old-colp');
    assert.equal(occupied.get('local'), 'exclusion:local');
    assert.equal(occupied.get('native-root'), 'root-colp');
    assert.equal(occupied.has('recovery:virtual'), false);
  } finally { f.store.close(); }
});

test('range repair reports unprovable native children while preserving excluded and mapped children', async () => {
  const f = await setupT03();
  try {
    f.api.seed({ id: 'unknown', parentId: 'native-root', title: 'Local copy' });
    f.api.seed({ id: 'kept', parentId: 'native-root', title: 'Kept copy' });
    await f.store.putLocalSyncExclusion(scope, { nativeId: 'kept', decisionId: 'keep',
      rootNativeId: 'native-root', generation: scope.generation });
    const result = await repairUnmountedRangeMappings(f.store, scope, f.api);
    assert.deepEqual(result, { filled: 0, attention: 1, needsSnapshot: false });
    assert.equal(f.api.getNode('unknown')?.title, 'Local copy');
    assert.equal(f.api.getNode('kept')?.title, 'Kept copy');
    const diagnostics = (await f.store.exportScope(scope)).diagnostics;
    assert.ok(diagnostics.some(row => row.code === 'unprovable_native' && row.nativeId === 'unknown'));
    assert.equal(f.api.calls.filter(row => row.kind === 'delete' || row.kind === 'create').length, 0);
  } finally { f.store.close(); }
});

test('range repair defers orphaned and content-free virtual rows without guessing native identities', async () => {
  const f = await setupT03();
  try {
    await f.store.putMapping(scope, mapping('unmounted:orphan', 'orphan', { parentColpId: 'missing' }));
    await f.store.putMapping(scope, { ...mapping('unmounted:empty', 'empty', { parentColpId: 'root-colp' }),
      projection: { revision: 'r1', digest: 'empty' } });
    const result = await repairUnmountedRangeMappings(f.store, scope, f.api);
    assert.deepEqual(result, { filled: 0, attention: 1, needsSnapshot: true });
    assert.equal(f.api.calls.filter(row => row.kind === 'create').length, 0);
  } finally { f.store.close(); }
});
