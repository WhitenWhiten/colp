import { legacySite } from '../src/site-adapters/registry.js';
import { createContentBindings } from '../src/site-adapters/content-bindings.js';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createSiteActivity } from '../src/site-adapters/activity.js';
import { checkRuleDraft } from '../src/automation/rule-conditions.js';
import { flattenList } from '../src/automation/rule-list-flatten.js';
import type { LocalRule, RuleListRecord } from '../src/automation/rule-list-record.js';
import { createSourceDatabase, sourceKey } from '../src/site-adapters/source-db.js';
import { createSourceLedger } from '../src/site-adapters/ledger.js';
import { createSourceLayout, type LayoutNativeNode, type LayoutPorts, type SourceMount } from '../src/site-adapters/layout.js';
import { createReadScheduler } from '../src/site-adapters/read-scheduler.js';
import { createSiteImporter } from '../src/site-adapters/import-coordinator.js';
import { createLiveSourcePlanner } from '../src/site-adapters/live-planner.js';
import { createPlannedSaveExecutor } from '../src/site-adapters/planned-executor.js';
import type { AdapterMessage, HostCommand, NativeBinding, PageResult, SavePlan } from '../src/site-adapters/contracts.js';
import type { SourceContext } from '../src/site-adapters/ledger-types.js';
import type { PlannedExecutionPorts, PlannedNativeResult } from '../src/site-adapters/planned-types.js';
import { video } from './fixtures/site-adapters/bilibili.js';
afterEach(() => vi.restoreAllMocks());
async function fixture(copies: import('../src/site-adapters/contracts.js').SavePolicy['copies'] = 'sourceAndSemantic', importResume: 'stableCursor' | 'restartAndDeduplicate' = 'restartAndDeduplicate') {
  let time = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => time);
  const db = createSourceDatabase(new IDBFactory()), ledger = createSourceLedger(db, {}, { ...legacySite, importResume }), storage = new MemoryStorageArea();
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
  const layoutPorts: LayoutPorts = { sourceCopies: input => content.sourceDecision(input), rules: async () => flattenList(record), paused: async () => false, deviceId: async () => 'device',
    lookup: async id => nodes.get(id) ?? null, assertRoot: async b => { if (nodes.get(b.nativeId)?.dateAdded !== b.dateAdded) throw new Error('bindingUnavailable'); } };
  const layout = createSourceLayout(db, layoutPorts);
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
  const activity = createSiteActivity(storage, legacySite, { extensionVersion: 'test' });
  const ports = { activity, source: async (): Promise<{ context: SourceContext; expiresAt: number } | null> => ({ context, expiresAt: time + 60000 }), send: (_: SourceContext, command: HostCommand) => { sent.push(command); },
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
  return { db, ledger, layout, layoutPorts, importer, create, executor, execution, activity, ports, context: () => context, counts, nodes, sent, page, catalog, items, scan, freeze,
    changeRules: () => { record = { ...record, revision: record.revision + 1 }; },
    setRuleEnabled: (enabled: boolean) => { record = { ...record, revision: record.revision + 1, entries: [{ kind: 'rule', rule: { ...rule, enabled } }] }; },
    renew: async (patch: Partial<SourceContext> = { documentId: 'new-doc' }) => { context = { ...context, leaseId: 'new-lease', ...patch }; await ledger.bindLease(context, time + 10000000); },
    advance: (ms = 2000) => { time += ms; } };
}
test('an unused legacy rule mapping adopts the configured root owner and imports into the same mapping identity', async () => {
  const f = await fixture(); try {
    const old = await f.layout.bindRoot(f.context().connectionId, 'rule', 'root');
    expect(old.destination).toBeUndefined();
    const destination = { serverOrigin: 'https://sync.test', accountId: 'owner', collectionId: 'library' };
    f.layoutPorts.destination = async () => destination;
    const configured = await f.layout.bindRoot(f.context().connectionId, 'configured-rule', 'root', true);
    expect(configured.id).not.toBe(old.id);
    const { id } = await f.scan(), preview = await f.freeze(id);
    expect(preview.counts).toMatchObject({ createBookmarks: 2, createFolders: 2, review: 0 });
    expect(await f.db.read<SourceMount>('mounts', sourceKey(f.context().connectionId, 'rule'))).toMatchObject({ id: configured.id, destination });
    expect(f.counts).toEqual({ folder: 0, bookmark: 0 });
    await f.importer.approve({ jobId: id, previewId: preview.id, revision: preview.revision, digest: preview.digest });
    await f.importer.wake();
    expect(await f.importer.status()).toMatchObject({ phase: 'completed', nextPlan: 2 });
    expect(f.counts).toEqual({ folder: 2, bookmark: 2 });
  } finally { await f.db.close(); }
});
test.each(['paused', 'attention', 'preview'] as const)('preparing a %s task after same-account renewal rebinds authority without a source tab or another scan', async phase => {
  const f = await fixture(); try {
    const { id } = await f.scan();
    if (phase === 'preview') await f.freeze(id);
    if (phase === 'attention') {
      const plan = vi.spyOn(f.layout, 'plan').mockRejectedValue(new Error('sourceDestinationNeedsReview'));
      await f.importer.wake(); plan.mockRestore();
    }
    await f.activity.record({ kind: 'problem', operation: 'read', taskId: id, code: 'sourceAuthorizationChanged' });
    await f.ledger.setAuthority({ enabled: true, accountId: '42', installationGeneration: 2, sourceSessionGeneration: 2, negativeReadback: false });
    const source = vi.spyOn(f.ports, 'source').mockResolvedValue(null);
    const preview = await f.freeze(id);
    expect(preview.counts).toMatchObject({ createBookmarks: 2, review: 0 });
    expect(await f.importer.status()).toMatchObject({ phase: 'preview', edgeCount: 2, pages: 3, authorization: 'current' });
    expect(source).not.toHaveBeenCalled(); expect(f.counts).toEqual({ folder: 0, bookmark: 0 });
    expect((await f.activity.list()).find(e => e.code === 'sourceAuthorizationChanged')?.resolvedAt).toBeDefined();
    await f.importer.approve({ jobId: id, previewId: preview.id, revision: preview.revision, digest: preview.digest });
    await f.importer.wake(); expect((await f.importer.status())?.phase).toBe('completed');
    expect(f.counts).toEqual({ folder: 2, bookmark: 2 });
  } finally { await f.db.close(); }
});
test('repreparing discovery for a different confirmed account refuses to adopt the old task', async () => {
  const f = await fixture(); try {
    const { id } = await f.scan();
    await f.ledger.setAuthority({ enabled: true, accountId: '43', installationGeneration: 2, sourceSessionGeneration: 2, negativeReadback: false });
    await expect(f.importer.freeze(id)).rejects.toThrow('sourceAccountChanged');
    expect((await f.importer.status())?.edgeCount).toBe(2); expect(f.counts).toEqual({ folder: 0, bookmark: 0 });
  } finally { await f.db.close(); }
});
test('renewal during an approved save retains confirmed folders, invalidates the old approval and requires a new confirmation', async () => {
  const f = await fixture(); try {
    const { id } = await f.scan(), preview = await f.freeze(id);
    const approval = await f.importer.approve({ jobId: id, previewId: preview.id, revision: preview.revision, digest: preview.digest });
    const original = f.execution.execute;
    vi.spyOn(f.execution, 'execute').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      await f.ledger.setAuthority({ enabled: true, accountId: '42', installationGeneration: 2, sourceSessionGeneration: 2, negativeReadback: false });
      return result;
    });
    await f.importer.wake();
    expect(await f.importer.status()).toMatchObject({ phase: 'attention', reason: 'sourceAuthorizationChanged', authorization: 'renewed' });
    expect(f.counts).toEqual({ folder: 1, bookmark: 0 });
    const refreshed = await f.freeze(id);
    expect(await f.db.read('importApprovals', approval)).toMatchObject({ state: 'cancelled' });
    expect(f.counts).toEqual({ folder: 1, bookmark: 0 });
    await f.importer.approve({ jobId: id, previewId: refreshed.id, revision: refreshed.revision, digest: refreshed.digest });
    await f.importer.wake(); expect((await f.importer.status())?.phase).toBe('completed');
    expect(f.counts).toEqual({ folder: 2, bookmark: 2 });
  } finally { await f.db.close(); }
});
test('all 4917 retained favorites across 22 collections recover after renewal and save without another website read', async () => {
  const f = await fixture(); try {
    const started = performance.now();
    // fake-indexeddb 6 retains every finished transaction and rescans that
    // history for each new request. Collect only finished emulator objects;
    // pending transactions, data and all production authorization stay intact.
    const native = await f.db.open() as IDBDatabase & { _rawDatabase: { transactions: { _state: string }[] } };
    const transaction = f.db.transaction.bind(f.db);
    f.db.transaction = ((...args: Parameters<typeof transaction>) => {
      native._rawDatabase.transactions = native._rawDatabase.transactions.filter(tx => tx._state !== 'finished');
      return transaction(...args);
    }) as typeof f.db.transaction;
    const collections = Array.from({ length: 22 }, (_, i) => ({ id: String(101 + i), identity: 'siteId' as const, title: `Collection ${i + 1}`, parentId: null }));
    const id = await f.importer.start(collections.map(c => c.id));
    // Restore retained host facts, matching the reported old task. Website
    // extraction is covered separately; this test exercises the entire recovery/save path.
    await f.db.transaction(['meta', 'items', 'collections', 'memberships', 'importPages'], 'readwrite', async tx => {
      let itemNumber = 0; const context = f.context();
      for (const [index, collection] of collections.entries()) {
        tx.objectStore('collections').put({ entity: collection, ordinal: 1 }, sourceKey(context.connectionId, collection.id));
        for (let number = 0; number < 223 + (index < 11 ? 1 : 0); number++) {
          const aid = ++itemNumber, item = { ...video, id: `video:av:${aid}`, url: `https://www.bilibili.com/video/av${aid}` };
          tx.objectStore('items').put({ entity: item, ordinal: 1 }, sourceKey(context.connectionId, item.id));
          tx.objectStore('memberships').put({ connectionId: context.connectionId, itemId: item.id, collectionId: collection.id,
            state: 'present', ordinal: 1, liveOrdinal: 0, evidence: 'import', observationId: `receipt-${aid}`, conflicts: [] }, sourceKey(context.connectionId, item.id, collection.id));
          tx.objectStore('importPages').put({ kind: 'collectedEdge', collectionId: collection.id, itemId: item.id }, sourceKey('edge', id, collection.id, item.id));
        }
      }
      const job = await new Promise<any>(resolve => { const request = tx.objectStore('meta').get(`importJob:${id}`); request.onsuccess = () => resolve(request.result); });
      tx.objectStore('meta').put({ ...job, phase: 'attention', reason: 'sourceDestinationNeedsReview', stage: 'items', found: collections.map(c => c.id),
        collectionIndex: 22, edgeCount: 4917, pages: 103, scanComplete: true }, `importJob:${id}`);
    });
    expect(await f.importer.status()).toMatchObject({ phase: 'attention', edgeCount: 4917 });
    await f.ledger.setAuthority({ enabled: true, accountId: '42', installationGeneration: 2, sourceSessionGeneration: 2, negativeReadback: false });
    const source = vi.spyOn(f.ports, 'source').mockResolvedValue(null);
    await f.importer.freeze(id);
    for (let batch = 0; batch < 247 && (await f.importer.status())?.phase === 'preparing'; batch++) await f.importer.wake();
    console.info('4917-item regression: plans prepared in', Math.round(performance.now() - started), 'ms');
    const ready = (await f.importer.status())!, preview = ready.preview!;
    expect(ready.phase).toBe('preview'); expect(preview.counts).toEqual({ createBookmarks: 4917, createFolders: 22, reuseBookmarks: 0, review: 0 });
    expect(f.counts).toEqual({ folder: 0, bookmark: 0 });
    await f.importer.approve({ jobId: id, previewId: preview.id, revision: preview.revision, digest: preview.digest });
    console.info('4917-item regression: approval validated in', Math.round(performance.now() - started), 'ms');
    for (let batch = 0; batch < 492 && (await f.importer.status())?.phase === 'approved'; batch++) await f.importer.wake();
    expect(await f.importer.status()).toMatchObject({ phase: 'completed', nextPlan: 4917, authorization: 'current' });
    expect(f.counts).toEqual({ folder: 22, bookmark: 4917 }); expect(source).not.toHaveBeenCalled();
  } finally { await f.db.close(); }
}, 120000);
test('a mapping failure pauses preparation once instead of turning every video into an item review', async () => {
  const f = await fixture(); try {
    await f.scan();
    const plan = vi.spyOn(f.layout, 'plan').mockRejectedValue(new Error('sourceDestinationNeedsReview'));
    await f.importer.wake();
    expect(await f.importer.status()).toMatchObject({ phase: 'attention', reason: 'sourceDestinationNeedsReview', edgeCount: 2, nextEdge: 0, preview: null });
    expect(plan).toHaveBeenCalledOnce(); expect(f.counts).toEqual({ folder: 0, bookmark: 0 });
    plan.mockRestore();
    const status = (await f.importer.status())!, preview = await f.freeze(status.id);
    expect(preview.counts).toMatchObject({ createBookmarks: 2, review: 0 });
    expect((await f.importer.status())?.pages).toBe(3);
  } finally { await f.db.close(); }
});
test('a repeated unchanged catalog does not invalidate approval while real source content changes still do', async () => {
  const f = await fixture(); try {
    const { id } = await f.scan(), preview = await f.freeze(id);
    await f.ledger.acceptCatalog(f.context(), 'automatic-catalog-refresh', f.catalog.page.items);
    await f.importer.approve({ jobId: id, previewId: preview.id, revision: preview.revision, digest: preview.digest });
    await f.importer.wake(); expect((await f.importer.status())?.phase).toBe('completed');
    const next = await f.importer.start(['101']); await f.page(f.catalog); await f.page(f.items('101', '3'));
    const changed = await f.freeze(next);
    await f.ledger.acceptCatalog(f.context(), 'real-catalog-change', [{ ...f.catalog.page.items[0], title: 'Changed collection' }]);
    await expect(f.importer.approve({ jobId: next, previewId: changed.id, revision: changed.revision, digest: changed.digest })).rejects.toThrow('previewStale');
  } finally { await f.db.close(); }
});
test('batched approval still checks every item when several plans share one folder', async () => {
  const f = await fixture(); try {
    const id = await f.importer.start(['101']); await f.page(f.catalog);
    const first = f.items('101'); if (first.status !== 'ok' || first.kind !== 'items') throw new Error('items');
    const second = { ...video, id: 'video:av:2', url: 'https://www.bilibili.com/video/av2' };
    await f.page({ ...first, page: { ...first.page, items: [...first.page.items, { item: second }] } });
    const preview = await f.freeze(id);
    await f.db.transaction(['items'], 'readwrite', async tx => {
      tx.objectStore('items').put({ entity: { ...second, title: 'Changed after preview' }, ordinal: 100 }, sourceKey(f.context().connectionId, second.id));
    });
    await expect(f.importer.approve({ jobId: id, previewId: preview.id, revision: preview.revision, digest: preview.digest })).rejects.toThrow('previewStale');
    expect(f.counts).toEqual({ folder: 0, bookmark: 0 });
  } finally { await f.db.close(); }
});
test.each(['present', 'absent'] as const)('fresh membership receipts for an %s item are judged by facts instead of bookkeeping timestamps', async state => {
  const f = await fixture(); try {
    const { id } = await f.scan(), preview = await f.freeze(id);
    await f.ledger.acceptObservation(f.context(), 'fresh-read-confirmation', { type: 'membership.observed', item: video,
      memberships: { mode: 'delta', added: state === 'present' ? ['101'] : [], removed: state === 'absent' ? ['101'] : [] } });
    const approve = () => f.importer.approve({ jobId: id, previewId: preview.id, revision: preview.revision, digest: preview.digest });
    if (state === 'absent') { await expect(approve()).rejects.toThrow('previewStale'); expect(f.counts).toEqual({ folder: 0, bookmark: 0 }); }
    else { await approve(); await f.importer.wake(); expect((await f.importer.status())?.phase).toBe('completed'); expect(f.counts.bookmark).toBe(2); }
  } finally { await f.db.close(); }
});
test('old blocked previews expose all refusal counts and cannot be approved as an empty successful import', async () => {
  const f = await fixture(); try {
    const { id } = await f.scan(); vi.spyOn(f.layout, 'plan').mockResolvedValue({ status: 'policySkipped' });
    const preview = await f.freeze(id);
    await f.db.transaction(['importPreviews', 'importPages'], 'readwrite', async tx => {
      const p = await new Promise<any>(resolve => { const r = tx.objectStore('importPreviews').get(preview.id); r.onsuccess = () => resolve(r.result); });
      delete p.reviewCounts;
      for (const sample of p.reviewSamples) {
        sample.reason = 'sourceDestinationNeedsReview';
        const key = sourceKey('frozenEdge', p.id, sample.collectionId, sample.itemId);
        const row = await new Promise<any>(resolve => { const r = tx.objectStore('importPages').get(key); r.onsuccess = () => resolve(r.result); });
        tx.objectStore('importPages').put({ ...row, reviewReason: sample.reason }, key);
      }
      tx.objectStore('importPreviews').put(p, p.id);
    });
    expect((await f.importer.status())?.preview?.reviewCounts).toEqual({ sourceDestinationNeedsReview: 2 });
    await expect(f.importer.approve({ jobId: id, previewId: preview.id, revision: preview.revision, digest: preview.digest })).rejects.toThrow('sourceDestinationNeedsReview');
    expect((await f.importer.status())?.phase).toBe('preview'); expect(f.counts).toEqual({ folder: 0, bookmark: 0 });
  } finally { await f.db.close(); }
});
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
test.each(['sourceSyncPending', 'sourceSyncRecovering'])('approved shared saves wait for %s and resume without another approval or duplicate native effects', async reason => {
  const f = await fixture(); try {
    const { id } = await f.scan(), preview = await f.freeze(id);
    await f.importer.approve({ jobId: id, previewId: preview.id, revision: preview.revision, digest: preview.digest });
    vi.spyOn(f.execution, 'execute').mockResolvedValueOnce({ status: 'unknown', reason });
    await f.importer.wake();
    expect(await f.importer.status()).toMatchObject({ phase: 'approved', reason, nextPlan: 0 });
    expect(f.counts).toEqual({ folder: 0, bookmark: 0 });
    await f.importer.wake();
    expect((await f.importer.status())?.phase).toBe('completed');
    expect(f.counts).toEqual({ folder: 2, bookmark: 2 });
  } finally { await f.db.close(); }
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
test('temporary lease renewal preserves a document-local cursor and accepted progress without pausing', async () => {
  const f = await fixture(); try {
    await f.importer.start(['101']); await f.page(f.catalog);
    const first = f.items('101'); if (first.status !== 'ok' || first.kind !== 'items') throw new Error('items');
    const previous = await f.page({ ...first, page: { ...first.page, nextCursor: 'document-cursor' } });
    vi.spyOn(f.ports, 'source').mockResolvedValueOnce(null);
    f.advance(); await f.importer.wake();
    expect(await f.importer.status()).toMatchObject({ phase: 'scanning', reason: 'reconnectingSource', edgeCount: 1, cursor: 'document-cursor' });
    await f.renew({}); f.advance(); await f.importer.wake();
    expect(f.sent.at(-1)).toMatchObject({ operation: 'readPage', leaseId: 'new-lease', query: { kind: 'items', collectionId: '101', cursor: 'document-cursor' } });
    expect(await f.importer.status()).toMatchObject({ phase: 'scanning', reason: null, edgeCount: 1 });
    await f.page(f.items('101', '2')); await f.importer.wake();
    expect(await f.importer.status()).toMatchObject({ phase: 'preview', edgeCount: 2, preview: { counts: { createBookmarks: 2 } } });
    expect((await f.importer.accept(f.context(), previous))?.status).toBe('rejected');
    expect((await f.activity.list()).filter(event => event.kind === 'problem')).toEqual([]);
    expect(f.counts).toEqual({ folder: 0, bookmark: 0 });
  } finally { await f.db.close(); }
});
test.each([[2, 1], [1, 2], [2, 2]])('a confirmed same-account reconnection adopts generations %i/%i without losing progress or accepting the old page', async (installationGeneration, sourceSessionGeneration) => {
  const f = await fixture(); try {
    const id = await f.importer.start(['101', '102']); await f.page(f.catalog);
    const first = f.items('101'); if (first.status !== 'ok' || first.kind !== 'items') throw new Error('items');
    await f.page({ ...first, page: { ...first.page, nextCursor: 'old-cursor' } });
    f.advance(); await f.importer.wake();
    const oldContext = f.context(), outstanding = f.sent.at(-1)!;
    if (outstanding.operation !== 'readPage') throw new Error('noPage');
    const authority = await f.ledger.setAuthority({ enabled: true, accountId: '42', installationGeneration, sourceSessionGeneration, negativeReadback: false });
    expect(authority.connectionId).toBe(oldContext.connectionId);
    await f.renew({ installationGeneration, sourceSessionGeneration });
    await f.importer.wake();
    expect(await f.importer.status()).toMatchObject({ id, phase: 'paused', reason: 'sourceAuthorizationChanged', edgeCount: 1 });
    await f.create().resume(id);
    expect(await f.importer.status()).toMatchObject({ id, phase: 'scanning', edgeCount: 1, cursor: null });
    expect(f.sent.at(-1)).toEqual({ operation: 'cancelRead', readSessionId: id });
    const late = await f.importer.accept(oldContext, { protocolVersion: 1, operation: 'page.result', requestId: outstanding.pageRequestId,
      leaseId: outstanding.leaseId, capability: 'host-validated', readSessionId: id, pageRequestId: outstanding.pageRequestId, result: f.items('101', '99') });
    expect(late).toMatchObject({ status: 'rejected', reason: 'staleContext' });
    await f.page(f.catalog); await f.page(f.items('101')); await f.page(f.items('102', '2'));
    const preview = await f.freeze(id);
    expect(preview.counts).toMatchObject({ createBookmarks: 2, createFolders: 2 });
    expect(f.counts).toEqual({ folder: 0, bookmark: 0 });
    expect((await f.activity.list()).find(e => e.code === 'sourceAuthorizationChanged')?.resolution).toBe('recovered');
  } finally { await f.db.close(); }
});
test('resuming refuses a different confirmed account and preserves the original paused task', async () => {
  const f = await fixture(); try {
    const id = await f.importer.start(['101']); await f.page(f.catalog); await f.page(f.items('101'));
    const other = await f.ledger.setAuthority({ enabled: true, accountId: '43', installationGeneration: 2, sourceSessionGeneration: 2, negativeReadback: false });
    await f.renew({ connectionId: other.connectionId!, installationGeneration: 2, sourceSessionGeneration: 2 });
    // scanFinished is still discovery and must not cross the account boundary.
    await expect(f.importer.resume(id)).rejects.toThrow('sourceAccountChanged');
    expect(await f.importer.status()).toMatchObject({ id, phase: 'paused', edgeCount: 1 });
    expect(f.counts).toEqual({ folder: 0, bookmark: 0 });
  } finally { await f.db.close(); }
});
test('resuming reports a missing page precisely and revalidates the current lease inside the transaction', async () => {
  const f = await fixture(); try {
    const id = await f.importer.start(['101']); await f.page(f.catalog); await f.page(f.items('101'));
    const source = vi.spyOn(f.ports, 'source').mockResolvedValueOnce(null);
    await expect(f.importer.resume(id)).rejects.toThrow('pageUnavailable');
    await f.ledger.revokeLease(f.context().leaseId);
    source.mockRestore();
    await expect(f.importer.resume(id)).rejects.toThrow('staleContext');
    expect(await f.importer.status()).toMatchObject({ phase: 'paused', edgeCount: 1 });
    expect(f.counts).toEqual({ folder: 0, bookmark: 0 });
  } finally { await f.db.close(); }
});
test('an unavailable import document pauses after the bounded reconnection window and preserves accepted progress', async () => {
  const f = await fixture(); try {
    await f.importer.start(['101']); await f.page(f.catalog);
    const first = f.items('101'); if (first.status !== 'ok' || first.kind !== 'items') throw new Error('items');
    await f.page({ ...first, page: { ...first.page, nextCursor: 'document-cursor' } });
    const source = vi.spyOn(f.ports, 'source').mockResolvedValue(null);
    f.advance(); await f.importer.wake();
    expect(await f.importer.status()).toMatchObject({ phase: 'scanning', reason: 'reconnectingSource' });
    f.advance(30001); await f.importer.wake();
    expect(await f.importer.status()).toMatchObject({ phase: 'paused', reason: 'pageUnavailable', edgeCount: 1, cursor: 'document-cursor' });
    source.mockRestore(); await f.importer.resume((await f.importer.status())!.id);
    vi.spyOn(f.ports, 'source').mockResolvedValueOnce(null);
    f.advance(); await f.importer.wake();
    expect(await f.importer.status()).toMatchObject({ phase: 'scanning', reason: 'reconnectingSource', edgeCount: 1 });
    expect(f.counts).toEqual({ folder: 0, bookmark: 0 });
  } finally { await f.db.close(); }
});
test('cancellation fences approved work and late pages cannot revive a frozen or cancelled campaign', async () => {
  const f = await fixture(), { id, b } = await f.scan(), p = await f.freeze(id);
  await f.importer.approve({ jobId: id, previewId: p.id, revision: p.revision, digest: p.digest }); await f.importer.cancel(id);
  await f.create().wake(); expect((await f.importer.status())?.phase).toBe('cancelled'); expect(f.counts).toEqual({ folder: 0, bookmark: 0 });
  expect((await f.importer.accept(f.context(), b))?.status).toBe('duplicate'); expect((await f.importer.status())?.phase).toBe('cancelled'); await f.db.close();
});
test('a new check after cancellation reads a fresh scope and writes only after its own approval', async () => {
  const f = await fixture(); try {
    const old = await f.scan(true);
    await f.importer.cancel(old.id);
    const id = await f.importer.start(['102']);
    expect(id).not.toBe(old.id);
    expect(await f.importer.status()).toMatchObject({ id, phase: 'scanning', edgeCount: 0, pages: 0, omissions: 0, preview: null });
    await f.page(f.catalog); await f.page(f.items('102', '2'));
    const preview = await f.freeze(id);
    expect(preview.counts).toMatchObject({ createFolders: 1, createBookmarks: 1 });
    expect(f.counts).toEqual({ folder: 0, bookmark: 0 });
    await f.importer.approve({ jobId: id, previewId: preview.id, revision: preview.revision, digest: preview.digest });
    await f.importer.wake();
    expect((await f.importer.status())?.phase).toBe('completed');
    expect(f.counts).toEqual({ folder: 1, bookmark: 1 });
  } finally { await f.db.close(); }
});
test('background wake prepares a completed scan without the settings page and counts skips separately from saves', async () => {
  const f = await fixture(); try {
    await f.scan(true);
    expect(await f.importer.status()).toMatchObject({ phase: 'paused', reason: 'scanFinished', omissionCounts: { invalid: 1 },
      progress: { collectionsRead: 2, collectionsTotal: 2, prepared: 0, saved: 0, toSave: 0 } });
    await f.create().wake();
    const status = await f.importer.status();
    expect(status).toMatchObject({ phase: 'preview', progress: { prepared: 2, saved: 0, toSave: 2 },
      preview: { coverage: 'partial', counts: { createBookmarks: 2, review: 0 }, omissions: { unscannedRemainder: false } } });
    expect(f.counts).toEqual({ folder: 0, bookmark: 0 });
    const preview = status!.preview!;
    await f.importer.approve({ jobId: status!.id, previewId: preview.id, revision: preview.revision, digest: preview.digest });
    await f.importer.wake();
    expect(await f.importer.status()).toMatchObject({ phase: 'completed', progress: { saved: 2, toSave: 2 } });
  } finally { await f.db.close(); }
});
test('a collection containing only deleted videos produces an empty finishable preview without blocking or creating folders', async () => {
  const f = await fixture(); try {
    const id = await f.importer.start(['101']);
    await f.page(f.catalog);
    await f.page({ status: 'ok', kind: 'items', collectionId: '101', page: { items: [], nextCursor: null, coverage: 'partial', consistency: 'bestEffort',
      omissions: [{ id: 'video:av:9', reason: 'invalid' }] } });
    await f.create().wake();
    const status = await f.importer.status(), preview = status!.preview!;
    expect(status).toMatchObject({ phase: 'preview', scanComplete: true, omissions: 1, omissionCounts: { invalid: 1 } });
    expect(preview.counts).toEqual({ createFolders: 0, createBookmarks: 0, reuseBookmarks: 0, review: 0 });
    await f.importer.approve({ jobId: id, previewId: preview.id, revision: preview.revision, digest: preview.digest });
    await f.importer.wake();
    expect((await f.importer.status())?.phase).toBe('completed');
    expect(f.counts).toEqual({ folder: 0, bookmark: 0 });
  } finally { await f.db.close(); }
});
test('live collection titles and failed requests remain distinct from automatically skipped deleted items', async () => {
  const f = await fixture(); try {
    await f.importer.start(['101', '102']); await f.page(f.catalog);
    expect(await f.importer.status()).toMatchObject({ progress: { collectionsRead: 0, collectionsTotal: 2, currentCollection: 'B' } });
    await f.page({ status: 'failed', error: { code: 'rateLimited' } });
    expect(await f.importer.status()).toMatchObject({ phase: 'paused', reason: 'rateLimited', omissionCounts: { failed: 1 }, progress: { saved: 0 } });
    await f.importer.wake();
    expect((await f.importer.status())?.phase).toBe('paused');
    expect(f.counts).toEqual({ folder: 0, bookmark: 0 });
  } finally { await f.db.close(); }
});
test('planning refusals have readable source context and redacted reasons in the durable task report', async () => {
  const f = await fixture(); try {
    const { id } = await f.scan();
    vi.spyOn(f.layout, 'plan').mockResolvedValueOnce({ status: 'policySkipped' });
    const preview = await f.freeze(id), sample = (await f.importer.status())!.preview!.reviewSamples![0]!;
    expect(sample).toMatchObject({ itemTitle: video.title, collectionTitle: 'B', reason: 'policySkipped' });
    expect(preview.counts).toMatchObject({ createBookmarks: 1, review: 1 });
    await f.importer.approve({ jobId: id, previewId: preview.id, revision: preview.revision, digest: preview.digest });
    await f.importer.wake();
    expect((await f.importer.status())?.phase).toBe('attention');
    const incident = (await f.activity.list()).find(e => e.code === 'sourceReviewRequired')!;
    expect(incident.review).toEqual([{ code: 'policySkipped', itemRef: expect.any(String), collectionRef: expect.any(String) }]);
    const report = JSON.stringify(await f.activity.report(incident.id));
    expect(report).not.toContain(video.title); expect(report).not.toContain(sample.itemId);
    await f.freeze(id);
    expect((await f.activity.report(incident.id)).incident?.resolution).toBe('dismissed');
  } finally { await f.db.close(); }
});
test('an unknown native result remains attention and never completes or creates a replacement', async () => {
  const f = await fixture(), { id } = await f.scan(), p = await f.freeze(id);
  f.execution.execute = async c => { if (!f.nodes.has('unknown')) { f.counts[c.kind]++; f.nodes.set('unknown', { id: 'unknown', title: c.title, dateAdded: Date.now() }); } return { status: 'unknown', reason: 'nativeOutcomeUnknown' }; };
  await f.importer.approve({ jobId: id, previewId: p.id, revision: p.revision, digest: p.digest }); await f.importer.wake();
  expect(await f.importer.status()).toMatchObject({ phase: 'attention', reason: 'nativeOutcomeUnknown' });
  await f.create().wake(); expect(f.counts.folder).toBe(1); await f.db.close();
});
test('retrying approved work checks the original native command, preserves its approval, and never replaces an uncertain write', async () => {
  const f = await fixture(); try {
    const { id } = await f.scan(), preview = await f.freeze(id), original = f.execution.execute;
    const approval = await f.importer.approve({ jobId: id, previewId: preview.id, revision: preview.revision, digest: preview.digest });
    vi.spyOn(f.execution, 'execute').mockImplementationOnce(async (command, digest, authorize) => {
      await original(command, digest, authorize); return { status: 'unknown', reason: 'nativeOutcomeUnknown' };
    });
    await f.importer.wake();
    expect(await f.importer.status()).toMatchObject({ phase: 'attention', nextPlan: 0, approvalId: approval });
    expect(f.counts).toEqual({ folder: 1, bookmark: 0 });
    const recover = vi.spyOn(f.execution, 'recover').mockResolvedValueOnce({ status: 'unknown', reason: 'nativeOutcomeUnknown' });
    await f.importer.retry(id); await f.importer.wake();
    expect((await f.importer.status())?.phase).toBe('attention');
    expect(f.counts).toEqual({ folder: 1, bookmark: 0 });
    recover.mockRestore();
    await f.importer.retry(id); await f.importer.wake();
    expect(await f.importer.status()).toMatchObject({ phase: 'completed', approvalId: approval, nextPlan: 2 });
    expect(f.counts).toEqual({ folder: 2, bookmark: 2 });
    await expect(f.importer.retry(id)).rejects.toThrow('importChanged');
  } finally { await f.db.close(); }
});
test('continuing approved work refuses changed rules and a cancelled approval without writing', async () => {
  const f = await fixture(); try {
    const { id } = await f.scan(), preview = await f.freeze(id);
    await f.importer.approve({ jobId: id, previewId: preview.id, revision: preview.revision, digest: preview.digest });
    vi.spyOn(f.execution, 'execute').mockResolvedValueOnce({ status: 'unknown', reason: 'nativeOutcomeUnknown' });
    await f.importer.wake();
    f.changeRules();
    await expect(f.importer.retry(id)).rejects.toThrow('previewStale');
    await f.importer.cancel(id);
    await expect(f.importer.retry(id)).rejects.toThrow('importChanged');
    expect(f.counts).toEqual({ folder: 0, bookmark: 0 });
  } finally { await f.db.close(); }
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

test('cancelled unapproved previews release single-copy reservations for semantic saves', async () => {
  const f = await fixture('singlePreferSemantic'), { id } = await f.scan(), preview = await f.freeze(id);
  expect(preview.counts.createBookmarks).toBe(2);
  await f.importer.cancel(id);
  const bindings = createContentBindings(f.db, async () => {});
  const binding = await bindings.prepare({ itemId: video.id, commandId: 'semantic-after-cancel', captureIntentId: 'capture-after-cancel', title: video.title, url: video.url, parentId: 'root', automatic: true });
  expect(binding).toMatchObject({ mode: 'create', state: 'pending' });
  expect(f.counts).toEqual({ folder: 0, bookmark: 0 });
  await f.db.close();
});

test('cancelling one draft retains another plan sharing its native command', async () => {
  const f = await fixture(), { id } = await f.scan(); await f.freeze(id);
  const observation = await f.ledger.acceptObservation(f.context(), 'shared-live', { type: 'membership.observed', item: video, memberships: { mode: 'delta', added: ['101'], removed: [] } });
  if (observation.status === 'rejected') throw new Error(observation.reason);
  const live = await f.layout.plan({ context: f.context(), itemId: video.id, collectionId: '101', entry: 'reconcile', trigger: { kind: 'observation', observationId: observation.receiptId } });
  if (live.status !== 'planned') throw new Error(live.status);
  await f.importer.cancel(id);
  for (const effect of live.plan.effects) expect((await f.executor.execute(live.plan.id, effect.effectId)).status).toBe('confirmed');
  expect(f.counts).toEqual({ folder: 1, bookmark: 1 }); await f.db.close();
});

test('cancelling unknown submitted work retains its command and folder reservation', async () => {
  const f = await fixture(), { id } = await f.scan(), preview = await f.freeze(id);
  f.execution.execute = async () => ({ status: 'unknown', reason: 'nativeOutcomeUnknown' });
  await f.importer.approve({ jobId: id, previewId: preview.id, revision: preview.revision, digest: preview.digest });
  await f.importer.wake();
  const retained = await f.db.transaction(['outbox', 'folderReservations'], 'readonly', async tx => new Promise<unknown>((resolve, reject) => {
    const r = tx.objectStore('outbox').getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  }));
  await f.importer.cancel(id);
  const after = await f.db.transaction(['outbox'], 'readonly', async tx => new Promise<unknown>((resolve, reject) => {
    const r = tx.objectStore('outbox').getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  }));
  expect(after).toEqual(retained); expect(after).toHaveLength(1); await f.db.close();
});

test('restart clears traversal cursor history but preserves entity deduplication and loop detection', async () => {
  const f = await fixture(), id = await f.importer.start(['101', '102']);
  const first = { ...f.catalog, page: { ...f.catalog.page, nextCursor: 'stable-next-page' } } as const;
  await f.page(first);
  await f.renew(); f.advance(); await f.importer.wake();
  await f.importer.resume(id); await f.page(first);
  f.advance(); await f.importer.wake();
  const c = f.sent.at(-1)!; if (c.operation !== 'readPage') throw new Error('noPage');
  const loop = await f.importer.accept(f.context(), { protocolVersion: 1, requestId: c.pageRequestId, leaseId: c.leaseId, capability: 'host-validated',
    operation: 'page.result', readSessionId: c.readSessionId, pageRequestId: c.pageRequestId, result: first });
  expect(loop).toMatchObject({ status: 'rejected', reason: 'invalid' }); await f.db.close();
});

test('registered stable cursor strategy resumes the last accepted cursor under a new lease', async () => {
  const f = await fixture('sourceAndSemantic', 'stableCursor'), id = await f.importer.start(['101', '102']);
  await f.page({ ...f.catalog, page: { ...f.catalog.page, nextCursor: 'stable-next' } });
  await f.renew(); f.advance(); await f.importer.wake(); await f.importer.resume(id);
  f.advance(); await f.importer.wake();
  expect(f.sent.at(-1)).toMatchObject({ operation: 'readPage', leaseId: 'new-lease', query: { kind: 'collections', cursor: 'stable-next' } });
  await f.db.close();
});

test('cancellation reclaims reservations even if plan persistence fails before the preview checkpoint', async () => {
  const f = await fixture('singlePreferSemantic'), { id } = await f.scan(); await f.importer.freeze(id);
  const transaction = f.db.transaction.bind(f.db);
  let cut = true;
  f.db.transaction = ((stores: any, mode: any, work: any) => {
    if (cut && mode === 'readwrite' && stores.includes('savePlans')) { cut = false; return Promise.reject(new Error('workerCutBeforePlan')); }
    return transaction(stores, mode, work);
  }) as typeof f.db.transaction;
  await f.importer.wake();
  expect(cut).toBe(false); const preview = (await f.importer.status())!.preview!; expect(preview.counts.review).toBeGreaterThan(0);
  await f.create().cancel(id);
  await expect(f.layout.plan({ context: f.context(), itemId: video.id, collectionId: '101', entry: 'siteImport', trigger: { kind: 'import', importRunId: id, previewId: preview.id } })).rejects.toThrow('planCancelled');
  const bindings = createContentBindings(f.db, async () => {});
  expect(await bindings.prepare({ itemId: video.id, commandId: 'after-preparation-cut', captureIntentId: 'capture-after-cut', title: video.title, url: video.url, parentId: 'root', automatic: true })).toMatchObject({ mode: 'create' });
  expect(f.counts).toEqual({ folder: 0, bookmark: 0 }); await f.db.close();
});
