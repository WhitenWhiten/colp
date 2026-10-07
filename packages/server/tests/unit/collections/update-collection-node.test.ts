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

describe('updateCollectionNode: legal merge patches', () => {
  test('folder: title, description, tags, visibility merges', async () => {
    const state = createState();
    seedCollection(state);
    seedFolder(state, {
      title: 'Old',
      description: 'old desc',
      tags: ['a'],
      visibility: 'inherit',
    });
    const ports = createMemoryPorts(state);

    const updated = assertUpdated(
      await updateCollectionNode(
        ports,
        baseInput({
          patch: {
            title: 'New Title',
            description: 'new desc',
            tags: ['b', 'c'],
            visibility: 'protected',
          },
        }),
      ),
    );

    assert.equal(updated.node.kind, 'folder');
    assert.equal(updated.node.title, 'New Title');
    assert.equal(updated.node.description, 'new desc');
    assert.deepEqual([...updated.node.tags], ['b', 'c']);
    assert.equal(updated.node.visibility, 'protected');
  });

  test('bookmark: title and url merge', async () => {
    const state = createState();
    seedCollection(state);
    seedBookmark(state);
    const ports = createMemoryPorts(state);

    const updated = assertUpdated(
      await updateCollectionNode(
        ports,
        baseInput({
          nodeId: BOOKMARK_ID,
          ifMatch: strongEntityTag(BOOKMARK_RESOURCE_REV),
          patch: {
            title: 'New BM',
            url: 'https://example.com/new',
          },
        }),
      ),
    );

    assert.equal(updated.node.kind, 'bookmark');
    if (updated.node.kind === 'bookmark') {
      assert.equal(updated.node.title, 'New BM');
      assert.equal(updated.node.url, 'https://example.com/new');
      assert.equal(Object.hasOwn(updated.node, 'iconUrl'), true);
      assert.equal(updated.node.iconUrl, null);
    }
  });

  test('bookmark: normalization-equivalent url keeps the stored spelling', async () => {
    const state = createState();
    seedCollection(state);
    seedBookmark(state, { url: 'https://Example.COM:443/docs/' });
    const ports = createMemoryPorts(state);

    const updated = assertUpdated(
      await updateCollectionNode(
        ports,
        baseInput({
          nodeId: BOOKMARK_ID,
          ifMatch: strongEntityTag(BOOKMARK_RESOURCE_REV),
          patch: { url: 'https://example.com/docs#frag' },
        }),
      ),
    );

    // The stored spelling — uppercase host, default port, trailing / — wins so
    // the community generation fence sees no semantic drift and any stored
    // urlHash stays paired with the bytes it was minted over.
    assert.equal(state.nodes.get(BOOKMARK_ID)?.url, 'https://Example.COM:443/docs/');
    assert.equal(updated.node.kind, 'bookmark');
    if (updated.node.kind === 'bookmark') {
      assert.equal(updated.node.url, 'https://Example.COM:443/docs/');
    }
  });

  test('PATCH title keeps a seeded iconUrl (same-origin, not null, not CDN)', async () => {
    const objectId = '01234567-89ab-4cde-8f01-23456789abcd';
    const state = createState();
    seedCollection(state);
    seedBookmark(state);
    state.iconObjectIds.set(BOOKMARK_ID, objectId);
    const ports = createMemoryPorts(state);

    const updated = assertUpdated(
      await updateCollectionNode(
        ports,
        baseInput({
          nodeId: BOOKMARK_ID,
          ifMatch: strongEntityTag(BOOKMARK_RESOURCE_REV),
          patch: { title: 'Only title' },
        }),
      ),
    );

    assert.equal(updated.node.kind, 'bookmark');
    if (updated.node.kind === 'bookmark') {
      assert.equal(updated.node.title, 'Only title');
      assert.equal(updated.node.iconUrl, `https://known.example/api/v1/favicon/${objectId}`);
      assert.doesNotMatch(updated.node.iconUrl ?? '', /favicon\.im|duckduckgo/i);
    }
    assert.ok(state.iconLookupCalls >= 1);
  });

  test('Folder + url → invalid_node_patch', async () => {
    const state = createState();
    seedCollection(state);
    seedFolder(state);
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        updateCollectionNode(
          ports,
          baseInput({
            patch: { url: 'https://example.com/' } as UpdateCollectionNodeInput['patch'],
          }),
        ),
      (error: unknown) => {
        expectCode(error, 'invalid_node_patch');
        return true;
      },
    );
    assert.equal(state.operations.length, 0);
  });

  test('Bookmark url null → invalid_node_url', async () => {
    const state = createState();
    seedCollection(state);
    seedBookmark(state);
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        updateCollectionNode(
          ports,
          baseInput({
            nodeId: BOOKMARK_ID,
            ifMatch: strongEntityTag(BOOKMARK_RESOURCE_REV),
            patch: { url: null as unknown as string },
          }),
        ),
      (error: unknown) => {
        expectCode(error, 'invalid_node_url');
        return true;
      },
    );
  });

  test('tags null clears; description null clears', async () => {
    const state = createState();
    seedCollection(state);
    seedFolder(state, { description: 'will clear', tags: ['keep'] });
    const ports = createMemoryPorts(state);

    const updated = assertUpdated(
      await updateCollectionNode(
        ports,
        baseInput({
          patch: { description: null, tags: null },
        }),
      ),
    );

    assert.equal(updated.node.description, null);
    assert.deepEqual([...updated.node.tags], []);
    assert.equal(state.nodes.get(FOLDER_ID)!.description, null);
    assert.deepEqual(state.nodes.get(FOLDER_ID)!.tags, []);
  });

  test('empty patch rejected', async () => {
    const state = createState();
    seedCollection(state);
    seedFolder(state);
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () => updateCollectionNode(ports, baseInput({ patch: {} })),
      (error: unknown) => {
        expectCode(error, 'invalid_node_patch');
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Root immutable
// ---------------------------------------------------------------------------

describe('updateCollectionNode: root immutable', () => {
  test('PATCH root → NodeConflictError root_immutable', async () => {
    const state = createState();
    seedCollection(state);
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        updateCollectionNode(
          ports,
          baseInput({
            nodeId: ROOT_ID,
            ifMatch: strongEntityTag(ROOT_RESOURCE_REV),
            patch: { title: 'Cannot rename root' },
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof NodeConflictError);
        assert.equal(error.code, 'root_immutable');
        return true;
      },
    );
    assert.equal(state.operations.length, 0);
    assert.equal(state.nodes.get(ROOT_ID)!.title, 'Root Title');
  });
});

// ---------------------------------------------------------------------------
// If-Match
// ---------------------------------------------------------------------------

describe('updateCollectionNode: If-Match / ETag', () => {
  test('ifMatchSatisfied accepts strong entity-tag and bare revision', () => {
    assert.equal(ifMatchSatisfied(strongEntityTag(FOLDER_RESOURCE_REV), FOLDER_RESOURCE_REV), true);
    assert.equal(ifMatchSatisfied(FOLDER_RESOURCE_REV, FOLDER_RESOURCE_REV), true);
    assert.equal(ifMatchSatisfied(strongEntityTag('other'), FOLDER_RESOURCE_REV), false);
  });

  test('stale If-Match → CollectionPreconditionError 412 path', async () => {
    const state = createState();
    seedCollection(state);
    seedFolder(state, { resourceRevision: FOLDER_RESOURCE_REV });
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        updateCollectionNode(
          ports,
          baseInput({ ifMatch: strongEntityTag('stale-node-revision') }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof CollectionPreconditionError);
        assert.equal(error.code, 'precondition_failed');
        assert.equal(error.precondition, 'resource');
        assert.equal(error.currentEtag, strongEntityTag(FOLDER_RESOURCE_REV));
        return true;
      },
    );
    assert.equal(state.operations.length, 0);
    assert.equal(state.nodes.get(FOLDER_ID)!.title, 'Folder Title');
  });

  test('matching ETag succeeds and advances node resource + collection content', async () => {
    const state = createState();
    seedCollection(state, { contentRevision: CONTENT_REV, commitOrdinal: 5n });
    seedFolder(state);
    const ports = createMemoryPorts(state);

    const updated = assertUpdated(
      await updateCollectionNode(
        ports,
        baseInput({ ifMatch: strongEntityTag(FOLDER_RESOURCE_REV) }),
      ),
    );

    assert.notEqual(updated.node.revision, FOLDER_RESOURCE_REV);
    assert.equal(updated.node.etag, strongEntityTag(updated.node.revision));
    assert.notEqual(updated.fence.contentRevision, CONTENT_REV);
    assert.equal(updated.commitOrdinal, 6n);
    assert.equal(state.nodes.get(FOLDER_ID)!.resourceRevision, updated.node.revision);
  });
});

// ---------------------------------------------------------------------------
// Field authority
// ---------------------------------------------------------------------------

describe('updateCollectionNode: field authority', () => {
  test('rejects kind, parentId, position, id, revision in patch', async () => {
    const state = createState();
    seedCollection(state);
    seedFolder(state);
    const ports = createMemoryPorts(state);

    for (const patch of [
      { kind: 'bookmark' },
      { parentId: ROOT_ID },
      { position: 'Z' },
      { id: 'evil' },
      { revision: 'r' },
      { collectionId: 'x' },
      { childrenRevision: 'c' },
    ] as const) {
      await assert.rejects(
        () =>
          updateCollectionNode(
            ports,
            baseInput({
              patch: patch as unknown as UpdateCollectionNodeInput['patch'],
            }),
          ),
        (error: unknown) => {
          assert.ok(error instanceof CollectionsError);
          assert.ok(
            error.code === 'invalid_node_patch' || error.code === 'invalid_node_input',
            error.code,
          );
          return true;
        },
      );
    }
    assert.equal(state.operations.length, 0);
  });

  test('blank title rejected', async () => {
    const state = createState();
    seedCollection(state);
    seedFolder(state);
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () => updateCollectionNode(ports, baseInput({ patch: { title: '   ' } })),
      (error: unknown) => {
        expectCode(error, 'invalid_node_title');
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('updateCollectionNode: authorization', () => {
  test('viewer deny; non-member conceal', async () => {
    const state = createState();
    seedCollection(state, {
      memberships: [
        { subjectId: SUBJECT_EDITOR, role: 'editor' },
        { subjectId: SUBJECT_VIEWER, role: 'viewer' },
      ],
    });
    seedFolder(state);
    const ports = createMemoryPorts(state);

    assertUpdated(
      await updateCollectionNode(
        ports,
        baseInput({
          actor: {
            principalId: PRINCIPAL_EDITOR,
            principalType: 'account',
            subjectId: SUBJECT_EDITOR,
          },
          patch: { title: 'Editor Edit' },
        }),
      ),
    );

    const currentEtag = strongEntityTag(state.nodes.get(FOLDER_ID)!.resourceRevision);

    await assert.rejects(
      () =>
        updateCollectionNode(
          ports,
          baseInput({
            actor: {
              principalId: PRINCIPAL_VIEWER,
              principalType: 'account',
              subjectId: SUBJECT_VIEWER,
            },
            ifMatch: currentEtag,
            command: { commandId: COMMAND_B, fingerprint: FINGERPRINT_B },
            patch: { title: 'Viewer' },
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
        updateCollectionNode(
          ports,
          baseInput({
            actor: {
              principalId: PRINCIPAL_STRANGER,
              principalType: 'account',
              subjectId: SUBJECT_STRANGER,
            },
            ifMatch: currentEtag,
            command: { commandId: COMMAND_C, fingerprint: FINGERPRINT_A },
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof CollectionAuthorizationError);
        assert.equal(error.outcome, 'conceal');
        return true;
      },
    );
  });

  test('policy revision mismatch after lock denies', async () => {
    const state = createState();
    seedCollection(state);
    seedFolder(state);
    const base = createMemoryPorts(state);
    const ports = {
      ...base,
      accessPolicy: {
        async loadCollectionFacts(input: Parameters<typeof base.accessPolicy.loadCollectionFacts>[0]) {
          const facts = await base.accessPolicy.loadCollectionFacts(input);
          if (!facts) return null;
          return { ...facts, policyRevision: 'stale-policy-rev' };
        },
      },
    };

    await assert.rejects(
      () => updateCollectionNode(ports, baseInput({ patch: { title: 'Mismatch' } })),
      (error: unknown) => {
        assert.ok(error instanceof CollectionAuthorizationError);
        assert.equal(error.outcome, 'deny');
        assert.equal(error.reasonCategory, 'policy_revision_mismatch');
        return true;
      },
    );
    assert.equal(state.operations.length, 0);
  });

  test('missing node after authorize → conceal', async () => {
    const state = createState();
    seedCollection(state);
    // no folder seed
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () =>
        updateCollectionNode(
          ports,
          baseInput({ nodeId: 'missing-node', ifMatch: strongEntityTag('x') }),
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
// Revisions + side effects
// ---------------------------------------------------------------------------

describe('updateCollectionNode: revisions and side effects', () => {
  test('node resource + content advance; children unchanged; op/audit/outbox once', async () => {
    const state = createState();
    seedCollection(state, {
      contentRevision: CONTENT_REV,
      policyRevision: POLICY_REV,
      commitOrdinal: 4n,
    });
    seedFolder(state);
    const ports = createMemoryPorts(state);
    const previousChildren = state.nodes.get(FOLDER_ID)!.childrenRevision;

    const updated = assertUpdated(
      await updateCollectionNode(ports, baseInput({ patch: { title: 'Rev' } })),
    );

    assert.equal(state.resourceRevisions.length, 1);
    assert.equal(state.resourceRevisions[0]!.resourceId, FOLDER_ID);
    assert.equal(state.contentRevisions.length, 1);
    assert.equal(state.childrenRevisions.length, 0);
    assert.equal(state.nodes.get(FOLDER_ID)!.childrenRevision, previousChildren);

    assert.equal(state.operations.length, 1);
    assert.equal(state.operations[0]!.operationType, 'resource.update');
    assert.equal(state.audit.length, 1);
    assert.equal(state.audit[0]!.eventType, 'resource.update');
    assert.equal(state.outbox.length, 1);
    assert.equal(state.outbox[0]!.eventType, NODE_UPDATED_EVENT_TYPE);

    assert.equal(updated.fence.contentRevision, state.collections.get(COLLECTION_ID)!.contentRevision);
    assert.notEqual(updated.fence.contentRevision, CONTENT_REV);
  });

  test('visibility change advances policy revision', async () => {
    const state = createState();
    seedCollection(state, { policyRevision: POLICY_REV });
    seedFolder(state, { visibility: 'inherit' });
    const ports = createMemoryPorts(state);

    const updated = assertUpdated(
      await updateCollectionNode(
        ports,
        baseInput({ patch: { visibility: 'private' } }),
      ),
    );

    assert.equal(updated.node.visibility, 'private');
    assert.notEqual(updated.fence.policyRevision, POLICY_REV);
    assert.equal(state.policyRevisions.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Command admission
// ---------------------------------------------------------------------------
