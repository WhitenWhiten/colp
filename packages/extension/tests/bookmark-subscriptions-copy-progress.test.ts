import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { SubscriptionStore } from '../src/bookmark-subscriptions/store.js';
import type { NativeExecutor } from '../src/bookmark-subscriptions/native.js';
import type { MaintenanceContext, createMaintenance } from '../src/bookmark-subscriptions/maintenance.js';
import type { CompletedCopy } from '../src/bookmark-subscriptions/local-types.js';
import type { ExitPreview } from '../src/bookmark-subscriptions/contracts.js';
import type { SubscriptionTransactionPorts } from '../../server/src/modules/bookmark-subscriptions/application/contracts.js';
const state = vi.hoisted(() => ({ db: undefined as unknown as SubscriptionStore,
  native: undefined as unknown as NativeExecutor, maintenance: undefined as unknown as ReturnType<typeof createMaintenance> }));
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
import { SubscriptionError } from '../src/bookmark-subscriptions/product-client.js';
import { database, nativeFixture, row, root, leaf, owned, scope } from './bookmark-subscriptions-fixture.js';
import { commitExit, saveExitPreview } from '../../server/src/modules/bookmark-subscriptions/application/exits.js';
import { createFixedWindowRateLimiter, consumeProductAdmission } from '../../server/src/transport/http-security.js';
beforeEach(() => { state.db = database(); });
afterEach(async () => { vi.restoreAllMocks(); await state.db.close(); });

async function scenario(count = 3) {
  const fixture = nativeFixture();
  const mapping = { ...row(), rootNativeId: 'source-root', state: 'local_change' as const, enabled: false, reserved: count };
  await state.db.put('mappings', mapping);
  for (const [i, node] of [root, ...Array.from({ length: count - 1 }, (_, i) => ({ ...leaf('content-' + i), index: i }))].entries()) {
    const id = i ? 'source-' + i : 'source-root', parent = i ? 'source-root' : 'bar';
    fixture.nodes.set(id, { id, parentId: parent, title: node.title, index: node.index, ...(node.url ? { url: node.url } : {}) });
    await state.db.put('nodes', owned(mapping, node, id, parent));
  }
  state.native = createNativeExecutor(state.db, fixture.api); state.maintenance = buildMaintenance(state.db, state.native);
  let now = Date.now(), topChecks = 0, nodeChecks = 0, quotaWaits = 0, denyAt = Infinity;
  let policy = 'remove', policyRevision = 'p1', remoteMapping = mapping.mapping;
  const tasks: unknown[] = [], snapshots = new Map<string, unknown>();
  const limiter = createFixedWindowRateLimiter({ maxRequests: 120, windowMs: 60000, now: () => now });
  const source = { ...mapping.source, subscriptionId: mapping.mapping.subscriptionId, status: 'active', revision: 's1' };
  const ports = { now: async () => new Date(now),
    preferences: async () => ({ revision: policyRevision, subscriptionOnUnsubscribe: policy }),
    sources: { check: async () => ({ available: true }) },
    store: { getMapping: async () => remoteMapping, getSubscription: async () => source, tasks: async () => tasks,
      savePreview: async (_: string, preview: ExitPreview, selectionRevision: string) => snapshots.set(preview.previewId, { preview, selectionRevision }),
      getPreview: async (_: string, id: string) => snapshots.get(id),
      saveTask: async (_: string, task: object) => { tasks.push(task); return task; },
      saveMapping: async (_: string, _source: unknown, value: typeof remoteMapping) => { remoteMapping = value; },
    },
  } as unknown as SubscriptionTransactionPorts;
  const actor = { accountId: scope.accountId, subjectId: 'subject' };
  const input = { trigger: 'unsubscribe' as const, target: { kind: 'mapping' as const, mappingId: mapping.id } };
  const request = async (path: string, options: { body?: unknown } = {}) => {
    let data: unknown;
    if (path.endsWith('exit-previews')) data = await saveExitPreview(ports, actor, input);
    else if (path.endsWith('subscription-exits')) {
      try { data = await commitExit(ports, actor, input, (options.body as { previewId: string }).previewId); }
      catch (error) { throw new SubscriptionError((error as { code: string }).code, 412); }
    } else {
      let admission = await consumeProductAdmission(limiter, 'subscription-read:' + scope.accountId);
      if (admission.kind === 'denied') { now += admission.retryAfterSeconds * 1000; quotaWaits++;
        admission = await consumeProductAdmission(limiter, 'subscription-read:' + scope.accountId); }
      expect(admission.kind).toBe('allowed');
      const fence = { mappingId: mapping.id, generation: 'g1', mappingRevision: 'r1',
        authorityRevision: 'a1', contentEnabled: true, state: 'available' };
      if (path.endsWith('node-access-checks')) { nodeChecks++; data = { ...fence, requestDigest: digest((options.body as { nodes: unknown }).nodes), removeNodes: [] }; }
      else { topChecks++; data = topChecks >= denyAt ? { ...fence, state: 'unavailable', reason: 'access_lost', cleanup: 'remove_managed' } : { ...fence, removeEditionIds: [] }; }
    }
    return { status: 200, etag: null, data };
  };
  const ctx = { scope, assertCurrent: async () => {}, client: { request } } as MaintenanceContext;
  const preview = async () => (await recoveryCommand(ctx, { kind: 'recoveryPreview', mappingId: mapping.id, expectedGeneration: 'g1', action: 'copy_detach' }, crypto.randomUUID())).data as { token: string; copyReused: boolean; exitPreview: ExitPreview };
  const confirm = (token: string) => recoveryCommand(ctx, { kind: 'recoveryConfirm', token }, crypto.randomUUID());
  const expireAfterCopy = () => {
    const complete = state.db.completeCopy.bind(state.db);
    vi.spyOn(state.db, 'completeCopy').mockImplementationOnce(async (...args) => { await complete(...args); now += 301000; });
  };
  return { fixture, mapping, ctx, tasks, preview, confirm, expireAfterCopy,
    counts: () => ({ topChecks, nodeChecks, quotaWaits }),
    changePolicy: () => { policy = 'keep'; policyRevision = 'p2'; }, revokeAt: (n: number) => { denyAt = n; } };
}

