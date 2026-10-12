import { isSupportedBookmarkRoot } from './bookmark-folder-policy.js';

export type BookmarkNodeKind = 'folder' | 'bookmark' | 'separator';
export type BrowserRootKind = 'bookmarks_bar' | 'other' | 'mobile' | 'browser_root';
export type ColpFolderRole = 'bookmarks-bar' | 'other-bookmarks' | 'mobile-bookmarks' | 'managed-bookmarks' | 'custom';
export type SpecialFolderRole = 'bookmarks-bar' | 'other-bookmarks' | 'mobile-bookmarks';

export interface ChromeBookmarkNode {
  readonly id: string;
  readonly title: string;
  readonly url?: string;
  readonly type?: 'folder' | 'bookmark' | 'separator';
  readonly unmodifiable?: string;
  /** Browser variants may expose additional containers; only supported types enter sync. */
  readonly folderType?: string;
  readonly parentId?: string;
  readonly index?: number;
  readonly dateAdded?: number;
  readonly dateGroupModified?: number;
  readonly dateLastUsed?: number;
  readonly syncing?: boolean;
  readonly children?: readonly ChromeBookmarkNode[];
}
export interface BookmarkTreeApi {
  getTree(): Promise<readonly ChromeBookmarkNode[]>;
  getChildren(id: string): Promise<readonly ChromeBookmarkNode[]>;
  getSubTree(id: string): Promise<readonly ChromeBookmarkNode[]>;
}
export interface NormalizedBookmarkNode {
  readonly nativeId: string;
  readonly title: string;
  readonly kind: BookmarkNodeKind;
  readonly managed: boolean;
  readonly url?: string;
  readonly children: readonly NormalizedBookmarkNode[];
}
export interface NormalizedBookmarkRoot extends NormalizedBookmarkNode { readonly rootKind: BrowserRootKind }

const BROWSER_TO_COLP: Readonly<Record<Exclude<BrowserRootKind, 'browser_root'>, SpecialFolderRole>> = {
  bookmarks_bar: 'bookmarks-bar', other: 'other-bookmarks', mobile: 'mobile-bookmarks',
};
const COLP_TO_BROWSER: Readonly<Record<SpecialFolderRole, Exclude<BrowserRootKind, 'browser_root'>>> = {
  'bookmarks-bar': 'bookmarks_bar', 'other-bookmarks': 'other', 'mobile-bookmarks': 'mobile',
};

/** Sole BrowserRootKind ↔ COLP folderRole conversion. Wire/remote use COLP spellings. */
export function folderRoleForBrowserRoot(kind: BrowserRootKind, managed: boolean): ColpFolderRole {
  if (managed) return 'managed-bookmarks';
  if (kind === 'browser_root') return 'custom';
  return BROWSER_TO_COLP[kind];
}

export function browserRootKindForFolderRole(role: SpecialFolderRole): Exclude<BrowserRootKind, 'browser_root'> {
  return COLP_TO_BROWSER[role];
}

export function isWritableMountRole(role: ColpFolderRole): boolean {
  return role !== 'managed-bookmarks';
}

export function customSourceKeyForFolder(nativeId: string): string {
  return `folder:${nativeId}`;
}

export class BookmarkTreeError extends Error {
  constructor(readonly code: 'permission_required' | 'tree_unavailable' | 'bookmark_tree_corrupt', detail?: string) {
    super(detail ? `${code}:${detail}` : code); this.name = 'BookmarkTreeError';
  }
}

export function createChromeBookmarkTreeAdapter(api: BookmarkTreeApi) {
  return Object.freeze({
    async read(): Promise<{ readonly roots: readonly NormalizedBookmarkRoot[] }> {
      const raw = await call(() => api.getTree());
      try {
        if (raw.length !== 1) throw new Error('root_count');
        const top = raw[0]; validateBase(top);
        const seen = new Set<string>(); const active = new Set<object>();
        const container = normalize(top, seen, active);
        // Apply the same root policy as the picker and manager before exposing
        // any folders to range selection, bootstrap, reconciliation or progress.
        const roots = container.children.flatMap((child, index) => {
          const rawRoot = top.children![index]!;
          return isSupportedBookmarkRoot(rawRoot) ? [{ ...child, rootKind: rootKind(rawRoot) }] : [];
        });
        return { roots };
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'invalid';
        throw new BookmarkTreeError('bookmark_tree_corrupt', detail);
      }
    },
    async getChildren(nativeId: string) { return validateResult(await call(() => api.getChildren(nativeId))); },
    async getSubTree(nativeId: string) { return validateResult(await call(() => api.getSubTree(nativeId))); },
  });
}

async function call<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/permission|not permitted|access denied/i.test(message)) throw new BookmarkTreeError('permission_required');
    throw new BookmarkTreeError('tree_unavailable');
  }
}
function validateResult(nodes: readonly ChromeBookmarkNode[]) {
  try { const seen = new Set<string>(); return nodes.map((item) => normalize(item, seen, new Set())); }
  catch (error) { throw new BookmarkTreeError('bookmark_tree_corrupt', error instanceof Error ? error.message : 'invalid'); }
}
function normalize(value: ChromeBookmarkNode, seen: Set<string>, active: Set<object>): NormalizedBookmarkNode {
  validateBase(value);
  if (active.has(value)) throw new Error('bookmark_tree_cycle');
  if (seen.has(value.id)) throw new Error('duplicate_native_id');
  seen.add(value.id); active.add(value);
  const children = (value.children ?? []).map((child) => normalize(child, seen, active));
  active.delete(value);
  const kind = value.type === 'separator' ? 'separator' : typeof value.url === 'string' ? 'bookmark' : 'folder';
  if (kind !== 'folder' && children.length) throw new Error('leaf_has_children');
  return { nativeId: value.id, title: value.title, kind, managed: value.unmodifiable === 'managed', children,
    ...(kind === 'bookmark' && typeof value.url === 'string' ? { url: value.url } : {}) };
}
function validateBase(value: unknown): asserts value is ChromeBookmarkNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('node_invalid');
  const node = value as Partial<ChromeBookmarkNode>;
  if (typeof node.id !== 'string' || !node.id || typeof node.title !== 'string') throw new Error('node_invalid');
  if (node.url !== undefined && typeof node.url !== 'string') throw new Error('url_invalid');
  if (node.children !== undefined && !Array.isArray(node.children)) throw new Error('children_invalid');
}
function rootKind(node: ChromeBookmarkNode): BrowserRootKind {
  if (node.unmodifiable === 'managed') return 'browser_root';
  if (node.folderType === 'bookmarks-bar') return 'bookmarks_bar';
  if (node.folderType === 'other') return 'other';
  if (node.folderType === 'mobile') return 'mobile';
  // Chromium 121–133 omits folderType. Reserved native ids, never sibling
  // positions or titles, identify its built-in roots.
  if (node.folderType === undefined) {
    if (node.id === '1') return 'bookmarks_bar';
    if (node.id === '2') return 'other';
    if (node.id === '3') return 'mobile';
  }
  return 'browser_root';
}
