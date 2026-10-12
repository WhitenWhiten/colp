import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { SubscriptionStore } from '../src/bookmark-subscriptions/store.js';
import type { MaintenanceContext } from '../src/bookmark-subscriptions/maintenance.js';
import type { LocalMapping } from '../src/bookmark-subscriptions/local-types.js';
const state = vi.hoisted(() => ({ db: undefined as unknown as SubscriptionStore, ctx: undefined as unknown as MaintenanceContext }));
vi.mock('../src/bookmark-subscriptions/store.js', async original => ({ ...await original<object>(), get subscriptionStore() { return state.db; } }));
vi.mock('../src/sw/runtime.js', () => ({ hasBookmarkPermission: async () => true }));
vi.mock('../src/bookmark-subscriptions/runtime.js', () => ({
  subscriptionContext: async () => state.ctx, localDirectoryContext: async () => state.ctx,
  maintenance: { belongs: (r: LocalMapping, s: MaintenanceContext['scope']) => r.scope.accountId === s.accountId && r.scope.serverOrigin === s.serverOrigin && r.scope.profileId === s.profileId },
  subscriptionNative: { read: async (id: string) => { if (id === 'missing') throw new Error('target_missing'); return { id, title: 'Bar' }; } },
  wakeSubscriptions: vi.fn(),
}));
import { handleSubscriptionRequest } from '../src/bookmark-subscriptions/worker.js';
import { database, row, owned, leaf, root, scope } from './bookmark-subscriptions-fixture.js';

beforeEach(() => { state.db = database(); });
afterEach(async () => { vi.restoreAllMocks(); await state.db.close(); });
const list = () => handleSubscriptionRequest({ type: 'BOOKMARK_SUBSCRIPTIONS', requestId: crypto.randomUUID(), command: { kind: 'list' } }) as Promise<{ mappings: { items: { mappingId: string; local: LocalMapping & { bookmarkCount: number; ackPending: boolean; recoveryPending: boolean; mountPath: string[] } | null }[] } }>;
function respond(rows: LocalMapping[]) {
  state.ctx = { scope, assertCurrent: async () => {}, client: { request: vi.fn(async path => ({ status: 200, etag: null, data: path.startsWith('/me/bookmark-subscription-mappings') ? { items: rows.map(r => r.mapping), nextCursor: null } : { items: [] } })) as MaintenanceContext['client']['request'] } };
}

test('50 list rows share one ownership/ACK scan and read only unsettled operations', async () => {
  const rows = Array.from({ length: 50 }, () => { const id = crypto.randomUUID(); const base = row(); return { ...base, id, mapping: { ...base.mapping, mappingId: id } }; });
  rows[4]!.cleanup = true;
  rows[5]!.state = 'local_change'; rows[6]!.state = 'target_missing'; rows[7]!.state = 'repair_pending';
  rows[8]!.mountParentNativeId = 'missing';
  for (const r of rows) {
    await state.db.put('mappings', r);
    await state.db.put('nodes', owned(r, root, 'root-' + r.id));
    await state.db.put('nodes', owned(r, leaf(), 'leaf-' + r.id));
  }
  await state.db.put('nodes', owned(rows[0]!, leaf('second'), 'second'));
  await state.db.put('nodes', { ...owned(rows[0]!, leaf('copy'), 'copy'), copyTaskId: 'pending-copy' });
  await state.db.put('acks', { id: 'ack', mappingId: rows[1]!.id, scope, generation: 'g1', result: 'kept', commandId: crypto.randomUUID(), pending: true, completedAt: 0, evidence: [] });
  for (let i = 0; i < 100; i++) await state.db.put('operations', { id: 'history-' + i, mappingId: rows[3]!.id, generation: 'g1', applyEpoch: 1, kind: 'create', phase: 'received', settled: true, createdAt: 0 });
  await state.db.put('operations', { id: 'pending', mappingId: rows[2]!.id, generation: 'g1', applyEpoch: 1, kind: 'update', phase: 'received', settled: false, createdAt: 0 });
  respond(rows);
  const all = vi.spyOn(state.db, 'all'); const pending = vi.spyOn(state.db, 'pendingOperations');
  const items = (await list()).mappings.items;
  expect(items.map(i => i.local?.bookmarkCount)).toEqual([2, ...Array(49).fill(1)]);
  expect(items.map(i => i.local?.ackPending)).toEqual(rows.map((_, i) => i === 1));
  expect(items.map(i => i.local?.recoveryPending)).toEqual(rows.map((_, i) => [2, 4, 5, 6, 7].includes(i)));
  expect(items[0]!.local?.mountPath).toEqual(['Bar']); expect(items[8]!.local?.mountPath).toEqual([]);
  expect(all.mock.calls.filter(([table]) => table === 'nodes')).toHaveLength(1);
  expect(all.mock.calls.filter(([table]) => table === 'acks')).toHaveLength(1);
  expect(all.mock.calls.filter(([table]) => table === 'operations')).toHaveLength(0);
  expect(pending).toHaveBeenCalledOnce();
});

test('a remote page without current-account local rows does not read ownership or operation history', async () => {
  const foreign = { ...row(), scope: { ...scope, accountId: 'other-account' } };
  await state.db.put('mappings', foreign); respond([foreign]);
  const all = vi.spyOn(state.db, 'all'); const pending = vi.spyOn(state.db, 'pendingOperations');
  expect((await list()).mappings.items[0]!.local).toBeNull();
  // The independent ACK outbox must be checked even when the server returns no local row.
  expect(all.mock.calls.map(([table]) => table)).toEqual(['mappings', 'acks']);
  expect(pending).not.toHaveBeenCalled();
});
