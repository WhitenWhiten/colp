import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { createSyncStateStore, type ScopeCommandPlanRecord } from '../src/sync-state-store.js';
import { requestValue, runTransaction } from '../src/sync-state/idb.js';
import { STORES } from '../src/sync-state/schema.js';
import { writeScopeCommandRecord } from '../src/sync-state/scope-command-evidence.js';
import { scopeKey } from '../src/sync-state/scope-key.js';
import { scope } from './kns-05-pull-harness.js';

const CAP = 8 * 1_024;
const account = { environment: scope.environment, serverId: scope.serverId,
  accountId: scope.accountId, browserProfileId: scope.browserProfileId };
const plan = (commandId = 'rejoin-delete:mount:folder', count = 160): Omit<ScopeCommandPlanRecord, 'scopeKey'> => ({
  commandId, kind: 'rejoin', phase: 'applying', confirmationVersion: '1', baselineDigest: 'sha256:evidence',
  mountId: 'mount', retryReason: 'keep_remote', updatedAt: 1,
  dependencies: Array.from({ length: count }, (_, i) => `${i}`.padStart(47, '0')),
  rejoinDecision: { kind: 'local_delete', title: '😀'.repeat(400),
    restoreOrders: [{ parentId: 'folder', order: Array.from({ length: count }, (_, i) => `unmounted:${`${i}`.padStart(47, '0')}`) }] },
});
async function setup() {
  const indexedDB = new IDBFactory();
  const store = createSyncStateStore({ indexedDB, maxRecordBytes: CAP });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: Date.now() + 60_000 },
    checkpoint: null, selectedRoots: [], rootStatus: 'ready' });
  return { store, indexedDB };
}
async function physical(store: ReturnType<typeof createSyncStateStore>) {
  const db = await store.open(); const tx = db.transaction([STORES.metadata, STORES.scopeCommandPlans], 'readonly');
  const [metadata, headers] = await Promise.all([requestValue<Record<string, unknown>[]>(tx.objectStore(STORES.metadata).getAll()),
    requestValue<Record<string, unknown>[]>(tx.objectStore(STORES.scopeCommandPlans).getAll())]);
  return { pages: metadata.filter(row => row.kind === 'scope_command_evidence_v1'), headers };
}

test('paged restore evidence survives a new store, export and exact begin replay within the physical cap', async () => {
  const f = await setup(); let store = f.store;
  try {
    const saved = await store.putScopeCommandPlan(scope, plan());
    const records = await physical(store);
    expect(records.pages.length).toBeGreaterThan(1);
    for (const row of [...records.pages, ...records.headers]) expect(new TextEncoder().encode(JSON.stringify(row)).length).toBeLessThanOrEqual(CAP);
    await store.close(); store = createSyncStateStore({ indexedDB: f.indexedDB, maxRecordBytes: CAP });
    expect(await store.getScopeCommandPlan(scope, saved.commandId)).toEqual(saved);
    expect(await store.listScopeCommandPlans(scope)).toEqual([saved]);
    expect((await store.exportScope(scope)).scopeCommandPlans).toEqual([saved]);
    expect(await store.beginScopeCommandPlan(scope, plan())).toEqual(saved);
  } finally { store.close(); }
});

test.each(['missing', 'binding', 'body'] as const)('a %s evidence page fails closed in get, list and ordinary export', async damage => {
  const { store } = await setup();
  try {
    await store.putScopeCommandPlan(scope, plan());
    const page = (await physical(store)).pages[0]!;
    const db = await store.open();
    await runTransaction(db, [STORES.metadata], 'readwrite', async tx => {
      const metadata = tx.objectStore(STORES.metadata);
      if (damage === 'missing') metadata.delete(page.key as string);
      else metadata.put({ ...page, ...(damage === 'binding' ? { commandId: 'other-command' } : { chunk: `${page.chunk}x` }) });
    });
    await expect(store.getScopeCommandPlan(scope, plan().commandId)).rejects.toThrow(/command_evidence/);
    await expect(store.listScopeCommandPlans(scope)).rejects.toThrow(/command_evidence/);
    await expect(store.exportScope(scope)).rejects.toThrow(/command_evidence/);
    await store.retireScope(scope, { retiredAt: 2, reason: 'user_reset' });
    const archive = await store.exportArchive(scope);
    expect(archive.scopeCommandPlans).toEqual([]);
    expect(archive.unreadableCommandEvidence).toHaveLength(1);
    expect((await physical(store)).pages).toHaveLength(0);
  } finally { store.close(); }
});

