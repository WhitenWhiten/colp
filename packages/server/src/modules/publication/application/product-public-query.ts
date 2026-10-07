import type { Relation, SnapshotNode } from '@know-n/colp/types';
import {
  attachBookmarkPreviewImages,
  knownFaviconForUrl,
  iconUrlForNode,
  isBookmarkPinned,
  loadBookmarkIconObjectIds,
  type BookmarkPreviewImageView,
  type LinkPreviewReadPort,
} from '../../collections/index.js';
import type { PublicationCursorKeyring } from './cursor-keyring.js';
import {
  isCanonicalProductPublicCollectionSlug,
  type ProductPublicCollectionLocatorReadPort,
  type ProductPublicCollectionViewCountReadPort,
} from './product-public-read.js';
import type { ModerationHiddenBookmarkRef } from './snapshot-read.js';
import {
  getPublicationSnapshotPage,
  type PublicationPrincipal,
  type PublicationSnapshotQueryPorts,
} from './snapshot-query.js';

export const PRODUCT_PUBLIC_COLLECTION_DEFAULT_LIMIT = 24;
export const PRODUCT_PUBLIC_COLLECTION_MAX_LIMIT = 100;

export interface ProductPublicCollectionQueryPorts {
  readonly locators: ProductPublicCollectionLocatorReadPort;
  readonly viewCounts: ProductPublicCollectionViewCountReadPort;
  readonly snapshot: PublicationSnapshotQueryPorts;
  readonly cursors: PublicationCursorKeyring;
  /** Identity-owned discoverability projection, resolved from the internal owner fact. */
  readonly owners: {
    findByOwnerSubjectId(ownerSubjectId: string): Promise<Readonly<{
      profileId: string;
      handle: string;
      displayName: string;
      avatarUrl: string | null;
      ownerSubjectId: string;
    }> | null>;
  };
  /** PRODUCT_ORIGIN for same-origin `/api/v1/favicon/{uuid}` URLs. */
  readonly productOrigin?: string;
  /** Batch live bookmark_icons lookup; default empty → every node `iconUrl` is null. */
  readonly bookmarkIcons?: {
    findObjectIdsByNodeIds(nodeIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  };
  /** LP-04 preview images; absent (feature off) → every bookmark previewImage is null. */
  readonly linkPreviews?: LinkPreviewReadPort;
  /**
   * Batch icon-source lookup driving the per-node CDN fallback. An explicit
   * `none` is an owner opt-out: the shared page must not hotlink a third-party
   * favicon CDN for that node ("自动任务…不得复活 none"). A missing row keeps
   * the legacy fallback, so untouched bookmarks are unaffected.
   */
  readonly faviconSources?: {
    findModesByNodeIds(
      nodeIds: readonly string[],
    ): Promise<ReadonlyMap<string, 'inherit' | 'online' | 'uploaded' | 'none'>>;
  };
  /** Batch public tldr/note lookup; default empty → every node omit marks. */
  readonly publicMarks?: {
    findPublicMarksByNodeIds(
      collectionId: string,
      nodeIds: readonly string[],
    ): Promise<ReadonlyMap<string, { tldr: string | null; note: string | null }>>;
    /** Latest `updated_at` public tldr per collection (curator note). */
    findPublicMarksForCollections(
      collectionIds: readonly string[],
    ): Promise<ReadonlyMap<string, string>>;
  };
}

export interface ProductPublicCollectionPage {
  readonly collection: {
    readonly id: string;
    readonly slug: string;
    readonly title: string;
    readonly summary: string | null;
    readonly kind: 'bookmarks' | 'reading_path' | 'knowledge_collection' | 'mixed';
    readonly rootNodeId: string;
    readonly updatedAt: string;
    readonly access: 'public' | 'member';
    readonly viewCount: number;
    /** Latest public collection tldr (curator recommendation), or null. */
    readonly curatorNote: string | null;
    readonly owner: {
      readonly profileId: string;
      readonly handle: string;
      readonly displayName: string;
      readonly avatarUrl: string | null;
    };
    readonly faviconCdnAllowed: boolean;
  };
  readonly relations?: readonly Pick<Relation, 'id' | 'fromNodeId' | 'toNodeId' | 'type' | 'label'>[];
  readonly nodes: readonly ProductPublicCollectionNode[];
  readonly page: {
    readonly cursor: string | null;
    readonly hasMore: boolean;
    readonly sequence: number;
  };
}

export type ProductPublicCollectionNode = Readonly<{
  id: string;
  parentId: string | null;
  kind: 'root' | 'folder' | 'bookmark';
  title: string;
  description: string | null;
  url: string | null;
  position: string | null;
  iconUrl: string | null;
  /** LP-04 same-origin preview image on bookmarks (null when none); absent on folders and tombstones. */
  previewImage?: BookmarkPreviewImageView | null;
  /**
   * Whether this exact node may fall back to the third-party favicon CDN.
   * Present on bookmark nodes: it is false when the owner explicitly set the
   * source to `none`, otherwise it mirrors the collection-level fact (so a
   * legacy response without the field keeps the previous behavior).
   */
  faviconCdnAllowed?: boolean;
  /** The owner pinned this bookmark above the folder's other bookmarks; absent otherwise. */
  pinned?: true;
  /** Public TL;DR annotation text, present only when non-empty. */
  tldr?: string;
  /** Public note annotation text, present only when non-empty. */
  note?: string;
  /**
   * Live-state marker. `hidden` means an official moderation action removed
   * this bookmark from public view: the row stays in position with its URL,
   * description, and icon nulled and the title replaced, so the public list
   * admits the intervention instead of silently shrinking. Absent on visible
   * nodes and on responses from older servers.
   */
  state?: 'visible' | 'hidden';
}>;

export type ProductPublicNodeMarks = Readonly<{
  tldr: string | null;
  note: string | null;
}>;

export class ProductPublicCollectionNotFoundError extends Error {
  readonly code = 'resource_not_found';
}

export class ProductPublicCollectionCursorError extends Error {
  readonly code = 'invalid_cursor';
}

export async function getProductPublicCollectionPage(
  ports: ProductPublicCollectionQueryPorts,
  input: {
    readonly slug: string;
    readonly principal: PublicationPrincipal;
    readonly limit?: number;
    readonly cursor?: string;
    readonly includeRelations?: boolean;
  },
): Promise<ProductPublicCollectionPage> {
  const slug = normalizeSlug(input.slug);
  const limit = input.limit ?? PRODUCT_PUBLIC_COLLECTION_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 2 || limit > PRODUCT_PUBLIC_COLLECTION_MAX_LIMIT) {
    throw new RangeError(
      `Public Collection page limit must be between 2 and ${PRODUCT_PUBLIC_COLLECTION_MAX_LIMIT}`,
    );
  }
  const context = Object.freeze({
    slug,
    principal: input.principal.kind === 'anonymous' ? 'anonymous' : `account:${input.principal.principalId}`,
    limit,
    version: input.includeRelations ? 'product-public-graph-v1' : 'product-public-page-v2',
  });
  let snapshotCursor: string | undefined;
  if (input.cursor !== undefined) {
    const verification = ports.cursors.product.verify(input.cursor, context);
    if (!verification.valid) throw new ProductPublicCollectionCursorError();
    snapshotCursor = verification.nextPosition;
  }
  const collectionId = await ports.locators.findCollectionIdBySlug(slug);
  if (collectionId === null) throw new ProductPublicCollectionNotFoundError();
  const result = await getPublicationSnapshotPage(ports.snapshot, {
    collectionId,
    principal: input.principal,
    query: { limit, ...(input.includeRelations ? { include: ['relations'] as const } : {}), ...(snapshotCursor ? { pageCursor: snapshotCursor } : {}) },
  });
  const nextCursor = result.nextCursor === null
    ? null
    : ports.cursors.product.sign({ ...context, nextPosition: result.nextCursor });
  const collection = result.snapshot.collection;
  if (typeof collection.slug !== 'string') throw new Error('Publication Snapshot is missing its slug');
  const owner = await ports.owners.findByOwnerSubjectId(result.ownerSubjectId);
  if (owner === null) throw new ProductPublicCollectionNotFoundError();
  if (owner.ownerSubjectId !== result.ownerSubjectId) {
    throw new Error('Identity owner Profile projection returned mismatched authority facts');
  }
  if (owner.displayName.length < 1 || owner.displayName.length > 120) {
    throw new ProductPublicCollectionNotFoundError();
  }
  const iconObjectIds = await loadBookmarkIconObjectIds(
    ports.bookmarkIcons,
    result.snapshot.nodes.filter((node) => node.kind === 'bookmark').map((node) => node.id),
  );
  const faviconSourceModes = ports.faviconSources === undefined
    ? new Map<string, 'inherit' | 'online' | 'uploaded' | 'none'>()
    : await ports.faviconSources.findModesByNodeIds(
      result.snapshot.nodes.filter((node) => node.kind === 'bookmark').map((node) => node.id),
    );
  const marksByNodeId = ports.publicMarks === undefined
    ? undefined
    : await ports.publicMarks.findPublicMarksByNodeIds(
      collectionId,
      result.snapshot.nodes.map((node) => node.id),
    );
  const curatorNotes = ports.publicMarks === undefined
    ? new Map<string, string>()
    : await ports.publicMarks.findPublicMarksForCollections([collectionId]);
  const viewCount = await ports.viewCounts.sumCollectionViews(collectionId);
  if (!Number.isSafeInteger(viewCount) || viewCount < 0) {
    throw new Error('Public collection view count is invalid');
  }
  const cdnAllowed = collection.visibility === 'public' && result.projection === 'public';
  return Object.freeze({
    collection: Object.freeze({
      id: collection.id,
      slug: collection.slug,
      title: collection.title,
      summary: collection.summary ?? null,
      kind: collection.kind,
      rootNodeId: collection.rootNodeId,
      updatedAt: collection.updatedAt,
      access: result.projection,
      viewCount,
      curatorNote: curatorNotes.get(collectionId) ?? null,
      owner: Object.freeze({
        profileId: owner.profileId,
        handle: owner.handle,
        displayName: owner.displayName,
        avatarUrl: safeAvatarUrl(owner.avatarUrl),
      }),
      faviconCdnAllowed: cdnAllowed,
    }),
    ...(input.includeRelations ? { relations: result.snapshot.relations.map(({ id, fromNodeId, toNodeId, type, label }) =>
      Object.freeze({ id, fromNodeId, toNodeId, type, ...(label === undefined ? {} : { label }) })) } : {}),
    nodes: mergeModerationTombstones(
      await attachBookmarkPreviewImages(ports.linkPreviews, ports.productOrigin, result.snapshot.nodes.map((node) =>
        mapNode(node, iconObjectIds, ports.productOrigin, marksByNodeId, faviconSourceModes, cdnAllowed))),
      result.moderationHiddenBookmarks,
    ),
    page: Object.freeze({
      cursor: nextCursor,
      hasMore: nextCursor !== null,
      sequence: result.snapshot.page.sequence,
    }),
  });
}

