import { describe, expect, it } from 'vitest';
import { canonicalLocation, projectFolder, projectRule, type ProjectionDeps } from '../src/automation/binding-projector.js';
import { COLLECTION_ID, SERVER_UUID, compiledRule, folderRef } from './automation-fixture.js';

interface Native { readonly id: string; readonly title: string; readonly parentId?: string; readonly url?: string }
function deps(natives: readonly Native[], mappings: Readonly<Record<string, string>>, kinds: Readonly<Record<string, string>> = {}): ProjectionDeps {
  const byColp = new Map(Object.entries(mappings)), byNative = new Map(Object.entries(mappings).map(([colp, native]) => [native, colp]));
  const nodes = new Map(natives.map((node) => [node.id, node]));
  return {
    async mappingByColpId(colpId) { const nativeId = byColp.get(colpId); return nativeId ? { nativeId, ...(kinds[colpId] ? { nodeKind: kinds[colpId] } : {}) } : null; },
    async mappingByNativeId(nativeId) { const colpId = byNative.get(nativeId); return colpId ? { colpId, ...(kinds[colpId] ? { nodeKind: kinds[colpId] } : {}) } : null; },
    async nativeNode(nativeId) { return nodes.get(nativeId) ?? null; },
  };
}

const tree: Native[] = [
  { id: '1', title: 'Bookmarks bar', parentId: '0' },
  { id: '10', title: 'Academic', parentId: '1' },
  { id: '11', title: 'Papers', parentId: '10' },
  { id: '20', title: 'Academic', parentId: '1' },
  { id: '30', title: 'A bookmark', parentId: '1', url: 'https://example.org/' },
];

describe('canonical to native folder projection', () => {
  it('resolves a bound folder only through its Sync mapping', async () => {
    const projected = await projectFolder(folderRef('academic'), COLLECTION_ID, deps(tree, { academic: '10' }));
    expect(projected).toEqual({ status: 'resolved', folder: folderRef('academic'), nativeId: '10', title: 'Academic' });
  });

  it('never picks a same-named folder when the mapping is missing', async () => {
    // Folder 20 is also called "Academic"; without a mapping the rule waits instead of guessing.
    expect(await projectFolder(folderRef('academic'), COLLECTION_ID, deps(tree, {}))).toEqual({ status: 'unresolved', folder: folderRef('academic'), reason: 'unmapped' });
  });

  it('reports folders of another collection, deleted folders and non-folders as unresolved', async () => {
    const mapped = deps(tree, { academic: '10', gone: '99', page: '30' }, { page: 'bookmark' });
    expect(await projectFolder(folderRef('academic', 'c_other'), COLLECTION_ID, mapped)).toMatchObject({ status: 'unresolved', reason: 'otherCollection' });
    expect(await projectFolder(folderRef('gone'), COLLECTION_ID, mapped)).toMatchObject({ status: 'unresolved', reason: 'deleted' });
    expect(await projectFolder(folderRef('page'), COLLECTION_ID, mapped)).toMatchObject({ status: 'unresolved', reason: 'notFolder' });
    expect(await projectFolder(folderRef('page'), COLLECTION_ID, deps(tree, { page: '30' }))).toMatchObject({ status: 'unresolved', reason: 'notFolder' });
  });

  it('projects every folder role of a rule', async () => {
    const local = await projectRule(compiledRule(), COLLECTION_ID, deps(tree, { academic: '10' }));
    expect(local.folders.academicRoot).toMatchObject({ status: 'resolved', nativeId: '10' });
  });
});

describe('native to canonical location', () => {
  const context = { serverUuid: SERVER_UUID, collectionId: COLLECTION_ID };

  it('walks mapped ancestors and stops at the first folder outside the collection', async () => {
    const location = await canonicalLocation('11', context, deps(tree, { papers: '11', academic: '10' }));
    expect(location).toEqual({ parent: folderRef('papers'), ancestors: [folderRef('papers'), folderRef('academic')] });
  });

  it('has no parent for an unmapped folder', async () => {
    expect(await canonicalLocation('20', context, deps(tree, { academic: '10' }))).toEqual({ ancestors: [] });
  });

  it('stops on a cycle', async () => {
    const looping = deps([{ id: 'a', title: 'A', parentId: 'b' }, { id: 'b', title: 'B', parentId: 'a' }], { fa: 'a', fb: 'b' });
    expect((await canonicalLocation('a', context, looping)).ancestors).toHaveLength(2);
  });
});
