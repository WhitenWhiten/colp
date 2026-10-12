// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { SubscriptionStore } from '../src/bookmark-subscriptions/store.js';
import type { MaintenanceContext } from '../src/bookmark-subscriptions/maintenance.js';
import type { AckRecord, LocalMapping } from '../src/bookmark-subscriptions/local-types.js';
import type { MappingPage } from '../src/bookmark-subscriptions/contracts.js';
import type { Send, SubscriptionCommand } from '../src/subscriptions-ui/client.js';
const state = vi.hoisted(() => ({ db: undefined as unknown as SubscriptionStore, ctx: undefined as unknown as MaintenanceContext }));
vi.mock('../src/bookmark-subscriptions/store.js', async original => ({ ...await original<object>(), get subscriptionStore() { return state.db; } }));
vi.mock('../src/sw/runtime.js', () => ({ hasBookmarkPermission: async () => true }));
vi.mock('../src/bookmark-subscriptions/runtime.js', () => ({
  subscriptionContext: async () => state.ctx,
  maintenance: { belongs: (r: LocalMapping, s: MaintenanceContext['scope']) => r.scope.accountId === s.accountId && r.scope.serverOrigin === s.serverOrigin && r.scope.profileId === s.profileId },
  subscriptionNative: { read: async (id: string) => ({ id, title: 'Bar' }) }, wakeSubscriptions: vi.fn(),
}));
import { handleSubscriptionRequest } from '../src/bookmark-subscriptions/worker.js';
import { createSubscriptionList, type ListResult } from '../src/subscriptions-ui/list.js';
import { database, row, scope } from './bookmark-subscriptions-fixture.js';
let host: HTMLElement, dispose: (() => void) | undefined;
beforeEach(() => {
  state.db = database(); document.body.replaceChildren();
  host = document.createElement('div'); document.body.append(host); vi.stubGlobal('chrome', {});
});
afterEach(async () => { dispose?.(); dispose = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); await state.db.close(); });
function local(alias = 'Saved mapping'): LocalMapping {
  const base = row(), id = crypto.randomUUID();
  return { ...base, id, mapping: { ...base.mapping, mappingId: id }, enabled: false, state: 'detached', localAlias: alias };
}
function ack(mappingId: string, patch: Partial<AckRecord> = {}): AckRecord {
  return { id: crypto.randomUUID(), scope, mappingId, generation: 'g1', result: 'kept', commandId: crypto.randomUUID(), pending: true, completedAt: Date.now(), evidence: [], ...patch };
}
function api(page: (query: URLSearchParams) => MappingPage = () => ({ items: [], nextCursor: null })) {
  const queries: URLSearchParams[] = [];
  state.ctx = { scope, assertCurrent: async () => {}, client: { request: (async path => {
    const url = new URL(path, scope.serverOrigin); let data: unknown;
    if (url.pathname.endsWith('subscription-mappings')) { queries.push(url.searchParams); data = page(url.searchParams); }
    else if (url.pathname.endsWith('capabilities')) data = { protocolVersion: 1, contentEnabled: true };
    else data = { items: [], nextCursor: null };
    return { status: 200, etag: null, data };
  }) as MaintenanceContext['client']['request'] } };
  return queries;
}
const send: Send = async <T>(command: SubscriptionCommand) => await handleSubscriptionRequest({ type: 'BOOKMARK_SUBSCRIPTIONS', requestId: crypto.randomUUID(), command }) as T;
const list = (command: SubscriptionCommand = { kind: 'list', scope: 'this_browser', status: 'live' }) => send<ListResult>(command);
const pending = () => host.querySelector('.subscription-pending-exits')!;
function render(params = new URLSearchParams(), history = false) { dispose = createSubscriptionList(host, send, vi.fn(), params, history).dispose; }

test('an empty server live page exposes only current account/profile pending exits with a single ACK scan', async () => {
  const mapping = local(); await state.db.put('mappings', mapping);
  const lost = ack(mapping.id, { scope: { ...scope, authorityGeneration: scope.authorityGeneration - 1 } });
  await state.db.put('acks', lost);
  for (let i = 0; i < 60; i++) { const history = local('History ' + i); await state.db.put('mappings', history); await state.db.put('acks', ack(history.id, { pending: false })); }
  for (const patch of [{ accountId: 'foreign' }, { serverOrigin: 'https://foreign.test' }, { profileId: 'foreign' }]) {
    const foreign = { ...local('Foreign private alias'), scope: { ...scope, ...patch } };
    await state.db.put('mappings', foreign); await state.db.put('acks', ack(foreign.id, { scope: foreign.scope }));
  }
  api(); const all = vi.spyOn(state.db, 'all'), operations = vi.spyOn(state.db, 'pendingOperations');
  const result = await list();
  expect(result.mappings.items).toEqual([]);
  expect(result.pendingExits).toEqual([{ id: lost.id, mappingId: mapping.id, generation: 'g1', result: 'kept', completedAt: lost.completedAt, localAlias: mapping.localAlias }]);
  expect(all.mock.calls.map(([table]) => table)).toEqual(['mappings', 'acks']);
  expect(operations).not.toHaveBeenCalled();
  expect(await state.db.get('acks', lost.id)).toEqual(lost);
  render(); await vi.waitFor(() => expect(pending().textContent).toContain('Waiting for Know-N to confirm'));
  expect(pending().textContent).toContain('Kept as your own bookmarks');
  expect(pending().textContent).not.toMatch(/Foreign|History/);
});

