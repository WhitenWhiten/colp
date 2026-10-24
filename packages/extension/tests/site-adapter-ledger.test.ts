import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test, expect } from 'vitest';
import { createSourceDatabase, sourceKey } from '../src/site-adapters/source-db.js';
import { createSourceLedger } from '../src/site-adapters/ledger.js';
import { createSourceReservations } from '../src/site-adapters/reservations.js';
import type { LedgerEdge, SourceContext, SourceImportRun } from '../src/site-adapters/ledger-types.js';
import type { NativeBinding, RepresentationKey } from '../src/site-adapters/contracts.js';
import { observation, partialPage, video } from './fixtures/site-adapters/bilibili.js';
async function harness(beforeCommit?: (tx: IDBTransaction) => void) {
  const factory = new IDBFactory(), db = createSourceDatabase(factory), ledger = createSourceLedger(db, { beforeCommit });
  const a = await ledger.setAuthority({ enabled: true, installationGeneration: 1, sourceSessionGeneration: 1, accountId: '42', negativeReadback: false });
  const context: SourceContext = { connectionId: a.connectionId!, documentId: 'doc', tabId: 1, routeEpoch: 0, leaseId: 'lease', installationGeneration: 1, sourceSessionGeneration: 1 };
  await ledger.bindLease(context, Date.now() + 100000);
  const edge = (collectionId = '101') => db.read<LedgerEdge>('memberships', sourceKey(context.connectionId, video.id, collectionId));
  return { factory, db, ledger, context, edge };
}
test('commit-before-ack survives reopen; lease renewal cannot bypass same-request replay/conflict', async () => {
  const h = await harness(); const accepted = await h.ledger.acceptObservation(h.context, 'one', observation);
  expect(accepted.status).toBe('accepted'); expect((await h.edge())?.state).toBe('present');
  await h.db.close(); const ledger = createSourceLedger(createSourceDatabase(h.factory));
  const renewed = { ...h.context, leaseId: 'renewed' }; await ledger.bindLease(renewed, Date.now() + 100000);
  expect(await ledger.acceptObservation(renewed, 'one', observation)).toEqual({ ...accepted, status: 'duplicate' });
  expect(await ledger.acceptObservation(renewed, 'one', { ...observation, item: { ...video, title: 'Changed' } })).toMatchObject({ status: 'rejected', reason: 'conflict' });
});
test('transaction abort leaves no receipt, ordinal or facts and never acknowledges acceptance', async () => {
  const h = await harness(tx => tx.abort());
  expect((await h.ledger.acceptObservation(h.context, 'one', observation)).status).toBe('rejected');
  expect(await h.edge()).toBeUndefined(); expect(await h.db.read('meta', 'ordinal')).toBeUndefined();
  const clean = createSourceLedger(h.db); expect((await clean.acceptObservation(h.context, 'one', observation)).status).toBe('accepted');
});
test('disable, route, old document and account fences reject late observations without resetting data', async () => {
  const h = await harness(); await h.ledger.acceptObservation(h.context, 'one', observation);
  await h.ledger.revokeDocuments(1);
  expect(await h.ledger.acceptObservation(h.context, 'two', observation)).toMatchObject({ reason: 'staleContext' });
  await h.ledger.bindLease({ ...h.context, routeEpoch: 1, leaseId: 'next' }, Date.now() + 100000);
  expect(await h.ledger.acceptObservation(h.context, 'two', observation)).toMatchObject({ reason: 'staleContext' });
  await h.ledger.setAuthority({ enabled: false, installationGeneration: 2, sourceSessionGeneration: 1, accountId: '42', negativeReadback: false });
  expect((await h.edge())?.state).toBe('present');
  await expect(h.ledger.setAuthority({ enabled: true, installationGeneration: 1, sourceSessionGeneration: 1, accountId: '42', negativeReadback: false })).rejects.toThrow('staleContext');
});
test('B-only deltas never remove C; contradictory live reports remain unresolved', async () => {
  const h = await harness(); await h.ledger.acceptObservation(h.context, 'c', { ...observation, memberships: { mode: 'delta', added: ['102'], removed: [] } });
  await h.ledger.acceptObservation(h.context, 'b', observation); expect((await h.edge('102'))?.state).toBe('present');
  const other = { ...h.context, documentId: 'doc2', tabId: 2, leaseId: 'lease2' }; await h.ledger.bindLease(other, Date.now() + 100000);
  await h.ledger.acceptObservation(other, 'remove', { ...observation, memberships: { mode: 'delta', added: [], removed: ['101'] } });
  expect((await h.edge())?.state).toBe('unresolved'); expect((await h.edge())?.conflicts).toHaveLength(2);
});
test('live additions/removals during an import overlay already scanned pages; page replay never advances twice', async () => {
  const h = await harness(); await h.ledger.startImport(h.context, 'run');
  await h.ledger.acceptObservation(h.context, 'live', { ...observation, memberships: { mode: 'delta', added: [], removed: ['101'] } });
  await h.ledger.issuePage({ id: 'page', runId: 'run', context: h.context, deadlineAt: Date.now() + 30000, query: { kind: 'items', collectionId: '101', cursor: null } });
  const accepted = await h.ledger.acceptPage(h.context, 'page', partialPage);
  expect(accepted.status).toBe('accepted'); expect((await h.edge())?.state).toBe('absent');
  const ordinal = await h.db.read('meta', 'ordinal');
  expect(await h.ledger.acceptPage(h.context, 'page', partialPage)).toEqual({ ...accepted, status: 'duplicate' });
  expect(await h.db.read('meta', 'ordinal')).toBe(ordinal);
  await h.ledger.acceptObservation(h.context, 'c', { ...observation, memberships: { mode: 'delta', added: ['102'], removed: [] } });
  expect((await h.edge('102'))?.state).toBe('present');
  expect((await h.db.read<SourceImportRun>('importRuns', 'run'))?.coverage).toBe('partial');
});
test('stopped import rejects new pages and conflicting replay; schema errors do not imply emptiness', async () => {
  const h = await harness(); await h.ledger.startImport(h.context, 'run');
  await h.ledger.issuePage({ id: 'page', runId: 'run', context: h.context, deadlineAt: Date.now() + 30000, query: { kind: 'items', collectionId: '101', cursor: null } });
  await h.ledger.stopImport(h.context, 'run');
  expect(await h.ledger.acceptPage(h.context, 'page', partialPage)).toMatchObject({ reason: 'staleContext' }); expect(await h.edge()).toBeUndefined();
});
test('fresh scoped read cannot clear a conflict touched after its baseline; unknown preserves it', async () => {
  const h = await harness(); await h.ledger.acceptObservation(h.context, 'add', observation);
  await h.ledger.issueMembershipRead(h.context, { id: 'read', deadlineAt: Date.now() + 30000, query: { itemId: video.id, collectionIds: ['101'] } });
  await h.ledger.acceptObservation(h.context, 'remove', { ...observation, memberships: { mode: 'delta', added: [], removed: ['101'] } });
  const positive = { status: 'ok', itemId: video.id, edges: [{ collectionId: '101', state: 'present', evidence: { kind: 'siteResponse', operation: 'ids.fresh' } }] } as const;
  expect((await h.ledger.acceptMembershipRead(h.context, 'read', positive)).status).toBe('accepted'); expect((await h.edge())?.state).toBe('unresolved');
  await h.ledger.issueMembershipRead(h.context, { id: 'fresh', deadlineAt: Date.now() + 30000, query: { itemId: video.id, collectionIds: ['101'] } });
  expect((await h.ledger.acceptMembershipRead(h.context, 'fresh', positive)).status).toBe('accepted'); expect((await h.edge())?.state).toBe('present');
  await h.ledger.issueMembershipRead(h.context, { id: 'negative', deadlineAt: Date.now() + 30000, query: { itemId: video.id, collectionIds: ['101'] } });
  expect(await h.ledger.acceptMembershipRead(h.context, 'negative', { ...positive, edges: [{ ...positive.edges[0], state: 'absent' }] })).toMatchObject({ reason: 'invalid' });
});
const root: NativeBinding<'folder'> = { bindingId: 'binding-root', nativeId: 'native-root', deviceId: 'device', kind: 'folder', dateAdded: 10, proof: { kind: 'explicitAdoption', id: 'adoption' } };
test('different items share one folder command; unknown blocks all consumers and cancellation retains others', async () => {
  const h = await harness(); const reservations = createSourceReservations(h.db);
  const input = { mountId: 'mount', collectionId: '101', mountRevision: 1, parent: { kind: 'native' as const, binding: root }, title: 'Same name' };
  const [one, two] = await Promise.all([reservations.reserveFolder(input, { planId: 'p1', effectId: 'e1' }), reservations.reserveFolder(input, { planId: 'p2', effectId: 'e2' })]);
  expect(one.commandId).toBe(two.commandId); expect(one.id).toBe(two.id);
  await reservations.setFolderState('mount', '101', 'reserved', 'submitted'); await reservations.setFolderState('mount', '101', 'submitted', 'unknown');
  const three = await reservations.reserveFolder(input, { planId: 'p3', effectId: 'e3' }); expect(three.state).toBe('unknown'); expect(three.commandId).toBe(one.commandId);
  await reservations.cancelConsumer(one.id, 'p1', 'e1');
  expect(await h.db.read('folderConsumers', sourceKey(one.id, 'p2', 'e2'))).toMatchObject({ active: true });
  await expect(reservations.setFolderState('mount', '101', 'unknown', 'reserved')).rejects.toThrow('conflict');
  expect((await reservations.reserveFolder({ ...input, collectionId: '102' }, { planId: 'p4', effectId: 'e4' })).id).not.toBe(one.id);
  await expect(reservations.reserveFolder({ ...input, title: 'Changed' }, { planId: 'p5', effectId: 'e5' })).rejects.toThrow('conflict');
});
test('single-copy intents serialize across purposes; manual delete suppresses reconstruction and missing proof blocks binding', async () => {
  const h = await harness(), r = createSourceReservations(h.db);
  const key: RepresentationKey = { connectionId: h.context.connectionId, itemId: video.id, purpose: 'sourceArchive', sourceCollectionId: '101', mountId: 'mount' };
  const first = await r.reserveItem(key, { title: 'first' }, 'singlePreferSemantic'); expect(first.status).toBe('reserved');
  const second = await r.reserveItem({ ...key, purpose: 'semantic', sourceCollectionId: null, mountId: null }, { title: 'second' }, 'singlePreferSemantic'); expect(second.status).toBe('dependency');
  await r.bindRepresentation({ ...key, native: { ...root, kind: 'bookmark' }, state: 'active', manualRevision: 0 });
  await r.manualChange(key, 'suppressed'); expect((await r.reserveItem(key, {}, 'sourceAndSemantic')).status).toBe('blocked');
  await expect(r.bindRepresentation({ ...key, native: { ...root, kind: 'bookmark', dateAdded: null }, state: 'active', manualRevision: 0 })).rejects.toThrow('unprovenNative');
});
test('future database versions stay intact and disabled instead of resetting source data', async () => {
  const factory = new IDBFactory();
  const future = await new Promise<IDBDatabase>((resolve, reject) => { const r = factory.open('known-site-adapters', 2);
    r.onupgradeneeded = () => { r.result.createObjectStore('future').put('keep', 'sentinel'); }; r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  future.close(); await expect(createSourceDatabase(factory).open()).rejects.toThrow('schemaIncompatible');
  const reopened = await new Promise<IDBDatabase>((resolve, reject) => { const r = factory.open('known-site-adapters', 2); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const value = await new Promise<unknown>(resolve => { const r = reopened.transaction('future').objectStore('future').get('sentinel'); r.onsuccess = () => resolve(r.result); });
  expect(value).toBe('keep'); reopened.close();
});
test('import overlay preserves a newer source collection rename and detects cursor cycles', async () => {
  const h = await harness(); await h.ledger.startImport(h.context, 'run');
  await h.ledger.acceptObservation(h.context, 'rename', { type: 'catalog.upsert', collections: [{ id: '101', identity: 'siteId', title: 'New', parentId: null }] });
  const issue = (id: string, cursor: string | null) => h.ledger.issuePage({ id, runId: 'run', context: h.context, deadlineAt: Date.now() + 30000, query: { kind: 'collections', cursor } });
  const result = (nextCursor: string) => ({ status: 'ok', kind: 'collections', page: { items: [{ id: '101', identity: 'siteId', title: 'Old', parentId: null }], nextCursor, consistency: 'bestEffort', coverage: 'complete' } } as const);
  await issue('a', null); expect((await h.ledger.acceptPage(h.context, 'a', result('a'))).status).toBe('accepted');
  expect(await h.db.read('collections', sourceKey(h.context.connectionId, '101'))).toMatchObject({ entity: { title: 'New' } });
  await issue('b', 'a'); expect((await h.ledger.acceptPage(h.context, 'b', result('b'))).status).toBe('accepted');
  await issue('c', 'b'); expect(await h.ledger.acceptPage(h.context, 'c', result('a'))).toMatchObject({ status: 'rejected', reason: 'invalid' });
});
test('capacity pauses admission without evicting unfinished observations', async () => {
  const h = await harness();
  await h.db.transaction(['observations'], 'readwrite', async tx => {
    for (let i = 0; i < 10000; i++) tx.objectStore('observations').put({ id: String(i), state: 'pending', context: h.context, observation }, String(i));
  });
  expect(await h.ledger.acceptObservation(h.context, 'overflow', observation)).toMatchObject({ status: 'rejected', reason: 'capacity' });
  expect(await h.db.read('meta', 'ordinal')).toBeUndefined(); expect(await h.db.read('observations', '0')).toMatchObject({ state: 'pending' });
});
