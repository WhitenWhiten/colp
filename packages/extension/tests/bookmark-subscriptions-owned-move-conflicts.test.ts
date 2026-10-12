import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SubscriptionStore } from '../src/bookmark-subscriptions/store.js';
import type { NativeExecutor } from '../src/bookmark-subscriptions/native.js';
import type { LocalMapping, OwnedNode } from '../src/bookmark-subscriptions/local-types.js';
import type { MaintenanceContext } from '../src/bookmark-subscriptions/maintenance.js';
const state = vi.hoisted(() => ({ db: undefined as unknown as SubscriptionStore, native: undefined as unknown as NativeExecutor }));
vi.mock('../src/bookmark-subscriptions/store.js', async original => ({ ...await original<object>(), get subscriptionStore() { return state.db; } }));
vi.mock('../src/bookmark-subscriptions/runtime.js', () => ({ get subscriptionNative() { return state.native; } }));
import { subscriptionEvent, repairSubscriptionEvents } from '../src/bookmark-subscriptions/events.js';
import { createNativeExecutor } from '../src/bookmark-subscriptions/native.js';
import { createMaintenance } from '../src/bookmark-subscriptions/maintenance.js';
import { isSubscriptionExcluded, personalBookmarks } from '../src/bookmark-subscriptions/guards.js';
import { database, row, root, leaf, owned } from './bookmark-subscriptions-fixture.js';
import { positionedNativeFixture } from './bookmark-subscriptions-position-fixture.js';

let fixture: ReturnType<typeof positionedNativeFixture>, mapping: LocalMapping, other: LocalMapping, child: OwnedNode, rootId: string, otherId: string, personalId: string, folderId: string;
beforeEach(async () => {
  state.db = database(); fixture = positionedNativeFixture(); vi.stubGlobal('chrome', { bookmarks: fixture.api });
  rootId = (await fixture.api.create({ parentId: 'bar', title: root.title })).id;
  otherId = (await fixture.api.create({ parentId: 'bar', title: 'Other mapping' })).id;
  personalId = (await fixture.api.create({ parentId: 'bar', title: 'Personal destination' })).id;
  mapping = { ...row(), rootNativeId: rootId, state: 'current' };
  const id = crypto.randomUUID(); other = { ...row(), id, mapping: { ...row().mapping, mappingId: id }, rootNativeId: otherId, state: 'current' };
  await state.db.put('mappings', mapping); await state.db.put('mappings', other);
  await state.db.put('nodes', owned(mapping, root, rootId)); await state.db.put('nodes', owned(other, { ...root, title: 'Other mapping' }, otherId));
  const node = leaf(); const native = await fixture.api.create({ parentId: rootId, title: node.title, url: node.url });
  child = owned(mapping, node, native.id, rootId); await state.db.put('nodes', child);
  const folder = { ...root, key: JSON.stringify(['collection', 'collection', 'folder']), parentKey: root.key, role: 'content' as const, title: 'Source folder', index: 1 };
  folderId = (await fixture.api.create({ parentId: rootId, title: folder.title })).id; await state.db.put('nodes', owned(mapping, folder, folderId, rootId));
  state.native = createNativeExecutor(state.db, fixture.api);
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await state.db.close(); });

async function moveAndCapture(id: string, parentId: string, index?: number) {
  const before = (await fixture.api.get(id))[0]!; const after = await fixture.api.move(id, { parentId, index });
  expect(await subscriptionEvent({ kind: 'moved', nativeId: id, move: { parentId: after.parentId!, index: after.index!, oldParentId: before.parentId!, oldIndex: before.index! } })).toBe(true);
}
async function expectConflict(id: string, parentId: string) {
  expect((await fixture.api.get(id))[0]!.parentId).toBe(parentId);
  expect(await state.db.get('mappings', mapping.id)).toMatchObject({ enabled: false, state: 'local_change', applyEpoch: 2 });
  expect(await state.db.get('mappings', other.id)).toEqual(other);
  expect(await state.db.all('diagnostics')).toMatchObject([{ mappingId: mapping.id, reasonCode: 'readonly_content_changed', resolution: 'pending' }]);
  expect((await state.db.all('meta')).filter(m => m.id.startsWith('native-recovery:'))).toEqual([]);
  expect(await isSubscriptionExcluded(id)).toBe(true);
}

it('retains a source child moved out, excludes upload, and stops content writes until explicit recovery', async () => {
  await moveAndCapture(child.nativeId, personalId, 0);
  await expectConflict(child.nativeId, personalId);
  expect(await state.db.nodeForNative(child.nativeId)).toEqual(child);
  await expect(personalBookmarks.update(child.nativeId, { title: 'upload attempt' })).rejects.toThrow('readonly_write_blocked');
  const calls = fixture.calls.length; const request = vi.fn();
  const paused = (await state.db.get('mappings', mapping.id))!;
  await createMaintenance(state.db, state.native).content({ scope: mapping.scope, assertCurrent: async () => {}, client: { request } } as MaintenanceContext, paused);
  await repairSubscriptionEvents(mapping.id);
  expect(request).not.toHaveBeenCalled(); expect(fixture.calls).toHaveLength(calls);
});

