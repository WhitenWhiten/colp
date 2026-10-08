import { knownFaviconForUrl } from './favicon-known-domains.js';
import {
  authorizeCapability,
  type AccessPolicyFactsPort,
} from '../../access-policy/index.js';
import {
  CollectionAuthorizationError,
  SnapshotExpiredError,
} from '../domain/errors.js';
import type { CollectionKind } from '../domain/validation.js';
import { iconUrlForNode, loadBookmarkIconObjectIds } from './bookmark-icon-url.js';
import { attachBookmarkPreviewImages, type BookmarkPreviewImageView, type LinkPreviewReadPort } from './link-preview-read.js';
import {
  COLLECTION_CHILDREN_SORTS,
  PRODUCT_COLLECTION_CHILDREN_CURSOR_TTL_MS,
  PRODUCT_COLLECTION_CHILDREN_CURSOR_PURPOSE,
  PRODUCT_COLLECTION_CHILDREN_CURSOR_VERSION,
  CollectionChildrenCursorError,
  formatChildrenCursorTime,
  isCollectionChildrenSort,
  viewerScope,
  type CollectionChildrenCursorAfter,
  type CollectionChildrenCursorPayload,
  type CollectionChildrenCursorSignerPort,
  type CollectionChildrenSort,
  type CollectionChildrenViewer,
} from './collection-children-cursor.js';
import type {
  BookmarkIconReadPort,
  CollectionWritePort,
  CollectionsClock,
} from './ports.js';

export const COLLECTION_CHILDREN_DEFAULT_LIMIT = 50;
export const COLLECTION_CHILDREN_MAX_LIMIT = 100;
/** Contract `pageBudget`: full serialized ChildrenPage capped at 65536 UTF-8 bytes. */
export const COLLECTION_CHILDREN_MAX_BYTES = 65_536;

/**
 * FO-05 `listCollectionChildren` application query.
 *
 * Reads exactly one layer of live children under `parentId` (or the collection
 * root when omitted). Time sorts change ONLY the read view: nothing is written
 * (no position tokens, no revisions, no sync logs) and `reading_path`
 * collections reject created sorts with 400 invalid_query (their path is
 * always the curated order). Folder scope, root and parent/child relations are
 * preserved — the tree is never globally reordered. Anonymous public reads are
 * allowed for public collections; owner/member reads use ordinary authority.
 */

export class CollectionChildrenInputError extends Error {
  readonly code = 'invalid_query' as const;

  constructor(message: string) {
    super(message);
    this.name = 'CollectionChildrenInputError';
  }
}

export interface CollectionChildrenNodeRow {
  readonly id: string;
  readonly collectionId: string;
  readonly parentId: string;
  readonly kind: 'folder' | 'bookmark';
  readonly title: string;
  readonly url: string | null;
  readonly description: string | null;
  readonly positionToken: string | null;
  readonly childrenRevision: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** True when an active official hide_public covers this bookmark. */
  readonly moderationHidden: boolean;
  /** The owner pinned this bookmark in a browser extension. */
  readonly pinned?: boolean;
}

export interface CollectionChildrenReadPort {
  /**
   * Live children of one parent, in the requested sort order, at most
   * `limit` + 1 rows (the extra row detects hasMore without a second query).
   * `parentId` is '' for the collection root. `after` keyset: curated uses
   * (positionKey, nodeId); created sorts use (createdAt, nodeId) with ID
   * ascending on ties.
   */
  listLiveChildren(input: {
    readonly collectionId: string;
    readonly parentId: string;
    readonly sort: CollectionChildrenSort;
    readonly after?: CollectionChildrenCursorAfter;
    readonly limit: number;
    /**
     * Hidden bookmarks always come back in the page, marked
     * `moderationHidden`, so a public read can render a tombstone instead of
     * silently dropping the row; the caller decides what to do with the mark.
     */
  }): Promise<readonly CollectionChildrenNodeRow[]>;

  /** Live node row (deleted_at IS NULL) or null. Used to validate parentId targets. */
  getLiveNode(collectionId: string, nodeId: string): Promise<CollectionChildrenNodeRow | null>;
}

