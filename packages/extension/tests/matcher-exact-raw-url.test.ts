/**
 * P2-04: Extension pairing and candidates compare stored URL strings exactly.
 * Backend normalizeBookmarkUrl is advisory and must not become sync identity.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  matchLocalRemote, type LocalNodeFact, type MappingFact, type MountFact, type RemoteNodeFact,
} from '../src/bootstrap/matcher.js';

const BAR: MountFact = { nativeRootId: 'bar', rootRole: 'bookmarks-bar', remoteMountNodeId: 'mount-bar' };
const OTHER: MountFact = { nativeRootId: 'other', rootRole: 'other-bookmarks', remoteMountNodeId: 'mount-other' };

const VARIANTS: ReadonlyArray<{ readonly name: string; readonly local: string; readonly remote: string }> = [
  { name: 'case', local: 'https://Example.COM/docs', remote: 'https://example.com/docs' },
  { name: 'default port', local: 'https://example.com:443/docs', remote: 'https://example.com/docs' },
  { name: 'trailing slash', local: 'https://example.com/docs/', remote: 'https://example.com/docs' },
  { name: 'fragment', local: 'https://example.com/docs#section', remote: 'https://example.com/docs' },
  { name: 'tracking query', local: 'https://example.com/docs?utm_source=news', remote: 'https://example.com/docs' },
  { name: 'query order', local: 'https://example.com/docs?b=2&a=1', remote: 'https://example.com/docs?a=1&b=2' },
  { name: 'percent encoding', local: 'https://example.com/%7Euser', remote: 'https://example.com/~user' },
  { name: 'similar path', local: 'https://example.com/docs', remote: 'https://example.com/docs2' },
];

function structure(): RemoteNodeFact[] {
  return [
    { nodeId: 'folder-root', parentId: null, kind: 'folder', title: '', folderRole: 'root', revision: 'r0' },
    { nodeId: 'mount-bar', parentId: 'folder-root', kind: 'folder', title: 'Bar', folderRole: 'bookmarks-bar',
      revision: 'r1' },
    { nodeId: 'folder-a', parentId: 'mount-bar', kind: 'folder', title: 'A', revision: 'r1' },
    { nodeId: 'folder-b', parentId: 'mount-bar', kind: 'folder', title: 'B', revision: 'r1' },
  ];
}

function merge(input: {
  readonly local: readonly LocalNodeFact[];
  readonly remote: readonly RemoteNodeFact[];
  readonly mappings?: readonly MappingFact[];
  readonly mounts?: readonly MountFact[];
}) {
  return matchLocalRemote({
    scopeKey: 'scope-1', confirmationId: 'conf-raw', local: input.local, remote: input.remote,
    mappings: input.mappings ?? [{ nativeId: 'folder-a', colpId: 'folder-a' }],
    mounts: input.mounts ?? [BAR], rootNodeId: 'folder-root', bootstrapMode: 'merge',
  });
}

function bookmark(nativeId: string, parentNativeId: string, title: string, url: string,
  mountNativeRootId = 'bar'): LocalNodeFact {
  return { nativeId, mountNativeRootId, parentNativeId, kind: 'bookmark', title, url };
}

function remoteBookmark(nodeId: string, parentId: string, title: string, url: string): RemoteNodeFact {
  return { nodeId, parentId, kind: 'bookmark', title, url, revision: 'r2' };
}

function assertKeptSeparate(
  report: ReturnType<typeof matchLocalRemote>, localId: string, remoteId: string, localUrl: string,
): void {
  assert.equal(report.matched.some((row) => row.nativeId === localId && row.nodeId === remoteId), false);
  assert.deepEqual(report.planned.filter((op) => op.type !== 'create_node'), []);
  assert.ok(report.localOnly.includes(localId));
  assert.ok(report.remoteOnly.includes(remoteId));
  const created = report.planned.find((op) => op.nativeId === localId);
  assert.equal(created?.type, 'create_node');
  assert.equal(created?.node?.url, localUrl);
  assert.equal(report.candidates.some((row) => row.nodeIds.includes(localId) && row.nodeIds.includes(remoteId)),
    false);
}

describe('P2-04 exact raw URL identity', () => {
  test('unique same parent, title, and exact raw URL still pairs', () => {
    const url = 'https://example.com/docs';
    const report = merge({
      local: [bookmark('native-1', 'folder-a', 'Doc', url)],
      remote: [...structure(), remoteBookmark('bm-cloud', 'folder-a', 'Doc', url)],
    });
    assert.deepEqual(report.matched, [{ nativeId: 'native-1', nodeId: 'bm-cloud' }]);
    assert.equal(report.planned.some((op) => op.nativeId === 'native-1'), false);
    assert.equal(report.candidates.length, 0);
  });

  for (const variant of VARIANTS) {
    test(`${variant.name} spelling does not pair, candidate, or merge`, () => {
      const report = merge({
        local: [bookmark('native-1', 'folder-a', 'Doc', variant.local)],
        remote: [...structure(), remoteBookmark('bm-cloud', 'folder-a', 'Doc', variant.remote)],
      });
      assertKeptSeparate(report, 'native-1', 'bm-cloud', variant.local);
    });
  }

  test('same title different URL does not pair, candidate, or merge', () => {
    const report = merge({
      local: [bookmark('native-1', 'folder-a', 'Same title', 'https://example.com/alpha')],
      remote: [...structure(), remoteBookmark('bm-cloud', 'folder-a', 'Same title', 'https://example.com/beta')],
    });
    assertKeptSeparate(report, 'native-1', 'bm-cloud', 'https://example.com/alpha');
  });

  test('same URL different parent is a candidate and never an auto-merge', () => {
    const url = 'https://example.com/dup';
    const report = merge({
      local: [bookmark('native-1', 'folder-a', 'Doc', url)],
      remote: [...structure(), remoteBookmark('bm-cloud', 'folder-b', 'Doc', url)],
      mappings: [{ nativeId: 'folder-a', colpId: 'folder-a' }, { nativeId: 'folder-b', colpId: 'folder-b' }],
    });
    assert.equal(report.matched.length, 0);
    assert.deepEqual(report.planned.filter((op) => op.type !== 'create_node'), []);
    assert.equal(report.planned.find((op) => op.nativeId === 'native-1')?.type, 'create_node');
    assert.ok(report.candidates.some((row) => row.kind === 'duplicate_candidate' && row.url === url
      && row.nodeIds.includes('native-1') && row.nodeIds.includes('bm-cloud')));
  });

  test('exact URL candidates stay inside one mount and do not leak across mounts', () => {
    const url = 'https://example.com/shared';
    const report = merge({
      local: [
        bookmark('native-bar', 'folder-a', 'Bar copy', url, 'bar'),
        bookmark('native-other', 'folder-other', 'Other copy', url, 'other'),
      ],
      remote: [
        ...structure(),
        { nodeId: 'mount-other', parentId: 'folder-root', kind: 'folder', title: 'Other',
          folderRole: 'other-bookmarks', revision: 'r1' },
        { nodeId: 'folder-other', parentId: 'mount-other', kind: 'folder', title: 'Other folder', revision: 'r1' },
        remoteBookmark('bm-bar', 'folder-a', 'Bar cloud', url),
        remoteBookmark('bm-other', 'folder-other', 'Other cloud', url),
      ],
      mappings: [
        { nativeId: 'folder-a', colpId: 'folder-a' },
        { nativeId: 'folder-other', colpId: 'folder-other' },
      ],
      mounts: [BAR, OTHER],
    });
    assert.equal(report.matched.length, 0);
    assert.deepEqual(report.planned.filter((op) => op.type !== 'create_node'), []);
    const bar = report.candidates.find((row) => row.nodeIds.includes('native-bar'));
    const other = report.candidates.find((row) => row.nodeIds.includes('native-other'));
    assert.ok(bar);
    assert.ok(other);
    assert.equal(bar.nodeIds.includes('bm-other') || bar.nodeIds.includes('native-other'), false);
    assert.equal(other.nodeIds.includes('bm-bar') || other.nodeIds.includes('native-bar'), false);
    assert.ok(bar.nodeIds.includes('bm-bar'));
    assert.ok(other.nodeIds.includes('bm-other'));
  });

  test('foreign Collection rows with the same URL do not enter this mount candidate group', () => {
    const url = 'https://example.com/shared';
    const report = merge({
      local: [bookmark('native-1', 'folder-a', 'Local', url)],
      remote: [
        ...structure(),
        remoteBookmark('bm-bar', 'folder-a', 'This collection', url),
        { nodeId: 'foreign-root', parentId: null, kind: 'folder', title: '', folderRole: 'root', revision: 'r0' },
        { nodeId: 'foreign-mount', parentId: 'foreign-root', kind: 'folder', title: 'Foreign bar',
          folderRole: 'bookmarks-bar', revision: 'r1' },
        remoteBookmark('bm-foreign', 'foreign-mount', 'Foreign collection', url),
      ],
    });
    assert.equal(report.matched.length, 0);
    const candidate = report.candidates.find((row) => row.nodeIds.includes('native-1'));
    assert.ok(candidate);
    assert.ok(candidate.nodeIds.includes('bm-bar'));
    assert.equal(candidate.nodeIds.includes('bm-foreign'), false);
    assert.equal(report.candidates.some((row) => row.nodeIds.includes('bm-foreign')
      && (row.nodeIds.includes('native-1') || row.nodeIds.includes('bm-bar'))), false);
  });
});
