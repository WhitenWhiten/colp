import { createContentBindings } from '../src/site-adapters/content-bindings.js';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { checkRuleDraft } from '../src/automation/rule-conditions.js';
import { flattenList } from '../src/automation/rule-list-flatten.js';
import type { LocalRule, RuleListRecord } from '../src/automation/rule-list-record.js';
import { createSourceDatabase, sourceKey } from '../src/site-adapters/source-db.js';
import { createSourceLedger } from '../src/site-adapters/ledger.js';
import { createSourceLayout, type LayoutNativeNode } from '../src/site-adapters/layout.js';
import { createReadScheduler } from '../src/site-adapters/read-scheduler.js';
import { createSiteImporter } from '../src/site-adapters/import-coordinator.js';
import { createLiveSourcePlanner } from '../src/site-adapters/live-planner.js';
import { createPlannedSaveExecutor } from '../src/site-adapters/planned-executor.js';
import type { AdapterMessage, HostCommand, NativeBinding, PageResult, SavePlan } from '../src/site-adapters/contracts.js';
import type { SourceContext } from '../src/site-adapters/ledger-types.js';
import type { PlannedExecutionPorts, PlannedNativeResult } from '../src/site-adapters/planned-types.js';
import { video } from './fixtures/site-adapters/bilibili.js';
afterEach(() => vi.restoreAllMocks());
async function fixture(copies: import('../src/site-adapters/contracts.js').SavePolicy['copies'] = 'sourceAndSemantic') {
  let time = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => time);
  const db = createSourceDatabase(new IDBFactory()), ledger = createSourceLedger(db), storage = new MemoryStorageArea();
  const a = await ledger.setAuthority({ enabled: true, installationGeneration: 1, sourceSessionGeneration: 1, accountId: '42', negativeReadback: false });
  let context: SourceContext = { connectionId: a.connectionId!, documentId: 'doc', leaseId: 'lease', installationGeneration: 1, sourceSessionGeneration: 1, routeEpoch: 0, tabId: 1 };
  await ledger.bindLease(context, time + 10000000);
  const site = { version: 1, admission: { entries: ['siteImport', 'reconcile'], purpose: 'sourceArchive', connectionId: context.connectionId }, layout: { kind: 'sourceCollections', root: 'actionDestination' } } as const;
  const draft = { name: 'Archive', combinator: 'all', conditions: [{ kind: 'siteIs', value: 'www.bilibili.com' }], action: { kind: 'file', folderNativeId: 'root' }, site } as const;
  const checked = checkRuleDraft(draft); if (!checked.ok) throw new Error('draft');
  const rule: LocalRule = { id: 'rule', enabled: true, name: draft.name, combinator: draft.combinator, conditions: checked.conditions, action: draft.action, site,
    definition: checked.definition, compiledFrom: { contentVersions: {} }, createdAt: time, updatedAt: time };
  let record: RuleListRecord = { version: 3, revision: 1, enabled: true, entries: [{ kind: 'rule', rule }] };
  const nodes = new Map<string, LayoutNativeNode>([['root', { id: 'root', title: 'Root', dateAdded: 10 }]]);
  const content = createContentBindings(db, async (b, expected) => { const n = nodes.get(b.nativeId); if (!n || n.dateAdded !== b.dateAdded || expected && (n.title !== expected.title || n.parentId !== expected.parentId)) throw new Error('content_binding_needs_review'); });
  const layout = createSourceLayout(db, { sourceCopies: input => content.sourceDecision(input), rules: async () => flattenList(record), paused: async () => false, deviceId: async () => 'device',
    lookup: async id => nodes.get(id) ?? null, assertRoot: async b => { if (nodes.get(b.nativeId)?.dateAdded !== b.dateAdded) throw new Error('bindingUnavailable'); } });
  await layout.configure({ connectionId: context.connectionId, enabled: true, liveArchive: true, policy: { revision: 1, copies, backgroundClassification: 'disabled', sourceRemoval: 'retainArchive' } });
  const native = new Map<string, PlannedNativeResult>(), counts = { folder: 0, bookmark: 0 };
  const execution: PlannedExecutionPorts = {
    deviceId: async () => 'device', scope: async () => ({ serverOrigin: 'https://known.test', accountId: null, authorityGeneration: 1, collectionId: null }),
    authorize: (p, e) => layout.authorize(p, e), assertNative: async b => { if (nodes.get(b.nativeId)?.dateAdded !== b.dateAdded) throw new Error('bindingUnavailable'); },
    execute: async (c, _digest, authorize) => {
      if (native.has(c.commandId)) return native.get(c.commandId)!;
      await authorize(); counts[c.kind]++;
      const binding: NativeBinding = { nativeId: `native-${c.commandId}`, bindingId: c.commandId, deviceId: 'device', dateAdded: time,
        kind: c.kind, proof: { kind: 'writeReceipt', id: c.commandId } };
      nodes.set(binding.nativeId, { id: binding.nativeId, dateAdded: time, parentId: c.parent.nativeId, title: c.title, url: c.bookmark?.url });
      const result = { status: 'confirmed', native: binding } as const; native.set(c.commandId, result); return result;
    }, recover: async c => native.get(c.commandId) ?? null, acknowledge: async () => {},
  };
  const executor = createPlannedSaveExecutor(db, execution), sent: HostCommand[] = [];
  const ports = { source: async () => ({ context, expiresAt: time + 60000 }), send: (_: SourceContext, command: HostCommand) => { sent.push(command); },
    prioritizeLive: async () => {}, snapshot: async () => ({ browserRules: { storageVersion: 3 as const, listRevision: record.revision, contentVersions: {} }, policyRevision: 1 }),
    execute: (p: string, e: string) => executor.execute(p, e), alarm: (_: number) => {} };
  const scheduler = () => createReadScheduler(storage, 'queue');
  const create = () => createSiteImporter(ledger, layout, scheduler(), ports), importer = create();
  const reply = (command: Extract<HostCommand, { operation: 'readPage' }>, result: PageResult): AdapterMessage => ({ protocolVersion: 1,
    requestId: command.pageRequestId, leaseId: command.leaseId, capability: 'host-validated', operation: 'page.result', readSessionId: command.readSessionId, pageRequestId: command.pageRequestId, result });
  async function page(result: PageResult) {
    time += 2000; await importer.wake(); const c = sent.at(-1)!; if (c.operation !== 'readPage') throw new Error('noPage');
    const message = reply(c, result); const receipt = await importer.accept(context, message); expect(receipt?.status).toBe('accepted'); return message;
  }
  const catalog = { status: 'ok', kind: 'collections', page: { items: [{ id: '101', identity: 'siteId', title: 'B', parentId: null }, { id: '102', identity: 'siteId', title: 'C', parentId: null }],
    nextCursor: null, coverage: 'complete', consistency: 'bestEffort' } } as const;
  const items = (collectionId: string, aid = '1', partial = false): PageResult => ({ status: 'ok', kind: 'items', collectionId, page: { items: [{ item: { ...video, id: `video:av:${aid}`, url: `https://www.bilibili.com/video/av${aid}` } }],
    nextCursor: null, consistency: 'bestEffort', coverage: partial ? 'partial' : 'complete', ...(partial ? { omissions: [{ id: 'video:av:99', reason: 'invalid' }] } : {}) } });
  async function scan(partial = false) { const id = await importer.start(['101', '102']); await page(catalog); const b = await page(items('101')); await page(items('102', '2', partial)); return { id, b }; }
  async function freeze(id: string) { await importer.freeze(id); await importer.wake(); const status = await importer.status(); expect(status?.phase).toBe('preview'); return status!.preview!; }
  return { db, ledger, layout, importer, create, executor, execution, context: () => context, counts, nodes, sent, page, catalog, items, scan, freeze,
    changeRules: () => { record = { ...record, revision: record.revision + 1 }; },
    setRuleEnabled: (enabled: boolean) => { record = { ...record, revision: record.revision + 1, entries: [{ kind: 'rule', rule: { ...rule, enabled } }] }; },
    renew: async () => { context = { ...context, documentId: 'new-doc', leaseId: 'new-lease' }; await ledger.bindLease(context, time + 10000000); },
    advance: (ms = 2000) => { time += ms; } };
}
test('scan, page acknowledgment and a frozen partial preview authorize zero native writes; exact approval executes only covered effects', async () => {
  const f = await fixture(), { id, b } = await f.scan(true);
  expect(f.counts).toEqual({ folder: 0, bookmark: 0 });
  expect((await f.importer.accept(f.context(), b))?.status).toBe('duplicate');
  const preview = await f.freeze(id);
  expect(preview).toMatchObject({ coverage: 'partial', counts: { createFolders: 2, createBookmarks: 2, reuseBookmarks: 0 } });
  expect(f.counts).toEqual({ folder: 0, bookmark: 0 });
  await expect(f.importer.approve({ jobId: id, previewId: preview.id, revision: preview.revision, digest: 'wrong' })).rejects.toThrow('previewStale');
  await f.importer.approve({ jobId: id, previewId: preview.id, revision: preview.revision, digest: preview.digest });
  await f.importer.wake(); expect((await f.importer.status())?.phase).toBe('completed'); expect(f.counts).toEqual({ folder: 2, bookmark: 2 }); await f.db.close();
});
test('rule changes and live membership after freeze invalidate approval without expanding its collected set', async () => {
  const f = await fixture(), { id } = await f.scan(), p = await f.freeze(id);
  f.changeRules(); await expect(f.importer.approve({ jobId: id, previewId: p.id, revision: p.revision, digest: p.digest })).rejects.toThrow('previewStale');
  expect(f.counts).toEqual({ folder: 0, bookmark: 0 }); await f.db.close();
});
test('a live addition to an already scanned B remains independent, and shares its folder with the later import', async () => {
  const f = await fixture(), id = await f.importer.start(['101', '102']); await f.page(f.catalog); await f.page(f.items('101'));
  const item = { ...video, id: 'video:av:3', url: 'https://www.bilibili.com/video/av3' };
  const observation = await f.ledger.acceptObservation(f.context(), 'live', { type: 'membership.observed', item, memberships: { mode: 'delta', added: ['101'], removed: [] } });
  if (observation.status === 'rejected') throw new Error('observation');
  const live = await f.layout.plan({ context: f.context(), itemId: item.id, collectionId: '101', entry: 'reconcile', trigger: { kind: 'observation', observationId: observation.receiptId } });
  if (live.status !== 'planned') throw new Error('plan');
  for (const e of live.plan.effects) expect((await f.executor.execute(live.plan.id, e.effectId)).status).toBe('confirmed');
  await f.page(f.items('102', '2')); const p = await f.freeze(id);
  expect(p.counts).toMatchObject({ createFolders: 1, createBookmarks: 2 });
  await f.importer.approve({ jobId: id, previewId: p.id, revision: p.revision, digest: p.digest }); await f.importer.wake();
  expect(f.counts).toEqual({ folder: 2, bookmark: 3 }); await f.db.close();
});
test('restart-and-deduplicate repeats discovery with new requests, preserves accepted edges, and rejects the old page', async () => {
  const f = await fixture(), id = await f.importer.start(['101', '102']); await f.page(f.catalog); const b = await f.page(f.items('101'));
  await f.renew(); f.advance(); await f.importer.wake(); expect((await f.importer.status())?.phase).toBe('paused');
  await f.importer.resume(id); await f.page(f.catalog); await f.page(f.items('101')); await f.page(f.items('102', '2'));
  expect((await f.importer.status())?.edgeCount).toBe(2);
  expect((await f.importer.accept(f.context(), b))?.status).toBe('rejected');
  const p = await f.freeze(id); expect(p.counts.createBookmarks).toBe(2); expect(f.counts.bookmark).toBe(0); await f.db.close();
});
test('cancellation fences approved work and late pages cannot revive a frozen or cancelled campaign', async () => {
  const f = await fixture(), { id, b } = await f.scan(), p = await f.freeze(id);
  await f.importer.approve({ jobId: id, previewId: p.id, revision: p.revision, digest: p.digest }); await f.importer.cancel(id);
  await f.create().wake(); expect((await f.importer.status())?.phase).toBe('cancelled'); expect(f.counts).toEqual({ folder: 0, bookmark: 0 });
  expect((await f.importer.accept(f.context(), b))?.status).toBe('duplicate'); expect((await f.importer.status())?.phase).toBe('cancelled'); await f.db.close();
});
test('an unknown native result remains attention and never completes or creates a replacement', async () => {
  const f = await fixture(), { id } = await f.scan(), p = await f.freeze(id);
  f.execution.execute = async c => { if (!f.nodes.has('unknown')) { f.counts[c.kind]++; f.nodes.set('unknown', { id: 'unknown', title: c.title, dateAdded: Date.now() }); } return { status: 'unknown', reason: 'nativeOutcomeUnknown' }; };
  await f.importer.approve({ jobId: id, previewId: p.id, revision: p.revision, digest: p.digest }); await f.importer.wake();
  expect(await f.importer.status()).toMatchObject({ phase: 'attention', reason: 'nativeOutcomeUnknown' });
  await f.create().wake(); expect(f.counts.folder).toBe(1); await f.db.close();
});
test('cancelling discovery aborts its reader and fences an in-flight result before acknowledgment', async () => {
  const f = await fixture(), id = await f.importer.start(['101']); await f.importer.wake();
  const command = f.sent.at(-1)!; if (command.operation !== 'readPage') throw new Error('command');
  await f.importer.cancel(id);
  expect(f.sent.at(-1)).toEqual({ operation: 'cancelRead', readSessionId: id });
  const result = await f.importer.accept(f.context(), { protocolVersion: 1, operation: 'page.result', requestId: command.pageRequestId,
    leaseId: command.leaseId, capability: 'host-validated', readSessionId: id, pageRequestId: command.pageRequestId, result: f.catalog });
  expect(result?.status).toBe('rejected'); expect(await f.importer.status()).toMatchObject({ phase: 'cancelled', edgeCount: 0 });
  expect(f.counts).toEqual({ folder: 0, bookmark: 0 }); await f.db.close();
});
test('a live effect completed after freeze makes that preview stale, then a refreshed preview reuses the proven copy', async () => {
  const f = await fixture(), { id } = await f.scan(), p = await f.freeze(id);
  const receipt = await f.ledger.acceptObservation(f.context(), 'later-live', { type: 'membership.observed', item: video, memberships: { mode: 'delta', added: ['101'], removed: [] } });
  if (receipt.status === 'rejected') throw new Error('receipt');
  const live = await f.layout.plan({ context: f.context(), itemId: video.id, collectionId: '101', entry: 'reconcile', trigger: { kind: 'observation', observationId: receipt.receiptId } });
  if (live.status !== 'planned') throw new Error('live');
  for (const e of live.plan.effects) expect((await f.executor.execute(live.plan.id, e.effectId)).status).toBe('confirmed');
  await expect(f.importer.approve({ jobId: id, previewId: p.id, revision: p.revision, digest: p.digest })).rejects.toThrow('previewStale');
  const next = await f.freeze(id); expect(next.counts).toMatchObject({ createBookmarks: 1, reuseBookmarks: 1 });
  await f.importer.approve({ jobId: id, previewId: next.id, revision: next.revision, digest: next.digest }); await f.importer.wake();
  expect(f.counts).toEqual({ folder: 2, bookmark: 2 }); await f.db.close();
});
test('preview preparation checkpoints a bounded batch and resumes without new native objects or duplicate plans', async () => {
  const f = await fixture(), id = await f.importer.start(['101']); await f.page(f.catalog);
  const result: PageResult = { status: 'ok', kind: 'items', collectionId: '101', page: { items: Array.from({ length: 21 }, (_, i) => ({ item: { ...video, id: `video:av:${i + 1}`, url: `https://www.bilibili.com/video/av${i + 1}` } })),
    nextCursor: null, coverage: 'complete', consistency: 'bestEffort' } };
  await f.page(result); await f.importer.freeze(id); await f.importer.wake();
  expect(await f.importer.status()).toMatchObject({ phase: 'preparing', nextEdge: 20, preview: null });
  await f.create().wake(); expect(await f.importer.status()).toMatchObject({ phase: 'preview', nextEdge: 21, preview: { counts: { createBookmarks: 21, createFolders: 1 } } });
  expect(f.counts).toEqual({ folder: 0, bookmark: 0 }); await f.db.close();
});
test('live activation does not retroactively archive old observations, while settling retains durable replay receipts', async () => {
  const f = await fixture(); await f.scan();
  const o = { type: 'membership.observed', item: video, memberships: { mode: 'delta', added: ['101'], removed: [] } } as const;
  const old = await f.ledger.acceptObservation(f.context(), 'old', o); if (old.status === 'rejected') throw new Error('old');
  const ordinal = await f.db.read<number>('meta', 'ordinal');
  await f.layout.configure({ connectionId: f.context().connectionId, enabled: true, liveArchive: true, admittedAfterOrdinal: ordinal,
    policy: { revision: 2, copies: 'sourceAndSemantic', backgroundClassification: 'disabled', sourceRemoval: 'retainArchive' } });
  const fresh = await f.ledger.acceptObservation(f.context(), 'fresh', { ...o, item: { ...video, id: 'video:av:5', url: 'https://www.bilibili.com/video/av5' } });
  if (fresh.status === 'rejected') throw new Error('fresh');
  await createLiveSourcePlanner(f.db, f.layout, () => {}).wake();
  expect(await f.db.read('observations', old.receiptId)).toMatchObject({ state: 'settled', planning: { reason: 'beforeSourceActivation', planIds: [] } });
  const row = await f.db.read<{ planning: { planIds: string[] } }>('observations', fresh.receiptId); expect(row?.planning.planIds).toHaveLength(1);
  expect(await f.db.read('meta', 'pendingObservations')).toBe(0); expect(f.counts.bookmark).toBe(0);
  expect(await f.ledger.acceptObservation(f.context(), 'old', o)).toEqual({ ...old, status: 'duplicate' });
  expect(await f.db.read('meta', 'pendingObservations')).toBe(0); await f.db.close();
});
test('an individually paused source rule holds accepted live work for resumption', async () => {
  const f = await fixture(); await f.scan(); f.setRuleEnabled(false);
  const receipt = await f.ledger.acceptObservation(f.context(), 'held', { type: 'membership.observed', item: video, memberships: { mode: 'delta', added: ['101'], removed: [] } });
  if (receipt.status === 'rejected') throw new Error('receipt');
  const planner = createLiveSourcePlanner(f.db, f.layout, () => {}); await planner.wake();
  expect(await f.db.read('observations', receipt.receiptId)).toMatchObject({ state: 'pending' }); expect(f.counts.bookmark).toBe(0);
  f.setRuleEnabled(true); await planner.wake();
  expect(await f.db.read('observations', receipt.receiptId)).toMatchObject({ state: 'settled', planning: { reason: 'planned' } }); await f.db.close();
});
test('a missing collection on one live edge does not discard an independently admitted edge', async () => {
  const f = await fixture(); await f.scan();
  await f.db.transaction(['collections'], 'readwrite', async tx => { tx.objectStore('collections').delete(sourceKey(f.context().connectionId, '102')); });
  const receipt = await f.ledger.acceptObservation(f.context(), 'two-edges', { type: 'membership.observed', item: video, memberships: { mode: 'delta', added: ['102', '101'], removed: [] } });
  if (receipt.status === 'rejected') throw new Error('receipt');
  await createLiveSourcePlanner(f.db, f.layout, () => {}).wake();
  const row = await f.db.read<{ planning: { planIds: string[]; edges: { collectionId: string; status: string }[] } }>('observations', receipt.receiptId);
  expect(row?.planning.planIds).toHaveLength(1); expect(row?.planning.edges).toEqual([{ collectionId: '102', status: 'sourceFactsUnresolved' }, { collectionId: '101', status: 'planned' }]); await f.db.close();
});

