import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, test } from 'vitest';
import { createBootstrapCoordinator } from '../src/bootstrap/coordinator.js';
import {
  lastMatchIndexStats, matchLocalRemote, type LocalNodeFact, type MountFact, type RemoteNodeFact,
} from '../src/bootstrap/matcher.js';
import { buildRemoteIndex, encodeFactKey, matchIndexBuilds } from '../src/bootstrap/match-index.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';

const mounts: MountFact[] = [{ nativeRootId: 'bar', rootRole: 'bookmarks-bar', remoteMountNodeId: 'mount-bar' }];

function remoteTree(count: number): RemoteNodeFact[] {
  const root: RemoteNodeFact = {
    nodeId: 'folder-root', parentId: null, kind: 'folder', title: '', folderRole: 'root', revision: 'r0',
  };
  const bar: RemoteNodeFact = {
    nodeId: 'mount-bar', parentId: 'folder-root', kind: 'folder', title: 'Bar', folderRole: 'bookmarks-bar',
    revision: 'r1',
  };
  const bookmarks: RemoteNodeFact[] = Array.from({ length: count }, (_, index) => ({
    nodeId: `bm-${index}`, parentId: 'mount-bar', kind: 'bookmark' as const, title: `T${index}`,
    url: `https://example.test/${index}`, revision: `r-${index}`,
  }));
  return [root, bar, ...bookmarks];
}

test('FRR-06-A: matcher builds remote/mount indexes once across 1k/2k/5k/10k facts', () => {
  const sizes = [1_000, 2_000, 5_000, 10_000] as const;
  const visits: number[] = [];
  for (const size of sizes) {
    const report = matchLocalRemote({
      scopeKey: 'scope-1', confirmationId: 'conf-index', local: [], remote: remoteTree(size), mappings: [],
      mounts, rootNodeId: 'folder-root', bootstrapMode: 'merge',
    });
    const stats = lastMatchIndexStats();
    assert.ok(stats);
    assert.equal(stats.remoteCount, size + 2);
    assert.equal(stats.localIndexBuilds, 1);
    assert.equal(stats.remoteIndexBuilds, 1);
    assert.equal(stats.mountIndexBuilds, 1);
    assert.ok(stats.mountChainVisits <= stats.remoteCount);
    visits.push(stats.mountChainVisits);
    assert.equal(report.matched.length, 0);
  }
  assert.ok(visits[3]! <= visits[2]! * 3 + 10);
});

test('FRR-06-A: remoteIndexBuilds counts buildRemoteIndex calls for that match, not per node', () => {
  const remote = remoteTree(10_000);
  matchIndexBuilds.reset();
  assert.equal(buildRemoteIndex(remote, 0).stats.remoteIndexBuilds, 1);
  assert.equal(buildRemoteIndex(remote, 0).stats.remoteIndexBuilds, 2);
  let remoteNotes = 0;
  const originalNote = matchIndexBuilds.note;
  matchIndexBuilds.note = (kind) => {
    if (kind === 'remote') remoteNotes += 1;
    originalNote.call(matchIndexBuilds, kind);
  };
  try {
    const report = matchLocalRemote({
      scopeKey: 'scope-1', confirmationId: 'conf-index-count', local: [], remote, mappings: [],
      mounts, rootNodeId: 'folder-root', bootstrapMode: 'merge',
    });
    const stats = lastMatchIndexStats();
    assert.ok(stats);
    assert.equal(remoteNotes, 1);
    assert.equal(stats.remoteCount, 10_002);
    assert.equal(stats.localIndexBuilds, 1);
    assert.equal(stats.remoteIndexBuilds, 1);
    assert.equal(stats.mountIndexBuilds, 1);
    assert.notEqual(stats.remoteIndexBuilds, remote.length);
    assert.equal(report.matched.length, 0);
  } finally {
    matchIndexBuilds.note = originalNote;
  }
  assert.equal(buildRemoteIndex([], 0).stats.remoteIndexBuilds, 2);
  assert.equal(lastMatchIndexStats()?.remoteIndexBuilds, 1);
});

