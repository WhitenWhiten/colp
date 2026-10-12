import type { NativeNode } from './bookmark-manager-dom.js';
import { isSupportedBookmarkRoot } from './bookmark-folder-policy.js';

/** Display only supported browser bookmark roots and their ordinary descendants.
 * Special browser containers stay outside the manager regardless of their titles.
 * This projection never changes the native tree or the sync/import readers.
 */
export function projectManagerRoot(root: NativeNode): NativeNode {
  const children = root.children?.filter(node => node.url !== undefined || isSupportedBookmarkRoot(node));
  return children?.length === root.children?.length ? root : { ...root, children };
}
