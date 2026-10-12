import { expect, it } from 'vitest';
import { queryCloudCapture } from '../src/capture/cloud-existence.js';
import type { CaptureEditorPage } from '../src/classification-product-client.js';

it('requires complete revision-fenced cloud pages and returns full paths and read-only locations', async () => {
  const page = { collection: { id: 'c', title: 'Library' }, root: { id: 'root' }, capabilities: { updateNode: false, moveNode: false },
    page: { snapshotId: 'snapshot', hasMore: true, nextCursor: 'next' },
    nodes: [{ id: 'b', kind: 'bookmark', parentId: 'f', title: 'Page', url: 'https://example.org/?q=1' }] } as CaptureEditorPage;
  const result = await queryCloudCapture('https://example.org/?q=1', 'c', async cursor => cursor
    ? { ...page, page: { ...page.page, hasMore: false, nextCursor: null }, nodes: [{ id: 'f', kind: 'folder', title: 'Folder', parentId: 'root' } as CaptureEditorPage['nodes'][number]] } : page);
  expect(result.complete).toBe(true);
  expect(result.locations).toMatchObject([{ path: ['Library', 'Folder'], writable: false, nativeId: null }]);
  await expect(queryCloudCapture('https://example.org/?q=1', 'c', async cursor => cursor
    ? { ...page, page: { ...page.page, snapshotId: 'changed' } } : page)).rejects.toThrow('snapshot_changed');
});
