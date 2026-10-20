import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { activateAdvancedPlan, projectAdvancedSnapshot } from '../src/bootstrap/advanced-run.js';
import { buildAdvancedPlan } from '../src/bootstrap/advanced-plan.js';
import type { LocalNodeFact, MountFact, RemoteNodeFact } from '../src/bootstrap/matcher.js';
import { createSyncStateStore, type JsonObject, type MappingInput, type RecoveryPageInput,
  type SyncScope } from '../src/sync-state-store.js';
import { scope } from './kns-03-bootstrap-harness.js';

const mounts: readonly MountFact[] = [
  { nativeRootId: 'bar', rootRole: 'bookmarks-bar', remoteMountNodeId: 'remote-bar' },
];
const remote: readonly RemoteNodeFact[] = [
  { nodeId: 'root', parentId: null, kind: 'folder', title: '', folderRole: 'root',
    revision: 'remote-root-r1', childrenRevision: 'remote-root-c1' },
  { nodeId: 'remote-bar', parentId: 'root', kind: 'folder', title: 'Bar', folderRole: 'bookmarks-bar',
    revision: 'remote-bar-r1', childrenRevision: 'remote-bar-c1', position: 'a' },
  { nodeId: 'remote-matched', parentId: 'remote-bar', kind: 'bookmark', title: 'Matched',
    url: 'https://matched.example/', revision: 'remote-matched-r1', position: 'a' },
  { nodeId: 'remote-only', parentId: 'remote-bar', kind: 'bookmark', title: 'Remote only',
    url: 'https://remote-only.example/', revision: 'remote-only-r1', position: 'b' },
];
const local: readonly LocalNodeFact[] = [
  { nativeId: 'bar', mountNativeRootId: 'bar', parentNativeId: '0', kind: 'folder', title: 'Bar' },
  { nativeId: 'local-matched', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'bookmark',
    title: 'Matched', url: 'https://matched.example/' },
];

const metadataValues = {
  mode: 'download' as const,
  mounts,
  confirmationId: 'advanced-confirmation',
  treeDigest: 'advanced-tree',
  boundaryVersion: '1',
  remoteSnapshotId: 'snapshot-1',
  remoteRevision: 'revision-1',
  remoteCursor: 'cursor-1',
};

type Store = ReturnType<typeof createSyncStateStore>;

async function registerActive(store: Store, targetScope: SyncScope = scope): Promise<void> {
  await store.registerScope({
    ...targetScope,
    lifecycle: 'active',
    lease: { leaseId: 'advanced-test-lease', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'base-revision', cursor: 'base-cursor' },
    selectedRoots: [], boundaryVersion: metadataValues.boundaryVersion,
  });
}

async function fixture() {
  const indexedDB = new IDBFactory();
  const store = createSyncStateStore({ indexedDB });
  await registerActive(store);
  const plan = buildAdvancedPlan({
    scope,
    planId: 'advanced-snapshot-gates',
    confirmationId: metadataValues.confirmationId,
    mode: metadataValues.mode,
    boundaryVersion: metadataValues.boundaryVersion,
    treeDigest: metadataValues.treeDigest,
    remoteSnapshotId: metadataValues.remoteSnapshotId,
    remoteRevision: metadataValues.remoteRevision,
    remoteCursor: metadataValues.remoteCursor,
    local,
    remote,
    mappings: [],
    mounts,
    rootNodeId: 'root',
  });
  assert.ok(plan.matched.some((pair) => pair.nativeId === 'local-matched' && pair.nodeId === 'remote-matched'));
  const definitions = JSON.parse(JSON.stringify([
    ...remote.map((fact) => ({ kind: 'snapshot-fact', fact,
      nativeId: plan.matched.find((pair) => pair.nodeId === fact.nodeId)?.nativeId ?? null })),
    ...plan.steps,
  ])) as JsonObject[];
  const committed = await store.commitAdvancedPlan(scope, {
    planId: plan.planId,
    metadata: JSON.parse(JSON.stringify(metadataValues)) as JsonObject,
    steps: definitions,
    now: 10,
  });
  return { indexedDB, store, plan, committed };
}

function stagedMappings(): MappingInput[] {
  return remote.map((fact) => ({
    // These IDs intentionally come from the staged page and are not proof of
    // a native identity. projectAdvancedSnapshot must replace them from the
    // immutable plan or with an unmounted placeholder.
    nativeId: `staged:${fact.nodeId}`,
    colpId: fact.nodeId,
    rootNativeId: 'staged-root',
    nodeKind: fact.kind,
    ...(fact.parentId ? { parentColpId: fact.parentId } : {}),
    projection: {
      revision: fact.revision,
      digest: `staged-digest:${fact.nodeId}`,
      ...(fact.childrenRevision ? { childrenRevision: fact.childrenRevision } : {}),
      content: {
        title: fact.title,
        ...(fact.url ? { url: fact.url } : {}),
        ...(fact.folderRole ? { folderRole: fact.folderRole } : {}),
      },
    },
  }));
}

