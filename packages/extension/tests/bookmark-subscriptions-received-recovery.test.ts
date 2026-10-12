import { expect, test } from 'vitest';
import { database, row, root, leaf, owned, nativeFixture } from './bookmark-subscriptions-fixture.js';
import { createNativeExecutor, fingerprint } from '../src/bookmark-subscriptions/native.js';

test.each(['remove', 'update', 'move'] as const)('recovers received %s ownership without repeating the native call', async kind => {
  const db = database();
  try {
    const mapping = { ...row(), rootNativeId: 'root', state: 'current' as const };
    const fixture = nativeFixture();
    const folder = { ...leaf('folder'), kind: 'folder' as const, url: undefined, index: 1 };
    fixture.nodes.set('root', { id: 'root', parentId: 'bar', title: root.title, index: 0 });
    fixture.nodes.set('folder', { id: 'folder', parentId: 'root', title: folder.title, index: 1 });
    fixture.nodes.set('child', { id: 'child', parentId: 'root', title: leaf().title, url: leaf().url, index: 0 });
    await db.put('mappings', mapping);
    await db.put('nodes', owned(mapping, root, 'root'));
    await db.put('nodes', owned(mapping, folder, 'folder', 'root'));
    const original = owned(mapping, leaf(), 'child', 'root');
    await db.put('nodes', original);
    const executor = createNativeExecutor(db, fixture.api);
    const put = db.put.bind(db), remove = db.remove.bind(db);
    db.put = async (table, value) => {
      if (kind !== 'remove' && table === 'nodes') throw new Error('interrupted_ownership');
      return put(table, value);
    };
    db.remove = async (table, id) => {
      if (kind === 'remove' && table === 'nodes') throw new Error('interrupted_ownership');
      return remove(table, id);
    };
    const desired = { ...leaf(), ...(kind === 'update' ? { title: 'Updated remotely' } : {}), ...(kind === 'move' ? { parentKey: folder.key } : {}) };
    await expect(kind === 'remove'
      ? executor.removeOwned(mapping, new Set([original.key]))
      : executor.update(mapping, original, desired, kind === 'move' ? 'folder' : 'root')).rejects.toThrow('interrupted_ownership');
    expect(await db.pendingOperations()).toMatchObject([{ phase: 'received' }]);
    db.put = put; db.remove = remove;
    await db.close();
    const calls = [...fixture.calls];
    const restarted = createNativeExecutor(db, fixture.api);
    await restarted.recover(mapping);
    await restarted.recover(mapping);
    expect(fixture.calls).toEqual(calls);
    expect(await db.pendingOperations()).toEqual([]);
    if (kind === 'remove') expect(await db.get('nodes', original.id)).toBeUndefined();
    else expect(await db.get('nodes', original.id)).toMatchObject({ fingerprint: fingerprint(desired), parentNativeId: kind === 'move' ? 'folder' : 'root' });
    await expect(restarted.reconcile(mapping)).resolves.toBeUndefined();
    if (kind === 'update') {
      fixture.nodes.get('child')!.title = 'Later personal change';
      await expect(restarted.reconcile(mapping)).rejects.toThrow('readonly_content_changed');
    }
  } finally { await db.close(); }
});

test('recovers a root receipt even when its node row exists but rootNativeId was not committed', async () => {
  const db = database();
  try {
    const mapping = row(), fixture = nativeFixture();
    await db.put('mappings', mapping);
    const change = db.changeMapping.bind(db);
    db.changeMapping = async () => { throw new Error('root_mapping_interrupted'); };
    await expect(createNativeExecutor(db, fixture.api).create(mapping, root, 'bar')).rejects.toThrow('root_mapping_interrupted');
    db.changeMapping = change;
    expect(await db.nodesForMapping(mapping.id)).toHaveLength(1);
    await db.close();
    await createNativeExecutor(db, fixture.api).recover(mapping);
    expect((await db.get('mappings', mapping.id))?.rootNativeId).toBe('1');
    expect(fixture.calls).toEqual(['create:1']);
    expect(await db.pendingOperations()).toEqual([]);
  } finally { await db.close(); }
});
