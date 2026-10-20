import 'fake-indexeddb/auto';
import { expect, test, vi } from 'vitest';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { plannedCreateNativeId } from '../src/bookmark-event-codec.js';
import { requestValue, runTransaction } from '../src/sync-state/idb.js';
import { STORES } from '../src/sync-state/schema.js';
import { scopeKey } from '../src/sync-state/scope-key.js';
import { scope } from './bookmark-event-queue-harness.js';
import { batchBoundaryFixture } from './queued-upload-batch-boundary-harness.js';

async function frozenFacts(f: Awaited<ReturnType<typeof batchBoundaryFixture>>) {
  const { scopeKey: _key, ...run } = (await f.store.listBootstrapRuns(scope))[0]!;
  const mount = (await f.store.listMountBindings(scope))[0]!;
  await f.store.putScopePreview(scope, { previewId: 'batch-preview', boundaryVersion: '1', treeDigest: 'sha256:tree',
    bookmarkCount: f.nodes.length, folderCount: 1, skippedCount: 0, expiresAt: Date.now() + 600_000, warnings: [],
    boundary: { selectedNativeIds: ['root-selected'], excludedNativeIds: ['root-unselected'],
      mounts: [{ nativeRootId: 'root-selected', writable: true, materialized: false, customSourceKey: 'selected' }] } });
  await f.store.putBootstrapRun(scope, { ...run, previewId: 'batch-preview', attention: { reportId: run.runId,
    version: 1, createdAt: 1, candidateCount: 101, conflictCount: 0, localOnlyCount: 0, remoteOnlyCount: 0, matchedCount: 0,
    items: Array.from({ length: 101 }, (_, index) => ({ itemId: `candidate-${index}`, kind: 'duplicate_candidate',
      locationCount: 2, decision: 'keep_both' })) } });
  const dependencies = Array.from({ length: 5_000 }, (_, index) => `actual-dependency-${index}-${'x'.repeat(96)}`);
  await f.store.putScopeCommandPlan(scope, { commandId: `rejoin:${mount.mountId}`, kind: 'rejoin',
    confirmationVersion: mount.boundaryVersion, baselineDigest: 'snapshot-boundary', phase: 'applying',
    dependencies, mountId: mount.mountId, updatedAt: Date.now() });
  return { run, mount, dependencies };
}

test('one readonly transaction retains complete preview, attention pages, 5000 command dependencies and linked events', async () => {
  const f = await batchBoundaryFixture();
  try {
    const { mount, dependencies } = await frozenFacts(f);
    const sourceQueue = f.original.find(row => plannedCreateNativeId(row.opId) === f.nodes[0]!.id)!;
    const queue = createBookmarkEventQueue({ store: f.store, scope, api: f.api, autoFlush: false,
      uuid: () => sourceQueue.opId });
    const capture = await queue.created(f.nodes[0]!.id, f.nodes[0]!); await queue.flush();
    const original = (await f.store.getBookmarkEvent(scope, capture.eventId!))!;
    expect(original.opId).toBe(sourceQueue.opId);
    // A valid captured/coalesced event anchors these historical records. This
    // is evidence-read load only: no queue or receipt is fabricated or changed.
    await runTransaction(await f.store.open(), [STORES.bookmarkEvents], 'readwrite', async tx => {
      for (let ordinal = 2; ordinal <= 1_001; ordinal++) tx.objectStore(STORES.bookmarkEvents).put({ ...original,
        eventId: `historic-capture-${ordinal}`, dedupeKey: `historic-capture-${ordinal}`, ordinal });
    });
    const db = await f.store.open(), transaction = vi.spyOn(db, 'transaction');
    let facts: Awaited<ReturnType<typeof f.store.readQueuedUploadBoundaryFacts>>;
    try {
      facts = await f.store.readQueuedUploadBoundaryFacts(scope, f.original);
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(transaction.mock.calls[0]![1]).toBe('readonly');
      expect(transaction.mock.calls[0]![0]).toEqual(expect.arrayContaining([STORES.mappings, STORES.scopes,
        STORES.mounts, STORES.localSyncExclusions, STORES.bookmarkEvents, STORES.metadata]));
    } finally { transaction.mockRestore(); }
    expect(facts.commands.find(row => row.commandId === `rejoin:${mount.mountId}`)?.plan?.dependencies).toEqual(dependencies);
    expect(facts.preview?.boundary.excludedNativeIds).toEqual(['root-unselected']);
    expect(facts.runs[0]!.attention?.items).toHaveLength(101);
    const sourceEvents = facts.events.find(row => row.opId === sourceQueue.opId)!;
    expect(sourceEvents.original).toEqual(original); expect(sourceEvents.linked).toHaveLength(1_001);
    expect(sourceEvents.linked.at(-1)!.ordinal).toBe(1_001);
    await f.batchGuard(f.original);
    expect((await f.store.listQueue(scope)).map(row => row.payload)).toEqual(f.original.map(row => row.payload));
    for (const row of f.original) expect(await f.store.getQueueReceipt(scope, row.sequence)).toBeNull();
  } finally { f.store.close(); }
});

test('an incomplete command evidence page cannot become an empty batch authorization', async () => {
  const f = await batchBoundaryFixture();
  try {
    await frozenFacts(f);
    await runTransaction(await f.store.open(), [STORES.metadata], 'readwrite', async tx => {
      const pages = await requestValue<Array<{ key: string; kind?: string }>>(tx.objectStore(STORES.metadata).getAll());
      const page = pages.find(row => row.kind === 'scope_command_evidence_v1'); expect(page).toBeDefined();
      tx.objectStore(STORES.metadata).delete(page!.key);
    });
    await expect(f.store.readQueuedUploadBoundaryFacts(scope, f.original)).rejects.toThrow('command_evidence_missing');
    await expect(f.batchGuard(f.original)).rejects.toThrow('command_evidence_missing');
    expect(f.sent).toEqual([]);
  } finally { f.store.close(); }
});

test('legacy selected identities are point-read without mounts, while a retired scope has no live facts', async () => {
  const f = await batchBoundaryFixture();
  try {
    await f.store.replaceMountBindings(scope, []);
    const recorded = (await f.store.getScope(scope))!;
    const facts = await f.store.readQueuedUploadBoundaryFacts(scope, f.original);
    expect(facts.mounts).toEqual([]);
    for (const id of [...recorded.selectedRoots, ...recorded.privateRoots!]) {
      expect(facts.mappings.find(row => row.colpId === id)?.mapping?.colpId).toBe(id);
    }
    await f.store.retireScope(scope, { retiredAt: Date.now(), reason: 'user_clear' });
    const after = await f.store.readQueuedUploadBoundaryFacts(scope, f.original);
    expect(after.recorded).toBeNull(); expect(after.runs).toEqual([]); expect(after.events.every(row => !row.original && !row.linked.length)).toBe(true);
    expect(after.mappings.every(row => row.mapping === null)).toBe(true);
    expect(after.commands).toEqual([]); expect(after.preview).toBeNull();
    expect(scopeKey(scope)).toBe(f.original[0]!.scopeKey);
  } finally { f.store.close(); }
});
