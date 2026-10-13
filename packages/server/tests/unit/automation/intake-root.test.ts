import { expect, test } from 'vitest';
import { isIntakeRootFolder, isIntakeRootSnapshot } from '../../../src/modules/automation/domain/intake-root.js';

test.each(['bookmarks-bar', 'other-bookmarks', 'mobile-bookmarks'])('canonical browser intake role %s is recognized', folderRole => {
  expect(isIntakeRootFolder({ isRoot: false, folderRole })).toBe(true);
  expect(isIntakeRootSnapshot({ parentId: folderRole, parentIsIntakeRoot: true }, 'root')).toBe(true);
});

test('root identity and trusted event-time evidence, never a name heuristic', () => {
  expect(isIntakeRootFolder({ isRoot: true, folderRole: null })).toBe(true);
  expect(isIntakeRootSnapshot({ parentId: 'root' }, 'root')).toBe(true);
  for (const folderRole of ['Bookmarks Bar', 'academic', '', null]) {
    expect(isIntakeRootFolder({ isRoot: false, folderRole })).toBe(false);
  }
  expect(isIntakeRootSnapshot({ parentId: 'bookmarks-bar' }, 'root')).toBe(false);
  expect(isIntakeRootSnapshot({ parentId: 'selected', parentIsIntakeRoot: false }, 'root')).toBe(false);
  expect(isIntakeRootSnapshot(null, 'root')).toBe(false);
  expect(isIntakeRootFolder(undefined)).toBe(false);
});
