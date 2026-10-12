import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import type { SubscriptionStore } from '../src/bookmark-subscriptions/store.js';
import type { NativeExecutor } from '../src/bookmark-subscriptions/native.js';
import type { createMaintenance, MaintenanceContext } from '../src/bookmark-subscriptions/maintenance.js';
const state = vi.hoisted(() => ({ db: undefined as unknown as SubscriptionStore, native: undefined as unknown as NativeExecutor, maintenance: undefined as unknown as ReturnType<typeof createMaintenance> }));
vi.mock('../src/bookmark-subscriptions/store.js', async original => ({ ...await original<object>(), get subscriptionStore() { return state.db; } }));
vi.mock('../src/bookmark-subscriptions/runtime.js', () => ({
  get subscriptionNative() { return state.native; }, get maintenance() { return state.maintenance; },
  localMapping: async (_ctx: unknown, id: string) => state.db.get('mappings', id),
  refreshMapping: vi.fn(), markFailure: vi.fn(), wakeSubscriptions: vi.fn(),
}));
import { recoveryCommand } from '../src/bookmark-subscriptions/recovery.js';
import { createNativeExecutor } from '../src/bookmark-subscriptions/native.js';
import { createMaintenance as buildMaintenance } from '../src/bookmark-subscriptions/maintenance.js';
import { digest } from '../src/bookmark-subscriptions/projection.js';
import { database, nativeFixture, row, root, leaf, owned, scope } from './bookmark-subscriptions-fixture.js';
let fixture: ReturnType<typeof nativeFixture>, mapping: ReturnType<typeof row>, ctx: MaintenanceContext, exits: number;
beforeEach(async () => {
  state.db = database(); fixture = nativeFixture(); exits = 0;
  mapping = { ...row(), rootNativeId: 'source-root', state: 'local_change', enabled: false, reserved: 2 };
  await state.db.put('mappings', mapping);
  fixture.nodes.set('source-root', { id: 'source-root', parentId: 'bar', title: 'Source', index: 0 });
  fixture.nodes.set('source-leaf', { id: 'source-leaf', parentId: 'source-root', index: 0, title: 'Edited locally', url: leaf().url });
  await state.db.put('nodes', owned(mapping, root, 'source-root'));
  await state.db.put('nodes', owned(mapping, leaf(), 'source-leaf', 'source-root'));
  state.native = createNativeExecutor(state.db, fixture.api); state.maintenance = buildMaintenance(state.db, state.native);
  const fence = { mappingId: mapping.id, generation: 'g1', mappingRevision: 'r1', authorityRevision: 'a1', contentEnabled: true, state: 'available' };
  ctx = { scope, assertCurrent: async () => {}, client: { request: (async (path, options) => {
    let data: unknown;
    if (path.endsWith('exit-previews')) data = { previewId: 'preview', trigger: 'unsubscribe', target: { kind: 'mapping', mappingId: mapping.id }, preferenceRevision: 'p1', expiresAt: new Date(Date.now() + 60000).toISOString(), targets: [] };
    else if (path.endsWith('subscription-exits')) { exits++; data = { exitId: 'exit', trigger: 'unsubscribe', actions: [] }; }
    else if (path.endsWith('node-access-checks')) data = { ...fence, requestDigest: digest((options?.body as { nodes: unknown }).nodes), removeNodes: [] };
    else data = { ...fence, removeEditionIds: [] };
    return { status: 200, etag: null, data };
  }) as MaintenanceContext['client']['request'] } };
});
afterEach(async () => { vi.restoreAllMocks(); await state.db.close(); });
async function otherMapping(reserved: number) {
  const id = crypto.randomUUID(); const other = { ...row(), id, mapping: { ...row().mapping, mappingId: id }, reserved };
  await state.db.put('mappings', other); return other;
}
async function preview() {
  const result = await recoveryCommand(ctx, { kind: 'recoveryPreview', mappingId: mapping.id, expectedGeneration: 'g1', action: 'copy_detach' }, crypto.randomUUID());
  return (result.data as { token: string }).token;
}
const confirm = (token: string) => recoveryCommand(ctx, { kind: 'recoveryConfirm', token }, crypto.randomUUID());

