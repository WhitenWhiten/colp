/**
 * P1-06 editor page query — authorization deny/conceal and 10k page-without-mix.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  EDITOR_PAGE_DEFAULT_LIMIT,
  EditorAuthorizationError,
  getCollectionEditorPage,
  type GetCollectionEditorPageInput,
  type GetCollectionEditorPagePorts,
} from '../../../src/modules/collections/index.js';
import {
  COLLECTION_ID,
  PRINCIPAL_STRANGER,
  PRINCIPAL_VIEWER,
  ROOT_ID,
  SUBJECT_STRANGER,
  SUBJECT_VIEWER,
  addBookmark,
  addFolder,
  createMemoryPorts,
  createState,
  lockedRowFromEditorState,
  ownerInput,
  query,
  seedOwnedCollection,
  sortedNodes,
} from './editor-page-query-helpers.js';

// ---------------------------------------------------------------------------
// Authorization deny / conceal
// ---------------------------------------------------------------------------

describe('getCollectionEditorPage: authorization deny/conceal', () => {
  test('missing collection → EditorAuthorizationError conceal', async () => {
    const state = createState();
    await assert.rejects(
      () => query(state, ownerInput({ collectionId: 'missing-col' })),
      (error: unknown) => {
        assert.ok(error instanceof EditorAuthorizationError);
        assert.equal(error.outcome, 'conceal');
        return true;
      },
    );
  });

  test('soft-deleted collection → EditorAuthorizationError conceal', async () => {
    const state = createState();
    seedOwnedCollection(state, { deleted: true });
    await assert.rejects(
      () => query(state, ownerInput()),
      (error: unknown) => {
        assert.ok(error instanceof EditorAuthorizationError);
        assert.equal(error.outcome, 'conceal');
        return true;
      },
    );
  });

  test('private collection non-member → conceal', async () => {
    const state = createState();
    seedOwnedCollection(state, { visibility: 'private' });
    await assert.rejects(
      () =>
        query(
          state,
          ownerInput({
            actor: {
              principalId: PRINCIPAL_STRANGER,
              subjectId: SUBJECT_STRANGER,
            },
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof EditorAuthorizationError);
        assert.equal(error.outcome, 'conceal');
        return true;
      },
    );
  });

  test('public collection non-member → deny (not conceal)', async () => {
    const state = createState();
    seedOwnedCollection(state, { visibility: 'public' });
    await assert.rejects(
      () =>
        query(
          state,
          ownerInput({
            actor: {
              principalId: PRINCIPAL_STRANGER,
              subjectId: SUBJECT_STRANGER,
            },
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof EditorAuthorizationError);
        assert.equal(error.outcome, 'deny');
        return true;
      },
    );
  });

  test('viewer membership can read_editor with mutation capabilities false', async () => {
    const state = createState();
    seedOwnedCollection(state);
    state.memberships.push({
      collectionId: COLLECTION_ID,
      subjectId: SUBJECT_VIEWER,
      role: 'viewer',
    });
    addBookmark(state, { id: 'bm-v', parentId: ROOT_ID, positionToken: '1' });

    const page = await query(
      state,
      ownerInput({
        actor: {
          principalId: PRINCIPAL_VIEWER,
          subjectId: SUBJECT_VIEWER,
        },
      }),
    );
    assert.equal(page.nodes.length, 1);
    assert.equal(page.capabilities.updateCollection, false);
    assert.equal(page.capabilities.managePublication, false);
    assert.equal(page.capabilities.createNode, false);
    assert.equal(page.capabilities.updateNode, false);
    assert.equal(page.capabilities.moveNode, false);
    assert.equal(page.capabilities.deleteNode, false);
  });

  test('marks pinned bookmarks and leaves others without the field', async () => {
    const state = createState();
    seedOwnedCollection(state);
    addBookmark(state, { id: 'bm-pinned', parentId: ROOT_ID, positionToken: '1', pinned: true });
    addBookmark(state, { id: 'bm-plain', parentId: ROOT_ID, positionToken: '2' });
    const page = await query(state, ownerInput());
    const pinned = page.nodes.find((node) => node.id === 'bm-pinned')!;
    const plain = page.nodes.find((node) => node.id === 'bm-plain')!;
    assert.equal(pinned.kind === 'bookmark' && pinned.pinned, true);
    assert.equal(Object.hasOwn(plain, 'pinned'), false);
  });

  test('lockForShare runs before authorize and snapshot', async () => {
    const state = createState();
    seedOwnedCollection(state);
    addBookmark(state, { id: 'bm-lock', parentId: ROOT_ID, positionToken: '1' });
    const order: string[] = [];
    const base = createMemoryPorts(state);
    const ports: GetCollectionEditorPagePorts = {
      ...base,
      collections: {
        async lockForShare(collectionId) {
          order.push('lock');
          return lockedRowFromEditorState(state, collectionId);
        },
      },
      accessPolicy: {
        async loadCollectionFacts(input) {
          order.push('authorize');
          return base.accessPolicy.loadCollectionFacts(input);
        },
      },
      loadSnapshot: {
        async loadCollectionEditorSnapshot(input) {
          order.push('snapshot');
          return base.loadSnapshot.loadCollectionEditorSnapshot(input);
        },
      },
    };

    const page = await getCollectionEditorPage(ports, ownerInput());
    assert.equal(page.nodes.length, 1);
    assert.deepEqual(order, ['lock', 'authorize', 'snapshot']);
  });

  test('mock that never locks conceals even when facts would allow', async () => {
    const state = createState();
    seedOwnedCollection(state);
    const base = createMemoryPorts(state);
    const ports: GetCollectionEditorPagePorts = {
      ...base,
      collections: {
        async lockForShare() {
          return null;
        },
      },
    };

    await assert.rejects(
      () => getCollectionEditorPage(ports, ownerInput()),
      (error: unknown) => {
        assert.ok(error instanceof EditorAuthorizationError);
        assert.equal(error.outcome, 'conceal');
        assert.equal(error.reasonCategory, 'resource_missing');
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 10k correctness (no timing SLA — residual evidence is P1-14)
// ---------------------------------------------------------------------------

describe('getCollectionEditorPage: 10k correctness (no SLA)', () => {
  test('10k synthetic nodes fully pageable under memory without mix or drop', async () => {
    const state = createState();
    seedOwnedCollection(state);

    const TOTAL = 10_000;
    for (let i = 0; i < TOTAL; i += 1) {
      const parentId =
        i % 17 === 0 && i > 0
          ? `folder-${String(Math.floor(i / 17)).padStart(4, '0')}`
          : ROOT_ID;
      if (parentId !== ROOT_ID && !state.nodes.some((n) => n.id === parentId)) {
        addFolder(state, {
          id: parentId,
          parentId: ROOT_ID,
          positionToken: `f-${String(Math.floor(i / 17)).padStart(5, '0')}`,
          title: parentId,
        });
      }
      addBookmark(state, {
        id: `n-${String(i).padStart(5, '0')}`,
        parentId,
        positionToken: String(i).padStart(6, '0'),
        title: `Node ${i}`,
      });
    }

    const expectedIds = sortedNodes(state, COLLECTION_ID).map((n) => n.id);
    assert.ok(expectedIds.length >= TOTAL);

    const seen: string[] = [];
    const seenSet = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    let snapshotId: string | undefined;
    let contentRevision: string | undefined;
    let policyRevision: string | undefined;

    for (;;) {
      const input: GetCollectionEditorPageInput = cursor
        ? ownerInput({ cursor })
        : ownerInput({ limit: 200 });
      const page = await query(state, input);
      pages += 1;

      if (snapshotId === undefined) {
        snapshotId = page.page.snapshotId;
        contentRevision = page.page.contentRevision;
        policyRevision = page.page.policyRevision;
      } else {
        assert.equal(page.page.snapshotId, snapshotId);
        assert.equal(page.page.contentRevision, contentRevision);
        assert.equal(page.page.policyRevision, policyRevision);
      }

      for (const node of page.nodes) {
        assert.ok(!seenSet.has(node.id), `duplicate node ${node.id} across pages`);
        seenSet.add(node.id);
        seen.push(node.id);
      }

      if (!page.page.hasMore) {
        assert.equal(page.page.nextCursor, null);
        break;
      }
      assert.ok(page.page.nextCursor);
      cursor = page.page.nextCursor;
      assert.ok(pages < 200, 'safety: too many pages');
    }

    assert.deepEqual(seen, expectedIds);
    assert.ok(pages >= Math.ceil(expectedIds.length / EDITOR_PAGE_DEFAULT_LIMIT));
  });
});
