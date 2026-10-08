/**
 * P1-09 moveCollectionNode application unit tests (in-memory ports).
 *
 * Expected production surface (aligned with create/update-collection-node):
 *   moveCollectionNode(ports, input)
 *     → moved | replay | in_progress | reused | expired
 *   moveCollectionNodeCommandScope(collectionId, nodeId)
 *     -> collection:{collectionId}:node:{nodeId}:move
 *   Capability: move_node (owner/editor; viewer deny; non-member conceal)
 *   Root → NodeConflictError root_immutable (409)
 *   Stale If-Match → CollectionPreconditionError (412)
 *   Stale baseSource/baseTarget parent children revision
 *     → NodeConflictError position_context_stale (409)
 *   Cycle / invalid parent / cross-collection → CollectionsError invalid_node_parent
 *
 * MoveNodeResult shape (success):
 *   { node, sourceParent, targetParent, fence }
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  CollectionAuthorizationError,
  CollectionPreconditionError,
  CollectionsError,
  NODE_MOVED_EVENT_TYPE,
  NodeConflictError,
  moveCollectionNode,
  strongEntityTag,
  type SiblingPositionRow,
} from '../../../src/modules/collections/index.js';
import {
  COMMAND_A,
  COMMAND_B,
  COMMAND_C,
  COMMAND_D,
  PRINCIPAL_OWNER,
  SUBJECT_OWNER,
  PRINCIPAL_EDITOR,
  SUBJECT_EDITOR,
  PRINCIPAL_VIEWER,
  SUBJECT_VIEWER,
  PRINCIPAL_STRANGER,
  SUBJECT_STRANGER,
  FINGERPRINT_A,
  FINGERPRINT_B,
  COLLECTION_ID,
  OTHER_COLLECTION_ID,
  ROOT_ID,
  FOLDER_A,
  FOLDER_B,
  FOLDER_CHILD,
  BOOKMARK_ID,
  SIBLING_A,
  SIBLING_B,
  SIBLING_C,
  MOVE_TARGET,
  CONTENT_REV,
  POLICY_REV,
  ROOT_CHILDREN_REV,
  FOLDER_A_CHILDREN_REV,
  FOLDER_B_CHILDREN_REV,
  MOVE_TARGET_RESOURCE_REV,
  OPERATION_ID,
  createMemoryPorts,
  createState,
  seedCollection,
  seedNode,
  seedStandardTree,
  baseInput,
  assertMoved,
  completedReceipt,
  expectCode,
  parentChildren,
} from '../../support/move-collection-node-memory.js';

describe('moveCollectionNode: same parent reorder', () => {
  test('delegates placement reads to canonical without listing every sibling', async () => {
    const state = createState();
    seedStandardTree(state);
    const basePorts = createMemoryPorts(state);
    let fullSiblingReads = 0;
    const ports = {
      ...basePorts,
      nodes: {
        ...basePorts.nodes,
        async listLiveSiblingPositions(): Promise<readonly SiblingPositionRow[]> {
          fullSiblingReads += 1;
          throw new Error('Product move must not list all live sibling positions');
        },
      },
    };

    assertMoved(await moveCollectionNode(ports, baseInput({
      newParentId: ROOT_ID,
      afterId: SIBLING_A,
      beforeId: BOOKMARK_ID,
    })));
    assert.equal(fullSiblingReads, 0);
  });

  test('reorders under root between anchors; advances source=target children + content', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    // Move target currently at 't'; place after sibling-a (before sibling next).
    const moved = assertMoved(
      await moveCollectionNode(
        ports,
        baseInput({
          newParentId: ROOT_ID,
          afterId: SIBLING_A,
          beforeId: null,
          baseSourceParentRevision: ROOT_CHILDREN_REV,
          baseTargetParentRevision: ROOT_CHILDREN_REV,
        }),
      ),
    );

    assert.equal(moved.node.id, MOVE_TARGET);
    assert.equal(moved.node.parentId, ROOT_ID);
    assert.equal(typeof moved.node.position, 'string');
    assert.ok((moved.node.position as string) > 'a');

    assert.equal(moved.sourceParent.id, ROOT_ID);
    assert.equal(moved.targetParent.id, ROOT_ID);
    assert.equal(moved.sourceParent.childrenRevision, moved.targetParent.childrenRevision);
    assert.notEqual(moved.sourceParent.childrenRevision, ROOT_CHILDREN_REV);
    assert.equal(
      moved.sourceParent.childrenEtag,
      strongEntityTag(moved.sourceParent.childrenRevision),
    );

    assert.notEqual(moved.fence.contentRevision, CONTENT_REV);
    assert.equal(moved.fence.policyRevision, POLICY_REV);
    assert.equal(moved.fence.contentEtag, strongEntityTag(moved.fence.contentRevision));
    assert.equal(moved.node.etag, strongEntityTag(moved.node.revision));
    assert.notEqual(moved.node.revision, MOVE_TARGET_RESOURCE_REV);

    const stored = state.nodes.get(MOVE_TARGET)!;
    assert.equal(stored.parentId, ROOT_ID);
    assert.equal(stored.positionToken, moved.node.position);
    assert.equal(parentChildren(state, ROOT_ID), moved.sourceParent.childrenRevision);

    assert.equal(state.operations.length, 1);
    assert.equal(state.operations[0]!.operationType, 'resource.move');
    assert.equal(state.audit.length, 1);
    assert.equal(state.audit[0]!.eventType, 'resource.move');
    assert.equal(state.outbox.length, 1);
    assert.equal(state.outbox[0]!.eventType, NODE_MOVED_EVENT_TYPE);
  });

  test('append at end with both anchors null', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    const moved = assertMoved(
      await moveCollectionNode(
        ports,
        baseInput({
          newParentId: ROOT_ID,
          afterId: null,
          beforeId: null,
          baseSourceParentRevision: ROOT_CHILDREN_REV,
          baseTargetParentRevision: ROOT_CHILDREN_REV,
        }),
      ),
    );

    assert.equal(moved.node.parentId, ROOT_ID);
    const siblings = [...state.nodes.values()]
      .filter((n) => n.parentId === ROOT_ID && n.positionToken && n.deletedAt === null)
      .sort((a, b) => (a.positionToken! < b.positionToken! ? -1 : 1));
    assert.equal(siblings[siblings.length - 1]!.id, MOVE_TARGET);
  });
});

// ---------------------------------------------------------------------------
// Cross-parent move (same collection)
// ---------------------------------------------------------------------------

describe('moveCollectionNode: cross parent move', () => {
  test('moves node from root into folder-a; advances both parent children revisions', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    const moved = assertMoved(
      await moveCollectionNode(
        ports,
        baseInput({
          newParentId: FOLDER_A,
          afterId: null,
          beforeId: null,
          baseSourceParentRevision: ROOT_CHILDREN_REV,
          baseTargetParentRevision: FOLDER_A_CHILDREN_REV,
        }),
      ),
    );

    assert.equal(moved.node.parentId, FOLDER_A);
    assert.equal(moved.sourceParent.id, ROOT_ID);
    assert.equal(moved.targetParent.id, FOLDER_A);
    assert.notEqual(moved.sourceParent.childrenRevision, ROOT_CHILDREN_REV);
    assert.notEqual(moved.targetParent.childrenRevision, FOLDER_A_CHILDREN_REV);
    // Distinct parents should receive independent revision tokens.
    assert.notEqual(
      moved.sourceParent.childrenRevision,
      moved.targetParent.childrenRevision,
    );

    const stored = state.nodes.get(MOVE_TARGET)!;
    assert.equal(stored.parentId, FOLDER_A);
    assert.equal(parentChildren(state, ROOT_ID), moved.sourceParent.childrenRevision);
    assert.equal(parentChildren(state, FOLDER_A), moved.targetParent.childrenRevision);

    assert.notEqual(state.collections.get(COLLECTION_ID)!.contentRevision, CONTENT_REV);
    assert.equal(state.collections.get(COLLECTION_ID)!.policyRevision, POLICY_REV);
    assert.ok(state.childrenRevisions.some((r) => r.parentId === ROOT_ID));
    assert.ok(state.childrenRevisions.some((r) => r.parentId === FOLDER_A));
  });

  test('moves bookmark under folder-b after existing child', async () => {
    const state = createState();
    seedStandardTree(state);
    seedNode(state, {
      id: 'folder-b-child',
      parentId: FOLDER_B,
      positionToken: 'a',
      resourceRevision: 'fb-child-res',
    });
    const ports = createMemoryPorts(state);

    const moved = assertMoved(
      await moveCollectionNode(
        ports,
        baseInput({
          nodeId: BOOKMARK_ID,
          ifMatch: strongEntityTag('bookmark-res'),
          newParentId: FOLDER_B,
          afterId: 'folder-b-child',
          beforeId: null,
          baseSourceParentRevision: ROOT_CHILDREN_REV,
          baseTargetParentRevision: FOLDER_B_CHILDREN_REV,
          command: { commandId: COMMAND_B, fingerprint: FINGERPRINT_B },
          operationId: 'op-move-bookmark',
        }),
      ),
    );

    assert.equal(moved.node.kind, 'bookmark');
    assert.equal(moved.node.parentId, FOLDER_B);
    assert.ok((moved.node.position as string) > 'a');
  });

  test('move keeps a seeded bookmark iconUrl', async () => {
    const objectId = '01234567-89ab-4cde-8f01-23456789abcd';
    const state = createState();
    seedStandardTree(state);
    state.iconObjectIds.set(BOOKMARK_ID, objectId);
    const ports = createMemoryPorts(state);

    const moved = assertMoved(
      await moveCollectionNode(
        ports,
        baseInput({
          nodeId: BOOKMARK_ID,
          ifMatch: strongEntityTag('bookmark-res'),
          newParentId: FOLDER_B,
          afterId: null,
          beforeId: null,
          baseSourceParentRevision: ROOT_CHILDREN_REV,
          baseTargetParentRevision: FOLDER_B_CHILDREN_REV,
          command: { commandId: COMMAND_B, fingerprint: FINGERPRINT_B },
          operationId: 'op-move-bookmark-icon',
        }),
      ),
    );

    assert.equal(moved.node.kind, 'bookmark');
    if (moved.node.kind === 'bookmark') {
      assert.equal(moved.node.iconUrl, `https://known.example/api/v1/favicon/${objectId}`);
    }
    assert.ok(state.iconLookupCalls >= 1);
  });
});

// ---------------------------------------------------------------------------
// Cycle / root / cross-collection rejects
// ---------------------------------------------------------------------------

describe('moveCollectionNode: cycle / root / cross-collection', () => {
  test('root move → NodeConflictError root_immutable', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        moveCollectionNode(
          ports,
          baseInput({
            nodeId: ROOT_ID,
            ifMatch: strongEntityTag('root-resource-rev'),
            newParentId: FOLDER_A,
            baseSourceParentRevision: ROOT_CHILDREN_REV,
            baseTargetParentRevision: FOLDER_A_CHILDREN_REV,
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof NodeConflictError);
        assert.equal(error.code, 'root_immutable');
        return true;
      },
    );
    assert.equal(state.operations.length, 0);
    assert.equal(state.nodes.get(ROOT_ID)!.parentId, null);
  });

  test('self-parent cycle rejected', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        moveCollectionNode(
          ports,
          baseInput({
            nodeId: FOLDER_A,
            ifMatch: strongEntityTag('folder-a-res'),
            newParentId: FOLDER_A,
            baseSourceParentRevision: ROOT_CHILDREN_REV,
            baseTargetParentRevision: FOLDER_A_CHILDREN_REV,
          }),
        ),
      (error: unknown) => {
        expectCode(error, 'invalid_node_input');
        return true;
      },
    );
    assert.equal(state.operations.length, 0);
  });

  test('descendant parent cycle rejected', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    // folder-a is ancestor of folder-child; moving folder-a under folder-child cycles.
    await assert.rejects(
      () =>
        moveCollectionNode(
          ports,
          baseInput({
            nodeId: FOLDER_A,
            ifMatch: strongEntityTag('folder-a-res'),
            newParentId: FOLDER_CHILD,
            baseSourceParentRevision: ROOT_CHILDREN_REV,
            baseTargetParentRevision: 'folder-child-ch',
          }),
        ),
      (error: unknown) => {
        expectCode(error, 'invalid_node_parent');
        return true;
      },
    );
    assert.equal(state.nodes.get(FOLDER_A)!.parentId, ROOT_ID);
    assert.equal(state.operations.length, 0);
  });

  test('ancestry depth cap without root is a depth error, not a cycle', async () => {
    const state = createState();
    seedCollection(state);
    // 257 live folders under root: the leaf's ancestry is truncated by the port
    // before it reaches root, which must fail closed as a depth error.
    let parent = ROOT_ID;
    for (let i = 1; i <= 257; i += 1) {
      seedNode(state, {
        id: `deep-chain-${i}`,
        parentId: parent,
        resourceRevision: `deep-chain-${i}-res`,
        childrenRevision: `deep-chain-${i}-ch`,
      });
      parent = `deep-chain-${i}`;
    }
    seedNode(state, {
      id: FOLDER_A,
      parentId: ROOT_ID,
      positionToken: 'f',
      resourceRevision: 'folder-a-res',
      childrenRevision: FOLDER_A_CHILDREN_REV,
    });
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        moveCollectionNode(
          ports,
          baseInput({
            nodeId: FOLDER_A,
            ifMatch: strongEntityTag('folder-a-res'),
            newParentId: 'deep-chain-257',
            baseSourceParentRevision: ROOT_CHILDREN_REV,
            baseTargetParentRevision: 'deep-chain-257-ch',
          }),
        ),
      (error: unknown) => {
        expectCode(error, 'invalid_node_parent');
        assert.match((error as Error).message, /exceeds maximum depth/);
        return true;
      },
    );
    assert.equal(state.nodes.get(FOLDER_A)!.parentId, ROOT_ID);
    assert.equal(state.operations.length, 0);
  });

  test('bookmark as newParent rejected', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        moveCollectionNode(
          ports,
          baseInput({
            newParentId: BOOKMARK_ID,
            baseSourceParentRevision: ROOT_CHILDREN_REV,
            baseTargetParentRevision: 'bookmark-ch',
          }),
        ),
      (error: unknown) => {
        expectCode(error, 'invalid_node_parent');
        return true;
      },
    );
  });

  test('newParent in another collection rejected (cross-collection)', async () => {
    const state = createState();
    seedStandardTree(state);
    seedCollection(state, {
      collectionId: OTHER_COLLECTION_ID,
      rootId: 'other-root',
      rootChildrenRevision: 'other-root-ch',
    });
    seedNode(state, {
      id: 'other-folder',
      parentId: 'other-root',
      collectionId: OTHER_COLLECTION_ID,
      positionToken: 'a',
      childrenRevision: 'other-folder-ch',
    });
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        moveCollectionNode(
          ports,
          baseInput({
            newParentId: 'other-folder',
            baseSourceParentRevision: ROOT_CHILDREN_REV,
            baseTargetParentRevision: 'other-folder-ch',
          }),
        ),
      (error: unknown) => {
        expectCode(error, 'invalid_node_parent');
        return true;
      },
    );
    assert.equal(state.nodes.get(MOVE_TARGET)!.collectionId, COLLECTION_ID);
    assert.equal(state.nodes.get(MOVE_TARGET)!.parentId, ROOT_ID);
  });
});

// ---------------------------------------------------------------------------
// Parent revision conflicts + node If-Match
// ---------------------------------------------------------------------------

describe('moveCollectionNode: parent revision + If-Match', () => {
  test('stale baseSourceParentRevision → position_context_stale', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        moveCollectionNode(
          ports,
          baseInput({
            baseSourceParentRevision: 'stale-source-children',
            baseTargetParentRevision: ROOT_CHILDREN_REV,
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof NodeConflictError);
        assert.equal(error.code, 'position_context_stale');
        return true;
      },
    );
    assert.equal(state.operations.length, 0);
  });

  test('stale baseTargetParentRevision → position_context_stale', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        moveCollectionNode(
          ports,
          baseInput({
            newParentId: FOLDER_A,
            baseSourceParentRevision: ROOT_CHILDREN_REV,
            baseTargetParentRevision: 'stale-target-children',
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof NodeConflictError);
        assert.equal(error.code, 'position_context_stale');
        return true;
      },
    );
    assert.equal(state.operations.length, 0);
  });

  test('stale node If-Match → CollectionPreconditionError', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        moveCollectionNode(
          ports,
          baseInput({
            ifMatch: strongEntityTag('stale-node-revision'),
            baseSourceParentRevision: ROOT_CHILDREN_REV,
            baseTargetParentRevision: ROOT_CHILDREN_REV,
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof CollectionPreconditionError);
        assert.equal(error.code, 'precondition_failed');
        assert.equal(error.currentEtag, strongEntityTag(MOVE_TARGET_RESOURCE_REV));
        return true;
      },
    );
    assert.equal(state.operations.length, 0);
  });

  test('non-adjacent anchors → position_context_stale', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        moveCollectionNode(
          ports,
          baseInput({
            afterId: SIBLING_A,
            beforeId: SIBLING_C,
            baseSourceParentRevision: ROOT_CHILDREN_REV,
            baseTargetParentRevision: ROOT_CHILDREN_REV,
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof NodeConflictError);
        assert.equal(error.code, 'position_context_stale');
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Sequential concurrent-ish moves
// ---------------------------------------------------------------------------

describe('moveCollectionNode: sequential moves', () => {
  test('second move must use refreshed parent + node revisions', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    const first = assertMoved(
      await moveCollectionNode(
        ports,
        baseInput({
          nodeId: SIBLING_A,
          ifMatch: strongEntityTag('sibling-a-res'),
          newParentId: FOLDER_A,
          afterId: null,
          beforeId: null,
          baseSourceParentRevision: ROOT_CHILDREN_REV,
          baseTargetParentRevision: FOLDER_A_CHILDREN_REV,
          command: { commandId: COMMAND_A, fingerprint: FINGERPRINT_A },
          operationId: 'op-seq-1',
        }),
      ),
    );

    // Stale parent revs from before first move must fail.
    await assert.rejects(
      () =>
        moveCollectionNode(
          ports,
          baseInput({
            nodeId: SIBLING_B,
            ifMatch: strongEntityTag('sibling-b-res'),
            newParentId: FOLDER_A,
            baseSourceParentRevision: ROOT_CHILDREN_REV,
            baseTargetParentRevision: FOLDER_A_CHILDREN_REV,
            command: { commandId: COMMAND_B, fingerprint: FINGERPRINT_B },
            operationId: 'op-seq-2-stale',
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof NodeConflictError);
        assert.equal(error.code, 'position_context_stale');
        return true;
      },
    );

    const second = assertMoved(
      await moveCollectionNode(
        ports,
        baseInput({
          nodeId: SIBLING_B,
          ifMatch: strongEntityTag('sibling-b-res'),
          newParentId: FOLDER_A,
          afterId: SIBLING_A,
          beforeId: null,
          baseSourceParentRevision: first.sourceParent.childrenRevision,
          baseTargetParentRevision: first.targetParent.childrenRevision,
          command: { commandId: COMMAND_C, fingerprint: FINGERPRINT_A },
          operationId: 'op-seq-2',
        }),
      ),
    );

    assert.equal(state.nodes.get(SIBLING_A)!.parentId, FOLDER_A);
    assert.equal(state.nodes.get(SIBLING_B)!.parentId, FOLDER_A);
    assert.equal(state.operations.length, 2);
    assert.ok(
      (second.node.position as string) > (state.nodes.get(SIBLING_A)!.positionToken as string),
    );
  });
});

// ---------------------------------------------------------------------------
// Rebalance path
// ---------------------------------------------------------------------------

describe('moveCollectionNode: rebalance', () => {
  test('tight position gap under target triggers sibling rebalance', async () => {
    const state = createState();
    seedCollection(state);
    // Source parent for MOVE_TARGET.
    seedNode(state, {
      id: FOLDER_A,
      parentId: ROOT_ID,
      positionToken: 'f',
      resourceRevision: 'folder-a-res',
      childrenRevision: FOLDER_A_CHILDREN_REV,
    });
    // Two max-length adjacent tokens that leave no midpoint for allocatePosition.
    const maxA = 'a'.repeat(128);
    const maxB = `${'a'.repeat(127)}b`;
    seedNode(state, {
      id: 'tight-lo',
      parentId: ROOT_ID,
      positionToken: maxA,
      resourceRevision: 'tight-lo-res',
    });
    seedNode(state, {
      id: 'tight-hi',
      parentId: ROOT_ID,
      positionToken: maxB,
      resourceRevision: 'tight-hi-res',
    });
    seedNode(state, {
      id: MOVE_TARGET,
      parentId: FOLDER_A,
      positionToken: 'x',
      resourceRevision: MOVE_TARGET_RESOURCE_REV,
    });

    const ports = createMemoryPorts(state);

    const moved = assertMoved(
      await moveCollectionNode(
        ports,
        baseInput({
          newParentId: ROOT_ID,
          afterId: 'tight-lo',
          beforeId: 'tight-hi',
          baseSourceParentRevision: FOLDER_A_CHILDREN_REV,
          baseTargetParentRevision: ROOT_CHILDREN_REV,
        }),
      ),
    );

    assert.equal(moved.node.parentId, ROOT_ID);
    // Rebalance rewrites sibling positions — tokens must no longer be max-length blocks.
    const lo = state.nodes.get('tight-lo')!;
    const hi = state.nodes.get('tight-hi')!;
    const target = state.nodes.get(MOVE_TARGET)!;
    assert.ok(lo.positionToken! < target.positionToken!);
    assert.ok(target.positionToken! < hi.positionToken!);
    // Resource revisions advanced for rebalanced siblings.
    assert.notEqual(lo.resourceRevision, 'tight-lo-res');
    assert.notEqual(hi.resourceRevision, 'tight-hi-res');

    const opPayload = state.operations[0]!.payload as { rebalancedCount?: number };
    if (typeof opPayload.rebalancedCount === 'number') {
      assert.ok(opPayload.rebalancedCount >= 2);
    }
  });
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe('moveCollectionNode: authorization', () => {
  test('owner and editor allowed; viewer denied; stranger concealed', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    assertMoved(
      await moveCollectionNode(
        ports,
        baseInput({
          actor: {
            principalId: PRINCIPAL_OWNER,
            principalType: 'account',
            subjectId: SUBJECT_OWNER,
          },
          nodeId: SIBLING_A,
          ifMatch: strongEntityTag('sibling-a-res'),
          newParentId: FOLDER_A,
          baseSourceParentRevision: ROOT_CHILDREN_REV,
          baseTargetParentRevision: FOLDER_A_CHILDREN_REV,
          command: { commandId: COMMAND_A, fingerprint: FINGERPRINT_A },
          operationId: 'op-owner',
        }),
      ),
    );

    const afterOwnerTargetCh = parentChildren(state, FOLDER_A);
    const afterOwnerSourceCh = parentChildren(state, ROOT_ID);

    assertMoved(
      await moveCollectionNode(
        ports,
        baseInput({
          actor: {
            principalId: PRINCIPAL_EDITOR,
            principalType: 'account',
            subjectId: SUBJECT_EDITOR,
          },
          nodeId: SIBLING_B,
          ifMatch: strongEntityTag('sibling-b-res'),
          newParentId: FOLDER_A,
          baseSourceParentRevision: afterOwnerSourceCh,
          baseTargetParentRevision: afterOwnerTargetCh,
          command: { commandId: COMMAND_B, fingerprint: FINGERPRINT_B },
          operationId: 'op-editor',
        }),
      ),
    );

    await assert.rejects(
      () =>
        moveCollectionNode(
          ports,
          baseInput({
            actor: {
              principalId: PRINCIPAL_VIEWER,
              principalType: 'account',
              subjectId: SUBJECT_VIEWER,
            },
            nodeId: SIBLING_C,
            ifMatch: strongEntityTag('sibling-c-res'),
            newParentId: FOLDER_A,
            baseSourceParentRevision: parentChildren(state, ROOT_ID),
            baseTargetParentRevision: parentChildren(state, FOLDER_A),
            command: { commandId: COMMAND_C, fingerprint: FINGERPRINT_A },
            operationId: 'op-viewer',
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
        moveCollectionNode(
          ports,
          baseInput({
            actor: {
              principalId: PRINCIPAL_STRANGER,
              principalType: 'account',
              subjectId: SUBJECT_STRANGER,
            },
            nodeId: SIBLING_C,
            ifMatch: strongEntityTag('sibling-c-res'),
            newParentId: FOLDER_A,
            baseSourceParentRevision: parentChildren(state, ROOT_ID),
            baseTargetParentRevision: parentChildren(state, FOLDER_A),
            command: { commandId: COMMAND_D, fingerprint: FINGERPRINT_B },
            operationId: 'op-stranger',
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof CollectionAuthorizationError);
        assert.equal(error.outcome, 'conceal');
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Result shape + side effects
// ---------------------------------------------------------------------------

describe('moveCollectionNode: MoveNodeResult shape + side effects', () => {
  test('success result has node, sourceParent, targetParent, fence; commit ordinal advances', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    const moved = assertMoved(
      await moveCollectionNode(
        ports,
        baseInput({
          baseSourceParentRevision: ROOT_CHILDREN_REV,
          baseTargetParentRevision: ROOT_CHILDREN_REV,
        }),
      ),
    );

    assert.equal(typeof moved.node.id, 'string');
    assert.equal(typeof moved.node.etag, 'string');
    assert.equal(typeof moved.node.revision, 'string');
    assert.equal(typeof moved.node.position, 'string');
    assert.equal(moved.sourceParent.id, ROOT_ID);
    assert.equal(typeof moved.sourceParent.childrenRevision, 'string');
    assert.equal(typeof moved.sourceParent.childrenEtag, 'string');
    assert.equal(moved.targetParent.id, ROOT_ID);
    assert.equal(typeof moved.fence.contentRevision, 'string');
    assert.equal(typeof moved.fence.contentEtag, 'string');
    assert.equal(typeof moved.fence.policyRevision, 'string');
    assert.equal(typeof moved.fence.policyEtag, 'string');
    assert.equal(moved.operationId, OPERATION_ID);
    assert.equal(moved.commitOrdinal, 3n);
    assert.equal(state.collections.get(COLLECTION_ID)!.commitOrdinal, 3n);

    assert.equal(state.resourceRevisions.some((r) => r.resourceId === MOVE_TARGET), true);
    assert.equal(state.contentRevisions.length, 1);
    assert.equal(state.outbox[0]!.aggregateType, 'node');
    assert.equal(state.outbox[0]!.aggregateId, MOVE_TARGET);
  });
});

// ---------------------------------------------------------------------------
// Command admission
// ---------------------------------------------------------------------------

describe('moveCollectionNode: command admission', () => {
  test('exact command retry → replay, no double mutation', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);
    const input = baseInput({
      baseSourceParentRevision: ROOT_CHILDREN_REV,
      baseTargetParentRevision: ROOT_CHILDREN_REV,
    });

    const first = assertMoved(await moveCollectionNode(ports, input));
    const product = completedReceipt(state);
    const opCount = state.operations.length;
    const commit = state.collections.get(COLLECTION_ID)!.commitOrdinal;
    const position = state.nodes.get(MOVE_TARGET)!.positionToken;

    const second = await moveCollectionNode(ports, input);
    assert.equal(second.kind, 'replay');
    if (second.kind !== 'replay') return;

    assert.equal(second.status, 200);
    assert.equal(second.status, product.status);
    assert.deepEqual(second.stableHeaders, product.stableHeaders);
    assert.deepEqual(
      Buffer.from(second.body).toString('hex'),
      Buffer.from(product.body).toString('hex'),
    );

    assert.equal(state.operations.length, opCount);
    assert.equal(state.collections.get(COLLECTION_ID)!.commitOrdinal, commit);
    assert.equal(state.nodes.get(MOVE_TARGET)!.positionToken, position);
    void first;
  });

  test('same command_id different fingerprint → reused without writes', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    assertMoved(
      await moveCollectionNode(
        ports,
        baseInput({
          baseSourceParentRevision: ROOT_CHILDREN_REV,
          baseTargetParentRevision: ROOT_CHILDREN_REV,
          command: { commandId: COMMAND_A, fingerprint: FINGERPRINT_A },
        }),
      ),
    );
    const after = {
      operations: state.operations.length,
      commit: state.collections.get(COLLECTION_ID)!.commitOrdinal,
      position: state.nodes.get(MOVE_TARGET)!.positionToken,
    };

    const reused = await moveCollectionNode(
      ports,
      baseInput({
        newParentId: FOLDER_A,
        baseSourceParentRevision: parentChildren(state, ROOT_ID),
        baseTargetParentRevision: FOLDER_A_CHILDREN_REV,
        command: { commandId: COMMAND_A, fingerprint: FINGERPRINT_B },
      }),
    );
    assert.equal(reused.kind, 'reused');
    assert.equal(state.operations.length, after.operations);
    assert.equal(state.collections.get(COLLECTION_ID)!.commitOrdinal, after.commit);
    assert.equal(state.nodes.get(MOVE_TARGET)!.positionToken, after.position);
  });

  test('in_progress claim returns without domain writes', async () => {
    const state = createState({ forceInProgress: true });
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    const outcome = await moveCollectionNode(
      ports,
      baseInput({
        baseSourceParentRevision: ROOT_CHILDREN_REV,
        baseTargetParentRevision: ROOT_CHILDREN_REV,
      }),
    );
    assert.equal(outcome.kind, 'in_progress');
    assert.equal(state.operations.length, 0);
    assert.equal(state.ledger.length, 0);
  });

  test('failed validation after claim must not complete receipt with success', async () => {
    const state = createState();
    seedStandardTree(state);
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        moveCollectionNode(
          ports,
          baseInput({
            ifMatch: strongEntityTag('stale'),
            baseSourceParentRevision: ROOT_CHILDREN_REV,
            baseTargetParentRevision: ROOT_CHILDREN_REV,
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

    // Receipt left in_progress or absent of completed success — no completed digest for bad move.
    for (const row of state.receipts.values()) {
      assert.notEqual(row.status, 'completed');
    }
  });
});
