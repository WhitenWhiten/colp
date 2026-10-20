/**
 * Owner: KNS-08 (QA). Fixture: see e2e/kns-08-ids.ts.
 * Run: see e2e/kns-08-ids.ts.
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { createBootstrapCoordinator } from '../src/bootstrap/coordinator.js';
import { matchLocalRemote, type LocalNodeFact, type MappingFact, type MountFact,
  type RemoteNodeFact } from '../src/bootstrap/matcher.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
});
const fixtures = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)),
  'fixtures/kns-00/golden-scenarios.json'), 'utf8')) as Array<{
  fixtureId: string; scenario: string; expectedOperationKinds?: string[];
  terminal: { liveNodes: Array<{ id: string; parentId: string | null; revision: string; kind?: string;
    folderRole?: string; url?: string }>; localMatchReport?: { candidates: Array<{ kind: string; url?: string;
      nodeIds: string[] }> } };
}>;

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

describe('KNS-03 merge matcher', () => {
  test('nested bookmark waits for the folder mapping and never uses Collection root', () => {
    const folder: LocalNodeFact = {
      nativeId: 'folder-1', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'folder', title: 'Nested',
    };
    const child: LocalNodeFact = {
      nativeId: 'bm-nested', mountNativeRootId: 'bar', parentNativeId: 'folder-1', kind: 'bookmark',
      title: 'Nested bm', url: 'https://example.com/nested',
    };
    const mounts: MountFact[] = [{ nativeRootId: 'bar', rootRole: 'bookmarks-bar', remoteMountNodeId: 'mount-bar' }];
    const remote: RemoteNodeFact[] = [
      { nodeId: 'folder-root', parentId: null, kind: 'folder', title: '', folderRole: 'root', revision: 'r0' },
    ];
    const waiting = matchLocalRemote({
      scopeKey: 'scope-1', confirmationId: 'conf-nested', local: [folder, child], remote, mappings: [],
      mounts, rootNodeId: 'folder-root', bootstrapMode: 'merge',
    });
    const waitingFolder = waiting.planned.find((op) => op.nativeId === 'folder-1');
    const waitingChild = waiting.planned.find((op) => op.nativeId === 'bm-nested');
    assert.equal(waitingFolder?.parentId, 'mount-bar');
    assert.equal(waitingChild?.parentId, undefined);
    assert.equal(waiting.planned.filter((op) => op.node?.kind === 'bookmark' && op.parentId === 'folder-root').length, 0);
    const ready = matchLocalRemote({
      scopeKey: 'scope-1', confirmationId: 'conf-nested', local: [folder, child], remote,
      mappings: [{ nativeId: 'folder-1', colpId: 'folder-colp' }],
      mounts, rootNodeId: 'folder-root', bootstrapMode: 'merge',
    });
    const readyChild = ready.planned.find((op) => op.nativeId === 'bm-nested');
    assert.equal(readyChild?.parentId, 'folder-colp');
    assert.equal(ready.planned.filter((op) => op.node?.kind === 'bookmark' && op.parentId === 'folder-root').length, 0);
    assertOpaquePlanned(waiting.planned);
    assertOpaquePlanned(ready.planned);
  });

  test('direct children use mapped mount native colpId when remoteMountNodeId is null', () => {
    const report = matchLocalRemote({
      scopeKey: 'scope-1', confirmationId: 'conf-map',
      local: [{ nativeId: 'bm-1', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'bookmark',
        title: 'One', url: 'https://example.com/one' }],
      remote: [{ nodeId: 'folder-root', parentId: null, kind: 'folder', title: '', folderRole: 'root',
        revision: 'r0' }],
      mappings: [{ nativeId: 'bar', colpId: 'mount-bar' }],
      mounts: [{ nativeRootId: 'bar', rootRole: 'bookmarks-bar', remoteMountNodeId: null }],
      rootNodeId: 'folder-root', bootstrapMode: 'merge',
    });
    assert.equal(report.planned.filter((op) => op.reason === 'mount-resolve').length, 0);
    assert.ok(report.planned.some((op) => op.nativeId === 'bm-1' && op.parentId === 'mount-bar'));
    assert.equal(report.planned.filter((op) => op.parentId?.startsWith('mount:')).length, 0);
    assertOpaquePlanned(report.planned);
  });

  test('104/87-style fork reuses 61 confirmed nodes, keeps 26 local-only, and candidates stay unmerged', () => {
    const mounts: MountFact[] = [{ nativeRootId: 'bar', rootRole: 'bookmarks-bar', remoteMountNodeId: 'mount-bar' }];
    const remote: RemoteNodeFact[] = [
      { nodeId: 'folder-root', parentId: null, kind: 'folder', title: '', folderRole: 'root', revision: 'r0' },
      { nodeId: 'mount-bar', parentId: 'folder-root', kind: 'folder', title: 'Bar', folderRole: 'bookmarks-bar',
        revision: 'r1' },
    ];
    const local: LocalNodeFact[] = [];
    const mappings: MappingFact[] = [];
    for (let index = 0; index < 61; index += 1) {
      const nativeId = `n-shared-${index}`; const nodeId = `bm-shared-${index}`;
      const url = `https://example.com/shared/${index}`;
      local.push({ nativeId, mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'bookmark',
        title: `Shared ${index}`, url });
      remote.push({ nodeId, parentId: 'mount-bar', kind: 'bookmark', title: `Shared ${index}`, url, revision: 'r2' });
      mappings.push({ nativeId, colpId: nodeId });
    }
    remote.push(
      { nodeId: 'folder-remote', parentId: 'mount-bar', kind: 'folder', title: 'Remote', revision: 'r1' },
    );
    for (let index = 0; index < 26; index += 1) {
      const url = `https://example.com/maybe/${index}`;
      local.push({ nativeId: `n-new-${index}`, mountNativeRootId: 'bar', parentNativeId: 'folder-local',
        kind: 'bookmark', title: `Local ${index}`, url });
      remote.push({ nodeId: `bm-maybe-${index}`, parentId: 'folder-remote', kind: 'bookmark',
        title: `Remote ${index}`, url, revision: 'r3' });
    }
    for (let index = 0; index < 17; index += 1) {
      remote.push({ nodeId: `bm-only-${index}`, parentId: 'mount-bar', kind: 'bookmark',
        title: `Cloud ${index}`, url: `https://example.com/cloud/${index}`, revision: 'r4' });
    }
    const report = matchLocalRemote({
      scopeKey: 'scope-1', confirmationId: 'conf-fork', local, remote, mappings, mounts,
      rootNodeId: 'folder-root', bootstrapMode: 'merge',
    });
    assert.equal(local.filter((row) => row.kind === 'bookmark').length, 87);
    assert.equal(remote.filter((row) => row.kind === 'bookmark').length, 104);
    assert.equal(report.matched.length, 61);
    assert.equal(report.planned.filter((op) => op.reason === 'local-only').length, 26);
    assert.equal(report.planned.filter((op) => op.type !== 'create_node').length, 0);
    assertOpaquePlanned(report.planned);
    assert.ok(report.candidates.length >= 26);
    assert.ok(report.candidates.every((row) => row.kind === 'duplicate_candidate'));
    assert.equal(report.remoteOnly.filter((id) => id.startsWith('bm-')).length, 26 + 17);
  });

  test('same URL different parent never auto-merges (KNS-00 fixture identities)', () => {
    const fixture = fixtures.find((row) => row.scenario === 'same-url-different-parent')!;
    const remote: RemoteNodeFact[] = fixture.terminal.liveNodes.map((node) => ({
      nodeId: node.id, parentId: node.parentId, kind: (node.kind as 'bookmark' | 'folder') ?? 'bookmark',
      title: 'Same', url: node.url, revision: node.revision, ...(node.folderRole ? { folderRole: node.folderRole } : {}),
    }));
    const local: LocalNodeFact[] = [
      { nativeId: 'native-a', mountNativeRootId: 'bar', parentNativeId: 'folder-a', kind: 'bookmark',
        title: 'Same', url: 'https://example.com/dup' },
      { nativeId: 'native-b', mountNativeRootId: 'bar', parentNativeId: 'folder-b', kind: 'bookmark',
        title: 'Same', url: 'https://example.com/dup' },
    ];
    const report = matchLocalRemote({
      scopeKey: 'scope-1', confirmationId: 'conf-dup', local, remote, mappings: [],
      mounts: [{ nativeRootId: 'bar', rootRole: 'bookmarks-bar', remoteMountNodeId: 'mount-bar' }],
      rootNodeId: 'folder-root', bootstrapMode: 'merge',
    });
    const merged = report.planned.filter((op) => op.type !== 'create_node' && op.type !== 'delete_node');
    assert.equal(merged.length, 0);
    assert.ok(report.candidates.some((row) => row.kind === 'duplicate_candidate'
      && row.url === 'https://example.com/dup' && row.nodeIds.length >= 2));
    assert.equal(new Set(report.matched.map((row) => row.nodeId)).size, report.matched.length);
  });

  test('unique exact URL in the same mount is a candidate, never an auto-merge', () => {
    const report = matchLocalRemote({
      scopeKey: 'scope-1', confirmationId: 'conf-url',
      local: [{ nativeId: 'native-1', mountNativeRootId: 'bar', parentNativeId: 'folder-a', kind: 'bookmark',
        title: 'Laptop', url: 'https://example.com/unique' }],
      remote: [
        { nodeId: 'mount-bar', parentId: 'folder-root', kind: 'folder', title: 'Bar', folderRole: 'bookmarks-bar',
          revision: 'r1' },
        { nodeId: 'folder-b', parentId: 'mount-bar', kind: 'folder', title: 'B', revision: 'r1' },
        { nodeId: 'bm-cloud', parentId: 'folder-b', kind: 'bookmark', title: 'Cloud',
          url: 'https://example.com/unique', revision: 'r2' },
      ],
      mappings: [], mounts: [{ nativeRootId: 'bar', rootRole: 'bookmarks-bar', remoteMountNodeId: 'mount-bar' }],
      rootNodeId: 'folder-root', bootstrapMode: 'merge',
    });
    assert.equal(report.matched.length, 0);
    assert.ok(report.candidates.some((row) => row.url === 'https://example.com/unique'));
    assert.equal(report.planned.filter((op) => op.nativeId === 'native-1' && op.type === 'create_node').length, 1);
  });

  test('unique exact URL under the same mount parent is still a candidate, not an auto-merge', () => {
    const report = matchLocalRemote({
      scopeKey: 'scope-1', confirmationId: 'conf-same-parent-url',
      local: [{ nativeId: 'native-1', mountNativeRootId: 'bar', parentNativeId: 'folder-a', kind: 'bookmark',
        title: 'Laptop', url: 'https://example.com/same-parent' }],
      remote: [
        { nodeId: 'mount-bar', parentId: 'folder-root', kind: 'folder', title: 'Bar', folderRole: 'bookmarks-bar',
          revision: 'r1' },
        { nodeId: 'folder-a', parentId: 'mount-bar', kind: 'folder', title: 'A', revision: 'r1' },
        { nodeId: 'bm-cloud', parentId: 'folder-a', kind: 'bookmark', title: 'Cloud',
          url: 'https://example.com/same-parent', revision: 'r2' },
      ],
      mappings: [], mounts: [{ nativeRootId: 'bar', rootRole: 'bookmarks-bar', remoteMountNodeId: 'mount-bar' }],
      rootNodeId: 'folder-root', bootstrapMode: 'merge',
    });
    assert.equal(report.matched.length, 0);
    assert.ok(report.candidates.some((row) => row.url === 'https://example.com/same-parent'));
    assert.equal(report.planned.filter((op) => op.nativeId === 'native-1' && op.type === 'create_node').length, 1);
  });

  test('consistent persisted mapping and sidecar identity win over URL heuristics', () => {
    const local: LocalNodeFact[] = [
      { nativeId: 'native-map', mountNativeRootId: 'bar', parentNativeId: 'other', kind: 'bookmark',
        title: 'Changed', url: 'https://example.com/other', sourceRefColpId: 'bm-side' },
    ];
    const remote: RemoteNodeFact[] = [
      { nodeId: 'bm-map', parentId: 'mount-bar', kind: 'bookmark', title: 'Mapped',
        url: 'https://example.com/mapped', revision: 'r1' },
      { nodeId: 'bm-side', parentId: 'mount-bar', kind: 'bookmark', title: 'Sidecar',
        url: 'https://example.com/side', revision: 'r1' },
    ];
    const mapped = matchLocalRemote({
      scopeKey: 's', confirmationId: 'c', local: local.map(row => ({ ...row, sourceRefColpId: 'bm-map' })),
      remote, mappings: [{ nativeId: 'native-map', colpId: 'bm-map' }],
      mounts: [{ nativeRootId: 'bar', rootRole: 'bookmarks-bar', remoteMountNodeId: 'mount-bar' }],
      rootNodeId: 'folder-root', bootstrapMode: 'merge',
    });
    assert.deepEqual(mapped.matched, [{ nativeId: 'native-map', nodeId: 'bm-map' }]);
    const sidecar = matchLocalRemote({
      scopeKey: 's', confirmationId: 'c', local, remote, mappings: [], sidecars: [{ nativeId: 'native-map',
        colpId: 'bm-side' }],
      mounts: [{ nativeRootId: 'bar', rootRole: 'bookmarks-bar', remoteMountNodeId: 'mount-bar' }],
      rootNodeId: 'folder-root', bootstrapMode: 'merge',
    });
    assert.deepEqual(sidecar.matched, [{ nativeId: 'native-map', nodeId: 'bm-side' }]);
    const sourceRef = matchLocalRemote({
      scopeKey: 's', confirmationId: 'c', local, remote, mappings: [],
      mounts: [{ nativeRootId: 'bar', rootRole: 'bookmarks-bar', remoteMountNodeId: 'mount-bar' }],
      rootNodeId: 'folder-root', bootstrapMode: 'merge',
    });
    assert.deepEqual(sourceRef.matched, [{ nativeId: 'native-map', nodeId: 'bm-side' }]);
  });
});

describe('KNS-03 scan-period inbox and Snapshot recovery', () => {
  test('replays post-scan native create/rename/delete by ordinal with no drop or double create', async () => {
    const { store, coordinator } = await setup();
    const create = fixtures.find((row) => row.scenario === 'native-create-after-scan')!;
    const rename = fixtures.find((row) => row.scenario === 'native-rename-after-scan')!;
    const remove = fixtures.find((row) => row.scenario === 'native-delete-after-scan')!;
    await store.stageBookmarkEvent(scope, {
      eventId: 'evt-create', dedupeKey: 'd-create', occurredAt: '2026-07-27T05:00:00Z', kind: 'create',
      nativeId: 'native-after', details: { title: 'After scan', url: 'https://example.com/after-scan',
        parentNativeId: 'bar', mountNativeRootId: 'bar', kind: 'bookmark' },
    });
    await store.stageBookmarkEvent(scope, {
      eventId: 'evt-rename', dedupeKey: 'd-rename', occurredAt: '2026-07-27T05:01:00Z', kind: 'change',
      nativeId: 'native-after', details: { title: 'Renamed after scan' },
    });
    await store.stageBookmarkEvent(scope, {
      eventId: 'evt-delete', dedupeKey: 'd-delete', occurredAt: '2026-07-27T05:02:00Z', kind: 'remove',
      nativeId: 'native-gone', details: { title: 'Gone' },
    });
    const view = await coordinator.confirm({
      confirmationId: 'conf-inbox', treeDigest: 'sha256:tree', confirmationVersion: '1',
      localFacts: [{ nativeId: 'native-gone', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'bookmark',
        title: 'Gone', url: 'https://example.com/gone' }],
      remoteFacts: [
        { nodeId: 'folder-root', parentId: null, kind: 'folder', title: '', folderRole: 'root', revision: 'r0' },
        { nodeId: 'mount-bar', parentId: 'folder-root', kind: 'folder', title: 'Bar', folderRole: 'bookmarks-bar',
          revision: 'r1' },
      ],
      mounts: [{ nativeRootId: 'bar', rootRole: 'bookmarks-bar', remoteMountNodeId: 'mount-bar' }],
      rootNodeId: 'folder-root',
    });
    const creates = view.report?.planned.filter((op) => op.type === 'create_node' && op.reason === 'local-only') ?? [];
    assert.equal(creates.filter((op) => op.nativeId === 'native-gone').length, 0);
    assert.equal(creates.filter((op) => op.nativeId === 'native-after').length, 1);
    assert.equal(creates.find((op) => op.nativeId === 'native-after')?.node?.title, 'Renamed after scan');
    const queued = await store.listQueue(scope);
    assertOpaquePlanned(view.report?.planned);
    assert.equal(queued.filter((row) => row.opId.includes('native-after')).length, 1);
    assert.equal(queued.filter((row) => row.opId.includes('native-gone')).length, 0);
    assert.deepEqual(create.expectedOperationKinds, ['create_node']);
    assert.deepEqual(rename.expectedOperationKinds, ['update_node_content']);
    assert.deepEqual(remove.expectedOperationKinds, ['delete_node']);
  });

  test('post-Snapshot remote create is observed from recovery_nodes and never locally double-created', async () => {
    const { store, coordinator } = await setup();
    const fixture = fixtures.find((row) => row.scenario === 'remote-create-after-snapshot')!;
    await store.stageRecoveryPage(scope, {
      snapshotId: 'snap-1', revision: 'r2', syncCursor: 'spc2.snap-1', identityDigest: 'identity-1',
      rootNodeId: 'folder-root', page: 0, pageDigest: 'sha256:p0', previousPageDigest: null, nextCursor: null,
      complete: true,
      nodes: [
        recoveryNode('folder-root', null, 'Folder', { title: '', folderRole: 'root' }),
        recoveryNode('mount-bar', 'folder-root', 'Folder', { title: 'Bar', folderRole: 'bookmarks-bar' },
          'bookmarks-bar'),
        recoveryNode('bookmark-from-snapshot', 'mount-bar', 'Bookmark',
          { title: 'From snapshot', url: 'https://example.com/from-snapshot' }),
      ],
    });
    const view = await coordinator.confirm({
      confirmationId: 'conf-snap', treeDigest: 'sha256:tree', confirmationVersion: '1',
      localFacts: [], mounts: [{ nativeRootId: 'bar', rootRole: 'bookmarks-bar', remoteMountNodeId: 'mount-bar' }],
      rootNodeId: 'folder-root',
    });
    assert.ok(view.report?.remoteOnly.includes('bookmark-from-snapshot'));
    assert.equal(view.report?.planned.filter((op) => op.nativeId && op.type === 'create_node'
      && op.node?.url === 'https://example.com/from-snapshot').length, 0);
    assert.equal(fixture.expectedOperationKinds?.[0], 'create_node');
    assert.equal(view.run.snapshotCursor, 'spc2.snap-1');
    await store.stageRecoveryPage(scope, {
      snapshotId: 'snap-2', revision: 'r3', syncCursor: 'spc2.snap-2', identityDigest: 'identity-2',
      rootNodeId: 'folder-root', page: 0, pageDigest: 'sha256:p1', previousPageDigest: null, nextCursor: null,
      complete: true,
      nodes: [
        recoveryNode('folder-root', null, 'Folder', { title: '', folderRole: 'root' }),
        recoveryNode('mount-bar', 'folder-root', 'Folder', { title: 'Bar', folderRole: 'bookmarks-bar' },
          'bookmarks-bar'),
        recoveryNode('bookmark-from-snapshot', 'mount-bar', 'Bookmark',
          { title: 'From snapshot', url: 'https://example.com/from-snapshot' }),
      ],
    });
    const again = await coordinator.confirm({
      confirmationId: 'conf-snap', treeDigest: 'sha256:tree', confirmationVersion: '1',
      localFacts: [], mounts: [{ nativeRootId: 'bar', rootRole: 'bookmarks-bar', remoteMountNodeId: 'mount-bar' }],
      rootNodeId: 'folder-root',
    });
    assert.equal(again.run.snapshotCursor, 'spc2.snap-1');
  });

  test('conflicts stay isolated so unrelated local-only bookmarks still enqueue', () => {
    const report = matchLocalRemote({
      scopeKey: 's', confirmationId: 'c',
      local: [
        { nativeId: 'native-conflict', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'bookmark',
          title: 'Laptop title', url: 'https://example.com/shared' },
        { nativeId: 'native-ok', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'bookmark',
          title: 'Only local', url: 'https://example.com/local-only' },
      ],
      remote: [
        { nodeId: 'mount-bar', parentId: 'folder-root', kind: 'folder', title: 'Bar', folderRole: 'bookmarks-bar',
          revision: 'r1' },
        { nodeId: 'bookmark-shared', parentId: 'mount-bar', kind: 'bookmark', title: 'Server title',
          url: 'https://example.com/shared', revision: 'r2' },
      ],
      mappings: [{ nativeId: 'native-conflict', colpId: 'bookmark-shared' }],
      mounts: [{ nativeRootId: 'bar', rootRole: 'bookmarks-bar', remoteMountNodeId: 'mount-bar' }],
      rootNodeId: 'folder-root', bootstrapMode: 'merge',
    });
    assert.ok(report.conflicts.some((row) => row.kind === 'title' && row.remoteNodeId === 'bookmark-shared'));
    assert.ok(report.planned.some((op) => op.nativeId === 'native-ok' && op.type === 'create_node'));
    assert.equal(report.planned.filter((op) => op.nativeId === 'native-conflict').length, 0);
    assertOpaquePlanned(report.planned);
  });

  test('planned opIds are COLP opaqueIds, deterministic, and survive hostile native keys', () => {
    const confirmationId = '019b3de2-7f76-7b8b-8ffc-941d6e6318de';
    const input = {
      scopeKey: 'scope-1', confirmationId,
      local: [{ nativeId: 'folder:1/weird', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'folder' as const,
        title: 'Weird' }],
      remote: [{ nodeId: 'folder-root', parentId: null, kind: 'folder' as const, title: '', folderRole: 'root',
        revision: 'r0' }],
      mappings: [] as MappingFact[],
      mounts: [{ nativeRootId: 'bar', rootRole: 'bookmarks-bar' as const, remoteMountNodeId: null }],
      rootNodeId: 'folder-root', bootstrapMode: 'merge' as const,
    };
    const report = matchLocalRemote(input);
    assert.ok(report.planned.some((op) => op.reason === 'mount-resolve'));
    assert.ok(report.planned.some((op) => op.nativeId === 'folder:1/weird'));
    assertOpaquePlanned(report.planned);
    assert.deepEqual(matchLocalRemote(input).planned.map((op) => op.opId), report.planned.map((op) => op.opId));
    const other = matchLocalRemote({ ...input, local: [{ ...input.local[0]!, nativeId: 'folder:2/weird' }] });
    assert.notEqual(other.planned.find((op) => op.nativeId === 'folder:2/weird')?.opId,
      report.planned.find((op) => op.nativeId === 'folder:1/weird')?.opId);
    assert.equal(other.planned.find((op) => op.reason === 'mount-resolve')?.opId,
      report.planned.find((op) => op.reason === 'mount-resolve')?.opId);
    const longNativeId = `native-${'x'.repeat(200)}`;
    const longReport = matchLocalRemote({ ...input, local: [{ ...input.local[0]!, nativeId: longNativeId }] });
    assertOpaquePlanned(longReport.planned);
    assert.notEqual(longReport.planned.find((op) => op.nativeId === longNativeId)?.opId,
      report.planned.find((op) => op.nativeId === 'folder:1/weird')?.opId);
    const destructive = matchLocalRemote({ ...input, bootstrapMode: 'download', destructiveConfirmed: true });
    assert.ok(destructive.destructivePlan?.deletes.some((item) => item.side === 'local'
      && item.nativeId === 'folder:1/weird'));
    assert.deepEqual(destructive.planned, []);
    assertOpaquePlanned(destructive.planned);
  });
});

async function setup() {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'revision-0', cursor: 'cursor-0' }, selectedRoots: [],
  });
  return { store, coordinator: createBootstrapCoordinator({ store, scope, now: () => 10, randomUUID: () => 'run-1' }) };
}

function recoveryNode(colpId: string, parentId: string | null, kind: 'Folder' | 'Bookmark',
  content: { title: string; url?: string; folderRole?: string }, rootRole?: 'bookmarks-bar') {
  return {
    colpId, parentId, position: colpId, kind, payloadDigest: `sha256:${colpId}`,
    mapping: {
      nativeId: `recovery:${colpId}`, colpId, rootNativeId: 'recovery:root',
      nodeKind: kind === 'Bookmark' ? 'bookmark' as const : 'folder' as const,
      ...(parentId ? { parentColpId: parentId } : {}),
      ...(rootRole ? { rootRole } : {}),
      projection: { revision: 'r2', digest: `sha256:${colpId}`, content },
    },
  };
}

const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

function assertOpaquePlanned(planned: readonly { readonly opId: string }[] | undefined) {
  assert.ok(planned);
  for (const op of planned) {
    assert.match(op.opId, OPAQUE_ID);
    assert.doesNotMatch(op.opId, /:/);
  }
}
