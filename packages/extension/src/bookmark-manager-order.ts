import { collectSubtreeIds, type NativeNode } from './bookmark-manager-dom.js';
import { pinAvailable, pinDropAfterAllowed, pinDropAllowed, projectPinnedChildren, type PinView } from './bookmark-manager-pins.js';

export function projectVisibleChildren<Node extends object>(
  children: readonly Node[],
  foldersFirst: boolean,
): readonly Node[] {
  if (!foldersFirst) return [...children];
  const folders: Node[] = [];
  const bookmarks: Node[] = [];
  for (const child of children) {
    ((child as { readonly url?: unknown }).url ? bookmarks : folders).push(child);
  }
  return [...folders, ...bookmarks];
}

export function canDropIntoNode(source: NativeNode | undefined, targetFolder: NativeNode | undefined): boolean {
  if (!source || !targetFolder || source.id === targetFolder.id) return false;
  if (targetFolder.url !== undefined || targetFolder.unmodifiable === 'managed') return false;
  const forbidden = new Set<string>();
  collectSubtreeIds(source, forbidden);
  return !forbidden.has(targetFolder.id);
}

export function canDropBeforeNode(
  source: NativeNode | undefined,
  target: NativeNode,
  options: {
    readonly foldersFirst: boolean;
    readonly pinView?: PinView;
    readonly visibleChildren: readonly NativeNode[];
  },
): boolean {
  if (!source || source.id === target.id) return false;
  const { foldersFirst, pinView, visibleChildren } = options;
  const sourceIsFolder = source.url === undefined;
  const targetIsFolder = target.url === undefined;

  if (foldersFirst) {
    if (sourceIsFolder) {
      if (targetIsFolder) return true;
      const firstBookmark = visibleChildren.find((c) => c.url !== undefined);
      return firstBookmark?.id === target.id;
    }
    if (targetIsFolder) return false;
    return pinDropAllowed(pinView, source, target, visibleChildren);
  }

  if (!sourceIsFolder && !targetIsFolder) {
    return pinDropAllowed(pinView, source, target, visibleChildren);
  }
  return true;
}

export function canDropAfterNode(
  source: NativeNode | undefined,
  target: NativeNode,
  options: {
    readonly foldersFirst: boolean;
    readonly pinView?: PinView;
    readonly visibleChildren: readonly NativeNode[];
  },
): boolean {
  if (!source || source.id === target.id) return false;
  const { foldersFirst, pinView, visibleChildren } = options;
  const sourceIsFolder = source.url === undefined;
  const targetIsFolder = target.url === undefined;

  if (foldersFirst) {
    if (sourceIsFolder) return targetIsFolder;
    if (targetIsFolder) {
      const folders = visibleChildren.filter((c) => c.url === undefined);
      const lastFolder = folders.at(-1);
      if (lastFolder?.id !== target.id) return false;
      if (pinAvailable(pinView) && !pinView!.pinned.has(source.id)) {
        const hasPins = visibleChildren.some((c) => c.url !== undefined && pinView!.pinned.has(c.id));
        if (hasPins) return false;
      }
      return true;
    }
    return pinDropAfterAllowed(pinView, source, target, visibleChildren);
  }

  if (!sourceIsFolder && !targetIsFolder) {
    return pinDropAfterAllowed(pinView, source, target, visibleChildren);
  }
  return true;
}

export function createDropValidator(
  nodesById: ReadonlyMap<string, NativeNode> | (() => ReadonlyMap<string, NativeNode>),
  foldersFirst: () => boolean,
  currentFolder: () => { readonly id: string; readonly pinView?: PinView },
) {
  const getNodes = typeof nodesById === 'function' ? nodesById : () => nodesById;
  const visibleChildrenOf = (parentId: string | undefined): readonly NativeNode[] => {
    const map = getNodes();
    const parent = parentId ? map.get(parentId) : undefined;
    if (!parent) return [];
    const { id, pinView } = currentFolder();
    const pins = parent.id === id ? pinView : undefined;
    return projectPinnedChildren(projectVisibleChildren(parent.children ?? [], foldersFirst()), pins);
  };
  return {
    canDropInto: (sourceId: string, folderId: string) => {
      const map = getNodes();
      return canDropIntoNode(map.get(sourceId), map.get(folderId));
    },
    canDropBefore: (sourceId: string, target: NativeNode) => {
      const map = getNodes();
      return map.get(target.parentId ?? '')?.unmodifiable !== 'managed' &&
      canDropBeforeNode(map.get(sourceId), target, {
        foldersFirst: foldersFirst(), pinView: target.parentId === currentFolder().id ? currentFolder().pinView : undefined,
        visibleChildren: visibleChildrenOf(target.parentId),
      });
    },
    canDropAfter: (sourceId: string, target: NativeNode) => {
      const map = getNodes();
      return map.get(target.parentId ?? '')?.unmodifiable !== 'managed' &&
      canDropAfterNode(map.get(sourceId), target, {
        foldersFirst: foldersFirst(), pinView: target.parentId === currentFolder().id ? currentFolder().pinView : undefined,
        visibleChildren: visibleChildrenOf(target.parentId),
      });
    },
  };
}


