import { randomUUID } from 'node:crypto';
import {
  strongEntityTag,
  type CollectionTreeLiveMember,
  type CollectionVersionRecord,
  type RestoreCollectionVersionPorts,
} from '../../src/modules/collections/index.js';
import {
  PRINCIPAL_OWNER,
  ROOT_ID,
  SUBJECT_OWNER,
  createMemoryPorts,
  seedCollection,
  seedNode,
  type MemoryState,
} from './move-collection-node-memory.js';
import { createMemoryCollectionVersionRestoreReceiptStore } from './collection-version-restore-receipts-memory.js';
import {
  createMemoryProductCommandReceiptPort,
  type MemoryProductCommandReceipts,
} from './product-http-harness.js';

export const COL = 'col-restore-1';
export const ROOT = ROOT_ID;
export const FOLDER = 'folder-restore';
export const BM_A = 'bm-restore-a';
export const BM_B = 'bm-restore-b';
export const EXTRA = 'folder-extra';
export const SEPARATOR = 'sep-restore';
export const VERSION = 'ver-restore-1';
export const REV = 'rev-restore-1';
export const MATCH = strongEntityTag(REV);
export const NOW = new Date('2026-08-24T08:00:00.000Z');
export const ACCOUNT = PRINCIPAL_OWNER;
export const SUBJECT = SUBJECT_OWNER;

export function liveMembers(state: MemoryState): CollectionTreeLiveMember[] {
  return [...state.nodes.values()]
    .filter((node) =>
      node.collectionId === COL
      && !node.isRoot
      && node.deletedAt === null
      && (node.kind === 'folder' || node.kind === 'bookmark'))
    .map((node) => ({
      id: node.id,
      kind: node.kind,
      parentId: node.parentId ?? ROOT,
      title: node.title,
      url: node.kind === 'bookmark' ? node.url : null,
      positionToken: node.positionToken ?? node.id,
    }));
}

export function versionOf(
  treeJson: CollectionVersionRecord['treeJson'],
  overrides: Partial<CollectionVersionRecord> = {},
): CollectionVersionRecord {
  return {
    versionId: VERSION,
    accountId: ACCOUNT,
    collectionId: COL,
    contentRevision: REV,
    kind: 'manual',
    label: 'Snapshot',
    etag: `"${VERSION}"`,
    nodeCount: treeJson.length,
    treeJson,
    createdAt: NOW,
    ...overrides,
  };
}

export function restoreMutations(state: MemoryState) {
  const base = createMemoryPorts(state);
  return {
    ...base,
    canonical: {
      async execute(input: Parameters<typeof base.canonical.execute>[0]) {
        if (input.mutation.action === 'update') {
          const node = state.nodes.get(input.mutation.target.resourceId)!;
          const fields = input.mutation.fields!.kindFields;
          node.title = String(fields.title);
          if (node.kind === 'bookmark') node.url = String(fields.url);
          node.description = fields.description === null ? null : String(fields.description ?? node.description ?? '');
          if (node.description === '') node.description = fields.description === null ? null : node.description;
          node.tags = Array.isArray(fields.tags) ? [...fields.tags as string[]] : node.tags;
          node.visibility = (fields.visibility as typeof node.visibility) ?? node.visibility;
          const collection = state.collections.get(input.collectionId)!;
          collection.commitOrdinal += 1n;
          node.resourceRevision = `res-${collection.commitOrdinal}`;
          collection.contentRevision = `cnt-${collection.commitOrdinal}`;
          return {
            operationId: input.operationId,
            collectionId: input.collectionId,
            resourceId: node.id,
            action: 'update' as const,
            allocation: {
              commitOrdinal: collection.commitOrdinal,
              resourceRevision: node.resourceRevision,
              contentRevision: collection.contentRevision,
              childrenRevisions: {},
            },
          };
        }
        if (input.mutation.action === 'delete') {
          const node = state.nodes.get(input.mutation.target.resourceId)!;
          const parentId = node.parentId!;
          node.deletedAt = state.now;
          const collection = state.collections.get(input.collectionId)!;
          collection.commitOrdinal += 1n;
          const resourceRevision = `del-${collection.commitOrdinal}`;
          const contentRevision = `cnt-${collection.commitOrdinal}`;
          const parentChildrenRevision = `pch-${collection.commitOrdinal}`;
          const parent = state.nodes.get(parentId);
          if (parent) parent.childrenRevision = parentChildrenRevision;
          node.resourceRevision = resourceRevision;
          collection.contentRevision = contentRevision;
          return {
            operationId: input.operationId,
            collectionId: input.collectionId,
            resourceId: node.id,
            action: 'delete' as const,
            allocation: {
              commitOrdinal: collection.commitOrdinal,
              resourceRevision,
              contentRevision,
              childrenRevisions: { [parentId]: parentChildrenRevision },
              deletedResourceRevisions: { [node.id]: resourceRevision },
            },
          };
        }
        return base.canonical.execute(input);
      },
      bootstrapOwnedCollection: base.canonical.bootstrapOwnedCollection,
    },
  };
}

