import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { createSourceDatabase, sourceKey, SOURCE_STORES, SOURCE_DATABASE_VERSION } from '../src/site-adapters/source-db.js';
import { createSourceLedger, readConnectionAuthority } from '../src/site-adapters/ledger.js';
import { legacySite } from '../src/site-adapters/registry.js';
import { createLiveSourcePlanner } from '../src/site-adapters/live-planner.js';
import { type createSourceLayout } from '../src/site-adapters/layout.js';
import { createReadScheduler } from '../src/site-adapters/read-scheduler.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { installationKey } from '../src/site-adapters/installation.js';
import { contentBindingKey, listContentBindings } from '../src/site-adapters/content-identity.js';
import { parsePortableSources, restorePortableSources, assertSourceRebound } from '../src/site-adapters/portable.js';
import { video } from './fixtures/site-adapters/bilibili.js';

// Metadata-only fixtures exercise two installations of the same implementation, not another adapter.
const revision = { ...legacySite, adapterId: 'fixture.installation', identityVersion: 2 };
test('a disabled installation with a full connection backlog cannot deny another installation admission', async () => {
  const db = createSourceDatabase(new IDBFactory());
  try {
    const first = createSourceLedger(db), second = createSourceLedger(db, {}, revision);
    const input = { enabled: true, accountId: '42', installationGeneration: 1, sourceSessionGeneration: 1, negativeReadback: false };
    const a = await first.setAuthority(input), b = await second.setAuthority(input);
    const ca = { connectionId: a.connectionId!, installationGeneration: 1, sourceSessionGeneration: 1, documentId: 'one', tabId: 1, leaseId: 'one', routeEpoch: 0 };
    const cb = { ...ca, connectionId: b.connectionId!, installationId: revision.adapterId, documentId: 'two', leaseId: 'two', tabId: 2 };
    await first.bindLease(ca, Date.now() + 60000); await second.bindLease(cb, Date.now() + 60000);
    const observation = { type: 'membership.observed' as const, item: video, memberships: { mode: 'delta' as const, added: ['101'], removed: [] } };
    await db.transaction(['observations'], 'readwrite', async tx => {
      for (let i = 0; i < 10000; i++) tx.objectStore('observations').put({ id: String(i), installationId: legacySite.adapterId,
        ordinal: i + 1, state: 'pending', context: ca, observation, readyAt: 0 }, String(i));
    });
    expect(await first.acceptObservation(ca, 'overflow', observation)).toMatchObject({ status: 'rejected', reason: 'capacity' });
    await first.setAuthority({ ...input, enabled: false, installationGeneration: 2 });
    expect(await second.acceptObservation(cb, 'healthy', observation)).toMatchObject({ status: 'accepted' });
    const count = await db.transaction(['observations'], 'readonly', tx => new Promise<number>((resolve, reject) => {
      const request = tx.objectStore('observations').count(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    }));
    expect(count).toBe(10001);
  } finally { await db.close(); }
});
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

test('a full page of another identity cannot hide this site from the association inspector', async () => {
  const db = createSourceDatabase(new IDBFactory());
  const content = { siteKey: legacySite.siteKey, identityVersion: 1, itemId: video.id };
  await db.transaction(['contentBindings'], 'readwrite', async tx => {
    for (let n = 0; n < 1001; n++) { const foreign = { ...content, siteKey: 'aaa-other-namespace' }; tx.objectStore('contentBindings').put({ id: String(n), content: foreign }, contentBindingKey(foreign, String(n))); }
    tx.objectStore('contentBindings').put({ id: 'selected', content }, contentBindingKey(content, 'selected'));
  });
  expect((await listContentBindings(db, content)).map(b => b.id)).toEqual(['selected']); await db.close();
});

test('a blocked schema upgrade can retry after the old context closes without leaking its abandoned connection', async () => {
  const factory = new IDBFactory();
  const old = await new Promise<IDBDatabase>(resolve => { const r = factory.open('blocked', 2); r.onsuccess = () => resolve(r.result); });
  const db = createSourceDatabase(factory, 'blocked');
  await expect(db.open()).rejects.toThrow('schemaIncompatible'); old.close();
  expect((await db.open()).version).toBe(SOURCE_DATABASE_VERSION); await db.close();
});

test('registry-valid installations on the same document retain independent leases and revocations', async () => {
  const { validateSiteDefinitions } = await import('../src/site-adapters/registry-validation.js');
  validateSiteDefinitions([legacySite, revision]);
  const db = createSourceDatabase(new IDBFactory());
  try {
    const first = createSourceLedger(db), second = createSourceLedger(db, {}, revision);
    const input = { enabled: true, accountId: '42', installationGeneration: 1, sourceSessionGeneration: 1, negativeReadback: false };
    const a = await first.setAuthority(input), b = await second.setAuthority(input);
    const ca = { connectionId: a.connectionId!, installationGeneration: 1, sourceSessionGeneration: 1, documentId: 'same-document', tabId: 1, leaseId: 'first-lease', routeEpoch: 0 };
    const cb = { ...ca, connectionId: b.connectionId!, installationId: revision.adapterId, leaseId: 'second-lease' };
    await first.bindLease(ca, Date.now() + 60000); await second.bindLease(cb, Date.now() + 60000);
    const catalog = [{ id: '101', identity: 'siteId' as const, title: 'Favorites', parentId: null }];
    expect(await first.acceptCatalog(ca, 'first', catalog)).toMatchObject({ status: 'accepted' });
    expect(await second.acceptCatalog(cb, 'second', catalog)).toMatchObject({ status: 'accepted' });
    await first.revokeDocuments(1);
    expect(await first.acceptCatalog(ca, 'revoked', catalog)).toMatchObject({ status: 'rejected', reason: 'staleContext' });
    expect(await second.acceptCatalog(cb, 'still-live', catalog)).toMatchObject({ status: 'accepted' });
    await first.revokeLease('second-lease');
    expect(await second.acceptCatalog(cb, 'still-owned', catalog)).toMatchObject({ status: 'accepted' });
  } finally { await db.close(); }
});

test('v13 document leases migrate into their installation namespace without reviving revoked leases', async () => {
  const { documentLeaseKey } = await import('../src/site-adapters/document-leases.js');
  const factory = new IDBFactory(), name = 'lease-migration';
  const context = { connectionId: 'connection', installationGeneration: 1, sourceSessionGeneration: 1, documentId: 'legacy-document', tabId: 1, leaseId: 'lease', routeEpoch: 0 };
  const records = [{ context, active: true, expiresAt: Date.now() + 60000 },
    { context: { ...context, documentId: 'other-document', installationId: revision.adapterId }, active: false, expiresAt: 1 }];
  const old = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, 13);
    request.onupgradeneeded = () => {
      for (const store of SOURCE_STORES) request.result.createObjectStore(store);
      for (const row of records) request.transaction!.objectStore('documentLeases').put(row, row.context.documentId);
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  }); old.close();
  const db = createSourceDatabase(factory, name);
  try {
    for (const row of records) {
      expect(await db.read('documentLeases', documentLeaseKey(row.context))).toEqual(row);
      expect(await db.read('documentLeases', row.context.documentId)).toBeUndefined();
    }
  } finally { await db.close(); }
});
