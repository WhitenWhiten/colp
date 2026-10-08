/** In-memory ports for updateCollectionNode unit tests. */
import assert from 'node:assert/strict';
import {
  CollectionAuthorizationError,
  CollectionPreconditionError,
  CollectionsError,
  NODE_UPDATED_EVENT_TYPE,
  NodeConflictError,
  ifMatchSatisfied,
  strongEntityTag,
  updateCollectionNode,
  updateCollectionNodeCommandScope,
  type BootstrapAuditRecord,
  type BootstrapOperationRecord,
  type BootstrapOutboxRecord,
  type ChildrenRevisionInsert,
  type ContentRevisionInsert,
  type IdLedgerReserveEntry,
  type LockedCollectionRow,
  type NodeContentUpdateRow,
  type PolicyRevisionInsert,
  type ProductCollectionCanonicalPorts,
  type CollectionsWritePorts,
  type ResourceRevisionInsert,
  type SiblingPositionRow,
  type UpdateCollectionNodeInput,
  type UpdateCollectionNodeResult,
} from '../../src/modules/collections/index.js';
import type { ProductCommandResult } from '../../src/modules/commands/index.js';
import {
  collectionsMemoryReceiptKey,
  createCollectionsMemoryAccessPolicyFacts,
  createCollectionsMemoryReceipts,
  snapshotLockedNode,
  type CollectionsMemoryMembershipRow,
  type CollectionsMemoryReceiptRow,
} from './collections-memory-adapter-shared.js';
import {
  createMemoryBookmarkIconFields,
  createMemoryBookmarkIcons,
  type MemoryBookmarkIconFields,
} from './memory-bookmark-icons.js';

export const NOW = new Date('2026-07-22T12:00:00.000Z');

export const COMMAND_A = '5de3947e-6271-4fdf-a946-d22e58a99c2a';
export const COMMAND_B = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
export const COMMAND_C = '11111111-2222-4333-8444-555555555555';

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

export const COLLECTION_ID = 'col-node-upd-1';
export const ROOT_ID = 'root-node-upd-1';
export const FOLDER_ID = 'folder-node-upd-1';
export const BOOKMARK_ID = 'bookmark-node-upd-1';
export const RESOURCE_REV = 'collection-resource-rev';
export const CONTENT_REV = 'collection-content-rev';
export const POLICY_REV = 'collection-policy-rev';
export const FOLDER_RESOURCE_REV = 'folder-resource-rev-1';
export const BOOKMARK_RESOURCE_REV = 'bookmark-resource-rev-1';
export const ROOT_RESOURCE_REV = 'root-resource-rev-1';
export const OPERATION_ID = 'op-node-update-1';

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

