import type { AuthorityContext } from '../authority-fence.js';
import { supportedBookmarkTree } from '../bookmark-folder-policy.js';
import { browserMetadataSyncPolicy } from '../metadata-sync-policy.js';
import { configuredPersonalSyncPolicy } from '../personal-sync-fetch.js';
import { resolveIngressBoundary } from '../bookmark-event-ingress.js';
import type { FolderTreeNode } from '../save-folder.js';
import type { MappingInput, SyncScope } from '../sync-state-store.js';
import { scopeKey } from '../sync-state/scope-key.js';
import { createMetadataBoundary, assertMetadataTarget } from '../metadata-boundary.js';
import { currentSyncScope } from './scope.js';
import { currentBookmarkEventQueue } from './bookmarks.js';
import { syncState, store, hasBookmarkPermission } from './runtime.js';

/** One authority/privacy boundary for all browser sidecar fields. */
export async function metadataSyncInputs(scope: SyncScope, context: AuthorityContext) {
  const personal = await configuredPersonalSyncPolicy()?.capture(scope);
  const policy = browserMetadataSyncPolicy();
  if ((await policy.read(scope)).mode !== 'sync') return null;
  const assertConsent = await policy.capture(scope);
  if (!await hasBookmarkPermission() || typeof chrome.bookmarks?.getTree !== 'function') return null;
  const tree = supportedBookmarkTree(await chrome.bookmarks.getTree()) as FolderTreeNode[];
  const boundary = await resolveIngressBoundary(syncState, scope), queue = await currentBookmarkEventQueue();
  if (!queue || boundary.rootStatus !== 'ready') return null;
  const { nodes, allowed } = createMetadataBoundary(tree, boundary);
  const assertCurrent = async () => {
    await personal?.assertCurrent();
    await store.assertWritable(context.generation);
    if (scopeKey(await currentSyncScope()) !== scopeKey(scope)) throw new Error('metadata_scope_changed');
    await assertConsent();
    personal?.assertLive();
  };
  await assertCurrent();
  const assertMapping = (mapping: MappingInput) => assertMetadataTarget(mapping, nodes.get(mapping.nativeId), {
    assertCurrent, mapping: () => syncState.getMappingByNativeId(scope, mapping.nativeId),
    boundary: () => resolveIngressBoundary(syncState, scope), node: async id => (await chrome.bookmarks.get(id))[0],
  });
  const assertSnapshot = async (mappings: readonly MappingInput[]) => {
    await assertCurrent();
    if (JSON.stringify(supportedBookmarkTree(await chrome.bookmarks.getTree())) !== JSON.stringify(tree)) throw new Error('metadata_target_changed');
    const fresh = new Map((await syncState.listMappings(scope)).map(mapping => [mapping.nativeId, mapping]));
    const boundaryNow = createMetadataBoundary(tree, await resolveIngressBoundary(syncState, scope));
    if (mappings.some(mapping => fresh.get(mapping.nativeId)?.colpId !== mapping.colpId || !boundaryNow.allowed(mapping)))
      throw new Error('metadata_target_changed');
    await assertConsent();
  };
  return { scope, sync: syncState, tree, queue, allowed, assertCurrent, assertMapping, assertSnapshot };
}
