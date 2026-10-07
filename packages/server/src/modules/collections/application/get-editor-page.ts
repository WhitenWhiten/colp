import { authorizeCapability, capabilitiesForRole, type AccessPolicyFactsPort, type MembershipRole } from '../../access-policy/index.js';
import {
  EditorAuthorizationError,
  EditorCursorError,
  SnapshotExpiredError,
  formatUtcDateTime,
  generateOpaqueId,
  strongEntityTag,
  type CollectionKind,
  type NodeVisibility,
} from '../domain/index.js';
import {
  PRODUCT_EDITOR_COMPARATOR_VERSION,
  PRODUCT_EDITOR_CURSOR_PURPOSE,
  PRODUCT_EDITOR_CURSOR_TTL_MS,
  PRODUCT_EDITOR_CURSOR_VERSION,
  type ProductEditorCursorAfter,
  type ProductEditorCursorPayload,
  type ProductEditorCursorSignerPort,
} from './editor-cursor.js';
import type { CollectionsClock, BookmarkIconReadPort, CollectionWritePort } from './ports.js';
import { iconUrlForNode, loadBookmarkIconObjectIds } from './bookmark-icon-url.js';
import { attachBookmarkPreviewImages, type BookmarkPreviewImageView, type LinkPreviewReadPort } from './link-preview-read.js';

export const EDITOR_PAGE_DEFAULT_LIMIT = 200;
export const EDITOR_PAGE_MAX_LIMIT = 500;
/** Full EditorPage JSON body budget (4 MiB). */
export const EDITOR_PAGE_MAX_BYTES = 4 * 1024 * 1024;

export interface GetCollectionEditorPageActor {
  readonly principalId: string;
  readonly subjectId: string;
}

export interface GetCollectionEditorPageInput {
  readonly collectionId: string;
  readonly actor: GetCollectionEditorPageActor;
  /** First page only; default 200, max 500. Must be omitted when cursor is set. */
  readonly limit?: number;
  /** Continuation token; when set, limit must be omitted. */
  readonly cursor?: string;
}