export function createMemoryPorts(
  state: MemoryState,
): CollectionsWritePorts & ProductCollectionCanonicalPorts {
  return {
    canonical: {
      async execute(input) {
        const collection = state.collections.get(input.collectionId)!;
        const node = state.nodes.get(input.mutation.target.resourceId)!;
        const fields = input.mutation.fields!.kindFields;
        const ordinal = collection.commitOrdinal + 1n;
        const resourceRevision = `canonical-resource-${ordinal}`;
        const contentRevision = `canonical-content-${ordinal}`;
        const visibility = String(fields.visibility) as MutableNode['visibility'];
        const policyRevision = visibility === node.visibility ? undefined : `canonical-policy-${ordinal}`;
        node.title = String(fields.title);
        node.url = fields.url === null ? null : String(fields.url);
        node.description = fields.description === null ? null : String(fields.description);
        node.tags = [...fields.tags as readonly string[]];
        node.visibility = visibility;
        node.resourceRevision = resourceRevision;
        node.updatedAt = new Date(state.now);
        collection.contentRevision = contentRevision;
        collection.commitOrdinal = ordinal;
        if (policyRevision) collection.policyRevision = policyRevision;
        state.resourceRevisions.push({ collectionId: input.collectionId, resourceId: node.id, revision: resourceRevision, ordinal, createdAt: state.now });
        state.contentRevisions.push({ collectionId: input.collectionId, revision: contentRevision, ordinal, createdAt: state.now });
        if (policyRevision) state.policyRevisions.push({ collectionId: input.collectionId, revision: policyRevision, ordinal, createdAt: state.now });
        state.operations.push({ operationId: input.operationId, collectionId: input.collectionId, commitOrdinal: ordinal, operationType: 'resource.update', payload: {}, actorPrincipalId: input.actor.principalId, createdAt: state.now });
        state.audit.push({ operationId: input.operationId, collectionId: input.collectionId, principalId: input.actor.principalId, eventType: 'resource.update', details: {}, createdAt: state.now });
        state.outbox.push({ outboxId: `outbox-${ordinal}`, domainEventId: input.operationId, eventType: NODE_UPDATED_EVENT_TYPE, eventVersion: 1, handlerName: 'node_updated_projection', handlerMode: 'projection_latest_only', aggregateType: 'node', aggregateId: node.id, aggregateScope: input.collectionId, aggregateRevision: resourceRevision, commitOrdinal: ordinal, payload: {}, occurredAt: state.now });
        return { operationId: input.operationId, collectionId: input.collectionId, resourceId: node.id, action: 'update', allocation: { commitOrdinal: ordinal, resourceRevision, contentRevision, ...(policyRevision ? { policyRevision } : {}), childrenRevisions: {} } };
      },
      async bootstrapOwnedCollection() { throw new Error('bootstrap not used'); },
    },
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
        throw new Error('insertBootstrap not used by updateCollectionNode');
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
        throw new Error('insertRoot not used by updateCollectionNode');
      },
      async insertNode() {
        throw new Error('insertNode not used by updateCollectionNode');
      },
      async getNode(collectionId, nodeId) {
        const row = state.nodes.get(nodeId);
        if (!row || row.collectionId !== collectionId) return null;
        return toLockedNode(row);
      },
      async listLiveSiblingPositions(
        _collectionId,
        _parentId,
      ): Promise<readonly SiblingPositionRow[]> {
        return [];
      },
      async updateContent(collectionId, nodeId, update: NodeContentUpdateRow) {
        const row = state.nodes.get(nodeId);
        if (!row || row.collectionId !== collectionId) {
          throw new Error(`missing node ${nodeId}`);
        }
        row.title = update.title;
        row.url = update.url;
        row.description = update.description;
        row.tags = [...update.tags];
        row.visibility = update.visibility;
        row.resourceRevision = update.resourceRevision;
        row.updatedAt = update.updatedAt;
      },
      async updatePosition() {
        throw new Error('updatePosition not used by updateCollectionNode');
      },
      async advanceChildrenRevision() {
        throw new Error('children revision must not advance on content update');
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
      async insertChildrenRevision() {
        throw new Error('children revision must not advance on content update');
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
    productOrigin: state.productOrigin,
    bookmarkIcons: createMemoryBookmarkIcons(state, COLLECTION_ID),
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
    memberships?: Array<{ subjectId: string; role: MembershipRole }>;
    deletedAt?: Date | null;
    commitOrdinal?: bigint;
    contentRevision?: string;
    policyRevision?: string;
  } = {},
): void {
  const createdAt = new Date(state.now);
  state.collections.set(COLLECTION_ID, {
    id: COLLECTION_ID,
    ownerSubjectId: SUBJECT_OWNER,
    title: 'Update Node Collection',
    summary: null,
    kind: 'bookmarks',
    visibility: 'private',
    rootNodeId: ROOT_ID,
    resourceRevision: RESOURCE_REV,
    contentRevision: options.contentRevision ?? CONTENT_REV,
    policyRevision: options.policyRevision ?? POLICY_REV,
    commitOrdinal: options.commitOrdinal ?? 2n,
    createdAt,
    updatedAt: createdAt,
    deletedAt: options.deletedAt ?? null,
  });
  state.memberships.push({
    collectionId: COLLECTION_ID,
    subjectId: SUBJECT_OWNER,
    role: 'owner',
  });
  for (const m of options.memberships ?? []) {
    state.memberships.push({
      collectionId: COLLECTION_ID,
      subjectId: m.subjectId,
      role: m.role,
    });
  }

  state.nodes.set(ROOT_ID, {
    id: ROOT_ID,
    collectionId: COLLECTION_ID,
    parentId: null,
    kind: 'folder',
    isRoot: true,
    title: 'Root Title',
    url: null,
    description: null,
    tags: [],
    visibility: 'inherit',
    positionToken: null,
    resourceRevision: ROOT_RESOURCE_REV,
    childrenRevision: 'root-children',
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  });
}

export function seedFolder(
  state: MemoryState,
  options: {
    title?: string;
    description?: string | null;
    tags?: string[];
    visibility?: 'inherit' | 'protected' | 'private';
    resourceRevision?: string;
  } = {},
): void {
  const createdAt = new Date(state.now);
  state.nodes.set(FOLDER_ID, {
    id: FOLDER_ID,
    collectionId: COLLECTION_ID,
    parentId: ROOT_ID,
    kind: 'folder',
    isRoot: false,
    title: options.title ?? 'Folder Title',
    url: null,
    description: options.description === undefined ? 'folder desc' : options.description,
    tags: options.tags ?? ['alpha'],
    visibility: options.visibility ?? 'inherit',
    positionToken: 'U',
    resourceRevision: options.resourceRevision ?? FOLDER_RESOURCE_REV,
    childrenRevision: 'folder-children',
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  });
}

export function seedBookmark(
  state: MemoryState,
  options: {
    title?: string;
    url?: string;
    description?: string | null;
    tags?: string[];
    visibility?: 'inherit' | 'protected' | 'private';
    resourceRevision?: string;
  } = {},
): void {
  const createdAt = new Date(state.now);
  state.nodes.set(BOOKMARK_ID, {
    id: BOOKMARK_ID,
    collectionId: COLLECTION_ID,
    parentId: ROOT_ID,
    kind: 'bookmark',
    isRoot: false,
    title: options.title ?? 'Bookmark Title',
    url: options.url ?? 'https://example.com/old',
    description: options.description === undefined ? 'bm desc' : options.description,
    tags: options.tags ?? ['tag1'],
    visibility: options.visibility ?? 'inherit',
    positionToken: 'V',
    resourceRevision: options.resourceRevision ?? BOOKMARK_RESOURCE_REV,
    childrenRevision: 'bm-children-unused',
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  });
}

export function baseInput(
  overrides: Partial<UpdateCollectionNodeInput> = {},
): UpdateCollectionNodeInput {
  const collectionId = overrides.collectionId ?? COLLECTION_ID;
  const nodeId = overrides.nodeId ?? FOLDER_ID;
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
      commandScope: updateCollectionNodeCommandScope(collectionId, nodeId),
      ...overrides.command,
    },
    collectionId,
    nodeId,
    ifMatch: overrides.ifMatch ?? strongEntityTag(FOLDER_RESOURCE_REV),
    patch: overrides.patch ?? { title: 'Updated Folder' },
    operationId: overrides.operationId ?? OPERATION_ID,
  };
}

export function assertUpdated(
  outcome: UpdateCollectionNodeResult,
): Extract<UpdateCollectionNodeResult, { kind: 'updated' }> {
  assert.equal(outcome.kind, 'updated', `expected updated, got ${outcome.kind}`);
  return outcome as Extract<UpdateCollectionNodeResult, { kind: 'updated' }>;
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

// ---------------------------------------------------------------------------
// Legal merge patches
// ---------------------------------------------------------------------------
