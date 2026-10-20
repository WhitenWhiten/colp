import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { rejoinFixture } from './rejoin-recovery-harness.js';
import { installKns05IndexedDb, scope } from './kns-05-pull-harness.js';
import { detachScopeMount, rejoinScopeMount } from '../src/scope-commands.js';
import { captureRejoinParents } from '../src/scope-rejoin-parents.js';

installKns05IndexedDb();
type Fixture = Awaited<ReturnType<typeof rejoinFixture>>;
async function input(f: Fixture) {
  return { ...f.native, store: f.store, scope, mount: (await f.store.getMountBinding(scope, 'mount-bar'))! };
}

test('a pending parent create is flushed once and a second rejoin cannot allocate a duplicate sequence', async () => {
  const f = await rejoinFixture();
  try {
    f.api.seed({ id: 'new-parent', parentId: 'native-root', title: 'New folder' });
    await f.api.move('native-node', { parentId: 'new-parent', index: 0 });
    assert.equal((await f.queue.created('new-parent', { id: 'new-parent', parentId: 'native-root', title: 'New folder' })).outcome, 'staged');
    const pending = await f.store.listBookmarkEventsByStatus(scope, 'pending');
    assert.equal(pending.length, 1);
    await detachScopeMount(f.store, scope, 'mount-bar');
    await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], f.native);
    const queued = await f.store.listQueue(scope);
    assert.equal(queued.length, 1); assert.equal(queued[0]!.payload.type, 'create_node');
    await captureRejoinParents(await input(f), await f.store.listMappings(scope));
    assert.deepEqual(await f.store.listQueue(scope), queued);
    const events = (await f.store.listBookmarkEvents(scope)).filter(row => row.kind === 'create');
    assert.equal(events.length, 1); assert.equal(events[0]!.eventId, pending[0]!.eventId);
    assert.equal(events[0]!.status, 'processed');
    assert.equal((await f.api.get('native-node'))[0]!.parentId, 'new-parent');
  } finally { f.store.close(); }
});

test.each(['missing', 'orphan', 'bookmark', 'separator', 'cycle', 'too_deep'] as const)(
  'an unprovable %s destination does not upload guessed parent identities', async invalid => {
    const f = await rejoinFixture();
    try {
      await detachScopeMount(f.store, scope, 'mount-bar');
      const parent = 'new-parent';
      if (invalid === 'too_deep') {
        for (let i = 0; i < 257; i++) f.api.seed({ id: `depth-${i}`, title: 'Deep', parentId: i === 256 ? 'native-root' : `depth-${i + 1}` });
      } else if (invalid !== 'missing') {
        f.api.seed({ id: parent, title: 'Unproved parent',
          ...(invalid === 'orphan' ? {} : { parentId: invalid === 'cycle' ? parent : 'native-root' }),
          ...(invalid === 'bookmark' ? { url: 'https://example.test/not-a-folder' } : {}),
          ...(invalid === 'separator' ? { type: 'separator' } : {}) });
      }
      f.api.seed({ ...f.api.getNode('native-node'), id: 'native-node', parentId: invalid === 'too_deep' ? 'depth-0' : parent });
      const mappings = await f.store.listMappings(scope); const native = f.api.all(); const calls = [...f.api.calls];
      await captureRejoinParents(await input(f), mappings);
      assert.deepEqual(await f.store.listQueue(scope), []);
      assert.deepEqual(await f.store.listBookmarkEvents(scope), []);
      assert.deepEqual(await f.store.listMappings(scope), mappings);
      assert.deepEqual(f.api.all(), native); assert.deepEqual(f.api.calls, calls);
      assert.ok(f.api.reads.length < 300, 'cycle/depth guard bounds native reads');
    } finally { f.store.close(); }
  });

test('without a children API rejoin leaves an offline move untouched rather than inventing a parent capture', async () => {
  const f = await rejoinFixture();
  try {
    f.api.seed({ id: 'new-parent', parentId: 'native-root' });
    await f.api.move('native-node', { parentId: 'new-parent', index: 0 });
    await captureRejoinParents({ ...await input(f), getChildren: undefined }, await f.store.listMappings(scope));
    assert.deepEqual(await f.store.listQueue(scope), []);
    assert.deepEqual(await f.store.listBookmarkEvents(scope), []);
    assert.equal(f.api.getNode('native-node')?.parentId, 'new-parent');
  } finally { f.store.close(); }
});

test('an invalid empty-title parent cannot be uploaded and its child stays at the user-selected destination', async () => {
  const f = await rejoinFixture();
  try {
    await detachScopeMount(f.store, scope, 'mount-bar');
    f.api.seed({ id: 'new-parent', parentId: 'native-root' });
    await f.api.move('native-node', { parentId: 'new-parent', index: 0 });
    await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], f.native);
    const events = (await f.store.listBookmarkEvents(scope)).filter(row => row.kind === 'create');
    assert.deepEqual(events, []);
    const rows = await f.store.listQueue(scope);
    assert.deepEqual(rows, []);
    assert.ok((await f.store.listIngressDiagnostics(scope)).some(row => row.code === 'invalid_title'));
    assert.equal((await f.store.getMappingByNativeId(scope, 'native-node'))!.parentNativeId, 'native-root');
    assert.equal(f.api.getNode('native-node')?.parentId, 'new-parent');
  } finally { f.store.close(); }
});
