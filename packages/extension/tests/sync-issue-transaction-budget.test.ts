import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBDatabase } from 'fake-indexeddb';
import { afterEach, test, vi } from 'vitest';
import { readOpenSyncIssues } from '../src/sync-issues.js';
import { installKns05IndexedDb, scope, setup } from './kns-05-pull-harness.js';

installKns05IndexedDb();
afterEach(() => vi.restoreAllMocks());

function transactionBudget() {
  const counts = { readonly: 0, readwrite: 0, pending: 0, peak: 0 };
  const original = IDBDatabase.prototype.transaction;
  vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args) {
    const tx = original.apply(this, args);
    if (tx.mode !== 'readonly' && tx.mode !== 'readwrite') return tx;
    counts[tx.mode]++;
    counts.pending++;
    counts.peak = Math.max(counts.peak, counts.pending);
    const settled = () => { counts.pending--; };
    tx.addEventListener('complete', settled);
    tx.addEventListener('abort', settled);
    return tx;
  });
  return counts;
}

test('96 fresh empty issue scans take no adoption write locks and overlap independent reads', async () => {
  const f = await setup();
  try {
    const counts = transactionBudget();
    for (let i = 0; i < 96; i++) assert.equal((await readOpenSyncIssues(f.store, scope)).total, 0);
    assert.equal(counts.readwrite, 0, 'completed durable adoption is checked with fresh readonly facts');
    assert.ok(counts.readonly <= 11 * 96, `unexpected repeated issue transactions: ${counts.readonly}`);
    assert.ok(counts.peak >= 8, `independent reads were serialized: peak ${counts.peak}`);
    assert.equal(counts.pending, 0);
  } finally { f.store.close(); }
});

test('a fresh scan observes a new issue and its closure after another connection reopens', async () => {
  const f = await setup();
  try {
    assert.equal((await readOpenSyncIssues(f.store, scope)).total, 0);
    await f.store.stageBookmarkEvent(scope, { eventId: 'fresh-issue', dedupeKey: 'fresh-issue',
      kind: 'change', nativeId: 'native-node', occurredAt: '2026-10-20T00:00:00Z', details: {} });
    const park = { eventId: 'fresh-issue', state: 'parked' as const, code: 'operation_schema_invalid',
      attempts: 1, at: '2026-10-20T00:00:00Z' };
    await f.store.putIngressDiagnostic(scope, { code: 'park:fresh-issue', park });
    f.store.close();
    const open = await readOpenSyncIssues(f.store, scope);
    assert.equal(open.total, 1);
    assert.deepEqual([...open.nativeRoots], ['native-node']);
    assert.deepEqual([...open.roots], ['node-1']);
    await f.store.putIngressDiagnostic(scope, { code: 'park:fresh-issue', park: { ...park, state: 'open' } });
    f.store.close();
    assert.equal((await readOpenSyncIssues(f.store, scope)).total, 0);
  } finally { f.store.close(); }
});
