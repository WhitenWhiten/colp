/** Shared in-memory ports for create/delete collection-node application tests. */
import assert from 'node:assert/strict';
import {
  allocatePosition,
  NODE_CREATED_EVENT_TYPE,
  resolvePlacement,
  type BootstrapAuditRecord,
  type BootstrapOperationRecord,
  type BootstrapOutboxRecord,
  type CanonicalMutationInput,
  type CanonicalMutationResult,
  type ChildrenRevisionInsert,
  type CollectionsWritePorts,
  type ContentRevisionInsert,
  type IdLedgerReserveEntry,
  type LockedCollectionRow,
  type NodeInsertRow,
  type NodeSoftDeleteRow,
  type PolicyRevisionInsert,
  type ProductCollectionCanonicalPorts,
  type ResourceRevisionInsert,
  type SiblingPositionRow,
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
import { executeMemoryCanonicalForTests } from './product-canonical-memory.js';

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

// ---------------------------------------------------------------------------
// Memory state + ports
// ---------------------------------------------------------------------------

export type ReceiptRow = CollectionsMemoryReceiptRow;
export type MembershipRow = CollectionsMemoryMembershipRow;

export type MutableCollection = LockedCollectionRow & {
  title: string;
  summary: string | null;
  resourceRevision: string;
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
  deletedCommitOrdinal?: bigint | null;
};

export interface MemoryState extends MemoryBookmarkIconFields {
  now: Date;
  receipts: Map<string, ReceiptRow>;
  ledger: IdLedgerReserveEntry[];
  collections: Map<string, MutableCollection>;
  nodes: Map<string, MutableNode>;
  memberships: MembershipRow[];
  policies: Map<string, { policyJson: Readonly<Record<string, unknown>>; updatedAt: Date }>;
  resourceRevisions: ResourceRevisionInsert[];
  contentRevisions: ContentRevisionInsert[];
  policyRevisions: PolicyRevisionInsert[];
  childrenRevisions: ChildrenRevisionInsert[];
  operations: BootstrapOperationRecord[];
  audit: BootstrapAuditRecord[];
  outbox: BootstrapOutboxRecord[];
  forceInProgress?: boolean;
  productOrigin: string;
  /**
   * After the first listLiveDescendantIds call, invoke this hook (e.g. inject a
   * new descendant) so the second recheck diverges → revision_conflict.
   */
  onAfterFirstDescendantList?: () => void;
  descendantListCalls: number;
}

export const receiptKey = collectionsMemoryReceiptKey;
export const toLockedNode = snapshotLockedNode;
export const createMemoryReceipts = createCollectionsMemoryReceipts;
export const createMemoryAccessPolicyFacts = createCollectionsMemoryAccessPolicyFacts;

/** Live descendants under rootNodeId (excludes rootNodeId), collection-scoped. */
function listLiveDescendants(
  state: MemoryState,
  collectionId: string,
  rootNodeId: string,
): string[] {
  const result: string[] = [];
  const queue = [rootNodeId];
  const seen = new Set<string>([rootNodeId]);
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    for (const n of state.nodes.values()) {
      if (
        n.collectionId === collectionId
        && n.parentId === parentId
        && n.deletedAt === null
        && !n.isRoot
        && !seen.has(n.id)
      ) {
        seen.add(n.id);
        result.push(n.id);
        queue.push(n.id);
      }
    }
  }
  return result;
}

function listLiveSiblingPositions(
  state: MemoryState,
  collectionId: string,
  parentId: string,
): SiblingPositionRow[] {
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
}

/**
 * Create-path canonical stays on state so Product create tests can prove
 * admission does not list siblings via ports.nodes.
 */
