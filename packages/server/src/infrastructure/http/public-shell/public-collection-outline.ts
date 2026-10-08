import { PUBLIC_SHELL_TITLE_MAX, sanitizePublicShellText } from './sanitize-public-shell-text.js';

/** One `getPublicationSnapshotPage` call; do not page past this. */
export const PUBLIC_SHELL_MARKDOWN_ITEM_CAP = 500;

const HTTP_URL_NO_USERINFO = /^[Hh][Tt][Tt][Pp][Ss]?:\/\/[^/?#@\s]+(?:[/?#]|$)/;
const URL_MIN = 8;
const URL_MAX = 4096;

export interface PublicShellMarkdownNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: 'root' | 'folder' | 'bookmark';
  readonly title: string;
  readonly url?: string | null;
  readonly position: string | null;
}

/**
 * Same accept as publication bookmarks (`isAcceptedBookmarkUrl`): absolute
 * http(s), no userinfo. Copied here so the http leaf stays import-free.
 */
export function toPublicShellMarkdownNode(node: {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: string;
  readonly title?: string;
  readonly url?: string | null;
  readonly position: string | null;
}): PublicShellMarkdownNode | null {
  if (node.kind !== 'root' && node.kind !== 'folder' && node.kind !== 'bookmark') return null;
  if (typeof node.title !== 'string') return null;
  return {
    id: node.id,
    parentId: node.parentId,
    kind: node.kind,
    title: node.title,
    url: node.kind === 'bookmark' ? node.url ?? null : null,
    position: node.position,
  };
}

export function isPublicShellMarkdownUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url.length < URL_MIN || url.length > URL_MAX) return false;
  if (/\s/.test(url)) return false;
  if (!HTTP_URL_NO_USERINFO.test(url)) return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.username === ''
      && parsed.password === ''
      && parsed.hostname !== '';
  } catch {
    return false;
  }
}

export function selectPublicShellMarkdownNodes(
  nodes: readonly PublicShellMarkdownNode[],
  cap = PUBLIC_SHELL_MARKDOWN_ITEM_CAP,
): readonly PublicShellMarkdownNode[] {
  const root = nodes.find((node) => node.kind === 'root');
  const rest = nodes.filter((node) => node.kind !== 'root');
  if (root === undefined) return rest.slice(0, cap);
  return [root, ...rest.slice(0, Math.max(0, cap - 1))];
}

export type PublicShellOutlineEntry =
  | { readonly kind: 'folder'; readonly depth: number; readonly title: string }
  | { readonly kind: 'bookmark'; readonly depth: number; readonly title: string; readonly url: string };

/**
 * Depth-first, position-ordered outline shared by the markdown and HTML
 * renderers. Titles are control-stripped and bounded but NOT escaped; each
 * renderer escapes for its own context. Bookmarks with a non-http(s) or
 * userinfo URL are dropped. Cycles in parentId are cut by lineage.
 */
export function outlinePublicCollection(
  nodes: readonly PublicShellMarkdownNode[],
  cap = PUBLIC_SHELL_MARKDOWN_ITEM_CAP,
): { readonly entries: readonly PublicShellOutlineEntry[]; readonly included: number } {
  const selected = selectPublicShellMarkdownNodes(nodes, cap);
  const root = selected.find((node) => node.kind === 'root');
  if (root === undefined) return { entries: [], included: selected.length };

  const childrenByParent = new Map<string, PublicShellMarkdownNode[]>();
  for (const node of selected) {
    if (node.id === root.id || node.parentId === null) continue;
    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentId, siblings);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort(comparePublicShellMarkdownSiblings);
  }

  const entries: PublicShellOutlineEntry[] = [];
  const visit = (parentId: string, depth: number, lineage: ReadonlySet<string>): void => {
    for (const node of childrenByParent.get(parentId) ?? []) {
      if (lineage.has(node.id)) continue;
      const nextLineage = new Set(lineage);
      nextLineage.add(node.id);
      const title = sanitizePublicShellText(node.title, PUBLIC_SHELL_TITLE_MAX) || 'Untitled';
      if (node.kind === 'folder') {
        entries.push({ kind: 'folder', depth, title });
        visit(node.id, depth + 1, nextLineage);
      } else if (node.kind === 'bookmark') {
        const url = node.url;
        if (typeof url !== 'string' || !isPublicShellMarkdownUrl(url)) continue;
        entries.push({ kind: 'bookmark', depth, title, url });
      }
    }
  };
  visit(root.id, 0, new Set([root.id]));
  return { entries, included: selected.length };
}

export function comparePublicShellMarkdownSiblings(
  left: PublicShellMarkdownNode,
  right: PublicShellMarkdownNode,
): number {
  const leftPosition = left.position ?? '';
  const rightPosition = right.position ?? '';
  if (leftPosition < rightPosition) return -1;
  if (leftPosition > rightPosition) return 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
