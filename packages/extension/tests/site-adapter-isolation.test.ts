import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { createSourceDatabase, sourceKey, SOURCE_STORES } from '../src/site-adapters/source-db.js';
import { createSourceLedger, readConnectionAuthority } from '../src/site-adapters/ledger.js';
import { legacySite } from '../src/site-adapters/registry.js';
import { createLiveSourcePlanner } from '../src/site-adapters/live-planner.js';
import { type createSourceLayout } from '../src/site-adapters/layout.js';
import { createReadScheduler } from '../src/site-adapters/read-scheduler.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { installationKey } from '../src/site-adapters/installation.js';
import { contentBindingKey } from '../src/site-adapters/content-identity.js';
import { parsePortableSources, restorePortableSources, assertSourceRebound } from '../src/site-adapters/portable.js';
import { video } from './fixtures/site-adapters/bilibili.js';

// Metadata-only fixtures exercise two installations of the same implementation, not another adapter.
const revision = { ...legacySite, adapterId: 'fixture.installation', identityVersion: 2 };
test('installations preserve independent source authority and pending observation ownership', async () => {
  const db = createSourceDatabase(new IDBFactory());
  const first = createSourceLedger(db), second = createSourceLedger(db, {}, revision);
  const input = { enabled: true, accountId: '42', installationGeneration: 1, sourceSessionGeneration: 1, negativeReadback: false };
  const a = await first.setAuthority(input), b = await second.setAuthority(input); expect(a.connectionId).not.toBe(b.connectionId);
  const context = (connectionId: string, id: string) => ({ connectionId, installationGeneration: 1, sourceSessionGeneration: 1, documentId: id, tabId: id === 'one' ? 1 : 2, leaseId: id, routeEpoch: 0 });
  const ca = context(a.connectionId!, 'one'), cb = { ...context(b.connectionId!, 'two'), installationId: revision.adapterId };
  await first.bindLease(ca, Date.now() + 60000); await second.bindLease(cb, Date.now() + 60000);
  const observation = { type: 'membership.observed' as const, item: video, memberships: { mode: 'delta' as const, added: ['101'], removed: [] } };
  const one = await first.acceptObservation(ca, 'same-request', observation), two = await second.acceptObservation(cb, 'same-request', observation);
  expect(one.status).toBe('accepted'); expect(two.status).toBe('accepted');
  expect(await first.acceptObservation(cb, 'wrong-installation', observation)).toMatchObject({ status: 'rejected', reason: 'staleContext' });
  await db.transaction(['meta'], 'readwrite', async tx => { tx.objectStore('meta').put({ enabled: true, liveArchive: true, policy: { revision: 1 } }, `policy:${a.connectionId}`); });
  const plan = vi.fn(async () => ({ status: 'noMatch' as const }));
  await createLiveSourcePlanner(db, { plan } as unknown as ReturnType<typeof createSourceLayout>, () => {}).wake();
  expect(plan).toHaveBeenCalledOnce(); expect(plan).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ connectionId: a.connectionId }) }));
  if (two.status === 'rejected') throw new Error(two.reason);
  expect(await db.read('observations', two.receiptId)).toMatchObject({ state: 'pending', installationId: revision.adapterId });
  await second.setAuthority({ ...input, enabled: false, installationGeneration: 2 });
  expect(await readConnectionAuthority(db, a.connectionId!)).toMatchObject({ enabled: true }); await db.close();
});
test('a paced or lost command in one installation does not take another installation slot', async () => {
  const storage = new MemoryStorageArea(), now = () => 100;
  const one = createReadScheduler(storage, installationKey('reads', legacySite), now), two = createReadScheduler(storage, installationKey('reads', revision), now);
  expect((await one.acquire({ id: 'one', documentId: 'doc', deadlineAt: 5000 })).status).toBe('ready');
  expect((await two.acquire({ id: 'two', documentId: 'other', deadlineAt: 5000 })).status).toBe('ready');
  await one.finish('one', 10000); expect((await two.current()).active?.id).toBe('two');
  expect((await one.acquire({ id: 'retry', documentId: 'doc', deadlineAt: 5000 })).status).toBe('paused');
});
test('v2 migration preserves binding receipts and adds versioned content keys without dropping unknown outbox work', async () => {
  const factory = new IDBFactory(), content = { siteKey: legacySite.siteKey, identityVersion: 1, itemId: video.id };
  const binding = { id: 'binding', content, commandId: 'original', state: 'pending', native: null };
  const old = await new Promise<IDBDatabase>(resolve => { const r = factory.open('migration', 2); r.onupgradeneeded = () => {
    for (const store of SOURCE_STORES) r.result.createObjectStore(store);
    r.transaction!.objectStore('contentBindings').put(binding, sourceKey(content.siteKey, content.itemId, binding.id));
    r.transaction!.objectStore('outbox').put({ state: 'unknown', command: { commandId: 'original' } }, 'original');
    r.transaction!.objectStore('observations').put({ id: 'old', state: 'pending', ordinal: 1 }, 'old');
  }; r.onsuccess = () => resolve(r.result); }); old.close();
  const db = createSourceDatabase(factory, 'migration');
  expect(await db.read('contentBindings', contentBindingKey(content, binding.id))).toEqual(binding);
  expect(await db.read('contentBindings', sourceKey(content.siteKey, content.itemId, binding.id))).toBeUndefined();
  expect(await db.read('outbox', 'original')).toMatchObject({ state: 'unknown', command: { commandId: 'original' } });
  expect(await db.read('observations', 'old')).toMatchObject({ installationId: legacySite.adapterId }); await db.close();
});
test('portable v2 preserves unfamiliar identities inertly and does not gate the same account in another namespace', async () => {
  const db = createSourceDatabase(new IDBFactory()), ledger = createSourceLedger(db);
  const a = await ledger.setAuthority({ enabled: true, accountId: '42', installationGeneration: 1, sourceSessionGeneration: 1, negativeReadback: false });
  const backup = parsePortableSources({ version: 2, connections: [{ ref: 'foreign', siteKey: 'uninstalled-source', identityVersion: 7,
    accountId: '42', copies: 'sourceAndSemantic', mounts: [], associations: [] }] });
  await restorePortableSources(db, 'backup', backup, new Map());
  await expect(assertSourceRebound(db, a.connectionId!)).resolves.toBeUndefined();
  expect(await db.read('meta', 'restoredSources:backup')).toMatchObject({ state: 'disabled', data: backup }); await db.close();
});
