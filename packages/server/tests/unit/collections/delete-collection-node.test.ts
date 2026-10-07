/**
 * P1-10 deleteCollectionNode application unit tests (in-memory ports).
 *
 * Production surface (modules/collections):
 *   deleteCollectionNode(ports, input)
 *     → deleted | replay | in_progress | reused | expired
 *   deleteCollectionNodeCommandScope(collectionId, nodeId)
 *     -> collection:{collectionId}:node:{nodeId}:delete
 *   Capability: delete_node (owner/editor; viewer deny; non-member conceal)
 *   Leaf bookmark / empty folder → soft-delete single (scope single)
 *   Non-empty folder without recursive → NodeConflictError folder_not_empty
 *   recursive Folder + If-Content-Match → subtree soft-delete
 *   Stale If-Match → CollectionPreconditionError resource
 *   Stale / missing content fence (recursive) → content precondition or invalid input
 *   Concurrent-ish descendant drift → NodeConflictError revision_conflict
 *   Root → NodeConflictError root_immutable
 *   Bookmark recursive=true → CollectionsError invalid_node_delete
 *   If-Content-Match on non-recursive → CollectionsError invalid_node_input
 *   ID ledger never released for deleted node resource ids
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import type { MembershipRole } from '../../../src/modules/access-policy/index.js';
import {
  CollectionAuthorizationError,
  CollectionPreconditionError,
  CollectionsError,
  NODE_DELETED_EVENT_TYPE,
  NODE_DELETION_PURGE_RETENTION_MS,
  NodeConflictError,
  deleteCollectionNode,
  deleteCollectionNodeCommandScope,
  strongEntityTag,
  type DeleteCollectionNodeInput,
  type DeleteCollectionNodeResult,
} from '../../../src/modules/collections/index.js';
import {
  COMMAND_A,
  COMMAND_B,
  COMMAND_C,
  COMMAND_D,
  FINGERPRINT_A,
  FINGERPRINT_B,
  NOW,
  PRINCIPAL_EDITOR,
  PRINCIPAL_OWNER,
  PRINCIPAL_STRANGER,
  PRINCIPAL_VIEWER,
  SUBJECT_EDITOR,
  SUBJECT_OWNER,
  SUBJECT_STRANGER,
  SUBJECT_VIEWER,
  completedReceipt,
  createMemoryPorts,
  createState,
  expectCode,
  type MemoryState,
  type MutableCollection,
  type MutableNode,
} from '../../support/memory-collections-write-ports.js';

const COLLECTION_ID = 'col-node-delete-1';
const ROOT_ID = 'root-node-delete-1';
const FOLDER_EMPTY = 'folder-empty-delete-1';
const FOLDER_NONEMPTY = 'folder-nonempty-delete-1';
const FOLDER_DEEP = 'folder-deep-delete-1';
const FOLDER_NESTED = 'folder-nested-delete-1';
const BOOKMARK_LEAF = 'bookmark-leaf-delete-1';
const BOOKMARK_IN_FOLDER = 'bookmark-in-folder-delete-1';
const BOOKMARK_DEEP = 'bookmark-deep-delete-1';

const RESOURCE_REV = 'collection-resource-rev';
const CONTENT_REV = 'collection-content-rev';
const POLICY_REV = 'collection-policy-rev';
const ROOT_CHILDREN_REV = 'root-children-rev-1';
const FOLDER_EMPTY_RESOURCE_REV = 'folder-empty-res';
const FOLDER_NONEMPTY_RESOURCE_REV = 'folder-nonempty-res';
const FOLDER_DEEP_RESOURCE_REV = 'folder-deep-res';
const FOLDER_NESTED_RESOURCE_REV = 'folder-nested-res';
const BOOKMARK_LEAF_RESOURCE_REV = 'bookmark-leaf-res';
const BOOKMARK_IN_FOLDER_RESOURCE_REV = 'bookmark-in-folder-res';
const BOOKMARK_DEEP_RESOURCE_REV = 'bookmark-deep-res';
const OPERATION_ID = 'op-node-delete-1';

function seedCollection(
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
    title: 'Node Delete Collection',
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
    deletedCommitOrdinal: null,
  });

  return row;
}

function seedNode(
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
    deletedCommitOrdinal: null,
  };
  state.nodes.set(options.id, row);
  return row;
}

/**
 * Tree:
 *   ROOT
 *     BOOKMARK_LEAF
 *     FOLDER_EMPTY (no children)
 *     FOLDER_NONEMPTY
 *       BOOKMARK_IN_FOLDER
 *     FOLDER_DEEP
 *       FOLDER_NESTED
 *         BOOKMARK_DEEP
 */
