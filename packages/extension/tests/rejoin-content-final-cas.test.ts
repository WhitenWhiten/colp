import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { detachScopeMount, rejoinScopeMount } from '../src/scope-commands.js';
import { rejoinFixture } from './rejoin-recovery-harness.js';
import { installKns05IndexedDb, scope } from './kns-05-pull-harness.js';

installKns05IndexedDb();

for (const observed of ['content', 'tombstone', 'placement'] as const) for (const raced of ['mapping', 'content', 'parent'] as const)
test(`rejoin ${observed} cannot overwrite ${raced} changed during the final native boundary read`, async () => {
  const f = await rejoinFixture();
  try {
    await f.store.putMapping(scope, { nativeId: 'remote-dest', colpId: 'remote-dest-colp', rootNativeId: 'native-root',
      parentNativeId: 'native-root', parentColpId: 'root-colp', nodeKind: 'folder',
      projection: { revision: 'dest-r1', childrenRevision: 'dest-c1', digest: 'dest', content: { title: 'Remote destination' } } });
    f.api.seed({ id: 'remote-dest', parentId: 'native-root', title: 'Remote destination' });
    await detachScopeMount(f.store, scope, 'mount-bar');
    const mount = (await f.store.getMountBinding(scope, 'mount-bar'))!;
    f.api.seed({ id: 'new-parent', parentId: 'native-root', title: 'New folder' });
    await f.store.putRemoteObservation(scope, { colpId: 'node-1', remoteRevision: 'cloud-title', kind: observed,
      cursor: 'cloud-title', payload: observed === 'content' ? { title: 'Cloud title', url: 'https://example.test/' }
        : observed === 'tombstone' ? { deleted: true } : { parentId: 'remote-dest-colp' }, observedAt: 1,
      sourceDigest: 'sha256:cloud-title', pauseGeneration: scope.generation,
      pauseBoundaryVersion: mount.pauseBaseline!.boundaryVersion, pauseCursor: mount.pauseBaseline!.lastAppliedCursor });
    let injected = false, automaticWrites = 0;
    const native = { ...f.native,
      getNative: async (id: string) => {
        if (!injected && id === 'native-node' && (await f.store.listApplyIntents(scope))
          .some(intent => intent.liveWorkKind === 'rejoin' && intent.state === 'browser_call_started')) {
          injected = true;
          if (raced === 'mapping') await f.store.deleteMapping(scope, 'native-node');
          else if (raced === 'content') await f.api.update('native-node', { title: 'Newest user title' });
          else await f.api.move('native-node', { parentId: 'new-parent', index: 0 });
        }
        return f.native.getNative(id);
      },
      updateNative: async (id: string, changes: { title?: string; url?: string }) => {
        automaticWrites++; return f.api.update(id, changes);
      },
      removeNative: async (id: string, tree: boolean) => {
        automaticWrites++; return tree ? f.api.removeTree(id) : f.api.remove(id);
      },
      moveNative: async (id: string, placement: { parentId: string; index: number }) => {
        automaticWrites++; return f.api.move(id, placement);
      },
    };
    await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], native).catch(error => {
      assert.match(String(error), /rejoin_(boundary|content|mapping)_changed/);
    });
    assert.equal(injected, true);
    assert.equal(automaticWrites, 0, 'the last comparison must reject stale identity and newer user edits');
    assert.equal((await f.api.get('native-node'))[0]?.title, raced === 'content' ? 'Newest user title' : 'node-1');
    assert.equal((await f.api.get('native-node'))[0]?.parentId, raced === 'parent' ? 'new-parent' : 'native-root');
    if (raced === 'mapping') assert.equal(await f.store.getMappingByNativeId(scope, 'native-node'), null);
    assert.equal((await f.store.getMountBinding(scope, 'mount-bar'))?.status, 'detached');
  } finally { f.store.close(); }
});

async function pausedContentFixture() {
  const f = await rejoinFixture();
  await detachScopeMount(f.store, scope, 'mount-bar');
  const mount = (await f.store.getMountBinding(scope, 'mount-bar'))!;
  await f.store.putRemoteObservation(scope, { colpId: 'node-1', remoteRevision: 'cloud-title', kind: 'content',
    cursor: 'cloud-title', payload: { title: 'Cloud title', url: 'https://example.test/' }, observedAt: 1,
    sourceDigest: 'sha256:cloud-title', pauseGeneration: scope.generation,
    pauseBoundaryVersion: mount.pauseBaseline!.boundaryVersion, pauseCursor: mount.pauseBaseline!.lastAppliedCursor });
  return f;
}

