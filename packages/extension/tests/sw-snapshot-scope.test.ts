import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test, vi } from 'vitest';
import { createSyncStateStore } from '../src/sync-state-store.js';
import { MemoryStorageArea, createCredentialStore } from '../src/credential-store.js';
import { createExtensionWorkCoordinator } from '../src/authority-fence.js';

const root = '../src';
const base = { environment: 'development', serverId: 'server', serverOrigin: 'https://known.example',
  accountId: 'account', browserProfileId: 'profile', replicaId: 'replica', generation: 1 };
const scopeA = { ...base, collectionId: 'collection-a' };
const scopeB = { ...base, collectionId: 'collection-b' };
const mapping = (nativeId: string, colpId: string, rootNativeId: string, title: string, extra: object = {}) => ({
  nativeId, colpId, rootNativeId, nodeKind: 'folder', projection: { revision: 'revision-1', digest: 'sha256:content', content: {title} }, ...extra
});

test.each(['snapshot', 'pull-collection', 'pull-login', 'pull-logout'])('worker fences %s at the production effect boundary', async mode => {
  vi.resetModules();
  const syncState = createSyncStateStore({ indexedDB: new IDBFactory() });
  const credentials = createCredentialStore(new MemoryStorageArea());
  const coordinator = createExtensionWorkCoordinator(credentials.fence);
  const native = new Map<string, {id: string; title: string; parentId?: string; url?: string}>([['1', { id:'1', title:'Bookmarks bar' }]]);
  let serial = 1;
  const creates: unknown[] = [];
  const chrome = { bookmarks: {
    get: async (id: string) => native.has(id) ? [{...native.get(id)!}] : [],
    getChildren: async (id: string) => [...native.values()].filter((n:any) => n.parentId === id),
    create: async (input: any) => { const node = { ...input, id: String(++serial) }; native.set(node.id,node); creates.push(node); return node; },
    update: async (id: string, changes: any) => { native.set(id, {...native.get(id)!, ...changes}); },
    move: async (id: string, changes: any) => { native.set(id, {...native.get(id)!, ...changes}); },
    remove: async (id: string) => {native.delete(id);}, removeTree: async (id: string) => {native.delete(id);}
  }, alarms: {create:()=>undefined}, storage:{local:new MemoryStorageArea(),session:new MemoryStorageArea()}};
  vi.stubGlobal('chrome',chrome); vi.stubGlobal('__KNOWN_EXTENSION_EVIDENCE__',false);
  for (const scope of [scopeA, scopeB]) {
    await syncState.registerScope({...scope, lifecycle:'active', lease: {leaseId:'lease',expiresAt:Date.parse('2099-01-01T00:00:00Z')},
      checkpoint:{serverRevision:'revision-1',cursor:'cursor-1'}, selectedRoots:[], rootStatus:'ready'} as any);
    await syncState.putMountBinding(scope as any, {mountId:scope.collectionId+'-mount', nativeRootId:'1',
      remoteMountNodeId:scope === scopeA ? 'a-bar' : 'b-bar', boundaryVersion:'1',materialized:true,status:'active',rootRole:'bookmarks-bar'});
  }
  await syncState.putMapping(scopeB as any, mapping('1','b-bar','1','Bookmarks bar', {rootRole:'bookmarks-bar',mountId:'collection-b-mount'}) as any);
  const staged = [
    mapping('recovery:a-root','a-root','recovery:a-root','A Root', {projection:{revision:'revision-1',digest:'sha256:root',content:{title:'A Root',folderRole:'root'}}}),
    mapping('recovery:a-bar','a-bar','recovery:a-bar','Bookmarks bar', {rootRole:'bookmarks-bar',parentColpId:'a-root'}),
    mapping('recovery:a-secret','a-secret','recovery:a-bar','A collection bookmark', {nodeKind:'bookmark',parentColpId:'a-bar',
      projection:{revision:'revision-1',digest:'sha256:secret',content:{title:'A collection bookmark',url:'https://a-private.example'}}}),
  ];
  let current = scopeA;
  let capturedScope: unknown;
  let failure: unknown;
  vi.doMock(root+'/sw/runtime.js',()=>({store:credentials,syncState,workCoordinator:coordinator,
    sw:{configPromise:Promise.resolve({}),sessionRetryNotBefore:0}, extensionOrigin:()=> 'chrome-extension://test',
    rootScopeKey:()=>JSON.stringify(current), hasBookmarkPermission:async()=>true,
    BOOKMARK_RECOVERY_ALARM:'recovery',COLLECTION_BINDING:'collection',
    faviconSidecar:{list:async()=>[],prune:async()=>0},safeError:(error:Error)=>error.message}));
  vi.doMock(root+'/sw/scope.js',()=>({ currentSyncScope:async()=>current, loadConfig:async()=>({}),
    pushSessionAuthority:async()=>undefined, currentSyncStatusAuthority:async()=>undefined }));
  vi.doMock(root+'/sw/scope-rebuild.js',()=>({replicaRebuilder:()=>({resume:async()=>undefined})}));
  vi.doMock(root+'/sw/bookmarks.js',()=>({bookmarkListenerLifecycle:{install:()=>undefined},currentBookmarkEventQueue:async()=>undefined}));
  // The engine seam delays delivery until selection has changed. Its scope and
  // snapshot callback are supplied by the real production runSyncEngine wiring.
  vi.doMock(root+'/durable-sync-engine.js',()=>({createDurableSyncEngine:(options:any)=>({
    refreshPlacement:async()=>undefined,
    wake:async()=>{
      capturedScope=options.scope;
      if (mode === 'pull-login') await credentials.fence.activate();
      else if (mode === 'pull-logout') await credentials.fence.revoke();
      else current=scopeB;
      try { if (mode === 'snapshot') await options.snapshotProjector(staged);
        else await options.pullApplier.stage({}); } catch(error) { failure=error; throw error; }
    }
  })}));
  const worker = await import('../src/sw/engine.js');
  await worker.runSyncEngine('manual',false,await credentials.fence.capture());
  const mountB=(await syncState.listMountBindings(scopeB as any))[0];
  const childB=await syncState.getMappingByColpId(scopeB as any,'a-secret');
  assert.equal((failure as Error)?.message, 'authority_fenced');
  assert.deepEqual(capturedScope,scopeA);
  assert.ok(mountB);
  assert.equal(mountB.remoteMountNodeId,'b-bar');
  assert.equal(creates.length,0);
  assert.equal(childB, null);
  syncState.close();vi.unstubAllGlobals();
});
