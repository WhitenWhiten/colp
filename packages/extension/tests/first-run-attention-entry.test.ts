import type { Operation } from '@know-n/colp/types';
import { expect, test, vi } from 'vitest';
import { node, ports, scope, seedSelected, tree } from './sw-authority-entry-fixture.js';
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

async function attentionFixture() {
  await seedSelected();
  const canonical: RemoteNodeFact[] = [
    { nodeId: 'library-root', parentId: null, folderRole: 'root', kind: 'folder', title: 'Library', revision: 'r-root', childrenRevision: 'c-root' },
    { nodeId: 'remote-1', parentId: 'library-root', folderRole: 'bookmarks-bar', kind: 'folder', title: 'Bar', revision: 'r-1', childrenRevision: 'c-1' },
    { nodeId: 'remote-2', parentId: 'library-root', folderRole: 'other-bookmarks', kind: 'folder', title: 'Other', revision: 'r-2', childrenRevision: 'c-2' },
    { nodeId: 'remote-10', parentId: 'remote-1', kind: 'folder', title: 'Selected folder', revision: 'r-10', childrenRevision: 'c-10' },
    { nodeId: 'remote-11', parentId: 'remote-10', kind: 'bookmark', title: 'Selected bookmark', url: 'https://example.test/selected', revision: 'r-11' },
    { nodeId: 'remote-20', parentId: 'remote-1', kind: 'folder', title: 'Private folder', revision: 'r-20', childrenRevision: 'c-20' },
    { nodeId: 'remote-21', parentId: 'remote-20', kind: 'bookmark', title: 'Private bookmark', url: 'https://example.test/private', revision: 'r-21' },
  ];
  let session = { ...(await store.loadSession())!, snapshotRequired: true };
  await store.saveSession(session);
  const requests = installRejoinHttp(() => scope, () => canonical), snapshotFetch = fetch;
  const acknowledged: string[] = [], pushed: Operation[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/manifest.json' || url.pathname === '/v1/snapshot') return snapshotFetch(input, init);
    if (url.pathname === '/v1/snapshot/conflicts') return Response.json({
      snapshotId: 'rejoin-snapshot', offset: 0, nextOffset: null, conflictCount: 0, conflicts: [] });
    if (url.pathname === '/v1/ack') {
      const body = JSON.parse(String(init?.body));
      expect(await syncState.getPendingAckIntent(scope)).toMatchObject({ cursor: body.cursor, state: 'pending' });
      acknowledged.push(body.cursor); session = { ...session, snapshotRequired: false }; await store.saveSession(session);
      return Response.json({ replicaId: scope.replicaId, ackedCursor: body.cursor, ackedAt: new Date().toISOString() });
    }
    if (url.pathname === '/v1/pull') return Response.json(pullFixtures.page({ events: [], nextCursor: 'cloud-cursor', collectionRevision: 'cloud-revision' }));
    if (url.pathname === '/v1/push') {
      const body = JSON.parse(String(init?.body)) as { batchId: string; operations: Operation[] };
      expect(body.operations).toHaveLength(1);
      const operation = body.operations[0]!;
      if (operation.type !== 'update_node_content') throw new Error('unexpected merge operation');
      const target = canonical.find(row => row.nodeId === operation.targetId)!;
      expect(operation.baseRevision).toBe(target.revision);
      expect(operation.payload.base).toEqual({ title: target.title });
      expect(operation.payload.value).toEqual({ title: 'Edited in this browser' });
      Object.assign(target, operation.payload.value, { revision: 'accepted-local-title' }); pushed.push(operation);
      return Response.json({ batchId: body.batchId, serverCursor: 'after-local-title', results: [{
        opId: operation.opId, sequence: operation.sequence, status: 'applied', targetId: target.nodeId,
        revision: target.revision, cursor: 'after-local-title', warnings: [] }] });
    }
    throw new Error(`undeclared HTTP ${url.pathname}`);
  };
  vi.stubGlobal('fetch', transport);
  const sessions = { get: async () => ({ credential: { accessToken: REJOIN_TOKEN }, session }) };
  const worker = createOutboundPushWorker({ scope, store: syncState, endpoints: async () => endpoints, sessions,
    fetch: transport, ownerId: () => 'attention-entry-worker',
    assertUploadAllowed: queue => assertQueuedUploadAllowed({ store: syncState, scope, queue,
      parentOf: async id => (await chrome.bookmarks.get(id))[0]?.parentId }) });
  const applier = createPullApplier({ scope, store: syncState, api: chrome.bookmarks,
    session: { ...session, collectionId: scope.collectionId }, endpoints, credential: { accessToken: REJOIN_TOKEN },
    effectPageTemplate: endpoints.syncEffectPages, effectPageAuthority: 'https://known.example',
    origin: 'chrome-extension://attention-entry', fetch: transport });
  await createDurableSyncEngine({ scope, store: syncState, sessions, endpoints: async () => ({ ...endpoints,
    syncSnapshot: `${scope.serverOrigin}/v1/snapshot` }), fetch: transport, pushWorker: worker, pullApplier: applier,
  snapshotProjector: staged => recoverVerifiedOrFreeze({ scope, store: syncState, staged, api: chrome.bookmarks,
    freezeUnprovenIdentity: true }) }).wake('startup');
  expect((await syncState.getEngineState(scope))?.lastError).toBeUndefined();
  expect(acknowledged).toEqual(['cloud-cursor']);
  expect(requests.filter(row => row.url.pathname === '/v1/snapshot')).toHaveLength(4);
  Object.assign(node('11'), { title: 'Edited in this browser' });
  const view = await loadRootView(scope);
  const preview = await handleFirstRunRequest({ kind: 'known.firstRun.preview', viewId: view.viewId,
    selectedRefs: [view.roots.find(row => row.title === 'Bar')!.ref],
    excludedRefs: [view.roots.find(row => row.title === 'Private folder')!.ref] });
  if (!preview.ok || !('previewId' in preview)) throw new Error('preview_missing');
  const response = await handleFirstRunRequest({ kind: 'known.firstRun.confirm', previewId: preview.previewId,
    confirmationId: 'merge-attention-entry', libraryId: scope.collectionId });
  expect(response).toMatchObject({ ok: true, firstRun: 'completed', phase: 'needs_attention', attention: { pendingCount: 1 } });
  const run = (await syncState.listBootstrapRuns(scope))[0]!, item = run.attention!.items[0]!;
  expect(item).toMatchObject({ kind: 'local_difference', decision: 'open' });
  expect(await syncState.listQueue(scope)).toEqual([]);
  return { run, item, canonical, worker, requests, pushed };
}

