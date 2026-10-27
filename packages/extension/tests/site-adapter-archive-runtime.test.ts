import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import { createSourceDatabase, sourceKey } from '../src/site-adapters/source-db.js';
import { createSourceLedger } from '../src/site-adapters/ledger.js';
import { createSourceArchiveRuntime } from '../src/site-adapters/archive-runtime.js';
import { createReadScheduler } from '../src/site-adapters/read-scheduler.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { admitsSiteEdge } from '../src/automation/site-rule.js';
import type { RuleDraft } from '../src/automation/rule-conditions.js';
import { postsDefinition, saved } from './fixtures/site-adapters/posts.js';
import { installationKey } from '../src/site-adapters/installation.js';
import type { ImportJob } from '../src/site-adapters/import-coordinator.js';
const mocks = vi.hoisted(() => ({ draft: undefined as RuleDraft | undefined }));
vi.mock('../src/site-adapters/source-runtime.js', () => ({ siteLedger: {} }));
vi.mock('../src/site-adapters/planned-runtime.js', () => ({ executePlannedSave: async () => ({ status: 'confirmed' }) }));
vi.mock('../src/site-adapters/layout-runtime.js', () => ({ sourceLayout: { bindRoot: async () => ({ root: { nativeId: 'root' } }), configureMount: async () => {}, configure: async () => {} } }));
vi.mock('../src/sw/capture-history.js', () => ({ captureDeviceId: async () => 'device' }));
vi.mock('../src/sw/planned-capture.js', () => ({ assertPlannedNative: async () => {}, assertSourceRoot: async () => ({ inRange: false }) }));
vi.mock('../src/sw/automation.js', () => ({ sourceAutomationsPaused: async () => false }));
vi.mock('../src/sw/automation-browser.js', () => ({ currentFlat: async () => ({ revision: 1, contentVersions: {}, stopped: null }), browserRuleStore: () => ({ saveRule: async (input: { draft: RuleDraft }) => { mocks.draft = input.draft; return { ok: true, rule: { id: 'rule' } }; } }) }));
afterEach(() => vi.unstubAllGlobals());
test('live archive configuration admits confirmed favorites as well as imports and reconciliation, within the approved scope', async () => {
  const db = createSourceDatabase(new IDBFactory()), ledger = createSourceLedger(db, {}, postsDefinition);
  const a = await ledger.setAuthority({ enabled: true, accountId: 'acct:reader', installationGeneration: 1, sourceSessionGeneration: 1, negativeReadback: true });
  const context = { installationId: postsDefinition.adapterId, connectionId: a.connectionId!, installationGeneration: 1, sourceSessionGeneration: 1, documentId: 'doc', leaseId: 'lease', routeEpoch: 0, tabId: 1 };
  await ledger.bindLease(context, Date.now() + 60000);
  vi.stubGlobal('chrome', { permissions: { contains: async () => true }, bookmarks: { get: async () => [{ id: 'root', dateAdded: 10 }] } });
  try {
    const source = vi.fn(async () => ({ context, expiresAt: Date.now() + 60000 }));
    const runtime = createSourceArchiveRuntime(createReadScheduler(new MemoryStorageArea(), 'reads'), { source, readSource: async () => null,
      catalog: async () => [saved], send: () => {}, prioritizeLive: async () => {}, alarm: () => {} }, ledger, postsDefinition);
    await runtime.handle({ kind: 'known.siteAdapters.archive.configure', rootNativeId: 'root', collectionIds: [saved.id], live: true });
    for (const entry of ['siteFavorite', 'siteImport', 'reconcile'] as const) {
      const edge = { entry, purpose: 'sourceArchive' as const, connectionId: context.connectionId, collectionId: saved.id };
      expect(admitsSiteEdge(mocks.draft?.site, edge)).toBe(true);
      expect(admitsSiteEdge(mocks.draft?.site, { ...edge, collectionId: 'list:other' })).toBe(false);
      expect(admitsSiteEdge(mocks.draft?.site, { ...edge, connectionId: 'other' })).toBe(false);
    }
    // Starting a new check uses the management path that waits for reconnection;
    // background reads still use the scoped, nonblocking readSource path.
    source.mockClear();
    await expect(runtime.handle({ kind: 'known.siteAdapters.import.start' })).rejects.toThrow('sourceAutomationPaused');
    expect(source).toHaveBeenCalledOnce();
  } finally { await db.close(); }
});
test('one confirmation repairs the retained task after renewal without a live tab, catalog reread or second client command', async () => {
  const db = createSourceDatabase(new IDBFactory()), ledger = createSourceLedger(db, {}, postsDefinition);
  const authority = await ledger.setAuthority({ enabled: true, accountId: 'acct:reader', installationGeneration: 1, sourceSessionGeneration: 1, negativeReadback: true });
  const context = { installationId: postsDefinition.adapterId, connectionId: authority.connectionId!, installationGeneration: 1, sourceSessionGeneration: 1, documentId: 'doc', leaseId: 'lease', routeEpoch: 0, tabId: 1 };
  await ledger.bindLease(context, Date.now() + 60000); await ledger.acceptCatalog(context, 'catalog', [saved]);
  vi.stubGlobal('chrome', { permissions: { contains: async () => true }, bookmarks: { get: async () => [{ id: 'root', dateAdded: 10 }] } });
  try {
    const source = vi.fn(async () => null), catalog = vi.fn(async () => [saved]);
    const runtime = createSourceArchiveRuntime(createReadScheduler(new MemoryStorageArea(), 'reads'), { source, readSource: async () => null,
      catalog, send: () => {}, prioritizeLive: async () => {}, alarm: () => {} }, ledger, postsDefinition);
    const message = { kind: 'known.siteAdapters.archive.configure', rootNativeId: 'root', collectionIds: [saved.id], live: true };
    await runtime.handle(message);
    await ledger.startImport(context, 'retained-task');
    const job: ImportJob = { installationId: postsDefinition.adapterId, id: 'retained-task', context, selected: [saved.id], phase: 'attention', stage: 'items',
      found: [saved.id], collectionIndex: 1, cursor: null, outstanding: null, pages: 103, edgeCount: 4917, scanComplete: true, omissions: 443,
      omissionSamples: [], coverage: 'partial', pageReceipts: [], reason: 'sourceDestinationNeedsReview', previewId: null, previewRevision: 2, nextEdge: 0,
      nextPlan: 0, planIds: [], scanSnapshot: { browserRules: { storageVersion: 3, listRevision: 1, contentVersions: {} }, policyRevision: 1 },
      counts: { createFolders: 0, createBookmarks: 0, reuseBookmarks: 0, review: 0 }, snapshot: null, approvalId: null };
    await db.transaction(['meta'], 'readwrite', async tx => {
      tx.objectStore('meta').put(job, `importJob:${job.id}`); tx.objectStore('meta').put(job.id, installationKey('activeImport:v1', postsDefinition));
      tx.objectStore('meta').put({ connectionId: context.connectionId, enabled: true, policy: { revision: 1 } }, `policy:${context.connectionId}`);
    });
    await ledger.setAuthority({ enabled: true, accountId: 'acct:reader', installationGeneration: 2, sourceSessionGeneration: 2, negativeReadback: true });
    await ledger.revokeDocuments(); catalog.mockRejectedValue(new Error('refreshCatalogRequired'));
    expect(await runtime.handle(message)).toEqual({ configured: true });
    expect(await runtime.importer.status()).toMatchObject({ id: job.id, phase: 'preparing', authorization: 'current', pages: 103, edgeCount: 4917 });
    expect(source).not.toHaveBeenCalled(); expect(catalog).toHaveBeenCalledOnce();
    expect(await db.read('collections', sourceKey(context.connectionId, saved.id))).toMatchObject({ entity: saved });
  } finally { await db.close(); }
});
