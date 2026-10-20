import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test, vi } from 'vitest';
import { detachScopeMount, rejoinScopeMount } from '../src/scope-commands.js';
import { queueRejoinOperation } from '../src/scope-rejoin-queue.js';
import { rejoinFixture } from './rejoin-recovery-harness.js';
import { installKns05IndexedDb, scope } from './kns-05-pull-harness.js';

installKns05IndexedDb();

async function folderFixture(depth = 2, width = 2) {
  const f = await rejoinFixture();
  const folders = Array.from({ length: depth }, (_, index) => `a-folder-${String(index).padStart(3, '0')}`);
  const bookmarks = ['native-node', 'native-child', ...Array.from({ length: width - 2 }, (_, index) => `native-extra-${index}`)];
  const family = [...folders, ...bookmarks];
  for (const [index, nativeId] of folders.entries()) {
    const parentNativeId = folders[index - 1] ?? 'native-root';
    const parentColpId = index ? `folder-${index - 1}` : 'root-colp';
    f.api.seed({ id: nativeId, parentId: parentNativeId, title: `Folder ${index}`, index: 0 });
    await f.store.putMapping(scope, { nativeId, colpId: `folder-${index}`, rootNativeId: 'native-root',
      parentNativeId, parentColpId, nodeKind: 'folder',
      projection: { revision: `folder-r${index}`, childrenRevision: `folder-c${index}`, digest: `folder-${index}`,
        content: { title: `Folder ${index}` },
        childrenOrder: folders[index + 1] ? [folders[index + 1]!] : bookmarks } });
  }
  for (const [index, nativeId] of ['native-node', 'native-child'].entries()) {
    await f.api.move(nativeId, { parentId: folders.at(-1)!, index });
    const { scopeKey: _key, ...mapping } = (await f.store.getMappingByNativeId(scope, nativeId))!;
    await f.store.putMapping(scope, { ...mapping, parentNativeId: folders.at(-1)!, parentColpId: `folder-${depth - 1}` });
  }
  for (const [offset, nativeId] of bookmarks.slice(2).entries()) {
    const content = { title: nativeId, url: `https://wide.test/${offset}` };
    f.api.seed({ id: nativeId, parentId: folders.at(-1)!, index: offset + 2, ...content });
    await f.store.putMapping(scope, { nativeId, colpId: `extra-colp-${offset}`, rootNativeId: 'native-root',
      parentNativeId: folders.at(-1)!, parentColpId: `folder-${depth - 1}`, nodeKind: 'bookmark',
      projection: { revision: `extra-r-${offset}`, digest: `extra-${offset}`, content } });
  }
  f.api.seed({ id: 'z-outside', parentId: 'native-root', title: 'Unrelated bookmark', url: 'https://outside.test/', index: 1 });
  await f.store.putMapping(scope, { nativeId: 'z-outside', colpId: 'outside-colp', rootNativeId: 'native-root',
    parentNativeId: 'native-root', parentColpId: 'root-colp', nodeKind: 'bookmark', projection: {
      revision: 'outside-r1', digest: 'outside', content: { title: 'Unrelated bookmark', url: 'https://outside.test/' } } });
  const { scopeKey: _key, ...root } = (await f.store.getMappingByNativeId(scope, 'native-root'))!;
  await f.store.putMapping(scope, { ...root, projection: { ...root.projection, childrenOrder: [folders[0]!, 'z-outside'] } });
  await detachScopeMount(f.store, scope, 'mount-bar');
  const mount = (await f.store.getMountBinding(scope, 'mount-bar'))!;
  // Pull records a tombstone for every member, including deep descendants.
  for (const nativeId of family) {
    const mapping = (await f.store.getMappingByNativeId(scope, nativeId))!;
    await f.store.putRemoteObservation(scope, { colpId: mapping.colpId, remoteRevision: 'family-deleted', kind: 'tombstone',
      cursor: 'deleted-cursor', payload: { deleted: true }, observedAt: 1, sourceDigest: 'sha256:folder-delete',
      pauseGeneration: scope.generation, pauseBoundaryVersion: mount.pauseBaseline!.boundaryVersion,
      pauseCursor: mount.pauseBaseline!.lastAppliedCursor });
  }
  f.api.reads.length = 0; f.api.calls.length = 0;
  return { ...f, folders, family };
}

