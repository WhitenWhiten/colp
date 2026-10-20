import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect } from 'vitest';
import { MemoryStorageArea, createCredentialStore } from '../src/credential-store.js';
import { digestJson } from '../src/bookmark-event-codec.js';
import { configurePersonalSyncTransport } from '../src/personal-sync-fetch.js';
import { createPersonalSyncPolicyStore } from '../src/personal-sync-policy.js';
import { sessionMatchesCredentialAuthority } from '../src/session-client.js';
import { createSyncEffectAuthority } from '../src/sync-effect-authority.js';
import { createSyncStateStore, type MappingInput, type SyncScope } from '../src/sync-state-store.js';
import { fakeChrome } from './recovery-projection-chrome-fixture.js';
import type { PullBookmarkApi } from '../src/pull-applier-types.js';
import { REJOIN_TOKEN, rejoinSession } from './rejoin-http-fixture.js';

// Only browser storage/IndexedDB and the external native API are substituted.
// Recovery owns the actual persisted delete; the test never writes an intent.
const policy = createPersonalSyncPolicyStore(new MemoryStorageArea());
configurePersonalSyncTransport(policy);
let serial = 0;

export async function snapshotNativeFixture() {
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
  const chrome = fakeChrome([{ id: '0', title: '' }, { id: '1', parentId: '0', title: 'Selected' },
    { id: '2', parentId: '1', index: 1, title: 'Target', url: 'https://target.test/' },
    { id: '3', parentId: '1', index: 0, title: 'Private' },
    { id: '4', parentId: '1', index: 2, title: 'Parent' }]);
  const removals: string[] = [];
  const ports: { afterChildren?: (id: string) => Promise<void>; afterGet?: (id: string) => Promise<void>;
    afterCreate?: () => Promise<void> } = {};
  const nativeApi = { ...chrome.api,
    async get(id: string) { const result = await chrome.api.get(id); await ports.afterGet?.(id); return result; },
    async create(input: Parameters<typeof chrome.api.create>[0]) {
      const result = await chrome.api.create(input); await ports.afterCreate?.(); return result;
    },
    async getChildren(id: string) { const result = await chrome.api.getChildren(id); await ports.afterChildren?.(id); return result; },
    async remove(id: string) { removals.push(id); await chrome.api.remove(id); } };

  async function effects(api: PullBookmarkApi = nativeApi) {
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
    return createSyncEffectAuthority({ scope, context: await credentials.fence.capture(), api,
      assertWritable: generation => credentials.assertWritable(generation), currentScope });
  }
  async function stage(rows: readonly MappingInput[]) {
    await store.stageRecoveryPage(scope, { snapshotId: 'snapshot', sessionId: session.sessionId,
      revision: 'snapshot-r2', syncCursor: 'snapshot-cursor', identityDigest: digestJson({ ...scope }), rootNodeId: 'root',
      page: 0, pageDigest: digestJson(JSON.parse(JSON.stringify(rows))), previousPageDigest: null, nextCursor: null, complete: true,
      nodes: rows.map((mapping, index) => ({ colpId: mapping.colpId, parentId: mapping.parentColpId ?? null,
        position: String(index), kind: mapping.nodeKind === 'bookmark' ? 'Bookmark' : 'Folder',
        payloadDigest: mapping.projection.digest, mapping })) });
  }
  return { scope, root, target, privateRoot, chrome, removals, ports, effects, stage,
    get store() { return store; },
    restart() { store.close(); store = createSyncStateStore({ indexedDB }); credentials = createCredentialStore(local); },
    close() { store.close(); } };
}