function seedStandardTree(state: MemoryState): void {
  seedCollection(state, {
    memberships: [
      { subjectId: SUBJECT_EDITOR, role: 'editor' },
      { subjectId: SUBJECT_VIEWER, role: 'viewer' },
    ],
  });
  seedNode(state, {
    id: BOOKMARK_LEAF,
    parentId: ROOT_ID,
    kind: 'bookmark',
    positionToken: 'a',
    resourceRevision: BOOKMARK_LEAF_RESOURCE_REV,
  });
  seedNode(state, {
    id: FOLDER_EMPTY,
    parentId: ROOT_ID,
    positionToken: 'b',
    resourceRevision: FOLDER_EMPTY_RESOURCE_REV,
    childrenRevision: 'folder-empty-ch',
  });
  seedNode(state, {
    id: FOLDER_NONEMPTY,
    parentId: ROOT_ID,
    positionToken: 'c',
    resourceRevision: FOLDER_NONEMPTY_RESOURCE_REV,
    childrenRevision: 'folder-nonempty-ch',
  });
  seedNode(state, {
    id: BOOKMARK_IN_FOLDER,
    parentId: FOLDER_NONEMPTY,
    kind: 'bookmark',
    positionToken: 'a',
    resourceRevision: BOOKMARK_IN_FOLDER_RESOURCE_REV,
  });
  seedNode(state, {
    id: FOLDER_DEEP,
    parentId: ROOT_ID,
    positionToken: 'd',
    resourceRevision: FOLDER_DEEP_RESOURCE_REV,
    childrenRevision: 'folder-deep-ch',
  });
  seedNode(state, {
    id: FOLDER_NESTED,
    parentId: FOLDER_DEEP,
    positionToken: 'a',
    resourceRevision: FOLDER_NESTED_RESOURCE_REV,
    childrenRevision: 'folder-nested-ch',
  });
  seedNode(state, {
    id: BOOKMARK_DEEP,
    parentId: FOLDER_NESTED,
    kind: 'bookmark',
    positionToken: 'a',
    resourceRevision: BOOKMARK_DEEP_RESOURCE_REV,
  });
}

function baseInput(overrides: Partial<DeleteCollectionNodeInput> = {}): DeleteCollectionNodeInput {
  const collectionId = overrides.collectionId ?? COLLECTION_ID;
  const nodeId = overrides.nodeId ?? BOOKMARK_LEAF;
  const recursive = overrides.recursive ?? false;

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
      commandScope: deleteCollectionNodeCommandScope(collectionId, nodeId),
      ...overrides.command,
    },
    collectionId,
    nodeId,
    ifMatch: overrides.ifMatch ?? strongEntityTag(BOOKMARK_LEAF_RESOURCE_REV),
    recursive,
    ifContentMatch: Object.hasOwn(overrides, 'ifContentMatch')
      ? overrides.ifContentMatch
      : recursive
        ? strongEntityTag(CONTENT_REV)
        : null,
    operationId: overrides.operationId ?? OPERATION_ID,
  };
}

function assertDeleted(
  outcome: DeleteCollectionNodeResult,
): Extract<DeleteCollectionNodeResult, { kind: 'deleted' }> {
  assert.equal(outcome.kind, 'deleted', `expected deleted, got ${outcome.kind}`);
  return outcome as Extract<DeleteCollectionNodeResult, { kind: 'deleted' }>;
}

// ---------------------------------------------------------------------------
// Command scope
// ---------------------------------------------------------------------------