test('an ACK-only exit remains visible without a local mapping and disappears after ACK reconciliation', async () => {
  const receipt = ack(crypto.randomUUID(), { result: 'no_local_mount' });
  await state.db.put('acks', receipt); api();
  const timeout = vi.spyOn(globalThis, 'setTimeout'); render();
  await vi.waitFor(() => expect(pending().textContent).toContain('Removed subscription'));
  expect(pending().textContent).toContain('Wasn\'t added in this browser');
  expect(timeout.mock.calls.some(([, delay]) => delay === 5000)).toBe(true);
  expect(pending().querySelector('a')).toBeNull();
  await state.db.put('acks', { ...receipt, pending: false });
  host.querySelector<HTMLButtonElement>('button[aria-label="Reload"]')!.click();
  await vi.waitFor(() => expect(pending().children).toHaveLength(0));
});

test('pending exits survive the complete 50-row live pagination without duplicating later server rows', async () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ ...local('Live ' + i), state: 'terminating' as const }));
  for (const mapping of rows) await state.db.put('mappings', mapping);
  const late = ack(rows[49]!.id), orphan = ack(crypto.randomUUID(), { result: 'removed_access_lost' });
  await state.db.put('acks', late); await state.db.put('acks', orphan);
  const remote = rows.map(r => ({ ...r.mapping, sourceRef: r.source, source: null, availability: 'unavailable' as const }));
  const queries = api(q => q.has('cursor') ? { items: remote.slice(25), nextCursor: null } : { items: remote.slice(0, 25), nextCursor: 'remaining' });
  const all = vi.spyOn(state.db, 'all'); render();
  await vi.waitFor(() => expect(host.querySelectorAll('.subscription-rows .sub-row')).toHaveLength(50));
  expect(queries).toHaveLength(2);
  expect(pending().querySelectorAll('.list-row')).toHaveLength(1);
  expect(pending().textContent).toContain('Deleted (no longer available)');
  expect(pending().textContent).not.toContain(orphan.mappingId);
  expect(pending().textContent).not.toContain(late.mappingId);
  expect(pending().textContent).not.toContain('Live');
  expect(all.mock.calls.filter(([table]) => table === 'acks')).toHaveLength(2);
});

test.each([{ history: true, devices: 'this_browser' }, { history: false, devices: 'all_browsers' }])('does not merge local outbox entries into history or other-browser pagination: %j', async ({ history, devices }) => {
  await state.db.put('acks', ack(crypto.randomUUID())); api();
  const result = await list({ kind: 'list', scope: devices as 'this_browser' | 'all_browsers', status: history ? 'detached' : 'live' });
  expect(result.pendingExits).toEqual([]);
  render(new URLSearchParams({ devices }), history);
  await vi.waitFor(() => expect(host.textContent).toContain('No subscription folders match'));
  expect(pending().children).toHaveLength(0);
});

test('an old-generation receipt cannot mark a replacement mapping as pending or inherit its alias', async () => {
  const mapping = local('New generation private alias'); mapping.mapping.generation = 'g2';
  await state.db.put('mappings', mapping); await state.db.put('acks', ack(mapping.id));
  api(() => ({ items: [{ ...mapping.mapping, sourceRef: mapping.source, source: null, availability: 'unavailable' }], nextCursor: null }));
  const result = await list();
  expect(result.mappings.items[0]!.local?.ackPending).toBe(false);
  expect(result.pendingExits).toHaveLength(1);
  expect(result.pendingExits![0]).not.toHaveProperty('localAlias');
});

test('a session switch during list collection prevents returning stale local exit data', async () => {
  await state.db.put('acks', ack(crypto.randomUUID())); api();
  state.ctx.assertCurrent = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('subscription_scope_changed'));
  await expect(list()).rejects.toThrow('subscription_scope_changed');
});
