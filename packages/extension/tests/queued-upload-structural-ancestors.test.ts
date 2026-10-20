import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { createBootstrapCoordinator } from '../src/bootstrap/coordinator.js';
import { localFactsFromRoots } from '../src/bootstrap/local-facts.js';
import { scanBoundary } from '../src/bookmark-boundary.js';
import { assertBootstrapUploadAllowed } from '../src/bootstrap/upload-boundary.js';
import { assertQueuedUploadAllowed } from '../src/queued-upload-boundary.js';
import { createOutboundPushWorker, type PushSessionController } from '../src/outbound-push-worker.js';
import type { NormalizedBookmarkRoot } from '../src/chrome-bookmark-tree.js';
import type { QueueOperation } from '../src/sync-state-store.js';
import { endpoints, json } from './outbound-push-worker-harness.js';
import { bar, scope, setup } from './sync-recovery-hardening-fixture.js';

async function nestedFixture(existingBar = true, confirmationId = 'nested-confirm') {
  const store = await setup();
  const roots: NormalizedBookmarkRoot[] = [{ nativeId: '1', title: 'Bookmarks bar', kind: 'folder',
    managed: false, rootKind: 'bookmarks_bar', children: [
      { nativeId: 'work', kind: 'folder', title: 'Work', managed: false, children: [
        { nativeId: 'selected-bookmark', kind: 'bookmark', title: 'Selected', url: 'https://example.test/selected',
          managed: false, children: [] },
      ] },
      { nativeId: 'sibling', kind: 'bookmark', title: 'Private sibling', url: 'https://example.test/not-selected',
        managed: false, children: [] },
    ] }];
  const scan = scanBoundary({ roots, selectedNativeIds: ['work'] });
  const discovered = [
    { nativeId: '1', ancestorNativeIds: [] }, { nativeId: 'work', ancestorNativeIds: ['1'] },
    { nativeId: 'private-parent', ancestorNativeIds: ['1'] },
  ];
  await store.configureBrowserRoots(scope, { discovered,
    selectedNativeIds: ['work'], privateNativeIds: ['private-parent'], status: 'ready' });
  await store.putMapping(scope, { nativeId: 'recovery:root', colpId: 'root', rootNativeId: 'recovery:root',
    nodeKind: 'folder', projection: { revision: 'r1', digest: 'root', content: { title: '', folderRole: 'root' } } });
  if (existingBar) await store.putMapping(scope, { ...bar, parentColpId: 'root' });
  await createBootstrapCoordinator({ store, scope }).confirm({ confirmationId,
    treeDigest: scan.treeDigest, confirmationVersion: '1', localFacts: localFactsFromRoots(roots, ['work']),
    mounts: scan.mounts.map(row => ({ ...row, remoteMountNodeId: null })), rootNodeId: 'root',
    remoteFacts: [{ nodeId: 'root', parentId: null, kind: 'folder', title: '', folderRole: 'root', revision: 'r1' },
      ...(existingBar ? [{ nodeId: 'bar', parentId: 'root', kind: 'folder' as const, title: 'Bookmarks bar',
        folderRole: 'bookmarks-bar', revision: 'r1' }] : [])] });
  const rows = await store.listQueue(scope);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.payload.type, 'create_node');
  assert.equal((rows[0]?.payload.payload as { node: { title: string } }).node.title, existingBar ? 'Work' : 'bookmarks-bar');
  const parents: Record<string, string> = { work: '1', 'selected-bookmark': 'work', sibling: '1',
    'private-parent': '1', '1': '0' };
  const input = { store, scope, queue: rows[0]!, parentOf: async (id: string) => parents[id] };
  return { store, rows, parents, input };
}

test.each([true, false])('selected nested folders can dispatch their required structural containers (remote bar=%s)', async existingBar => {
  const f = await nestedFixture(existingBar);
  try {
    const { input, rows } = f;
    await assertBootstrapUploadAllowed(input);
    await assertQueuedUploadAllowed(input);
    assert.ok(!JSON.stringify(rows).includes('not-selected'));
    const requests: string[] = [];
    const sessions: PushSessionController = { async get() { return {
      credential: { accessToken: 'nested-token' }, session: { sessionId: 'nested-session',
        expiresAt: '2099-01-01T00:00:00Z', scope: 'collection', snapshotRequired: false,
        credentialAuthorityDigest: 'a'.repeat(64), collection: { collectionId: scope.collectionId,
          serverCursor: 'c0', serverRevision: 'r1' },
        replicaLease: { leaseId: 'lease', generation: '1', state: 'active', expiresAt: '2099-01-01T00:00:00Z' } },
    }; } };
    const worker = createOutboundPushWorker({ store: f.store, scope, sessions, endpoints: async () => endpoints,
      ownerId: () => 'nested-worker', schedule: () => undefined,
      assertUploadAllowed: queue => assertQueuedUploadAllowed({ ...input, queue }),
      fetch: async (_url, init) => {
        const body = String(init?.body); requests.push(body);
        const request = JSON.parse(body) as { batchId: string; operations: { opId: string; sequence: number }[] };
        return json(200, { batchId: request.batchId, serverCursor: 'c1', results: request.operations.map(op => ({
          opId: op.opId, sequence: op.sequence, status: 'applied', targetId: 'created-container',
          revision: 'r2', cursor: 'c1', warnings: [],
        })) });
      },
    });
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.equal(requests.length, 1);
    assert.equal((await f.store.getQueueReceipt(scope, rows[0]!.sequence))?.opId, rows[0]!.opId);
    assert.ok(!requests[0]!.includes('not-selected'));
  } finally { f.store.close(); }
});

test.each([true, false])('structural bootstrap cannot cross a newly private selected branch (remote bar=%s)', async existingBar => {
  const f = await nestedFixture(existingBar);
  try {
    f.parents.work = 'private-parent';
    await assert.rejects(assertQueuedUploadAllowed(f.input), /queued_upload_excluded/);
  } finally { f.store.close(); }
});

test('a paused nested mount no longer authorizes its ancestor containers', async () => {
  const f = await nestedFixture(false);
  try {
    const mount = (await f.store.listMountBindings(scope))[0]!;
    await f.store.detachMount(scope, mount.mountId);
    await assert.rejects(assertQueuedUploadAllowed(f.input), /bootstrap_upload_excluded/);
  } finally { f.store.close(); }
});

test('an unrecognized bootstrap mount cannot borrow its still-selected destination as source proof', async () => {
  const f = await nestedFixture();
  try {
    const queue: QueueOperation = { ...f.input.queue, opId: 'b3.other-confirm.mount.unknown-source' };
    await assert.rejects(assertQueuedUploadAllowed({ ...f.input, queue }), /upload_boundary_unavailable/);
  } finally { f.store.close(); }
});

test('a hashed bootstrap mount retains exact native provenance after restart', async () => {
  const f = await nestedFixture(true, 'long-confirmation-'.repeat(8));
  try {
    assert.match(f.input.queue.opId, /^b3\.[a-f0-9]{64}$/);
    f.store.close();
    await assertQueuedUploadAllowed(f.input);
    f.parents.work = 'private-parent';
    await assert.rejects(assertQueuedUploadAllowed(f.input), /queued_upload_excluded/);
  } finally { f.store.close(); }
});