export interface CollectionView {
  readonly id: string;
  readonly kind: CollectionKind;
  readonly title: string;
  readonly summary: string | null;
  readonly visibility: 'private' | 'protected' | 'unlisted' | 'public';
  readonly publicationSlug: string | null;
  readonly allowSearchIndexing: boolean;
  readonly publishedAt: string | null;
  readonly rootNodeId: string;
  readonly revision: string;
  readonly etag: string;
  readonly contentRevision: string;
  readonly contentEtag: string;
  readonly policyRevision: string;
  readonly policyEtag: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RootNodeView {
  readonly id: string;
  readonly collectionId: string;
  readonly kind: 'folder';
  readonly folderRole: 'root';
  readonly parentId: null;
  readonly position: null;
  readonly title: string;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly visibility: 'inherit';
  readonly revision: string;
  readonly etag: string;
  readonly readOnly: true;
  readonly readOnlyReason: 'root_immutable';
  readonly childrenRevision: string;
  readonly childrenEtag: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FolderNodeView {
  readonly id: string;
  readonly collectionId: string;
  readonly kind: 'folder';
  readonly folderRole: null;
  readonly parentId: string;
  readonly position: string;
  readonly title: string;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly visibility: NodeVisibility;
  readonly revision: string;
  readonly etag: string;
  readonly readOnly: false;
  readonly readOnlyReason: null;
  readonly childrenRevision: string;
  readonly childrenEtag: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BookmarkNodeView {
  readonly id: string;
  readonly collectionId: string;
  readonly kind: 'bookmark';
  readonly parentId: string;
  readonly position: string;
  readonly title: string;
  readonly url: string;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly visibility: NodeVisibility;
  readonly revision: string;
  readonly etag: string;
  readonly readOnly: false;
  readonly readOnlyReason: null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Live same-origin `/api/v1/favicon/{uuid}` URL, or JSON null when unbound. */
  readonly iconUrl: string | null;
  /** LP-04 same-origin preview image; null when none. Omitted by mutation responses. */
  readonly previewImage?: BookmarkPreviewImageView | null;
  /** Pinned by the owner in a browser; read views only, absent when unpinned. */
  readonly pinned?: true;
}

export type EditableNodeView = FolderNodeView | BookmarkNodeView;

export interface CollectionCapabilities {
  readonly updateCollection: boolean;
  /** Owner-only authority for visibility and publication locator changes. */
  readonly managePublication: boolean;
  readonly createNode: boolean;
  readonly updateNode: boolean;
  readonly moveNode: boolean;
  readonly deleteNode: boolean;
}

export interface EditorPageState {
  readonly snapshotId: string;
  readonly contentRevision: string;
  readonly policyRevision: string;
  readonly comparatorVersion: typeof PRODUCT_EDITOR_COMPARATOR_VERSION;
  readonly expiresAt: string;
  readonly returnedCount: number;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

export interface EditorPage {
  readonly collection: CollectionView;
  readonly root: RootNodeView;
  readonly nodes: readonly EditableNodeView[];
  readonly capabilities: CollectionCapabilities;
  readonly page: EditorPageState;
}

/** Comparator sentinel for null parent_id / position_token (root excluded from nodes). */
export const EDITOR_COMPARATOR_ROOT_SENTINEL = '';

export interface EditorCollectionRow {
  readonly id: string;
  readonly kind: CollectionKind;
  readonly title: string;
  readonly summary: string | null;
  readonly visibility: 'private' | 'protected' | 'unlisted' | 'public';
  readonly publicationSlug?: string | null;
  readonly allowSearchIndexing?: boolean;
  readonly publishedAt?: Date | null;
  readonly rootNodeId: string;
  readonly resourceRevision: string;
  readonly contentRevision: string;
  readonly policyRevision: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

export interface EditorRootNodeRow {
  readonly id: string;
  readonly collectionId: string;
  readonly title: string;
  readonly description: string | null;
  readonly tags: unknown;
  readonly resourceRevision: string;
  readonly childrenRevision: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface EditorLiveNodeRow {
  readonly id: string;
  readonly collectionId: string;
  readonly parentId: string;
  readonly kind: 'folder' | 'bookmark';
  readonly title: string;
  readonly url: string | null;
  readonly description: string | null;
  readonly tags: unknown;
  readonly visibility: NodeVisibility;
  readonly positionToken: string;
  readonly resourceRevision: string;
  readonly childrenRevision: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly pinned?: boolean;
}

export interface LoadCollectionEditorSnapshotInput {
  readonly collectionId: string;
  /** Page size; implementation fetches limit+1 to detect hasMore. */
  readonly limit: number;
  /** Exclusive start for keyset continuation; omit on first page. */
  readonly after?: ProductEditorCursorAfter;
}

export interface CollectionEditorSnapshot {
  readonly collection: EditorCollectionRow;
  readonly root: EditorRootNodeRow;
  /**
   * Live non-root nodes in comparator order, length <= limit+1.
   * When length > limit, hasMore is true for the item budget.
   */
  readonly nodes: readonly EditorLiveNodeRow[];
}

export interface CollectionEditorSnapshotPort {
  /**
   * Load collection + root + live non-root nodes page.
   * Returns null when the collection row is absent.
   * Soft-deleted collections still return the row (deletedAt set); auth conceals.
   */
  loadCollectionEditorSnapshot(
    input: LoadCollectionEditorSnapshotInput,
  ): Promise<CollectionEditorSnapshot | null>;
}

export interface GetCollectionEditorPagePorts {
  readonly collections: Pick<CollectionWritePort, 'lockForShare'>;
  readonly loadSnapshot: CollectionEditorSnapshotPort;
  readonly accessPolicy: AccessPolicyFactsPort;
  readonly cursorSigner: ProductEditorCursorSignerPort;
  readonly clock: CollectionsClock;
  /** Absolute first-page cursor TTL; defaults to PRODUCT_EDITOR_CURSOR_TTL_MS (15 min). */
  readonly cursorTtlMs?: number;
  /** PRODUCT_ORIGIN used to project same-origin `/api/v1/favicon/{uuid}` URLs. */
  readonly productOrigin?: string;
  /** Batch live bookmark_icons lookup; missing/empty → every bookmark `iconUrl` is null. */
  readonly bookmarkIcons?: BookmarkIconReadPort;
  readonly linkPreviews?: LinkPreviewReadPort;
}

/** Application-level input error for transport to map to invalid_query. */
export class EditorInputError extends Error {
  readonly code = 'invalid_query' as const;

  constructor(message: string) {
    super(message);
    this.name = 'EditorInputError';
  }
}

/**
 * Revision-fenced Product Editor page (P1-06 / ADR-0004).
 * Caller binds ports to one REPEATABLE READ transaction for lock + authorize + snapshot.
 */
export async function getCollectionEditorPage(
  ports: GetCollectionEditorPagePorts,
  input: GetCollectionEditorPageInput,
): Promise<EditorPage> {
  const collectionId = assertNonEmpty(input.collectionId, 'collectionId');
  const principalId = assertNonEmpty(input.actor.principalId, 'actor.principalId');
  const subjectId = assertNonEmpty(input.actor.subjectId, 'actor.subjectId');

  if (input.cursor !== undefined && input.limit !== undefined) {
    throw new EditorInputError('limit and cursor are mutually exclusive');
  }

  const now = await ports.clock.now();

  let continuation: ProductEditorCursorPayload | null = null;
  let limit: number;
  let snapshotId: string;
  let issuedAt: string;
  let expiresAt: string;
  let after: ProductEditorCursorAfter | undefined;

  if (input.cursor !== undefined) {
    if (typeof input.cursor !== 'string' || input.cursor.length < 1) {
      throw new EditorCursorError();
    }
    continuation = ports.cursorSigner.verify(input.cursor, now);
    if (
      continuation.principalId !== principalId
      || continuation.collectionId !== collectionId
      || continuation.purpose !== PRODUCT_EDITOR_CURSOR_PURPOSE
      || continuation.v !== PRODUCT_EDITOR_CURSOR_VERSION
      || continuation.comparatorVersion !== PRODUCT_EDITOR_COMPARATOR_VERSION
    ) {
      throw new EditorCursorError();
    }
    limit = continuation.limit;
    snapshotId = continuation.snapshotId;
    issuedAt = continuation.issuedAt;
    expiresAt = continuation.expiresAt;
    after = continuation.after;
  } else {
    limit = normalizeLimit(input.limit);
    snapshotId = generateOpaqueId();
    const ttlMs = ports.cursorTtlMs ?? PRODUCT_EDITOR_CURSOR_TTL_MS;
    issuedAt = formatUtcDateTime(now);
    expiresAt = formatUtcDateTime(new Date(now.getTime() + ttlMs));
  }

  const locked = await ports.collections.lockForShare(collectionId);
  if (!locked || locked.deletedAt !== null) {
    throw new EditorAuthorizationError({
      outcome: 'conceal',
      reasonCategory: 'resource_missing',
    });
  }

  const decision = await authorizeCapability(ports.accessPolicy, {
    collectionId,
    actor: { principalId, subjectId, kind: 'account' },
    capability: 'read_editor',
  });

  if (decision.outcome !== 'allow') {
    throw new EditorAuthorizationError({
      outcome: decision.outcome,
      reasonCategory: decision.reasonCategory,
    });
  }

  const snapshot = await ports.loadSnapshot.loadCollectionEditorSnapshot({
    collectionId,
    limit,
    after,
  });

  if (!snapshot || snapshot.collection.deletedAt !== null) {
    // Collection gone or soft-deleted after lock/authorize race → conceal.
    throw new EditorAuthorizationError({
      outcome: 'conceal',
      reasonCategory: 'resource_missing',
    });
  }

  if (continuation) {
    if (
      snapshot.collection.contentRevision !== continuation.contentRevision
      || snapshot.collection.policyRevision !== continuation.policyRevision
    ) {
      throw new SnapshotExpiredError();
    }
  }

  const collection = mapCollectionView(snapshot.collection);
  const root = mapRootNodeView(snapshot.root);
  const capabilities = mapCapabilities(decision.effectiveRole);

  const iconObjectIds = await loadBookmarkIconObjectIds(
    ports.bookmarkIcons,
    snapshot.nodes.filter((row) => row.kind === 'bookmark').map((row) => row.id),
  );

  // Adapter returns at most limit+1 rows; map only what we may return (+1 probe).
  const mapped: EditableNodeView[] = await attachBookmarkPreviewImages(ports.linkPreviews, ports.productOrigin,
    snapshot.nodes.map((row) => mapEditableNodeView(row, iconObjectIds, ports.productOrigin)));

  const selection = selectNodesWithinBudgets(mapped, limit, {
    collection,
    root,
    capabilities,
    snapshotId,
    contentRevision: collection.contentRevision,
    policyRevision: collection.policyRevision,
    expiresAt,
  }, (last) => {
    const payload: ProductEditorCursorPayload = {
      v: PRODUCT_EDITOR_CURSOR_VERSION,
      purpose: PRODUCT_EDITOR_CURSOR_PURPOSE,
      principalId,
      collectionId,
      limit,
      comparatorVersion: PRODUCT_EDITOR_COMPARATOR_VERSION,
      after: cursorAfterFromNode(last),
      contentRevision: collection.contentRevision,
      policyRevision: collection.policyRevision,
      snapshotId,
      issuedAt,
      expiresAt,
    };
    return payload;
  }, (payload) => ports.cursorSigner.encodedLength(payload));

  let nextCursor: string | null = null;
  if (selection.nextCursorPayload !== null) {
    nextCursor = ports.cursorSigner.sign(selection.nextCursorPayload);
    if (Buffer.byteLength(nextCursor, 'utf8') !== selection.nextCursorBytes) {
      throw new Error('product editor cursor signer returned an unexpected token length');
    }
  }

  return {
    collection,
    root,
    nodes: selection.nodes,
    capabilities,
    page: {
      snapshotId,
      contentRevision: collection.contentRevision,
      policyRevision: collection.policyRevision,
      comparatorVersion: PRODUCT_EDITOR_COMPARATOR_VERSION,
      expiresAt,
      returnedCount: selection.nodes.length,
      hasMore: selection.hasMore,
      nextCursor,
    },
  };
}

interface PageBudgetContext {
  readonly collection: CollectionView;
  readonly root: RootNodeView;
  readonly capabilities: CollectionCapabilities;
  readonly snapshotId: string;
  readonly contentRevision: string;
  readonly policyRevision: string;
  readonly expiresAt: string;
}

interface BudgetedNodeSelection {
  readonly nodes: EditableNodeView[];
  readonly hasMore: boolean;
  readonly nextCursorPayload: ProductEditorCursorPayload | null;
  readonly nextCursorBytes: number | null;
}

/**
 * Add nodes while respecting item limit and 4 MiB full-response budget.
 * Always returns at least an empty page; a single legal node is assumed to fit.
 */
function selectNodesWithinBudgets(
  candidates: readonly EditableNodeView[],
  itemLimit: number,
  context: PageBudgetContext,
  createNextCursorPayload: (last: EditableNodeView) => ProductEditorCursorPayload,
  measureNextCursor: (payload: ProductEditorCursorPayload) => number,
): BudgetedNodeSelection {
  const nodes: EditableNodeView[] = [];
  let nodesPayloadBytes = 0;
  let hasMore = false;
  let nextCursorPayload: ProductEditorCursorPayload | null = null;
  let nextCursorBytes: number | null = null;
  const emptyShellBytes = utf8JsonBytes(buildSizeProbe(context, 0, false, null));

  const selectableCount = Math.min(candidates.length, itemLimit);
  for (let index = 0; index < selectableCount; index += 1) {
    const node = candidates[index]!;
    const encodedNode = JSON.stringify(node);
    const trialNodesPayloadBytes = nodesPayloadBytes
      + (nodes.length === 0 ? 0 : 1)
      + Buffer.byteLength(encodedNode, 'utf8');
    const trialCount = nodes.length + 1;
    const trialHasMore = trialCount < candidates.length;
    const trialNextCursorPayload = trialHasMore ? createNextCursorPayload(node) : null;
    const trialNextCursorTokenBytes = trialNextCursorPayload === null
      ? null
      : measureNextCursor(trialNextCursorPayload);
    const trialNextCursorJsonBytes = trialNextCursorTokenBytes === null
      ? 4 // JSON `null`
      : trialNextCursorTokenBytes + 2; // JSON string quotes
    const shellBytes = emptyShellBytes
      + utf8JsonBytes(trialCount) - 1 // replace `returnedCount:0`
      + utf8JsonBytes(trialHasMore) - 5 // replace `hasMore:false`
      + trialNextCursorJsonBytes - 4; // replace `nextCursor:null`

    // The shell contains `nodes:[]`; replacing that empty payload adds exactly
    // the encoded node bytes and the commas accumulated above.
    if (shellBytes + trialNodesPayloadBytes <= EDITOR_PAGE_MAX_BYTES) {
      nodes.push(node);
      nodesPayloadBytes = trialNodesPayloadBytes;
      hasMore = trialHasMore;
      nextCursorPayload = trialNextCursorPayload;
      nextCursorBytes = trialNextCursorTokenBytes;
      continue;
    }

    // Legal node field limits keep one node well below 4 MiB. Failing closed
    // preserves the response budget if persisted data violates that invariant.
    if (nodes.length === 0) {
      throw new Error('editor node exceeds the response byte budget');
    }
    break;
  }

  return { nodes, hasMore, nextCursorPayload, nextCursorBytes };
}

function buildSizeProbe(
  context: PageBudgetContext,
  returnedCount: number,
  hasMore: boolean,
  nextCursor: string | null,
): EditorPage {
  return {
    collection: context.collection,
    root: context.root,
    nodes: [],
    capabilities: context.capabilities,
    page: {
      snapshotId: context.snapshotId,
      contentRevision: context.contentRevision,
      policyRevision: context.policyRevision,
      comparatorVersion: PRODUCT_EDITOR_COMPARATOR_VERSION,
      expiresAt: context.expiresAt,
      returnedCount,
      hasMore,
      nextCursor,
    },
  };
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return EDITOR_PAGE_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > EDITOR_PAGE_MAX_LIMIT) {
    throw new EditorInputError(
      `limit must be an integer between 1 and ${EDITOR_PAGE_MAX_LIMIT}`,
    );
  }
  return limit;
}

function assertNonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EditorInputError(`${field} is required`);
  }
  return value;
}

function mapCapabilities(role: MembershipRole | null): CollectionCapabilities {
  const caps = capabilitiesForRole(role);
  return {
    updateCollection: caps.has('update_collection_metadata'),
    managePublication: caps.has('manage_publication'),
    createNode: caps.has('create_node'),
    updateNode: caps.has('update_node'),
    moveNode: caps.has('move_node'),
    deleteNode: caps.has('delete_node'),
  };
}

function mapCollectionView(row: EditorCollectionRow): CollectionView {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    visibility: row.visibility,
    publicationSlug: row.publicationSlug ?? null,
    allowSearchIndexing: row.allowSearchIndexing ?? false,
    publishedAt: row.publishedAt ? formatUtcDateTime(row.publishedAt) : null,
    rootNodeId: row.rootNodeId,
    revision: row.resourceRevision,
    etag: strongEntityTag(row.resourceRevision),
    contentRevision: row.contentRevision,
    contentEtag: strongEntityTag(row.contentRevision),
    policyRevision: row.policyRevision,
    policyEtag: strongEntityTag(row.policyRevision),
    createdAt: formatUtcDateTime(row.createdAt),
    updatedAt: formatUtcDateTime(row.updatedAt),
  };
}

function mapRootNodeView(row: EditorRootNodeRow): RootNodeView {
  return {
    id: row.id,
    collectionId: row.collectionId,
    kind: 'folder',
    folderRole: 'root',
    parentId: null,
    position: null,
    title: row.title,
    description: row.description ?? null,
    tags: parseTags(row.tags),
    visibility: 'inherit',
    revision: row.resourceRevision,
    etag: strongEntityTag(row.resourceRevision),
    readOnly: true,
    readOnlyReason: 'root_immutable',
    childrenRevision: row.childrenRevision,
    childrenEtag: strongEntityTag(row.childrenRevision),
    createdAt: formatUtcDateTime(row.createdAt),
    updatedAt: formatUtcDateTime(row.updatedAt),
  };
}

function mapEditableNodeView(
  row: EditorLiveNodeRow,
  iconObjectIds: ReadonlyMap<string, string>,
  productOrigin: string | undefined,
): EditableNodeView {
  const tags = parseTags(row.tags);
  const visibility = row.visibility ?? 'inherit';
  const common = {
    id: row.id,
    collectionId: row.collectionId,
    parentId: row.parentId,
    position: row.positionToken,
    title: row.title,
    description: row.description ?? null,
    tags,
    visibility,
    revision: row.resourceRevision,
    etag: strongEntityTag(row.resourceRevision),
    readOnly: false as const,
    readOnlyReason: null,
    createdAt: formatUtcDateTime(row.createdAt),
    updatedAt: formatUtcDateTime(row.updatedAt),
  };

  if (row.kind === 'folder') {
    return {
      ...common,
      kind: 'folder',
      folderRole: null,
      childrenRevision: row.childrenRevision,
      childrenEtag: strongEntityTag(row.childrenRevision),
    };
  }

  if (typeof row.url !== 'string' || row.url.length < 1) {
    // DB check guarantees bookmark url; treat as hard integrity failure.
    throw new Error(`bookmark node ${row.id} is missing url`);
  }
  return {
    ...common,
    kind: 'bookmark',
    url: row.url,
    iconUrl: iconUrlForNode(row.id, iconObjectIds, productOrigin),
    ...(row.pinned === true ? { pinned: true as const } : {}),
  };
}

function parseTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') tags.push(item);
  }
  return tags;
}

function cursorAfterFromNode(node: EditableNodeView): ProductEditorCursorAfter {
  return {
    parentKey: node.parentId,
    positionKey: node.position,
    nodeId: node.id,
  };
}

function utf8JsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
