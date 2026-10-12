/**
 * F002 (T-03 round 2): the advanced bootstrap plan and its remote executor must
 * choose the delete operation from the deleted node's own kind — the same rule
 * as `translateSyncBrowserDelete` and the browser-event path (F117).
 *
 * Before the fix `planUploadDeletes` hardcoded `delete_node` for every target,
 * including folders, and `advanced-remote-executor` copied that literal into the
 * outbound queue operation. A remote folder delete therefore reached the server
 * as a non-recursive delete, which is permanently refused (`invalid_document`,
 * 422) whenever the folder still has a child the local snapshot did not prove.
 *
 * Both cases below drive production entries: `buildAdvancedPlan(...)` for the
 * plan shape and `executeActiveAdvancedPlan(...)` (the first-run engine entry)
 * for the queued operations.
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, test } from 'vitest';
import { translateSyncBrowserDelete } from '@know-n/colp/sync';
import { buildAdvancedPlan, type AdvancedPlan, type AdvancedStep } from '../src/bootstrap/advanced-plan.js';
import { activateAdvancedPlan, executeActiveAdvancedPlan, projectAdvancedSnapshot } from '../src/bootstrap/advanced-run.js';
import type { AdvancedNativeApi } from '../src/bootstrap/advanced-local-executor.js';
import type { LocalNodeFact, MountFact, RemoteNodeFact } from '../src/bootstrap/matcher.js';
import { validateOperation } from '../src/bookmark-event-codec.js';
import { createSyncStateStore, type JsonObject, type MappingInput } from '../src/sync-state-store.js';
import { active, completeQueuedCreate, scope } from './kns-03-bootstrap-harness.js';

const root: RemoteNodeFact = {
  nodeId: 'r-root', parentId: null, kind: 'folder', title: 'Collection', folderRole: 'root',
  revision: 'r-root-1', childrenRevision: 'children-root-1',
};
const mount: RemoteNodeFact = {
  nodeId: 'r-bar', parentId: root.nodeId, kind: 'folder', title: 'Bookmarks bar',
  folderRole: 'bookmarks-bar', revision: 'r-bar-1', childrenRevision: 'children-bar-1',
};
const mountFact: MountFact = { nativeRootId: 'n-bar', rootRole: 'bookmarks-bar', remoteMountNodeId: mount.nodeId };

function remote(nodeId: string, parentId: string, title: string, url: string | undefined,
  kind: RemoteNodeFact['kind'], revision = `revision-${nodeId}`, childrenRevision?: string): RemoteNodeFact {
  return { nodeId, parentId, kind, title, revision, ...(url ? { url } : {}),
    ...(kind === 'folder' ? { childrenRevision: childrenRevision ?? `children-${nodeId}` } : {}) };
}

function planInput(overrides: Partial<Parameters<typeof buildAdvancedPlan>[0]> = {}): Parameters<typeof buildAdvancedPlan>[0] {
  return {
    confirmationId: 'confirm-kind', mode: 'upload', remoteSnapshotId: 'snapshot-kind',
    remoteRevision: 'collection-revision-1', remoteCursor: 'cursor-kind',
    scopeFingerprint: 'sha256:scope', treeDigest: 'sha256:tree', rootNodeId: root.nodeId,
    local: [], remote: [root, mount], mappings: [], mounts: [mountFact], ...overrides,
  };
}

function stepsOf<Side extends AdvancedStep['side'], Action extends AdvancedStep['action']>(
  plan: AdvancedPlan, side: Side, action: Action,
): Extract<AdvancedStep, { side: Side; action: Action }>[] {
  return plan.steps.filter((step) => step.side === side && step.action === action) as
    unknown as Extract<AdvancedStep, { side: Side; action: Action }>[];
}

function protocolType(nodeId: string, nodeKind: 'folder' | 'bookmark' | 'separator'): string {
  return translateSyncBrowserDelete({ nodeId, nodeKind }).type;
}

describe('advanced plan delete shape follows the remote node kind', () => {
  it('plans delete_subtree for a remote-only folder and delete_node for a remote-only bookmark', () => {
    const oldFolder = remote('r-old', mount.nodeId, 'Old container', undefined, 'folder', 'r-old-1', 'children-old-1');
    const oldChild = remote('r-old-child', oldFolder.nodeId, 'Old child', 'https://example.test/old-child',
      'bookmark', 'r-old-child-1');
    const oldBookmark = remote('r-bm-old', mount.nodeId, 'Old bookmark', 'https://example.test/old',
      'bookmark', 'r-bm-old-1');
    const plan = buildAdvancedPlan(planInput({ remote: [root, mount, oldFolder, oldChild, oldBookmark] }));
    const folderDelete = stepsOf(plan, 'remote', 'delete').find((step) => step.target.nodeId === oldFolder.nodeId);
    const childDelete = stepsOf(plan, 'remote', 'delete').find((step) => step.target.nodeId === oldChild.nodeId);
    const bookmarkDelete = stepsOf(plan, 'remote', 'delete').find((step) => step.target.nodeId === oldBookmark.nodeId);
    expect(folderDelete).toBeDefined();
    expect(childDelete).toBeDefined();
    expect(bookmarkDelete).toBeDefined();
    expect(folderDelete).toMatchObject({ operation: 'delete_subtree',
      payload: { type: 'delete_subtree', targetId: 'r-old', baseRevision: 'r-old-1' } });
    expect(childDelete).toMatchObject({ operation: 'delete_node', payload: { type: 'delete_node' } });
    expect(bookmarkDelete).toMatchObject({ operation: 'delete_node', payload: { type: 'delete_node' } });
    expect(folderDelete!.dependsOn).toContain(childDelete!.stepId);
    expect(folderDelete!.payload.type).toBe(protocolType('r-old', 'folder'));
    expect(bookmarkDelete!.payload.type).toBe(protocolType('r-bm-old', 'bookmark'));
    expect(plan.checklist.find((item) => item.stepId === folderDelete!.stepId))
      .toMatchObject({ kind: 'folder', action: 'delete', targetId: 'r-old' });
    expect(plan.checklist.find((item) => item.stepId === bookmarkDelete!.stepId))
      .toMatchObject({ kind: 'bookmark', action: 'delete', targetId: 'r-bm-old' });
  });
});

const execRemote: RemoteNodeFact[] = [
  { nodeId: 'root', parentId: null, kind: 'folder', title: '', folderRole: 'root', revision: 'r0', childrenRevision: 'c0' },
  { nodeId: 'remote-bar', parentId: 'root', kind: 'folder', title: 'Bar', folderRole: 'bookmarks-bar',
    revision: 'r1', childrenRevision: 'c1', position: 'a' },
  { nodeId: 'remote-old', parentId: 'remote-bar', kind: 'folder', title: 'Old container',
    revision: 'r-old', childrenRevision: 'c-old', position: 'a' },
  { nodeId: 'remote-bookmark-old', parentId: 'remote-bar', kind: 'bookmark', title: 'Old bookmark',
    url: 'https://old.example/', revision: 'r-bm-old', position: 'b' },
];
const execLocal: LocalNodeFact[] = [
  { nativeId: 'bar', mountNativeRootId: 'bar', parentNativeId: '0', kind: 'folder', title: 'Bar' },
];
const execMounts = [{ nativeRootId: 'bar', rootRole: 'bookmarks-bar' as const, remoteMountNodeId: 'remote-bar' }];

test('an executed upload plan queues delete_subtree for the folder and delete_node for the bookmark', async () => {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() });
  await active(store);
  const plan = buildAdvancedPlan({ scope, confirmationId: 'confirm-exec-kind', mode: 'upload', boundaryVersion: '1',
    treeDigest: 'tree', remoteSnapshotId: 'snapshot', remoteRevision: 'revision', remoteCursor: 'cursor',
    local: execLocal, remote: execRemote, mappings: [], mounts: execMounts, rootNodeId: 'root' });
  const definitions = [
    ...execRemote.map((fact) => ({ kind: 'snapshot-fact', fact,
      nativeId: plan.matched.find((pair) => pair.nodeId === fact.nodeId)?.nativeId ?? null })),
    ...plan.steps,
  ];
  const committed = await store.commitAdvancedPlan(scope, { planId: plan.planId,
    metadata: { mode: 'upload', mounts: JSON.parse(JSON.stringify(execMounts)), confirmationId: 'confirm-exec-kind',
      treeDigest: 'tree' },
    steps: JSON.parse(JSON.stringify(definitions)) as JsonObject[], now: 10 });
  await activateAdvancedPlan(store, scope, committed);
  const staged: MappingInput[] = execRemote.map((fact) => ({ colpId: fact.nodeId, nativeId: `snapshot:${fact.nodeId}`,
    rootNativeId: 'root', nodeKind: fact.kind,
    ...(fact.parentId ? { parentColpId: fact.parentId } : {}),
    projection: { revision: fact.revision, digest: 'digest',
      ...(fact.childrenRevision ? { childrenRevision: fact.childrenRevision } : {}),
      content: { title: fact.title, ...(fact.url ? { url: fact.url } : {}) } } }));
  const projection = await projectAdvancedSnapshot(store, scope, staged);
  for (const mapping of projection ?? []) await store.putMapping(scope, mapping);

  const api: AdvancedNativeApi = {
    async get() { return []; },
    async getChildren() { return []; },
    async create(): Promise<never> { throw new Error('unexpected_local_create'); },
    async update(): Promise<never> { throw new Error('unexpected_local_update'); },
    async move(): Promise<never> { throw new Error('unexpected_local_move'); },
    async remove(): Promise<never> { throw new Error('unexpected_local_remove'); },
  };
  for (let round = 0; round < 10; round += 1) {
    await executeActiveAdvancedPlan(store, scope, api);
    const loaded = await store.readAdvancedPlan(scope, plan.planId);
    if (loaded?.plan.state === 'completed') break;
    const pending = (await store.listQueue(scope)).filter((row) => row.status !== 'terminal');
    assert.ok(pending.length > 0, `advanced plan made no progress (round ${round})`);
    for (const row of pending) {
      const targetId = typeof row.payload.targetId === 'string' ? row.payload.targetId : 'created-target';
      await completeQueuedCreate(store, row, targetId);
    }
  }
  assert.equal((await store.readAdvancedPlan(scope, plan.planId))?.plan.state, 'completed');

  const rows = await store.listQueue(scope);
  const typeByTarget = new Map(rows.map((row) => [String(row.payload.targetId), String(row.payload.type)]));
  assert.equal(rows.length, 2, 'the upload plan deletes exactly the two remote-only nodes');
  assert.equal(typeByTarget.get('remote-old'), 'delete_subtree');
  assert.equal(typeByTarget.get('remote-bookmark-old'), 'delete_node');
  assert.equal(typeByTarget.get('remote-old'), protocolType('remote-old', 'folder'));
  assert.equal(typeByTarget.get('remote-bookmark-old'), protocolType('remote-bookmark-old', 'bookmark'));
  for (const row of rows) assert.equal(validateOperation(row.payload), true);
  assert.deepEqual(rows.filter((row) => row.payload.targetId === 'remote-old').map((row) => row.payload.type),
    ['delete_subtree'], 'a folder target must never leave as delete_node');
});