describe('deleteCollectionNode: command scope helper', () => {
  test('scope includes concrete collection and node ids', () => {
    assert.equal(
      deleteCollectionNodeCommandScope(COLLECTION_ID, BOOKMARK_LEAF),
      `collection:${COLLECTION_ID}:node:${BOOKMARK_LEAF}:delete`,
    );
  });
});

// ---------------------------------------------------------------------------
// Leaf bookmark delete
// ---------------------------------------------------------------------------

describe('deleteCollectionNode: leaf bookmark', () => {
  test('soft-deletes bookmark; advances parent children + content; side effects', async () => {
    const state = createState();
    seedStandardTree(state);
    // Pre-reserve node resource id in ledger (create path would have done this).
    state.ledger.push({ resourceId: BOOKMARK_LEAF, resourceType: 'node' });
    const ports = createMemoryPorts(state);

    const deleted = assertDeleted(await deleteCollectionNode(ports, baseInput()));

    assert.equal(deleted.receipt.resourceType, 'node');
    assert.equal(deleted.receipt.targetId, BOOKMARK_LEAF);
    assert.equal(deleted.receipt.collectionId, COLLECTION_ID);
    assert.equal(deleted.receipt.scope, 'single');
    assert.equal(deleted.receipt.affectedCount, 1);
    assert.equal(deleted.receipt.operationId, OPERATION_ID);
    assert.equal(deleted.receipt.deletedAt, '2026-07-22T12:00:00Z');
    assert.equal(
      deleted.receipt.purgeAfter,
      new Date(NOW.getTime() + NODE_DELETION_PURGE_RETENTION_MS).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    );
    // deleteRevision is the deleted target's tombstone revision, not the
    // collection content fence (which stays in fence.contentRevision).
    assert.equal(deleted.receipt.deleteRevision, state.nodes.get(BOOKMARK_LEAF)!.resourceRevision);
    assert.notEqual(deleted.receipt.deleteRevision, deleted.fence.contentRevision);

    assert.equal(deleted.parent.id, ROOT_ID);
    assert.notEqual(deleted.parent.childrenRevision, ROOT_CHILDREN_REV);
    assert.equal(
      deleted.parent.childrenEtag,
      strongEntityTag(deleted.parent.childrenRevision),
    );

    assert.notEqual(deleted.fence.contentRevision, CONTENT_REV);
    assert.equal(deleted.fence.policyRevision, POLICY_REV);
    assert.equal(deleted.fence.contentEtag, strongEntityTag(deleted.fence.contentRevision));
    assert.equal(deleted.operationId, OPERATION_ID);
    assert.equal(deleted.commitOrdinal, 3n);

    const stored = state.nodes.get(BOOKMARK_LEAF)!;
    assert.ok(stored.deletedAt);
    assert.equal(stored.deletedCommitOrdinal, 3n);
    assert.equal(state.nodes.get(ROOT_ID)!.childrenRevision, deleted.parent.childrenRevision);
    assert.equal(state.collections.get(COLLECTION_ID)!.contentRevision, deleted.fence.contentRevision);
    assert.equal(state.collections.get(COLLECTION_ID)!.commitOrdinal, 3n);

    assert.equal(state.operations.length, 1);
    assert.equal(state.operations[0]!.operationType, 'resource.delete');
    assert.equal(state.audit.length, 1);
    assert.equal(state.audit[0]!.eventType, 'resource.delete');
    assert.equal(state.outbox.length, 1);
    assert.equal(state.outbox[0]!.eventType, NODE_DELETED_EVENT_TYPE);
    assert.equal(state.outbox[0]!.aggregateId, BOOKMARK_LEAF);
    assert.equal(state.contentRevisions.length, 1);
    assert.ok(state.childrenRevisions.some((r) => r.parentId === ROOT_ID));

    // ID ledger entry for the deleted node is never freed.
    assert.ok(state.ledger.some((e) => e.resourceId === BOOKMARK_LEAF && e.resourceType === 'node'));
  });
});

// ---------------------------------------------------------------------------
// Empty folder delete
// ---------------------------------------------------------------------------

