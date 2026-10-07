import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  CLASSIFY_INBOX_DEFAULT_LIMIT,
  ClassifyInboxInputError,
  createProductClassifyInboxCursorSigner,
  getMyClassifyInboxPage,
  isClassifyInboxEligible,
  scoreClassifyInboxSuggestions,
  type ClassifyInboxBookmarkRow,
  type ClassifyInboxFolderRow,
  type ClassifyInboxReadPort,
} from '../../../src/modules/collections/index.js';
import {
  buildClassifyInboxFixture,
  toScoreInput,
} from '../../support/classify-inbox-fixtures.js';

const NOW = new Date('2026-08-24T08:00:00.000Z');
const OWNER = 'subject-owner';
const STRANGER = 'subject-stranger';

interface SeedBookmark extends ClassifyInboxBookmarkRow {
  readonly ownerSubjectId: string;
}

function bookmark(overrides: Partial<SeedBookmark> & Pick<SeedBookmark, 'nodeId'>): SeedBookmark {
  return {
    ownerSubjectId: OWNER,
    collectionId: 'col-classify-inbox',
    collectionTitle: 'Inbox library',
    title: 'Design systems',
    url: 'https://system.example.com/essay',
    resourceRevision: `rev-${overrides.nodeId}`,
    createdAt: NOW,
    isOwner: true,
    kind: 'bookmark',
    softDeleted: false,
    parentKind: 'root',
    hasSidecar: false,
    ...overrides,
  };
}

function folder(overrides: Partial<ClassifyInboxFolderRow> = {}): ClassifyInboxFolderRow {
  return {
    collectionId: 'col-classify-inbox',
    folderId: 'fld-spacing',
    folderTitle: 'Spacing as a system',
    ...overrides,
  };
}

function memoryReads(
  bookmarks: readonly SeedBookmark[],
  folders: readonly ClassifyInboxFolderRow[],
): ClassifyInboxReadPort {
  return {
    async listInboxBookmarks(input) {
      const eligible = bookmarks.filter((row) => (
        row.ownerSubjectId === input.ownerSubjectId
        && isClassifyInboxEligible({
          isOwner: row.ownerSubjectId === input.ownerSubjectId,
          kind: row.kind,
          softDeleted: row.softDeleted,
          url: row.url,
          parentKind: row.parentKind,
          hasSidecar: row.hasSidecar,
        })
      )).sort((left, right) => {
        const time = right.createdAt.getTime() - left.createdAt.getTime();
        if (time !== 0) return time;
        if (left.nodeId > right.nodeId) return -1;
        if (left.nodeId < right.nodeId) return 1;
        return 0;
      }).filter((row) => {
        if (!input.after) return true;
        if (row.createdAt.getTime() < input.after.createdAt.getTime()) return true;
        return row.createdAt.getTime() === input.after.createdAt.getTime()
          && row.nodeId < input.after.nodeId;
      });
      return eligible.slice(0, input.limit + 1).map((row) => {
        const { ownerSubjectId: _owner, ...rest } = row;
        return {
          ...rest,
          isOwner: row.ownerSubjectId === input.ownerSubjectId,
        };
      });
    },
    async listLiveFolders(input) {
      if (input.collectionIds.length === 0) return [];
      const allowed = new Set(input.collectionIds);
      return folders.filter((item) => allowed.has(item.collectionId));
    },
  };
}

function ports(bookmarks: readonly SeedBookmark[], folders: readonly ClassifyInboxFolderRow[]) {
  const signer = createProductClassifyInboxCursorSigner({
    current: { id: 'ci-app-v1', key: 'classify-inbox-app-cursor-secret-material' },
  });
  return {
    signer,
    ports: {
      reads: memoryReads(bookmarks, folders),
      cursors: signer,
      clock: { now: async () => NOW },
    },
  };
}

test('owned live root bookmark is included with scorer suggestions', async () => {
  const fixture = buildClassifyInboxFixture();
  const { signer, ports: pagePorts } = ports(
    [bookmark({ nodeId: fixture.bookmark.id, title: fixture.bookmark.title, url: fixture.bookmark.url ?? '' })],
    [folder({ folderId: fixture.folder.id, folderTitle: fixture.folder.title })],
  );
  try {
    const page = await getMyClassifyInboxPage(pagePorts, { actor: { subjectId: OWNER } });
    assert.equal(page.items.length, 1);
    const item = page.items[0];
    assert.ok(item);
    assert.equal(item.nodeId, fixture.bookmark.id);
    assert.equal(item.collectionId, fixture.collection.id);
    assert.equal(item.host, 'system.example.com');
    assert.equal(item.etag, `"rev-${fixture.bookmark.id}"`);
    assert.equal(item.createdAt, '2026-08-24T08:00:00Z');
    assert.deepEqual(item.suggestions, scoreClassifyInboxSuggestions(toScoreInput(fixture)));
    assert.equal(page.nextCursor, null);
  } finally {
    signer.destroy();
  }
});