test('first-run attention retains the local choice until an actual Push receipt and fresh complete snapshot settle it', async () => {
  const f = await attentionFixture(), beforeNative = structuredClone(tree);
  const request = { kind: 'known.firstRun.attention.decide' as const, reportId: f.run.runId,
    itemId: f.item.itemId, decision: 'keep_local' as const, evidenceDigest: f.item.evidenceDigest };
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.attention.get', reportId: f.run.runId }))
    .toMatchObject({ ok: true, items: [{ kind: 'local_difference', evidenceDigest: f.item.evidenceDigest }] });
  expect(await handleFirstRunRequest(request)).toMatchObject({ ok: true, phase: 'needs_attention' });
  const queued = await syncState.listQueue(scope);
  expect(queued).toHaveLength(1); expect(queued[0]).toMatchObject({ status: 'pending', payload: { type: 'update_node_content', targetId: 'remote-11' } });
  expect(await resumeRunningBootstrap(scope)).toBe(false);
  expect((await syncState.listBootstrapRuns(scope))[0]?.attention?.items).toHaveLength(1);
  syncState.close(); expect(await handleFirstRunRequest(request)).toMatchObject({ ok: true });
  expect(await syncState.listQueue(scope)).toEqual(queued);
  expect(await f.worker.drain()).toMatchObject({ outcome: 'terminal' });
  expect(f.pushed).toHaveLength(1);
  expect(await syncState.getQueueReceipt(scope, queued[0]!.sequence)).toMatchObject({ kind: 'terminal',
    opId: queued[0]!.opId, operationDigest: queued[0]!.digest, result: { results: [{ status: 'applied', targetId: 'remote-11' }] } });
  await resumeRunningBootstrap(scope);
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.status' })).toMatchObject({ ok: true, firstRun: 'completed', phase: 'completed' });
  expect((await syncState.listBootstrapRuns(scope))[0]?.attention?.items).toEqual([]);
  expect(f.canonical.find(row => row.nodeId === 'remote-11')).toMatchObject({ title: 'Edited in this browser', revision: 'accepted-local-title' });
  expect(await syncState.getMappingByNativeId(scope, '11')).toMatchObject({ colpId: 'remote-11' });
  expect(tree).toEqual(beforeNative);
  for (const name of ['create', 'update', 'move', 'remove', 'removeTree'] as const) expect(chrome.bookmarks[name]).not.toHaveBeenCalled();
  syncState.close(); expect(await handleFirstRunRequest({ kind: 'known.firstRun.attention.get', reportId: f.run.runId }))
    .toMatchObject({ ok: true, items: [], attention: { pendingCount: 0 } });
  expect((await syncState.listQueue(scope)).map(row => row.opId)).toEqual([queued[0]!.opId]);
});

