/**
 * Owner: KNS-03/KNS-05 (QA). Formal IDs: FR-F3-DUPLICATE-SIBLINGS, FR-F3-APPLY-CRASH.
 * Run: npx vitest run tests/recovery-projection-siblings.test.ts
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, test } from 'vitest';
import type { PullBookmarkApi } from '../src/pull-applier.js';
import {
  configureProjectionApplyBarrier, executeProjectionIntents, ProjectionAmbiguousError,
  projectVirtualSnapshotChildren, projectionApplyBarrierStatus, releaseProjectionApplyBarrier,
} from '../src/recovery-projection-executor.js';
import { createProjectionSuppression, type ProjectionIntentRecord } from '../src/recovery-overlay.js';
import { createSyncStateStore, type MappingInput, type SyncScope } from '../src/sync-state-store.js';

const scope: SyncScope = {
  environment: 'development', serverId: 'server-siblings', serverOrigin: 'https://known.example',
  accountId: 'account-siblings', browserProfileId: 'profile-siblings', collectionId: 'collection-siblings',
  replicaId: 'replica-siblings', generation: 1,
};

const parent: MappingInput = {
  nativeId: '1', colpId: 'folder-colp', rootNativeId: '1', nodeKind: 'folder',
  projection: { revision: 'r1', digest: 'd-parent', content: { title: 'Parent' } },
};

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

test('FR-F3-DUPLICATE-SIBLINGS: equal-content remote bookmarks keep distinct natives', async () => {
  const { store, chrome } = await ready();
  const projected = await projectVirtualSnapshotChildren({
    scope, store, api: chrome.api, bound: [parent, sibling('remote-a'), sibling('remote-b')],
  });
  assert.equal(chrome.creates, 2);
  const a = projected.find((mapping) => mapping.colpId === 'remote-a');
  const b = projected.find((mapping) => mapping.colpId === 'remote-b');
  assert.ok(a && b && a.nativeId !== b.nativeId);
  assert.equal((await store.getMappingByColpId(scope, 'remote-a'))?.nativeId, a.nativeId);
  assert.equal((await store.getMappingByColpId(scope, 'remote-b'))?.nativeId, b.nativeId);
  assert.equal((await store.getMappingByNativeId(scope, a.nativeId))?.colpId, 'remote-a');
  assert.equal((await store.getMappingByNativeId(scope, b.nativeId))?.colpId, 'remote-b');
  assert.equal((await store.listProjectionIntents(scope)).every((intent) => intent.state === 'terminal'), true);
});

test('FR-F3-DUPLICATE-SIBLINGS: equal-title remote folders keep distinct natives', async () => {
  const { store, chrome } = await ready();
  await projectVirtualSnapshotChildren({
    scope, store, api: chrome.api, bound: [parent, folderSibling('folder-a'), folderSibling('folder-b')],
  });
  assert.equal(chrome.creates, 2);
  const a = await store.getMappingByColpId(scope, 'folder-a');
  const b = await store.getMappingByColpId(scope, 'folder-b');
  assert.ok(a && b && a.nativeId !== b.nativeId);
  assert.equal(chrome.nodes.get(a.nativeId)?.url, undefined);
  assert.equal(chrome.nodes.get(b.nativeId)?.url, undefined);
});

test('FR-F3-DUPLICATE-SIBLINGS: replaying the same intents does not create a third native', async () => {
  const { store, chrome } = await ready();
  const bound = [parent, sibling('remote-a'), sibling('remote-b')];
  await projectVirtualSnapshotChildren({ scope, store, api: chrome.api, bound });
  const first = {
    a: (await store.getMappingByColpId(scope, 'remote-a'))!.nativeId,
    b: (await store.getMappingByColpId(scope, 'remote-b'))!.nativeId,
  };
  const mapped = [parent, { ...sibling('remote-a'), nativeId: first.a }, { ...sibling('remote-b'), nativeId: first.b }];
  const again = await executeProjectionIntents({
    scope, store, api: chrome.api, selectedRootNativeId: '1', seedMappings: mapped,
  });
  assert.equal(chrome.creates, 2);
  assert.equal(again.find((mapping) => mapping.colpId === 'remote-a')?.nativeId, first.a);
  assert.equal(again.find((mapping) => mapping.colpId === 'remote-b')?.nativeId, first.b);
});

test('FR-F3-APPLY-CRASH: evidence barrier trips after Chrome create and before mapping', async () => {
  const { store, chrome } = await ready();
  configureProjectionApplyBarrier('after_chrome_create_before_mapping');
  await assert.rejects(() => projectVirtualSnapshotChildren({
    scope, store, api: chrome.api, bound: [parent, sibling('remote-a')],
  }), /projection_apply_barrier/);
  assert.equal(projectionApplyBarrierStatus().hits, 1);
  assert.equal(chrome.creates, 1);
  assert.equal(await store.getMappingByColpId(scope, 'remote-a'), null);
  await projectVirtualSnapshotChildren({
    scope, store, api: chrome.api, bound: [parent, sibling('remote-a')],
  });
  assert.equal(chrome.creates, 1);
  assert.ok((await store.getMappingByColpId(scope, 'remote-a'))?.nativeId);
  configureProjectionApplyBarrier();
});

test('FR-F3-APPLY-CRASH: Chrome create without observedNativeId does not claim unique title+URL', async () => {
  const { store, chrome } = await ready();
  chrome.crashAfterCreate = 1;
  await assert.rejects(() => projectVirtualSnapshotChildren({
    scope, store, api: chrome.api, bound: [parent, sibling('remote-a'), sibling('remote-b')],
  }), /chrome_crash/);
  const crashed = await store.listProjectionIntents(scope);
  assert.equal(crashed.some((intent) => intent.state === 'terminal'), false);
  assert.equal(await store.getMappingByColpId(scope, 'remote-a'), null);
  assert.equal(chrome.creates, 1);
  chrome.crashAfterCreate = 0;
  await assert.rejects(() => projectVirtualSnapshotChildren({
    scope, store, api: chrome.api, bound: [parent, sibling('remote-a'), sibling('remote-b')],
  }), (error: unknown) => error instanceof ProjectionAmbiguousError
    && error.code === 'snapshot_native_projection_ambiguous');
  assert.equal((await store.listProjectionIntents(scope)).some((intent) => intent.state === 'ambiguous'), true);
  assert.equal(await store.getMappingByColpId(scope, 'remote-a'), null);
  assert.equal(chrome.creates, 1);
});

test('FR-F3-APPLY-CRASH: observedNativeId persist without mapping is reused and then mapped', async () => {
  const { store, chrome } = await ready();
  chrome.nodes.set('created-1', {
    id: 'created-1', parentId: '1', index: 0, title: 'Equal content', url: 'https://example.test/equal',
  });
  await store.replaceProjectionIntents(scope, [
    createIntent('remote-a', 1, { state: 'executing', observedNativeId: 'created-1' }),
    createIntent('remote-b', 2, { state: 'pending' }),
  ]);
  const projected = await executeProjectionIntents({
    scope, store, api: chrome.api, selectedRootNativeId: '1',
    seedMappings: [parent, sibling('remote-a'), sibling('remote-b')],
  });
  assert.equal(chrome.creates, 1);
  assert.equal(projected.find((mapping) => mapping.colpId === 'remote-a')?.nativeId, 'created-1');
  assert.notEqual(projected.find((mapping) => mapping.colpId === 'remote-b')?.nativeId, 'created-1');
  assert.equal((await store.getMappingByColpId(scope, 'remote-a'))?.nativeId, 'created-1');
});

test('live mapping occupancy survives a leftover-terminal replan', async () => {
  const { store, chrome } = await ready();
  await projectVirtualSnapshotChildren({
    scope, store, api: chrome.api, bound: [parent, sibling('remote-a')],
  });
  const first = (await store.getMappingByColpId(scope, 'remote-a'))!.nativeId;
  await projectVirtualSnapshotChildren({
    scope, store, api: chrome.api,
    bound: [parent, { ...sibling('remote-a'), nativeId: first }, sibling('remote-b')],
  });
  assert.equal(chrome.creates, 2);
  assert.equal((await store.getMappingByColpId(scope, 'remote-a'))?.nativeId, first);
  assert.notEqual((await store.getMappingByColpId(scope, 'remote-b'))?.nativeId, first);
});

test('occupied observedNativeId stays non-terminal and does not overwrite the owner mapping', async () => {
  const { store, chrome } = await ready();
  await store.putMapping(scope, { ...sibling('remote-a'), nativeId: 'owned' });
  chrome.nodes.set('owned', {
    id: 'owned', parentId: '1', index: 0, title: 'Equal content', url: 'https://example.test/equal',
  });
  await store.replaceProjectionIntents(scope, [
    createIntent('remote-b', 1, { state: 'executing', observedNativeId: 'owned' }),
  ]);
  await assert.rejects(() => executeProjectionIntents({
    scope, store, api: chrome.api, selectedRootNativeId: '1',
    seedMappings: [parent, { ...sibling('remote-a'), nativeId: 'owned' }, sibling('remote-b')],
  }), (error: unknown) => error instanceof ProjectionAmbiguousError
    && error.code === 'snapshot_native_projection_ambiguous');
  assert.equal((await store.listProjectionIntents(scope))[0]?.state, 'ambiguous');
  assert.equal((await store.getMappingByNativeId(scope, 'owned'))?.colpId, 'remote-a');
  assert.equal(await store.getMappingByColpId(scope, 'remote-b'), null);
});

async function ready() {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-siblings', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'r1', cursor: 'c0' }, selectedRoots: ['folder-colp'], rootStatus: 'ready',
  });
  await store.putMapping(scope, parent);
  return { store, chrome: fakeChrome([{ id: '1', title: 'Parent' }]) };
}

function sibling(colpId: string): MappingInput {
  return {
    nativeId: `recovery:${colpId}`, colpId, rootNativeId: '1', nodeKind: 'bookmark', parentColpId: 'folder-colp',
    projection: { revision: 'r2', digest: `sha256:${colpId}`,
      content: { title: 'Equal content', url: 'https://example.test/equal' } },
  };
}

function folderSibling(colpId: string): MappingInput {
  return {
    nativeId: `recovery:${colpId}`, colpId, rootNativeId: '1', nodeKind: 'folder', parentColpId: 'folder-colp',
    projection: { revision: 'r2', digest: `sha256:${colpId}`, content: { title: 'Equal folder' } },
  };
}

function createIntent(
  colpId: string, order: number, extra: Partial<ProjectionIntentRecord>,
): ProjectionIntentRecord {
  return {
    intentId: `create:${colpId}`, kind: 'create', colpId, order, generation: 1,
    suppression: createProjectionSuppression('1', 'Equal content', 'https://example.test/equal'),
    parentColpId: 'folder-colp', parentNativeId: '1', title: 'Equal content',
    url: 'https://example.test/equal', folder: false, state: 'pending', ...extra,
  };
}

function fakeChrome(seed: readonly { id: string; parentId?: string; index?: number; title: string; url?: string }[]) {
  const nodes = new Map(seed.map((node) => [node.id, { ...node }]));
  let nextId = seed.reduce((max, node) => Math.max(max, Number(node.id) || 0), 0) + 1;
  let creates = 0;
  const api: PullBookmarkApi = {
    async create(input) {
      const id = String(nextId); nextId += 1;
      nodes.set(id, { id, parentId: input.parentId, index: input.index ?? 0, title: input.title ?? '', url: input.url });
      creates += 1;
      if (chrome.crashAfterCreate > 0) { chrome.crashAfterCreate -= 1; throw new Error('chrome_crash'); }
      return { id };
    },
    async update() { return {}; }, async move() { return {}; },
    async remove() {}, async removeTree() {},
    async get(id) { const node = nodes.get(id); return node ? [node] : []; },
    async getChildren(id) {
      return [...nodes.values()].filter((node) => node.parentId === id)
        .sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
    },
  };
  const chrome = { api, nodes, crashAfterCreate: 0, get creates() { return creates; } };
  return chrome;
}

test('FR-F3-APPLY-HELD: a held apply stays mid-flight with the window open', async () => {
  // The throw mode above fails the apply AT the barrier, so by the time a caller
  // observes it the window has closed. This mode leaves it OPEN — the Chrome
  // bookmark exists, the mapping does not, and the apply is still suspended — so
  // an interruption can land while a multi-step durable write is genuinely
  // mid-flight, which is what MV3 produces and what the e2e crash test could not
  // reach.
  const { store, chrome } = await ready();
  configureProjectionApplyBarrier('after_chrome_create_before_mapping', 'hold');
  const held = projectVirtualSnapshotChildren({
    scope, store, api: chrome.api, bound: [parent, sibling('remote-a')],
  });
  // The apply walks several awaits before reaching the barrier, so wait for the
  // hit rather than assuming one macrotask is enough.
  for (let attempt = 0; attempt < 50 && projectionApplyBarrierStatus().hits === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const status = projectionApplyBarrierStatus();
  assert.equal(status.hits, 1, 'the barrier was reached');
  assert.equal(status.mode, 'hold');
  assert.equal(status.held, 1, 'the apply is suspended at the barrier');
  assert.equal(chrome.creates, 1, 'the Chrome bookmark exists');

  // The window is genuinely open: bookmark created, mapping not yet durable.
  assert.equal(await store.getMappingByColpId(scope, 'remote-a'), null);
  let settled = false;
  void held.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(settled, false, 'a held apply must not have settled');

  // Releasing lets it finish rather than failing it.
  assert.equal(releaseProjectionApplyBarrier(), 1);
  await held;
  assert.ok(await store.getMappingByColpId(scope, 'remote-a'), 'the released apply completed');
  assert.equal(projectionApplyBarrierStatus().held, 0);
  configureProjectionApplyBarrier();
});