export function portsFor(state: MemoryState, rows: CollectionVersionRecord[]): RestoreCollectionVersionPorts & {
  store: { rows: CollectionVersionRecord[]; lockOwnedLiveCalls: number; getOwnedLiveCalls: number };
} {
  const receipts: MemoryProductCommandReceipts = new Map();
  const restoreReceipts = createMemoryCollectionVersionRestoreReceiptStore();
  const base = createMemoryProductCommandReceiptPort(receipts);
  const store = {
    rows,
    lockOwnedLiveCalls: 0,
    getOwnedLiveCalls: 0,
    async lockOwnedLive(collectionId: string, ownerSubjectId: string) {
      store.lockOwnedLiveCalls += 1;
      const row = state.collections.get(collectionId);
      if (!row || row.ownerSubjectId !== ownerSubjectId || row.deletedAt) return null;
      return {
        collectionId: row.id,
        ownerSubjectId: row.ownerSubjectId,
        contentRevision: row.contentRevision,
        rootNodeId: row.rootNodeId,
      };
    },
    async getOwnedLive(collectionId: string, ownerSubjectId: string) {
      store.getOwnedLiveCalls += 1;
      const row = state.collections.get(collectionId);
      if (!row || row.ownerSubjectId !== ownerSubjectId || row.deletedAt) return null;
      return {
        collectionId: row.id,
        ownerSubjectId: row.ownerSubjectId,
        contentRevision: row.contentRevision,
        rootNodeId: row.rootNodeId,
      };
    },
    async loadLiveMembers() { return liveMembers(state); },
    async getByCollectionAndRevision(_accountId: string, collectionId: string, contentRevision: string) {
      return rows.find((row) => row.collectionId === collectionId && row.contentRevision === contentRevision) ?? null;
    },
    async getById(_accountId: string, collectionId: string, versionId: string) {
      return rows.find((row) => row.collectionId === collectionId && row.versionId === versionId) ?? null;
    },
    async list() { return rows; },
    async insert(row: CollectionVersionRecord) { rows.push(row); },
    async count() { return rows.length; },
    async deleteOldest(_accountId: string, _collectionId: string, excludeVersionId?: string) {
      const candidates = rows
        .filter((row) => row.versionId !== excludeVersionId)
        .sort((left, right) => {
          const time = left.createdAt.getTime() - right.createdAt.getTime();
          if (time !== 0) return time;
          return left.versionId < right.versionId ? -1 : 1;
        });
      const oldest = candidates[0];
      if (oldest) rows.splice(rows.indexOf(oldest), 1);
    },
    async findLatestManualCreatedAt() { return null; },
  };
  return {
    store,
    versions: store,
    receipts: {
      claim: (binding, fingerprint) => base.claim(binding, fingerprint),
      complete: (binding, fingerprint, result) => base.complete(binding, fingerprint, result),
      async lookup(binding, fingerprint) {
        return (await base.lookup?.(binding, fingerprint)) ?? { kind: 'absent' };
      },
    },
    clock: { now: () => NOW },
    mutations: restoreMutations(state),
    restoreReceipts,
    commandIds: { next: () => randomUUID() },
  };
}

export function seedBaseTree(state: MemoryState): void {
  seedCollection(state, { collectionId: COL, rootId: ROOT, contentRevision: REV });
  seedNode(state, {
    id: FOLDER, parentId: ROOT, kind: 'folder', title: 'Docs', positionToken: 'a',
    collectionId: COL, childrenRevision: 'folder-ch',
  });
  seedNode(state, {
    id: BM_A, parentId: FOLDER, kind: 'bookmark', title: 'Alpha',
    url: 'https://example.test/a', positionToken: 'a', collectionId: COL, resourceRevision: 'bm-a-res',
  });
  seedNode(state, {
    id: BM_B, parentId: FOLDER, kind: 'bookmark', title: 'Beta',
    url: 'https://example.test/b', positionToken: 'm', collectionId: COL, resourceRevision: 'bm-b-res',
  });
}

export function input(ifMatch = MATCH) {
  return {
    actor: { principalId: ACCOUNT, subjectId: SUBJECT },
    commandId: randomUUID(),
    collectionId: COL,
    versionId: VERSION,
    ifMatch,
  };
}
