import { afterEach, expect, test, vi } from 'vitest';
import type { SubscriptionStore } from '../src/bookmark-subscriptions/store.js';
import type { NativeExecutor } from '../src/bookmark-subscriptions/native.js';
import type { MaintenanceContext, createMaintenance } from '../src/bookmark-subscriptions/maintenance.js';
import type { CompletedCopy, LocalMapping } from '../src/bookmark-subscriptions/local-types.js';

const state = vi.hoisted(() => ({
  db: undefined as unknown as SubscriptionStore,
  native: undefined as unknown as NativeExecutor,
  maintenance: undefined as unknown as ReturnType<typeof createMaintenance>,
  refreshError: undefined as string | undefined,
}));
vi.mock('../src/bookmark-subscriptions/store.js', async original => ({
  ...await original<object>(), get subscriptionStore() { return state.db; },
}));
vi.mock('../src/bookmark-subscriptions/runtime.js', () => ({
  get subscriptionNative() { return state.native; },
  get maintenance() { return state.maintenance; },
  localMapping: async (_ctx: unknown, id: string) => state.db.get('mappings', id),
  refreshMapping: async (ctx: MaintenanceContext, mapping: LocalMapping) => state.maintenance.content(ctx, mapping),
  markFailure: async (mapping: LocalMapping, error: Error) => {
    state.refreshError = error.message;
    await state.db.changeMapping(mapping.id, current => ({ ...current, enabled: false, state: 'local_change', error: error.message }));
  },
  wakeSubscriptions: async () => {},
}));
import { createNativeExecutor, fingerprint } from '../src/bookmark-subscriptions/native.js';
import { createMaintenance as buildMaintenance } from '../src/bookmark-subscriptions/maintenance.js';
import { recoveryCommand } from '../src/bookmark-subscriptions/recovery.js';
import { database, row, root, leaf, owned } from './bookmark-subscriptions-fixture.js';
import { positionedNativeFixture } from './bookmark-subscriptions-position-fixture.js';
import { projectionContext } from './bookmark-subscriptions-composite-fixture.js';

afterEach(async () => { vi.restoreAllMocks(); if (state.db) await state.db.close(); });

test.each([
  { name: 'renamed and moved', title: 'Personal edit', url: leaf().url, moved: true },
  { name: 'URL edited and moved', title: leaf().title, url: 'https://personal.example/edited', moved: true },
  { name: 'both edited and moved', title: 'Personal edit', url: 'https://personal.example/edited', moved: true },
  { name: 'previously accepted fingerprint and moved', title: 'Personal edit', url: leaf().url, moved: true, accepted: true },
  { name: 'both edited in place', title: 'Personal edit', url: 'https://personal.example/edited', moved: false },
])('restore preserves the local copy and restores source content: $name', async edit => {
  state.db = database();
  state.refreshError = undefined;
  const fixture = positionedNativeFixture();
  const mapping = { ...row(), rootNativeId: 'native-root', state: 'local_change' as const, enabled: false };
  await state.db.put('mappings', mapping);
  fixture.nodes.set('native-root', { id: 'native-root', parentId: 'bar', title: root.title, index: 0 });
  fixture.nodes.set('personal-folder', { id: 'personal-folder', parentId: 'bar', title: 'Personal', index: 1 });
  const changed = { id: 'native-child', parentId: edit.moved ? 'personal-folder' : 'native-root', index: 0, title: edit.title, url: edit.url };
  fixture.nodes.set(changed.id, changed);
  await state.db.put('nodes', owned(mapping, root, 'native-root'));
  const source = owned(mapping, leaf(), changed.id, 'native-root');
  await state.db.put('nodes', edit.accepted ? { ...source, fingerprint: fingerprint(changed) } : source);
  state.native = createNativeExecutor(state.db, fixture.api);
  state.maintenance = buildMaintenance(state.db, state.native);
  const placement = state.native.restorePlacement;
  const receipts: string[] = [];
  vi.spyOn(state.native, 'restorePlacement').mockImplementation(async (...args) => {
    await placement(...args);
    const persisted = (await state.db.get('nodes', source.id))!;
    receipts.push(persisted.fingerprint);
    expect(persisted.fingerprint).toBe(fingerprint(fixture.nodes.get(changed.id)!));
    expect(persisted.fingerprint).toBe(fingerprint(persisted.node));
  });
  const ctx = projectionContext(mapping, [root, leaf()]);
  const preview = (await recoveryCommand(ctx, { kind: 'recoveryPreview', mappingId: mapping.id, expectedGeneration: 'g1', action: 'restore' }, crypto.randomUUID())).data as { token: string };
  const result = await recoveryCommand(ctx, { kind: 'recoveryConfirm', token: preview.token }, crypto.randomUUID());

  expect(result.handled).toBe(true);
  expect(state.refreshError).toBeUndefined();
  expect(receipts).toEqual(edit.moved ? [fingerprint({ title: edit.title, url: edit.url })] : []);
  expect(fixture.nodes.get(changed.id)).toMatchObject({ id: changed.id, parentId: 'native-root', index: 0, title: leaf().title, url: leaf().url });
  expect(await state.db.get('mappings', mapping.id)).toMatchObject({ enabled: true, state: 'current', lastAppliedRevision: 'p2' });
  const evidence = await state.db.nodesForMapping(mapping.id);
  expect(evidence).toHaveLength(2);
  expect(evidence.find(n => n.nativeId === changed.id)).toMatchObject({ node: leaf(), fingerprint: fingerprint(leaf()), parentNativeId: 'native-root' });
  expect(await state.db.pendingOperations()).toEqual([]);
  const copies = [...fixture.nodes.values()].filter(n => n.id !== changed.id && n.title === edit.title && n.url === edit.url);
  expect(copies).toHaveLength(1);
  const copyReceipt = (await state.db.all('meta')).find(n => n.id.startsWith('copy-receipt:'))!.value as CompletedCopy;
  expect(copyReceipt.nodes).toHaveLength(copyReceipt.count);
  expect(copyReceipt.nodes).toContainEqual({ nativeId: copies[0]!.id, parentNativeId: copies[0]!.parentId, fingerprint: fingerprint(copies[0]!) });
  expect(evidence.some(n => n.nativeId === copies[0]!.id)).toBe(false);

  // An idempotent confirm must neither create another copy nor alter its receipt.
  await recoveryCommand(ctx, { kind: 'recoveryConfirm', token: preview.token }, crypto.randomUUID());
  expect([...fixture.nodes.values()].filter(n => n.id !== changed.id && n.title === edit.title && n.url === edit.url)).toHaveLength(1);
  expect((await state.db.all('meta')).find(n => n.id.startsWith('copy-receipt:'))!.value).toEqual(copyReceipt);
});