test.each(['new_child', 'new_grandchild', 'edited_grandchild', 'moved_grandchild', 'mapping',
  'queued_metadata', 'capture', 'inflight_capture', 'exclusion', 'policy', 'attempt', 'clear'] as const)
('an ancestor deletion cannot erase a %s change during its last native reads', async changed => {
  const f = await folderFixture();
  try {
    let injected = false, removes = 0, addedId: string | undefined;
    await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], { ...f.native,
      getNative: async id => {
        if (!injected && id === f.folders[0] && (await f.store.listApplyIntents(scope))
          .some(intent => intent.nativeTargetId === f.folders[0] && intent.state === 'browser_call_started')) {
          injected = true;
          if (changed === 'new_child' || changed === 'new_grandchild') addedId = (await f.api.create({
            parentId: changed === 'new_child' ? f.folders[0] : f.folders.at(-1), title: 'Local-only new child',
            url: 'https://local-only.example/new' })).id;
          else if (changed === 'edited_grandchild' || changed === 'capture') {
            await f.api.update('native-child', { title: 'Newest descendant edit' });
            if (changed === 'capture') {
              // Paused capture is filtered; the native preimage still protects this edit.
              assert.equal((await f.queue.changed('native-child', { title: 'Newest descendant edit' })).outcome, 'filtered');
            }
          } else if (changed === 'moved_grandchild') await f.api.move('native-child', { parentId: 'native-root', index: 2 });
          else if (changed === 'mapping') await f.store.deleteMapping(scope, 'native-child');
          else if (changed === 'queued_metadata') {
            const mapping = (await f.store.getMappingByNativeId(scope, 'native-child'))!;
            await queueRejoinOperation(f.store, scope, mapping, mapping.projection.revision, 'update_node_content', {
              base: { description: null }, value: { description: 'Later independent metadata intent' } });
          } else if (changed === 'inflight_capture') {
            // An already admitted callback can reach the durable inbox after
            // the native item has returned to its comparison state.
            await f.api.update('native-child', { title: 'In-flight user edit' });
            await f.api.update('native-child', { title: 'node-child' });
            await f.store.stageBookmarkEvent(scope, { eventId: 'inflight-event', dedupeKey: 'inflight-event',
              kind: 'change', nativeId: 'native-child', occurredAt: new Date().toISOString(),
              details: { title: 'In-flight user edit' } });
          } else if (changed === 'exclusion') await f.store.putLocalSyncExclusion(scope, {
            nativeId: 'native-child', decisionId: 'new-choice', generation: scope.generation,
            rootNativeId: 'native-root', priorColpId: 'node-child' });
          else if (changed === 'policy') await f.store.setRemoteDeletePolicy(scope, { policy: 'confirm', expectedCasVersion: 0, now: Date.now() });
          else if (changed === 'attempt') {
            const { scopeKey: _key, ...mount } = (await f.store.getMountBinding(scope, 'mount-bar'))!;
            await f.store.putMountBinding(scope, { ...mount, pauseBaseline: { ...mount.pauseBaseline!, lastAppliedCursor: 'later-pause' } });
          } else await f.store.retireScope(scope, { retiredAt: 100, reason: 'user_clear' });
        }
        return f.native.getNative(id);
      }, removeNative: async (id, tree) => { removes++; return tree ? f.api.removeTree(id) : f.api.remove(id); },
    }).catch(error => assert.match(String(error), /rejoin_boundary_changed|scope_not_found/));
    assert.equal(injected, true); assert.equal(removes, 0, 'compare the whole authorized subtree before any member deletion');
    assert.ok(f.api.getNode('native-child')); assert.ok(f.api.getNode(f.folders[0]!));
    if (addedId) assert.equal(f.api.getNode(addedId)?.title, 'Local-only new child');
    if (changed === 'edited_grandchild' || changed === 'capture') assert.equal(f.api.getNode('native-child')?.title, 'Newest descendant edit');
    if (changed === 'moved_grandchild') assert.equal(f.api.getNode('native-child')?.parentId, 'native-root');
    if (changed === 'clear') assert.equal(await f.store.getScope(scope), null);
    else {
      assert.ok(await f.store.getMappingByNativeId(scope, f.folders[0]!));
      if (changed === 'mapping') assert.equal(await f.store.getMappingByNativeId(scope, 'native-child'), null);
      assert.equal((await f.store.getMountBinding(scope, 'mount-bar'))?.status, 'detached');
      if (changed === 'inflight_capture') {
        const [event] = await f.store.listBookmarkEvents(scope); assert.equal(event?.status, 'pending');
        assert.equal(event?.details.title, 'In-flight user edit');
      }
      if (changed === 'queued_metadata') {
        const rows = await f.store.listQueue(scope); assert.equal(rows.length, 1); assert.equal(rows[0]!.status, 'pending');
        assert.equal(await f.store.getQueueReceipt(scope, rows[0]!.sequence), null);
      }
    }
  } finally { f.store.close(); }
});