export interface ListCollectionChildrenPorts {
  readonly collections: Pick<CollectionWritePort, 'lockForShare'>;
  readonly children: CollectionChildrenReadPort;
  readonly accessPolicy: AccessPolicyFactsPort;
  readonly cursorSigner: CollectionChildrenCursorSignerPort;
  readonly clock: CollectionsClock;
  /** Batch live bookmark_icons lookup; missing/empty → every bookmark `iconUrl` is null. */
  readonly bookmarkIcons?: BookmarkIconReadPort;
  readonly linkPreviews?: LinkPreviewReadPort; // LP-04; absent → every bookmark previewImage is null
  /** PRODUCT_ORIGIN used to project same-origin `/api/v1/favicon/{uuid}` URLs. */
  readonly productOrigin?: string;
  /**
   * FO-08: per-node icon source modes for the node-level CDN opt-out. Required
   * (the children UoW always wires it): an absent port would silently degrade
   * to "no none opt-out" and break the explicit-none privacy promise.
   */
  readonly faviconSources: {
    findModesByNodeIds(nodeIds: readonly string[]): Promise<ReadonlyMap<string, 'inherit' | 'online' | 'uploaded' | 'none'>>;
  };
  /**
   * Official hide_public on the collection. Origin/public readers conceal;
   * owner/editor management reads keep working.
   */
  readonly publicControls: {
    isCollectionHiddenPublic(collectionId: string): Promise<boolean>;
  };
}

/** REPEATABLE READ unit of work for one collection-children page (FO-05).
 * Each page runs in a fresh transaction so current visibility is rechecked. */
export interface CollectionChildrenReadUnitOfWork {
  execute<Result>(work: (ports: ListCollectionChildrenPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal }): Promise<Result>;
}

export interface ListCollectionChildrenActor {
  readonly principalId: string | null;
  readonly subjectId: string | null;
}

export interface ListCollectionChildrenInput {
  readonly actor: ListCollectionChildrenActor;
  readonly collectionId: string;
  /** Omitted → collection root. */
  readonly parentId?: string;
  readonly sort?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly now?: Date;
}

export interface BrowseNode {
  readonly id: string;
  readonly parentId: string;
  readonly kind: 'folder' | 'bookmark';
  readonly title: string;
  readonly url: string | null;
  readonly description: string | null;
  readonly position: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly iconUrl: string | null;
  readonly previewImage?: BookmarkPreviewImageView | null; // LP-04: bookmarks only; null for tombstones and misses
  /**
   * FO-08: per-node CDN opt-out mirroring the public snapshot. Explicit `none`
   * bookmark nodes must never fall back to the third-party CDN, whatever the
   * collection-level fact says; folders/root carry no icon and omit the field.
   */
  readonly faviconCdnAllowed?: boolean;
  /** Moderation tombstone marker (absent = visible): an active official
      * hide_public nulled url/description/iconUrl and replaced the title. */
  readonly state?: 'visible' | 'hidden';
  /** Bookmarks the owner pinned in a browser extension; absent otherwise and on tombstones. */
  readonly pinned?: true;
}

export interface CollectionChildrenPage {
  readonly collectionId: string;
  readonly parentId: string;
  readonly rootId: string;
  readonly contentRevision: string;
  readonly sort: CollectionChildrenSort;
  readonly items: readonly BrowseNode[];
  readonly nextCursor: string | null;
}

interface ResolvedCollectionContext {
  readonly id: string;
  readonly kind: CollectionKind;
  readonly visibility: 'private' | 'protected' | 'unlisted' | 'public';
  readonly ownerSubjectId: string;
  readonly rootNodeId: string;
  readonly contentRevision: string;
  readonly deletedAt: Date | null;
}

