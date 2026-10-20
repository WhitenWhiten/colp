import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { deletionFixture } from './rejoin-decision-harness.js';
import { rejectedOrderFixture } from './rejoin-rejected-harness.js';
import { rejoinFixture } from './rejoin-recovery-harness.js';
import { installKns05IndexedDb, scope } from './kns-05-pull-harness.js';
import { detachScopeMount, rejoinScopeMount } from '../src/scope-commands.js';

installKns05IndexedDb();

test('restoration suppresses its API-return create identities but captures an identical manual create', async () => {
  const f = await deletionFixture(1);
  try {
    await f.compare(); await f.resolve('keep_remote');
    const folder = (await f.getStore().getMappingByColpId(scope, 'restore-folder'))!;
    const child = (await f.getStore().getMappingByColpId(scope, f.children[0]!.nodeId))!;
    const queue = f.queue();
    for (const mapping of [folder, child]) {
      const native = (await f.api.get(mapping.nativeId))[0]!;
      assert.equal((await queue.created(mapping.nativeId, { ...native, title: native.title ?? '' })).outcome, 'apply_intent_reserved');
    }
    assert.equal((await f.getStore().listQueue(scope)).length, 0);
    const source = (await f.api.get(child.nativeId))[0]!;
    const manual = await f.api.create({ parentId: folder.nativeId, index: 0, title: source.title, url: source.url });
    const saved = (await f.api.get(manual.id))[0]!;
    assert.equal((await queue.created(manual.id, { ...saved, title: saved.title ?? '' })).outcome, 'staged');
    await queue.flush();
    const rows = await f.getStore().listQueue(scope); assert.equal(rows.length, 1);
    assert.equal(rows[0]?.payload.type, 'create_node');
    assert.equal((await f.getStore().getMappingByNativeId(scope, child.nativeId))?.colpId, child.colpId);
    assert.notEqual((await f.getStore().getMappingByNativeId(scope, manual.id))?.colpId, child.colpId);
  } finally { f.getStore().close(); }
});

test('a completed standalone content echo never consumes user undo and redo during its live TTL', async () => {
  const f = await rejoinFixture();
  try {
    await detachScopeMount(f.store, scope, 'mount-bar');
    const mount = (await f.store.getMountBinding(scope, 'mount-bar'))!;
    await f.store.putRemoteObservation(scope, { colpId: 'node-1', remoteRevision: 'cloud-title', kind: 'content',
      cursor: 'cloud-title', payload: { title: 'Cloud title', url: 'https://example.test/' }, observedAt: 1,
      sourceDigest: 'sha256:cloud-title', pauseGeneration: scope.generation,
      pauseBoundaryVersion: mount.pauseBaseline!.boundaryVersion, pauseCursor: mount.pauseBaseline!.lastAppliedCursor });
    await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], f.native);
    assert.equal((await f.api.get('native-node'))[0]?.title, 'Cloud title');
    assert.equal((await f.queue.changed('native-node', { title: 'Cloud title' })).outcome, 'apply_intent_reserved');
    await f.api.update('native-node', { title: 'node-1' });
    assert.equal((await f.queue.changed('native-node', { title: 'node-1' })).outcome, 'staged');
    await f.api.update('native-node', { title: 'Cloud title' });
    assert.equal((await f.queue.changed('native-node', { title: 'Cloud title' })).outcome, 'staged');
    assert.equal((await f.store.listBookmarkEventsByStatus(scope, 'pending')).length, 2);
    await f.queue.flush();
    assert.equal((await f.store.listQueue(scope)).length, 1);
    assert.equal((await f.store.listBookmarkEventsByStatus(scope, 'pending')).length, 1);
  } finally { f.store.close(); }
});

test('a completed standalone order echo never consumes a user undo and redo before the first upload settles', async () => {
  const f = await rejectedOrderFixture();
  try {
    await f.compare(); await f.resolve('keep_remote_order');
    const echo = f.api.lastEvent; assert.ok(echo?.kind === 'move');
    const queue = f.queue();
    assert.equal((await queue.moved(echo.nativeId, echo.details)).outcome, 'apply_intent_reserved');
    await f.api.move(echo.nativeId, { parentId: echo.details.oldParentId, index: echo.details.oldIndex });
    const undo = f.api.lastEvent!;
    assert.equal((await queue.moved(undo.nativeId, undo.details)).outcome, 'staged');
    await f.api.move(echo.nativeId, { parentId: echo.details.parentId, index: echo.details.index });
    const redo = f.api.lastEvent!;
    assert.equal((await queue.moved(redo.nativeId, redo.details)).outcome, 'staged');
    assert.equal((await f.getStore().listBookmarkEventsByStatus(scope, 'pending')).length, 2);
    await queue.flush();
    assert.equal((await f.getStore().listQueue(scope)).length, 1);
    assert.equal((await f.getStore().listBookmarkEventsByStatus(scope, 'pending')).length, 1);
  } finally { f.getStore().close(); }
});
