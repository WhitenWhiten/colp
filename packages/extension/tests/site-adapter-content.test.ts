import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test } from 'vitest';
import { createContentBindings, contentIdentityFromUrl } from '../src/site-adapters/content-bindings.js';
import { createSourceDatabase, put } from '../src/site-adapters/source-db.js';
import { createSourceLedger } from '../src/site-adapters/ledger.js';
import { createSourceReservations, representationKey } from '../src/site-adapters/reservations.js';
import { createCaptureCoordinator } from '../src/capture/coordinator.js';
import { createCaptureStore } from '../src/capture/store.js';
import { task, location } from './fixtures/capture.js';
import type { NativeBinding, SavePolicy, RepresentationKey } from '../src/site-adapters/contracts.js';
const policies = ['sourceAndSemantic', 'singlePreferSemantic', 'singleKeepExisting'] as const;
const native: NativeBinding<'bookmark'> = { nativeId: 'native', dateAdded: 10, deviceId: 'device', bindingId: 'proof', kind: 'bookmark', proof: { kind: 'writeReceipt', id: 'receipt' } };
const node = { title: 'Video', parentId: 'semantic', url: 'https://www.bilibili.com/video/av1' };
const request = { itemId: 'video:av:1', commandId: 'command', captureIntentId: 'capture', ...node, automatic: true };
test('semantic roles are scoped to their destination library and private source identity', async () => {
  const f = await fixture('sourceAndSemantic');
  try {
    const saved = await f.bindings.prepare({ ...request, scopeId: 'library-a' }); await f.bindings.acknowledge(saved, native, node);
    const reused = await f.bindings.prepare({ ...request, commandId: 'reuse', captureIntentId: 'reuse', scopeId: 'library-a' });
    expect(reused.mode).toBe('reuse');
    const separate = await f.bindings.prepare({ ...request, commandId: 'other-library', captureIntentId: 'other-library', scopeId: 'library-b' });
    expect(separate.mode).toBe('create');
    await expect(f.bindings.prepare({ ...request, commandId: 'private', captureIntentId: 'private', scopeId: 'library-a',
      content: { siteKey: 'bilibili', identityVersion: 1, itemId: request.itemId, accountId: 'private-owner' } })).rejects.toThrow('content_identity_unresolved');
  } finally { await f.db.close(); }
});
async function fixture(copies: SavePolicy['copies'], connected = true) {
  const db = createSourceDatabase(new IDBFactory()), ledger = createSourceLedger(db); let invalid = false;
  const bindings = createContentBindings(db, async b => { if (invalid || b.dateAdded !== 10) throw new Error('content_binding_needs_review'); });
  const a = await ledger.setAuthority({ enabled: connected, installationGeneration: 1, sourceSessionGeneration: 1, accountId: connected ? '42' : null, negativeReadback: false });
  const connectionId = a.connectionId ?? 'later-connection';
  if (!a.connectionId) await db.transaction(['connections'], 'readwrite', async tx => { put(tx, 'connections', 'later-connection', { id: connectionId, siteKey: 'bilibili', identityVersion: 1, accountId: '42' }); });
  const policy: SavePolicy = { revision: 1, copies, sourceRemoval: 'retainArchive', backgroundClassification: 'disabled' };
  await db.transaction(['meta'], 'readwrite', async tx => { put(tx, 'meta', `policy:${connectionId}`, { connectionId, enabled: true, liveArchive: true, policy }); });
  const representation: RepresentationKey = { connectionId, itemId: request.itemId, purpose: 'sourceArchive', sourceCollectionId: '101', mountId: 'mount' };
  return { db, ledger, bindings, policy, connectionId, representation, invalid: () => { invalid = true; } };
}
for (const copies of policies) {
  test(`popup-first binding joins a later source connection under ${copies}`, async () => {
    const f = await fixture(copies, false), binding = await f.bindings.prepare(request);
    expect(binding.native).toBeNull(); expect(binding.connectionId).toBeNull();
    await f.bindings.acknowledge(binding, native, node);
    const result = await f.bindings.sourceDecision({ connectionId: f.connectionId, itemId: request.itemId, policy: f.policy, representation: f.representation });
    expect(result.status).toBe(copies === 'sourceAndSemantic' ? 'create' : 'reuse');
    expect((await f.bindings.forIntent(request.captureIntentId))?.connectionId).toBe(f.connectionId); await f.db.close();
  });
  test(`source-first semantic intent chooses the correct effect under ${copies}`, async () => {
    const f = await fixture(copies);
    await createSourceReservations(f.db).bindRepresentation({ ...f.representation, native, state: 'active', manualRevision: 0, lastWritten: node });
    const b = await f.bindings.prepare(request);
    expect(b.mode).toBe(copies === 'sourceAndSemantic' ? 'create' : copies === 'singlePreferSemantic' ? 'reclassify' : 'suggest');
    expect(b.native?.nativeId ?? null).toBe(copies === 'sourceAndSemantic' ? null : native.nativeId);
    expect(b.forceAnother).toBe(copies === 'sourceAndSemantic'); await f.db.close();
  });
  test(`simultaneous pending semantic save remains a source dependency under ${copies}`, async () => {
    const f = await fixture(copies); await f.bindings.prepare(request);
    const result = await f.bindings.sourceDecision({ connectionId: f.connectionId, itemId: request.itemId, policy: f.policy, representation: f.representation });
    expect(result.status).toBe(copies === 'sourceAndSemantic' ? 'create' : 'dependency');
    await expect(f.bindings.prepare({ ...request, commandId: 'other' })).rejects.toThrow('semantic_save_pending'); await f.db.close();
  });
}
test.each(['reserved', 'submitted', 'unknown'] as const)('source state %s does not strand the independent semantic save before its source receipt commits', async state => {
  const f = await fixture('sourceAndSemantic'), reservations = createSourceReservations(f.db);
  await reservations.reserveItem(f.representation, { url: node.url }, 'sourceAndSemantic', 'source-command');
  if (state !== 'reserved') await reservations.setItemState(f.representation, 'reserved', 'submitted');
  if (state === 'unknown') await reservations.setItemState(f.representation, 'submitted', 'unknown');
  const binding = await f.bindings.prepare(request), store = createCaptureStore(new IDBFactory());
  let creates = 0;
  const sourceLocation = { ...location, nativeId: native.nativeId, url: node.url };
  const coordinator = createCaptureCoordinator({ store, now: () => 20, assertCurrent: async () => {},
    // The browser exposes the source bookmark before the source executor commits its representation.
    existence: async () => ({ kind: 'local', exact: [sourceLocation], similar: [],
      coverage: { local: 'complete', cloud: 'not-checked', collectionIds: [], checkedAt: 20, stale: false } }),
    create: async (_task, reserved) => { creates++; await reserved('semantic-intent');
      return { nativeId: 'semantic-copy', nativeDateAdded: 10, location: { ...sourceLocation, nativeId: 'semantic-copy' }, sync: 'local-only' }; },
    receipt: async () => null,
    acknowledge: async saved => { await f.bindings.acknowledge(binding, { ...native, nativeId: saved.nativeId! }, node); },
  });
  try {
    await coordinator.start({ ...task, url: node.url, saveAnother: binding.forceAnother ?? false });
    expect(await coordinator.resume(task.scope, task.captureId)).toMatchObject({ disposition: 'new', save: 'local-saved', nativeId: 'semantic-copy' });
    expect(creates).toBe(1);
    await reservations.bindRepresentation({ ...f.representation, native, state: 'active', manualRevision: 0, lastWritten: node });
    expect((await f.bindings.forIntent(request.captureIntentId))?.native?.nativeId).toBe('semantic-copy');
  } finally { await store.close(); await f.db.close(); }
});