test('replacement and inline compaction remove only this command generation and abort restores both headers and pages', async () => {
  const { store } = await setup();
  try {
    const original = await store.putScopeCommandPlan(scope, plan());
    const other = await store.putScopeCommandPlan(scope, plan('rejoin-delete:other:folder'));
    const before = await physical(store);
    const db = await store.open();
    await expect(runTransaction(db, [STORES.metadata, STORES.scopeCommandPlans], 'readwrite', async tx => {
      await writeScopeCommandRecord(tx, scopeKey(scope), { ...original, baselineDigest: 'replacement' }, CAP);
      throw new Error('worker_crash');
    })).rejects.toThrow('worker_crash');
    expect(await physical(store)).toEqual(before);
    await store.putScopeCommandPlan(scope, { ...plan(), baselineDigest: 'replacement' });
    expect((await physical(store)).pages.some(row => row.baselineDigest === original.baselineDigest
      && row.commandId === original.commandId)).toBe(false);
    await store.putScopeCommandPlan(scope, { ...plan(), phase: 'active', dependencies: [], rejoinDecision: { kind: 'local_delete' } });
    expect((await physical(store)).pages.every(row => row.commandId === other.commandId)).toBe(true);
    expect(await store.getScopeCommandPlan(scope, other.commandId)).toEqual(other);
    await expect(store.putScopeCommandPlan(scope, { ...plan(), kind: 'detach' })).rejects.toThrow('record_too_large');
  } finally { store.close(); }
});

test('logout archives complete logical evidence before removing its pages', async () => {
  const { store } = await setup();
  try {
    const saved = await store.putScopeCommandPlan(scope, plan());
    await store.cleanupAccount(account);
    expect((await store.exportArchive(scope)).scopeCommandPlans).toEqual([saved]);
    expect((await physical(store)).pages).toHaveLength(0);
    expect(await store.getScope(scope)).toBeNull();
  } finally { store.close(); }
});

test('a later scope archive failure rolls back earlier scope deletions and every evidence page', async () => {
  const { store } = await setup();
  const second = { ...scope, replicaId: 'second-replica' };
  let fault: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await store.registerScope({ ...second, lifecycle: 'active', lease: { leaseId: 'second-lease', expiresAt: Date.now() + 60_000 },
      checkpoint: null, selectedRoots: [], rootStatus: 'ready' });
    const firstPlan = await store.putScopeCommandPlan(scope, plan());
    const secondPlan = await store.putScopeCommandPlan(second, plan());
    const before = await physical(store);
    const original = IDBObjectStore.prototype.add; let archived = 0;
    fault = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function(this: IDBObjectStore, value, key) {
      if (this.name === STORES.archives && ++archived === 2) throw new Error('archive_write_failed');
      return original.call(this, value, key);
    });
    await expect(store.cleanupAccount(account)).rejects.toThrow('archive_write_failed');
    fault.mockRestore();
    expect(await physical(store)).toEqual(before);
    expect(await store.getScope(scope)).not.toBeNull();
    expect(await store.getScope(second)).not.toBeNull();
    expect(await store.getScopeCommandPlan(scope, firstPlan.commandId)).toEqual(firstPlan);
    expect(await store.getScopeCommandPlan(second, secondPlan.commandId)).toEqual(secondPlan);
    await expect(store.exportArchive(scope)).rejects.toThrow('archive_not_found');
  } finally { fault?.mockRestore(); store.close(); }
});