test('2049-node copy uses linear batch checks and exits within its real server preview under production quota', async () => {
  const s = await scenario(2049);
  const preview = await s.preview();
  await s.confirm(preview.token);
  expect(s.counts()).toEqual({ topChecks: 67, nodeChecks: 97, quotaWaits: 1 });
  expect(s.tasks).toHaveLength(1);
  const scan = (await state.db.get('meta', 'scan:' + s.mapping.id))?.value;
  expect(scan).toMatchObject({ complete: true, full: true });
  expect((await state.db.nodesForMapping(s.mapping.id)).some(n => n.copyTaskId)).toBe(false);
  // The bound is on server checks, not time: fake-indexeddb's linear index upkeep alone takes ~15 s here.
}, 180_000);

test('expired exit requires fresh user review and reuses a durable verified copy after restart', async () => {
  const s = await scenario(); s.expireAfterCopy();
  await expect(s.confirm((await s.preview()).token)).rejects.toThrow('precondition_failed');
  expect(s.tasks).toHaveLength(0);
  const originalCalls = [...s.fixture.calls];
  await state.db.close(); s.changePolicy();
  const reviewed = await s.preview();
  expect(reviewed.copyReused).toBe(true);
  expect(reviewed.exitPreview.targets[0]?.effectiveAction).toBe('keep');
  expect(s.tasks).toHaveLength(0);
  await s.confirm(reviewed.token);
  expect(s.tasks).toHaveLength(1);
  expect(s.fixture.calls).toEqual(originalCalls);
});

test('a changed source tree receives a new copy preview without writing before confirmation', async () => {
  const s = await scenario(); s.expireAfterCopy();
  await expect(s.confirm((await s.preview()).token)).rejects.toThrow('precondition_failed');
  s.fixture.nodes.get('source-1')!.title = 'New local edit';
  const calls = [...s.fixture.calls];
  expect((await s.preview()).copyReused).toBe(false);
  expect(s.fixture.calls).toEqual(calls); expect(s.tasks).toHaveLength(0);
});

test('a copy changed after re-review cannot authorize deletion of the original', async () => {
  const s = await scenario(); s.expireAfterCopy();
  await expect(s.confirm((await s.preview()).token)).rejects.toThrow('precondition_failed');
  const reviewed = await s.preview(); expect(reviewed.copyReused).toBe(true);
  const receipt = (await state.db.all('meta')).find(m => m.id.startsWith('copy-receipt:'))!.value as CompletedCopy;
  s.fixture.nodes.delete(receipt.nodes!.find(n => n.nativeId !== receipt.rootNativeId)!.nativeId);
  await expect(s.confirm(reviewed.token)).rejects.toThrow('local_copy_changed');
  expect(s.tasks).toHaveLength(0); expect(s.fixture.nodes.has('source-root')).toBe(true);
});

test('another login authority cannot reuse the prior authority completed copy', async () => {
  const s = await scenario(); s.expireAfterCopy();
  await expect(s.confirm((await s.preview()).token)).rejects.toThrow('precondition_failed');
  s.ctx.scope = { ...s.ctx.scope, authorityGeneration: 2 };
  expect((await s.preview()).copyReused).toBe(false);
});

test('revocation between copy batches prevents conversion and server exit', async () => {
  const s = await scenario(66); s.revokeAt(3);
  await expect(s.confirm((await s.preview()).token)).rejects.toThrow('source_unavailable');
  expect(s.tasks).toHaveLength(0);
  expect((await state.db.all('meta')).some(m => m.id.startsWith('copy-receipt:'))).toBe(false);
  expect(await state.db.get('mappings', s.mapping.id)).toMatchObject({ state: 'access_lost' });
});