test.each([2, 160])('a stable %i-level family deletes exact members with linear child scans and current ancestry checks', async depth => {
  const f = await folderFixture(depth);
  try {
    const result = await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], { ...f.native,
      removeNative: async (id, tree) => { assert.equal(tree, false); return f.api.remove(id); },
    });
    assert.equal(result.mount.status, 'active');
    assert.deepEqual(f.api.calls.filter(row => row.kind === 'delete'),
      [...f.family].reverse().map(nativeId => ({ kind: 'delete', nativeId })));
    for (const id of f.family) {
      assert.equal(f.api.getNode(id), undefined); assert.equal(await f.store.getMappingByNativeId(scope, id), null);
    }
    assert.ok(f.api.getNode('z-outside')); assert.ok(f.api.getNode('native-root'));
    assert.equal((await f.store.getMountBinding(scope, 'mount-bar'))?.status, 'active');
    assert.equal((await f.store.listRemoteObservations(scope)).length, 0);
    assert.equal((await f.store.listQueue(scope)).length, 0);
    // Every destructive call must re-read current native ancestry. Account for
    // that O(ND) permission cost separately from the linear subtree comparisons.
    const ancestryReads = (depth + 1) * (depth + 2) / 2 + 2 * (depth + 2);
    assert.ok(f.api.reads.filter(row => row.kind === 'get').length <= ancestryReads + 10 * f.family.length + 40);
    assert.ok(f.api.reads.filter(row => row.kind === 'getChildren').length <= 5 * f.family.length + 10);
  } finally { f.store.close(); }
});

test('unrelated new queued work survives an authorized family deletion with its original unacknowledged bytes', async () => {
  const f = await folderFixture();
  try {
    let authored: Awaited<ReturnType<typeof f.store.listQueue>> = [], injected = false;
    const result = await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], { ...f.native,
      getNative: async id => {
        if (!injected && id === f.folders[0] && (await f.store.listApplyIntents(scope)).length) {
          injected = true;
          const mapping = (await f.store.getMappingByNativeId(scope, 'z-outside'))!;
          await queueRejoinOperation(f.store, scope, mapping, mapping.projection.revision, 'update_node_content', {
            base: { description: null }, value: { description: 'Unrelated new intent' } });
          authored = await f.store.listQueue(scope);
        }
        return f.native.getNative(id);
      },
    });
    assert.equal(result.mount.status, 'active'); assert.equal(injected, true);
    assert.equal(f.api.getNode(f.folders[0]!), undefined); assert.ok(f.api.getNode('z-outside'));
    assert.deepEqual(await f.store.listQueue(scope), authored);
    assert.equal(authored.length, 1); assert.equal(authored[0]!.status, 'pending');
    assert.equal(await f.store.getQueueReceipt(scope, authored[0]!.sequence), null);
  } finally { f.store.close(); }
});

