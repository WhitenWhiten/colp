import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { createSourceDatabase, sourceKey } from '../src/site-adapters/source-db.js';
import type { ReconcileRun, ReconcileOperation, ReconcileRunPorts } from '../src/site-adapters/reconcile-run.js';
vi.mock('../src/site-adapters/source-runtime.js', () => ({ siteLedger: { db: null }, SITE_RECOVERY_ALARM: 'recover' }));
vi.mock('../src/site-adapters/reconcile-run.js', () => ({ createReconcileRuns: (_db: unknown, ports: unknown) => ports }));
vi.mock('../src/site-adapters/reconcile-executor.js', () => ({
  executeReconcileCommand: vi.fn(async (_run, _op, _recover, _undo, authorize) => { await authorize(); return { receipt: 'mutation-authorized' }; }),
  prepareReconcileCommand: vi.fn(), assertReconcileOwnership: vi.fn(), assertReconcileUndoState: vi.fn(),
}));
vi.mock('../src/sw/capture-native.js', () => ({ assertCaptureOwner: async () => {}, assertCaptureScope: async () => {}, currentCaptureScope: vi.fn() }));
vi.mock('../src/sw/planned-capture.js', () => ({ assertSourceRoot: vi.fn(), acknowledgePlannedNative: vi.fn() }));
vi.mock('../src/sw/capture-history.js', () => ({ captureDeviceId: async () => 'device' }));
vi.mock('../src/sw/bookmark-folders-first.js', () => ({ scheduleNativeFoldersFirst: vi.fn() }));
vi.mock('../src/bookmark-annotation-store.js', () => ({ createBookmarkAnnotationStore: () => ({ get: async () => null, close() {} }) }));
import { siteLedger } from '../src/site-adapters/source-runtime.js';
import { reconciliationRuns } from '../src/site-adapters/reconcile-runtime.js';

test.each(['present', 'unresolved'])('prepared archive dispatch rejects newer %s membership', async state => {
  const db = createSourceDatabase(new IDBFactory()); siteLedger.db = db;
  try {
    await db.transaction(['authorities', 'meta', 'memberships', 'importRuns'], 'readwrite', async tx => {
      tx.objectStore('authorities').put({ enabled: true, connectionId: 'source', accountId: '42', installationGeneration: 1, sourceSessionGeneration: 1 }, 'adapter');
      tx.objectStore('meta').put({ enabled: true, policy: { revision: 1 } }, 'policy:source');
      tx.objectStore('importRuns').put({ baselineOrdinal: 1 }, 'import');
      tx.objectStore('memberships').put({ state, ordinal: 10, liveOrdinal: 10, evidence: 'live' }, sourceKey('source', 'item', 'saved'));
    });
    const run = { id: 'run', scope: {}, preview: { createdAt: Date.now(), importId: 'import', policyRevision: 1,
      context: { connectionId: 'source', installationGeneration: 1, sourceSessionGeneration: 1 } } } as unknown as ReconcileRun;
    const op = { id: 'op', decision: { choice: 'archive' }, difference: { kind: 'sourceRemoved', itemId: 'item', collectionId: 'saved' }, command: { preparedBeforeLiveEvent: true } } as unknown as ReconcileOperation;
    const ports = reconciliationRuns as unknown as ReconcileRunPorts;
    // Initial preparation does recognize the same changed edge.
    await expect(ports.prepare(run, op, false)).rejects.toThrow('sourceFactsChanged');
    // Retrying the immutable command must enforce the same membership fence.
    await expect(ports.execute(run, op, false, false)).rejects.toThrow('sourceFactsChanged');
  } finally { await db.close(); }
});
