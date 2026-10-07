import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  isAllowedRecoveredParent,
  SYNC_CREATE_FOLDER_ROLE_UNIQUE_LIVE,
  SYNC_RECOVERED_PARENT_ROLES,
  SYNC_RECOVERED_UNIQUE_BY_PARENT,
} from '../../../src/modules/sync/sync-mount-roles.js';

describe('FRR-05 recovered uniqueness contract', () => {
  test('special roots stay Collection-unique and recovered is unique per parent', () => {
    assert.deepEqual([...SYNC_CREATE_FOLDER_ROLE_UNIQUE_LIVE], [
      'bookmarks-bar', 'other-bookmarks', 'mobile-bookmarks',
    ]);
    assert.equal(SYNC_RECOVERED_UNIQUE_BY_PARENT, true);
    assert.deepEqual([...SYNC_RECOVERED_PARENT_ROLES], [
      'bookmarks-bar', 'other-bookmarks', 'mobile-bookmarks', 'custom',
    ]);
  });

  test('recovered may hang off a live mount or the Collection root, not a regular folder', () => {
    assert.equal(isAllowedRecoveredParent({ isRoot: true, nodeKind: 'folder', folderRole: 'root' }), true);
    assert.equal(isAllowedRecoveredParent({
      isRoot: false, nodeKind: 'folder', folderRole: 'bookmarks-bar',
    }), true);
    assert.equal(isAllowedRecoveredParent({ isRoot: false, nodeKind: 'folder', folderRole: 'custom' }), true);
    assert.equal(isAllowedRecoveredParent({ isRoot: false, nodeKind: 'folder', folderRole: null }), false);
    assert.equal(isAllowedRecoveredParent({
      isRoot: false, nodeKind: 'folder', folderRole: 'recovered',
    }), false);
  });
});
