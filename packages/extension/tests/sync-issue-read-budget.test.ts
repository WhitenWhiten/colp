import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBObjectStore } from 'fake-indexeddb';
import { afterEach, test, vi } from 'vitest';
import { readOpenSyncIssues } from '../src/sync-issues.js';
import { STORES } from '../src/sync-state/schema.js';
import { installKns05IndexedDb, mappingInput, scope, setup } from './kns-05-pull-harness.js';
import { conflicted, scope as attentionScope } from './bootstrap-merge-attention-harness.js';
import type { SyncScope, createSyncStateStore } from '../src/sync-state-store.js';

installKns05IndexedDb();
afterEach(() => vi.restoreAllMocks());

function observeMappingReads() {
  const counts = { calls: 0, rows: 0 }; const original = IDBObjectStore.prototype.getAll;
  vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (this: IDBObjectStore, ...args) {
    const request = original.apply(this, args);
    if (this.name === STORES.mappings) {
      counts.calls++;
      request.addEventListener('success', () => { counts.rows += request.result.length; });
    }
    return request;
  });
  return { counts, reset() { counts.calls = 0; counts.rows = 0; } };
}

async function park(store: ReturnType<typeof createSyncStateStore>, scope: SyncScope, nativeId: string) {
  const eventId = `park-${nativeId}`;
  await store.stageBookmarkEvent(scope, { eventId, dedupeKey: eventId, kind: 'change', nativeId,
    occurredAt: '2026-10-20T00:00:00Z', details: {} });
  return { eventId, state: 'parked' as const, code: 'operation_schema_invalid', attempts: 1,
    at: '2026-10-20T00:00:00Z' };
}

for (const unrelated of [0, 958]) {
  test(`no open attention reads zero mappings with ${unrelated} unrelated mappings, then observes new issues`, async () => {
    const f = await setup();
    try {
      for (let i = 0; i < unrelated; i++) await f.store.putMapping(scope, mappingInput(`unrelated-native-${i}`, `unrelated-${i}`));
      const reads = observeMappingReads();
      for (let read = 0; read < 3; read++) {
        const open = await readOpenSyncIssues(f.store, scope);
        assert.equal(open.total, 0); assert.equal(open.roots.size, 0);
      }
      assert.deepEqual(reads.counts, { calls: 0, rows: 0 });
      const marker = await park(f.store, scope, 'native-node');
      await f.store.putIngressDiagnostic(scope, { code: `park:${marker.eventId}`, park: marker });
      reads.reset();
      const open = await readOpenSyncIssues(f.store, scope);
      assert.equal(open.total, 1); assert.ok(open.roots.has('node-1'));
      assert.ok(open.nativeRoots.has('native-node')); assert.equal(reads.counts.calls, 1);
      await f.store.putIngressDiagnostic(scope, { code: `park:${marker.eventId}`, park: { ...marker, state: 'open' } });
      f.store.close(); reads.reset();
      const closed = await readOpenSyncIssues(f.store, scope);
      assert.equal(closed.total, 0); assert.equal(closed.roots.size, 0);
      assert.deepEqual(reads.counts, { calls: 0, rows: 0 });
    } finally { f.store.close(); }
  });
}

test('native protection and bootstrap display share one fresh mapping read, then stop reading after closure', async () => {
  const f = await conflicted();
  try {
    const reads = observeMappingReads();
    const first = await readOpenSyncIssues(f.store, attentionScope);
    assert.equal(first.bootstrap.length, 4); assert.equal(reads.counts.calls, 1);
    assert.equal(first.bootstrap.find(row => row.nodeId === 'remote-0')?.title, 'Local 0');
    const { scopeKey: _scopeKey, ...mapping } = (await f.store.getMappingByNativeId(attentionScope, 'local-0'))!;
    await f.store.putMapping(attentionScope, { ...mapping, projection: { ...mapping.projection,
      content: { ...mapping.projection.content, title: 'Fresh local title' } } });
    const marker = await park(f.store, attentionScope, 'local-0');
    await f.store.putIngressDiagnostic(attentionScope, { code: `park:${marker.eventId}`, park: marker });
    reads.reset();
    const changed = await readOpenSyncIssues(f.store, attentionScope);
    assert.equal(changed.operationalTotal, 1); assert.ok(changed.roots.has('remote-0'));
    assert.equal(changed.bootstrap.find(row => row.nodeId === 'remote-0')?.title, 'Fresh local title');
    assert.equal(reads.counts.calls, 1, 'one invocation does not read the full graph twice');
    await f.store.putIngressDiagnostic(attentionScope, { code: `park:${marker.eventId}`, park: { ...marker, state: 'open' } });
    await f.coordinator.advance(f.view.run.runId, { ...f.input,
      localFacts: f.input.localFacts.map((row, i) => ({ ...row, title: `Remote ${i}` })) });
    f.store.close(); reads.reset();
    const closed = await readOpenSyncIssues(f.store, attentionScope);
    assert.equal(closed.total, 0); assert.deepEqual(closed.bootstrap, []);
    assert.deepEqual(reads.counts, { calls: 0, rows: 0 });
  } finally { f.store.close(); }
});
