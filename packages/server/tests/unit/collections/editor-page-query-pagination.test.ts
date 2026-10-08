/**
 * P1-06 editor page query — keyset pagination, cursor fencing, invalid_cursor, limit.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, test } from 'vitest';
import {
  EDITOR_PAGE_MAX_LIMIT,
  EditorCursorError,
  EditorInputError,
  PRODUCT_EDITOR_CURSOR_TTL_MS,
  SnapshotExpiredError,
  getCollectionEditorPage,
  type ProductEditorCursorPayload,
} from '../../../src/modules/collections/index.js';
import {
  COLLECTION_ID,
  NOW,
  PRINCIPAL_OWNER,
  PRINCIPAL_STRANGER,
  ROOT_ID,
  SUBJECT_OWNER,
  addBookmark,
  createMemoryPorts,
  createState,
  expectCode,
  forgeWrongPurposeCursor,
  ownerInput,
  query,
  seedOwnedCollection,
  sortedNodes,
  tamperCursor,
} from './editor-page-query-helpers.js';

// ---------------------------------------------------------------------------
// Pagination + cursor fencing
// ---------------------------------------------------------------------------

describe('getCollectionEditorPage: pagination and cursor fencing', () => {
  test('pages across cursor without mix; second page rejects wrong principal/collection', async () => {
    const state = createState();
    seedOwnedCollection(state);
    for (let i = 0; i < 5; i += 1) {
      addBookmark(state, {
        id: `bm-${i}`,
        parentId: ROOT_ID,
        positionToken: String(i).padStart(2, '0'),
        title: `Item ${i}`,
      });
    }

    const first = await query(state, ownerInput({ limit: 2 }));
    assert.equal(first.nodes.length, 2);
    assert.equal(first.page.hasMore, true);
    assert.ok(first.page.nextCursor);
    const cursor = first.page.nextCursor!;
    const firstIds = first.nodes.map((n) => n.id);

    const second = await query(state, ownerInput({ cursor }));
    assert.equal(second.nodes.length, 2);
    assert.equal(second.page.hasMore, true);
    assert.equal(second.page.snapshotId, first.page.snapshotId);
    assert.equal(second.page.contentRevision, first.page.contentRevision);
    assert.equal(second.page.policyRevision, first.page.policyRevision);
    assert.equal(second.page.expiresAt, first.page.expiresAt);
    const secondIds = second.nodes.map((n) => n.id);
    for (const id of secondIds) {
      assert.ok(!firstIds.includes(id), `node ${id} must not repeat across pages`);
    }

    const third = await query(state, ownerInput({ cursor: second.page.nextCursor! }));
    assert.equal(third.nodes.length, 1);
    assert.equal(third.page.hasMore, false);
    assert.equal(third.page.nextCursor, null);

    const allIds = [...firstIds, ...secondIds, ...third.nodes.map((n) => n.id)];
    assert.deepEqual(allIds, sortedNodes(state, COLLECTION_ID).map((n) => n.id));

    // Wrong principal → invalid_cursor
    await assert.rejects(
      () =>
        query(
          state,
          ownerInput({
            cursor,
            actor: {
              principalId: PRINCIPAL_STRANGER,
              subjectId: SUBJECT_OWNER,
            },
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof EditorCursorError);
        expectCode(error, 'invalid_cursor');
        return true;
      },
    );

    // Wrong collection → invalid_cursor (cursor scoped to collection)
    const other = createState();
    seedOwnedCollection(other, {
      collectionId: 'col-other',
      rootId: 'root-other',
      title: 'Other',
    });
    // Reuse cursor from first collection against a different collection id
    other.cursorKey = state.cursorKey;
    other.now = new Date(state.now);
    await assert.rejects(
      () =>
        getCollectionEditorPage(
          createMemoryPorts(other),
          {
            collectionId: 'col-other',
            actor: { principalId: PRINCIPAL_OWNER, subjectId: SUBJECT_OWNER },
            cursor,
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof EditorCursorError);
        expectCode(error, 'invalid_cursor');
        return true;
      },
    );
  });

  test('contentRevision change on continuation → snapshot_expired', async () => {
    const state = createState();
    seedOwnedCollection(state);
    for (let i = 0; i < 3; i += 1) {
      addBookmark(state, {
        id: `bm-c-${i}`,
        parentId: ROOT_ID,
        positionToken: String(i),
      });
    }

    const first = await query(state, ownerInput({ limit: 1 }));
    assert.ok(first.page.nextCursor);

    assert.ok(state.collection);
    state.collection = {
      ...state.collection,
      contentRevision: 'content-rev-mutated',
    };

    await assert.rejects(
      () => query(state, ownerInput({ cursor: first.page.nextCursor! })),
      (error: unknown) => {
        assert.ok(error instanceof SnapshotExpiredError);
        expectCode(error, 'snapshot_expired');
        return true;
      },
    );
  });

  test('policyRevision change on continuation → snapshot_expired', async () => {
    const state = createState();
    seedOwnedCollection(state);
    for (let i = 0; i < 3; i += 1) {
      addBookmark(state, {
        id: `bm-p-${i}`,
        parentId: ROOT_ID,
        positionToken: String(i),
      });
    }

    const first = await query(state, ownerInput({ limit: 1 }));
    assert.ok(first.page.nextCursor);

    assert.ok(state.collection);
    state.collection = {
      ...state.collection,
      policyRevision: 'policy-rev-mutated',
    };

    await assert.rejects(
      () => query(state, ownerInput({ cursor: first.page.nextCursor! })),
      (error: unknown) => {
        assert.ok(error instanceof SnapshotExpiredError);
        expectCode(error, 'snapshot_expired');
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Invalid cursor
// ---------------------------------------------------------------------------

describe('getCollectionEditorPage: invalid_cursor', () => {
  test('tampered cursor → invalid_cursor', async () => {
    const state = createState();
    seedOwnedCollection(state);
    addBookmark(state, { id: 'bm-1', parentId: ROOT_ID, positionToken: '1' });
    addBookmark(state, { id: 'bm-2', parentId: ROOT_ID, positionToken: '2' });

    const first = await query(state, ownerInput({ limit: 1 }));
    assert.ok(first.page.nextCursor);

    await assert.rejects(
      () => query(state, ownerInput({ cursor: tamperCursor(first.page.nextCursor!) })),
      (error: unknown) => {
        assert.ok(error instanceof EditorCursorError);
        expectCode(error, 'invalid_cursor');
        return true;
      },
    );
  });

  test('expired cursor (past 15 min absolute TTL) → invalid_cursor', async () => {
    const state = createState();
    seedOwnedCollection(state);
    addBookmark(state, { id: 'bm-1', parentId: ROOT_ID, positionToken: '1' });
    addBookmark(state, { id: 'bm-2', parentId: ROOT_ID, positionToken: '2' });

    const first = await query(state, ownerInput({ limit: 1 }));
    assert.ok(first.page.nextCursor);

    // Absolute TTL from first-page issue; not renewed on continuation.
    state.now = new Date(NOW.getTime() + PRODUCT_EDITOR_CURSOR_TTL_MS + 1);

    await assert.rejects(
      () => query(state, ownerInput({ cursor: first.page.nextCursor! })),
      (error: unknown) => {
        assert.ok(error instanceof EditorCursorError);
        expectCode(error, 'invalid_cursor');
        return true;
      },
    );
  });

  test('wrong purpose / garbage / empty cursor → invalid_cursor', async () => {
    const state = createState();
    seedOwnedCollection(state);
    addBookmark(state, { id: 'bm-1', parentId: ROOT_ID, positionToken: '1' });
    addBookmark(state, { id: 'bm-2', parentId: ROOT_ID, positionToken: '2' });

    const first = await query(state, ownerInput({ limit: 1 }));
    assert.ok(first.page.nextCursor);

    const garbage = ['', 'not-a-cursor', '///', randomBytes(32).toString('base64url')];
    for (const cursor of garbage) {
      await assert.rejects(
        () => query(state, ownerInput({ cursor })),
        (error: unknown) => {
          assert.ok(error instanceof EditorCursorError);
          expectCode(error, 'invalid_cursor');
          return true;
        },
        `cursor=${JSON.stringify(cursor)}`,
      );
    }

    // Decode a real cursor payload shape then re-sign with wrong purpose.
    const token = first.page.nextCursor!;
    const [, body] = token.split('.');
    assert.ok(body);
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ProductEditorCursorPayload;
    const wrongPurpose = forgeWrongPurposeCursor(state.cursorKey, payload);

    await assert.rejects(
      () => query(state, ownerInput({ cursor: wrongPurpose })),
      (error: unknown) => {
        assert.ok(error instanceof EditorCursorError);
        expectCode(error, 'invalid_cursor');
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Limit validation
// ---------------------------------------------------------------------------

describe('getCollectionEditorPage: limit validation', () => {
  test('limit max 500; out-of-range limit rejected as invalid_query', async () => {
    const state = createState();
    seedOwnedCollection(state);

    await assert.rejects(
      () => query(state, ownerInput({ limit: EDITOR_PAGE_MAX_LIMIT + 1 })),
      (error: unknown) => {
        assert.ok(error instanceof EditorInputError);
        expectCode(error, 'invalid_query');
        return true;
      },
    );

    await assert.rejects(
      () => query(state, ownerInput({ limit: 0 })),
      (error: unknown) => {
        assert.ok(error instanceof EditorInputError);
        expectCode(error, 'invalid_query');
        return true;
      },
    );

    await assert.rejects(
      () => query(state, ownerInput({ limit: -1 })),
      (error: unknown) => {
        assert.ok(error instanceof EditorInputError);
        expectCode(error, 'invalid_query');
        return true;
      },
    );

    for (let i = 0; i < 10; i += 1) {
      addBookmark(state, {
        id: `bm-max-${i}`,
        parentId: ROOT_ID,
        positionToken: String(i).padStart(3, '0'),
      });
    }
    const page = await query(state, ownerInput({ limit: EDITOR_PAGE_MAX_LIMIT }));
    assert.ok(page.nodes.length <= EDITOR_PAGE_MAX_LIMIT);
  });

  test('limit + cursor together rejected as invalid_query', async () => {
    const state = createState();
    seedOwnedCollection(state);
    addBookmark(state, { id: 'bm-1', parentId: ROOT_ID, positionToken: '1' });
    addBookmark(state, { id: 'bm-2', parentId: ROOT_ID, positionToken: '2' });

    const first = await query(state, ownerInput({ limit: 1 }));
    assert.ok(first.page.nextCursor);

    await assert.rejects(
      () =>
        query(
          state,
          ownerInput({
            limit: 50,
            cursor: first.page.nextCursor!,
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof EditorInputError);
        expectCode(error, 'invalid_query');
        return true;
      },
    );
  });
});