test.each(['singlePreferSemantic', 'singleKeepExisting'] as const)('a pending source copy remains a dependency under %s', async policy => {
  const f = await fixture(policy);
  try {
    await createSourceReservations(f.db).reserveItem(f.representation, { url: node.url }, policy, 'source-command');
    await expect(f.bindings.prepare(request)).rejects.toThrow('source_save_pending');
  } finally { await f.db.close(); }
});

test.each([false, true])('the both-locations policy preserves duplicate checks without a live source reservation (blocked: %s)', async blocked => {
  const f = await fixture('sourceAndSemantic');
  try {
    if (blocked) {
      const reservations = createSourceReservations(f.db);
      await reservations.reserveItem(f.representation, { url: node.url }, 'sourceAndSemantic', 'source-command');
      await reservations.setItemState(f.representation, 'reserved', 'blocked');
    }
    expect((await f.bindings.prepare(request)).forceAnother).toBe(false);
  } finally { await f.db.close(); }
});

test('content normalization is account-independent; unsupported short links never alias an equal URL', () => {
  expect(contentIdentityFromUrl('https://www.bilibili.com/video/av1/?tracking=value')).toEqual({ siteKey: 'bilibili', identityVersion: 1, itemId: request.itemId });
  expect(contentIdentityFromUrl('https://b23.tv/ambiguous')).toBeNull(); expect(contentIdentityFromUrl('https://evil.test/video/av1')).toBeNull();
});
test('replay pins the original semantic intent and changed request fields conflict', async () => {
  const f = await fixture('sourceAndSemantic'), b = await f.bindings.prepare(request);
  expect(await f.bindings.prepare({ ...request, captureIntentId: 'replacement' })).toEqual(b);
  await expect(f.bindings.prepare({ ...request, title: 'Changed' })).rejects.toThrow('command_id_reused'); await f.db.close();
});
test('equal-URL bookmarks need explicit adoption; another account cannot take over a proven binding', async () => {
  const f = await fixture('singlePreferSemantic'), b = await f.bindings.prepare(request);
  expect(b.native).toBeNull(); expect(b.forceAnother).toBe(false);
  await expect(f.bindings.adopt(b, native, node, f.connectionId)).rejects.toThrow('explicit_adoption_required');
  const adopted = await f.bindings.adopt(b, { ...native, proof: { kind: 'explicitAdoption', id: 'consent' } }, node, f.connectionId);
  await expect(f.bindings.adopt(adopted, { ...native, proof: { kind: 'explicitAdoption', id: 'other' } }, node, 'another')).rejects.toThrow('content_account_adoption_required');
  expect((await f.bindings.adopt(adopted, { ...native, proof: { kind: 'explicitAdoption', id: 'other' } }, node, 'another', true)).connectionId).toBe('another'); await f.db.close();
});
test('manual changes and mismatched native creation proof block automatic reuse', async () => {
  const f = await fixture('singleKeepExisting'), b = await f.bindings.prepare(request); await f.bindings.acknowledge(b, native, node); f.invalid();
  await expect(f.bindings.sourceDecision({ connectionId: f.connectionId, itemId: request.itemId, policy: f.policy, representation: f.representation })).rejects.toThrow('content_binding_needs_review');
  expect((await f.bindings.forIntent(request.captureIntentId))?.native).toEqual(native); await f.db.close();
});