it('retains source folder descendants and their ownership when the folder moves out', async () => {
  const folder = (await state.db.nodeForNative(folderId))!;
  const node = leaf('nested', folder.key); const nested = await fixture.api.create({ parentId: folderId, title: node.title, url: node.url });
  const evidence = owned(mapping, node, nested.id, folderId); await state.db.put('nodes', evidence);
  await moveAndCapture(folderId, personalId); await expectConflict(folderId, personalId);
  expect(await state.db.nodeForNative(nested.id)).toEqual(evidence); expect(await isSubscriptionExcluded(nested.id)).toBe(true);
  expect((await fixture.api.get(nested.id))[0]!.parentId).toBe(folderId);
});

it('keeps a child moved inside the same mapping at its user-selected location', async () => {
  await moveAndCapture(child.nativeId, folderId); await expectConflict(child.nativeId, folderId);
  expect(await state.db.nodeForNative(child.nativeId)).toEqual(child);
});

it.each(['changed', 'removed'] as const)('pauses a source %s event without affecting another mapping', async kind => {
  if (kind === 'changed') { await fixture.api.update(child.nativeId, { title: 'Local edit' }); await subscriptionEvent({ kind, nativeId: child.nativeId, changes: { title: 'Local edit' } }); }
  else { await fixture.api.remove(child.nativeId); await subscriptionEvent({ kind, nativeId: child.nativeId, removal: { parentId: rootId, index: 0 } }); }
  expect(await state.db.get('mappings', mapping.id)).toMatchObject({ enabled: false, state: 'local_change' });
  expect(await state.db.get('mappings', other.id)).toEqual(other); expect(await state.db.nodeForNative(child.nativeId)).toEqual(child);
  const calls = fixture.calls.length; await repairSubscriptionEvents(); expect(fixture.calls).toHaveLength(calls);
});

it('still restores personal content moved into a mapping to its original native identity and position', async () => {
  const personal = await fixture.api.create({ parentId: personalId, title: 'Personal', url: 'https://example.test/personal' });
  await fixture.api.create({ parentId: personalId, title: 'Sibling' });
  await moveAndCapture(personal.id, rootId);
  expect((await fixture.api.get(personal.id))[0]).toMatchObject({ parentId: personalId, index: 0 });
  expect(await state.db.nodeForNative(personal.id)).toBeUndefined();
  expect(await state.db.get('mappings', mapping.id)).toMatchObject({ enabled: true, state: 'current' });
  expect(await state.db.all('diagnostics')).toMatchObject([{ reasonCode: 'readonly_native_moved_in', resolution: 'restored' }]);
});

it('restores cross-mapping source intrusion by ownership without creating a personal copy', async () => {
  await moveAndCapture(child.nativeId, otherId);
  expect((await fixture.api.get(child.nativeId))[0]).toMatchObject({ parentId: rootId, index: 0 });
  expect(await state.db.nodeForNative(child.nativeId)).toEqual(child);
  expect(await state.db.get('mappings', mapping.id)).toMatchObject({ enabled: true, state: 'current' });
  expect(await state.db.get('mappings', other.id)).toEqual(other);
  expect(await state.db.all('exclusions')).toEqual([]);
  expect((await state.db.all('operations')).map(o => o.kind)).toEqual(['move']);
});

it('accepts a legal root move and still corrects a root nested in another mapping', async () => {
  await moveAndCapture(rootId, personalId);
  expect(await state.db.get('mappings', mapping.id)).toMatchObject({ mountParentNativeId: personalId, mountIndex: 0, enabled: true });
  expect(await state.db.all('diagnostics')).toEqual([]);
  await moveAndCapture(rootId, otherId);
  expect((await fixture.api.get(rootId))[0]).toMatchObject({ parentId: personalId, index: 0 });
  expect(await state.db.get('mappings', mapping.id)).toMatchObject({ enabled: true, state: 'current' });
  expect(await state.db.all('diagnostics')).toMatchObject([{ reasonCode: 'mount_nested_invalid', resolution: 'restored' }]);
});

it('leaves failed personal intrusion repair paused and preserves the native scene', async () => {
  const personal = await fixture.api.create({ parentId: personalId, title: 'Personal' });
  await fixture.api.move(personal.id, { parentId: rootId });
  fixture.api.move = async () => { throw new Error('Permission denied'); };
  await subscriptionEvent({ kind: 'moved', nativeId: personal.id, move: { parentId: rootId, index: 2, oldParentId: personalId, oldIndex: 0 } });
  expect((await fixture.api.get(personal.id))[0]!.parentId).toBe(rootId);
  expect(await state.db.get('mappings', mapping.id)).toMatchObject({ enabled: false, state: 'repair_pending' });
  expect(await isSubscriptionExcluded(personal.id)).toBe(true);
});