describe('deleteCollectionNode: empty folder', () => {
  test('non-recursive soft-deletes empty folder (scope single)', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    const deleted = assertDeleted(
      await deleteCollectionNode(
        ports,
        baseInput({
          nodeId: FOLDER_EMPTY,
          ifMatch: strongEntityTag(FOLDER_EMPTY_RESOURCE_REV),
          recursive: false,
          ifContentMatch: null,
          operationId: 'op-empty-folder',
        }),
      ),
    );

    assert.equal(deleted.receipt.scope, 'single');
    assert.equal(deleted.receipt.affectedCount, 1);
    assert.equal(deleted.receipt.targetId, FOLDER_EMPTY);
    assert.equal(deleted.receipt.deleteRevision, state.nodes.get(FOLDER_EMPTY)!.resourceRevision);
    assert.ok(state.nodes.get(FOLDER_EMPTY)!.deletedAt);
    assert.equal(state.nodes.get(FOLDER_EMPTY)!.deletedCommitOrdinal, 3n);
  });

  test('recursive=true empty folder still requires content fence and uses subtree scope', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    const deleted = assertDeleted(
      await deleteCollectionNode(
        ports,
        baseInput({
          nodeId: FOLDER_EMPTY,
          ifMatch: strongEntityTag(FOLDER_EMPTY_RESOURCE_REV),
          recursive: true,
          ifContentMatch: strongEntityTag(CONTENT_REV),
          command: { commandId: COMMAND_B, fingerprint: FINGERPRINT_B },
          operationId: 'op-empty-recursive',
        }),
      ),
    );

    assert.equal(deleted.receipt.scope, 'subtree');
    assert.equal(deleted.receipt.affectedCount, 1);
    assert.ok(state.nodes.get(FOLDER_EMPTY)!.deletedAt);
    assert.equal(state.descendantListCalls, 2);
  });
});

// ---------------------------------------------------------------------------
// Non-empty folder without recursive
// ---------------------------------------------------------------------------

describe('deleteCollectionNode: non-empty folder without recursive', () => {
  test('folder_not_empty when live children present', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        deleteCollectionNode(
          ports,
          baseInput({
            nodeId: FOLDER_NONEMPTY,
            ifMatch: strongEntityTag(FOLDER_NONEMPTY_RESOURCE_REV),
            recursive: false,
            ifContentMatch: null,
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof NodeConflictError);
        assert.equal(error.code, 'folder_not_empty');
        return true;
      },
    );

    assert.equal(state.nodes.get(FOLDER_NONEMPTY)!.deletedAt, null);
    assert.equal(state.nodes.get(BOOKMARK_IN_FOLDER)!.deletedAt, null);
    assert.equal(state.operations.length, 0);
    assert.equal(state.collections.get(COLLECTION_ID)!.contentRevision, CONTENT_REV);
  });
});

// ---------------------------------------------------------------------------
// Recursive folder delete with If-Content-Match
// ---------------------------------------------------------------------------