test('a suppressed source edge does not block an independent source copy under the both-locations policy', async () => {
  const f = await fixture('sourceAndSemantic'), reservations = createSourceReservations(f.db);
  await reservations.bindRepresentation({ ...f.representation, native, state: 'active', manualRevision: 0, lastWritten: node });
  await reservations.manualChange(f.representation, 'suppressed');
  expect((await f.bindings.sourceDecision({ connectionId: f.connectionId, itemId: request.itemId, policy: f.policy,
    representation: { ...f.representation, sourceCollectionId: '102' } })).status).toBe('create'); await f.db.close();
});
test.each(policies.flatMap(copies => (['detached', 'suppressed'] as const).map(state => ({ copies, state }))))(
  '$copies handles a $state source archive without changing its opt-out', async ({ copies, state }) => {
    const f = await fixture(copies), reservations = createSourceReservations(f.db);
    try {
      await reservations.bindRepresentation({ ...f.representation, native, state: 'active', manualRevision: 0, lastWritten: node });
      await reservations.manualChange(f.representation, state);
      if (copies === 'sourceAndSemantic') {
        expect(await f.bindings.prepare(request)).toMatchObject({ mode: 'create', native: null, forceAnother: true });
      } else await expect(f.bindings.prepare(request)).rejects.toThrow('content_binding_needs_review');
      expect(await f.db.read('representations', representationKey(f.representation))).toMatchObject({ state, native });
    } finally { await f.db.close(); }
  },
);

test.each(['singleKeepExisting', 'singlePreferSemantic'] as const)('%s only reuses source copies in the requested destination scope', async policy => {
  const f = await fixture(policy);
  try {
    const library = { serverOrigin: 'https://sync.test', accountId: 'owner', collectionId: 'library' };
    const copy = { purpose: 'sourceArchive' as const, sourceAccount: '42', sourceCollectionId: '101', content: { site: 'bilibili', identityVersion: 1, itemId: request.itemId, accountId: null } };
    await createSourceReservations(f.db).bindRepresentation({ ...f.representation, native, state: 'active', manualRevision: 0, lastWritten: node,
      shared: { library, nodeId: 'canonical', slot: { kind: 'bookmark', copy } } });
    const local = await f.bindings.prepare({ ...request, scopeId: JSON.stringify(['local', 'device']) });
    expect(local).toMatchObject({ mode: 'create', native: null });
    const synced = await f.bindings.prepare({ ...request, commandId: 'synced', captureIntentId: 'synced', scopeId: JSON.stringify(['https://sync.test', 'owner', 'library']) });
    expect(synced.native).toEqual(native);
  } finally { await f.db.close(); }
});
test('single-copy reservations in separate scopes do not block each other', async () => {
  const f = await fixture('singleKeepExisting'), reservations = createSourceReservations(f.db);
  try {
    const semantic = { ...f.representation, purpose: 'semantic' as const, sourceCollectionId: null, mountId: null, scopeId: 'library' };
    await reservations.reserveItem(semantic, { title: 'pending semantic' }, 'singleKeepExisting', 'semantic');
    const result = await reservations.reserveItem({ ...f.representation, scopeId: JSON.stringify(['local', 'device']) }, { title: 'local source' }, 'singleKeepExisting', 'source');
    expect(result.status).toBe('reserved');
  } finally { await f.db.close(); }
});
