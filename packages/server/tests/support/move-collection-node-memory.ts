/** In-memory ports for moveCollectionNode unit tests. */
import assert from 'node:assert/strict';
import {
  CollectionAuthorizationError,
  CollectionPreconditionError,
  NodeConflictError,
  moveCollectionNode,
  moveCollectionNodeCommandScope,
  strongEntityTag,
  type BootstrapAuditRecord,
  type BootstrapOperationRecord,
  type BootstrapOutboxRecord,
  type ChildrenRevisionInsert,
  type ContentRevisionInsert,
  type IdLedgerReserveEntry,
  type LockedCollectionRow,
  type LockedNodeRow,
  type MoveCollectionNodeInput,
  type MoveCollectionNodePorts,
  type MoveCollectionNodeResult,
  type ProductCollectionCanonicalPorts,
  type NodeInsertRow,
  type NodeParentPositionUpdateRow,
  type NodePositionUpdateRow,
  type PolicyRevisionInsert,
  type ResourceRevisionInsert,
  type SiblingPositionRow,
} from '../../src/modules/collections/index.js';
import { executeMemoryCanonicalForTests } from './product-canonical-memory.js';
import {
  createMemoryBookmarkIconFields,
  createMemoryBookmarkIcons,
  type MemoryBookmarkIconFields,
} from './memory-bookmark-icons.js';
import type {
  ProductCommandResult,
} from '../../src/modules/commands/index.js';
import {
  collectionsMemoryReceiptKey,
  createCollectionsMemoryAccessPolicyFacts,
  createCollectionsMemoryReceipts,
  snapshotLockedNode,
  type CollectionsMemoryMembershipRow,
  type CollectionsMemoryReceiptRow,
} from './collections-memory-adapter-shared.js';

export const NOW = new Date('2026-07-22T12:00:00.000Z');

export const COMMAND_A = '5de3947e-6271-4fdf-a946-d22e58a99c2a';
export const COMMAND_B = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
export const COMMAND_C = '11111111-2222-4333-8444-555555555555';
export const COMMAND_D = '22222222-3333-4444-8555-666666666666';

export const PRINCIPAL_OWNER = 'principal-owner';
export const SUBJECT_OWNER = 'subject-owner';
export const PRINCIPAL_EDITOR = 'principal-editor';
export const SUBJECT_EDITOR = 'subject-editor';
export const PRINCIPAL_VIEWER = 'principal-viewer';
export const SUBJECT_VIEWER = 'subject-viewer';
export const PRINCIPAL_STRANGER = 'principal-stranger';
export const SUBJECT_STRANGER = 'subject-stranger';

export const FINGERPRINT_A = 'a'.repeat(64);
export const FINGERPRINT_B = 'b'.repeat(64);

export const COLLECTION_ID = 'col-node-move-1';
export const OTHER_COLLECTION_ID = 'col-node-move-other';
export const ROOT_ID = 'root-node-move-1';
export const FOLDER_A = 'folder-a-move-1';
export const FOLDER_B = 'folder-b-move-1';
export const FOLDER_CHILD = 'folder-child-move-1';
export const BOOKMARK_ID = 'bookmark-move-1';
export const SIBLING_A = 'sibling-a-move-1';
export const SIBLING_B = 'sibling-b-move-1';
export const SIBLING_C = 'sibling-c-move-1';
export const MOVE_TARGET = 'move-target-1';

export const RESOURCE_REV = 'collection-resource-rev';
export const CONTENT_REV = 'collection-content-rev';
export const POLICY_REV = 'collection-policy-rev';
export const ROOT_CHILDREN_REV = 'root-children-rev-1';
export const FOLDER_A_CHILDREN_REV = 'folder-a-children-rev-1';
export const FOLDER_B_CHILDREN_REV = 'folder-b-children-rev-1';
export const MOVE_TARGET_RESOURCE_REV = 'move-target-resource-rev-1';
export const OPERATION_ID = 'op-node-move-1';

// ---------------------------------------------------------------------------
// Memory state + ports
// ---------------------------------------------------------------------------

export type ReceiptRow = CollectionsMemoryReceiptRow;
export type MembershipRow = CollectionsMemoryMembershipRow;

