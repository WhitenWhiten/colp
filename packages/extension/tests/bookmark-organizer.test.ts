import { expect, test } from 'vitest';
import { organizeChoices, organizePaths, validOrganizeRequest } from '../src/bookmark-organizer.js';

type Node = chrome.bookmarks.BookmarkTreeNode;
const folder = (id: string, parentId: string, children: Node[] = [], extra: Partial<Node> = {}): Node =>
  ({ id, parentId, title: id, children, ...extra });
const tree = [folder('0', '', [folder('1', '0', [
  folder('a', '1', [folder('nested', 'a', [folder('deep', 'nested')]),
    folder('readonly', 'a', [folder('owned', 'readonly')])]),
  folder('b', '1', [folder('b-child', 'b')]),
  folder('link', '1', [], { url: 'https://example.test/' }),
  folder('subscription', '1', [folder('subscription-child', 'subscription')]),
]), folder('2', '0'), folder('managed', '0', [folder('policy', 'managed')], { folderType: 'managed', unmodifiable: 'managed' }),
folder('unsupported', '0', [folder('not-allowed', 'unsupported')])])];
const excluded = new Set(['readonly', 'subscription']);

test('lists every writable root and first-level folder, with no deeper selections', () => {
  expect(organizeChoices(tree, excluded)).toEqual([
    { nativeId: '1', title: '1', rootTitle: '1', recursive: false },
    { nativeId: 'a', title: 'a', rootTitle: '1', recursive: true },
    { nativeId: 'b', title: 'b', rootTitle: '1', recursive: true },
    { nativeId: '2', title: '2', rootTitle: '2', recursive: false },
  ]);
});

test('selecting a root includes only its direct contents, independently of folder checkboxes', () => {
  expect(organizePaths(tree, ['1'], excluded).map(node => node.id)).toEqual(['1']);
});

test('selecting a first-level folder includes all deeper personal folders but no unselected tree', () => {
  expect(organizePaths(tree, ['a'], excluded).map(node => node.id)).toEqual(['a', 'nested', 'deep']);
  expect(organizePaths(tree, ['1', 'b'], excluded).map(node => node.id)).toEqual(['1', 'b', 'b-child']);
});

test.each([['nested'], ['deep'], ['readonly'], ['subscription'], ['managed'], ['unsupported'], ['0'], ['link'], ['missing'], ['a', 'a'], []])
  ('rejects invalid selections before providing a mutation plan: %j', (...ids) => {
    expect(() => organizePaths(tree, ids, excluded)).toThrow('tree_changed');
  });

test('validates request shape, user intent, unique bounded IDs, and no arbitrary recursion flags', () => {
  expect(validOrganizeRequest({ kind: 'known.bookmarks.organize.preview' })).toBe(true);
  expect(validOrganizeRequest({ kind: 'known.bookmarks.organize.apply', userGesture: true, nativeIds: ['1', 'a'] })).toBe(true);
  for (const value of [null, [], { kind: 'known.bookmarks.organize.preview', extra: true },
    { kind: 'known.bookmarks.organize.apply', nativeIds: ['1'] },
    { kind: 'known.bookmarks.organize.apply', userGesture: false, nativeIds: ['1'] },
    { kind: 'known.bookmarks.organize.apply', userGesture: true, nativeIds: [] },
    { kind: 'known.bookmarks.organize.apply', userGesture: true, nativeIds: ['1', '1'] },
    { kind: 'known.bookmarks.organize.apply', userGesture: true, nativeIds: ['1'], recursive: true },
    { kind: 'known.bookmarks.organize.apply', userGesture: true, nativeIds: ['../1'] },
    { kind: 'known.bookmarks.organize.apply', userGesture: true, nativeIds: ['x'.repeat(129)] },
  ]) expect(validOrganizeRequest(value)).toBe(false);
});
