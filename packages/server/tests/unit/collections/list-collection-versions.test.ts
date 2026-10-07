import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import {
  CollectionVersionNotFoundError,
  buildCollectionTreeJson,
  createProductCollectionVersionCursorSigner,
  getCollectionVersion,
  listCollectionVersions,
  type CollectionTreeLiveMember,
  type CollectionVersionRecord,
  type CollectionVersionStorePort,
} from '../../../src/modules/collections/index.js';

const COL = 'col-1';
const ROOT = 'root-1';
const OWNER = 'owner-1';
const ACCOUNT = 'account-1';
const NOW = new Date('2026-08-24T08:00:00.000Z');

const signers: Array<{ destroy(): void }> = [];
afterEach(() => { while (signers.length) signers.pop()!.destroy(); });

function member(
  id: string,
  overrides: Partial<CollectionTreeLiveMember> = {},
): CollectionTreeLiveMember {
  return {
    id,
    kind: 'bookmark',
    parentId: ROOT,
    title: id,
    url: `https://example.test/${id}`,
    positionToken: id,
    ...overrides,
  };
}

function versionRow(
  versionId: string,
  treeJson: CollectionVersionRecord['treeJson'],
  createdAt: Date,
): CollectionVersionRecord {
  return {
    versionId,
    accountId: ACCOUNT,
    collectionId: COL,
    contentRevision: `rev-${versionId}`,
    kind: 'manual',
    label: versionId,
    etag: `"${versionId}"`,
    nodeCount: treeJson.length,
    treeJson,
    createdAt,
  };
}

function trackingStore(input: {
  readonly owner?: string;
  readonly members?: CollectionTreeLiveMember[];
  readonly rows?: CollectionVersionRecord[];
}): CollectionVersionStorePort & {
  lockOwnedLiveCalls: number;
  getOwnedLiveCalls: number;
  loadLiveMembersCalls: number;
} {
  const members = input.members ?? [];
  const rows = [...(input.rows ?? [])];
  const owner = input.owner ?? OWNER;
  const owned = async (collectionId: string, ownerSubjectId: string) => {
    if (collectionId !== COL || ownerSubjectId !== owner) return null;
    return {
      collectionId: COL,
      ownerSubjectId: owner,
      contentRevision: 'rev-1',
      rootNodeId: ROOT,
    };
  };
  const store = {
    lockOwnedLiveCalls: 0,
    getOwnedLiveCalls: 0,
    loadLiveMembersCalls: 0,
    async lockOwnedLive(collectionId: string, ownerSubjectId: string) {
      store.lockOwnedLiveCalls += 1;
      return owned(collectionId, ownerSubjectId);
    },
    async getOwnedLive(collectionId: string, ownerSubjectId: string) {
      store.getOwnedLiveCalls += 1;
      return owned(collectionId, ownerSubjectId);
    },
    async loadLiveMembers(collectionId: string) {
      store.loadLiveMembersCalls += 1;
      return collectionId === COL ? members : [];
    },
    async getByCollectionAndRevision(accountId: string, collectionId: string, contentRevision: string) {
      return rows.find((row) =>
        row.accountId === accountId
        && row.collectionId === collectionId
        && row.contentRevision === contentRevision) ?? null;
    },
    async getById(accountId: string, collectionId: string, versionId: string) {
      return rows.find((row) =>
        row.accountId === accountId
        && row.collectionId === collectionId
        && row.versionId === versionId) ?? null;
    },
    async list(accountId: string, collectionId: string, query: {
      readonly limit: number;
      readonly after?: { readonly createdAt: Date; readonly versionId: string };
    }) {
      const sorted = rows
        .filter((row) => row.accountId === accountId && row.collectionId === collectionId)
        .sort((left, right) => {
          const time = right.createdAt.getTime() - left.createdAt.getTime();
          if (time !== 0) return time;
          return right.versionId < left.versionId ? -1 : right.versionId > left.versionId ? 1 : 0;
        });
      const filtered = query.after
        ? sorted.filter((row) => {
          const time = row.createdAt.getTime() - query.after!.createdAt.getTime();
          if (time !== 0) return time < 0;
          return row.versionId < query.after!.versionId;
        })
        : sorted;
      return filtered.slice(0, query.limit + 1);
    },
    async insert(row: CollectionVersionRecord) { rows.push(row); },
    async count() { return rows.length; },
    async deleteOldest() { rows.shift(); },
    async findLatestManualCreatedAt() { return null; },
  };
  return store;
}

function listPorts(store: CollectionVersionStorePort) {
  const cursors = createProductCollectionVersionCursorSigner({
    current: { id: 'cv-list-v1', key: 'collection-versions-unit-cursor-secret-material' },
  });
  signers.push(cursors);
  return {
    versions: store,
    cursors,
    clock: { now: () => NOW },
  };
}

