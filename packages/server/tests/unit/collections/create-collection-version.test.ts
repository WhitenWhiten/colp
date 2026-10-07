import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';
import {
  CollectionPreconditionError,
  CollectionVersionNodeLimitError,
  CollectionVersionRateLimitError,
  createCollectionVersion,
  strongEntityTag,
  type CollectionTreeLiveMember,
  type CollectionVersionRecord,
  type CollectionVersionStorePort,
  type CreateCollectionVersionPorts,
} from '../../../src/modules/collections/index.js';
import {
  createMemoryProductCommandReceiptPort,
  type MemoryProductCommandReceipts,
} from '../../support/product-http-harness.js';

const COL = 'col-1';
const ROOT = 'root-1';
const OWNER = 'owner-1';
const ACCOUNT = 'account-1';
const NOW = new Date('2026-08-24T08:00:00.000Z');
const MATCH = strongEntityTag('rev-1');

function member(id: string, overrides: Partial<CollectionTreeLiveMember> = {}): CollectionTreeLiveMember {
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

function ports(input: {
  readonly members?: CollectionTreeLiveMember[];
  readonly owner?: string;
  readonly contentRevision?: string;
  readonly rows?: CollectionVersionRecord[];
  readonly latestManual?: Date | null;
}): CreateCollectionVersionPorts & {
  store: CollectionVersionStorePort & {
    rows: CollectionVersionRecord[];
    lockOwnedLiveCalls: number;
    getOwnedLiveCalls: number;
  };
} {
  const rows = [...(input.rows ?? [])];
  const receipts: MemoryProductCommandReceipts = new Map();
  const store: CollectionVersionStorePort & {
    rows: CollectionVersionRecord[];
    lockOwnedLiveCalls: number;
    getOwnedLiveCalls: number;
  } = {
    rows,
    lockOwnedLiveCalls: 0,
    getOwnedLiveCalls: 0,
    async lockOwnedLive(collectionId, ownerSubjectId) {
      store.lockOwnedLiveCalls += 1;
      if (collectionId !== COL || ownerSubjectId !== (input.owner ?? OWNER)) return null;
      return {
        collectionId: COL,
        ownerSubjectId: OWNER,
        contentRevision: input.contentRevision ?? 'rev-1',
        rootNodeId: ROOT,
      };
    },
    async getOwnedLive(collectionId, ownerSubjectId) {
      store.getOwnedLiveCalls += 1;
      if (collectionId !== COL || ownerSubjectId !== (input.owner ?? OWNER)) return null;
      return {
        collectionId: COL,
        ownerSubjectId: OWNER,
        contentRevision: input.contentRevision ?? 'rev-1',
        rootNodeId: ROOT,
      };
    },
    async loadLiveMembers() {
      return input.members ?? [];
    },
    async getByCollectionAndRevision(_accountId, collectionId, contentRevision) {
      return rows.find((row) =>
        row.collectionId === collectionId && row.contentRevision === contentRevision) ?? null;
    },
    async getById() { return null; },
    async list() { return rows; },
    async insert(row) { rows.push(row); },
    async count() { return rows.length; },
    async deleteOldest() { rows.shift(); },
    async findLatestManualCreatedAt() { return input.latestManual ?? null; },
  };
  const base = createMemoryProductCommandReceiptPort(receipts);
  return {
    store,
    versions: store,
    receipts: {
      claim: (binding, fingerprint) => base.claim(binding, fingerprint),
      complete: (binding, fingerprint, result) => base.complete(binding, fingerprint, result),
      async lookup(binding, fingerprint) {
        const existing = await base.lookup?.(binding, fingerprint);
        return existing ?? { kind: 'absent' };
      },
    },
    clock: { now: () => NOW },
    ids: { nextVersionId: () => 'ver-1' },
  };
}

test('create 201 snapshots an empty tree', async () => {
  const created = ports({ members: [] });
  const result = await createCollectionVersion(created, {
    actor: { principalId: ACCOUNT, subjectId: OWNER },
    commandId: randomUUID(),
    collectionId: COL,
    ifMatch: MATCH,
  });
  assert.equal(result.kind, 'succeeded');
  if (result.kind !== 'succeeded') return;
  assert.equal(result.status, 201);
  assert.equal(result.version.nodeCount, 0);
  assert.equal(result.version.label, 'Snapshot 2026-08-24T08:00:00Z');
  assert.equal(created.store.rows.length, 1);
  assert.ok(created.store.lockOwnedLiveCalls >= 1);
  assert.equal(created.store.getOwnedLiveCalls, 0);
});

test('second create for the same revision is 200 and does not insert', async () => {
  const first = ports({ members: [] });
  const firstResult = await createCollectionVersion(first, {
    actor: { principalId: ACCOUNT, subjectId: OWNER },
    commandId: randomUUID(),
    collectionId: COL,
    ifMatch: MATCH,
  });
  assert.equal(firstResult.kind, 'succeeded');
  const second = await createCollectionVersion(first, {
    actor: { principalId: ACCOUNT, subjectId: OWNER },
    commandId: randomUUID(),
    collectionId: COL,
    ifMatch: MATCH,
  });
  assert.equal(second.kind, 'succeeded');
  if (second.kind !== 'succeeded') return;
  assert.equal(second.status, 200);
  assert.equal(first.store.rows.length, 1);
});

test('wrong contentEtag is 412 and non-owner is not found', async () => {
  const created = ports({ members: [] });
  await assert.rejects(
    () => createCollectionVersion(created, {
      actor: { principalId: ACCOUNT, subjectId: OWNER },
      commandId: randomUUID(),
      collectionId: COL,
      ifMatch: '"other"',
    }),
    CollectionPreconditionError,
  );
  await assert.rejects(
    () => createCollectionVersion(created, {
      actor: { principalId: ACCOUNT, subjectId: 'outsider' },
      commandId: randomUUID(),
      collectionId: COL,
      ifMatch: MATCH,
    }),
    { name: 'CollectionVersionNotFoundError' },
  );
});

test('more than 2000 live members is invalid_request before insert', async () => {
  const members = Array.from({ length: 2001 }, (_, index) =>
    member(`bm-${index}`, { positionToken: `p${index}` }));
  const created = ports({ members });
  await assert.rejects(
    () => createCollectionVersion(created, {
      actor: { principalId: ACCOUNT, subjectId: OWNER },
      commandId: randomUUID(),
      collectionId: COL,
      ifMatch: MATCH,
    }),
    CollectionVersionNodeLimitError,
  );
  assert.equal(created.store.rows.length, 0);
});

test('manual create cooldown is 10 seconds', async () => {
  const created = ports({
    members: [],
    latestManual: new Date(NOW.getTime() - 1_000),
  });
  await assert.rejects(
    () => createCollectionVersion(created, {
      actor: { principalId: ACCOUNT, subjectId: OWNER },
      commandId: randomUUID(),
      collectionId: COL,
      ifMatch: MATCH,
    }),
    CollectionVersionRateLimitError,
  );
});
