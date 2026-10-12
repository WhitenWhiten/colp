import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SubscriptionStore } from '../src/bookmark-subscriptions/store.js';
import type { NativeExecutor } from '../src/bookmark-subscriptions/native.js';
import type { createMaintenance, MaintenanceContext } from '../src/bookmark-subscriptions/maintenance.js';
import type { SubscriptionCommand } from '../src/bookmark-subscriptions/commands.js';
import type { LocalMapping } from '../src/bookmark-subscriptions/local-types.js';

const state = vi.hoisted(() => ({ db: undefined as unknown as SubscriptionStore, native: undefined as unknown as NativeExecutor, maintenance: undefined as unknown as ReturnType<typeof createMaintenance>, ctx: undefined as unknown as MaintenanceContext, refresh: vi.fn() }));
vi.mock('../src/bookmark-subscriptions/store.js', async original => ({ ...await original<object>(), get subscriptionStore() { return state.db; } }));
vi.mock('../src/sw/runtime.js', () => ({ hasBookmarkPermission: async () => true }));
vi.mock('../src/bookmark-subscriptions/runtime.js', () => ({
  get subscriptionNative() { return state.native; }, get maintenance() { return state.maintenance; },
  subscriptionContext: async () => state.ctx, localDirectoryContext: async () => state.ctx,
  localMapping: async (_ctx: unknown, id: string) => state.db.get('mappings', id),
  refreshMapping: (...args: unknown[]) => state.refresh(...args), markFailure: vi.fn(), wakeSubscriptions: vi.fn(), scheduleSubscriptionAlarm: vi.fn(),
}));
import { handleSubscriptionRequest } from '../src/bookmark-subscriptions/worker.js';
import { createNativeExecutor } from '../src/bookmark-subscriptions/native.js';
import { createMaintenance as buildMaintenance } from '../src/bookmark-subscriptions/maintenance.js';
import { digest } from '../src/bookmark-subscriptions/projection.js';
import { database, row, root, owned, scope } from './bookmark-subscriptions-fixture.js';
import { positionedNativeFixture } from './bookmark-subscriptions-position-fixture.js';

let fixture: ReturnType<typeof positionedNativeFixture>, mapping: LocalMapping, rootId: string, targetId: string;
const call = (command: SubscriptionCommand) => handleSubscriptionRequest({ type: 'BOOKMARK_SUBSCRIPTIONS', requestId: crypto.randomUUID(), command });
beforeEach(async () => {
  state.db = database(); fixture = positionedNativeFixture(); state.refresh.mockReset();
  vi.stubGlobal('chrome', { bookmarks: fixture.api });
  rootId = (await fixture.api.create({ parentId: 'bar', title: root.title })).id;
  for (const title of ['A', 'B']) await fixture.api.create({ parentId: 'bar', title });
  targetId = (await fixture.api.create({ parentId: 'bar', title: 'Target' })).id;
  for (const title of ['X', 'Y']) await fixture.api.create({ parentId: targetId, title });
  mapping = { ...row(), rootNativeId: rootId, mountIndex: 0, state: 'current' };
  await state.db.put('mappings', mapping); await state.db.put('nodes', owned(mapping, root, rootId));
  state.native = createNativeExecutor(state.db, fixture.api); state.maintenance = buildMaintenance(state.db, state.native);
  const request = async (path: string, options: { body?: { nodes: unknown } } = {}) => {
    const fence = { mappingId: mapping.id, generation: 'g1', mappingRevision: 'r1', authorityRevision: 'a1', contentEnabled: true, state: 'available' };
    const data = path.endsWith('node-access-checks') ? { ...fence, requestDigest: digest(options.body!.nodes), removeNodes: [] } : path.includes('/access') ? { ...fence, removeEditionIds: [] } : mapping.mapping;
    return { status: 200, etag: null, data };
  };
  state.ctx = { scope, assertCurrent: async () => {}, client: { request } } as MaintenanceContext;
});
afterEach(async () => { await state.db.close(); vi.unstubAllGlobals(); });

it.each(['bar', 'target'])('relocate confirmation appends in %s and durably records the returned position', async destination => {
  const parentNativeId = destination === 'bar' ? 'bar' : targetId;
  const expected = (await fixture.api.getChildren(parentNativeId)).length - (destination === 'bar' ? 1 : 0);
  const preview = await call({ kind: 'relocatePreview', mappingId: mapping.id, expectedGeneration: 'g1', parentNativeId }) as { token: string };
  await call({ kind: 'relocateConfirm', token: preview.token });
  expect((await fixture.api.get(rootId))[0]).toMatchObject({ parentId: parentNativeId, index: expected });
  expect(await state.db.get('mappings', mapping.id)).toMatchObject({ mountIndex: expected, enabled: true, state: 'current' });
  expect(await state.db.nodeForNative(rootId)).toMatchObject({ index: expected });
  const calls = fixture.calls.length;
  await call({ kind: 'relocateConfirm', token: preview.token });
  expect(fixture.calls).toHaveLength(calls);
});

it('explicit recovery to bottom appends the existing root after preserving its local tree', async () => {
  await state.db.changeMapping(mapping.id, m => ({ ...m, enabled: false, state: 'local_change' }));
  const preview = await call({ kind: 'recoveryPreview', mappingId: mapping.id, expectedGeneration: 'g1', action: 'restore', parentNativeId: targetId }) as { token: string };
  await call({ kind: 'recoveryConfirm', token: preview.token });
  expect((await fixture.api.get(rootId))[0]).toMatchObject({ parentId: targetId, index: 2 });
  expect(await state.db.get('mappings', mapping.id)).toMatchObject({ mountParentNativeId: targetId, mountIndex: 2, enabled: true });
  expect(state.refresh).toHaveBeenCalledOnce();
});

it('missing-root recovery retains omitted bottom selection instead of the stale mount index', async () => {
  await fixture.api.remove(rootId);
  await state.db.changeMapping(mapping.id, m => ({ ...m, enabled: false, state: 'target_missing', mountIndex: 1 }));
  const preview = await call({ kind: 'recoveryPreview', mappingId: mapping.id, expectedGeneration: 'g1', action: 'restore', parentNativeId: targetId }) as { token: string };
  await call({ kind: 'recoveryConfirm', token: preview.token });
  const saved = await state.db.get('mappings', mapping.id);
  expect(saved!.mountParentNativeId).toBe(targetId); expect(saved!.mountIndex).toBeUndefined();
  expect(saved!.rootNativeId).toBeUndefined(); expect(state.refresh).toHaveBeenCalledOnce();
});
