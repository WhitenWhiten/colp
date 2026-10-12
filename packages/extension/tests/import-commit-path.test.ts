import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test, vi } from 'vitest';
import { normalizeChromeBookmarkTree, previewChromeBookmarkImport, previewNetscapeBookmarkImport,
} from '../src/import-preview.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';

const scope: SyncScope = { environment: 'production', serverId: 'known', serverOrigin: 'https://known.example',
  accountId: 'account', browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };
const html = (body: string) => `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>${body}</DL><p>`;
const fixture = html('<DT><H3>Reading</H3><DL><p><DT><A HREF="https://example.test/one">One</A></DL><p>'
  + '<DT><H3>Skip me</H3><DL><p><DT><A HREF="https://example.test/skip">Skip</A></DL><p>');
const chromeTree = () => [{ id: '0', title: '', children: [
  { id: '1', parentId: '0', index: 0, title: 'Bar', children: [
    { id: '10', parentId: '1', index: 0, title: 'Example', url: 'https://example.test/' }] },
  { id: '2', parentId: '0', index: 1, title: 'Other', children: [
    { id: '20', parentId: '2', index: 0, title: 'Local notes', url: 'https://example.test/skip' }] },
] }];

const fixtures = vi.hoisted(() => ({
  store: undefined as ReturnType<typeof createSyncStateStore> | undefined,
  permission: true,
  tree: undefined as unknown,
  session: new Map<string, unknown>(),
  alarms: [] as unknown[],
  chromeCreates: [] as unknown[],
}));

vi.mock('../src/sw/runtime.js', () => ({
  sw: { importPreviews: new Map() },
  syncState: new Proxy({} as ReturnType<typeof createSyncStateStore>, {
    get(_target, property, receiver) {
      const store = fixtures.store; if (!store) throw new Error('store_missing');
      const value = Reflect.get(store, property, store);
      return typeof value === 'function' ? value.bind(store) : value ?? Reflect.get(store, property, receiver);
    },
  }),
  hasBookmarkPermission: async () => fixtures.permission,
  faviconSidecar: undefined,
}));

vi.mock('../src/sw/scope.js', () => ({ requireSyncScope: async () => scope }));
vi.mock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: vi.fn() }));

import { handleImportRequest } from '../src/sw/import.js';
import { scheduleSyncEngineWake } from '../src/sw/engine.js';
import { sw } from '../src/sw/runtime.js';