test.each(['mapping', 'exclusion', 'queued_metadata', 'attempt'] as const)
('the last descendant read cannot authorize deletion after a newer %s', async changed => {
  const f = await folderFixture();
  try {
    let checks = 0, injected = false, removes = 0;
    await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], { ...f.native,
      getNative: async id => {
        if (id === 'native-child' && (await f.store.listApplyIntents(scope))
          .some(intent => intent.nativeTargetId === f.folders[0] && intent.state === 'browser_call_started') && ++checks === 2) {
          injected = true;
          if (changed === 'mapping') await f.store.deleteMapping(scope, id);
          else if (changed === 'exclusion') await f.store.putLocalSyncExclusion(scope, { nativeId: id,
            decisionId: 'last-read-choice', generation: scope.generation, rootNativeId: 'native-root', priorColpId: 'node-child' });
          else if (changed === 'queued_metadata') {
            const mapping = (await f.store.getMappingByNativeId(scope, id))!;
            await queueRejoinOperation(f.store, scope, mapping, mapping.projection.revision, 'update_node_content', {
              base: { description: null }, value: { description: 'Last-read new intent' } });
          } else {
            const { scopeKey: _key, ...mount } = (await f.store.getMountBinding(scope, 'mount-bar'))!;
            await f.store.putMountBinding(scope, { ...mount, pauseBaseline: { ...mount.pauseBaseline!, lastAppliedCursor: 'last-read-pause' } });
          }
        }
        return f.native.getNative(id);
      }, removeNative: async (id, tree) => { removes++; return f.native.removeNative!(id, tree); },
    });
    assert.equal(injected, true); assert.equal(removes, 0); assert.ok(f.api.getNode('native-child'));
    assert.equal((await f.store.getMountBinding(scope, 'mount-bar'))?.status, 'detached');
  } finally { f.store.close(); }
});

test('without a complete native child listing a folder remains local and unresolved', async () => {
  const f = await folderFixture();
  try {
    const { getChildren: _children, ...native } = f.native;
    const result = await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], native);
    assert.equal(result.mount.status, 'detached');
    assert.ok(f.api.getNode(f.folders[0]!));
    assert.ok(!f.api.calls.some(row => row.kind === 'delete' && f.folders.includes(row.nativeId!)));
    assert.equal((await f.store.getScopeCommandPlan(scope, 'rejoin:mount-bar'))?.phase, 'pending');
  } finally { f.store.close(); }
});

test.each([{ depth: 2, after: 1 }, { depth: 2, after: 4 }, { depth: 160, after: 41 }])
('restart after native delete $after of a $depth-level family resumes only the remaining identities', async ({ depth, after }) => {
  const f = await folderFixture(depth);
  try {
    let calls = 0;
    await assert.rejects(rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], { ...f.native,
      removeNative: async (id, tree) => {
        assert.equal(tree, false); await f.api.remove(id);
        if (++calls === after) throw new Error('worker_crash');
      },
    }), /worker_crash/);
    const removed = [...f.family].reverse().slice(0, after);
    for (const id of removed) assert.equal(f.api.getNode(id), undefined);
    assert.ok(await f.store.getMappingByNativeId(scope, removed.at(-1)!));
    assert.equal((await f.store.getMountBinding(scope, 'mount-bar'))?.status, 'detached');
    f.store.close();
    const resumed = await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], f.native);
    assert.equal(resumed.mount.status, 'active');
    assert.deepEqual(f.api.calls.filter(row => row.kind === 'delete'),
      [...f.family].reverse().map(nativeId => ({ kind: 'delete', nativeId })));
    for (const nativeId of f.family) assert.equal(await f.store.getMappingByNativeId(scope, nativeId), null);
    assert.equal((await f.store.listApplyIntents(scope)).filter(row => row.liveWorkKind === 'rejoin')
      .every(row => row.state === 'page_complete'), true);
    assert.equal((await f.store.listQueue(scope)).length, 0);
  } finally { f.store.close(); }
});

