import type { SnapshotNode } from '@know-n/colp/types';
import { iconUrlForNode, isBookmarkPinned } from '../../collections/index.js';
import type { ProductPublicCollectionNode, ProductPublicNodeMarks } from './product-public-query.js';

export function safeAvatarUrl(value: string | null): string | null {
  if (value === null || value === '') return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === ''
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

export interface PublicPageNode {
  readonly id: string; readonly parentId: string | null; readonly kind: string; readonly title?: string;
  readonly description?: string | null; readonly url?: string | null; readonly position: string | null;
  readonly extensions?: SnapshotNode['extensions'];
}

export function projectPublicNode(
  node: PublicPageNode,
  iconObjectIds: ReadonlyMap<string, string>,
  productOrigin: string | undefined,
  marksByNodeId: ReadonlyMap<string, ProductPublicNodeMarks> | undefined,
  faviconSourceModes: ReadonlyMap<string, 'inherit' | 'online' | 'uploaded' | 'none'>,
  collectionCdnAllowed: boolean,
): ProductPublicCollectionNode {
  if (!['root', 'folder', 'bookmark'].includes(node.kind) || typeof node.title !== 'string') {
    throw new Error('Publication Snapshot contains an unsupported Product page node');
  }
  if (node.kind === 'bookmark' && typeof node.url !== 'string') {
    throw new Error('Publication Snapshot Bookmark is missing its URL');
  }
  const marks = marksByNodeId?.get(node.id);
  // Keep the legacy policy field false for old clients as well. Folder/root nodes carry no icon.
  const nodeCdnAllowed = node.kind !== 'bookmark'
    ? undefined
    : collectionCdnAllowed;
  return Object.freeze({
    id: node.id,
    parentId: node.parentId,
    kind: node.kind as ProductPublicCollectionNode['kind'],
    title: node.title,
    description: node.description ?? null,
    url: node.kind === 'bookmark' ? node.url! : null,
    position: node.position,
    iconUrl: node.kind === 'bookmark' && faviconSourceModes.get(node.id) !== 'none'
      ? iconUrlForNode(node.id, iconObjectIds, productOrigin)
      : null,
    ...(nodeCdnAllowed === undefined ? {} : { faviconCdnAllowed: nodeCdnAllowed }),
    ...(node.kind === 'bookmark' ? { previewImage: null } : {}),
    ...(node.kind === 'bookmark' && isBookmarkPinned(node.extensions) ? { pinned: true as const } : {}),
    ...(marks?.tldr ? { tldr: marks.tldr } : {}),
    ...(marks?.note ? { note: marks.note } : {}),
  });
}