export type MutableCollection = LockedCollectionRow & {
  contentRevision: string;
  policyRevision: string;
  commitOrdinal: bigint;
  updatedAt: Date;
  deletedAt: Date | null;
};

export type MutableNode = {
  id: string;
  collectionId: string;
  parentId: string | null;
  kind: 'folder' | 'bookmark';
  isRoot: boolean;
  title: string;
  url: string | null;
  description: string | null;
  tags: string[];
  visibility: 'inherit' | 'protected' | 'private';
  positionToken: string | null;
  resourceRevision: string;
  childrenRevision: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

export interface MemoryState extends MemoryBookmarkIconFields {
  now: Date;
  receipts: Map<string, ReceiptRow>;
  ledger: IdLedgerReserveEntry[];
  collections: Map<string, MutableCollection>;
  nodes: Map<string, MutableNode>;
  memberships: MembershipRow[];
  resourceRevisions: ResourceRevisionInsert[];
  contentRevisions: ContentRevisionInsert[];
  policyRevisions: PolicyRevisionInsert[];
  childrenRevisions: ChildrenRevisionInsert[];
  operations: BootstrapOperationRecord[];
  audit: BootstrapAuditRecord[];
  outbox: BootstrapOutboxRecord[];
  forceInProgress?: boolean;
  productOrigin: string;
}

export const receiptKey = collectionsMemoryReceiptKey;
export const toLockedNode = snapshotLockedNode;
export const createMemoryReceipts = createCollectionsMemoryReceipts;
export const createMemoryAccessPolicyFacts = createCollectionsMemoryAccessPolicyFacts;

/**
 * In-memory ports for move. updateParentAndPosition moves the target node;
 * updatePosition rewrites sibling positions during rebalance.
 */
export function createMemoryPorts(state: MemoryState): ProductCollectionCanonicalPorts {
  const legacy: MoveCollectionNodePorts = {
    receipts: createMemoryReceipts(state),
    clock: {
      now: async () => new Date(state.now),
    },
    idLedger: {
      async reserve(entries) {
        for (const entry of entries) {
          if (state.ledger.some((e) => e.resourceId === entry.resourceId)) {
            throw new Error(`duplicate ledger id ${entry.resourceId}`);
          }
          state.ledger.push({ ...entry });
        }
      },
    },
    collections: {
      async insertBootstrap() {
        throw new Error('insertBootstrap not used by moveCollectionNode');
      },
      async lockForUpdate(collectionId) {
        const row = state.collections.get(collectionId);
        if (!row) return null;
        return { ...row };
      },
      async lockForShare(collectionId) {
        return this.lockForUpdate(collectionId);
      },
      async advanceContentFence(collectionId, update) {
        const row = state.collections.get(collectionId);
        if (!row) throw new Error(`missing collection ${collectionId}`);
        row.contentRevision = update.contentRevision;
        row.commitOrdinal = update.commitOrdinal;
        row.updatedAt = update.updatedAt;
        if (update.policyRevision !== undefined) {
          row.policyRevision = update.policyRevision;
        }
      },
    },
    nodes: {
      async insertRoot() {
        throw new Error('insertRoot not used by moveCollectionNode');
      },
      async insertNode(row: NodeInsertRow) {
        if (state.nodes.has(row.id)) {
          throw new Error(`duplicate node ${row.id}`);
        }
        state.nodes.set(row.id, {
          id: row.id,
          collectionId: row.collectionId,
          parentId: row.parentId,
          kind: row.kind,
          isRoot: false,
          title: row.title,
          url: row.url,
          description: row.description,
          tags: [...row.tags],
          visibility: row.visibility,
          positionToken: row.positionToken,
          resourceRevision: row.resourceRevision,
          childrenRevision: row.childrenRevision,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          deletedAt: null,
        });
      },
      async getNode(collectionId, nodeId) {
        const row = state.nodes.get(nodeId);
        if (!row || row.collectionId !== collectionId) return null;
        return toLockedNode(row);
      },
      async readParentAncestry(collectionId, parentId, maxDepth) {
        const rows: LockedNodeRow[] = [];
        let currentId: string | null = parentId;
        for (let depth = 0; depth <= maxDepth && currentId !== null; depth += 1) {
          const row = state.nodes.get(currentId);
          if (!row) break;
          rows.push(toLockedNode(row));
          currentId = row.parentId;
        }
        return rows;
      },
      async listLiveSiblingPositions(collectionId, parentId): Promise<readonly SiblingPositionRow[]> {
        return [...state.nodes.values()]
          .filter(
            (n) =>
              n.collectionId === collectionId
              && n.parentId === parentId
              && n.deletedAt === null
              && n.positionToken !== null,
          )
          .sort((a, b) => {
            const pa = a.positionToken!;
            const pb = b.positionToken!;
            if (pa < pb) return -1;
            if (pa > pb) return 1;
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
          })
          .map((n) => ({ id: n.id, positionToken: n.positionToken! }));
      },
      async listLiveNodes(collectionId) {
        return [...state.nodes.values()]
          .filter((n) =>
            n.collectionId === collectionId
            && n.deletedAt === null
            && (n.kind === 'folder' || n.kind === 'bookmark'))
          .map((n) => toLockedNode(n));
      },
      async updateContent() {
        throw new Error('updateContent not used by moveCollectionNode');
      },
      async updatePosition(collectionId, nodeId, update: NodePositionUpdateRow) {
        const row = state.nodes.get(nodeId);
        if (!row || row.collectionId !== collectionId) {
          throw new Error(`missing node ${nodeId}`);
        }
        row.positionToken = update.positionToken;
        row.resourceRevision = update.resourceRevision;
        row.updatedAt = update.updatedAt;
      },
      async updateParentAndPosition(
        collectionId,
        nodeId,
        update: NodeParentPositionUpdateRow,
      ) {
        const row = state.nodes.get(nodeId);
        if (!row || row.collectionId !== collectionId) {
          throw new Error(`missing node ${nodeId}`);
        }
        row.parentId = update.parentId;
        row.positionToken = update.positionToken;
        row.resourceRevision = update.resourceRevision;
        row.updatedAt = update.updatedAt;
      },
      async advanceChildrenRevision(collectionId, nodeId, childrenRevision, updatedAt) {
        const row = state.nodes.get(nodeId);
        if (!row || row.collectionId !== collectionId) {
          throw new Error(`missing parent ${nodeId}`);
        }
        row.childrenRevision = childrenRevision;
        row.updatedAt = updatedAt;
      },
    },
    revisions: {
      async insertResourceRevision(row) {
        state.resourceRevisions.push({ ...row });
      },
      async insertContentRevision(row) {
        state.contentRevisions.push({ ...row });
      },
      async insertPolicyRevision(row) {
        state.policyRevisions.push({ ...row });
      },
      async insertChildrenRevision(row) {
        state.childrenRevisions.push({ ...row });
      },
    },
    operations: {
      async append(record) {
        state.operations.push({ ...record });
      },
    },
    audit: {
      async append(record) {
        state.audit.push({ ...record });
      },
    },
    outbox: {
      async append(record) {
        state.outbox.push({ ...record });
      },
    },
    accessPolicy: createMemoryAccessPolicyFacts(state),
  };
  return {
    receipts: legacy.receipts,
    clock: legacy.clock,
    collections: legacy.collections,
    nodes: legacy.nodes,
    accessPolicy: legacy.accessPolicy,
    productOrigin: state.productOrigin,
    bookmarkIcons: createMemoryBookmarkIcons(state, COLLECTION_ID),
    canonical: {
      execute: (input) => executeMemoryCanonicalForTests(legacy as never, input),
      async bootstrapOwnedCollection() {
        throw new Error('bootstrap is outside moveCollectionNode tests');
      },
    },
  };
}

export function createState(overrides: Partial<MemoryState> = {}): MemoryState {
  return {
    now: new Date(NOW),
    receipts: new Map(),
    ledger: [],
    collections: new Map(),
    nodes: new Map(),
    memberships: [],
    resourceRevisions: [],
    contentRevisions: [],
    policyRevisions: [],
    childrenRevisions: [],
    operations: [],
    audit: [],
    outbox: [],
    productOrigin: 'https://known.example',
    ...createMemoryBookmarkIconFields(),
    ...overrides,
  };
}

export function seedCollection(
  state: MemoryState,
  options: {
    collectionId?: string;
    rootId?: string;
    ownerSubjectId?: string;
    contentRevision?: string;
    policyRevision?: string;
    commitOrdinal?: bigint;
    deletedAt?: Date | null;
    rootChildrenRevision?: string;
    memberships?: Array<{ subjectId: string; role: MembershipRole }>;
  } = {},
): MutableCollection {
  const collectionId = options.collectionId ?? COLLECTION_ID;
  const rootId = options.rootId ?? ROOT_ID;
  const ownerSubjectId = options.ownerSubjectId ?? SUBJECT_OWNER;
  const createdAt = new Date(state.now);
  const row: MutableCollection = {
    id: collectionId,
    ownerSubjectId,
    title: 'Node Move Collection',
    summary: 'seed',
    kind: 'bookmarks',
    visibility: 'private',
    rootNodeId: rootId,
    resourceRevision: RESOURCE_REV,
    contentRevision: options.contentRevision ?? CONTENT_REV,
    policyRevision: options.policyRevision ?? POLICY_REV,
    commitOrdinal: options.commitOrdinal ?? 2n,
    createdAt,
    updatedAt: createdAt,
    deletedAt: options.deletedAt ?? null,
  };
  state.collections.set(collectionId, row);
  state.memberships.push({
    collectionId,
    subjectId: ownerSubjectId,
    role: 'owner',
  });
  for (const m of options.memberships ?? []) {
    state.memberships.push({
      collectionId,
      subjectId: m.subjectId,
      role: m.role,
    });
  }

  state.nodes.set(rootId, {
    id: rootId,
    collectionId,
    parentId: null,
    kind: 'folder',
    isRoot: true,
    title: 'Root',
    url: null,
    description: null,
    tags: [],
    visibility: 'inherit',
    positionToken: null,
    resourceRevision: 'root-resource-rev',
    childrenRevision: options.rootChildrenRevision ?? ROOT_CHILDREN_REV,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  });

  return row;
}

export function seedNode(
  state: MemoryState,
  options: {
    id: string;
    parentId: string;
    kind?: 'folder' | 'bookmark';
    positionToken?: string;
    resourceRevision?: string;
    childrenRevision?: string;
    collectionId?: string;
    title?: string;
    url?: string | null;
    deletedAt?: Date | null;
  },
): MutableNode {
  const collectionId = options.collectionId ?? COLLECTION_ID;
  const kind = options.kind ?? 'folder';
  const createdAt = new Date(state.now);
  const row: MutableNode = {
    id: options.id,
    collectionId,
    parentId: options.parentId,
    kind,
    isRoot: false,
    title: options.title ?? options.id,
    url: kind === 'bookmark' ? (options.url ?? 'https://example.com/') : null,
    description: null,
    tags: [],
    visibility: 'inherit',
    positionToken: options.positionToken ?? 'U',
    resourceRevision: options.resourceRevision ?? `${options.id}-res`,
    childrenRevision: options.childrenRevision ?? `${options.id}-ch`,
    createdAt,
    updatedAt: createdAt,
    deletedAt: options.deletedAt ?? null,
  };
  state.nodes.set(options.id, row);
  return row;
}

/** Standard tree: root → [A, B, C] siblings; folder-a children; bookmark under root. */
export function seedStandardTree(state: MemoryState): void {
  seedCollection(state, {
    memberships: [
      { subjectId: SUBJECT_EDITOR, role: 'editor' },
      { subjectId: SUBJECT_VIEWER, role: 'viewer' },
    ],
  });
  seedNode(state, {
    id: SIBLING_A,
    parentId: ROOT_ID,
    positionToken: 'a',
    resourceRevision: 'sibling-a-res',
  });
  seedNode(state, {
    id: SIBLING_B,
    parentId: ROOT_ID,
    positionToken: 'm',
    resourceRevision: 'sibling-b-res',
  });
  seedNode(state, {
    id: SIBLING_C,
    parentId: ROOT_ID,
    positionToken: 'z',
    resourceRevision: 'sibling-c-res',
  });
  seedNode(state, {
    id: FOLDER_A,
    parentId: ROOT_ID,
    positionToken: 'f',
    resourceRevision: 'folder-a-res',
    childrenRevision: FOLDER_A_CHILDREN_REV,
  });
  seedNode(state, {
    id: FOLDER_B,
    parentId: ROOT_ID,
    positionToken: 'g',
    resourceRevision: 'folder-b-res',
    childrenRevision: FOLDER_B_CHILDREN_REV,
  });
  seedNode(state, {
    id: FOLDER_CHILD,
    parentId: FOLDER_A,
    positionToken: 'a',
    resourceRevision: 'folder-child-res',
  });
  seedNode(state, {
    id: BOOKMARK_ID,
    parentId: ROOT_ID,
    kind: 'bookmark',
    positionToken: 'b',
    resourceRevision: 'bookmark-res',
  });
  seedNode(state, {
    id: MOVE_TARGET,
    parentId: ROOT_ID,
    positionToken: 't',
    resourceRevision: MOVE_TARGET_RESOURCE_REV,
    childrenRevision: 'move-target-ch',
  });
}

export function defaultTargetChildrenRevision(newParentId: string): string {
  if (newParentId === ROOT_ID) return ROOT_CHILDREN_REV;
  if (newParentId === FOLDER_A) return FOLDER_A_CHILDREN_REV;
  if (newParentId === FOLDER_B) return FOLDER_B_CHILDREN_REV;
  return ROOT_CHILDREN_REV;
}

export function baseInput(overrides: Partial<MoveCollectionNodeInput> = {}): MoveCollectionNodeInput {
  const collectionId = overrides.collectionId ?? COLLECTION_ID;
  const nodeId = overrides.nodeId ?? MOVE_TARGET;
  const newParentId = overrides.newParentId ?? ROOT_ID;

  return {
    actor: {
      principalId: PRINCIPAL_OWNER,
      principalType: 'account',
      subjectId: SUBJECT_OWNER,
      ...overrides.actor,
    },
    command: {
      commandId: COMMAND_A,
      fingerprint: FINGERPRINT_A,
      commandScope: moveCollectionNodeCommandScope(collectionId, nodeId),
      ...overrides.command,
    },
    collectionId,
    nodeId,
    ifMatch: overrides.ifMatch ?? strongEntityTag(MOVE_TARGET_RESOURCE_REV),
    newParentId,
    afterId: overrides.afterId === undefined ? null : overrides.afterId,
    beforeId: overrides.beforeId === undefined ? null : overrides.beforeId,
    baseSourceParentRevision: overrides.baseSourceParentRevision ?? ROOT_CHILDREN_REV,
    baseTargetParentRevision:
      overrides.baseTargetParentRevision ?? defaultTargetChildrenRevision(newParentId),
    operationId: overrides.operationId ?? OPERATION_ID,
  };
}

export function assertMoved(
  outcome: MoveCollectionNodeResult,
): Extract<MoveCollectionNodeResult, { kind: 'moved' }> {
  assert.equal(outcome.kind, 'moved', `expected moved, got ${outcome.kind}`);
  return outcome as Extract<MoveCollectionNodeResult, { kind: 'moved' }>;
}

export function completedReceipt(state: MemoryState): ProductCommandResult {
  const key = [...state.receipts.keys()][0];
  assert.ok(key, 'expected a receipt');
  const row = state.receipts.get(key!);
  assert.ok(row?.result, 'expected completed receipt result');
  return row!.result!;
}

export function expectCode(error: unknown, code: string): void {
  assert.ok(error && typeof error === 'object' && 'code' in error, String(error));
  assert.equal((error as { code: string }).code, code);
}

export function parentChildren(state: MemoryState, parentId: string): string {
  const parent = state.nodes.get(parentId);
  assert.ok(parent, `missing parent ${parentId}`);
  return parent!.childrenRevision;
}

// ---------------------------------------------------------------------------
// Same-parent reorder
// ---------------------------------------------------------------------------
