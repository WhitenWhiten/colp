import assert from 'node:assert/strict';
import { test } from 'vitest';
import { advancedLocalFacts } from '../src/bootstrap/advanced-local-facts.js';
import { scanBoundary } from '../src/bookmark-boundary.js';
import type { NormalizedBookmarkNode, NormalizedBookmarkRoot } from '../src/chrome-bookmark-tree.js';

test('advanced facts retain protected descendants and original ordering without including other mounts', () => {
  const bookmark = (nativeId: string): NormalizedBookmarkNode => ({ nativeId, kind: 'bookmark',
    title: nativeId, url: `https://example.test/${nativeId}`, managed: false, children: [] });
  const roots: NormalizedBookmarkRoot[] = [{ nativeId: '0', rootKind: 'browser_root', kind: 'folder',
    title: '', managed: false, children: [
      { nativeId: 'bar', kind: 'folder', title: 'Bar', managed: false, children: [bookmark('selected'),
        { nativeId: 'private', kind: 'folder', title: 'Private', managed: false, children: [bookmark('private-child')] },
        { ...bookmark('managed'), managed: true }] },
      { nativeId: 'other', kind: 'folder', title: 'Other', managed: false, children: [bookmark('unselected')] },
    ] }];
  const scan = scanBoundary({ roots, selectedNativeIds: ['bar'], excludedNativeIds: ['private'] });
  const facts = advancedLocalFacts(roots, scan);
  assert.deepEqual(facts.map((fact) => fact.nativeId).sort(), ['bar', 'managed', 'private', 'private-child', 'selected']);
  assert.equal(facts.find((fact) => fact.nativeId === 'bar')?.parentNativeId, '0');
  assert.equal(facts.find((fact) => fact.nativeId === 'selected')?.index, 0);
  assert.equal(facts.find((fact) => fact.nativeId === 'managed')?.index, 2);
  for (const id of ['private', 'private-child', 'managed']) assert.equal(facts.find((fact) => fact.nativeId === id)?.privateLocal, true);
  assert.equal(facts.find((fact) => fact.nativeId === 'selected')?.privateLocal, undefined);
});