it('retires legacy auto-repair tasks for moved-out source children without moving or re-enabling them', async () => {
  await fixture.api.move(child.nativeId, { parentId: personalId });
  const paused = await state.db.changeMapping(mapping.id, m => ({ ...m, enabled: false, applyEpoch: 2, state: 'repair_pending' }));
  const id = crypto.randomUUID();
  await state.db.put('diagnostics', { id, scope: mapping.scope, mappingId: mapping.id, nativeId: child.nativeId, reasonCode: 'readonly_native_moved_in', resolution: 'pending', operation: 'moved', origin: 'native_unknown', time: Date.now(), count: 1 });
  await state.db.put('meta', { id: 'native-recovery:' + id, value: { id, mappingId: mapping.id, generation: 'g1', epoch: paused.applyEpoch, nativeId: child.nativeId, owned: child, oldParentId: rootId, oldIndex: 0, priorEnabled: true, priorState: 'current' } });
  const calls = fixture.calls.length; await repairSubscriptionEvents(mapping.id);
  expect(fixture.calls).toHaveLength(calls); expect((await fixture.api.get(child.nativeId))[0]!.parentId).toBe(personalId);
  expect(await state.db.get('mappings', mapping.id)).toMatchObject({ enabled: false, state: 'local_change' });
  expect((await state.db.get('diagnostics', id))!).toMatchObject({ reasonCode: 'readonly_content_changed', resolution: 'pending' });
  expect((await state.db.get('meta', 'native-recovery:' + id))!.value).toMatchObject({ complete: true });
});

it('retires a stale repair task without overriding a newer mapping intent', async () => {
  await fixture.api.move(child.nativeId, { parentId: personalId });
  const latest = await state.db.changeMapping(mapping.id, m => ({ ...m, enabled: true, applyEpoch: 3, state: 'current' }));
  const id = crypto.randomUUID();
  await state.db.put('diagnostics', { id, scope: mapping.scope, mappingId: mapping.id, nativeId: child.nativeId, reasonCode: 'readonly_native_moved_in', resolution: 'pending', origin: 'native_unknown', time: Date.now(), count: 1 });
  await state.db.put('meta', { id: 'native-recovery:' + id, value: { id, mappingId: mapping.id, generation: 'g1', epoch: 2, nativeId: child.nativeId, owned: child, priorEnabled: true, priorState: 'current' } });
  const calls = fixture.calls.length; await repairSubscriptionEvents(mapping.id);
  expect(await state.db.get('mappings', mapping.id)).toEqual(latest);
  expect(fixture.calls).toHaveLength(calls);
  expect((await state.db.get('meta', 'native-recovery:' + id))!.value).toMatchObject({ complete: true });
});

it('finishes an interrupted cross-mapping correction without another native move', async () => {
  const put = state.db.put; let interrupt = true;
  vi.spyOn(state.db, 'put').mockImplementation(async (store, record) => {
    if (store === 'meta' && record.id.startsWith('native-recovery:') && 'value' in record && (record.value as { complete?: boolean }).complete && interrupt) { interrupt = false; throw new Error('worker interrupted before task completion'); }
    return put(store, record);
  });
  await moveAndCapture(child.nativeId, otherId);
  expect((await fixture.api.get(child.nativeId))[0]!.parentId).toBe(rootId);
  expect(await state.db.get('mappings', mapping.id)).toMatchObject({ enabled: false, state: 'repair_pending' });
  const calls = fixture.calls.length; await repairSubscriptionEvents(mapping.id);
  expect(fixture.calls).toHaveLength(calls);
  expect(await state.db.get('mappings', mapping.id)).toMatchObject({ enabled: true, state: 'current' });
  expect((await state.db.all('operations')).filter(o => o.kind === 'move')).toHaveLength(1);
  expect(await state.db.all('diagnostics')).toMatchObject([{ resolution: 'restored' }]);
});

it('keeps the new scene if a source child moves out again before intrusion repair retries', async () => {
  const move = fixture.api.move;
  await fixture.api.move(child.nativeId, { parentId: otherId });
  fixture.api.move = async () => { throw new Error('Permission denied'); };
  await subscriptionEvent({ kind: 'moved', nativeId: child.nativeId, move: { parentId: otherId, index: 0, oldParentId: rootId, oldIndex: 0 } });
  expect(await state.db.get('mappings', mapping.id)).toMatchObject({ enabled: false, state: 'repair_pending' });
  fixture.api.move = move;
  // This subsequent browser move happens while the worker has no event receipt.
  await move(child.nativeId, { parentId: personalId });
  const calls = fixture.calls.length; await repairSubscriptionEvents(mapping.id);
  expect(fixture.calls).toHaveLength(calls);
  expect((await fixture.api.get(child.nativeId))[0]!.parentId).toBe(personalId);
  expect(await state.db.get('mappings', mapping.id)).toMatchObject({ enabled: false, state: 'local_change' });
  expect(await state.db.nodeForNative(child.nativeId)).toEqual(child);
  expect(await state.db.all('diagnostics')).toMatchObject([{ reasonCode: 'readonly_content_changed', resolution: 'pending' }]);
});