function executeCreateCanonical(
  state: MemoryState,
  input: CanonicalMutationInput,
): CanonicalMutationResult {
  const collection = state.collections.get(input.collectionId)!;
  const fields = input.mutation.fields!.kindFields;
  const siblings = [...state.nodes.values()]
    .filter((row) => row.collectionId === input.collectionId
      && row.parentId === input.mutation.parentId && row.deletedAt === null
      && row.positionToken !== null)
    .sort((a, b) => a.positionToken!.localeCompare(b.positionToken!));
  const { beforeToken, afterToken } = resolvePlacement(
    siblings.map((row) => ({ id: row.id, positionToken: row.positionToken! })),
    input.mutation.relativePosition?.afterId,
    input.mutation.relativePosition?.beforeId,
  );
  const ordinal = collection.commitOrdinal + 1n;
  const suffix = `${ordinal}-${state.nodes.size}`;
  const resourceRevision = `canonical-resource-${suffix}`;
  const childrenRevision = `canonical-children-${suffix}`;
  const parentChildrenRevision = `canonical-parent-${suffix}`;
  const contentRevision = `canonical-content-${suffix}`;
  const visibility = String(fields.visibility) as MutableNode['visibility'];
  const policyRevision = visibility === 'inherit' ? undefined : `canonical-policy-${suffix}`;
  const domainEventId = `event-${input.operationId}`;
  const outboxId = `outbox-${suffix}`;
  const positionToken = allocatePosition(
    beforeToken,
    afterToken,
    siblings.map((row) => row.positionToken!),
  );
  for (const entry of [
    { resourceId: input.mutation.target.resourceId, resourceType: 'node' },
    { resourceId: input.operationId, resourceType: 'operation' },
    { resourceId: domainEventId, resourceType: 'domain-event' },
    { resourceId: outboxId, resourceType: 'outbox' },
  ] as const) {
    if (state.ledger.some((existing) => existing.resourceId === entry.resourceId)) {
      throw new Error(`duplicate ledger id ${entry.resourceId}`);
    }
    state.ledger.push(entry);
  }
  state.nodes.set(input.mutation.target.resourceId, {
    id: input.mutation.target.resourceId,
    collectionId: input.collectionId,
    parentId: input.mutation.parentId,
    kind: String(fields.kind) as MutableNode['kind'],
    isRoot: false,
    title: String(fields.title),
    url: fields.url === null ? null : String(fields.url),
    description: fields.description === null ? null : String(fields.description),
    tags: [...fields.tags as readonly string[]],
    visibility,
    positionToken,
    resourceRevision,
    childrenRevision,
    createdAt: new Date(state.now),
    updatedAt: new Date(state.now),
    deletedAt: null,
  });
  const parent = state.nodes.get(input.mutation.parentId!)!;
  parent.childrenRevision = parentChildrenRevision;
  collection.contentRevision = contentRevision;
  collection.commitOrdinal = ordinal;
  if (policyRevision) collection.policyRevision = policyRevision;
  state.resourceRevisions.push({ collectionId: input.collectionId, resourceId: input.mutation.target.resourceId, revision: resourceRevision, ordinal, createdAt: state.now });
  state.contentRevisions.push({ collectionId: input.collectionId, revision: contentRevision, ordinal, createdAt: state.now });
  state.childrenRevisions.push({ collectionId: input.collectionId, parentId: input.mutation.target.resourceId, revision: childrenRevision, ordinal });
  state.childrenRevisions.push({ collectionId: input.collectionId, parentId: input.mutation.parentId!, revision: parentChildrenRevision, ordinal });
  if (policyRevision) state.policyRevisions.push({ collectionId: input.collectionId, revision: policyRevision, ordinal, createdAt: state.now });
  state.operations.push({ operationId: input.operationId, collectionId: input.collectionId, commitOrdinal: ordinal, operationType: 'resource.create', payload: {}, actorPrincipalId: input.actor.principalId, createdAt: state.now });
  state.audit.push({ operationId: input.operationId, collectionId: input.collectionId, principalId: input.actor.principalId, eventType: 'resource.create', details: {}, createdAt: state.now });
  state.outbox.push({ outboxId, domainEventId, eventType: NODE_CREATED_EVENT_TYPE, eventVersion: 1, handlerName: 'node_created_projection', handlerMode: 'projection_latest_only', aggregateType: 'node', aggregateId: input.mutation.target.resourceId, aggregateScope: input.collectionId, aggregateRevision: resourceRevision, commitOrdinal: ordinal, payload: {}, occurredAt: state.now });
  return {
    operationId: input.operationId,
    collectionId: input.collectionId,
    resourceId: input.mutation.target.resourceId,
    action: 'create',
    allocation: {
      commitOrdinal: ordinal,
      resourceRevision,
      createdNodeChildrenRevision: childrenRevision,
      contentRevision,
      ...(policyRevision ? { policyRevision } : {}),
      childrenRevisions: { [input.mutation.parentId!]: parentChildrenRevision },
      positionToken,
    },
  };
}