test.each([false, true])('a child arriving at the browser delete entry point survives, then resumes with review commit crash=%s', async crash => {
  const f = await folderFixture();
  try {
    let added: string | undefined;
    await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], { ...f.native,
      removeNative: async (id, tree) => {
        if (id === f.folders[0] && !added) added = (await f.api.create({ parentId: id,
          title: 'Arrived after every read', url: 'https://entry-race.test/' })).id;
        return f.native.removeNative!(id, tree);
      },
    }).catch(error => assert.match(String(error), /rejoin_boundary_changed/));
    assert.ok(added, 'inject at the destructive browser call itself');
    assert.equal(f.api.getNode(added)?.title, 'Arrived after every read');
    assert.ok(f.api.getNode(f.folders[0]!));
    assert.equal((await f.store.getMountBinding(scope, 'mount-bar'))?.status, 'detached');
    const previousCalls = f.api.calls.filter(row => row.kind === 'delete');
    assert.deepEqual(previousCalls, f.family.slice(1).reverse().map(nativeId => ({ kind: 'delete', nativeId })));
    for (const id of f.family.slice(1)) assert.equal(await f.store.getMappingByNativeId(scope, id), null);
    f.store.close();
    const blocked = await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], f.native);
    assert.equal(blocked.mount.status, 'detached');
    assert.equal((await f.store.getScopeCommandPlan(scope, 'rejoin:mount-bar'))?.phase, 'pending');
    assert.equal(f.api.getNode(added)?.title, 'Arrived after every read');
    assert.deepEqual(f.api.calls.filter(row => row.kind === 'delete'), previousCalls);
    const review = (await f.store.listScopeCommandPlans(scope)).find(row => row.rejoinDecision?.kind === 'remote_delete');
    assert.equal(review?.phase, 'pending');
    // A subsequent explicit user removal clears the remaining conflict. No
    // member already deleted by this attempt may be deleted a second time.
    await f.api.remove(added);
    if (crash) {
      const put = IDBObjectStore.prototype.put;
      const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
        if (value?.commandId === review!.commandId && value.phase === 'failed') throw new Error('worker_crash');
        return key === undefined ? put.call(this, value) : put.call(this, value, key);
      });
      try { await assert.rejects(rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], f.native), /worker_crash/); }
      finally { fault.mockRestore(); }
      assert.equal(f.api.getNode(f.folders[0]!), undefined);
      assert.ok(await f.store.getMappingByNativeId(scope, f.folders[0]!));
      assert.equal((await f.store.getScopeCommandPlan(scope, review!.commandId))?.phase, 'pending');
      f.store.close();
    }
    const resumed = await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], f.native);
    assert.equal(resumed.mount.status, 'active');
    assert.equal(await f.store.getMappingByNativeId(scope, f.folders[0]!), null);
    const retiredReview = (await f.store.getScopeCommandPlan(scope, review!.commandId))!;
    assert.equal(retiredReview.phase, 'failed');
    assert.equal(retiredReview.rejoinDecision?.supersededBy, 'rejoin:mount-bar');
    assert.equal(retiredReview.baselineDigest, review!.baselineDigest);
    assert.deepEqual(retiredReview.rejoinDecision?.remoteDeletion, review!.rejoinDecision?.remoteDeletion);
    assert.equal((await f.store.listQueue(scope)).length, 0);
    assert.deepEqual(f.api.calls.filter(row => row.kind === 'delete' && f.family.includes(row.nativeId!)),
      [...f.family].reverse().map(nativeId => ({ kind: 'delete', nativeId })));
  } finally { f.store.close(); }
});

