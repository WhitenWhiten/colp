import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { createBookmarkImportCoordinator } from '../src/bookmark-import-plan.js';
import { previewNetscapeBookmarkImport } from '../src/import-preview.js';
import { STORES } from '../src/sync-state/schema.js';
import { scopeKey } from '../src/sync-state/scope-key.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';

/**
 * B5-2: import_node rows are never deleted, and settlement used to scan only the first 20k rows of the scope, so
 * two large plans were enough for every later plan's nodes to live outside that window and have their push receipts
 * silently ignored. The lookup no longer depends on where a plan's rows sort: the enqueue event names the plan, and
 * an event the retention pruned falls back to streaming the scope. These fixtures put the target rows behind a full
 * window of another plan, and behind one page of their own plan.
 */
const scope: SyncScope = { environment: 'production', serverId: 'known', serverOrigin: 'https://known.example',
  accountId: 'account', browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };
const key = scopeKey(scope);
/** The window the old walk truncated at. These rows are only written, never scanned, so the fixture stays cheap. */
const WINDOW = 20_001;
/** More than one page of a plan. */
const PAGE = 1_001;
const twoLinks = new TextEncoder().encode('<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>'
  + '<DT><A HREF="https://example.test/one">One</A><DT><A HREF="https://example.test/two">Two</A></DL><p>');
const oneLink = new TextEncoder().encode('<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>'
  + '<DT><A HREF="https://example.test/one">One</A></DL><p>');

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

async function setup(bytes = twoLinks) {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 99_999 },
    checkpoint: { serverRevision: 'r1', cursor: 'c1' }, selectedRoots: ['root'] });
  await store.putMapping(scope, { nativeId: 'native-root', colpId: 'server-root', rootNativeId: 'native-root',
    nodeKind: 'folder', projection: { revision: 'children-r1', digest: 'sha256:root' } });
  const coordinator = createBookmarkImportCoordinator({ store, scope, now: () => 100 });
  const conversion = previewNetscapeBookmarkImport(bytes);
  const plan = await coordinator.commit({ conversion, choices: conversion.tree.map(node => ({
    sourceNodeId: node.sourceNodeId, action: 'import' as const,
    target: { nativeId: 'native-root', colpId: 'server-root', revision: 'children-r1' } })) });
  return { store, coordinator, plan };
}

/** Writes raw rows through a transaction of their own; node validation is exercised elsewhere. */
async function write(store: Awaited<ReturnType<typeof setup>>['store'], stores: string[],
  fill: (tx: IDBTransaction) => void): Promise<void> {
  const db = await store.open(); const tx = db.transaction(stores, 'readwrite');
  fill(tx);
  await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
}

const filler = (planId: string, order: number) => ({ scopeKey: key, planId, sourceNodeId: `filler-${order}`, order,
  parentSourceNodeId: null, opId: `filler-op-${planId}-${order}`, choice: 'skip' as const, status: 'skipped' as const,
  node: { kind: 'bookmark' } });

const receipt = (receiptId: string, opId: string, operationDigest: string) => ({ opId, operationDigest, kind: 'terminal' as const,
  receiptId, resultDigest: `sha256:${receiptId}`, result: { targetId: `server-${receiptId}`, revision: `revision-${receiptId}` } });

describe('import settlement is not truncated by the first window of the scope', () => {
  test('settles a node whose plan sorts behind a full 20k window of another plan', async () => {
    const { store, plan } = await setup();
    try {
      // An older plan fills the window the old scan stopped at, so a scope prefix could never reach this plan.
      await write(store, [STORES.importNodes], (tx) => {
        const nodes = tx.objectStore(STORES.importNodes);
        for (let order = 0; order < WINDOW; order += 1) nodes.put(filler('a-earlier-plan', order));
      });
      const [first, second] = await store.listQueue(scope);
      assert.ok(first && second);

      await store.completeQueueWithReceipt(scope, first.sequence, receipt('one', first.opId, first.digest));
      const settled = (await store.listImportNodes(scope, plan.planId)).find(node => node.opId === first.opId);
      assert.equal(settled?.status, 'terminal');
      assert.deepEqual(settled?.authoritativeTarget, { colpId: 'server-one', revision: 'revision-one' });
    } finally { store.close(); }
  }, 30_000);

  test('settles the same node once retention has pruned its enqueue event', async () => {
    const { store, plan } = await setup();
    try {
      await write(store, [STORES.importNodes], (tx) => {
        const nodes = tx.objectStore(STORES.importNodes);
        for (let order = 0; order < PAGE; order += 1) nodes.put(filler('a-earlier-plan', order));
      });
      const [queued] = await store.listQueue(scope); assert.ok(queued);
      const node = (await store.listImportNodes(scope, plan.planId)).find(item => item.opId === queued.opId);
      assert.ok(node);
      await write(store, [STORES.bookmarkEvents], (tx) => {
        tx.objectStore(STORES.bookmarkEvents).delete([key, `import:${plan.planId}:${node.sourceNodeId}`]);
      });

      // Nothing names the plan any more: the fallback streams the scope to the row instead of stopping at a window.
      await store.completeQueueWithReceipt(scope, queued.sequence, receipt('two', queued.opId, queued.digest));
      const settled = (await store.listImportNodes(scope, plan.planId)).find(item => item.opId === queued.opId);
      assert.equal(settled?.status, 'terminal');
      assert.deepEqual(settled?.authoritativeTarget, { colpId: 'server-two', revision: 'revision-two' });
    } finally { store.close(); }
  }, 30_000);

  test('parks and resumes a paused plan queue row that sits beyond one page of its own plan', async () => {
    const { store, plan, coordinator } = await setup(oneLink);
    try {
      const [queued] = await store.listQueue(scope); assert.ok(queued);
      const node = (await store.listImportNodes(scope, plan.planId)).find(item => item.opId === queued.opId);
      assert.ok(node);
      // The plan's only queued row now sits past the first page of its own node records.
      await write(store, [STORES.importNodes], (tx) => {
        const nodes = tx.objectStore(STORES.importNodes);
        nodes.put({ ...node, order: PAGE });
        for (let order = 0; order < PAGE; order += 1) nodes.put(filler(plan.planId, order));
      });
      await coordinator.pause(plan.planId);
      assert.equal((await store.getQueueByOpId(scope, queued.opId))?.status, 'set_aside');
      await coordinator.resume(plan.planId);
      assert.equal((await store.getQueueByOpId(scope, queued.opId))?.status, 'pending');
    } finally { store.close(); }
  }, 30_000);
});
