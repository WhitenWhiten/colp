import { isSupportedBookmarkRoot } from './bookmark-folder-policy.js';

type Node = chrome.bookmarks.BookmarkTreeNode;
export interface OrganizeChoice {
  readonly nativeId: string;
  readonly title: string;
  readonly rootTitle: string;
  readonly recursive: boolean;
}
export type OrganizeRequest =
  | { readonly kind: 'known.bookmarks.organize.preview' }
  | { readonly kind: 'known.bookmarks.organize.apply'; readonly userGesture: true; readonly nativeIds: readonly string[] };
export type OrganizeResponse =
  | { readonly ok: true; readonly choices: readonly OrganizeChoice[] }
  | { readonly ok: true; readonly moved: number }
  | { readonly ok: false; readonly error: 'permission_required' | 'busy' | 'tree_changed' | 'organize_failed'; readonly moved: number };

function writableFolder(node: Node, excluded: ReadonlySet<string>): boolean {
  return node.url === undefined && node.type !== 'separator' && !node.unmodifiable && !excluded.has(node.id);
}

/** The invisible browser root is not writable. Each standard container has its own root path. */
export function organizeChoices(tree: readonly Node[], excluded: ReadonlySet<string>): OrganizeChoice[] {
  const choices: OrganizeChoice[] = [];
  for (const root of tree.flatMap(node => node.children ?? [])) {
    if (!isSupportedBookmarkRoot(root) || !writableFolder(root, excluded)) continue;
    choices.push({ nativeId: root.id, title: root.title, rootTitle: root.title, recursive: false });
    for (const folder of root.children ?? []) {
      if (writableFolder(folder, excluded)) {
        choices.push({ nativeId: folder.id, title: folder.title, rootTitle: root.title, recursive: true });
      }
    }
  }
  return choices;
}

/** Validate all selections before any mutation. Deeper folders cannot be selected independently. */
export function organizePaths(tree: readonly Node[], selected: readonly string[], excluded: ReadonlySet<string>): Node[] {
  const choices = new Map(organizeChoices(tree, excluded).map(choice => [choice.nativeId, choice]));
  if (!selected.length || new Set(selected).size !== selected.length || selected.some(id => !choices.has(id))) {
    throw new Error('tree_changed');
  }
  const nodes = new Map<string, Node>();
  const pending = [...tree];
  while (pending.length) {
    const node = pending.pop()!;
    nodes.set(node.id, node); pending.push(...(node.children ?? []));
  }
  const paths: Node[] = [];
  for (const id of selected) {
    if (!choices.get(id)!.recursive) { paths.push(nodes.get(id)!); continue; }
    const descendants = [nodes.get(id)!];
    while (descendants.length) {
      const folder = descendants.pop()!;
      if (!writableFolder(folder, excluded)) continue;
      paths.push(folder);
      descendants.push(...(folder.children ?? []).filter(child => child.url === undefined));
    }
  }
  return paths;
}

export function validOrganizeRequest(value: unknown): value is OrganizeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (request.kind === 'known.bookmarks.organize.preview') return Object.keys(request).length === 1;
  if (request.kind !== 'known.bookmarks.organize.apply' || Object.keys(request).length !== 3 || request.userGesture !== true) return false;
  const ids = request.nativeIds;
  return Array.isArray(ids) && ids.length > 0 && ids.length <= 20_000
    && ids.every(id => typeof id === 'string' && /^[A-Za-z0-9._~-]{1,128}$/u.test(id)) && new Set(ids).size === ids.length;
}
