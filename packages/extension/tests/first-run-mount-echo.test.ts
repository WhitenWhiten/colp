import { canonicalAuthoritativeEffectDigest, canonicalOperationDigest } from '@know-n/colp/sync';
import type { Operation, SyncPullEventV02 } from '@know-n/colp/types';
import { expect, test, vi } from 'vitest';
import { node, replaceTree, scope, tree } from './sw-authority-entry-fixture.js';
import { store, syncState } from '../src/sw/runtime.js';
import { createDurableSyncEngine } from '../src/durable-sync-engine.js';
import { createPullApplier } from '../src/pull-applier.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { recoverVerifiedOrFreeze } from '../src/recovery-guard.js';
import { assertQueuedUploadAllowed } from '../src/queued-upload-boundary.js';
import { handleFirstRunRequest, resumeRunningBootstrap } from '../src/sw/first-run.js';
import { loadRootView } from '../src/sw/roots.js';
import { installRejoinHttp, REJOIN_TOKEN } from './rejoin-http-fixture.js';
import { endpoints } from './outbound-push-worker-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import type { RemoteNodeFact } from '../src/bootstrap/matcher.js';
import { STORES } from '../src/sync-state/schema.js';
import { transactionDone } from '../src/sync-state/idb.js';

const remote: RemoteNodeFact[] = [
  { nodeId: 'library-root', parentId: null, folderRole: 'root', kind: 'folder', title: 'Library', revision: 'r-root', childrenRevision: 'c-root' },
  { nodeId: 'remote-1', parentId: 'library-root', folderRole: 'bookmarks-bar', kind: 'folder', title: 'Bar', revision: 'r-bar', childrenRevision: 'c-bar' },
  { nodeId: 'remote-2', parentId: 'library-root', folderRole: 'other-bookmarks', kind: 'folder', title: 'Other', revision: 'r-other', childrenRevision: 'c-other' },
];

test.each(['current', 'another-profile-cloud-root', 'admitted-preview-expired', 'unconfirmed', 'stale-boundary', 'completed-run',
  'wrong-run', 'unselected-preview', 'wrong-preview-owner', 'moved-under-excluded', 'other-replica', 'different-payload'] as const)