test.each(['content', 'parent', 'mapping', 'queued_metadata', 'exclusion', 'attempt'] as const)
('after one authorized member is deleted a later %s stops the remaining family', async changed => {
  const f = await folderFixture();
  try {
    let injected = false;
    await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], { ...f.native,
      removeNative: async (id, tree) => {
        assert.equal(tree, false); await f.api.remove(id);
        if (injected) return;
        assert.equal(id, 'native-child'); injected = true;
        if (changed === 'content') await f.api.update('native-node', { title: 'Newer retained title' });
        else if (changed === 'parent') await f.api.move('native-node', { parentId: 'native-root', index: 1 });
        else if (changed === 'mapping') await f.store.deleteMapping(scope, 'native-node');
        else if (changed === 'queued_metadata') {
          const mapping = (await f.store.getMappingByNativeId(scope, 'native-node'))!;
          await queueRejoinOperation(f.store, scope, mapping, mapping.projection.revision, 'update_node_content', {
            base: { description: null }, value: { description: 'Newly authored after the first removal' } });
        } else if (changed === 'exclusion') await f.store.putLocalSyncExclusion(scope, {
          nativeId: 'native-node', decisionId: 'later-choice', generation: scope.generation,
          rootNativeId: 'native-root', priorColpId: 'node-1' });
        else {
          const { scopeKey: _key, ...mount } = (await f.store.getMountBinding(scope, 'mount-bar'))!;
          await f.store.putMountBinding(scope, { ...mount, pauseBaseline: { ...mount.pauseBaseline!, lastAppliedCursor: 'later-attempt' } });
        }
      },
    });
    assert.equal(injected, true);
    assert.deepEqual(f.api.calls.filter(row => row.kind === 'delete'), [{ kind: 'delete', nativeId: 'native-child' }]);
    assert.equal(f.api.getNode('native-child'), undefined);
    assert.ok(f.api.getNode('native-node')); assert.ok(f.api.getNode(f.folders[0]!));
    assert.equal((await f.store.getMountBinding(scope, 'mount-bar'))?.status, 'detached');
    if (changed === 'content') assert.equal(f.api.getNode('native-node')?.title, 'Newer retained title');
    if (changed === 'parent') assert.equal(f.api.getNode('native-node')?.parentId, 'native-root');
    if (changed === 'mapping') assert.equal(await f.store.getMappingByNativeId(scope, 'native-node'), null);
    if (changed === 'queued_metadata') {
      const rows = await f.store.listQueue(scope);
      assert.equal(rows.length, 1); assert.equal(rows[0]!.status, 'pending');
      assert.equal((rows[0]!.payload.payload as { value: { description: string } }).value.description,
        'Newly authored after the first removal');
      assert.equal(await f.store.getQueueReceipt(scope, rows[0]!.sequence), null);
    }
  } finally { f.store.close(); }
});

test('a wide deletion does not rescan every mapping for each member permission check', async () => {
  const f = await folderFixture(1, 80);
  try {
    const scans = vi.fn(f.store.listMappings);
    const nativeLookups = vi.fn(f.store.getMappingByNativeId);
    const remoteLookups = vi.fn(f.store.getMappingByColpId);
    const store = { ...f.store, listMappings: scans, getMappingByNativeId: nativeLookups, getMappingByColpId: remoteLookups };
    const result = await rejoinScopeMount(store, scope, 'mount-bar', new Set(), [], f.native);
    assert.equal(result.mount.status, 'active');
    assert.deepEqual(f.api.calls.filter(row => row.kind === 'delete'),
      [...f.family].reverse().map(nativeId => ({ kind: 'delete', nativeId })));
    assert.ok(scans.mock.calls.length <= 20, `full mapping scans: ${scans.mock.calls.length}`);
    assert.ok(nativeLookups.mock.calls.length + remoteLookups.mock.calls.length <= 12 * f.family.length + 40);
    assert.ok(f.api.reads.filter(row => row.kind === 'get').length <= 15 * f.family.length + 40);
    assert.ok(f.api.reads.filter(row => row.kind === 'getChildren').length <= 5 * f.family.length + 10);
  } finally { f.store.close(); }
});