export async function listCollectionChildren(
  ports: ListCollectionChildrenPorts,
  input: ListCollectionChildrenInput,
): Promise<CollectionChildrenPage> {
  const collectionId = assertNonEmpty(input.collectionId, 'collectionId');
  const viewer = resolveViewer(input.actor);
  const now = input.now ?? (await ports.clock.now());

  // ---------------------------------------------------------------- cursor --
  let continuation: CollectionChildrenCursorPayload | null = null;
  let limit: number;
  let after: CollectionChildrenCursorAfter | undefined;
  let parentId: string;
  let sort: CollectionChildrenSort;

  if (input.cursor !== undefined) {
    if (typeof input.cursor !== 'string' || input.cursor.length < 1) {
      throw new CollectionChildrenInputError('cursor is required');
    }
    continuation = ports.cursorSigner.verify(input.cursor, now);
    assertCursorBinding(continuation, collectionId, viewer);
    // Every normalized request factor must match the cursor binding: a sort,
    // parent or limit switch is 400 invalid_cursor, never a silent
    // re-interpretation. The cursor already binds the first-page limit, so a
    // contract-conforming client echoing that same limit with the cursor is
    // accepted; a different limit is rejected as invalid_cursor.
    if (input.sort !== undefined && normalizeSort(input.sort) !== continuation.sort) {
      throw new CollectionChildrenCursorError();
    }
    if (input.parentId !== undefined && normalizeParentId(input.parentId) !== continuation.parentId) {
      throw new CollectionChildrenCursorError();
    }
    if (input.limit !== undefined && normalizeLimit(input.limit) !== continuation.limit) {
      throw new CollectionChildrenCursorError();
    }
    parentId = continuation.parentId;
    sort = continuation.sort;
    limit = continuation.limit;
    after = continuation.after;
  } else {
    sort = normalizeSort(input.sort);
    limit = normalizeLimit(input.limit);
    parentId = normalizeParentId(input.parentId);
  }

  // ------------------------------------------------- collection + authorize --
  const locked = await ports.collections.lockForShare(collectionId);
  if (locked === null || locked.deletedAt !== null) {
    throw conceal();
  }
  const collection: ResolvedCollectionContext = {
    id: locked.id,
    kind: locked.kind,
    visibility: locked.visibility,
    ownerSubjectId: locked.ownerSubjectId,
    rootNodeId: locked.rootNodeId,
    contentRevision: locked.contentRevision,
    deletedAt: locked.deletedAt,
  };

  await authorizeRead(ports, collectionId, viewer, collection.visibility);
  const managementRead = await viewerHasManagementRead(ports, collectionId, viewer);
  if (!managementRead && await ports.publicControls.isCollectionHiddenPublic(collectionId)) {
    throw conceal();
  }

  // --------------------------------------- reading_path keeps curated order --
  if (collection.kind === 'reading_path' && sort !== 'curated') {
    throw new CollectionChildrenInputError(
      'reading_path collections keep the curated reading order; created sorts are not allowed.',
    );
  }

  // ---------------------------------------------------- parent validation --
  const effectiveParentId = parentId === '' ? collection.rootNodeId : parentId;
  if (parentId !== '') {
    const parent = await ports.children.getLiveNode(collectionId, parentId);
    if (parent === null || parent.kind !== 'folder') {
      throw new CollectionChildrenInputError(
        'parentId must be a live folder in this collection',
      );
    }
  }

  // ----------------------------------------------------------------- fence --
  if (continuation !== null) {
    if (locked.contentRevision !== continuation.contentRevision) {
      throw new SnapshotExpiredError(
        'The collection children snapshot expired because the collection content changed.',
      );
    }
  }

  // --------------------------------------------------------------- query ----
  const fetched = await ports.children.listLiveChildren({
    collectionId,
    parentId: effectiveParentId,
    sort,
    after,
    limit,
  });

  const iconObjectIds = await loadBookmarkIconObjectIds(
    ports.bookmarkIcons,
    fetched.filter((row) => row.kind === 'bookmark' && !row.moderationHidden).map((row) => row.id),
  );
  // FO-08: the node-level CDN opt-out mirrors the public snapshot — explicit
  // `none` never falls back to the third-party CDN, whatever the collection
  // fact says. The collection-level gate itself lives in the client
  // (`collection.faviconCdnAllowed` ANDed with the node fact).
  const faviconSourceModes = await ports.faviconSources.findModesByNodeIds(
    fetched.filter((row) => row.kind === 'bookmark' && !row.moderationHidden).map((row) => row.id),
  );
  const collectionCdnAllowed = collection.visibility === 'public';
  const candidates = await attachBookmarkPreviewImages(ports.linkPreviews, ports.productOrigin, fetched.map((row) => {
    const node = mapBrowseNode(row, iconObjectIds, ports.productOrigin, collectionCdnAllowed, faviconSourceModes);
    // Public readers get an inert tombstone (url null → previewImage null); moderation never silently shrinks the page.
    return row.moderationHidden && !managementRead ? hiddenBookmarkTombstone(node) : node;
  }));

  const issuedAt = formatChildrenCursorTime(now);
  const expiresAt = formatChildrenCursorTime(new Date(now.getTime() + PRODUCT_COLLECTION_CHILDREN_CURSOR_TTL_MS));
  const selection = selectItemsWithinBudget(candidates, limit, {
    collectionId,
    parentId: effectiveParentId,
    rootId: collection.rootNodeId,
    contentRevision: collection.contentRevision,
    sort,
    itemsLimit: limit,
    issuedAt,
    expiresAt,
    viewer: viewerScope(viewer),
    collectionIdForCursor: collectionId,
    parentIdForCursor: parentId,
  }, ports.cursorSigner);

  return {
    collectionId,
    parentId: effectiveParentId,
    rootId: collection.rootNodeId,
    contentRevision: collection.contentRevision,
    sort,
    items: selection.items,
    nextCursor: selection.nextCursor,
  };
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

function resolveViewer(actor: ListCollectionChildrenActor): CollectionChildrenViewer {
  if (actor.subjectId === null || actor.principalId === null) return { kind: 'anonymous' };
  return { kind: 'account', principalId: actor.principalId, subjectId: actor.subjectId };
}

async function viewerHasManagementRead(
  ports: ListCollectionChildrenPorts,
  collectionId: string,
  viewer: CollectionChildrenViewer,
): Promise<boolean> {
  if (viewer.kind === 'anonymous') return false;
  const decision = await authorizeCapability(ports.accessPolicy, {
    collectionId,
    actor: { principalId: viewer.principalId, subjectId: viewer.subjectId, kind: 'account' },
    capability: 'read_editor',
  });
  return decision.outcome === 'allow';
}

async function authorizeRead(
  ports: ListCollectionChildrenPorts,
  collectionId: string,
  viewer: CollectionChildrenViewer,
  visibility: 'private' | 'protected' | 'unlisted' | 'public',
): Promise<void> {
  if (viewer.kind === 'anonymous') {
    // Anonymous public read is allowed only for public collections. Like every
    // other existing surface, unlisted/protected/private read URIs conceal 404.
    if (visibility !== 'public') throw conceal();
    return;
  }
  // A signed-in account must never be treated worse than an anonymous one: a
  // PUBLIC collection is readable by every account (member or not), exactly
  // like the other public surfaces where logged-in visitors and anonymous
  // share the same bytes (plan §2 图标来源与生效版本). Only non-public
  // collections require the read_editor capability (owner/editor/viewer +
  // member authority).
  if (visibility === 'public') return;
  const decision = await authorizeCapability(ports.accessPolicy, {
    collectionId,
    actor: { principalId: viewer.principalId, subjectId: viewer.subjectId, kind: 'account' },
    capability: 'read_editor',
  });
  if (decision.outcome !== 'allow') {
    throw new CollectionAuthorizationError({
      outcome: decision.outcome,
      reasonCategory: decision.reasonCategory,
    });
  }
}

function conceal(): CollectionAuthorizationError {
  return new CollectionAuthorizationError({
    outcome: 'conceal',
    reasonCategory: 'resource_missing',
  });
}

// ---------------------------------------------------------------------------
// Cursor binding
// ---------------------------------------------------------------------------

function assertCursorBinding(
  payload: CollectionChildrenCursorPayload,
  collectionId: string,
  viewer: CollectionChildrenViewer,
): void {
  if (
    payload.v !== PRODUCT_COLLECTION_CHILDREN_CURSOR_VERSION
    || payload.purpose !== PRODUCT_COLLECTION_CHILDREN_CURSOR_PURPOSE
    || payload.viewer !== viewerScope(viewer)
    || payload.collectionId !== collectionId
  ) {
    throw new CollectionChildrenCursorError();
  }
}

// ---------------------------------------------------------------------------
// Budgeted selection
// ---------------------------------------------------------------------------

interface PageBudgetContext {
  readonly collectionId: string;
  readonly parentId: string;
  readonly rootId: string;
  readonly contentRevision: string;
  readonly sort: CollectionChildrenSort;
  readonly itemsLimit: number;
  readonly viewer: string;
  readonly collectionIdForCursor: string;
  readonly parentIdForCursor: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

interface BudgetedSelection {
  readonly items: BrowseNode[];
  readonly nextCursor: string | null;
}

/**
 * Add items while respecting both the requested item limit and the 65536-byte
 * full-page budget. A byte-limited short page still emits a nextCursor for the
 * first unconsumed eligible item: never cut an item, skip it or truncate.
 */
export function selectItemsWithinBudget(
  candidates: readonly BrowseNode[],
  itemLimit: number,
  context: PageBudgetContext,
  signer: CollectionChildrenCursorSignerPort,
): BudgetedSelection {
  // At most limit items may be returned; the last fetched row may exist only
  // as a hasMore probe, so eligible items continue whenever we stopped before
  // the end of the fetched set.
  const selectableCount = Math.min(candidates.length, itemLimit);
  const items: BrowseNode[] = [];
  let nextCursor: string | null = null;

  for (let index = 0; index < selectableCount; index += 1) {
    const candidate = candidates[index]!;
    const trialItems = [...items, candidate];
    const remainingAfterTrial = index + 1 < candidates.length;
    const trialCursor = remainingAfterTrial
      ? signer.sign(buildCursorPayload(context, candidate))
      : null;
    const page: CollectionChildrenPage = {
      collectionId: context.collectionId,
      parentId: context.parentId,
      rootId: context.rootId,
      contentRevision: context.contentRevision,
      sort: context.sort,
      items: trialItems,
      nextCursor: trialCursor,
    };
    if (Buffer.byteLength(JSON.stringify(page), 'utf8') <= COLLECTION_CHILDREN_MAX_BYTES) {
      items.push(candidate);
      nextCursor = trialCursor;
      continue;
    }
    if (items.length === 0) {
      // Write-path byte caps (title/url/description/iconUrl) guarantee a
      // single maximal item serializes under half the budget; a live row
      // violating that invariant is a hard integrity failure, never a cut.
      throw new Error('collection children item exceeds the response byte budget');
    }
    break;
  }

  return { items, nextCursor };
}

function buildCursorPayload(
  context: PageBudgetContext,
  last: BrowseNode,
): CollectionChildrenCursorPayload {
  return {
    v: PRODUCT_COLLECTION_CHILDREN_CURSOR_VERSION,
    purpose: PRODUCT_COLLECTION_CHILDREN_CURSOR_PURPOSE,
    viewer: context.viewer,
    collectionId: context.collectionIdForCursor,
    parentId: context.parentIdForCursor,
    sort: context.sort,
    limit: context.itemsLimit,
    contentRevision: context.contentRevision,
    after: {
      nodeId: last.id,
      positionKey: last.position,
      createdAt: last.createdAt,
    },
    issuedAt: context.issuedAt,
    expiresAt: context.expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Mapping + normalization
// ---------------------------------------------------------------------------

/** Inert stand-in for a bookmark under an active official hide_public. */
function hiddenBookmarkTombstone({ pinned: _pinned, ...node }: BrowseNode): BrowseNode {
  return { ...node, title: 'Bookmark hidden', url: null, description: null, iconUrl: null, state: 'hidden' };
}

function mapBrowseNode(
  row: CollectionChildrenNodeRow,
  iconObjectIds: ReadonlyMap<string, string>,
  productOrigin: string | undefined,
  collectionCdnAllowed: boolean,
  faviconSourceModes: ReadonlyMap<string, 'inherit' | 'online' | 'uploaded' | 'none'>,
): BrowseNode {
  if (row.positionToken === null || row.positionToken.length < 1) {
    throw new Error(`collection children node ${row.id} is missing position`);
  }
  // An explicit `none` never falls back to the third-party CDN, whatever the
  // collection-level fact says. Folder/root nodes carry no icon and omit the
  // field (mirrors the public snapshot mapping).
  const nodeCdnAllowed = row.kind !== 'bookmark'
    ? undefined
    : collectionCdnAllowed && faviconSourceModes.get(row.id) !== 'none' && knownFaviconForUrl(row.url) === null;
  return {
    id: row.id,
    parentId: row.parentId,
    kind: row.kind,
    title: row.title,
    url: row.url,
    description: row.description,
    position: row.positionToken,
    createdAt: formatChildrenCursorTime(row.createdAt),
    updatedAt: formatChildrenCursorTime(row.updatedAt),
    iconUrl: iconUrlForNode(row.id, iconObjectIds, productOrigin),
    ...(nodeCdnAllowed === undefined ? {} : { faviconCdnAllowed: nodeCdnAllowed }),
    ...(row.kind === 'bookmark' && row.pinned === true ? { pinned: true as const } : {}),
  };
}

function normalizeSort(value: string | undefined): CollectionChildrenSort {
  const sort = value ?? 'curated';
  if (!isCollectionChildrenSort(sort)) {
    throw new CollectionChildrenInputError(
      `sort must be one of: ${COLLECTION_CHILDREN_SORTS.join(', ')}`,
    );
  }
  return sort;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return COLLECTION_CHILDREN_DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > COLLECTION_CHILDREN_MAX_LIMIT) {
    throw new CollectionChildrenInputError(
      `limit must be an integer between 1 and ${COLLECTION_CHILDREN_MAX_LIMIT}`,
    );
  }
  return value;
}

function normalizeParentId(value: string | undefined): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > 128) {
    throw new CollectionChildrenInputError('parentId must be a valid node id');
  }
  // A parent id is opaque; never NFKC-normalize, trim or rewrite it.
  return value;
}

function assertNonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CollectionChildrenInputError(`${field} is required`);
  }
  return value;
}