test.each(['boundary', 'attempt', 'exclusion', 'parent_mapping', 'clear'] as const)
('the final mutation authority rejects a withdrawn %s before invoking the browser', async changed => {
  const f = await pausedContentFixture();
  try {
    let injected = false, writes = 0;
    await assert.rejects(rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], { ...f.native,
      getNative: async id => {
        if (!injected && id === 'native-node' && (await f.store.listApplyIntents(scope))
          .some(intent => intent.liveWorkKind === 'rejoin' && intent.state === 'browser_call_started')) {
          injected = true;
          if (changed === 'boundary') await f.store.bumpBoundaryVersion(scope);
          else if (changed === 'attempt') {
            const { scopeKey: _key, ...mount } = (await f.store.getMountBinding(scope, 'mount-bar'))!;
            await f.store.putMountBinding(scope, { ...mount, pauseBaseline: { ...mount.pauseBaseline!, lastAppliedCursor: 'new-pause' } });
          } else if (changed === 'exclusion') await f.store.putLocalSyncExclusion(scope, {
            nativeId: 'native-node', decisionId: 'new-user-choice', generation: scope.generation,
            rootNativeId: 'native-root', priorColpId: 'node-1',
          });
          else if (changed === 'parent_mapping') await f.store.deleteMapping(scope, 'native-root');
          else await f.store.retireScope(scope, { retiredAt: 100, reason: 'user_clear' });
        }
        return f.native.getNative(id);
      }, updateNative: async (id, value) => { writes++; return f.api.update(id, value); },
    }), /rejoin_boundary_changed|scope_not_found/);
    assert.equal(injected, true); assert.equal(writes, 0);
    assert.equal((await f.api.get('native-node'))[0]?.title, 'node-1');
    if (changed === 'clear') assert.equal(await f.store.getScope(scope), null);
    else assert.equal((await f.store.getMountBinding(scope, 'mount-bar'))?.status, 'detached');
  } finally { f.store.close(); }
});

test.each(['mapping', 'capture', 'exclusion', 'boundary'] as const)
('a completed native update cannot publish a stale projection after a concurrent %s', async changed => {
  const f = await pausedContentFixture();
  try {
    let writes = 0;
    await assert.rejects(rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], { ...f.native,
      updateNative: async (id, value) => {
        writes++;
        const result = await f.api.update(id, value);
        if (changed === 'mapping') await f.store.deleteMapping(scope, id);
        else if (changed === 'capture') {
          await f.api.update(id, { title: 'New work after the cloud update' });
          assert.equal((await f.queue.changed(id, { title: 'New work after the cloud update' })).outcome, 'staged');
          await f.queue.flush();
        } else if (changed === 'exclusion') await f.store.putLocalSyncExclusion(scope, {
          nativeId: id, decisionId: 'new-user-choice', generation: scope.generation,
          rootNativeId: 'native-root', priorColpId: 'node-1',
        });
        else await f.store.bumpBoundaryVersion(scope);
        return result;
      },
    }), /rejoin_boundary_changed/);
    assert.equal(writes, 1, 'the authorized operation landed before the later change');
    const current = await f.store.getMappingByNativeId(scope, 'native-node');
    if (changed === 'mapping') assert.equal(current, null, 'a removed identity is not restored from the earlier comparison');
    else if (changed === 'capture') {
      assert.equal(current?.projection.content?.title, 'New work after the cloud update');
      assert.match(current!.projection.revision, /^local-/);
      const authored = await f.store.listQueue(scope);
      assert.equal(authored.length, 1);
      assert.equal(authored[0]?.status, 'pending');
      assert.equal((authored[0]?.payload.payload as { value?: { title?: string } })?.value?.title,
        'New work after the cloud update');
      assert.equal(await f.store.getQueueReceipt(scope, authored[0]!.sequence), null);
    } else assert.equal(current?.projection.content?.title, 'node-1');
    assert.equal((await f.api.get('native-node'))[0]?.title,
      changed === 'capture' ? 'New work after the cloud update' : 'Cloud title');
    assert.equal((await f.store.getMountBinding(scope, 'mount-bar'))?.status, 'detached');
  } finally { f.store.close(); }
});
