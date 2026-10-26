import { readReconcileData } from '../src/site-adapters/reconcile-storage.js';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { createSourceDatabase } from '../src/site-adapters/source-db.js';
import { createSourceLedger } from '../src/site-adapters/ledger.js';
import { createReconcilePreview, reconcileKey } from '../src/site-adapters/reconcile-preview.js';
import type { ReconcilePreview } from '../src/site-adapters/reconcile-model.js';
import type { ReconcileInventory } from '../src/site-adapters/reconcile-inventory.js';
import type { ImportJob } from '../src/site-adapters/import-coordinator.js';
import type { SourceFolderReservation, Representation } from '../src/site-adapters/contracts.js';
import { representationKey } from '../src/site-adapters/reservations.js';
import { postsDefinition, post, saved } from './fixtures/site-adapters/posts.js';
test.each(['site', 'account'] as const)('preview follows stored request receipts and qualifies %s-scoped candidate identity', async contentIdScope => {
  const db = createSourceDatabase(new IDBFactory());
  try {
    const definition = { ...postsDefinition, contentIdScope }, ledger = createSourceLedger(db, {}, definition);
    const authority = await ledger.setAuthority({ enabled: true, accountId: 'acct:reader', installationGeneration: 1, sourceSessionGeneration: 1, negativeReadback: true });
    const context = { connectionId: authority.connectionId!, installationGeneration: 1, sourceSessionGeneration: 1, documentId: 'doc', tabId: 1, routeEpoch: 0, leaseId: 'lease' };
    const job = { id: 'run', previewId: 'preview', selected: [saved.id], context, pageReceipts: [{ id: 'receipt', digest: 'digest' }], snapshot: { policyRevision: 1 } } as unknown as ImportJob;
    await db.transaction(['importPages'], 'readwrite', async tx => { tx.objectStore('importPages').put({ request: { id: 'request', runId: job.id, context,
      query: { kind: 'items', collectionId: saved.id, cursor: null }, deadlineAt: 100 }, receipt: { id: 'receipt', digest: 'digest', ordinal: 1 },
      result: { status: 'ok', kind: 'items', collectionId: saved.id, page: { items: [{ item: post }], nextCursor: null, coverage: 'complete', consistency: 'bestEffort' } } }, 'request'); });
    const binding = { kind: 'folder' as const, nativeId: 'folder', bindingId: 'proof', deviceId: 'device', dateAdded: 1, proof: { kind: 'explicitAdoption' as const, id: 'proof' } };
    const inventory = vi.fn(async (): Promise<ReconcileInventory> => ({ movedFolders: [], representations: [],
      folders: [{ collectionId: saved.id, native: binding } as SourceFolderReservation], nodes: [{ native: { ...binding, kind: 'bookmark', nativeId: 'bookmark' },
        title: 'My post', url: post.url, parentId: binding.nativeId, pinned: true, protected: false }] }));
    const service = createReconcilePreview(db, definition, inventory);
    await service.begin(job); await service.inspect(job, { kind: 'collectedEdge', collectionId: saved.id, itemId: post.id }); await service.begin(job); await service.freeze(job);
    const preview = await readReconcileData<ReconcilePreview>(db, reconcileKey(job.id));
    expect(preview?.differences[0]?.kind).toBe(contentIdScope === 'site' ? 'candidate' : 'add');
    expect(preview?.snapshots[0]).toMatchObject({ complete: true, absence: 'unverified', items: [post] });
    expect(inventory).toHaveBeenCalledOnce(); expect(preview?.digest).toMatch(/^sha256:/u);
  } finally { await db.close(); }
});
test('freezing retains deletion bookkeeping discovered during layout preparation without changing the native preview', async () => {
  const db = createSourceDatabase(new IDBFactory());
  try {
    const ledger = createSourceLedger(db, {}, postsDefinition);
    const authority = await ledger.setAuthority({ enabled: true, accountId: 'acct:reader', installationGeneration: 1, sourceSessionGeneration: 1, negativeReadback: true });
    const context = { connectionId: authority.connectionId!, installationGeneration: 1, sourceSessionGeneration: 1, documentId: 'doc', tabId: 1, routeEpoch: 0, leaseId: 'lease' };
    const job = { id: 'run', previewId: 'preview', selected: [saved.id], context, pageReceipts: [{ id: 'receipt', digest: 'digest' }], snapshot: { policyRevision: 1 } } as unknown as ImportJob;
    const native = { kind: 'bookmark' as const, nativeId: 'missing', bindingId: 'proof', deviceId: 'device', dateAdded: 1, proof: { kind: 'writeReceipt' as const, id: 'proof' } };
    const representation: Representation = { connectionId: context.connectionId, itemId: post.id, sourceCollectionId: saved.id, mountId: 'mount', purpose: 'sourceArchive',
      native, state: 'active', manualRevision: 0, lastWritten: { title: post.title, url: post.url, parentId: 'folder' } };
    await db.transaction(['importPages', 'representations'], 'readwrite', async tx => {
      tx.objectStore('importPages').put({ request: { id: 'request', runId: job.id, context, query: { kind: 'items', collectionId: saved.id, cursor: null }, deadlineAt: 100 },
        receipt: { id: 'receipt', digest: 'digest', ordinal: 1 }, result: { status: 'ok', kind: 'items', collectionId: saved.id,
          page: { items: [{ item: post }], nextCursor: null, coverage: 'complete', consistency: 'bestEffort' } } }, 'request');
      tx.objectStore('representations').put(representation, representationKey(representation));
    });
    const service = createReconcilePreview(db, postsDefinition, async () => ({ movedFolders: [], representations: [representation], folders: [], nodes: [] }));
    await service.begin(job);
    await db.transaction(['representations'], 'readwrite', async tx => {
      tx.objectStore('representations').put({ ...representation, state: 'suppressed', manualRevision: 1 }, representationKey(representation));
    });
    await service.freeze(job);
    expect((await readReconcileData<ReconcilePreview>(db, reconcileKey(job.id)))?.differences).toMatchObject([
      { kind: 'localDeleted', choices: ['keep', 'restore'], representation: { state: 'suppressed', manualRevision: 1 } },
    ]);
  } finally { await db.close(); }
});