test('an empty-folder native failure remains visible and can resume without recursive fallback', async () => {
  const f = await folderFixture();
  try {
    await assert.rejects(rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], { ...f.native,
      removeNative: async (id, tree) => {
        assert.equal(tree, false);
        if (id === f.folders[0]) throw new Error('native_permission_changed');
        return f.api.remove(id);
      },
    }), /native_permission_changed/);
    assert.ok(f.api.getNode(f.folders[0]!));
    assert.ok(await f.store.getMappingByNativeId(scope, f.folders[0]!));
    assert.equal((await f.store.getMountBinding(scope, 'mount-bar'))?.status, 'detached');
    f.store.close();
    const result = await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], f.native);
    assert.equal(result.mount.status, 'active');
    assert.deepEqual(f.api.calls.filter(row => row.kind === 'delete'),
      [...f.family].reverse().map(nativeId => ({ kind: 'delete', nativeId })));
  } finally { f.store.close(); }
});

test.each([false, true])('an ancestor outside deletion lookup hints remains private after identity migration=%s', async migrated => {
  const f = await folderFixture();
  try {
    for (const id of ['private-old', 'private-new']) f.api.seed({ id, title: id });
    const privateMapping = { nativeId: 'private-old', colpId: 'private-colp', rootNativeId: 'private-old',
      nodeKind: 'folder' as const, projection: { revision: 'private-r1', digest: 'private', content: { title: 'Private' } } };
    await f.store.putMapping(scope, privateMapping);
    await f.store.configureBrowserRoots(scope, { status: 'ready', selectedNativeIds: ['native-root'],
      privateNativeIds: ['private-old'], discovered: [
        { nativeId: 'native-root', ancestorNativeIds: [] }, { nativeId: 'private-old', ancestorNativeIds: [] },
      ] });
    const lookups = vi.fn(f.store.getMappingByNativeId);
    const batches = vi.fn(f.store.readRejoinBoundaryMappings);
    const store = { ...f.store, getMappingByNativeId: lookups, readRejoinBoundaryMappings: batches };
    let injected = false;
    await rejoinScopeMount(store, scope, 'mount-bar', new Set(), [], { ...f.native,
      getNative: async id => {
        if (!injected && id === 'native-root' && (await f.store.listApplyIntents(scope))
          .some(intent => intent.nativeTargetId === f.folders[0])) {
          injected = true;
          if (migrated) {
            await f.store.deleteMapping(scope, 'private-old');
            await f.store.putMapping(scope, { ...privateMapping, nativeId: 'private-new', rootNativeId: 'private-new' });
          }
          await f.api.move('native-root', { parentId: migrated ? 'private-new' : 'private-old', index: 0 });
        }
        return f.native.getNative(id);
      },
    });
    assert.equal(injected, true);
    assert.equal(f.api.calls.filter(row => row.kind === 'delete').length, 0);
    assert.ok(f.api.getNode('native-child'));
    assert.equal((await f.store.getMountBinding(scope, 'mount-bar'))?.status, 'detached');
    assert.deepEqual((await f.store.getScope(scope))?.privateRoots, ['private-colp']);
    assert.ok(batches.mock.calls.length > 0);
    assert.ok(batches.mock.calls.every(call => !call[1].includes('private-new')));
    if (migrated) assert.ok(lookups.mock.calls.some(call => call[1] === 'private-new'), 'current fallback reads the newly introduced ancestor');
  } finally { f.store.close(); }
});
