import { executeRemoteDelete as execute } from '../src/scope-commands.js';
import { previewRangeChange } from '../src/scope-range.js';
import type { NormalizedBookmarkRoot } from '../src/chrome-bookmark-tree.js';

type Store = Parameters<typeof execute>[0];
const previews = new WeakMap<Store, Map<string, string>>();
const commands = new WeakMap<object, string>();

/** Old command-focused fixtures now perform the same preview step as the UI. */
export async function executeRemoteDelete(store: Store, scope: Parameters<typeof execute>[1],
  command: Parameters<typeof execute>[2]) {
  if (command.previewId) return execute(store, scope, command);
  const mount = await store.getMountBinding(scope, command.mountId);
  if (!mount?.remoteMountNodeId) return execute(store, scope, command);
  const key = `${command.mountId}:${command.confirmationToken}`;
  const cache = previews.get(store) ?? new Map<string, string>(); previews.set(store, cache);
  let previewId = commands.get(command) ?? cache.get(key);
  if (!previewId) {
    const mounts = await store.listMountBindings(scope);
    const roots: NormalizedBookmarkRoot[] = mounts.map(row => ({ nativeId: row.nativeRootId,
      title: 'Sync root', kind: 'folder', managed: false, rootKind: 'bookmarks_bar', children: [] }));
    try {
      const { preview } = await previewRangeChange(store, scope, { roots,
        selectedNativeIds: mounts.filter(row => row.mountId !== command.mountId).map(row => row.nativeRootId) });
      previewId = preview.previewId;
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : 'preview_failed' };
    }
    cache.set(key, previewId); commands.set(command, previewId);
  }
  return execute(store, scope, { ...command, previewId });
}