describe('P1-05 import preview/commit user path', () => {
  beforeEach(async () => {
    fixtures.permission = true; fixtures.tree = chromeTree(); fixtures.session.clear();
    fixtures.alarms.length = 0; fixtures.chromeCreates.length = 0;
    sw.importPreviews.clear();
    (globalThis as { chrome?: unknown }).chrome = {
      storage: { session: {
        async get(keys: string | string[]) {
          const wanted = typeof keys === 'string' ? [keys] : keys;
          return Object.fromEntries(wanted.filter((key) => fixtures.session.has(key))
            .map((key) => [key, fixtures.session.get(key)]));
        },
        async set(items: Record<string, unknown>) {
          for (const [key, value] of Object.entries(items)) fixtures.session.set(key, value);
        },
        async remove(keys: string | string[]) {
          for (const key of typeof keys === 'string' ? [keys] : keys) fixtures.session.delete(key);
        },
      } },
      bookmarks: {
        getTree: async () => fixtures.tree,
        get: async (id: string) => [{ id, title: id === 'native-root' ? 'Bar' : 'Other' }],
        create: async (input: unknown) => { fixtures.chromeCreates.push(input); throw new Error('preview_must_not_create'); },
      },
      alarms: { create: (...args: unknown[]) => { fixtures.alarms.push(args); } },
    };
    const indexedDB = new IDBFactory();
    fixtures.store = createSyncStateStore({ indexedDB });
    await fixtures.store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 99_999 },
      checkpoint: { serverRevision: 'r1', cursor: 'c1' }, selectedRoots: ['server-root'] });
    await fixtures.store.putMapping(scope, { nativeId: 'native-root', colpId: 'server-root', rootNativeId: 'native-root',
      nodeKind: 'folder', projection: { revision: 'children-r1', digest: 'sha256:root' } });
    await fixtures.store.putMapping(scope, { nativeId: 'other-native', colpId: 'other-root', rootNativeId: 'other-native',
      nodeKind: 'folder', projection: { revision: 'other-r1', digest: 'sha256:other' } });
  });

  test('file preview does not enqueue, write Chrome, or keep an import plan', async () => {
    const response = await handleImportRequest({ kind: 'known.import.previewFile', base64: btoa(fixture) });
    assert.equal(response.ok, true);
    if (!response.ok || !('preview' in response)) return;
    assert.equal(response.preview.sourceProfile, 'netscape-bookmarks-v1');
    assert.equal(response.preview.targets.map((target) => target.colpId).join(), 'server-root');
    assert.equal((await fixtures.store!.listQueue(scope)).length, 0);
    assert.equal((await fixtures.store!.listImportPlans(scope)).length, 0);
    assert.deepEqual(fixtures.chromeCreates, []);
  });

  test('unsupported JSON and a second preview invalidate the previous digest', async () => {
    await assert.rejects(handleImportRequest({ kind: 'known.import.previewFile',
      base64: btoa('{"checksum":"x","roots":{}}') }), /unsupported_format/);
    assert.equal((await fixtures.store!.listImportPlans(scope)).length, 0);
    const first = await handleImportRequest({ kind: 'known.import.previewFile', base64: btoa(fixture) });
    if (!first.ok || !('preview' in first)) throw new Error('preview_missing');
    const secondHtml = html('<DT><H3>Other</H3><DL><p><DT><A HREF="https://example.test/two">Two</A></DL><p>');
    const second = await handleImportRequest({ kind: 'known.import.previewFile', base64: btoa(secondHtml) });
    if (!second.ok || !('preview' in second)) throw new Error('second_preview_missing');
    assert.notEqual(second.preview.digest, first.preview.digest);
    assert.equal(sw.importPreviews.has(first.preview.digest), false);
    assert.equal(sw.importPreviews.has(second.preview.digest), true);
    await assert.rejects(handleImportRequest({ kind: 'known.import.commit', digest: first.preview.digest, choices: [] }),
      /preview_expired/);
    const current = await handleImportRequest({ kind: 'known.import.commit', digest: second.preview.digest,
      choices: second.preview.roots.map((root) => ({ sourceNodeId: root.sourceNodeId, action: 'skip' as const })) });
    assert.equal(current.ok, true);
    if (!current.ok || !('status' in current)) return;
    assert.equal(current.status.state, 'complete');
    assert.equal((await fixtures.store!.listImportPlans(scope)).length, 1);
  });

  test('native source change and out-of-bound targets reject commit with zero queue writes', async () => {
    const preview = await handleImportRequest({ kind: 'known.import.previewNative', tree: fixtures.tree });
    if (!preview.ok || !('preview' in preview)) throw new Error('preview_missing');
    const live = fixtures.tree as Array<{ children: Array<{ children: Array<{ title: string }> }> }>;
    live[0]!.children[0]!.children[0]!.title = 'Changed after preview';
    await assert.rejects(handleImportRequest({
      kind: 'known.import.commit', digest: preview.preview.digest,
      choices: preview.preview.roots.map((root) => ({ sourceNodeId: root.sourceNodeId, action: 'skip' as const })),
    }), /preview_expired/);
    fixtures.tree = chromeTree();
    const fresh = await handleImportRequest({ kind: 'known.import.previewNative', tree: fixtures.tree });
    if (!fresh.ok || !('preview' in fresh)) throw new Error('fresh_preview_missing');
    await assert.rejects(handleImportRequest({
      kind: 'known.import.commit', digest: fresh.preview.digest,
      choices: [{ sourceNodeId: fresh.preview.roots[0]!.sourceNodeId, action: 'import',
        target: { nativeId: 'other-native', colpId: 'other-root', revision: 'other-r1' } },
      { sourceNodeId: fresh.preview.roots[1]!.sourceNodeId, action: 'skip' }],
    }), /folder_choice_invalid/);
    assert.equal((await fixtures.store!.listQueue(scope)).length, 0);
    assert.equal((await fixtures.store!.listImportPlans(scope)).length, 0);
    assert.deepEqual(fixtures.chromeCreates, []);
  });

  test('skipping unselected roots commits a plan with zero queue items and no Chrome creates', async () => {
    const conversion = previewNetscapeBookmarkImport(new TextEncoder().encode(fixture));
    const preview = await handleImportRequest({ kind: 'known.import.previewFile', base64: btoa(fixture) });
    if (!preview.ok || !('preview' in preview)) throw new Error('preview_missing');
    assert.equal(preview.preview.digest, conversion.digest);
    const response = await handleImportRequest({
      kind: 'known.import.commit', digest: preview.preview.digest,
      choices: preview.preview.roots.map((root) => ({ sourceNodeId: root.sourceNodeId, action: 'skip' as const })),
    });
    assert.equal(response.ok, true);
    if (!response.ok || !('status' in response)) return;
    assert.equal(response.status.state, 'complete');
    assert.equal(response.status.progress.queued, 0);
    assert.equal((await fixtures.store!.listQueue(scope)).length, 0);
    assert.equal((await fixtures.store!.listImportPlans(scope)).length, 1);
    assert.deepEqual(fixtures.chromeCreates, []);
  });

  test('live native import omits browser workspaces and their descendants', async () => {
    const raw = chromeTree();
    fixtures.tree = [{ ...raw[0], children: [raw[0]!.children[0], {
      id: 'workspace', parentId: '0', index: 1, title: 'Workspaces', children: [
        { id: 'project', parentId: 'workspace', title: 'Project', children: [] },
      ],
    }, raw[0]!.children[1]] }];
    const response = await handleImportRequest({ kind: 'known.import.previewNative' });
    if (!response.ok || !('preview' in response)) throw new Error('preview_missing');
    assert.deepEqual(response.preview.roots.map(root => root.title), ['Bar', 'Other']);
    assert.equal(response.preview.creates, 4);
    assert.doesNotMatch(JSON.stringify(sw.importPreviews.get(response.preview.digest)), /Workspaces|Project/u);
  });

  test('native preview digest matches a live Chromium conversion of the same tree', async () => {
    const expected = previewChromeBookmarkImport(normalizeChromeBookmarkTree(fixtures.tree));
    const response = await handleImportRequest({ kind: 'known.import.previewNative', tree: fixtures.tree });
    if (!response.ok || !('preview' in response)) throw new Error('preview_missing');
    assert.equal(response.preview.sourceProfile, 'chromium-bookmarks-v1');
    assert.equal(response.preview.digest, expected.digest);
    const committed = await handleImportRequest({ kind: 'known.import.commit', digest: response.preview.digest,
      choices: response.preview.roots.map((root) => ({ sourceNodeId: root.sourceNodeId, action: 'skip' as const })) });
    assert.equal(committed.ok, true);
    assert.equal((await fixtures.store!.listQueue(scope)).length, 0);
    assert.deepEqual(fixtures.chromeCreates, []);
  });
});

