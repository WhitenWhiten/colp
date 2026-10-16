import { expect, it } from 'vitest';
import { resolveFolderSyncTarget } from '../src/folder-sync-target.js';
it.each(['excluded', 'child', 'bar'])('private boundary %s excludes the destination or its ancestors', async excluded => {
  const parents: Record<string, string> = { child: 'excluded', excluded: 'bar' };
  expect(await resolveFolderSyncTarget({ folderId: 'child', mounts: new Set(['bar']),
    privateNative: new Set([excluded]), boundCollectionId: 'library', getParent: async id => parents[id] })).toEqual({ kind: 'local' });
});
it('an unrelated exclusion leaves a folder synced', async () => {
  expect(await resolveFolderSyncTarget({ folderId: 'child', mounts: new Set(['bar']),
    privateNative: new Set(['sibling']), boundCollectionId: 'library', getParent: async id => id === 'child' ? 'bar' : undefined }))
    .toEqual({ kind: 'synced', collectionId: 'library' });
});
