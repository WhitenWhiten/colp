import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test } from 'vitest';
import { MemoryStorageArea, createCredentialStore } from '../src/credential-store.js';
import { digestJson } from '../src/bookmark-event-codec.js';
import { configurePersonalSyncTransport } from '../src/personal-sync-fetch.js';
import { createPersonalSyncPolicyStore } from '../src/personal-sync-policy.js';
import { recoverVerifiedOrFreeze } from '../src/recovery-guard.js';
import { detachScopeMount } from '../src/scope-detach.js';
import { sessionMatchesCredentialAuthority } from '../src/session-client.js';
import { createSyncEffectAuthority } from '../src/sync-effect-authority.js';
import { SyncFailureError } from '../src/sync-failure-class.js';
import { createSyncStateStore, type MappingInput, type SyncScope } from '../src/sync-state-store.js';
import { fakeChrome } from './recovery-projection-chrome-fixture.js';
import { REJOIN_TOKEN, rejoinSession } from './rejoin-http-fixture.js';

// Only browser storage/IndexedDB and the external native API are substituted.
// Recovery owns the actual persisted delete; the test never writes an intent.
const policy = createPersonalSyncPolicyStore(new MemoryStorageArea());
configurePersonalSyncTransport(policy);
let serial = 0;

async function fixture() {
  const local = new MemoryStorageArea(), indexedDB = new IDBFactory();
  let credentials = createCredentialStore(local);
  const authority = await credentials.fence.activate();
  const binding = await credentials.getOrCreateBinding(authority.generation);
  const scope: SyncScope = { environment: 'development', serverId: 'https://snapshot-authority.test',
    serverOrigin: 'https://snapshot-authority.test', accountId: `snapshot-authority-${++serial}`,
    browserProfileId: binding.browserProfileId, collectionId: 'collection', replicaId: binding.replicaId,
    generation: Number(binding.generation) };
  await credentials.saveCredential({ accessToken: REJOIN_TOKEN, tokenType: 'Bearer', subject: scope.accountId,
    expiresAt: Date.now() + 3_600_000, scope: ['known.sync'], issuer: `${scope.serverOrigin}/`,
    audience: 'known-sync-api', clientId: 'known-chromium-extension', serverOrigin: scope.serverOrigin });
  const session = await rejoinSession(scope); await credentials.saveSession(session);
  await policy.write(scope, 'enabled');
  let store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active',
    lease: { leaseId: session.replicaLease.leaseId, generation: session.replicaLease.generation,
      expiresAt: Date.parse(session.replicaLease.expiresAt) },
    checkpoint: { serverRevision: session.collection.serverRevision, cursor: session.collection.serverCursor },
    selectedRoots: ['root'], privateRoots: ['private'], rootStatus: 'ready' });
  const root: MappingInput = { nativeId: '1', colpId: 'root', rootNativeId: '1', nodeKind: 'folder',
    mountId: 'mount', projection: { revision: 'root-r1', digest: digestJson({ title: 'Selected' }),
      childrenRevision: 'root-children-r1', content: { title: 'Selected' } } };
  const privateRoot: MappingInput = { nativeId: '3', colpId: 'private', rootNativeId: '1', nodeKind: 'folder',
    mountId: 'mount', parentNativeId: '1', parentColpId: 'root',
    projection: { revision: 'private-r1', digest: digestJson({ title: 'Private' }),
      childrenRevision: 'private-children-r1', content: { title: 'Private' } } };
  const target: MappingInput = { nativeId: '2', colpId: 'target', rootNativeId: '1', nodeKind: 'bookmark',
    mountId: 'mount', parentNativeId: '1', parentColpId: 'root',
    projection: { revision: 'target-r1', digest: digestJson({ title: 'Target', url: 'https://target.test/' }),
      content: { title: 'Target', url: 'https://target.test/' } } };
  for (const row of [root, target, privateRoot]) await store.putMapping(scope, row);
  await store.putMountBinding(scope, { mountId: 'mount', nativeRootId: '1', remoteMountNodeId: 'root',
    customSourceKey: 'folder:1', boundaryVersion: '1', materialized: true, status: 'active' });
  const chrome = fakeChrome([{ id: '1', title: 'Selected' },
    { id: '2', parentId: '1', index: 1, title: 'Target', url: 'https://target.test/' },
    { id: '3', parentId: '1', index: 0, title: 'Private' },
    { id: '4', parentId: '1', index: 2, title: 'Parent' }]);
  const removals: string[] = [];
  const ports: { afterChildren?: (id: string) => Promise<void> } = {};
  const nativeApi = { ...chrome.api,
    async getChildren(id: string) { const result = await chrome.api.getChildren(id); await ports.afterChildren?.(id); return result; },
    async remove(id: string) { removals.push(id); await chrome.api.remove(id); } };

  async function effects() {
    const currentScope = async (): Promise<SyncScope> => {
      const [credential, currentSession, currentBinding, recorded] = await Promise.all([
        credentials.loadCredential(), credentials.loadSession(), credentials.loadBinding(), store.getScope(scope),
      ]);
      expect(credential?.expiresAt).toBeGreaterThan(Date.now());
      expect(currentSession).not.toBeNull(); expect(credential).not.toBeNull(); expect(currentBinding).not.toBeNull();
      expect(await sessionMatchesCredentialAuthority(currentSession!, credential!)).toBe(true);
      expect(recorded?.lease).toMatchObject({ leaseId: currentSession!.replicaLease.leaseId,
        generation: currentSession!.replicaLease.generation });
      expect(recorded?.lease?.expiresAt).toBeGreaterThan(Date.now());
      return { ...scope, accountId: credential!.subject!, collectionId: currentSession!.collection.collectionId,
        browserProfileId: currentBinding!.browserProfileId, replicaId: currentBinding!.replicaId,
        generation: Number(currentBinding!.generation) };
    };
    return createSyncEffectAuthority({ scope, context: await credentials.fence.capture(), api: nativeApi,
      assertWritable: generation => credentials.assertWritable(generation), currentScope });
  }
  async function stage(rows: readonly MappingInput[]) {
    await store.stageRecoveryPage(scope, { snapshotId: 'snapshot', sessionId: session.sessionId,
      revision: 'snapshot-r2', syncCursor: 'snapshot-cursor', identityDigest: digestJson(scope), rootNodeId: 'root',
      page: 0, pageDigest: digestJson(rows), previousPageDigest: null, nextCursor: null, complete: true,
      nodes: rows.map((mapping, index) => ({ colpId: mapping.colpId, parentId: mapping.parentColpId ?? null,
        position: String(index), kind: mapping.nodeKind === 'bookmark' ? 'Bookmark' : 'Folder',
        payloadDigest: mapping.projection.digest, mapping })) });
  }
  return { scope, root, target, privateRoot, chrome, removals, ports, effects, stage,
    get store() { return store; },
    restart() { store.close(); store = createSyncStateStore({ indexedDB }); credentials = createCredentialStore(local); },
    close() { store.close(); } };
}