test('single-copy source planning requires an eligible primary and reuses the confirmed copy for another edge', async () => {
  const f = await fixture('singleKeepExisting'); await f.scan();
  await f.ledger.acceptObservation(f.context(), 'multi', { type: 'membership.observed', item: video, memberships: { mode: 'delta', added: ['101', '102'], removed: [] } });
  const input = { context: f.context(), itemId: video.id, entry: 'reconcile' as const, trigger: { kind: 'observation' as const, observationId: 'multi' } };
  await expect(f.layout.plan({ ...input, collectionId: '101' })).rejects.toThrow('primarySourceCollectionRequired');
  await f.layout.configure({ connectionId: f.context().connectionId, enabled: true, liveArchive: true,
    policy: { revision: 2, copies: 'singleKeepExisting', primarySourceCollectionId: '101', backgroundClassification: 'disabled', sourceRemoval: 'retainArchive' } });
  expect((await f.layout.plan({ ...input, collectionId: '102' })).status).toBe('policySkipped');
  const plan = await f.layout.plan({ ...input, collectionId: '101' }); if (plan.status !== 'planned') throw new Error('plan');
  for (const e of plan.plan.effects) expect((await f.executor.execute(plan.plan.id, e.effectId)).status).toBe('confirmed');
  expect((await f.layout.plan({ ...input, collectionId: '102' })).status).toBe('represented');
  expect(f.counts).toEqual({ folder: 1, bookmark: 1 }); await f.db.close();
});