function recoveryPage(overrides: Partial<RecoveryPageInput> = {}): RecoveryPageInput {
  return {
    snapshotId: metadataValues.remoteSnapshotId,
    sessionId: 'recovery-session-1',
    revision: metadataValues.remoteRevision,
    syncCursor: metadataValues.remoteCursor,
    identityDigest: 'recovery-identity-1',
    rootNodeId: 'root',
    page: 0,
    pageDigest: 'recovery-page-1',
    previousPageDigest: null,
    nextCursor: null,
    complete: true,
    nodes: [{
      colpId: 'root',
      parentId: null,
      position: 'a',
      kind: 'Folder',
      payloadDigest: 'recovery-root-payload',
      mapping: {
        nativeId: 'recovery-root',
        colpId: 'root',
        rootNativeId: 'recovery-root',
        nodeKind: 'folder',
        projection: { revision: metadataValues.remoteRevision, digest: 'recovery-root-payload',
          content: { title: '', folderRole: 'root' } },
      },
    }],
    ...overrides,
  };
}

async function stageRecovery(store: Store, overrides: Partial<RecoveryPageInput> = {}): Promise<void> {
  await store.stageRecoveryPage(scope, recoveryPage(overrides));
}

function scopeExportPart(exported: Awaited<ReturnType<Store['exportScope']>>) {
  return {
    mappings: exported.mappings,
    queue: exported.queue,
    mountBindings: exported.mountBindings,
    bootstrapRuns: exported.bootstrapRuns,
  };
}

test('restarts after atomic plan commit and activate restores mounts, run, and firstRun', async () => {
  const { indexedDB, store } = await fixture();
  assert.deepEqual(await store.listMountBindings(scope), []);
  assert.deepEqual(await store.listBootstrapRuns(scope), []);
  assert.equal((await store.getScope(scope))?.firstRun, 'none');

  store.close();
  const restarted = createSyncStateStore({ indexedDB });
  await registerActive(restarted);
  const durablePlan = (await restarted.listAdvancedPlans(scope))[0];
  assert.ok(durablePlan);
  await activateAdvancedPlan(restarted, scope, durablePlan);

  const bindings = await restarted.listMountBindings(scope);
  assert.equal(bindings.length, 1);
  const { scopeKey: _mountScopeKey, ...binding } = bindings[0]!;
  assert.deepEqual(binding, {
    mountId: 'mount:bar',
    nativeRootId: 'bar',
    remoteMountNodeId: 'remote-bar',
    boundaryVersion: '1',
    materialized: false,
    status: 'active',
    rootRole: 'bookmarks-bar',
  });
  const runs = await restarted.listBootstrapRuns(scope);
  assert.equal(runs.length, 1);
  const { scopeKey: _runScopeKey, updatedAt, ...run } = runs[0]!;
  assert.deepEqual(run, {
    runId: durablePlan.planId,
    confirmationId: metadataValues.confirmationId,
    phase: 'syncing',
    bootstrapMode: 'download',
    destructiveConfirmed: true,
    reportDigest: durablePlan.digest,
    treeDigest: metadataValues.treeDigest,
    libraryId: scope.collectionId,
    confirmationVersion: metadataValues.boundaryVersion,
    snapshotCursor: metadataValues.remoteCursor,
  });
  assert.equal(typeof updatedAt, 'number');
  assert.equal((await restarted.getScope(scope))?.firstRun, 'running');
});

test('detached mount cannot be reactivated after the plan was already activated', async () => {
  const { store, committed } = await fixture();
  await activateAdvancedPlan(store, scope, committed);
  await store.detachMount(scope, 'mount:bar');
  const before = scopeExportPart(await store.exportScope(scope));

  await activateAdvancedPlan(store, scope, committed);

  const after = scopeExportPart(await store.exportScope(scope));
  assert.deepEqual(after.mappings, before.mappings);
  assert.deepEqual(after.queue, before.queue);
  assert.deepEqual(after.bootstrapRuns, before.bootstrapRuns);
  assert.equal(after.mountBindings[0]?.status, 'detached');
  const loaded = await store.readAdvancedPlan(scope, committed.planId);
  assert.equal(loaded?.plan.state, 'attention');
  assert.ok(loaded);
  const attention = loaded.steps.find((step) => step.state === 'attention');
  assert.ok(attention);
  assert.equal(attention.error, 'advanced_boundary_changed');
});

test('changed boundaryVersion cannot reactivate the already activated plan', async () => {
  const { store, committed } = await fixture();
  await activateAdvancedPlan(store, scope, committed);
  await store.bumpBoundaryVersion(scope);
  assert.equal((await store.getScope(scope))?.boundaryVersion, '2');
  const before = scopeExportPart(await store.exportScope(scope));

  await activateAdvancedPlan(store, scope, committed);

  const after = scopeExportPart(await store.exportScope(scope));
  assert.deepEqual(after.mappings, before.mappings);
  assert.deepEqual(after.queue, before.queue);
  assert.deepEqual(after.bootstrapRuns, before.bootstrapRuns);
  assert.equal(after.mountBindings[0]?.status, 'active');
  const loaded = await store.readAdvancedPlan(scope, committed.planId);
  assert.equal(loaded?.plan.state, 'attention');
  assert.ok(loaded);
  const attention = loaded.steps.find((step) => step.state === 'attention');
  assert.ok(attention);
  assert.equal(attention.error, 'advanced_boundary_changed');
});