test('a fully reserved profile rejects recovery before creating any folder or copy', async () => {
  await otherMapping(19998);
  await expect(confirm(await preview())).rejects.toThrow('capacity_exceeded');
  expect(fixture.calls).toEqual([]); expect(exits).toBe(0);
  expect(await state.db.all('nodes')).toHaveLength(2);
  expect(await state.db.all('exclusions')).toHaveLength(0);
});

test('interrupted copy retains capacity across restart, retries once, and releases it only on conversion', async () => {
  const other = await otherMapping(19995), token = await preview();
  vi.spyOn(state.db, 'completeCopy').mockRejectedValueOnce(new Error('storage_unavailable'));
  await expect(confirm(token)).rejects.toThrow('storage_unavailable');
  const copies = (await state.db.all('nodes')).filter(n => n.copyTaskId);
  expect(copies).toHaveLength(3); expect(exits).toBe(0);
  const task = copies[0]!.copyTaskId!;
  expect((await state.db.get('mappings', mapping.id))?.copyReservations).toEqual({ [task]: 3 });
  await state.db.close();
  await expect(state.db.reserve(other.id, 19996)).rejects.toThrow('capacity_exceeded');
  const calls = [...fixture.calls];
  await confirm(token);
  expect(fixture.calls).toEqual(calls); expect(exits).toBe(1);
  expect(await state.db.all('nodes')).toHaveLength(2);
  expect((await state.db.get('mappings', mapping.id))?.copyReservations?.[task]).toBeUndefined();
  expect((await state.db.get('mappings', mapping.id))?.reserved).toBe(2);
  expect((await state.db.get('meta', 'copy-receipt:' + task))?.value).toMatchObject({ count: 3 });
  await expect(state.db.reserve(other.id, 19998)).resolves.toBeUndefined();
});

test('simultaneous copy reservations cannot overbook a profile and repeat reservation is idempotent', async () => {
  const other = await otherMapping(19995), taskA = crypto.randomUUID(), taskB = crypto.randomUUID();
  const results = await Promise.allSettled([
    state.db.reserveCopy(mapping.id, taskA, mapping.applyEpoch, 2),
    state.db.reserveCopy(other.id, taskB, other.applyEpoch, 2),
  ]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const failure = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
  expect(failure.reason.message).toBe('capacity_exceeded');
  const [winner, task] = results[0]!.status === 'fulfilled' ? [mapping, taskA] as const : [other, taskB] as const;
  await state.db.reserveCopy(winner.id, task, winner.applyEpoch, 2);
  expect((await state.db.get('mappings', winner.id))?.copyReservations).toEqual({ [task]: 2 });
  await expect(state.db.reserveCopy(winner.id, task, winner.applyEpoch, 3)).rejects.toThrow('copy_reservation_conflict');
  await expect(state.db.reserveCopy(winner.id, task, winner.applyEpoch + 1, 2)).rejects.toThrow('apply_epoch_changed');
});

test('legacy unfinished copies count against ordinary content reservations', async () => {
  const other = await otherMapping(19997);
  for (const id of ['legacy-a', 'legacy-b']) await state.db.put('nodes', { ...owned(mapping, leaf(id), id), copyTaskId: 'legacy-task' });
  await expect(state.db.reserve(other.id, 19997)).rejects.toThrow('capacity_exceeded');
});

test('successful local cleanup releases abandoned copy reservations', async () => {
  await state.db.reserveCopy(mapping.id, 'abandoned', mapping.applyEpoch, 3);
  await state.db.changeMapping(mapping.id, m => ({ ...m, cleanup: true, applyEpoch: m.applyEpoch + 1 }));
  await state.maintenance.cleanup();
  expect(await state.db.all('nodes')).toHaveLength(0);
  expect(await state.db.get('mappings', mapping.id)).toMatchObject({ reserved: 0, cleanup: false });
  expect((await state.db.get('mappings', mapping.id))?.copyReservations).toBeUndefined();
});