describe('deleteCollectionNode: recursive subtree', () => {
  test('deletes folder and all live descendants; advances fences', async () => {
    const state = createState();
    seedStandardTree(state);
    for (const id of [FOLDER_DEEP, FOLDER_NESTED, BOOKMARK_DEEP]) {
      state.ledger.push({ resourceId: id, resourceType: 'node' });
    }
    const ports = createMemoryPorts(state);

    const deleted = assertDeleted(
      await deleteCollectionNode(
        ports,
        baseInput({
          nodeId: FOLDER_DEEP,
          ifMatch: strongEntityTag(FOLDER_DEEP_RESOURCE_REV),
          recursive: true,
          ifContentMatch: strongEntityTag(CONTENT_REV),
          operationId: 'op-subtree',
        }),
      ),
    );

    assert.equal(deleted.receipt.scope, 'subtree');
    assert.equal(deleted.receipt.affectedCount, 3);
    assert.equal(deleted.parent.id, ROOT_ID);
    assert.notEqual(deleted.parent.childrenRevision, ROOT_CHILDREN_REV);
    assert.notEqual(deleted.fence.contentRevision, CONTENT_REV);

    // Receipt revision is the request target's tombstone (FOLDER_DEEP), never
    // a planned member or the collection content fence.
    assert.equal(deleted.receipt.deleteRevision, state.nodes.get(FOLDER_DEEP)!.resourceRevision);
    assert.notEqual(deleted.receipt.deleteRevision, state.nodes.get(BOOKMARK_DEEP)!.resourceRevision);
    assert.notEqual(deleted.receipt.deleteRevision, deleted.fence.contentRevision);

    assert.ok(state.nodes.get(FOLDER_DEEP)!.deletedAt);
    assert.ok(state.nodes.get(FOLDER_NESTED)!.deletedAt);
    assert.ok(state.nodes.get(BOOKMARK_DEEP)!.deletedAt);
    assert.equal(state.nodes.get(FOLDER_DEEP)!.deletedCommitOrdinal, 3n);
    assert.equal(state.nodes.get(FOLDER_NESTED)!.deletedCommitOrdinal, 3n);
    assert.equal(state.nodes.get(BOOKMARK_DEEP)!.deletedCommitOrdinal, 3n);

    // Unrelated siblings untouched.
    assert.equal(state.nodes.get(BOOKMARK_LEAF)!.deletedAt, null);
    assert.equal(state.nodes.get(FOLDER_NONEMPTY)!.deletedAt, null);

    const opPayload = state.operations[0]!.payload as {
      deletedNodeIds: string[];
      affectedCount: number;
      scope: string;
    };
    assert.equal(opPayload.scope, 'subtree');
    assert.equal(opPayload.affectedCount, 3);
    assert.deepEqual(
      [...opPayload.deletedNodeIds].sort(),
      [BOOKMARK_DEEP, FOLDER_DEEP, FOLDER_NESTED].sort(),
    );

    // Ledger entries for deleted nodes remain reserved.
    for (const id of [FOLDER_DEEP, FOLDER_NESTED, BOOKMARK_DEEP]) {
      assert.ok(state.ledger.some((e) => e.resourceId === id && e.resourceType === 'node'));
    }
  });

  test('shallow non-empty folder recursive delete includes direct child only', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    const deleted = assertDeleted(
      await deleteCollectionNode(
        ports,
        baseInput({
          nodeId: FOLDER_NONEMPTY,
          ifMatch: strongEntityTag(FOLDER_NONEMPTY_RESOURCE_REV),
          recursive: true,
          ifContentMatch: strongEntityTag(CONTENT_REV),
          command: { commandId: COMMAND_B, fingerprint: FINGERPRINT_B },
          operationId: 'op-shallow-subtree',
        }),
      ),
    );

    assert.equal(deleted.receipt.affectedCount, 2);
    assert.ok(state.nodes.get(FOLDER_NONEMPTY)!.deletedAt);
    assert.ok(state.nodes.get(BOOKMARK_IN_FOLDER)!.deletedAt);
  });
});

// ---------------------------------------------------------------------------
// Content fence / recursive confirm
// ---------------------------------------------------------------------------