test.each(['active', 'detached', 'private'] as const)(
  'a persisted Snapshot delete respects its current native authority after restart (%s)', async boundary => {
    const f = await fixture();
    try {
      const staged = [f.root, f.privateRoot]; await f.stage(staged);
      const before = await f.effects(); await before.assertCurrent();
      f.chrome.crashOn.remove = 1;
      await expect(recoverVerifiedOrFreeze({ scope: f.scope, store: f.store, staged, api: before.api,
        freezeUnprovenIdentity: true })).rejects.toThrow('chrome_crash');
      expect(await f.store.listProjectionIntents(f.scope)).toEqual([expect.objectContaining({
        kind: 'delete', colpId: 'target', nativeId: '2', generation: f.scope.generation, state: 'recovery',
      })]);
      expect(f.chrome.nodes.has('2')).toBe(true);
      // These are real durable detach semantics / an independent Chrome user
      // move while no event listener is running. The canonical parent stays old.
      if (boundary === 'detached') await detachScopeMount(f.store, f.scope, 'mount');
      f.restart();
      if (boundary === 'private') await f.chrome.api.move('2', { parentId: '3', index: 0 });
      f.removals.length = 0;
      const after = await f.effects(); await after.assertCurrent();
      expect((await f.store.exportScope(f.scope)).recovery).toMatchObject({
        complete: true, sessionId: 'rejoin-session', syncCursor: 'snapshot-cursor',
      });
      await recoverVerifiedOrFreeze({ scope: f.scope, store: f.store, staged, api: after.api,
        freezeUnprovenIdentity: true, recoveryOnly: true }).catch(error => {
        expect(boundary).not.toBe('active'); expect(error).toBeInstanceOf(SyncFailureError);
      });
      await after.assertCurrent();
      if (boundary === 'active') {
        expect(f.removals).toEqual(['2']); expect(f.chrome.nodes.has('2')).toBe(false);
        expect(await f.store.getMappingByColpId(f.scope, 'target')).toBeNull();
        expect(await f.store.listProjectionIntents(f.scope)).toEqual([expect.objectContaining({ state: 'terminal' })]);
      } else {
        expect({ nativeRemoveCalls: f.removals, targetStillPresent: f.chrome.nodes.has('2') })
          .toEqual({ nativeRemoveCalls: [], targetStillPresent: true });
        expect(await f.store.getMappingByColpId(f.scope, 'target')).toMatchObject(f.target);
        expect((await f.store.listProjectionIntents(f.scope))[0]?.state).not.toBe('terminal');
      }
      expect(await f.store.listQueue(f.scope)).toEqual([]);
    } finally { f.close(); }
  });