test('AI eligibility changes preserve confirmed folder reuse while fencing old plans', async () => {
  const f = await fixture(), { id } = await f.scan(), preview = await f.freeze(id);
  await f.importer.approve({ jobId: id, previewId: preview.id, revision: preview.revision, digest: preview.digest });
  await f.importer.wake();
  await f.layout.configureMount(f.context().connectionId, 'rule', 'allowed');
  const item = { ...video, id: 'video:av:3', url: 'https://www.bilibili.com/video/av3' };
  const receipt = await f.ledger.acceptObservation(f.context(), 'after-ai-change', { type: 'membership.observed', item, memberships: { mode: 'delta', added: ['101'], removed: [] } });
  if (receipt.status === 'rejected') throw new Error(receipt.reason);
  const result = await f.layout.plan({ context: f.context(), itemId: item.id, collectionId: '101', entry: 'reconcile', trigger: { kind: 'observation', observationId: receipt.receiptId } });
  if (result.status !== 'planned') throw new Error(result.status);
  for (const e of result.plan.effects) expect((await f.executor.execute(result.plan.id, e.effectId)).status).toBe('confirmed');
  expect(f.counts).toEqual({ folder: 2, bookmark: 3 });
  await f.layout.configureMount(f.context().connectionId, 'rule', 'excluded');
  await expect(f.layout.authorize(result.plan, result.plan.effects[0]!)).rejects.toThrow('mountChanged');
  await f.db.close();
});