describe('P1-06 import pause, resume and retry user path', () => {
  beforeEach(async () => {
    fixtures.permission = true; fixtures.tree = chromeTree(); fixtures.session.clear();
    fixtures.alarms.length = 0; fixtures.chromeCreates.length = 0;
    sw.importPreviews.clear();
    vi.mocked(scheduleSyncEngineWake).mockClear();
    (globalThis as { chrome?: unknown }).chrome = {
      storage: { session: {
        async get(keys: string | string[]) {
          const wanted = typeof keys === 'string' ? [keys] : keys;
          return Object.fromEntries(wanted.filter((key) => fixtures.session.has(key))
            .map((key) => [key, fixtures.session.get(key)]));
        },
        async set(items: Record<string, unknown>) {
          for (const [key, value] of Object.entries(items)) fixtures.session.set(key, value);
        },
        async remove(keys: string | string[]) {
          for (const key of typeof keys === 'string' ? [keys] : keys) fixtures.session.delete(key);
        },
      } },
      bookmarks: {
        getTree: async () => fixtures.tree,
        get: async (id: string) => [{ id, title: id === 'native-root' ? 'Bar' : 'Other' }],
        create: async (input: unknown) => { fixtures.chromeCreates.push(input); throw new Error('preview_must_not_create'); },
      },
      alarms: { create: (...args: unknown[]) => { fixtures.alarms.push(args); } },
    };
    const indexedDB = new IDBFactory();
    fixtures.store = createSyncStateStore({ indexedDB });
    await fixtures.store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 99_999 },
      checkpoint: { serverRevision: 'r1', cursor: 'c1' }, selectedRoots: ['server-root'] });
    await fixtures.store.putMapping(scope, { nativeId: 'native-root', colpId: 'server-root', rootNativeId: 'native-root',
      nodeKind: 'folder', projection: { revision: 'children-r1', digest: 'sha256:root' } });
  });

  test('pause via known.import.pause stops claim; resume continues the same plan and opIds', async () => {
    const preview = await handleImportRequest({ kind: 'known.import.previewFile', base64: btoa(fixture) });
    if (!preview.ok || !('preview' in preview)) throw new Error('preview_missing');
    const destination = preview.preview.targets[0]!;
    const committed = await handleImportRequest({ kind: 'known.import.commit', digest: preview.preview.digest,
      choices: preview.preview.roots.map((root, index) => index === 0
        ? { sourceNodeId: root.sourceNodeId, action: 'import' as const, target: {
          nativeId: destination.nativeId, colpId: destination.colpId, revision: destination.revision } }
        : { sourceNodeId: root.sourceNodeId, action: 'skip' as const }) });
    if (!committed.ok || !('status' in committed)) throw new Error('commit_missing');
    const stored = (await fixtures.store!.listImportPlans(scope))[0]!;
    assert.equal(stored.planId, committed.status.planId);
    assert.match(stored.conversionDigest, /^sha256:/u);
    assert.match(stored.choiceDigest, /^sha256:/u);
    const nodes = await fixtures.store!.listImportNodes(scope, committed.status.planId);
    assert.equal(nodes.every((node) => typeof node.opId === 'string' && Number.isSafeInteger(node.order)), true);
    assert.deepEqual(fixtures.chromeCreates, []);
    const queued = await fixtures.store!.listQueue(scope);
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.opId, nodes.find((node) => node.choice === 'import' && node.parentSourceNodeId === null)?.opId);
    assert.equal(queued[0]?.retry.attempt, 0);
    vi.mocked(scheduleSyncEngineWake).mockClear();
    const paused = await handleImportRequest({ kind: 'known.import.pause', planId: committed.status.planId });
    if (!paused.ok || !('status' in paused)) throw new Error('pause_missing');
    assert.equal(paused.status.state, 'paused');
    assert.equal(paused.status.planId, committed.status.planId);
    assert.equal(vi.mocked(scheduleSyncEngineWake).mock.calls.length, 0);
    const lease = await fixtures.store!.acquireLease(scope, 'owner', 101, 1_000);
    assert.equal(lease.outcome, 'acquired');
    assert.equal(await fixtures.store!.claimNextQueue(scope, 'owner', lease.fence, 102), null);
    const resumed = await handleImportRequest({ kind: 'known.import.resume', planId: committed.status.planId });
    if (!resumed.ok || !('status' in resumed)) throw new Error('resume_missing');
    assert.equal(resumed.status.planId, committed.status.planId);
    assert.equal(vi.mocked(scheduleSyncEngineWake).mock.calls.length, 1);
    const claimed = await fixtures.store!.claimNextQueue(scope, 'owner', lease.fence, 103);
    assert.equal(claimed?.opId, queued[0]?.opId);
    assert.equal(claimed?.payload.type, 'create_node');
    const after = await fixtures.store!.listImportNodes(scope, committed.status.planId);
    assert.deepEqual(after.map((node) => node.opId), nodes.map((node) => node.opId));
  });

  test('retry via known.import.retry retries recoverable originals and leaves conflict in attention', async () => {
    const preview = await handleImportRequest({ kind: 'known.import.previewFile', base64: btoa(fixture) });
    if (!preview.ok || !('preview' in preview)) throw new Error('preview_missing');
    const destination = preview.preview.targets[0]!;
    const committed = await handleImportRequest({ kind: 'known.import.commit', digest: preview.preview.digest,
      choices: preview.preview.roots.map((root) => ({ sourceNodeId: root.sourceNodeId, action: 'import' as const,
        target: { nativeId: destination.nativeId, colpId: destination.colpId, revision: destination.revision } })) });
    if (!committed.ok || !('status' in committed)) throw new Error('commit_missing');
    const queued = await fixtures.store!.listQueue(scope);
    const first = queued[0]!; const conflicted = queued[1]!;
    await fixtures.store!.completeQueueWithReceipt(scope, first.sequence, { opId: first.opId,
      operationDigest: first.digest, kind: 'terminal', receiptId: 'receipt-ok', resultDigest: 'sha256:ok',
      result: { targetId: 'server-folder', revision: 'folder-r1' } });
    const lease = await fixtures.store!.acquireLease(scope, 'owner', 101, 1_000);
    assert.equal(lease.outcome, 'acquired');
    await fixtures.store!.claimNextQueue(scope, 'owner', lease.fence, 102);
    const conflictResult = { batchId: 'batch', results: [{ opId: conflicted.opId, sequence: conflicted.sequence,
      status: 'conflicted', conflictId: 'conflict-1', cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1' };
    await fixtures.store!.settleClaimedPush(scope, conflicted.sequence, 'owner', lease.fence, { outcome: 'blocked',
      receipt: { opId: conflicted.opId, operationDigest: conflicted.digest, kind: 'terminal',
        receiptId: `push-${conflicted.opId}`, resultDigest: 'sha256:conflict', result: conflictResult },
      retry: { attempt: 0, notBefore: 0 }, recovery: { code: 'conflict_pending' } });
    const nodes = await fixtures.store!.listImportNodes(scope, committed.status.planId);
    const recoverable = nodes.find((node) => node.status === 'staged' && node.choice === 'import');
    if (!recoverable) throw new Error('staged_missing');
    await fixtures.store!.setImportNodeRecovery(scope, committed.status.planId, recoverable.opId, 'permission_required');
    await fixtures.store!.setImportPlanState(scope, committed.status.planId, 'attention', 200);
    vi.mocked(scheduleSyncEngineWake).mockClear();
    const retried = await handleImportRequest({ kind: 'known.import.retry', planId: committed.status.planId });
    if (!retried.ok || !('status' in retried)) throw new Error('retry_missing');
    assert.equal(retried.status.planId, committed.status.planId);
    assert.equal(retried.status.state, 'attention');
    assert.equal(retried.status.progress.recoverable, 1);
    assert.equal(vi.mocked(scheduleSyncEngineWake).mock.calls.length, 1);
    const afterQueue = await fixtures.store!.listQueue(scope);
    assert.equal(new Set(afterQueue.map((item) => item.opId)).size, afterQueue.length);
    assert.equal(afterQueue.filter((item) => item.opId === first.opId).length, 1);
    assert.equal(afterQueue.filter((item) => item.opId === conflicted.opId).length, 1);
    assert.equal(afterQueue.find((item) => item.opId === conflicted.opId)?.status, 'blocked');
    const afterNodes = await fixtures.store!.listImportNodes(scope, committed.status.planId);
    assert.deepEqual(afterNodes.map((node) => node.opId), nodes.map((node) => node.opId));
    assert.equal(afterNodes.find((node) => node.opId === conflicted.opId)?.recovery, 'conflict');
    assert.equal(afterNodes.find((node) => node.opId === recoverable.opId)?.recovery, undefined);
  });
});