test.each(['active', 'moved-private'] as const)(
  'Snapshot create checks the native parent again after reading its children (%s)', async boundary => {
    const f = await fixture();
    try {
      const parent: MappingInput = { ...f.privateRoot, nativeId: '4', colpId: 'parent',
        projection: { revision: 'parent-r1', digest: digestJson({ title: 'Parent' }),
          childrenRevision: 'parent-children-r1', content: { title: 'Parent' } } };
      const fresh: MappingInput = { ...f.target, nativeId: 'recovery:fresh', colpId: 'fresh',
        parentNativeId: '4', parentColpId: 'parent',
        projection: { revision: 'fresh-r1', digest: digestJson({ title: 'Fresh', url: 'https://fresh.test/' }),
          content: { title: 'Fresh', url: 'https://fresh.test/' } } };
      await f.store.putMapping(f.scope, parent);
      const staged = [f.root, f.privateRoot, f.target, parent, fresh]; await f.stage(staged);
      let moved = false;
      f.ports.afterChildren = async id => {
        if (boundary !== 'moved-private' || moved || id !== '4') return;
        moved = true;
        // An independent browser edit races the worker's final create. No
        // listener flush has changed the durable canonical parent chain.
        await f.chrome.api.move('4', { parentId: '3', index: 0 });
      };
      const effects = await f.effects(); await effects.assertCurrent();
      await recoverVerifiedOrFreeze({ scope: f.scope, store: f.store, staged, api: effects.api,
        freezeUnprovenIdentity: true }).catch(error => {
        expect(boundary).toBe('moved-private'); expect(error).toBeInstanceOf(SyncFailureError);
      });
      await effects.assertCurrent();
      if (boundary === 'active') {
        expect(f.chrome.creates).toBe(1);
        expect([...f.chrome.nodes.values()].find(row => row.url === 'https://fresh.test/')).toMatchObject({ parentId: '4' });
      } else {
        expect(moved).toBe(true);
        expect(f.chrome.nodes.get('4')?.parentId).toBe('3');
        expect((await f.store.getMappingByColpId(f.scope, 'parent'))?.parentColpId).toBe('root');
        expect({ nativeCreates: f.chrome.creates,
          leakedChild: [...f.chrome.nodes.values()].some(row => row.url === 'https://fresh.test/') })
          .toEqual({ nativeCreates: 0, leakedChild: false });
        expect((await f.store.getApplyIntent(f.scope, 'projection:create:fresh'))?.apiResultEvidence).toBeUndefined();
      }
      expect(await f.store.listQueue(f.scope)).toEqual([]);
    } finally { f.close(); }
  });