export function createMemoryWritePorts(state: MemoryState): CollectionsWritePorts {
  return {
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
        throw new Error('insertBootstrap not used by memory collections write ports');
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
        throw new Error('insertRoot not used by memory collections write ports');
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
          deletedCommitOrdinal: null,
        });
      },
      async getNode(collectionId, nodeId) {
        const row = state.nodes.get(nodeId);
        if (!row || row.collectionId !== collectionId) return null;
        return toLockedNode(row);
      },
      async listLiveNodes(collectionId) {
        return [...state.nodes.values()]
          .filter((row) => row.collectionId === collectionId && row.deletedAt === null)
          .map((row) => toLockedNode(row));
      },
      async listLiveSiblingPositions(collectionId, parentId): Promise<readonly SiblingPositionRow[]> {
        return listLiveSiblingPositions(state, collectionId, parentId);
      },
      async hasLiveChildren(collectionId: string, parentId: string) {
        return [...state.nodes.values()].some(
          (n) =>
            n.collectionId === collectionId
            && n.parentId === parentId
            && n.deletedAt === null
            && !n.isRoot,
        );
      },
      async listLiveDescendantIds(collectionId, rootNodeId) {
        state.descendantListCalls += 1;
        const ids = listLiveDescendants(state, collectionId, rootNodeId);
        if (state.descendantListCalls === 1 && state.onAfterFirstDescendantList) {
          state.onAfterFirstDescendantList();
        }
        return ids;
      },
      async updateContent() {
        throw new Error('updateContent not used by memory collections write ports');
      },
      async updatePosition(collectionId, nodeId, update) {
        const row = state.nodes.get(nodeId);
        if (!row || row.collectionId !== collectionId) {
          throw new Error(`missing node ${nodeId}`);
        }
        row.positionToken = update.positionToken;
        row.resourceRevision = update.resourceRevision;
        row.updatedAt = update.updatedAt;
      },
      async updateParentAndPosition() {
        throw new Error('updateParentAndPosition not used by memory collections write ports');
      },
      async advanceChildrenRevision(collectionId, nodeId, childrenRevision, updatedAt) {
        const row = state.nodes.get(nodeId);
        if (!row || row.collectionId !== collectionId) {
          throw new Error(`missing parent ${nodeId}`);
        }
        row.childrenRevision = childrenRevision;
        row.updatedAt = updatedAt;
      },
      async markDeleted(collectionId, nodeId, update: NodeSoftDeleteRow) {
        const row = state.nodes.get(nodeId);
        if (!row || row.collectionId !== collectionId || row.deletedAt !== null) {
          throw new Error(
            `markDeleted expected 1 live row for ${nodeId}`,
          );
        }
        row.deletedAt = update.deletedAt;
        row.deletedCommitOrdinal = update.deletedCommitOrdinal;
        row.resourceRevision = update.resourceRevision;
        row.updatedAt = update.updatedAt;
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
    accessPolicy: createMemoryAccessPolicy(state),
    accessPolicyFacts: createMemoryAccessPolicyFacts(state),
  };
}

/** Complete write capability; facts alone cannot stand in for this port. */
function createMemoryAccessPolicy(state: MemoryState): CollectionsWritePorts['accessPolicy'] {
  return {
    async insertMembership(input) {
      if (state.memberships.some(row => row.collectionId === input.collectionId && row.subjectId === input.subjectId)) {
        throw new Error('membership already exists');
      }
      state.memberships.push({ ...input, grantedAt: new Date(input.grantedAt) });
    },
    async deleteMembership(input) {
      const index = state.memberships.findIndex(row => row.collectionId === input.collectionId && row.subjectId === input.subjectId);
      if (index < 0) return false;
      state.memberships.splice(index, 1);
      return true;
    },
    async upsertCollectionPolicy(input) {
      state.policies.set(input.collectionId, {
        policyJson: structuredClone(input.policyJson ?? {}), updatedAt: new Date(input.updatedAt),
      });
    },
  };
}

export function createMemoryPorts(
  state: MemoryState,
  options: { readonly bookmarkIconsCollectionId?: string } = {},
): CollectionsWritePorts & ProductCollectionCanonicalPorts {
  const writePorts = createMemoryWritePorts(state);
  const iconCollectionId =
    options.bookmarkIconsCollectionId
    ?? [...state.collections.keys()][0]
    ?? 'unknown-collection';
  return {
    ...writePorts,
    accessPolicy: { ...writePorts.accessPolicy, ...writePorts.accessPolicyFacts },
    productOrigin: state.productOrigin,
    bookmarkIcons: createMemoryBookmarkIcons(state, iconCollectionId),
    canonical: {
      async execute(input) {
        if (input.mutation.action === 'create') {
          return executeCreateCanonical(state, input);
        }
        return executeMemoryCanonicalForTests(writePorts, input);
      },
      async bootstrapOwnedCollection() {
        throw new Error('bootstrap not used');
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
    policies: new Map(),
    resourceRevisions: [],
    contentRevisions: [],
    policyRevisions: [],
    childrenRevisions: [],
    operations: [],
    audit: [],
    outbox: [],
    productOrigin: 'https://known.example',
    descendantListCalls: 0,
    ...createMemoryBookmarkIconFields(),
    ...overrides,
  };
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