test.each([
  ['snapshotId', { snapshotId: 'stale-snapshot' }],
  ['revision', { revision: 'stale-revision' }],
  ['cursor', { syncCursor: 'stale-cursor' }],
] as const)('rejects a recovery header with a mismatched %s before any projection write', async (_field, mismatch) => {
  const { store, committed } = await fixture();
  await activateAdvancedPlan(store, scope, committed);
  await stageRecovery(store, mismatch);
  const before = scopeExportPart(await store.exportScope(scope));

  await assert.rejects(
    () => projectAdvancedSnapshot(store, scope, stagedMappings()),
    (error: unknown) => error instanceof Error && error.message === 'advanced_snapshot_changed',
  );

  const after = scopeExportPart(await store.exportScope(scope));
  assert.deepEqual(after.mappings, before.mappings);
  assert.deepEqual(after.queue, before.queue);
  assert.deepEqual(after.mountBindings, before.mountBindings);
  assert.deepEqual(after.bootstrapRuns, before.bootstrapRuns);
  const loaded = await store.readAdvancedPlan(scope, committed.planId);
  assert.equal(loaded?.plan.state, 'attention');
  assert.ok(loaded);
  const attention = loaded.steps.find((step) => step.state === 'attention');
  assert.ok(attention);
  assert.equal(attention.error, 'advanced_snapshot_changed');
});

test('projection reuses only proven native IDs, uses unmounted remote-only IDs, and keeps mount roots in scope', async () => {
  const { store, committed } = await fixture();
  const foreignScope: SyncScope = { ...scope, collectionId: 'foreign-collection', replicaId: 'foreign-replica' };
  await registerActive(store, foreignScope);
  await store.putMountBinding(foreignScope, {
    mountId: 'foreign-mount', nativeRootId: 'foreign-bar', remoteMountNodeId: 'remote-bar',
    boundaryVersion: '1', materialized: true, status: 'active', rootRole: 'bookmarks-bar',
  });
  await store.putMapping(foreignScope, {
    nativeId: 'foreign-bar', colpId: 'remote-bar', rootNativeId: 'foreign-bar',
    nodeKind: 'folder', mountId: 'foreign-mount', rootRole: 'bookmarks-bar',
    projection: { revision: 'foreign-revision', digest: 'foreign-digest', content: { title: 'Foreign Bar' } },
  });
  await activateAdvancedPlan(store, scope, committed);
  await stageRecovery(store);

  const projection = await projectAdvancedSnapshot(store, scope, stagedMappings());
  assert.ok(projection);
  const row = (colpId: string) => projection.find((mapping) => mapping.colpId === colpId);
  assert.equal(row('remote-bar')?.nativeId, 'bar');
  assert.equal(row('remote-bar')?.rootNativeId, 'bar');
  assert.equal(row('remote-bar')?.mountId, 'mount:bar');
  assert.equal(row('remote-matched')?.nativeId, 'local-matched');
  assert.equal(row('remote-matched')?.rootNativeId, 'bar');
  assert.equal(row('remote-matched')?.parentNativeId, 'bar');
  assert.equal(row('remote-only')?.nativeId, 'unmounted:remote-only');
  assert.equal(row('remote-only')?.rootNativeId, 'unmounted:remote-only');
  assert.equal(row('root')?.nativeId, 'unmounted:root');
  assert.equal((await store.getMappingByColpId(foreignScope, 'remote-bar'))?.nativeId, 'foreign-bar');
  assert.equal((await store.getMappingByColpId(scope, 'remote-bar')), null);
});

test('matching recovery header permits snapshot projection and materializes the planned mount binding', async () => {
  const { store, committed } = await fixture();
  await activateAdvancedPlan(store, scope, committed);
  await stageRecovery(store);
  const before = await store.exportScope(scope);

  const projection = await projectAdvancedSnapshot(store, scope, stagedMappings());

  assert.ok(projection);
  assert.equal(projection.length, remote.length);
  assert.equal(projection.find((mapping) => mapping.colpId === 'remote-bar')?.nativeId, 'bar');
  assert.equal(projection.find((mapping) => mapping.colpId === 'remote-matched')?.nativeId, 'local-matched');
  assert.equal(projection.find((mapping) => mapping.colpId === 'remote-only')?.nativeId, 'unmounted:remote-only');
  assert.deepEqual((await store.exportScope(scope)).queue, before.queue);
  assert.deepEqual((await store.exportScope(scope)).mappings, before.mappings);
  assert.equal((await store.getMountBinding(scope, 'mount:bar'))?.materialized, true);
  assert.equal((await store.readAdvancedPlan(scope, committed.planId))?.plan.state, 'active');
});
