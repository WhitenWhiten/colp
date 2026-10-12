import { expect, test } from 'vitest';
import { resolveClassificationNativeFolder } from '../src/classification-folder.js';
import type { MappingInput } from '../src/sync-state-store.js';
import type { FolderTreeNode } from '../src/save-folder.js';
import { workspaceFolderTree } from './fixtures/workspace-folders.js';
const mapping:MappingInput={nativeId:'42',colpId:'folder',rootNativeId:'root',nodeKind:'folder',projection:{revision:'r1',digest:'digest',content:{title:'Authoritative title'}}};
test('resolves only a live native folder within the current synced scope',async()=>{
  const deps={mapping:async()=>mapping,native:async()=>({title:'Technology'}),inScope:async()=>true};
  expect(await resolveClassificationNativeFolder('folder',deps)).toEqual({folderId:'folder',nativeId:'42',title:'Technology'});
  expect(await resolveClassificationNativeFolder(null,deps)).toBeNull();
  expect(await resolveClassificationNativeFolder('other',deps)).toBeNull();
  expect(await resolveClassificationNativeFolder('folder',{...deps,inScope:async()=>false})).toBeNull();
  expect(await resolveClassificationNativeFolder('folder',{...deps,native:async()=>undefined})).toBeNull();
  expect(await resolveClassificationNativeFolder('folder',{...deps,native:async()=>({title:'Bookmark',url:'https://example.org'})})).toBeNull();
  expect(await resolveClassificationNativeFolder('folder',{...deps,mapping:async()=>({...mapping,nodeKind:'bookmark' as const})})).toBeNull();
  expect(await resolveClassificationNativeFolder('folder',{...deps,mapping:async()=>({...mapping,nativeId:'recovery:42'})})).toBeNull();
});

test.each(['workspaces', 'project', 'workspace-folder'])('rejects a mapped workspace target %s even inside the synced scope', async nativeId => {
  const tree = workspaceFolderTree();
  const find = (nodes: readonly FolderTreeNode[], id: string): FolderTreeNode | undefined => {
    for (const node of nodes) { if (node.id === id) return node; const child = find(node.children ?? [], id); if (child) return child; }
    return undefined;
  };
  const deps = { mapping: async () => ({ ...mapping, nativeId }), native: async (id: string) => find(tree, id), inScope: async () => true };
  expect(await resolveClassificationNativeFolder('folder', deps)).toBeNull();
  expect(await resolveClassificationNativeFolder('folder', { ...deps, mapping: async () => ({ ...mapping, nativeId: 'user-workspace' }) }))
    .toMatchObject({ nativeId: 'user-workspace', title: 'Workspaces' });
});