test.each(['native-change', 'cloud-change', 'permission', 'credential', 'account-during-snapshot'] as const)
('an actual first-run local-difference choice cannot overwrite authority after %s', async guard => {
  const f = await attentionFixture();
  if (guard === 'native-change') Object.assign(node('11'), { title: 'Edited after review' });
  if (guard === 'cloud-change') Object.assign(f.canonical.find(row => row.nodeId === 'remote-11')!, { title: 'Cloud changed again', revision: 'new-cloud-revision' });
  if (guard === 'permission') ports.permission = false;
  if (guard === 'credential') await store.saveCredential({ ...(await store.loadCredential())!, subject: 'another-account' });
  if (guard === 'account-during-snapshot') {
    const transport = fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await transport(input, init);
      if (new URL(String(input)).searchParams.get('pageCursor') === '3') ports.scopeError = new Error('account_switch');
      return response;
    });
  }
  const nativeBefore = structuredClone(tree), canonicalBefore = structuredClone(f.canonical), mappingBefore = await syncState.listMappings(scope);
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.attention.decide', reportId: f.run.runId,
    itemId: f.item.itemId, decision: 'keep_local', evidenceDigest: f.item.evidenceDigest }))
    .toEqual({ ok: false, error: guard === 'permission' ? 'permission_required' : guard === 'credential' ? 'not_connected'
      // The native adapter reports loss of its captured account as an unreadable tree.
      : guard === 'account-during-snapshot' ? 'tree_unavailable' : 'bootstrap_confirmation_stale' });
  expect(await syncState.listQueue(scope)).toEqual([]); expect((await syncState.exportScope(scope)).receipts).toEqual([]);
  expect(await syncState.listMappings(scope)).toEqual(mappingBefore); expect(f.canonical).toEqual(canonicalBefore);
  expect(tree).toEqual(nativeBefore); expect(f.pushed).toEqual([]);
  syncState.close(); expect((await syncState.listBootstrapRuns(scope))[0]?.attention?.items).toEqual(f.run.attention!.items);
});

test('status polling throttles the same real attention report, Later preserves it and permission failures cannot close it', async () => {
  const f = await attentionFixture(), nativeBefore = structuredClone(tree);
  const expected = { ok: true, firstRun: 'completed', phase: 'needs_attention', attention: { pendingCount: 1 } };
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.status' })).toMatchObject(expected);
  const readCount = vi.mocked(chrome.bookmarks.getTree).mock.calls.length;
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.status' })).toMatchObject(expected);
  expect(vi.mocked(chrome.bookmarks.getTree).mock.calls).toHaveLength(readCount);
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.later' })).toMatchObject(expected);
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.attention.decide', reportId: f.run.runId,
    itemId: f.item.itemId, decision: 'keep_both' })).toEqual({ ok: false, error: 'request_invalid' });
  ports.permission = false;
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.attention.get', reportId: f.run.runId }))
    .toEqual({ ok: false, error: 'permission_required' });
  expect((await syncState.listBootstrapRuns(scope))[0]?.attention?.items).toEqual(f.run.attention!.items);
  expect(await syncState.listQueue(scope)).toEqual([]); expect(tree).toEqual(nativeBefore);
});

test('an older admitted report without a preview reference resumes from current mount and private authority after reopen', async () => {
  const f = await attentionFixture();
  const { previewId: _previewId, ...legacy } = f.run;
  await syncState.putBootstrapRun(scope, legacy, f.run);
  const authority = (await syncState.getScope(scope))!, nativeBefore = structuredClone(tree);
  syncState.close(); expect(await resumeRunningBootstrap(scope)).toBe(false);
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.attention.get', reportId: f.run.runId }))
    .toMatchObject({ ok: true, phase: 'needs_attention', attention: { pendingCount: 1 }, items: [{ kind: 'local_difference' }] });
  expect(await syncState.getScope(scope)).toMatchObject({ selectedRoots: authority.selectedRoots,
    privateRoots: authority.privateRoots, boundaryVersion: authority.boundaryVersion, firstRun: 'completed' });
  expect(await syncState.listQueue(scope)).toEqual([]); expect(tree).toEqual(nativeBefore);
});