test('FRR-06-A: structured keys do not collide when title or URL contains a separator', () => {
  assert.notEqual(encodeFactKey(['mount', 'parent', 'a|b', '']), encodeFactKey(['mount', 'parent', 'a', 'b']));
  const local: LocalNodeFact[] = [
    { nativeId: 'pipe', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'bookmark',
      title: 'a|b', url: 'https://example.test/pipe' },
    { nativeId: 'plain', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'bookmark',
      title: 'a', url: 'https://example.test/plain' },
  ];
  const remote: RemoteNodeFact[] = [
    { nodeId: 'folder-root', parentId: null, kind: 'folder', title: '', folderRole: 'root', revision: 'r0' },
    { nodeId: 'mount-bar', parentId: 'folder-root', kind: 'folder', title: 'Bar', folderRole: 'bookmarks-bar',
      revision: 'r1' },
    { nodeId: 'remote-pipe', parentId: 'mount-bar', kind: 'bookmark', title: 'a|b',
      url: 'https://example.test/pipe', revision: 'r2' },
    { nodeId: 'remote-plain', parentId: 'mount-bar', kind: 'bookmark', title: 'a',
      url: 'https://example.test/plain', revision: 'r3' },
  ];
  const report = matchLocalRemote({
    scopeKey: 'scope-1', confirmationId: 'conf-pipe', local, remote, mappings: [], mounts,
    rootNodeId: 'folder-root', bootstrapMode: 'merge',
  });
  assert.equal(report.matched.some((row) => row.nativeId === 'pipe' && row.nodeId === 'remote-pipe'), true);
  assert.equal(report.matched.some((row) => row.nativeId === 'plain' && row.nodeId === 'remote-plain'), true);
});

test('FRR-06-A: parent-first matching feeds a newly paired folder into its child', () => {
  const local: LocalNodeFact[] = [
    { nativeId: 'folder-1', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'folder', title: 'Work' },
    { nativeId: 'bm-1', mountNativeRootId: 'bar', parentNativeId: 'folder-1', kind: 'bookmark',
      title: 'Doc', url: 'https://example.test/doc' },
  ];
  const remote: RemoteNodeFact[] = [
    { nodeId: 'folder-root', parentId: null, kind: 'folder', title: '', folderRole: 'root', revision: 'r0' },
    { nodeId: 'mount-bar', parentId: 'folder-root', kind: 'folder', title: 'Bar', folderRole: 'bookmarks-bar',
      revision: 'r1' },
    { nodeId: 'work-colp', parentId: 'mount-bar', kind: 'folder', title: 'Work', revision: 'r2' },
    { nodeId: 'doc-colp', parentId: 'work-colp', kind: 'bookmark', title: 'Doc', url: 'https://example.test/doc',
      revision: 'r3' },
  ];
  const report = matchLocalRemote({
    scopeKey: 'scope-1', confirmationId: 'conf-parent', local, remote, mappings: [], mounts,
    rootNodeId: 'folder-root', bootstrapMode: 'merge',
  });
  assert.equal(report.matched.some((row) => row.nativeId === 'folder-1' && row.nodeId === 'work-colp'), true);
  assert.equal(report.matched.some((row) => row.nativeId === 'bm-1' && row.nodeId === 'doc-colp'), true);
  assert.equal(report.planned.length, 0);
});

test('FRR-06: mapping pair records a parent conflict when local and remote parents differ', () => {
  const local: LocalNodeFact[] = [
    { nativeId: 'folder-a', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'folder', title: 'A' },
    { nativeId: 'bm', mountNativeRootId: 'bar', parentNativeId: 'folder-a', kind: 'bookmark',
      title: 'Doc', url: 'https://example.test/doc' },
  ];
  const remote: RemoteNodeFact[] = [
    { nodeId: 'folder-root', parentId: null, kind: 'folder', title: '', folderRole: 'root', revision: 'r0' },
    { nodeId: 'mount-bar', parentId: 'folder-root', kind: 'folder', title: 'Bar', folderRole: 'bookmarks-bar',
      revision: 'r1' },
    { nodeId: 'folder-a-colp', parentId: 'mount-bar', kind: 'folder', title: 'A', revision: 'r2' },
    { nodeId: 'remote-bm', parentId: 'mount-bar', kind: 'bookmark', title: 'Doc',
      url: 'https://example.test/doc', revision: 'r3' },
  ];
  const report = matchLocalRemote({
    scopeKey: 'scope-1', confirmationId: 'conf-parent-conflict', local, remote,
    mappings: [
      { nativeId: 'bar', colpId: 'mount-bar' },
      { nativeId: 'folder-a', colpId: 'folder-a-colp' },
      { nativeId: 'bm', colpId: 'remote-bm' },
    ],
    mounts, rootNodeId: 'folder-root', bootstrapMode: 'merge',
  });
  assert.ok(report.conflicts.some((row) => row.kind === 'parent' && row.localNativeId === 'bm'
    && row.remoteNodeId === 'remote-bm'));
});

