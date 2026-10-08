import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import type {
  OrganizePlannerBookmark,
  OrganizePlannerFolder,
} from '../../../src/modules/collections/application/organize-planner.js';
import { selectOrganizeSource } from '../../../src/modules/collections/application/organize-inbox-selection.js';

const ROOT_ID = 'root';

function folder(
  id: string,
  title: string,
  parentId = ROOT_ID,
): OrganizePlannerFolder {
  return { id, parentId, title };
}

function bookmark(
  id: string,
  parentId: string,
  title = id,
): OrganizePlannerBookmark {
  return { id, parentId, title, url: `https://example.test/${id}` };
}

describe('selectOrganizeSource', () => {
  test('Unsorted and Reading later match; standalone Later does not', () => {
    const folders = [
      folder('unsorted', 'Unsorted'),
      folder('reading-later', 'Reading later'),
      folder('later', 'Later'),
    ];
    const bookmarks = [
      bookmark('from-unsorted', 'unsorted'),
      bookmark('from-reading', 'reading-later'),
      bookmark('from-later', 'later'),
    ];

    const result = selectOrganizeSource({
      rootId: ROOT_ID,
      folders,
      bookmarks,
    });

    assert.deepEqual([...result.inboxFolderIds].sort(), ['reading-later', 'unsorted']);
    assert.deepEqual(
      result.bookmarks.map((item) => item.id).sort(),
      ['from-reading', 'from-unsorted'],
    );
    assert.ok(!result.inboxFolderIds.includes('later'));
    assert.ok(!result.bookmarks.some((item) => item.id === 'from-later'));
    assert.equal(result.folders, folders);
    assert.equal(result.rootId, ROOT_ID);
  });

  test('root-parent bookmarks do not appear in the source set', () => {
    const folders = [folder('inbox', 'Inbox')];
    const bookmarks = [
      bookmark('root-bookmark', ROOT_ID),
      bookmark('inbox-bookmark', 'inbox'),
    ];

    const result = selectOrganizeSource({
      rootId: ROOT_ID,
      folders,
      bookmarks,
    });

    assert.deepEqual(result.inboxFolderIds, ['inbox']);
    assert.deepEqual(
      result.bookmarks.map((item) => item.id),
      ['inbox-bookmark'],
    );
    assert.ok(!result.bookmarks.some((item) => item.parentId === ROOT_ID));
  });

  test('empty inbox or inbox without bookmarks yields empty source without throwing', () => {
    assert.doesNotThrow(() =>
      selectOrganizeSource({ rootId: ROOT_ID, folders: [], bookmarks: [] }),
    );

    const emptyInbox = selectOrganizeSource({
      rootId: ROOT_ID,
      folders: [],
      bookmarks: [bookmark('root-only', ROOT_ID)],
    });
    assert.deepEqual(emptyInbox.inboxFolderIds, []);
    assert.deepEqual(emptyInbox.bookmarks, []);

    const inboxWithoutBookmarks = selectOrganizeSource({
      rootId: ROOT_ID,
      folders: [folder('inbox', 'Inbox')],
      bookmarks: [],
    });
    assert.doesNotThrow(() =>
      selectOrganizeSource({
        rootId: ROOT_ID,
        folders: [folder('inbox', 'Inbox')],
        bookmarks: [],
      }),
    );
    assert.deepEqual(inboxWithoutBookmarks.inboxFolderIds, ['inbox']);
    assert.deepEqual(inboxWithoutBookmarks.bookmarks, []);
  });

  test('nested folder titled Inbox under a non-root parent is excluded', () => {
    const folders = [
      folder('projects', 'Projects'),
      folder('nested-inbox', 'Inbox', 'projects'),
      folder('unsorted', 'Unsorted'),
      folder('nested-under-unsorted', 'Archive', 'unsorted'),
    ];
    const bookmarks = [
      bookmark('nested-inbox-child', 'nested-inbox'),
      bookmark('direct-unsorted', 'unsorted'),
      bookmark('grandchild', 'nested-under-unsorted'),
    ];

    const result = selectOrganizeSource({
      rootId: ROOT_ID,
      folders,
      bookmarks,
    });

    assert.deepEqual(result.inboxFolderIds, ['unsorted']);
    assert.ok(!result.inboxFolderIds.includes('nested-inbox'));
    assert.deepEqual(
      result.bookmarks.map((item) => item.id),
      ['direct-unsorted'],
    );
    assert.ok(!result.bookmarks.some((item) => item.id === 'nested-inbox-child'));
    assert.ok(!result.bookmarks.some((item) => item.id === 'grandchild'));
    assert.equal(result.folders, folders);
  });
});