function safeAvatarUrl(value: string | null): string | null {
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

function normalizeSlug(value: string): string {
  if (!isCanonicalProductPublicCollectionSlug(value)) {
    throw new ProductPublicCollectionNotFoundError();
  }
  return value;
}

function mergeModerationTombstones(
  nodes: readonly ProductPublicCollectionNode[],
  hiddenRefs: readonly ModerationHiddenBookmarkRef[] | undefined,
): readonly ProductPublicCollectionNode[] {
  if (!hiddenRefs || hiddenRefs.length === 0) return Object.freeze([...nodes]);
  const merged: ProductPublicCollectionNode[] = [...nodes];
  for (const ref of hiddenRefs) {
    merged.push(Object.freeze({
      id: ref.id,
      parentId: ref.parentId,
      kind: 'bookmark',
      title: 'Bookmark hidden',
      description: null,
      url: null,
      position: ref.position,
      iconUrl: null,
      state: 'hidden',
    }));
  }
  merged.sort(compareProductPublicNodes);
  return Object.freeze(merged);
}

function compareProductPublicNodes(
  left: Pick<ProductPublicCollectionNode, 'parentId' | 'position' | 'id'>,
  right: Pick<ProductPublicCollectionNode, 'parentId' | 'position' | 'id'>,
): number {
  const leftParent = left.parentId ?? '';
  const rightParent = right.parentId ?? '';
  if (leftParent !== rightParent) return leftParent < rightParent ? -1 : 1;
  const leftPosition = left.position ?? '';
  const rightPosition = right.position ?? '';
  if (leftPosition !== rightPosition) return leftPosition < rightPosition ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function mapNode(
  node: SnapshotNode,
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
  // An explicit `none` never falls back to the third-party CDN, whatever the
  // collection-level fact says. Folder/root nodes carry no icon.
  const nodeCdnAllowed = node.kind !== 'bookmark'
    ? undefined
    : collectionCdnAllowed && faviconSourceModes.get(node.id) !== 'none' && knownFaviconForUrl(node.url) === null;
  return Object.freeze({
    id: node.id,
    parentId: node.parentId,
    kind: node.kind as ProductPublicCollectionNode['kind'],
    title: node.title,
    description: node.description ?? null,
    url: node.kind === 'bookmark' ? node.url! : null,
    position: node.position,
    iconUrl: node.kind === 'bookmark'
      ? iconUrlForNode(node.id, iconObjectIds, productOrigin)
      : null,
    ...(nodeCdnAllowed === undefined ? {} : { faviconCdnAllowed: nodeCdnAllowed }),
    ...(node.kind === 'bookmark' && isBookmarkPinned(node.extensions) ? { pinned: true as const } : {}),
    ...(marks?.tldr ? { tldr: marks.tldr } : {}),
    ...(marks?.note ? { note: marks.note } : {}),
  });
}
