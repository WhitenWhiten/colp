import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test } from 'vitest';
import { createSourceDatabase, sourceDigest } from '../src/site-adapters/source-db.js';
import { createSourceLedger } from '../src/site-adapters/ledger.js';
import { createReconcilePreview, reconcileKey } from '../src/site-adapters/reconcile-preview.js';
import { readReconcileData } from '../src/site-adapters/reconcile-storage.js';
import { LIMITS } from '../src/site-adapters/limits.js';
import type { ImportJob } from '../src/site-adapters/import-coordinator.js';
import type { ReconcilePreview } from '../src/site-adapters/reconcile-model.js';
import { postsDefinition, post, saved } from './fixtures/site-adapters/posts.js';
test.each([10001, 50000])('a %i-item import freezes and reloads a paged reconciliation preview', async count => {
  const db = createSourceDatabase(new IDBFactory()), ledger = createSourceLedger(db, {}, postsDefinition);
  try {
    const a = await ledger.setAuthority({ enabled: true, accountId: 'acct:reader', installationGeneration: 1, sourceSessionGeneration: 1, negativeReadback: true });
    const context = { installationId: postsDefinition.adapterId, connectionId: a.connectionId!, installationGeneration: 1, sourceSessionGeneration: 1, documentId: 'doc', leaseId: 'lease', tabId: 1, routeEpoch: 0 };
    const receipts: { id: string; digest: string }[] = [];
    await db.transaction(['importPages'], 'readwrite', async tx => {
      for (let offset = 0; offset < count; offset += 100) {
        const id = `request-${offset}`, receipt = { id: `receipt-${offset}`, digest: 'digest', ordinal: offset + 1 }; receipts.push(receipt);
        tx.objectStore('importPages').put({ request: { id, runId: 'run', context, deadlineAt: Date.now() + 30000, query: { kind: 'items', collectionId: saved.id, cursor: offset ? String(offset) : null } }, receipt,
          result: { status: 'ok', kind: 'items', collectionId: saved.id, page: { items: Array.from({ length: Math.min(100, count - offset) }, (_, i) => ({ item: { ...post, id: `post:${offset + i}` } })),
            nextCursor: offset + 100 < count ? String(offset + 100) : null, coverage: 'complete', consistency: 'bestEffort' } } }, id);
      }
    });
    const job = { id: 'run', previewId: 'preview', context, pageReceipts: receipts, selected: [saved.id], snapshot: { policyRevision: 1 } } as unknown as ImportJob;
    expect(count).toBeLessThanOrEqual(LIMITS.importItems);
    const preview = createReconcilePreview(db, postsDefinition, async () => ({ folders: [], representations: [], nodes: [], movedFolders: [] }));
    await preview.begin(job); await preview.freeze(job);
    expect(await db.read('meta', reconcileKey(job.id))).toMatchObject({ storage: 'paged-v1', differences: [], differenceCount: count });
    const restored = await readReconcileData<ReconcilePreview>(db, reconcileKey(job.id));
    expect(restored?.differences).toHaveLength(count); expect(restored?.snapshots[0]?.items).toHaveLength(count);
    expect(sourceDigest({ ...restored, digest: '' })).toBe(restored?.digest);
  } finally { await db.close(); }
}, 30000);
