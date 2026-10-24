import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test, expect } from 'vitest';
import { createSourceDatabase, sourceKey } from '../src/site-adapters/source-db.js';
import { createSourceReservations } from '../src/site-adapters/reservations.js';
import { createPlannedSaveExecutor, persistSavePlan, effectDigest } from '../src/site-adapters/planned-executor.js';
import type { NativeBinding, SavePlan, SaveEffect, RepresentationKey } from '../src/site-adapters/contracts.js';
import type { PlannedNativeCommand, PlannedNativeResult, PlannedExecutionPorts, SourceOutbox } from '../src/site-adapters/planned-types.js';
import { video } from './fixtures/site-adapters/bilibili.js';
const root: NativeBinding<'folder'> = { bindingId: 'root', nativeId: 'root', deviceId: 'device', kind: 'folder', dateAdded: 10, proof: { kind: 'explicitAdoption', id: 'adoption' } };
const scope = { serverOrigin: 'https://known.test', accountId: null, authorityGeneration: 1, collectionId: null };
async function harness() {
  const db = createSourceDatabase(new IDBFactory()), reservations = createSourceReservations(db);
  await db.transaction(['authorities'], 'readwrite', async tx => { tx.objectStore('authorities').put({ enabled: true, connectionId: 'connection', accountId: '42', installationGeneration: 1, sourceSessionGeneration: 1, negativeReadback: false }, 'bundled.bilibili'); });
  const native = new Map<string, PlannedNativeResult>(), counts = { folder: 0, bookmark: 0, acknowledgments: 0 }; let authorized = true;
  const ports: PlannedExecutionPorts = {
    deviceId: async () => 'device', scope: async () => scope, authorize: async () => { if (!authorized) throw new Error('paused'); },
    assertNative: async b => { if (!b.dateAdded) throw new Error('identityUnproven'); },
    execute: async (command, _digest, authorize) => {
      const old = native.get(command.commandId); if (old) return old; await authorize(); counts[command.kind]++;
      const result: PlannedNativeResult = { status: 'confirmed', native: { bindingId: command.commandId, nativeId: `native-${command.commandId}`, kind: command.kind,
        deviceId: 'device', dateAdded: 100, proof: { kind: 'writeReceipt', id: command.commandId } } }; native.set(command.commandId, result); return result;
    }, recover: async command => native.get(command.commandId) ?? null,
    acknowledge: async () => { counts.acknowledgments++; },
  };
  const seal = <T extends SaveEffect>(e: T): T => ({ ...e, payloadDigest: effectDigest(e) });
  async function plan(id: string, aid = '1') {
    const folder = await reservations.reserveFolder({ mountId: 'mount', collectionId: '101', mountRevision: 1, parent: { kind: 'native', binding: root }, title: 'Collection' }, { planId: id, effectId: 'folder' });
    const ensure = seal({ effectId: 'folder', commandId: `consumer-${id}`, payloadDigest: '', folderReservationDigest: folder.payloadDigest, dependsOn: [], kind: 'ensureSourceFolder', reservationId: folder.id } as const);
    const rep: RepresentationKey = { connectionId: 'connection', itemId: `video:av:${aid}`, purpose: 'sourceArchive', sourceCollectionId: '101', mountId: 'mount' };
    const bookmark = seal({ effectId: `bookmark-${aid}`, commandId: `bookmark-command-${aid}`, payloadDigest: '', folderReservationDigest: folder.payloadDigest,
      dependsOn: ['folder'], kind: 'createBookmark', representation: rep, item: { ...video, id: rep.itemId, url: `https://www.bilibili.com/video/av${aid}` }, parent: { kind: 'sourceFolder', reservationId: folder.id } } as const);
    const { payloadDigest: _digest, ...payload } = bookmark;
    await reservations.reserveItem(rep, payload, 'sourceAndSemantic', bookmark.commandId);
    const value: SavePlan = { id, trigger: { kind: 'observation', observationId: 'observation' }, purpose: 'sourceArchive', connectionId: 'connection',
      installationGeneration: 1, collectorGeneration: 1, sourceSessionGeneration: 1, importApprovalId: null,
      browserRules: { storageVersion: 3, listRevision: 1, contentVersions: {} }, rule: null, mount: { id: 'mount', revision: 1 },
      policyRevision: 1, classificationPolicyDigest: 'disabled', classification: 'disabled', effects: [ensure, bookmark] };
    await persistSavePlan(db, value, 'approved'); return { value, folder, bookmark, ensure };
  }
  return { db, ports, native, counts, plan, reservations, pause: () => { authorized = false; }, executor: () => createPlannedSaveExecutor(db, ports) };
}
test('planned execution resolves a shared folder receipt before creating the bookmark and retains exact replay', async () => {
  const h = await harness(), p = await h.plan('plan'), runner = h.executor();
  expect(await runner.execute('plan', p.bookmark.effectId)).toMatchObject({ status: 'blocked', reason: 'dependencyPending' });
  expect((await runner.execute('plan', 'folder')).status).toBe('confirmed');
  expect((await runner.execute('plan', p.bookmark.effectId)).status).toBe('confirmed');
  expect((await h.executor().execute('plan', p.bookmark.effectId)).status).toBe('confirmed');
  expect(h.counts).toMatchObject({ folder: 1, bookmark: 1 });
  const outbox = await h.db.read<SourceOutbox>('outbox', p.bookmark.commandId);
  expect(outbox?.state).toBe('acknowledged'); expect(outbox?.command.parent.nativeId).toBe(`native-${p.folder.commandId}`);
});
test('two approved item plans share one folder command; cancelling a consumer preserves the other', async () => {
  const h = await harness(), one = await h.plan('one'), two = await h.plan('two', '2'), runner = h.executor();
  const results = await Promise.all([runner.execute('one', 'folder'), runner.execute('two', 'folder')]);
  expect(results.every(r => r.status === 'confirmed')).toBe(true); expect(h.counts.folder).toBe(1);
  await h.reservations.cancelConsumer(one.folder.id, 'one', 'folder');
  expect((await runner.execute('two', two.bookmark.effectId)).status).toBe('confirmed'); expect(h.counts.bookmark).toBe(1);
});
test('native unknown is never replaced, even for a new shared folder consumer', async () => {
  const h = await harness(), p = await h.plan('one');
  h.ports.execute = async command => { const old = h.native.get(command.commandId); if (old) return old;
    h.counts.folder++; const unknown = { status: 'unknown', reason: 'nativeOutcomeUnknown' } as const; h.native.set(command.commandId, unknown); return unknown; };
  expect((await h.executor().execute('one', 'folder')).status).toBe('unknown');
  await h.plan('two', '2'); expect((await h.executor().execute('two', 'folder')).status).toBe('unknown');
  expect(h.counts.folder).toBe(1); expect(await h.db.read('folderReservations', sourceKey('mount', '101'))).toMatchObject({ state: 'unknown', commandId: p.folder.commandId });
});
test('crash after executor receipt but before source acknowledgment recovers the same native command', async () => {
  const h = await harness(), p = await h.plan('one'); const original = h.db.transaction.bind(h.db); let crash = true;
  h.db.transaction = ((stores: any, mode: any, work: any) => original(stores, mode, async tx => {
    const result = await work(tx); if (crash && stores.includes('representations') && stores.includes('outbox') && stores.includes('effects')) { crash = false; tx.abort(); } return result;
  })) as typeof h.db.transaction;
  expect((await h.executor().execute('one', 'folder')).status).toBe('blocked'); expect(h.counts.folder).toBe(1);
  expect((await h.db.read<SourceOutbox>('outbox', p.folder.commandId))?.state).toBe('submitted');
  expect((await h.executor().execute('one', 'folder')).status).toBe('confirmed'); expect(h.counts.folder).toBe(1);
  expect(h.counts.acknowledgments).toBe(1);
});
test('late proven receipts are retained after revocation; unsent siblings remain blocked', async () => {
  const h = await harness(), p = await h.plan('one'), original = h.ports.execute;
  h.ports.execute = async (...args) => { const result = await original(...args); h.pause(); return result; };
  expect((await h.executor().execute('one', 'folder')).status).toBe('confirmed');
  expect((await h.executor().execute('one', p.bookmark.effectId)).status).toBe('blocked'); expect(h.counts).toMatchObject({ folder: 1, bookmark: 0 });
});
test('draft/import approval and immutable command changes cannot dispatch', async () => {
  const h = await harness(), p = await h.plan('one');
  await persistSavePlan(h.db, p.value, 'draft'); expect((await h.executor().execute('one', 'folder')).status).toBe('blocked'); expect(h.counts.folder).toBe(0);
  await expect(persistSavePlan(h.db, { ...p.value, policyRevision: 2 }, 'approved')).rejects.toThrow('conflict');
  const imported = { ...p.value, id: 'import', trigger: { kind: 'import', importRunId: 'run', previewId: 'preview' } } as SavePlan;
  await persistSavePlan(h.db, imported, 'approved');
  expect(await h.executor().execute('import', 'folder')).toMatchObject({ status: 'blocked', reason: 'importApprovalRequired' });
});
test('cyclic and unresolved effect graphs are rejected before any native command', async () => {
  const h = await harness(), p = await h.plan('one');
  const cyclic = p.value.effects.map(e => { const next = { ...e, dependsOn: e.effectId === 'folder' ? [p.bookmark.effectId] : ['folder'] }; return { ...next, payloadDigest: effectDigest(next) }; });
  await expect(persistSavePlan(h.db, { ...p.value, id: 'cycle', effects: cyclic }, 'approved')).rejects.toThrow('invalidPlan');
  expect(h.counts).toMatchObject({ folder: 0, bookmark: 0 });
});
test('lost executor acknowledgment keeps the proven source receipt and retries only the handshake', async () => {
  const h = await harness(), p = await h.plan('one'); let fail = true;
  h.ports.acknowledge = async () => { if (fail) throw new Error('ackLost'); h.counts.acknowledgments++; };
  expect((await h.executor().execute('one', 'folder')).status).toBe('blocked');
  expect(await h.db.read('outbox', p.folder.commandId)).toMatchObject({ state: 'acknowledged', native: { kind: 'folder' } });
  fail = false; expect((await h.executor().execute('one', 'folder')).status).toBe('confirmed'); expect(h.counts.folder).toBe(1);
  expect(await h.db.read('outbox', p.folder.commandId)).toMatchObject({ executorAcknowledged: true });
});