describe('deleteCollectionNode: content fence and recursive rules', () => {
  test('recursive without ifContentMatch → invalid_node_input (defense in depth)', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        deleteCollectionNode(
          ports,
          baseInput({
            nodeId: FOLDER_EMPTY,
            ifMatch: strongEntityTag(FOLDER_EMPTY_RESOURCE_REV),
            recursive: true,
            ifContentMatch: null,
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof CollectionsError);
        expectCode(error, 'invalid_node_input');
        return true;
      },
    );
    assert.equal(state.operations.length, 0);
  });

  test('stale If-Content-Match → CollectionPreconditionError content', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        deleteCollectionNode(
          ports,
          baseInput({
            nodeId: FOLDER_DEEP,
            ifMatch: strongEntityTag(FOLDER_DEEP_RESOURCE_REV),
            recursive: true,
            ifContentMatch: strongEntityTag('stale-content-rev'),
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof CollectionPreconditionError);
        assert.equal(error.code, 'precondition_failed');
        assert.equal(error.precondition, 'content');
        assert.equal(error.currentEtag, strongEntityTag(CONTENT_REV));
        return true;
      },
    );
    assert.equal(state.nodes.get(FOLDER_DEEP)!.deletedAt, null);
    assert.equal(state.operations.length, 0);
  });

  test('If-Content-Match on non-recursive → invalid_node_input', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        deleteCollectionNode(
          ports,
          baseInput({
            nodeId: BOOKMARK_LEAF,
            ifMatch: strongEntityTag(BOOKMARK_LEAF_RESOURCE_REV),
            recursive: false,
            ifContentMatch: strongEntityTag(CONTENT_REV),
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof CollectionsError);
        expectCode(error, 'invalid_node_input');
        return true;
      },
    );
    assert.equal(state.nodes.get(BOOKMARK_LEAF)!.deletedAt, null);
  });

  test('Bookmark recursive=true → invalid_node_delete', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        deleteCollectionNode(
          ports,
          baseInput({
            nodeId: BOOKMARK_LEAF,
            ifMatch: strongEntityTag(BOOKMARK_LEAF_RESOURCE_REV),
            recursive: true,
            ifContentMatch: strongEntityTag(CONTENT_REV),
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof CollectionsError);
        expectCode(error, 'invalid_node_delete');
        return true;
      },
    );
    assert.equal(state.operations.length, 0);
  });

  test('stale node If-Match → CollectionPreconditionError resource', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        deleteCollectionNode(
          ports,
          baseInput({
            ifMatch: strongEntityTag('stale-node-revision'),
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof CollectionPreconditionError);
        assert.equal(error.precondition, 'resource');
        assert.equal(error.currentEtag, strongEntityTag(BOOKMARK_LEAF_RESOURCE_REV));
        return true;
      },
    );
    assert.equal(state.operations.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Concurrent-ish subtree (descendant added after confirm / between rechecks)
// ---------------------------------------------------------------------------

describe('deleteCollectionNode: concurrent-ish subtree drift', () => {
  test('descendant injected between list rechecks → revision_conflict', async () => {
    const state = createState();
    seedStandardTree(state);
    state.onAfterFirstDescendantList = () => {
      seedNode(state, {
        id: 'injected-after-confirm',
        parentId: FOLDER_NESTED,
        kind: 'bookmark',
        positionToken: 'z',
        resourceRevision: 'injected-res',
      });
    };
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        deleteCollectionNode(
          ports,
          baseInput({
            nodeId: FOLDER_DEEP,
            ifMatch: strongEntityTag(FOLDER_DEEP_RESOURCE_REV),
            recursive: true,
            ifContentMatch: strongEntityTag(CONTENT_REV),
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof NodeConflictError);
        assert.equal(error.code, 'revision_conflict');
        return true;
      },
    );

    assert.equal(state.descendantListCalls, 2);
    assert.equal(state.nodes.get(FOLDER_DEEP)!.deletedAt, null);
    assert.equal(state.nodes.get(FOLDER_NESTED)!.deletedAt, null);
    assert.equal(state.nodes.get(BOOKMARK_DEEP)!.deletedAt, null);
    assert.equal(state.nodes.get('injected-after-confirm')!.deletedAt, null);
    assert.equal(state.operations.length, 0);
  });

  test('content fence fails when collection content advanced after confirm snapshot', async () => {
    const state = createState();
    seedStandardTree(state);
    // Simulate another mutation advancing content after the client read contentEtag.
    state.collections.get(COLLECTION_ID)!.contentRevision = 'content-after-other-mutation';
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        deleteCollectionNode(
          ports,
          baseInput({
            nodeId: FOLDER_DEEP,
            ifMatch: strongEntityTag(FOLDER_DEEP_RESOURCE_REV),
            recursive: true,
            ifContentMatch: strongEntityTag(CONTENT_REV),
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof CollectionPreconditionError);
        assert.equal(error.precondition, 'content');
        assert.equal(
          error.currentEtag,
          strongEntityTag('content-after-other-mutation'),
        );
        return true;
      },
    );
    assert.equal(state.operations.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Root immutable
// ---------------------------------------------------------------------------

describe('deleteCollectionNode: root immutable', () => {
  test('root delete → NodeConflictError root_immutable', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        deleteCollectionNode(
          ports,
          baseInput({
            nodeId: ROOT_ID,
            ifMatch: strongEntityTag('root-resource-rev'),
            recursive: false,
            ifContentMatch: null,
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof NodeConflictError);
        assert.equal(error.code, 'root_immutable');
        return true;
      },
    );
    assert.equal(state.nodes.get(ROOT_ID)!.deletedAt, null);
    assert.equal(state.operations.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe('deleteCollectionNode: authorization', () => {
  test('owner and editor allowed; viewer denied; stranger concealed', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    assertDeleted(
      await deleteCollectionNode(
        ports,
        baseInput({
          actor: {
            principalId: PRINCIPAL_OWNER,
            principalType: 'account',
            subjectId: SUBJECT_OWNER,
          },
          nodeId: BOOKMARK_LEAF,
          ifMatch: strongEntityTag(BOOKMARK_LEAF_RESOURCE_REV),
          command: { commandId: COMMAND_A, fingerprint: FINGERPRINT_A },
          operationId: 'op-owner-del',
        }),
      ),
    );

    const contentAfterOwner = state.collections.get(COLLECTION_ID)!.contentRevision;

    assertDeleted(
      await deleteCollectionNode(
        ports,
        baseInput({
          actor: {
            principalId: PRINCIPAL_EDITOR,
            principalType: 'account',
            subjectId: SUBJECT_EDITOR,
          },
          nodeId: FOLDER_EMPTY,
          ifMatch: strongEntityTag(FOLDER_EMPTY_RESOURCE_REV),
          command: { commandId: COMMAND_B, fingerprint: FINGERPRINT_B },
          operationId: 'op-editor-del',
        }),
      ),
    );

    await assert.rejects(
      () =>
        deleteCollectionNode(
          ports,
          baseInput({
            actor: {
              principalId: PRINCIPAL_VIEWER,
              principalType: 'account',
              subjectId: SUBJECT_VIEWER,
            },
            nodeId: BOOKMARK_IN_FOLDER,
            ifMatch: strongEntityTag(BOOKMARK_IN_FOLDER_RESOURCE_REV),
            command: { commandId: COMMAND_C, fingerprint: FINGERPRINT_A },
            operationId: 'op-viewer-del',
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof CollectionAuthorizationError);
        assert.equal(error.outcome, 'deny');
        return true;
      },
    );

    await assert.rejects(
      () =>
        deleteCollectionNode(
          ports,
          baseInput({
            actor: {
              principalId: PRINCIPAL_STRANGER,
              principalType: 'account',
              subjectId: SUBJECT_STRANGER,
            },
            nodeId: BOOKMARK_IN_FOLDER,
            ifMatch: strongEntityTag(BOOKMARK_IN_FOLDER_RESOURCE_REV),
            command: { commandId: COMMAND_D, fingerprint: FINGERPRINT_B },
            operationId: 'op-stranger-del',
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof CollectionAuthorizationError);
        assert.equal(error.outcome, 'conceal');
        return true;
      },
    );

    assert.equal(state.nodes.get(BOOKMARK_IN_FOLDER)!.deletedAt, null);
    assert.notEqual(contentAfterOwner, CONTENT_REV);
  });

  test('already soft-deleted node conceals', async () => {
    const state = createState();
    seedStandardTree(state);
    state.nodes.get(BOOKMARK_LEAF)!.deletedAt = new Date(NOW);
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () => deleteCollectionNode(ports, baseInput()),
      (error: unknown) => {
        assert.ok(error instanceof CollectionAuthorizationError);
        assert.equal(error.outcome, 'conceal');
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Command admission: exact retry / reuse / in_progress / failed validation
// ---------------------------------------------------------------------------

describe('deleteCollectionNode: command admission', () => {
  test('exact command retry → replay, no double delete', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);
    const input = baseInput();

    const first = assertDeleted(await deleteCollectionNode(ports, input));
    const product = completedReceipt(state);
    const opCount = state.operations.length;
    const commit = state.collections.get(COLLECTION_ID)!.commitOrdinal;
    const deletedAt = state.nodes.get(BOOKMARK_LEAF)!.deletedAt;

    const second = await deleteCollectionNode(ports, input);
    assert.equal(second.kind, 'replay');
    if (second.kind !== 'replay') return;

    assert.equal(second.status, 200);
    assert.equal(second.status, product.status);
    assert.deepEqual(second.stableHeaders, product.stableHeaders);
    assert.deepEqual(
      Buffer.from(second.body).toString('hex'),
      Buffer.from(product.body).toString('hex'),
    );
    // No ETag on delete success (deleted resource has no representation ETag).
    assert.equal(second.stableHeaders.etag, undefined);
    assert.equal(second.stableHeaders['cache-control'], 'private, no-store');

    assert.equal(state.operations.length, opCount);
    assert.equal(state.collections.get(COLLECTION_ID)!.commitOrdinal, commit);
    assert.equal(state.nodes.get(BOOKMARK_LEAF)!.deletedAt?.getTime(), deletedAt?.getTime());
    void first;
  });

  test('same command_id different fingerprint → reused without writes', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    assertDeleted(
      await deleteCollectionNode(
        ports,
        baseInput({
          command: { commandId: COMMAND_A, fingerprint: FINGERPRINT_A },
        }),
      ),
    );
    const after = {
      operations: state.operations.length,
      commit: state.collections.get(COLLECTION_ID)!.commitOrdinal,
    };

    // Same command scope (same collectionId/nodeId) is required for fingerprint
    // collision; a different nodeId is a different Product command binding.
    const reused = await deleteCollectionNode(
      ports,
      baseInput({
        command: { commandId: COMMAND_A, fingerprint: FINGERPRINT_B },
      }),
    );
    assert.equal(reused.kind, 'reused');
    assert.equal(state.operations.length, after.operations);
    assert.equal(state.collections.get(COLLECTION_ID)!.commitOrdinal, after.commit);
    // Already soft-deleted by the first command; no second domain write occurred.
    assert.ok(state.nodes.get(BOOKMARK_LEAF)!.deletedAt !== null);
  });

  test('in_progress claim returns without domain writes', async () => {
    const state = createState({ forceInProgress: true });
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    const outcome = await deleteCollectionNode(ports, baseInput());
    assert.equal(outcome.kind, 'in_progress');
    assert.equal(state.operations.length, 0);
    assert.equal(state.ledger.length, 0);
    assert.equal(state.nodes.get(BOOKMARK_LEAF)!.deletedAt, null);
  });

  test('failed validation after claim must not complete receipt with success', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        deleteCollectionNode(
          ports,
          baseInput({
            ifMatch: strongEntityTag('stale'),
          }),
        ),
      (error: unknown) => {
        assert.ok(
          error instanceof CollectionPreconditionError
            || error instanceof NodeConflictError
            || error instanceof CollectionsError,
        );
        return true;
      },
    );

    for (const row of state.receipts.values()) {
      assert.notEqual(row.status, 'completed');
    }
  });
});

// ---------------------------------------------------------------------------
// ID ledger never freed
// ---------------------------------------------------------------------------

describe('deleteCollectionNode: ID ledger not freed', () => {
  test('soft-delete does not remove prior node ledger reservations', async () => {
    const state = createState();
    seedStandardTree(state);
    state.ledger.push(
      { resourceId: BOOKMARK_LEAF, resourceType: 'node' },
      { resourceId: FOLDER_DEEP, resourceType: 'node' },
      { resourceId: FOLDER_NESTED, resourceType: 'node' },
      { resourceId: BOOKMARK_DEEP, resourceType: 'node' },
    );
    const priorLedger = state.ledger.map((e) => ({ ...e }));
    const ports = createMemoryPorts(state);

    assertDeleted(
      await deleteCollectionNode(
        ports,
        baseInput({
          nodeId: FOLDER_DEEP,
          ifMatch: strongEntityTag(FOLDER_DEEP_RESOURCE_REV),
          recursive: true,
          ifContentMatch: strongEntityTag(CONTENT_REV),
          operationId: 'op-ledger-check',
        }),
      ),
    );

    for (const entry of priorLedger) {
      assert.ok(
        state.ledger.some(
          (e) => e.resourceId === entry.resourceId && e.resourceType === entry.resourceType,
        ),
        `ledger missing ${entry.resourceType}:${entry.resourceId}`,
      );
    }
    // New operation/event/outbox ids were reserved; node ids not released.
    assert.ok(state.ledger.length > priorLedger.length);
  });
});
