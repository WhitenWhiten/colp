// @vitest-environment happy-dom
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { afterEach, test, vi } from 'vitest';
import { scanBoundary } from '../src/bookmark-boundary.js';
import { advancedLocalFacts } from '../src/bootstrap/advanced-local-facts.js';
import { recordBoundaryDiagnostics } from '../src/bootstrap/boundary-diagnostics.js';
import { createBootstrapCoordinator } from '../src/bootstrap/coordinator.js';
import type { RemoteNodeFact } from '../src/bootstrap/matcher.js';
import { localFactsFromRoots } from '../src/bootstrap/local-facts.js';
import { createChromeBookmarkTreeAdapter, type ChromeBookmarkNode, type NormalizedBookmarkNode,
  type NormalizedBookmarkRoot } from '../src/chrome-bookmark-tree.js';
import { paintPreviewTotals, previewOmissionCopy } from '../src/first-run-preview-copy.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { createSyncStateStore, type JsonObject } from '../src/sync-state-store.js';
import { bar, scope, setup } from './sync-recovery-hardening-fixture.js';

const unsupportedUrls = [
  'javascript:alert("private bookmarklet")', 'data:text/plain,private%20data', 'file:///private/report.html',
  'chrome://settings/', 'about:blank', 'mailto:private@example.test', 'ftp://private.example.test/archive',
  '', '   ', 'https://private-user:private-password@example.test/',
];
const bookmark = (nativeId: string, url: string, title = nativeId): NormalizedBookmarkNode =>
  ({ nativeId, title, kind: 'bookmark', managed: false, url, children: [] });
const folder = (nativeId: string, title: string, children: NormalizedBookmarkNode[]): NormalizedBookmarkNode =>
  ({ nativeId, title, kind: 'folder', managed: false, children });

function mixedTree(): NormalizedBookmarkRoot[] {
  return [{ ...folder('1', 'Bookmarks bar', [
    folder('nested', 'Nested', [bookmark('good-route', 'https://example.test/#/route//?q=%F0%9F%98%80', ''),
      folder('deeper', 'Deeper', [bookmark('good-http', 'http://example.test/a//b?x=1&y=2#frag'),
        ...unsupportedUrls.map((url, index) => bookmark(`unsupported-${index}`, url))])]),
    folder('bad-folder', '   ', [bookmark('protected-child', 'https://private.example.test/under-invalid-folder')]),
    folder('private', 'Private', [bookmark('private-child', 'file:///private/local-only')]),
    folder('excluded', 'Excluded', [bookmark('excluded-child', 'chrome://private')]),
    { ...folder('managed', 'Managed', []), managed: true,
      children: [{ ...bookmark('managed-child', 'javascript:privateManaged()'), managed: true }] },
  ]), rootKind: 'bookmarks_bar' },
  { ...folder('other', 'Other bookmarks', [bookmark('unselected-child', 'file:///private/unselected')]), rootKind: 'other' }];
}
const scan = (roots: readonly NormalizedBookmarkRoot[] = mixedTree()) => scanBoundary({ roots, selectedNativeIds: ['1'],
  excludedNativeIds: ['excluded'], privateNativeIds: ['private'] });

function rawBrowserTree(): ChromeBookmarkNode[] {
  const native = (node: NormalizedBookmarkNode): ChromeBookmarkNode => ({ id: node.nativeId, title: node.title,
    type: node.kind, ...(node.url === undefined ? {} : { url: node.url }),
    ...(node.managed ? { unmodifiable: 'managed' } : {}), children: node.children.map(native) });
  return [{ id: '0', title: '', children: mixedTree().map(root => ({ ...native(root), parentId: '0',
    folderType: root.rootKind === 'bookmarks_bar' ? 'bookmarks-bar' : 'other' })) }];
}