test('list uses getOwnedLive without lockOwnedLive and loads live members once for three rows', async () => {
  const live = [member('bm-live', { title: 'Live', positionToken: 'a' })];
  const liveTree = buildCollectionTreeJson(live);
  const renamedTree = buildCollectionTreeJson([
    member('bm-live', { title: 'Old', positionToken: 'a' }),
  ]);
  const store = trackingStore({
    members: live,
    rows: [
      versionRow('ver-empty', [], new Date(NOW.getTime())),
      versionRow('ver-same', liveTree, new Date(NOW.getTime() + 1000)),
      versionRow('ver-renamed', renamedTree, new Date(NOW.getTime() + 2000)),
    ],
  });
  const page = await listCollectionVersions(listPorts(store), {
    actor: { principalId: ACCOUNT, subjectId: OWNER },
    collectionId: COL,
  });
  assert.equal(store.getOwnedLiveCalls, 1);
  assert.equal(store.lockOwnedLiveCalls, 0);
  assert.equal(store.loadLiveMembersCalls, 1);
  assert.deepEqual(page.items.map((item) => item.versionId), ['ver-renamed', 'ver-same', 'ver-empty']);
  assert.deepEqual(page.items[0]?.changeCounts, {
    added: 0, removed: 0, moved: 0, renamed: 1, retargeted: 0,
  });
  assert.deepEqual(page.items[1]?.changeCounts, {
    added: 0, removed: 0, moved: 0, renamed: 0, retargeted: 0,
  });
  assert.deepEqual(page.items[2]?.changeCounts, {
    added: 1, removed: 0, moved: 0, renamed: 0, retargeted: 0,
  });
  assert.equal(page.nextCursor, null);
});

test('50 max-size versions compute counts with linear snapshot visits', async () => {
  const live = Array.from({ length: 2_000 }, (_, index) => member(`bm-${String(index).padStart(4, '0')}`, {
    positionToken: `p${String(index).padStart(4, '0')}`,
  }));
  const snapshot = buildCollectionTreeJson(live);
  let indexedReads = 0;
  const tracked = new Proxy(snapshot, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/u.test(property)) indexedReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const rows = Array.from({ length: 50 }, (_, index) =>
    versionRow(`ver-${String(index).padStart(2, '0')}`, tracked, new Date(NOW.getTime() + index)));
  const page = await listCollectionVersions(listPorts(trackingStore({ members: live, rows })), {
    actor: { principalId: ACCOUNT, subjectId: OWNER }, collectionId: COL, limit: 50,
  });

  assert.equal(page.items.length, 50);
  assert.ok(page.items.every((item) => item.changeCounts.moved === 0));
  assert.ok(indexedReads < snapshot.length * rows.length * 8,
    `expected linear page diff access, observed ${indexedReads} indexed reads`);
});

test('get uses getOwnedLive without lockOwnedLive', async () => {
  const live = [member('bm-live', { title: 'Live', positionToken: 'a' })];
  const snapshot = buildCollectionTreeJson([
    member('bm-live', { title: 'Old', positionToken: 'a' }),
  ]);
  const store = trackingStore({
    members: live,
    rows: [versionRow('ver-1', snapshot, NOW)],
  });
  const item = await getCollectionVersion({ versions: store }, {
    actor: { principalId: ACCOUNT, subjectId: OWNER },
    collectionId: COL,
    versionId: 'ver-1',
  });
  assert.equal(store.getOwnedLiveCalls, 1);
  assert.equal(store.lockOwnedLiveCalls, 0);
  assert.equal(item.versionId, 'ver-1');
  assert.equal(item.changeCounts.renamed, 1);
  assert.equal(item.changes?.some((change) => change.type === 'renamed' && change.nodeId === 'bm-live'), true);
});

test('list and get miss when getOwnedLive returns null and never lock', async () => {
  const store = trackingStore({ owner: OWNER, members: [], rows: [] });
  await assert.rejects(
    () => listCollectionVersions(listPorts(store), {
      actor: { principalId: ACCOUNT, subjectId: 'outsider' },
      collectionId: COL,
    }),
    CollectionVersionNotFoundError,
  );
  await assert.rejects(
    () => getCollectionVersion({ versions: store }, {
      actor: { principalId: ACCOUNT, subjectId: 'outsider' },
      collectionId: COL,
      versionId: 'ver-1',
    }),
    CollectionVersionNotFoundError,
  );
  assert.equal(store.getOwnedLiveCalls, 2);
  assert.equal(store.lockOwnedLiveCalls, 0);
  assert.equal(store.loadLiveMembersCalls, 0);
});