('first-run ordinary mount receives only its current admitted parent echo before completed selection exists (%s)', async scenario => {
  const selectedTitle = scenario === 'another-profile-cloud-root' ? 'Profile B root' : 'Selected folder';
  if (scenario === 'another-profile-cloud-root') Object.assign(node('10'), { title: selectedTitle });
  const initialRemote: RemoteNodeFact[] = scenario === 'another-profile-cloud-root' ? [...remote,
    { nodeId: 'profile-a-folder', parentId: 'remote-1', kind: 'folder', title: 'Profile A root',
      revision: 'profile-a-revision', childrenRevision: 'profile-a-children' }] : remote;
  let session = { ...(await store.loadSession())!, snapshotRequired: true };
  await store.saveSession(session);
  const beforeNative = structuredClone(tree), clock = { now: Date.now() }, acked: string[] = [];
  const snapshotRequests = installRejoinHttp(() => scope, () => initialRemote), snapshotFetch = fetch;
  const events: Extract<SyncPullEventV02, { kind: 'operation' }>[] = [];
  const canonical = new Map(initialRemote.map(row => [row.nodeId, { ...row }]));
  let delivered = 0;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/manifest.json' || url.pathname === '/v1/snapshot') return snapshotFetch(input, init);
    if (url.pathname === '/v1/snapshot/conflicts') return Response.json({
      snapshotId: 'rejoin-snapshot', offset: 0, nextOffset: null, conflictCount: 0, conflicts: [] });
    if (url.pathname === '/v1/ack') {
      const body = JSON.parse(String(init?.body));
      expect(await syncState.getPendingAckIntent(scope)).toMatchObject({ cursor: body.cursor, state: 'pending' });
      acked.push(body.cursor); session = { ...session, snapshotRequired: false };
      await store.saveSession(session);
      return Response.json({ replicaId: scope.replicaId, ackedCursor: body.cursor, ackedAt: new Date().toISOString() });
    }
    if (url.pathname === '/v1/push') {
      const body = JSON.parse(String(init?.body)) as { batchId: string; operations: Operation[] };
      expect(body.operations).toHaveLength(1);
      const operation = body.operations[0]!;
      if (operation.type !== 'create_node') throw new Error('unexpected first-run operation');
      if (operation.payload.node.kind !== 'folder' && operation.payload.node.kind !== 'bookmark') throw new Error('unexpected first-run node');
      expect(canonical.has(operation.payload.parentId)).toBe(true);
      const template = pullFixtures.createEvent({ kind: operation.payload.node.kind === 'folder' ? 'Folder' : 'Bookmark',
        sequence: operation.sequence, collectionId: scope.collectionId, parentId: operation.payload.parentId,
        replicaId: scope.replicaId, opId: operation.opId });
      if (template.kind !== 'operation' || template.effect.kind !== 'node_created') throw new Error('invalid create fixture');
      const effect = { ...template.effect, node: { ...operation.payload.node, id: `created-${events.length + 1}`,
        revision: `created-r${events.length + 1}`, collectionId: scope.collectionId, parentId: operation.payload.parentId,
        position: template.effect.placement.position, visibility: 'private' as const,
        createdAt: operation.occurredAt, updatedAt: operation.occurredAt },
      operationDigest: canonicalOperationDigest(operation), effectDigest: '' };
      effect.effectDigest = canonicalAuthoritativeEffectDigest(effect);
      events.push({ ...template, operation, effect });
      canonical.set(effect.node.id, { nodeId: effect.node.id, parentId: effect.node.parentId,
        kind: effect.node.kind === 'bookmark' ? 'bookmark' : 'folder', title: effect.node.title ?? '', revision: effect.node.revision });
      return Response.json({ batchId: body.batchId, serverCursor: template.cursor, results: [{
        opId: operation.opId, sequence: operation.sequence, status: 'applied', targetId: effect.node.id,
        revision: effect.node.revision, cursor: template.cursor, warnings: [] }] });
    }
    if (url.pathname === '/v1/pull') {
      const page = pullFixtures.page({ events: events.slice(delivered), nextCursor: `echo-${events.length}`,
        collectionRevision: `after-create-${events.length}` });
      delivered = events.length; return Response.json(page);
    }
    throw new Error(`undeclared HTTP ${url.pathname}`);
  };
  vi.stubGlobal('fetch', transport);
  const sessions = { get: async () => ({ credential: { accessToken: REJOIN_TOKEN }, session }) };
  const worker = createOutboundPushWorker({ scope, store: syncState, endpoints: async () => endpoints, sessions,
    fetch: transport, now: () => clock.now, ownerId: () => 'first-run-echo-worker',
    assertUploadAllowed: queue => assertQueuedUploadAllowed({ store: syncState, scope, queue,
      parentOf: async id => (await chrome.bookmarks.get(id))[0]?.parentId }) });
  const applier = createPullApplier({ scope, store: syncState, api: chrome.bookmarks,
    session: { ...session, collectionId: scope.collectionId }, endpoints, credential: { accessToken: REJOIN_TOKEN },
    effectPageTemplate: endpoints.syncEffectPages, effectPageAuthority: 'https://known.example',
    origin: 'chrome-extension://first-run-echo', fetch: transport });
  const engine = () => createDurableSyncEngine({ scope, store: syncState, sessions, endpoints: async () => ({ ...endpoints,
    syncSnapshot: `${scope.serverOrigin}/v1/snapshot` }), fetch: transport, now: () => clock.now,
    pushWorker: worker, pullApplier: applier, snapshotProjector: staged => recoverVerifiedOrFreeze({
      scope, store: syncState, staged, api: chrome.bookmarks, freezeUnprovenIdentity: true }) });
  await engine().wake('startup');
  expect((await syncState.getEngineState(scope))?.lastError).toBeUndefined();
  expect(acked).toEqual(['cloud-cursor']);
  expect(snapshotRequests.filter(row => row.url.pathname === '/v1/snapshot')).toHaveLength(2);
  const view = await loadRootView(scope);
  const preview = await handleFirstRunRequest({ kind: 'known.firstRun.preview', viewId: view.viewId,
    selectedRefs: [view.roots.find(row => row.title === selectedTitle)!.ref],
    excludedRefs: [view.roots.find(row => row.title === 'Private folder')!.ref] });
  if (!preview.ok || !('previewId' in preview)) throw new Error('preview_missing');
  const request = { kind: 'known.firstRun.confirm' as const, previewId: preview.previewId,
    confirmationId: 'first-run-selected-subfolder', libraryId: scope.collectionId };
  expect(await handleFirstRunRequest(request)).toMatchObject({ ok: true, firstRun: 'running' });
  expect(await worker.drain()).toMatchObject({ outcome: 'terminal' });
  expect(events).toHaveLength(1);
  expect(await syncState.getBoundaryCommand(scope, request.confirmationId)).toMatchObject({ state: 'committed' });
  expect((await syncState.listMountBindings(scope))[0]).toMatchObject({ nativeRootId: '10', remoteMountNodeId: 'created-1', status: 'active' });
  expect(await syncState.getScope(scope)).toMatchObject({ firstRun: 'running', selectedRoots: [] });
  const reviewed = (await syncState.getScopePreview(scope, preview.previewId))!;
  const run = (await syncState.listBootstrapRuns(scope))[0]!;
  if (scenario === 'admitted-preview-expired') await syncState.putScopePreview(scope, { ...reviewed, expiresAt: 1 });
  if (scenario === 'unconfirmed') {
    // A restored database can retain a mapping/receipt but lack its journal.
    // Such identity facts must never manufacture a new user confirmation.
    const db = await syncState.open(), tx = db.transaction(STORES.boundaryCommands, 'readwrite');
    const done = transactionDone(tx); tx.objectStore(STORES.boundaryCommands).delete([reviewed.scopeKey, request.confirmationId]);
    await done;
  }
  if (scenario === 'stale-boundary') await syncState.bumpBoundaryVersion(scope);
  if (scenario === 'completed-run') await syncState.putBootstrapRun(scope, { ...run, phase: 'completed' });
  if (scenario === 'wrong-run') await syncState.putBootstrapRun(scope, { ...run, confirmationId: 'unrelated-confirmation' });
  if (scenario === 'unselected-preview') await syncState.putScopePreview(scope, { ...reviewed,
    boundary: { ...reviewed.boundary, selectedNativeIds: ['2'] } });
  if (scenario === 'wrong-preview-owner') await syncState.putScopePreview(scope, { ...reviewed, consumedBy: 'another-confirmation' });
  if (scenario === 'moved-under-excluded') {
    const selected = { ...node('10'), parentId: '20' }, privateFolder = node('20');
    replaceTree([{ ...tree[0]!, children: tree[0]!.children!.map(row => row.id !== '1' ? row : { ...row,
      children: [{ ...privateFolder, children: [...privateFolder.children!, selected] }] }) }]);
  }
  if (scenario === 'other-replica' || scenario === 'different-payload') {
    const original = events[0]!;
    if (original.operation.type !== 'create_node' || original.operation.payload.node.kind !== 'folder'
        || original.effect.kind !== 'node_created') throw new Error('folder_create_expected');
    const operation = { ...original.operation, ...(scenario === 'other-replica' ? { replicaId: 'another-replica' }
      : { payload: { ...original.operation.payload, node: { ...original.operation.payload.node, title: 'Different operation' } } }) };
    const effect = { ...original.effect, replicaId: operation.replicaId,
      operationDigest: canonicalOperationDigest(operation), effectDigest: '' };
    effect.effectDigest = canonicalAuthoritativeEffectDigest(effect);
    events[0] = { ...original, operation, effect };
  }
  const allowed = scenario === 'current' || scenario === 'admitted-preview-expired' || scenario === 'another-profile-cloud-root';
  const queueBeforePull = await syncState.listQueue(scope), nativeBeforePull = structuredClone(tree);
  const mappingsBeforePull = await syncState.listMappings(scope);
  // The parent echo arrives before any resume can persist the resolved selection.
  // A terminal Push receipt is identity evidence, not permission to invent roots.
  syncState.close(); clock.now += 2_000;
  await engine().wake('manual');
  if (!allowed) {
    expect(await syncState.getEngineState(scope)).toMatchObject({ recoveryFrozen: true, lastError: 'need_authority' });
    expect(acked).toEqual(['cloud-cursor']);
    expect(await syncState.listQueue(scope)).toEqual(queueBeforePull);
    expect(await syncState.listMappings(scope)).toEqual(mappingsBeforePull);
    expect(tree).toEqual(nativeBeforePull);
    expect([...canonical.values()].filter(row => row.title === selectedTitle)).toHaveLength(1);
    expect([...canonical.values()].filter(row => row.title === 'Selected bookmark')).toHaveLength(0);
    for (const name of ['create', 'update', 'move', 'remove', 'removeTree'] as const) expect(chrome.bookmarks[name]).not.toHaveBeenCalled();
    return;
  }
  expect(await syncState.getEngineState(scope), JSON.stringify({
    scope: await syncState.getScope(scope), command: await syncState.getBoundaryCommand(scope, request.confirmationId),
    runs: await syncState.listBootstrapRuns(scope), mounts: await syncState.listMountBindings(scope),
    queue: await syncState.listQueue(scope), preview: await syncState.getScopePreview(scope, preview.previewId),
  })).toMatchObject({ recoveryFrozen: false });
  expect((await syncState.getEngineState(scope))?.lastError).toBeUndefined();
  expect(acked).toEqual(['cloud-cursor', 'echo-1']);
  expect((await syncState.getMappingByColpId(scope, 'created-1'))?.nativeId).toBe('10');
  expect((await syncState.getScope(scope))?.selectedRoots).toEqual([]);
  expect(tree).toEqual(beforeNative);
  await resumeRunningBootstrap(scope);
  expect(await worker.drain()).toMatchObject({ outcome: 'terminal' });
  expect(events).toHaveLength(2);
  syncState.close(); clock.now += 2_000;
  await engine().wake('manual'); await resumeRunningBootstrap(scope);
  expect(await syncState.getScope(scope)).toMatchObject({ lifecycle: 'active', firstRun: 'completed', selectedRoots: ['created-1'] });
  expect(await syncState.listQueue(scope)).toEqual([expect.objectContaining({ status: 'terminal' }), expect.objectContaining({ status: 'terminal' })]);
  for (const operation of await syncState.listQueue(scope)) expect(await syncState.getQueueReceipt(scope, operation.sequence))
    .toMatchObject({ kind: 'terminal', opId: operation.opId, operationDigest: operation.digest });
  expect((await syncState.getMappingByNativeId(scope, '11'))?.colpId).toBe('created-2');
  expect([...canonical.values()].filter(row => row.title === selectedTitle)).toHaveLength(1);
  expect([...canonical.values()].filter(row => row.title === 'Selected bookmark')).toHaveLength(1);
  expect(node('10').children).toHaveLength(1); expect(tree).toEqual(beforeNative);
  expect(acked).toEqual(['cloud-cursor', 'echo-1', 'echo-2']);
  if (scenario === 'another-profile-cloud-root') {
    const view = await loadRootView(scope);
    expect(canonical.get('profile-a-folder')?.title).toBe('Profile A root');
    expect(view.roots.some(row => row.title === 'Profile A root')).toBe(false);
    expect(view.roots.find(row => row.title === 'Profile B root')).toMatchObject({ selected: true, privateLocal: false });
    const selected = (await syncState.getScope(scope))!.selectedRoots;
    expect(await Promise.all(selected.map(async id => (await syncState.getMappingByColpId(scope, id))?.nativeId))).toEqual(['10']);
    const sharedCloudCopy = await syncState.getMappingByColpId(scope, 'profile-a-folder');
    expect(sharedCloudCopy).not.toBeNull();
    expect(sharedCloudCopy?.nativeId).toMatch(/^(recovery|unmounted):/u);
  }
  for (const name of ['create', 'update', 'move', 'remove', 'removeTree'] as const) expect(chrome.bookmarks[name]).not.toHaveBeenCalled();
});