afterEach(async () => {
  await Promise.resolve();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

test('mixed nested trees retain unsupported items locally while valid bookmarks continue into bootstrap', async () => {
  const store = await setup();
  const browserTree = rawBrowserTree(), originalTree = structuredClone(browserTree);
  const { roots } = await createChromeBookmarkTreeAdapter({ getTree: async () => structuredClone(browserTree),
    getChildren: async () => { throw new Error('unexpected getChildren'); },
    getSubTree: async () => { throw new Error('unexpected getSubTree'); },
  }).read();
  const preview = scan(roots);
  let reopened: ReturnType<typeof createSyncStateStore> | undefined;
  try {
    await store.putMapping(scope, bar);
    assert.equal(preview.bookmarkCount, 2, 'the empty-title favicon bookmark and the ordinary web bookmark are both supported');
    assert.equal(preview.folderCount, 3);
    assert.deepEqual(preview.warnings, [
      { code: 'invalid_url', count: 5 }, { code: 'unsupported_url_scheme', count: 5 }, { code: 'invalid_title', count: 2 },
    ]);
    assert.ok(preview.skippedCount > unsupportedUrls.length + 2, 'unselected/private/managed items are not omission counts');
    const facts = localFactsFromRoots(roots, ['1'], ['excluded'], ['private']);
    assert.deepEqual(facts.map(row => row.nativeId), ['nested', 'good-route', 'deeper', 'good-http']);
    const protectedFacts = advancedLocalFacts(roots, preview);
    for (const id of [...unsupportedUrls.map((_, index) => `unsupported-${index}`), 'bad-folder', 'protected-child']) {
      assert.equal(preview.classifications.get(id), 'unsupported');
      assert.equal(protectedFacts.find(row => row.nativeId === id)?.privateLocal, true,
        'an advanced plan must not infer that a protected descendant vanished');
    }
    assert.deepEqual(protectedFacts.filter(row => row.nativeId.startsWith('unsupported-')).map(row => row.url), unsupportedUrls);
    const record = await store.putScopePreview(scope, { previewId: 'scheme-review', boundaryVersion: '1',
      treeDigest: preview.treeDigest, bookmarkCount: preview.bookmarkCount, folderCount: preview.folderCount,
      skippedCount: preview.skippedCount, warnings: preview.warnings, expiresAt: Date.now() + 60_000,
      boundary: { selectedNativeIds: preview.selectedNativeIds, excludedNativeIds: preview.excludedNativeIds, mounts: preview.mounts } });
    store.close();
    reopened = createSyncStateStore({ indexedDB: store.factory });
    assert.deepEqual(await reopened.getScopePreview(scope, record.previewId), record, 'exact omission counts survive a worker restart');
    await recordBoundaryDiagnostics(reopened, scope, preview, roots, record.previewId);
    await recordBoundaryDiagnostics(reopened, scope, preview, roots, record.previewId);
    const diagnostics = await reopened.listIngressDiagnostics(scope);
    for (const warning of preview.warnings) {
      assert.equal(diagnostics.find(row => row.code === warning.code)?.count, warning.count, 'a retried scan does not count the same native item again');
    }
    const coordinator = createBootstrapCoordinator({ store: reopened, scope });
    const remoteFacts: RemoteNodeFact[] = [
      { nodeId: 'root', parentId: null, kind: 'folder', title: 'Root', folderRole: 'root', revision: 'r1' },
      { nodeId: 'bar', parentId: 'root', kind: 'folder', title: 'Bookmarks bar', folderRole: 'bookmarks-bar', revision: 'r1' },
    ];
    const input = { confirmationId: 'scheme-confirm', confirmationVersion: '1', previewId: record.previewId,
      treeDigest: preview.treeDigest, localFacts: facts,
      mounts: [{ nativeRootId: '1', rootRole: 'bookmarks-bar' as const, remoteMountNodeId: 'bar' }], rootNodeId: 'root',
      remoteFacts };
    let view = await coordinator.confirm(input);
    assert.equal(view.run.phase, 'syncing');
    assert.deepEqual((await reopened.listQueue(scope)).map(row => row.opId), ['b3.scheme-confirm.create.nested'],
      'nested children wait for the parent server receipt');
    const sent: JsonObject[] = [];
    const endpoint = `${scope.serverOrigin}/v1/push`;
    const worker = createOutboundPushWorker({ scope, store: reopened, now: () => 10_000,
      ownerId: () => 'unsupported-preview-test', endpoints: async () => ({
        syncSessions: `${scope.serverOrigin}/v1/session`, syncSnapshot: `${scope.serverOrigin}/v1/snapshot`,
        syncPush: endpoint, syncPull: `${scope.serverOrigin}/v1/pull`, syncAck: `${scope.serverOrigin}/v1/ack`,
        syncConflict: `${scope.serverOrigin}/v1/conflicts/{conflictId}`,
        syncEffectPages: `${scope.serverOrigin}/v1/effects/{effectId}/pages/{pageNumber}`,
        syncRetire: `${scope.serverOrigin}/v1/retire`, effectPageAuthority: scope.serverOrigin,
      }), sessions: { async get() { return { credential: { accessToken: 'fixture-access' }, session: {
        sessionId: 'preview-session', expiresAt: '2099-01-01T00:00:00Z', scope: 'collection' as const,
        snapshotRequired: false, credentialAuthorityDigest: 'a'.repeat(64),
        collection: { collectionId: scope.collectionId, serverCursor: 'c0', serverRevision: 'r1' },
        replicaLease: { leaseId: 'lease', generation: '1', state: 'active' as const, expiresAt: '2099-01-01T00:00:00Z' },
      } }; } }, fetch: async (url, init) => {
        assert.equal(String(url), endpoint); assert.equal(init?.method, 'POST');
        const body = JSON.parse(String(init.body)) as { batchId: string; operations: JsonObject[] };
        const results = body.operations.map(operation => {
          assert.equal(operation.type, 'create_node'); sent.push(operation);
          const payload = operation.payload as JsonObject, node = payload.node as JsonObject;
          assert.ok(remoteFacts.some(row => row.nodeId === payload.parentId), 'every wire create uses an acknowledged parent');
          const nodeId = `server-${operation.sequence}`, revision = `r-${operation.sequence}`, cursor = `c-${operation.sequence}`;
          remoteFacts.push({ nodeId, parentId: String(payload.parentId), kind: node.kind as RemoteNodeFact['kind'],
            title: String(node.title), ...(typeof node.url === 'string' ? { url: node.url } : {}), revision });
          return { opId: operation.opId, sequence: operation.sequence, status: 'applied', targetId: nodeId,
            revision, cursor, warnings: [] };
        });
        return new Response(JSON.stringify({ batchId: body.batchId, results, serverCursor: results.at(-1)!.cursor }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      } });
    for (let pass = 0; pass < 3 && view.run.phase !== 'completed'; pass += 1) {
      assert.equal((await worker.drain()).outcome, 'terminal');
      view = await coordinator.advance(view.run.runId, input);
    }
    assert.equal(view.run.phase, 'completed', 'protected local items do not prevent supported descendants from finishing');
    const queued = await reopened.listQueue(scope);
    assert.deepEqual(queued.map(row => row.opId).sort(), facts.map(row => `b3.scheme-confirm.create.${row.nativeId}`).sort());
    assert.ok(queued.every(row => row.payload.type === 'create_node'));
    assert.ok(queued.every(row => row.status === 'terminal'));
    assert.deepEqual(sent.map(row => row.opId).sort(), queued.map(row => row.opId).sort());
    assert.deepEqual(remoteFacts.filter(row => row.kind === 'bookmark').map(row => row.url).sort(),
      facts.filter(row => row.kind === 'bookmark').map(row => row.url).sort(), 'web addresses retain every path slash and fragment');
    assert.ok(!JSON.stringify(queued).includes('private'), 'unsupported and protected content never reaches an outbound payload');
    assert.deepEqual(browserTree, originalTree, 'the browser tree retains every original item and URL');
  } finally { reopened?.close(); store.close(); }
});

test('the preview explains exact local-only counts without exposing bookmark content', async () => {
  const preview = scan();
  // Metadata is optional when bookmark permission is absent. The real preview
  // renderer still runs, without substituting its copy or totals functions.
  vi.stubGlobal('chrome', { bookmarks: {} });
  document.body.innerHTML = '<p id="totals"></p><p id="feedback" role="status"></p>';
  const totals = document.getElementById('totals')!, feedback = document.getElementById('feedback')!;
  const announcements: string[] = [];
  paintPreviewTotals(totals, { ...preview, previewId: 'current-preview' }, () => 'current-preview', copy => {
    announcements.push(copy); feedback.textContent = copy;
  });
  await Promise.resolve();
  assert.equal(totals.textContent, 'Will sync: 2 bookmarks, 3 folders');
  assert.equal(announcements.length, 1);
  const copy = feedback.textContent ?? '';
  assert.match(copy, /^12 items will stay in this browser and will not sync:/u);
  assert.match(copy, /Other bookmarks will sync\.$/u);
  assert.ok(!copy.includes('private'));
  for (const url of unsupportedUrls.filter(Boolean)) assert.ok(!copy.includes(url));
  assert.equal(feedback.querySelector('*'), null);
});

test('legacy and untrusted warning counts never become invented item totals', async () => {
  assert.equal(previewOmissionCopy([{ code: 'nested_normalized' }]), undefined);
  assert.match(previewOmissionCopy([{ code: 'invalid_url', count: 1 }])!, /^1 item will stay/u);
  for (const count of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.match(previewOmissionCopy([{ code: 'invalid_url', count }])!, /^Some items will stay/u);
  }
  assert.match(previewOmissionCopy([{ code: 'invalid_url', count: 2 }, { code: 'invalid_title' }])!, /^Some items will stay/u);
  const store = await setup();
  try {
    const preview = scan();
    const record = { previewId: 'legacy', boundaryVersion: '1', treeDigest: preview.treeDigest,
      bookmarkCount: 2, folderCount: 3, skippedCount: preview.skippedCount, expiresAt: Date.now() + 60_000,
      warnings: [{ code: 'invalid_url' }], boundary: { selectedNativeIds: ['1'], excludedNativeIds: [], mounts: preview.mounts } };
    await store.putScopePreview(scope, record);
    assert.deepEqual((await store.getScopePreview(scope, 'legacy'))?.warnings, [{ code: 'invalid_url' }]);
    for (const count of [0, -1, 1.5]) {
      await assert.rejects(store.putScopePreview(scope, { ...record, warnings: [{ code: 'invalid_url', count }] }));
    }
    assert.deepEqual((await store.getScopePreview(scope, 'legacy'))?.warnings, [{ code: 'invalid_url' }]);
  } finally { store.close(); }
});
