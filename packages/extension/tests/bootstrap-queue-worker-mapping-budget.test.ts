import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { writeFileSync } from 'node:fs';
import { IDBDatabase } from 'fake-indexeddb';
import { test, vi } from 'vitest';
import { canonicalAuthoritativeEffectDigest, canonicalOperationDigest } from '@know-n/colp/sync';
import { liveWorker } from './service-worker-live-harness.js';
import { manifest } from './auth-shell-fixture.js';
import { pullFixtures } from './pull-effect-fixtures.js';

/** Real coordinator, worker, receipts and Pull/Ack; controlled browser/HTTP ports.
 * This does not include the initial Snapshot and is not a Chrome time budget. */
test('96 bootstrap creates retain their receipts, Pull echo and Ack with one fresh transaction per mapping lookup', async () => {
  const f = await liveWorker(); const count = 96;
  const inMappingRead = new AsyncLocalStorage<boolean>();
  let lookups = 0, mappingReadTransactions = 0, mappingWriteTransactions = 0;
  let transactionSpy: ReturnType<typeof vi.spyOn> | undefined;
  let mappingSpy: ReturnType<typeof vi.spyOn> | undefined;
  const accepted: any[] = [];
  try {
    const scope = await f.connect(); f.permission.granted = true;
    const credential = (await f.runtime.store.loadCredential())!;
    const { credentialAuthorityDigest } = await import('../src/session-client.js');
    await f.runtime.store.saveSession({ sessionId: 'profile-session',
      credentialAuthorityDigest: await credentialAuthorityDigest(credential.accessToken),
      expiresAt: '2099-01-01T00:00:00Z', scope: 'collection', acceptedProtocolVersion: '0.2', snapshotRequired: false,
      maxBatchOperations: 50,
      collection: { collectionId: scope.collectionId, serverCursor: 'cursor-0', serverRevision: 'revision-0' },
      replicaLease: { leaseId: 'worker-lease', generation: String(scope.generation), state: 'active', expiresAt: '2099-01-01T00:00:00Z' },
      conversionPolicy: { separator: 'preserve_remote' } });
    await f.runtime.syncState.setFirstRun(scope, 'none');
    await f.runtime.syncState.configureBrowserRoots(scope, { discovered: [{ nativeId: '1', ancestorNativeIds: [] }],
      selectedNativeIds: ['1'], privateNativeIds: [], status: 'ready' });
    const library = { id: scope.collectionId, rootNodeId: 'profile-root', bookmarksBarId: 'profile-bar',
      otherBookmarksId: 'profile-other', title: 'Profile', library: true };
    await f.local.set({ 'known.sync.library.v1': { accountId: scope.accountId, serverOrigin: scope.serverOrigin,
      status: 'ready', library } });
    for (let i = 0; i < count; i++) f.api.seed({ id: `profile-${i}`, parentId: '1', index: i,
      title: `Profile ${i}`, url: `https://profile.test/${i}` });

    // Match Chrome's array-get behavior, including rejecting a mixed missing set.
    const getOne = chrome.bookmarks.get.bind(chrome.bookmarks);
    chrome.bookmarks.get = async ids => (await Promise.all((Array.isArray(ids) ? ids : [ids])
      .map(id => getOne(id)))).flat();
    assert.deepEqual((await chrome.bookmarks.get(['1', '0'])).map(row => row.id), ['1', '0']);
    await assert.rejects(chrome.bookmarks.get(['1', 'unknown-profile-id']), /Can't find bookmark/);
    Object.assign(navigator, { locks: { request: async (_name: string, _options: object, work: () => unknown) => work() } });

    const mappingView = await import('../src/pull-mapping-view.js');
    const current = mappingView.currentPullMapping;
    mappingSpy = vi.spyOn(mappingView, 'currentPullMapping').mockImplementation((...args) => {
      lookups++; return inMappingRead.run(true, () => current(...args));
    });
    const transaction = IDBDatabase.prototype.transaction;
    const originalTransaction = vi.isMockFunction(transaction) ? transaction.getMockImplementation()! : transaction;
    transactionSpy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args) {
      if (inMappingRead.getStore()) {
        if ((args[1] ?? 'readonly') === 'readonly') mappingReadTransactions++;
        else mappingWriteTransactions++;
      }
      return originalTransaction.apply(this, args);
    });

    const baseFetch = fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.href === f.config.manifestUrl) {
        const doc = manifest(scope.serverOrigin); doc.mounts[0]!.limits.maxSyncBatchOperations = 50;
        return Response.json(doc);
      }
      if (url.origin !== scope.serverOrigin) return baseFetch(input, init);
      if (url.pathname === '/v1/push') {
        assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${credential.accessToken}`);
        const request = JSON.parse(String(init?.body)); assert.equal(request.sessionId, 'profile-session');
        for (const operation of request.operations) {
          assert.equal(operation.type, 'create_node'); assert.equal(operation.collectionId, scope.collectionId);
          assert.equal(accepted.some(row => row.opId === operation.opId), false);
          accepted.push(operation);
        }
        return Response.json({ batchId: request.batchId, serverCursor: `cursor-${accepted.length}`,
          results: request.operations.map((operation: any) => ({ opId: operation.opId, sequence: operation.sequence,
            status: 'applied', targetId: `profile-cloud-${operation.sequence}`, revision: `r-${operation.sequence}`,
            cursor: `cursor-${operation.sequence}`, warnings: [] })) });
      }
      if (url.pathname === '/v1/pull') {
        const after = Number((url.searchParams.get('cursor') ?? 'cursor-0').replace('cursor-', ''));
        const events = accepted.filter(operation => operation.sequence > after).map(operation => {
          const event = pullFixtures.createEvent({ kind: 'Bookmark', sequence: operation.sequence,
            collectionId: scope.collectionId, replicaId: scope.replicaId, parentId: 'profile-bar', opId: operation.opId,
            title: operation.payload.node.title }) as any;
          event.operation = operation; event.effect.operationDigest = canonicalOperationDigest(operation);
          event.effect.node = { ...event.effect.node, ...operation.payload.node,
            id: `profile-cloud-${operation.sequence}`, revision: `r-${operation.sequence}` };
          event.effect.effectDigest = canonicalAuthoritativeEffectDigest(event.effect);
          return event;
        });
        return Response.json(pullFixtures.page({ events, nextCursor: `cursor-${accepted.length}`,
          collectionRevision: accepted.length ? `r-${accepted.length}` : 'revision-0' }));
      }
      if (url.pathname === '/v1/ack') {
        const body = JSON.parse(String(init?.body));
        return Response.json({ replicaId: scope.replicaId, ackedCursor: body.cursor, ackedAt: new Date().toISOString() });
      }
      if (url.pathname.includes('replica-health')) return new Response(null, { status: 204 });
      throw new Error(`unexpected_profile_http:${url.pathname}`);
    });

    const { createChromeBookmarkTreeAdapter } = await import('../src/chrome-bookmark-tree.js');
    const { localFactsFromRoots } = await import('../src/bootstrap/local-facts.js');
    const { createBootstrapCoordinator } = await import('../src/bootstrap/coordinator.js');
    const tree = await createChromeBookmarkTreeAdapter(chrome.bookmarks).read();
    const coordinator = createBootstrapCoordinator({ store: f.runtime.syncState, scope });
    const confirmed = await coordinator.confirm({ confirmationId: 'profile-confirmation', confirmationVersion: '1',
      treeDigest: 'sha256:profile', localFacts: localFactsFromRoots(tree.roots, ['1']), rootNodeId: 'profile-root',
      mounts: [{ nativeRootId: '1', rootRole: 'bookmarks-bar', remoteMountNodeId: 'profile-bar' }],
      remoteFacts: [{ nodeId: 'profile-root', parentId: null, kind: 'folder', title: 'Library', folderRole: 'root', revision: 'r0' },
        { nodeId: 'profile-bar', parentId: 'profile-root', kind: 'folder', title: 'Bookmarks', folderRole: 'bookmarks-bar',
          revision: 'bar-r0', childrenRevision: 'bar-children-r0' }] });
    assert.equal(confirmed.queuedOpIds.length, count);
    const engine = await import('../src/sw/engine.js');
    await engine.scheduleSyncEngineWake('manual'); await f.runtime.workCoordinator.drain();

    const rows = await f.runtime.syncState.listQueue(scope, 'terminal', 0, 1000);
    assert.equal(accepted.length, count); assert.equal(rows.length, count);
    const receipts = [];
    for (const row of rows) {
      const receipt = await f.runtime.syncState.getQueueReceipt(scope, row.sequence);
      assert.equal(receipt?.kind, 'terminal'); assert.equal(receipt?.opId, row.opId);
      assert.equal(receipt?.operationDigest, row.digest); receipts.push(receipt);
    }
    const pullEvents = await f.runtime.syncState.listPullEvents(scope);
    const ackIntents = await f.runtime.syncState.listAckIntents(scope);
    assert.equal(pullEvents.length, count);
    assert.equal(pullEvents.every(row => row.state === 'page_complete'), true);
    assert.ok(ackIntents.length > 0); assert.equal(ackIntents.every(row => row.state === 'complete'), true);
    assert.equal((await f.runtime.syncState.getCursor(scope))?.cursor, `cursor-${count}`);
    const state = await f.runtime.syncState.getEngineState(scope);
    assert.equal(state?.recoveryFrozen, false); assert.equal(state?.lastError, undefined);
    // The profile starts after Session activation without the initial Snapshot
    // header. It must not misreport completion of the entire first-run journey.
    assert.equal((await f.runtime.syncState.getScope(scope))?.firstRun, 'running');
    assert.equal((await f.runtime.syncState.listBootstrapRuns(scope))[0]?.retryReason, 'snapshot_pending');
    assert.equal(f.api.calls.filter(call => ['create', 'delete'].includes(call.kind)).length, 0);
    if (process.env.S08_PROFILE_OUTPUT) writeFileSync(process.env.S08_PROFILE_OUTPUT, JSON.stringify({
      source: process.env.S08_SOURCE_SHA, count, lookups, mappingReadTransactions, mappingWriteTransactions,
      bootstrapRetryReason: 'snapshot_pending',
      queue: rows.map(row => ({ sequence: row.sequence, opId: row.opId, status: row.status, digest: row.digest })),
      receipts: receipts.map(row => ({ sequence: row?.sequence, opId: row?.opId, kind: row?.kind, operationDigest: row?.operationDigest })),
      pull: pullEvents.map(row => ({ operationId: row.operationId, state: row.state, cursor: row.cursor })),
      ack: ackIntents.map(row => ({ kind: row.kind, cursor: row.cursor, state: row.state })),
      limits: ['Controlled browser/HTTP ports and fake IndexedDB; no Chrome or PostgreSQL timings',
        'Initial Snapshot absent; verifies 96 creates, receipts, Pull echo and Ack only'],
    }, null, 2));
    assert.ok(lookups > 0, 'exercise mapping reads through the real worker');
    assert.equal(mappingWriteTransactions, 0, 'reading a shadow must not promote its authority');
    assert.equal(mappingReadTransactions, lookups, 'one fresh readonly transaction per current mapping lookup');
  } finally { transactionSpy?.mockRestore(); mappingSpy?.mockRestore(); await f.close(); }
}, 90_000);
