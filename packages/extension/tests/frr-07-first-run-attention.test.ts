import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, test } from 'vitest';
import { publicAttentionSummary } from '../src/bootstrap/attention-report.js';
import { createBootstrapCoordinator } from '../src/bootstrap/coordinator.js';
import { handleAttentionDecide, handleAttentionGet, withAttention } from '../src/sw/first-run-attention.js';
import {
  popupFirstRunStatus, projectFirstRunSurface,
} from '../src/first-run-draft.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';

const scope: SyncScope = {
  environment: 'production', serverId: 'server-frr07', serverOrigin: 'https://known.example',
  accountId: 'account-frr07', browserProfileId: 'profile-frr07', collectionId: 'collection-frr07',
  replicaId: 'replica-frr07', generation: 1,
};

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

async function persistNeedsAttention(runId: string) {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 99_999 },
    checkpoint: { serverRevision: 'r0', cursor: 'c0' }, selectedRoots: [],
  });
  const coordinator = createBootstrapCoordinator({ store, scope, now: () => 10, randomUUID: () => runId });
  const input = {
    confirmationId: `conf-${runId}`, treeDigest: 'sha256:tree', confirmationVersion: '1',
    localFacts: [
      { nativeId: 'a', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'bookmark',
        title: 'One', url: 'https://example.test/dup' },
      { nativeId: 'b', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'bookmark',
        title: 'Two', url: 'https://example.test/dup' },
    ],
    remoteFacts: [
      { nodeId: 'folder-root', parentId: null, kind: 'folder', title: '', folderRole: 'root', revision: 'r0' },
      { nodeId: 'mount-bar', parentId: 'folder-root', kind: 'folder', title: 'Bar', folderRole: 'bookmarks-bar',
        revision: 'r1' },
      { nodeId: 'r1', parentId: 'mount-bar', kind: 'bookmark', title: 'Cloud', url: 'https://example.test/dup',
        revision: 'r2' },
    ],
    mounts: [{ nativeRootId: 'bar', rootRole: 'bookmarks-bar', remoteMountNodeId: 'mount-bar' }],
    rootNodeId: 'folder-root',
  } satisfies Parameters<typeof coordinator.confirm>[0];
  await coordinator.confirm(input);
  for (const row of await store.listQueue(scope)) {
    await store.completeQueueWithReceipt(scope, row.sequence, {
      opId: row.opId, operationDigest: row.digest, kind: 'terminal', receiptId: `receipt-${row.sequence}`,
      resultDigest: `sha256:${row.sequence}`, result: { results: [{ opId: row.opId, sequence: row.sequence,
        status: 'applied', targetId: `uploaded-${row.sequence}`, revision: `r-${row.sequence}` }] },
    });
  }
  const view = await coordinator.resume(input);
  if (!view) throw new Error('bootstrap_run_missing');
  return { store, coordinator, view };
}

function assertFourSurfaces(input: {
  readonly firstRun: 'completed';
  readonly phase: 'needs_attention';
  readonly attention: NonNullable<Parameters<typeof publicAttentionSummary>[0]>;
  readonly status: Awaited<ReturnType<ReturnType<typeof createBootstrapCoordinator>['status']>>;
  readonly page: Awaited<ReturnType<typeof handleAttentionGet>>;
}) {
  const summary = publicAttentionSummary(input.attention);
  assert.ok(summary.pendingCount > 0);
  assert.ok((input.attention.items ?? []).length > 0);
  assert.equal(projectFirstRunSurface({
    firstRun: input.firstRun, phase: input.phase, attention: summary,
  }), 'attention');
  const label = popupFirstRunStatus({
    connected: true, firstRun: input.firstRun, deferredDraft: false, phase: input.phase, attention: summary,
    engine: { phase: 'idle', hasPendingWork: false },
  });
  assert.equal(label, "action-required");
  assert.notEqual(label, "synced");
  const status = withAttention(input.phase, input.firstRun, { attention: input.attention });
  assert.equal(status.ok && 'phase' in status && status.phase, 'needs_attention');
  assert.equal(status.ok && 'firstRun' in status && status.firstRun, 'completed');
  assert.ok(status.ok && 'attention' in status && (status.attention?.pendingCount ?? 0) > 0);
  assert.equal(input.status.phase, 'needs_attention');
  assert.equal(input.status.firstRun, 'completed');
  assert.ok(input.status.attention && publicAttentionSummary(input.status.attention).pendingCount > 0);
  assert.equal(input.page.ok, true);
  assert.ok(input.page.ok && 'items' in input.page && (input.page.items?.length ?? 0) > 0);
  assert.ok(input.page.ok && 'attention' in input.page && (input.page.attention?.pendingCount ?? 0) > 0);
  assert.equal(input.page.ok && 'phase' in input.page && input.page.phase, 'needs_attention');
  assert.equal(input.page.ok && 'firstRun' in input.page && input.page.firstRun, 'completed');
}

test('FRR-07-A: completed firstRun does not hide needs_attention on four surfaces', async () => {
  const { store, coordinator, view } = await persistNeedsAttention('run-1');
  assert.equal(view.run.phase, 'needs_attention');
  assert.equal((await store.getScope(scope))?.firstRun, 'completed');
  if (!view.run.attention) throw new Error('attention_missing');
  const livePage = await handleAttentionGet(store, scope, 'run-1', undefined, 'completed');
  assertFourSurfaces({
    firstRun: 'completed', phase: 'needs_attention', attention: view.run.attention,
    status: await coordinator.status(), page: livePage,
  });
  store.close();
  const restarted = createSyncStateStore({ indexedDB });
  const restartedCoordinator = createBootstrapCoordinator({
    store: restarted, scope, now: () => 10, randomUUID: () => 'run-1',
  });
  const restartedStatus = await restartedCoordinator.status();
  const restartedRun = (await restarted.listBootstrapRuns(scope))
    .find((row) => row.runId === 'run-1');
  if (!restartedRun?.attention) throw new Error('attention_missing_after_restart');
  const restartedPage = await handleAttentionGet(restarted, scope, 'run-1', undefined, 'completed');
  assertFourSurfaces({
    firstRun: 'completed', phase: 'needs_attention', attention: restartedRun.attention,
    status: restartedStatus, page: restartedPage,
  });
});

test('FRR-07-A: merge confirm persists a bounded attention report without raw URLs', async () => {
  const { store, view } = await persistNeedsAttention('run-attn');
  assert.equal(view.run.phase, 'needs_attention');
  assert.ok(view.run.attention);
  assert.equal(view.run.attention.reportId, 'run-attn');
  const page = await handleAttentionGet(store, scope, 'run-attn', undefined, 'completed');
  assert.equal(page.ok, true);
  assert.ok(page.ok && 'items' in page && page.items && page.items.length > 0);
  assert.equal(JSON.stringify(page).includes('https://example.test/dup'), false);
  const items = page.ok && 'items' in page ? page.items ?? [] : [];
  assert.equal(items.every((item) => !('url' in item) && !('nativeId' in item)), true);
  const itemId = items[0]?.itemId ?? '';
  const decided = await handleAttentionDecide(store, scope, 'run-attn', itemId, 'completed');
  assert.equal(decided.ok && 'attention' in decided && decided.attention?.pendingCount, 0);
  const again = await handleAttentionDecide(store, scope, 'run-attn', itemId, 'completed');
  assert.equal(again.ok, true);
});