test('folder-child bookmarks are excluded', async () => {
  const { signer, ports: pagePorts } = ports(
    [
      bookmark({ nodeId: 'node-root-bookmark' }),
      bookmark({ nodeId: 'node-folder-child', parentKind: 'folder' }),
    ],
    [folder()],
  );
  try {
    const page = await getMyClassifyInboxPage(pagePorts, { actor: { subjectId: OWNER } });
    assert.deepEqual(page.items.map((item) => item.nodeId), ['node-root-bookmark']);
  } finally {
    signer.destroy();
  }
});

test('sidecar decisions exclude the bookmark', async () => {
  const { signer, ports: pagePorts } = ports(
    [
      bookmark({ nodeId: 'node-open' }),
      bookmark({ nodeId: 'node-skipped', hasSidecar: true }),
    ],
    [folder()],
  );
  try {
    const page = await getMyClassifyInboxPage(pagePorts, { actor: { subjectId: OWNER } });
    assert.deepEqual(page.items.map((item) => item.nodeId), ['node-open']);
  } finally {
    signer.destroy();
  }
});

test('non-owner bookmarks are excluded', async () => {
  const { signer, ports: pagePorts } = ports(
    [
      bookmark({ nodeId: 'node-mine' }),
      bookmark({ nodeId: 'node-theirs', ownerSubjectId: STRANGER, isOwner: false }),
    ],
    [folder()],
  );
  try {
    const ownerPage = await getMyClassifyInboxPage(pagePorts, { actor: { subjectId: OWNER } });
    assert.deepEqual(ownerPage.items.map((item) => item.nodeId), ['node-mine']);
    const strangerPage = await getMyClassifyInboxPage(pagePorts, { actor: { subjectId: STRANGER } });
    assert.deepEqual(strangerPage.items.map((item) => item.nodeId), ['node-theirs']);
  } finally {
    signer.destroy();
  }
});

test('keyset continuation is cursor-only and newest-first', async () => {
  const newer = bookmark({
    nodeId: 'node-newer',
    createdAt: new Date('2026-08-24T09:00:00.000Z'),
  });
  const older = bookmark({
    nodeId: 'node-older',
    createdAt: new Date('2026-08-24T07:00:00.000Z'),
  });
  const { signer, ports: pagePorts } = ports([older, newer], [folder()]);
  try {
    const first = await getMyClassifyInboxPage(pagePorts, { actor: { subjectId: OWNER }, limit: 1 });
    assert.deepEqual(first.items.map((item) => item.nodeId), ['node-newer']);
    assert.ok(first.nextCursor);
    const payload = signer.verify(first.nextCursor, NOW);
    assert.equal(payload.purpose, 'classify_inbox_v1');
    assert.equal(payload.limit, 1);
    assert.equal(payload.after.nodeId, 'node-newer');
    const second = await getMyClassifyInboxPage(pagePorts, {
      actor: { subjectId: OWNER }, cursor: first.nextCursor,
    });
    assert.deepEqual(second.items.map((item) => item.nodeId), ['node-older']);
    assert.equal(second.nextCursor, null);
    await assert.rejects(
      () => getMyClassifyInboxPage(pagePorts, {
        actor: { subjectId: OWNER }, cursor: first.nextCursor, limit: 1,
      }),
      ClassifyInboxInputError,
    );
  } finally {
    signer.destroy();
  }
});

test('default limit is 20 and values above 50 are invalid_query', async () => {
  assert.equal(CLASSIFY_INBOX_DEFAULT_LIMIT, 20);
  const { signer, ports: pagePorts } = ports([], []);
  try {
    await assert.rejects(
      () => getMyClassifyInboxPage(pagePorts, { actor: { subjectId: OWNER }, limit: 51 }),
      (error: unknown) => error instanceof ClassifyInboxInputError && error.code === 'invalid_query',
    );
  } finally {
    signer.destroy();
  }
});