test('FRR-06: confirmed upload destructive deletes remote-only descendants', () => {
  const local: LocalNodeFact[] = [
    { nativeId: 'bar', mountNativeRootId: 'bar', parentNativeId: null, kind: 'folder', title: 'Bar' },
  ];
  const remote: RemoteNodeFact[] = [
    { nodeId: 'folder-root', parentId: null, kind: 'folder', title: '', folderRole: 'root', revision: 'r0' },
    { nodeId: 'mount-bar', parentId: 'folder-root', kind: 'folder', title: 'Bar', folderRole: 'bookmarks-bar',
      revision: 'r1' },
    { nodeId: 'stale-bm', parentId: 'mount-bar', kind: 'bookmark', title: 'Gone locally',
      url: 'https://example.test/stale', revision: 'r2' },
  ];
  const report = matchLocalRemote({
    scopeKey: 'scope-1', confirmationId: 'conf-upload-destroy', local, remote,
    mappings: [{ nativeId: 'bar', colpId: 'mount-bar' }], mounts, rootNodeId: 'folder-root',
    bootstrapMode: 'upload', destructiveConfirmed: true,
  });
  assert.ok(report.planned.some((op) => op.type === 'delete_node' && op.targetId === 'stale-bm'
    && op.reason === 'destructive'));
});

test('upload resolves an unbound special mount by role and preserves another device mount', () => {
  const remote = [...remoteTree(1),
    { nodeId: 'peer-mount', parentId: 'folder-root', kind: 'folder' as const, title: 'Peer folder',
      folderRole: 'custom', revision: 'r1' },
    { nodeId: 'peer-bookmark', parentId: 'peer-mount', kind: 'bookmark' as const, title: 'Peer bookmark',
      url: 'https://example.test/peer', revision: 'r1' },
  ];
  const report = matchLocalRemote({ scopeKey: 'scope-1', confirmationId: 'unbound-upload',
    local: [{ nativeId: 'bar', mountNativeRootId: 'bar', parentNativeId: null, kind: 'folder', title: 'Bar' }],
    remote, mappings: [], mounts: [{ nativeRootId: 'bar', rootRole: 'bookmarks-bar', remoteMountNodeId: null }],
    rootNodeId: 'folder-root', bootstrapMode: 'upload', destructiveConfirmed: true,
  });
  assert.deepEqual(report.destructivePlan?.deletes, [{ targetId: 'bm-0', side: 'remote' }]);
  assert.deepEqual(report.planned.map(op => [op.type, op.targetId]), [['delete_node', 'bm-0']]);
  assert.ok(report.matched.some(row => row.nativeId === 'bar' && row.nodeId === 'mount-bar'));
});

const scope: SyncScope = {
  environment: 'production', serverId: 'server-frr06', serverOrigin: 'https://known.example',
  accountId: 'account-frr06', browserProfileId: 'profile-frr06', collectionId: 'collection-frr06',
  replicaId: 'replica-frr06', generation: 1,
};

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

test('FRR-06-B: bootstrap rematch reads recovery/receipts without exportScope', async () => {
  const inner = createSyncStateStore({ indexedDB });
  let exportCalls = 0;
  const store = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'exportScope') {
        return async (...args: Parameters<typeof inner.exportScope>) => {
          exportCalls += 1;
          return target.exportScope(...args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  await store.registerScope({
    ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 99_999 },
    checkpoint: { serverRevision: 'r0', cursor: 'c0' }, selectedRoots: [],
  });
  const coordinator = createBootstrapCoordinator({ store, scope, now: () => 10, randomUUID: () => 'run-frr06' });
  await coordinator.confirm({
    confirmationId: 'conf-frr06', treeDigest: 'sha256:tree', confirmationVersion: '1',
    localFacts: [{ nativeId: 'bm-1', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'bookmark',
      title: 'One', url: 'https://example.test/one' }],
    remoteFacts: [{ nodeId: 'folder-root', parentId: null, kind: 'folder', title: '', folderRole: 'root',
      revision: 'r0' }],
    mounts: [{ nativeRootId: 'bar', rootRole: 'bookmarks-bar', remoteMountNodeId: 'mount-bar' }],
    rootNodeId: 'folder-root',
  });
  assert.equal(exportCalls, 0);
});

test('FRR-06-B: matcher and coordinator do not call exportScope', () => {
  const matcher = readFileSync(resolve(import.meta.dirname, '../src/bootstrap/matcher.ts'), 'utf8');
  const coordinator = readFileSync(resolve(import.meta.dirname, '../src/bootstrap/coordinator.ts'), 'utf8');
  assert.equal(matcher.includes('exportScope'), false);
  assert.equal(coordinator.includes('exportScope'), false);
});

