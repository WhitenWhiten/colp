import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { endpoints } from './outbound-push-worker-harness.js';
/**
 * Owner: KNS-08 (QA). Formal id: FR-F4-CUSTOM-ONLY.
 * Run: npx vitest run tests/kns-03-custom-mount.test.ts
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { createBootstrapCoordinator } from '../src/bootstrap/coordinator.js';
import { bootstrapOpId, matchLocalRemote, type LocalNodeFact, type MountFact } from '../src/bootstrap/matcher.js';
import { scanBoundary } from '../src/bookmark-boundary.js';
import type { NormalizedBookmarkRoot } from '../src/chrome-bookmark-tree.js';
import { boundNativeId, planCreated } from '../src/pull-mount-apply.js';
import type { MappingInput, MountBindingRecord } from '../src/sync-state-store.js';
import {
  assertOpaquePlanned, assertOpaqueQueued, assertStampedColp, barMount, baseConfirm,
  completeQueuedCreate, customMount, installKns03IndexedDb, root, scope, setup,
} from './kns-03-bootstrap-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

installKns03IndexedDb();

// True custom roots have no browser ancestor to preserve. Ordinary subtree coverage is tested in range-topology-convergence.
const research: LocalNodeFact = {
  nativeId: 'custom-folder', mountNativeRootId: 'custom-folder', parentNativeId: null,
  kind: 'folder', title: 'Research',
};
const researchChild: LocalNodeFact = {
  nativeId: 'custom-child', mountNativeRootId: 'custom-folder', parentNativeId: 'custom-folder',
  kind: 'bookmark', title: 'Research bookmark', url: 'https://example.test/research',
};
const auditMount: MountFact = {
  nativeRootId: 'custom-folder', customSourceKey: 'custom-folder-key', remoteMountNodeId: null,
};

function folder(nativeId: string, title: string, children: NormalizedBookmarkRoot['children'] = [],
  extra: Partial<NormalizedBookmarkRoot> = {}): NormalizedBookmarkRoot {
  return { nativeId, title, kind: 'folder', managed: false, children, rootKind: 'browser_root', ...extra };
}
function customConfirm(overrides: Partial<Parameters<ReturnType<typeof createBootstrapCoordinator>['confirm']>[0]> = {}) {
  return baseConfirm({
    confirmationId: 'conf-custom', mounts: [auditMount], localFacts: [research, researchChild],
    remoteFacts: [root], rootNodeId: 'folder-root', ...overrides,
  });
}
function createPayload(row: { readonly payload: { readonly payload?: unknown } }) {
  const inner = row.payload.payload;
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) {
    return { parentId: undefined as string | undefined, node: undefined as
      { title?: string; folderRole?: string; url?: string; kind?: string } | undefined };
  }
  const record = inner as { parentId?: string; node?: { title?: string; folderRole?: string; url?: string; kind?: string } };
  return { parentId: record.parentId, node: record.node };
}

describe('FR-F4-CUSTOM-ONLY boundary', () => {
  test('selecting only an ordinary empty folder plans a custom mount at that native root', () => {
    const empty = folder('research', 'Research');
    const scan = scanBoundary({
      roots: [folder('bar', 'Bookmarks bar', [empty], { rootKind: 'bookmarks_bar' })],
      selectedNativeIds: ['research'],
    });
    assert.deepEqual(scan.selectedNativeIds, ['research']);
    assert.equal(scan.mounts.length, 1);
    assert.equal(scan.mounts[0]?.nativeRootId, 'research');
    assert.equal(scan.mounts[0]?.rootRole, undefined);
    assert.equal(scan.mounts[0]?.customSourceKey, 'folder:research');
    assert.equal(scan.folderCount, 1);
    assert.equal(scan.bookmarkCount, 0);
  });

  test('two same-titled ordinary folders keep distinct customSourceKeys', () => {
    const scan = scanBoundary({
      roots: [folder('other', 'Other bookmarks', [
        folder('a', 'Research'), folder('b', 'Research'),
      ], { rootKind: 'other' })],
      selectedNativeIds: ['a', 'b'],
    });
    assert.equal(scan.mounts.length, 2);
    assert.deepEqual(scan.mounts.map((mount) => mount.customSourceKey).sort(), ['folder:a', 'folder:b']);
    assert.ok(scan.mounts.every((mount) => mount.rootRole === undefined));
  });

  test('parent plus nested child selection collapses to one custom mount', () => {
    const scan = scanBoundary({
      roots: [folder('bar', 'Bookmarks bar', [
        folder('research', 'Research', [folder('papers', 'Papers')]),
      ], { rootKind: 'bookmarks_bar' })],
      selectedNativeIds: ['research', 'papers'],
    });
    assert.deepEqual(scan.selectedNativeIds, ['research']);
    assert.equal(scan.nestedNormalized, true);
    assert.equal(scan.mounts.length, 1);
    assert.equal(scan.mounts[0]?.nativeRootId, 'research');
    assert.equal(scan.mounts[0]?.customSourceKey, 'folder:research');
  });
});

describe('FR-F4-CUSTOM-ONLY matcher', () => {
  test('empty remote custom-only plans mount-resolve with the local folder title', () => {
    const report = matchLocalRemote({
      scopeKey: 'scope-1', confirmationId: 'audit-custom', local: [research, researchChild], remote: [root],
      mappings: [], mounts: [auditMount], rootNodeId: 'collection-root', bootstrapMode: 'merge',
    });
    const mountOp = report.planned.find((op) => op.reason === 'mount-resolve');
    assert.equal(mountOp?.type, 'create_node');
    assert.equal(mountOp?.parentId, 'collection-root');
    assert.equal(mountOp?.nativeId, 'custom-folder');
    assert.equal(mountOp?.node?.title, 'Research');
    assert.equal(mountOp?.node?.folderRole, 'custom');
    assert.equal(mountOp?.opId, bootstrapOpId('audit-custom', 'mount', 'custom-folder-key'));
    assert.equal(report.planned.some((op) => op.nativeId === 'custom-folder' && op.reason === 'local-only'), false);
    const child = report.planned.find((op) => op.nativeId === 'custom-child');
    assert.equal(child?.reason, 'local-only');
    assert.notEqual(child?.parentId, 'collection-root');
    assert.equal(child?.parentId?.startsWith('mount:') ?? true, true);
    assertOpaquePlanned(report.planned);
  });

  test('two same-titled custom folders are not collapsed', () => {
    const left: LocalNodeFact = { nativeId: 'a', mountNativeRootId: 'a', parentNativeId: null,
      kind: 'folder', title: 'Research' };
    const right: LocalNodeFact = { nativeId: 'b', mountNativeRootId: 'b', parentNativeId: null,
      kind: 'folder', title: 'Research' };
    const report = matchLocalRemote({
      scopeKey: 'scope-1', confirmationId: 'conf-dup', local: [left, right], remote: [root], mappings: [],
      mounts: [customMount('a', 'folder:a'), customMount('b', 'folder:b')],
      rootNodeId: 'folder-root', bootstrapMode: 'merge',
    });
    const planned = report.planned.filter((op) => op.reason === 'mount-resolve');
    assert.equal(planned.length, 2);
    assert.deepEqual(planned.map((op) => op.nativeId).sort(), ['a', 'b']);
    assert.ok(planned.every((op) => op.node?.title === 'Research' && op.node?.folderRole === 'custom'));
    assert.notEqual(planned[0]?.opId, planned[1]?.opId);
  });

  test('special uniqueness does not swallow a custom mount', () => {
    const report = matchLocalRemote({
      scopeKey: 'scope-1', confirmationId: 'conf-mix', local: [research], remote: [root, {
        nodeId: 'mount-bar', parentId: 'folder-root', kind: 'folder', title: 'Bar',
        folderRole: 'bookmarks-bar', revision: 'r1',
      }], mappings: [], mounts: [barMount(), auditMount], rootNodeId: 'folder-root', bootstrapMode: 'merge',
    });
    assert.equal(report.planned.filter((op) => op.reason === 'mount-resolve' && op.node?.folderRole === 'bookmarks-bar')
      .length, 0);
    const custom = report.planned.find((op) => op.reason === 'mount-resolve' && op.nativeId === 'custom-folder');
    assert.equal(custom?.node?.title, 'Research');
    assert.equal(custom?.node?.folderRole, 'custom');
  });
});

describe('FR-F4-CUSTOM-ONLY coordinator', () => {
  test('an independent custom browser root enqueues create_node at the Collection root', async () => {
    const { store, coordinator } = await setup();
    await coordinator.confirm({
      confirmationId: 'audit-custom', confirmationVersion: '1', treeDigest: 'sha256:audit',
      mounts: [auditMount], localFacts: [research, researchChild], rootNodeId: 'collection-root',
      remoteFacts: [{ nodeId: 'collection-root', parentId: null, kind: 'folder', title: '',
        folderRole: 'root', revision: 'root-r1' }],
    });
    const queued = await store.listQueue(scope);
    assert.equal(queued.some((row) => row.payload.type === 'create_node'), true);
    const mountOp = queued.find((row) => row.payload.type === 'create_node')!;
    const node = createPayload(mountOp).node;
    assert.equal(node?.title, 'Research');
    assert.equal(node?.folderRole, 'custom');
    assert.equal(createPayload(mountOp).parentId, 'collection-root');
    assert.equal((await store.getScope(scope))?.firstRun, 'running');
    assert.notEqual((await store.listBootstrapRuns(scope))[0]?.phase, 'completed');
  });

  test('empty custom folder stays syncing until receipt binds the existing native root', async () => {
    const { store, coordinator } = await setup();
    const input = customConfirm({ localFacts: [research] });
    const view = await coordinator.confirm(input);
    assert.notEqual(view.run.phase, 'completed');
    assert.equal((await store.getScope(scope))?.firstRun, 'running');
    const queued = await store.listQueue(scope);
    assert.equal(queued.length, 1);
    assert.equal(createPayload(queued[0]!).node?.title, 'Research');
    await completeQueuedCreate(store, queued[0]!, 'mount-custom');
    const resumed = await coordinator.resume(input);
    assert.ok(resumed);
    const bound = (await store.listMountBindings(scope))[0]!;
    assert.equal(bound.nativeRootId, 'custom-folder');
    assert.equal(bound.remoteMountNodeId, 'mount-custom');
    assert.equal(bound.status, 'active');
    assert.equal(bound.customSourceKey, 'custom-folder-key');
    assert.equal(resumed.run.phase, 'completed');
    assert.equal((await store.getScope(scope))?.firstRun, 'completed');
    assert.equal((await store.listQueue(scope)).filter((row) => row.opId.includes('.create.')).length, 0);
  });

  test('non-empty custom folder binds then parent-first enqueues the child', async () => {
    const { store, coordinator } = await setup();
    const input = customConfirm();
    const view = await coordinator.confirm(input);
    assert.notEqual(view.run.phase, 'completed');
    const mountOp = (await store.listQueue(scope))[0]!;
    assert.equal(createPayload(mountOp).node?.folderRole, 'custom');
    await completeQueuedCreate(store, mountOp, 'mount-custom');
    const resumed = await coordinator.resume(input);
    assert.ok(resumed);
    const queued = await store.listQueue(scope);
    assertOpaqueQueued(queued);
    assertStampedColp(queued);
    const child = queued.find((row) => row.opId.includes('.create.custom-child'))!;
    assert.equal(createPayload(child).parentId, 'mount-custom');
    assert.equal(createPayload(child).node?.url, 'https://example.test/research');
    assert.equal((await store.listMountBindings(scope))[0]?.nativeRootId, 'custom-folder');
    assert.equal(resumed.run.phase, 'syncing');
    await completeQueuedCreate(store, child, 'research-child-remote');
    assert.equal((await coordinator.resume(input))?.run.phase, 'completed');
  });

  test('deep custom children wait for the parent mapping', async () => {
    const { store, coordinator } = await setup();
    const papers: LocalNodeFact = { nativeId: 'papers', mountNativeRootId: 'custom-folder',
      parentNativeId: 'custom-folder', kind: 'folder', title: 'Papers' };
    const nested: LocalNodeFact = { nativeId: 'paper-1', mountNativeRootId: 'custom-folder',
      parentNativeId: 'papers', kind: 'bookmark', title: 'Paper', url: 'https://example.test/paper' };
    const input = customConfirm({ localFacts: [research, papers, nested] });
    await coordinator.confirm(input);
    await completeQueuedCreate(store, (await store.listQueue(scope))[0]!, 'mount-custom');
    const afterMount = await coordinator.resume(input);
    assert.ok(afterMount);
    const mid = await store.listQueue(scope);
    assert.equal(mid.some((row) => row.opId.includes('.create.papers')), true);
    assert.equal(mid.some((row) => row.opId.includes('.create.paper-1')), false);
    assert.notEqual(afterMount.run.phase, 'completed');
    await createOutboundPushWorker({ scope, store, endpoints: async () => endpoints, now: () => 1000, ownerId: () => 'papers',
      sessions: { get: async () => ({ credential: { accessToken: 'test' }, session: { sessionId: 'papers',
        expiresAt: '2099-01-01T00:00:00Z', scope: 'collection', snapshotRequired: false, credentialAuthorityDigest: 'a'.repeat(64),
        collection: { collectionId: scope.collectionId, serverCursor: 'c0', serverRevision: 'r0' },
        replicaLease: { leaseId: 'lease-1', generation: '1', state: 'active', expiresAt: '2099-01-01T00:00:00Z' } } }) },
      fetch: async (_url, init) => { const body = JSON.parse(String(init?.body)); const op = body.operations[0];
        return Response.json({ batchId: body.batchId, results: [{ opId: op.opId, sequence: op.sequence,
          status: 'applied', targetId: 'papers-colp', revision: 'rev-papers', cursor: 'c1', warnings: [] }], serverCursor: 'c1' }); },
    }).drain();
    const resumed = await coordinator.resume(input);
    assert.ok(resumed);
    const child = (await store.listQueue(scope)).find((row) => row.opId.includes('.create.paper-1'))!;
    assert.equal(createPayload(child).parentId, 'papers-colp');
    assert.equal(resumed.run.phase, 'syncing');
  });

  test('two custom receipts bind one-to-one without a wrapper native root', async () => {
    const { store, coordinator } = await setup();
    const left: LocalNodeFact = { nativeId: 'a', mountNativeRootId: 'a', parentNativeId: null,
      kind: 'folder', title: 'Research' };
    const right: LocalNodeFact = { nativeId: 'b', mountNativeRootId: 'b', parentNativeId: null,
      kind: 'folder', title: 'Research' };
    const input = customConfirm({
      confirmationId: 'conf-two', localFacts: [left, right],
      mounts: [customMount('a', 'folder:a'), customMount('b', 'folder:b')],
    });
    await coordinator.confirm(input);
    const queued = await store.listQueue(scope);
    assert.equal(queued.length, 2);
    const first = queued.find((row) => row.opId === bootstrapOpId('conf-two', 'mount', 'folder:a'))!;
    const second = queued.find((row) => row.opId === bootstrapOpId('conf-two', 'mount', 'folder:b'))!;
    await completeQueuedCreate(store, first, 'mount-a');
    await completeQueuedCreate(store, second, 'mount-b');
    await coordinator.resume(input);
    const bindings = await store.listMountBindings(scope);
    assert.equal(bindings.find((row) => row.nativeRootId === 'a')?.remoteMountNodeId, 'mount-a');
    assert.equal(bindings.find((row) => row.nativeRootId === 'b')?.remoteMountNodeId, 'mount-b');
    assert.ok(bindings.every((row) => row.status === 'active' && row.nativeRootId !== 'mount-a'
      && row.nativeRootId !== 'mount-b'));
    assert.equal((await store.listBootstrapRuns(scope))[0]?.phase, 'completed');
  });

  test('same confirmationId is idempotent for custom mount-resolve', async () => {
    const { store, coordinator } = await setup();
    const input = customConfirm({ localFacts: [research] });
    const first = await coordinator.confirm(input);
    const second = await coordinator.confirm(input);
    assert.equal(second.run.runId, first.run.runId);
    const queued = await store.listQueue(scope);
    assert.equal(queued.length, 1);
    assert.deepEqual((await store.listQueue(scope)).map((row) => row.opId), queued.map((row) => row.opId));
  });

  test('detach does not enqueue remote delete; rejoin reuses the bound identity', async () => {
    const { store, coordinator } = await setup();
    const input = customConfirm({ localFacts: [research] });
    await coordinator.confirm(input);
    await completeQueuedCreate(store, (await store.listQueue(scope))[0]!, 'mount-custom');
    await coordinator.resume(input);
    const before = await store.listQueue(scope);
    const mount = (await store.listMountBindings(scope))[0]!;
    const detached = await store.detachMount(scope, mount.mountId);
    assert.equal(detached.status, 'detached');
    assert.equal(detached.remoteMountNodeId, 'mount-custom');
    assert.equal((await store.listQueue(scope)).filter((row) => row.payload.type === 'delete_node').length, 0);
    const rejoined = await store.rejoinMount(scope, mount.mountId);
    assert.equal(rejoined.status, 'active');
    assert.equal(rejoined.remoteMountNodeId, 'mount-custom');
    assert.equal(rejoined.nativeRootId, 'custom-folder');
    const after = await coordinator.confirm(input);
    assert.equal(after.run.phase, 'completed');
    assert.deepEqual((await store.listQueue(scope)).map((row) => row.opId), before.map((row) => row.opId));
  });

  test('special plus custom mixed enqueue keeps both identities', async () => {
    const { store, coordinator } = await setup();
    await coordinator.confirm(customConfirm({
      mounts: [barMount(), auditMount], localFacts: [research],
    }));
    const queued = await store.listQueue(scope);
    assert.equal(queued.length, 2);
    const roles = queued.map((row) => createPayload(row).node?.folderRole).sort();
    assert.deepEqual(roles, ['bookmarks-bar', 'custom']);
    const custom = queued.find((row) => createPayload(row).node?.folderRole === 'custom')!;
    assert.equal(createPayload(custom).node?.title, 'Research');
    assert.notEqual((await store.listBootstrapRuns(scope))[0]?.phase, 'completed');
  });
});

describe('FR-F4-CUSTOM-ONLY pull bind identity', () => {
  test('boundNativeId matches custom mounts one-to-one', () => {
    const mounts: MountBindingRecord[] = [
      { scopeKey: 's', mountId: 'mount-a', nativeRootId: 'native-a', remoteMountNodeId: 'colp-a',
        boundaryVersion: '1', materialized: false, status: 'active', customSourceKey: 'folder:a' },
      { scopeKey: 's', mountId: 'mount-b', nativeRootId: 'native-b', remoteMountNodeId: 'colp-b',
        boundaryVersion: '1', materialized: false, status: 'active', customSourceKey: 'folder:b' },
    ];
    const mapping = (colpId: string, extras: Partial<MappingInput> = {}): MappingInput => ({
      nativeId: `recovery:${colpId}`, colpId, rootNativeId: 'recovery:root', nodeKind: 'folder',
      projection: { revision: 'r1', digest: `sha256:${colpId}`, content: { folderRole: 'custom', title: 'Research' } },
      ...extras,
    });
    assert.equal(boundNativeId(mapping('colp-b'), mounts), 'native-b');
    assert.equal(boundNativeId(mapping('colp-a'), mounts), 'native-a');
    // Membership and a replica-local key cannot override an active remote ID.
    assert.equal(boundNativeId(mapping('colp-orphan', { mountId: 'mount-b' }), mounts), 'recovery:colp-orphan');
    assert.equal(boundNativeId(mapping('colp-key', {
      projection: { revision: 'r1', digest: 'sha256:key',
        content: { folderRole: 'custom', customSourceKey: 'folder:a' } },
    }), mounts), 'recovery:colp-key');
    assert.equal(boundNativeId(mapping('colp-none'), mounts), 'recovery:colp-none');
  });

  for (const status of ['pending', 'active'] as const) {
    test(`a peer's same native-id key cannot claim a ${status} custom mount`, async () => {
      const { store } = await setup();
      await store.putMountBinding(scope, { mountId: 'mount-local', nativeRootId: '5',
        remoteMountNodeId: status === 'active' ? 'local-remote-root' : null,
        boundaryVersion: '1', materialized: false, status, customSourceKey: 'folder:5' });
      const event = pullFixtures.createEvent({ kind: 'Folder', sequence: 11,
        collectionId: scope.collectionId, parentId: 'folder-root', folderRole: 'custom' }) as
        Extract<Parameters<typeof planCreated>[2], { kind: 'operation'; operation: { type: 'create_node' } }>;
      const plan = await planCreated(store, scope, { ...event, operation: { ...event.operation,
        opId: bootstrapOpId('peer-confirmation', 'mount', 'folder:5'), replicaId: 'another-replica' } });
      assert.equal(plan.kind, 'skip_unmounted');
    });
  }

  test('an active custom mount accepts only its bound remote Node, even for a local opId', async () => {
    const { store } = await setup();
    const event = pullFixtures.createEvent({ kind: 'Folder', sequence: 11,
      collectionId: scope.collectionId, parentId: 'folder-root', folderRole: 'custom' }) as
      Extract<Parameters<typeof planCreated>[2], { kind: 'operation'; operation: { type: 'create_node' } }>;
    if (event.effect.kind !== 'node_created') throw new Error('create fixture required');
    const mount = { mountId: 'mount-local', nativeRootId: '5', remoteMountNodeId: 'local-remote-root',
      boundaryVersion: '1', materialized: false, status: 'active' as const, customSourceKey: 'folder:5' };
    await store.putMountBinding(scope, mount);
    const own = { ...event, operation: { ...event.operation,
      opId: bootstrapOpId('old-confirmation', 'mount', 'folder:5'), replicaId: scope.replicaId } };
    assert.equal((await planCreated(store, scope, own)).kind, 'skip_unmounted');
    await store.putMountBinding(scope, { ...mount, remoteMountNodeId: event.effect.node.id });
    assert.equal((await planCreated(store, scope, event)).kind, 'bind_mount');
  });

  test('planCreated binds the matching pending custom mount by opId', async () => {
    const { store } = await setup();
    await store.putMountBinding(scope, {
      mountId: 'mount-a', nativeRootId: 'a', remoteMountNodeId: null, boundaryVersion: '1',
      materialized: false, status: 'pending', customSourceKey: 'folder:a',
    });
    await store.putMountBinding(scope, {
      mountId: 'mount-b', nativeRootId: 'b', remoteMountNodeId: null, boundaryVersion: '1',
      materialized: false, status: 'pending', customSourceKey: 'folder:b',
    });
    const event = pullFixtures.createEvent({
      kind: 'Folder', sequence: 11, collectionId: scope.collectionId, parentId: 'folder-root',
      folderRole: 'custom',
    }) as Extract<Parameters<typeof planCreated>[2], { kind: 'operation'; operation: { type: 'create_node' } }>;
    const opId = bootstrapOpId('conf-two', 'mount', 'folder:b');
    const plan = await planCreated(store, scope, {
      ...event, operation: { ...event.operation, opId, replicaId: scope.replicaId },
    } as typeof event);
    assert.equal(plan.kind, 'bind_mount');
    if (plan.kind === 'bind_mount') assert.equal(plan.mount.nativeRootId, 'b');
  });
});
