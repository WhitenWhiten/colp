import 'fake-indexeddb/auto';
import { expect, test } from 'vitest';
import { dependsOnIssue, issueAncestry, readOpenSyncIssues } from '../src/sync-issues.js';
import { installKns05IndexedDb, scope, setup } from './kns-05-pull-harness.js';
installKns05IndexedDb();
test('shared issue reader includes all durable directions and conflict decisions', async () => {
  const f = await setup();
  try {
    await f.store.recordLocalIssue(scope, { nativeId: 'native-node', code: 'deletion_identity_unproven', now: 1 });
    const open = await readOpenSyncIssues(f.store, scope);
    expect(open.total).toBe(1); expect(open.nativeRoots.has('native-node')).toBe(true);
  } finally { f.store.close(); }
});
test('ancestry holds existing descendants and destination parents, preserving siblings', () => {
  const parents = new Map([['folder', null], ['child', 'folder'], ['grandchild', 'child'], ['sibling', null]]);
  const roots = new Set(['folder']);
  expect(dependsOnIssue(['grandchild'], roots, parents)).toBe(true);
  expect(dependsOnIssue(['sibling', 'child'], roots, parents)).toBe(true);
  expect(dependsOnIssue(['sibling'], roots, parents)).toBe(false);
  expect(dependsOnIssue(['new', 'child'], roots, parents)).toBe(true);
  expect(issueAncestry([]).size).toBe(0);
});
test('missing intermediate ancestry, cycles and excessive depth fail closed', () => {
  const roots = new Set(['held']);
  expect(dependsOnIssue(['child'], roots, new Map([['child', 'missing']]))).toBe(true);
  expect(dependsOnIssue(['a'], roots, new Map([['a', 'b'], ['b', 'a']]))).toBe(true);
  const deep = new Map(Array.from({ length: 260 }, (_, n) => [String(n), String(n + 1)]));
  expect(dependsOnIssue(['0'], roots, deep)).toBe(true);
});
