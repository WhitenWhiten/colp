/**
 * P1-08 updateCollectionNode application unit tests (in-memory ports).
 *
 * Production surface:
 *   updateCollectionNode(ports, input)
 *     → updated | replay | in_progress | reused | expired
 *   updateCollectionNodeCommandScope(collectionId, nodeId)
 *     -> collection:{collectionId}:node:{nodeId}:update
 *   Capability: update_node (owner/editor; viewer deny; non-member conceal)
 *   Root → NodeConflictError root_immutable (409)
 *   Stale If-Match → CollectionPreconditionError (412)
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  CollectionAuthorizationError,
  CollectionPreconditionError,
  CollectionsError,
  NODE_UPDATED_EVENT_TYPE,
  NodeConflictError,
  UPDATE_COLLECTION_NODE_OPERATION_TYPE,
  ifMatchSatisfied,
  strongEntityTag,
  updateCollectionNode,
} from '../../../src/modules/collections/index.js';
import {
  COMMAND_A,
  COMMAND_B,
  COMMAND_C,
  PRINCIPAL_EDITOR,
  SUBJECT_EDITOR,
  PRINCIPAL_VIEWER,
  SUBJECT_VIEWER,
  PRINCIPAL_STRANGER,
  SUBJECT_STRANGER,
  FINGERPRINT_A,
  FINGERPRINT_B,
  COLLECTION_ID,
  ROOT_ID,
  FOLDER_ID,
  BOOKMARK_ID,
  CONTENT_REV,
  POLICY_REV,
  FOLDER_RESOURCE_REV,
  BOOKMARK_RESOURCE_REV,
  ROOT_RESOURCE_REV,
  createMemoryPorts,
  createState,
  seedCollection,
  seedFolder,
  seedBookmark,
  baseInput,
  assertUpdated,
  completedReceipt,
  expectCode,
} from '../../support/update-collection-node-memory.js';


describe('updateCollectionNode: command admission', () => {
  test('exact retry → replay without second revision bump', async () => {
    const state = createState();
    seedCollection(state);
    seedFolder(state);
    const ports = createMemoryPorts(state);
    const input = baseInput();

    assertUpdated(await updateCollectionNode(ports, input));
    const product = completedReceipt(state);
    const counts = {
      operations: state.operations.length,
      resourceRevisions: state.resourceRevisions.length,
      title: state.nodes.get(FOLDER_ID)!.title,
      commit: state.collections.get(COLLECTION_ID)!.commitOrdinal,
    };

    const second = await updateCollectionNode(ports, input);
    assert.equal(second.kind, 'replay');
    if (second.kind !== 'replay') return;
    assert.equal(second.status, 200);
    assert.deepEqual(
      Buffer.from(second.body).toString('hex'),
      Buffer.from(product.body).toString('hex'),
    );
    assert.equal(state.operations.length, counts.operations);
    assert.equal(state.resourceRevisions.length, counts.resourceRevisions);
    assert.equal(state.nodes.get(FOLDER_ID)!.title, counts.title);
    assert.equal(state.collections.get(COLLECTION_ID)!.commitOrdinal, counts.commit);
  });

  test('command_id_reused different fingerprint', async () => {
    const state = createState();
    seedCollection(state);
    seedFolder(state);
    const ports = createMemoryPorts(state);

    assertUpdated(
      await updateCollectionNode(
        ports,
        baseInput({ command: { commandId: COMMAND_A, fingerprint: FINGERPRINT_A } }),
      ),
    );
    const after = state.operations.length;

    const reused = await updateCollectionNode(
      ports,
      baseInput({
        patch: { title: 'Other intent' },
        ifMatch: strongEntityTag(state.nodes.get(FOLDER_ID)!.resourceRevision),
        command: { commandId: COMMAND_A, fingerprint: FINGERPRINT_B },
      }),
    );
    assert.equal(reused.kind, 'reused');
    assert.equal(state.operations.length, after);
  });
});

