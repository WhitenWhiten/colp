import { resourceKind, type ResourceKind, postgresPlanFacts, type PostgresCanonicalPlanFacts, type CascadedAnnotationRow, type CascadedRelationRow, type CascadedAnnotationPlan, type CascadedRelationPlan } from './canonical-execution-plan.js';
import { withCanonicalTreeCapacity, type CanonicalTreeCapacityAdmission } from './canonical-tree-capacity.js';
import { appendCanonicalSecondaryOutbox } from './canonical-secondary-outbox.js';
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { appendAuditEvent } from '../database/audit-event-payload.js';
import { lockActiveSyncReplicasForCollection } from '../database/lock-order.js';
import {
  existingExtensions,
  existingNodePayloadFields,
  nodePayloadFields,
  withExtensions,
} from './canonical-mutation-payload-fields.js';
import {
  ANNOTATION_DELETED_EVENT_TYPE,
  ANNOTATION_DELETED_EVENT_VERSION,
  ANNOTATION_DELETED_HANDLER_NAME,
  RELATION_DELETED_EVENT_TYPE,
  RELATION_DELETED_EVENT_VERSION,
  RELATION_DELETED_HANDLER_NAME,
  CanonicalMutationInvariantError,
  CollectionsError,
  isAcceptedBookmarkUrl,
  isEquivalentBookmarkUrlRewrite,
  DeleteSubtreeLimitError,
  NodeConflictError,
  PositionRebalanceEscalationError,
  allocatePosition,
  assertValidCollectionKind,
  assertValidCollectionSummary,
  assertValidCollectionTitle,
  assertValidNodeDescription,
  assertValidNodeTags,
  assertValidNodeTitle,
  assertValidNodeVisibility,
  compareResourcePayload,
  assertAnnotationDeletedPayload,
  formatUtcDateTime,
  generateRevisionToken,
  materializeCollectionPayload,
  materializeNodePayload,
  NODE_DELETION_PURGE_RETENTION_MS,
  RESOURCE_PAYLOAD_SCHEMA_VERSION,
  planBoundedPositionRebalance,
  resolvePlacement as resolvePlacementPure,
  validateResourcePayload,
  type CanonicalMutationInput,
  type CanonicalResourceWrite,
  type CanonicalDomainEvent,
  type CanonicalMutationPlan,
  type CanonicalMutationPorts,
  type CanonicalMutationResult,
  type JsonObject,
  type LockedCollectionState,
} from '../../modules/collections/index.js';
import {
  appendSidecarDomainEvent,
  applySidecarCanonicalMutation,
  planSidecarCanonicalMutation,
  type SidecarUpdateFacts,
} from './canonical-sidecar-mutation-postgres.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { appendOperationWithPayload } from '../database/operation-payload-store.js';
import type { Metrics } from '../telemetry/index.js';
import type { ReportSourceInvalidationOutboxPort } from '../outbox/report-source-invalidation-producer.js';
import { deleteBookmarkIconsForNodeIds } from './bookmark-icon-postgres.js';
import {
  PUBLICATION_CACHE_PURGE_EVENT_TYPE,
  PUBLICATION_CACHE_PURGE_EVENT_VERSION,
  PUBLICATION_CACHE_PURGE_HANDLER_NAME,
} from '../outbox/publication-cache-purge.js';
import {
  type SocialCollectionChangeRouteFaultInjector,
} from '../outbox/social-collection-change.js';
import { routeCanonicalDomainEvent } from './canonical-outbox-router.js';
import {
  cascadeDeleteAnnotations,
  cascadeDeleteRelations,
} from './canonical-subtree-delete-batches.js';
import {
  readBoundedPlacementContext,
  readRebalanceWindowSiblings,
  type PreresolvedSiblingPlacement,
} from './postgres-sibling-placement-read.js';
type CollectionNodeKind = 'collection' | 'node';
const MAX_PARENT_ANCESTRY_DEPTH = 256;
const DEFAULT_MAX_DELETE_SUBTREE_NODES = 10_000;
const DEFAULT_MAX_DELETE_SUBTREE_DEPTH = 256;
const HARD_MAX_DELETE_SUBTREE_NODES = 100_000;
const HARD_MAX_DELETE_SUBTREE_DEPTH = 1_024;

function searchUrlHost(value: string | null): string | null {
  if (value === null) return null;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username.length > 0 || parsed.password.length > 0) return null;
    return parsed.hostname.normalize('NFKC').toLocaleLowerCase('und');
  } catch {
    return null;
  }
}

async function upsertPendingCollectionLinkHealth(
  tx: DatabaseTransaction,
  row: { readonly id: string; readonly collection_id: string; readonly kind: string; readonly url: string | null },
): Promise<void> {
  if (row.kind !== 'bookmark' || row.url === null || row.url.length < 1) return;
  await sql`
    INSERT INTO collection_link_health (
      node_id, collection_id, status, http_status, final_url, checked_at, error_class, lease_owner, lease_until
    ) VALUES (
      ${row.id}, ${row.collection_id}, 'pending', NULL, NULL, NULL, NULL, NULL, NULL
    )
    ON CONFLICT (node_id) DO UPDATE SET
      collection_id = EXCLUDED.collection_id,
      status = 'pending',
      http_status = NULL,
      final_url = NULL,
      checked_at = NULL,
      error_class = NULL,
      lease_owner = NULL,
      lease_until = NULL
  `.execute(tx);
}

async function deleteCollectionLinkHealthForNodeIds(
  tx: DatabaseTransaction,
  nodeIds: readonly string[],
): Promise<void> {
  if (nodeIds.length === 0) return;
  await tx.deleteFrom('collection_link_health').where('node_id', 'in', [...nodeIds]).execute();
}
export const DELETE_SUBTREE_WRITE_BATCH_SIZE = 128;
export const DEFAULT_POSITION_REBALANCE_WINDOW = 32;
export const MAX_POSITION_REBALANCE_WINDOW = 256;

export function resolvePositionRebalanceWindow(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_POSITION_REBALANCE_WINDOW;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_POSITION_REBALANCE_WINDOW)
    : DEFAULT_POSITION_REBALANCE_WINDOW;
}

export interface DeleteSubtreeLimits {
  readonly nodes: number;
  readonly depth: number;
}

function boundedDeleteLimit(raw: string | undefined, fallback: number, ceiling: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? Math.min(value, ceiling) : fallback;
}

export function resolveDeleteSubtreeLimits(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): DeleteSubtreeLimits {
  return {
    nodes: boundedDeleteLimit(env.KNOW_N_MAX_DELETE_SUBTREE_NODES, DEFAULT_MAX_DELETE_SUBTREE_NODES, HARD_MAX_DELETE_SUBTREE_NODES),
    depth: boundedDeleteLimit(env.KNOW_N_MAX_DELETE_SUBTREE_DEPTH, DEFAULT_MAX_DELETE_SUBTREE_DEPTH, HARD_MAX_DELETE_SUBTREE_DEPTH),
  };
}

function generateOutboxId(): string {
  return randomBytes(16).toString('base64url');
}

interface CollectionRow {
  id: string;
  owner_subject_id: string;
  title: string;
  summary: string | null;
  kind: 'bookmarks' | 'reading_path' | 'knowledge_collection' | 'mixed';
  visibility: 'private' | 'protected' | 'public' | 'unlisted';
  allow_search_indexing: boolean;
  publication_slug: string | null;
  published_at: Date | null;
  root_node_id: string;
  resource_revision: string;
  content_revision: string;
  policy_revision: string;
  commit_ordinal: bigint;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  payload_json: Record<string, unknown> | null;
  payload_schema_version: number | null;
  payload_authority_status: 'pending' | 'backfilled' | 'malformed' | null;
}

interface NodeRow {
  id: string;
  collection_id: string;
  parent_id: string | null;
  kind: 'folder' | 'bookmark' | 'separator';
  is_root: boolean;
  title: string | null;
  url: string | null;
  search_url_host: string | null;
  description: string | null;
  tags: unknown;
  visibility: 'inherit' | 'protected' | 'private';
  position_token: string | null;
  resource_revision: string;
  children_revision: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  deleted_commit_ordinal: bigint | null;
  payload_json: Record<string, unknown> | null;
  payload_schema_version: number | null;
  payload_authority_status: 'pending' | 'backfilled' | 'malformed' | null;
}

/**
 * One planned delete row from the set-based validation query. `id` is the
 * node row id (null when the planned resource disappeared); `expected_revision`
 * is the allocated delete revision (null when the revision map is missing it).
 */
type PlannedDeleteRow = Omit<NodeRow, 'id'> & {
  id: string | null;
  expected_revision: string | null;
};


function assertCascadedRelationAuthority(row: CascadedRelationRow): void {
  const payload = row.payload_json;
  if (payload.id !== row.id || payload.collectionId !== row.collection_id
    || payload.fromNodeId !== row.from_node_id || payload.toNodeId !== row.to_node_id
    || payload.visibility !== row.visibility || payload.revision !== row.resource_revision) {
    invariant(`cascade Relation authority mismatch for ${row.id}`, true);
  }
}

function assertCascadedAnnotationAuthority(row: CascadedAnnotationRow): void {
  const payload = row.payload_json;
  const subject = payload.subject;
  if (payload.id !== row.id || payload.collectionId !== row.collection_id
    || payload.visibility !== row.visibility || payload.revision !== row.resource_revision
    || !subject || typeof subject !== 'object' || Array.isArray(subject)
    || (subject as Record<string, unknown>).type !== row.subject_type
    || (subject as Record<string, unknown>).id !== row.subject_id) {
    invariant(`cascade Annotation authority mismatch for ${row.id}`, true);
  }
}

export type CanonicalMutationWritePhase =
  | 'ledger'
  | 'resource'
  | 'revision'
  | 'operation'
  | 'audit'
  | 'outbox';

export interface PostgresCanonicalMutationFaultContext {
  readonly phase: CanonicalMutationWritePhase;
  readonly resourceId?: string;
  readonly resourceIndex?: number;
  readonly resourceCount?: number;
  /** The enclosing transaction, exposed so fault tests can corrupt later batches in-transaction. */
  readonly transaction?: DatabaseTransaction;
}

export interface PostgresCanonicalMutationFaultInjector {
  afterPhase?(context: PostgresCanonicalMutationFaultContext): void | Promise<void>;
}

export interface PostgresCanonicalOperationIdClaimOwner {
  /**
   * Proves that the surrounding transaction already owns this Operation ID.
   * Sequence uses this hook so Canonical Mutation appends the Operation without
   * attempting a second lifetime reservation. Product/Publisher omit it.
   */
  assertClaimed(transaction: DatabaseTransaction, operationId: string): Promise<void>;
}

export interface PostgresCanonicalResourceIdClaimOwner {
  /** Proves that the surrounding transaction already reserved this resource ID. */
  assertClaimed(
    transaction: DatabaseTransaction,
    resourceId: string,
    resourceType: 'node',
  ): Promise<void>;
}

export interface PostgresCanonicalMutationPortOptions {
  readonly treeCapacityAdmission?: CanonicalTreeCapacityAdmission;
  readonly outboxIdGenerator?: () => string;
  readonly faultInjector?: PostgresCanonicalMutationFaultInjector;
  readonly metrics?: Metrics;
  readonly positionRebalanceWindow?: number;
  readonly operationIdClaimOwner?: PostgresCanonicalOperationIdClaimOwner;
  readonly resourceIdClaimOwner?: PostgresCanonicalResourceIdClaimOwner;
  /** Non-Sync writers have no COLP Replica/Sequence identity, so force Snapshot recovery. */
  readonly invalidateSyncReplicasOnNodeMutation?: boolean;
  readonly socialRouteFaultInjector?: SocialCollectionChangeRouteFaultInjector;
  /** Sync pre-validates placement once and passes the bounded read through to allocation. */
  readonly preresolvedPlacement?: PreresolvedSiblingPlacement; readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort;
}

function invariant(message: string, authority = false): never {
  throw new CanonicalMutationInvariantError(
    authority ? 'resource_field_authority_violation' : 'invalid_canonical_mutation',
    message,
  );
}

function assertExactlyOneUpdated(result: { readonly numUpdatedRows: bigint }, description: string): void {
  if (result.numUpdatedRows !== 1n) invariant(`${description} updated ${result.numUpdatedRows} rows instead of one`);
}

function collectionProjection(row: CollectionRow) {
  return {
    id: row.id,
    ownerSubjectId: row.owner_subject_id,
    title: row.title,
    summary: row.summary,
    kind: row.kind,
    visibility: row.visibility,
    allowSearchIndexing: row.allow_search_indexing,
    rootNodeId: row.root_node_id,
    resourceRevision: row.resource_revision,
    contentRevision: row.content_revision,
    policyRevision: row.policy_revision,
    commitOrdinal: row.commit_ordinal,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function nodeProjection(row: NodeRow) {
  return {
    id: row.id,
    collectionId: row.collection_id,
    parentId: row.parent_id,
    kind: row.kind,
    isRoot: row.is_root,
    title: row.title,
    url: row.url,
    description: row.description,
    tags: row.tags,
    visibility: row.visibility,
    positionToken: row.position_token,
    resourceRevision: row.resource_revision,
    childrenRevision: row.children_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    deletedCommitOrdinal: row.deleted_commit_ordinal,
  };
}

function assertExistingNodeAuthority(row: NodeRow): JsonObject {
  const validated = validateResourcePayload('node', row.payload_json);
  if (!validated.ok) {
    invariant(`node payload is invalid at ${validated.fieldPath || '$'}: ${validated.reason}`, true);
  }
  const extensions = (row.payload_json as Record<string, unknown>).extensions as JsonObject;
  const expected = assertMaterialized(
    'node',
    row.id,
    materializeNodePayload(nodeProjection(row)),
    extensions,
    existingNodePayloadFields(row.payload_json),
  );
  const comparison = compareResourcePayload({
    resourceType: 'node',
    resourceId: row.id,
    expected,
    actual: row.payload_json,
  });
  if (!comparison.equal) {
    invariant(`node authority mismatch at ${comparison.mismatches[0]?.path ?? '$'}`, true);
  }
  if (
    row.payload_schema_version !== RESOURCE_PAYLOAD_SCHEMA_VERSION
    || row.payload_authority_status !== 'backfilled'
  ) {
    invariant('node payload authority metadata is invalid', true);
  }
  return extensions;
}

function assertExistingCollectionAuthority(row: CollectionRow): JsonObject {
  const validated = validateResourcePayload('collection', row.payload_json);
  if (!validated.ok) {
    invariant(`collection payload is invalid at ${validated.fieldPath || '$'}: ${validated.reason}`, true);
  }
  const extensions = (row.payload_json as Record<string, unknown>).extensions as JsonObject;
  const expected = assertMaterialized(
    'collection',
    row.id,
    materializeCollectionPayload(collectionProjection(row)),
    extensions,
  );
  const comparison = compareResourcePayload({
    resourceType: 'collection',
    resourceId: row.id,
    expected,
    actual: row.payload_json,
  });
  if (!comparison.equal) {
    invariant(`collection authority mismatch at ${comparison.mismatches[0]?.path ?? '$'}`, true);
  }
  if (
    row.payload_schema_version !== RESOURCE_PAYLOAD_SCHEMA_VERSION
    || row.payload_authority_status !== 'backfilled'
  ) {
    invariant('collection payload authority metadata is invalid', true);
  }
  return extensions;
}

function assertMaterialized(
  resourceType: CollectionNodeKind,
  resourceId: string,
  materialized: ReturnType<typeof materializeCollectionPayload>,
  extensions: JsonObject,
  payloadOwnedFields: JsonObject = {},
): JsonObject {
  if (!materialized.ok) {
    invariant(`${resourceType} payload is invalid at ${materialized.fieldPath ?? '$'}: ${materialized.reason}`, true);
  }
  return withExtensions({ ...materialized.payload, ...payloadOwnedFields }, extensions);
}

function readCollectionFields(fields: JsonObject, current: CollectionRow) {
  const allowed = new Set(['title', 'summary', 'kind', 'visibility', 'publicationSlug', 'allowSearchIndexing']);
  for (const key of Object.keys(fields)) if (!allowed.has(key)) invariant(`unsupported collection field: ${key}`);
  const title = assertValidCollectionTitle(fields.title === undefined ? current.title : fields.title as string);
  const summary = assertValidCollectionSummary(fields.summary === undefined ? current.summary : fields.summary as string | null);
  const kind = assertValidCollectionKind(fields.kind === undefined ? current.kind : fields.kind as string);
  const visibility = fields.visibility === undefined ? current.visibility : fields.visibility;
  if (!['private', 'protected', 'public', 'unlisted'].includes(String(visibility))) {
    invariant('collection visibility is invalid');
  }
  const suppliedSlug = fields.publicationSlug;
  if (suppliedSlug !== undefined && (typeof suppliedSlug !== 'string'
    || !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/u.test(suppliedSlug))) {
    invariant('publication slug is invalid');
  }
  if (current.published_at !== null
    && current.publication_slug !== null
    && suppliedSlug !== undefined
    && suppliedSlug !== current.publication_slug) {
    invariant('published collection slug is immutable');
  }
  const publicationSlug = current.published_at === null
    ? suppliedSlug as string | undefined ?? current.publication_slug
    : current.publication_slug ?? suppliedSlug as string | undefined ?? null;
  if ((visibility === 'public' || visibility === 'unlisted') && publicationSlug === null) {
    invariant('published collection requires a publication slug');
  }
  const allowSearchIndexing = fields.allowSearchIndexing === undefined
    ? current.allow_search_indexing
    : fields.allowSearchIndexing;
  if (typeof allowSearchIndexing !== 'boolean') invariant('allowSearchIndexing must be a boolean');
  return {
    title,
    summary,
    kind,
    visibility: visibility as CollectionRow['visibility'],
    publication_slug: publicationSlug,
    allow_search_indexing: allowSearchIndexing,
  };
}

function readNodeFields(fields: JsonObject, current?: NodeRow) {
  const allowed = new Set([
    'kind', 'title', 'url', 'description', 'tags', 'visibility',
    'folderRole', 'canonicalUrl', 'urlHash',
  ]);
  for (const key of Object.keys(fields)) if (!allowed.has(key)) invariant(`unsupported node field: ${key}`);
  const kindValue = fields.kind === undefined ? current?.kind ?? '' : fields.kind;
  if (kindValue !== 'folder' && kindValue !== 'bookmark' && kindValue !== 'separator') {
    invariant('node kind is invalid');
  }
  const kind = kindValue as NodeRow['kind'];
  const title = kind === 'separator'
    ? (() => {
      if (fields.title !== null && fields.title !== undefined) invariant('separator title must be absent');
      return null;
    })()
    : assertValidNodeTitle(fields.title === undefined ? current?.title ?? '' : fields.title as string);
  const description = assertValidNodeDescription(
    fields.description === undefined ? current?.description ?? null : fields.description as string | null,
  );
  const tags = assertValidNodeTags(
    fields.tags === undefined ? (current?.tags ?? []) as readonly string[] : fields.tags as readonly string[],
  );
  const visibility = assertValidNodeVisibility(
    fields.visibility === undefined ? current?.visibility ?? 'inherit' : fields.visibility as string,
  );
  const urlValue = fields.url === undefined ? current?.url ?? null : fields.url;
  const url = urlValue === null ? null : String(urlValue);
  if (kind === 'bookmark') {
    if (url === null || !isAcceptedBookmarkUrl(url)) invariant('bookmark url is not an accepted HTTP(S) URL');
  } else if (url !== null) {
    invariant('non-Bookmark url must be null');
  }
  if (fields.folderRole !== undefined && (kind !== 'folder'
      || !/^(managed-bookmarks|bookmarks-bar|other-bookmarks|mobile-bookmarks|custom|recovered)$/.test(String(fields.folderRole)))) invariant('folderRole is invalid');
  if (fields.canonicalUrl !== undefined && fields.canonicalUrl !== null
      && (kind !== 'bookmark' || !isAcceptedBookmarkUrl(String(fields.canonicalUrl)))) {
    invariant('canonicalUrl is invalid');
  }
  if (fields.urlHash !== undefined && fields.urlHash !== null
      && (kind !== 'bookmark' || typeof fields.urlHash !== 'string')) {
    invariant('urlHash is invalid');
  }
  return { kind, title, url, description, tags, visibility };
}

async function loadCollection(transaction: DatabaseTransaction, id: string, lock = false): Promise<CollectionRow | undefined> {
  let query = transaction.selectFrom('collections').selectAll().where('id', '=', id);
  if (lock) query = query.forUpdate();
  return query.executeTakeFirst() as Promise<CollectionRow | undefined>;
}

async function loadNode(transaction: DatabaseTransaction, collectionId: string, id: string): Promise<NodeRow | undefined> {
  return transaction.selectFrom('nodes').selectAll()
    .where('collection_id', '=', collectionId).where('id', '=', id)
    .executeTakeFirst() as Promise<NodeRow | undefined>;
}

async function planLiveDeleteSet(
  transaction: DatabaseTransaction,
  collectionId: string,
  target: NodeRow,
  scope: 'single' | 'subtree',
  limits: DeleteSubtreeLimits,
): Promise<readonly NodeRow[]> {
  if (scope === 'single') {
    if (target.kind === 'folder') {
      const child = await transaction.selectFrom('nodes').select('id')
        .where('collection_id', '=', collectionId)
        .where('parent_id', '=', target.id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (child) invariant('non-recursive folder delete requires an empty folder');
    }
    return [target];
  }
  if (target.kind !== 'folder') invariant('recursive delete requires a folder target');
  const result = await sql<NodeRow & { depth: number; cycle: boolean }>`
    with recursive subtree as (
      select n.*, 0::integer as depth, array[n.id]::text[] as path, false as cycle
      from nodes n
      where n.collection_id = ${collectionId} and n.id = ${target.id} and n.deleted_at is null
      union all
      select child.*, subtree.depth + 1, subtree.path || child.id,
        child.id = any(subtree.path) as cycle
      from nodes child
      join subtree on child.parent_id = subtree.id
      where child.collection_id = ${collectionId}
        and child.deleted_at is null
        and subtree.depth <= ${limits.depth}
        and not subtree.cycle
    )
    select id, collection_id, parent_id, kind, is_root, title, url, search_url_host, description, tags,
      visibility, position_token, resource_revision, children_revision, created_at, updated_at,
      deleted_at, deleted_commit_ordinal, payload_json, payload_schema_version,
      payload_authority_status, depth, cycle
    from subtree
    limit ${limits.nodes + 1}
  `.execute(transaction);
  const rows = result.rows;
  if (rows.some((row) => row.cycle)) invariant('recursive delete graph contains a cycle');
  if (rows.some((row) => row.depth > limits.depth)) {
    throw new DeleteSubtreeLimitError(`Recursive delete exceeds the maximum depth of ${limits.depth}.`);
  }
  if (rows.length > limits.nodes) {
    throw new DeleteSubtreeLimitError(
      `Recursive delete exceeds the maximum node count of ${limits.nodes}.`,
    );
  }
  if (rows.length === 0 || !rows.some((row) => row.id === target.id)) invariant('recursive delete planner lost its target');
  return rows.sort((left, right) => right.depth - left.depth || left.id.localeCompare(right.id, 'en'));
}

async function validateNodeParent(
  transaction: DatabaseTransaction,
  collectionId: string,
  nodeId: string,
  parentId: string,
  checkAncestry: boolean,
): Promise<void> {
  if (parentId === nodeId) invariant('target parent ancestry already contains a cycle');
  const result = await sql<{ id: string; parent_id: string | null; depth: number; is_root: boolean; kind: string; collection_id: string; deleted_at: Date | null; cycle: boolean }>`
    with recursive ancestry as (
      select n.id, n.parent_id, 0::integer as depth, n.is_root, n.kind, n.collection_id, n.deleted_at, false as cycle,
        array[n.id]::text[] as path
      from nodes n where n.collection_id = ${collectionId} and n.id = ${parentId}
      union all
      select p.id, p.parent_id, a.depth + 1, p.is_root, p.kind, p.collection_id, p.deleted_at,
        p.id = any(a.path) as cycle, a.path || p.id
      from nodes p join ancestry a on p.id = a.parent_id
      where ${checkAncestry} and a.depth < ${MAX_PARENT_ANCESTRY_DEPTH} and not a.cycle
    ) select id, parent_id, depth, is_root, kind, collection_id, deleted_at, cycle from ancestry order by depth
  `.execute(transaction);
  const rows = result.rows.flatMap((row) => row.cycle ? [row, row] : [row]);
  if (rows.some((row) => row.cycle)) invariant('target parent ancestry already contains a cycle');
  if (rows.length === 0 || rows.some((row) => row.collection_id !== collectionId || row.deleted_at !== null || row.kind !== 'folder')) invariant('target parent must be a live folder in the collection');
  if (rows.some((row) => row.id === nodeId)) invariant('target parent must not be the node or its descendant');
  if (checkAncestry && !rows.some((row) => row.is_root || row.parent_id === null)) invariant('target parent ancestry exceeds maximum depth');
}

async function reserve(transaction: DatabaseTransaction, resourceId: string, resourceType: string): Promise<void> {
  const inserted = await transaction.insertInto('resource_id_ledger')
    .values({ resource_id: resourceId, resource_type: resourceType })
    .onConflict((conflict) => conflict.column('resource_id').doNothing())
    .returning('resource_type')
    .executeTakeFirst();
  if (inserted !== undefined) return;
  const existing = await transaction.selectFrom('resource_id_ledger')
    .select('resource_type')
    .where('resource_id', '=', resourceId)
    .executeTakeFirst();
  if (existing?.resource_type === resourceType) return;
  invariant(`resource_id_ledger already reserved ${resourceId} as ${existing?.resource_type ?? 'missing'}`);
}

async function stageRebalancedPositions(
  transaction: DatabaseTransaction,
  collectionId: string,
  parentId: string,
  resourceIds: readonly string[],
  boundaryTokens: readonly string[] = [],
): Promise<void> {
  if (resourceIds.length === 0) return;
  const affected = new Set(resourceIds);
  const rows = await transaction.selectFrom('nodes').select(['id', 'position_token'])
    .where('collection_id', '=', collectionId).where('parent_id', '=', parentId)
    .where('deleted_at', 'is', null).where('id', 'in', [...affected]).execute();
  if (rows.length !== affected.size) invariant('rebalanced resource disappeared while collection was locked');
  const occupied = new Set([
    ...rows.map((row) => row.position_token).filter((token): token is string => token !== null),
    ...boundaryTokens,
  ]);
  const nonce = randomBytes(16).toString('hex');
  for (const [index, row] of rows.entries()) {
    let suffix = index;
    let temporary = `_stage_${nonce}_${suffix}`;
    while (occupied.has(temporary)) {
      suffix += rows.length;
      temporary = `_stage_${nonce}_${suffix}`;
    }
    occupied.add(temporary);
    const result = await transaction.updateTable('nodes').set({ position_token: temporary })
      .where('collection_id', '=', collectionId).where('id', '=', row.id)
      .where('parent_id', '=', parentId).where('deleted_at', 'is', null)
      .executeTakeFirst();
    assertExactlyOneUpdated(result, `rebalance staging for node ${row.id}`);
  }
}

interface Placement {
  readonly beforeToken: string | null;
  readonly afterToken: string | null;
  readonly insertIndex: number;
}

function resolvePlacement(
  siblings: readonly { readonly id: string; readonly position_token: string | null }[],
  afterId: string | undefined,
  beforeId: string | undefined,
): Placement {
  if (siblings.some((sibling) => sibling.position_token === null)) {
    invariant('live non-root sibling has no position token');
  }
  try {
    return resolvePlacementPure(
      siblings.map((sibling) => ({ id: sibling.id, positionToken: sibling.position_token! })),
      afterId,
      beforeId,
    );
  } catch (error) {
    if (error instanceof NodeConflictError && error.code === 'position_context_stale') {
      invariant(error.message);
    }
    throw error;
  }
}

export function createPostgresCanonicalMutationPorts(
  transaction: DatabaseTransaction,
  options: PostgresCanonicalMutationPortOptions = {},
): CanonicalMutationPorts<DatabaseTransaction, PostgresCanonicalPlanFacts> {
  const deleteSubtreeLimits = resolveDeleteSubtreeLimits();
  const positionRebalanceWindow = resolvePositionRebalanceWindow(
    options.positionRebalanceWindow === undefined
      ? process.env.KNOW_N_POSITION_REBALANCE_WINDOW
      : String(options.positionRebalanceWindow),
  );
  const sidecarWrite = {
    faultInjector: options.faultInjector,
    outboxIdGenerator: options.outboxIdGenerator,
    reportSourceInvalidation: options.reportSourceInvalidation,
  };
  type PreparedWrite = CanonicalResourceWrite<PostgresCanonicalPlanFacts>;
  type PreparedEvent = CanonicalDomainEvent<PostgresCanonicalPlanFacts>;
  async function writeCollection(tx: DatabaseTransaction, write: PreparedWrite): Promise<void> {
        const nowResult = await sql<{ now: Date }>`select current_timestamp as now`.execute(tx);
        const now = nowResult.rows[0]!.now;
        const { mutation, allocation } = write;
          const current = await loadCollection(tx, mutation.target.resourceId);
          if (!current) invariant('collection disappeared while locked');
          const fields = readCollectionFields(mutation.fields!.kindFields, current);
          const updated: CollectionRow = {
            ...current, ...fields,
            published_at: (fields.visibility === 'public' || fields.visibility === 'unlisted')
              ? current.published_at ?? now
              : current.published_at,
            resource_revision: allocation.resourceRevision!,
            content_revision: allocation.contentRevision ?? current.content_revision,
            policy_revision: allocation.policyRevision ?? current.policy_revision,
            commit_ordinal: allocation.commitOrdinal, updated_at: now,
            payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION,
            payload_authority_status: 'backfilled',
          };
          const materialized = materializeCollectionPayload(collectionProjection(updated));
          const payload = assertMaterialized('collection', updated.id, materialized,
            mutation.fields?.extensions ?? existingExtensions(current.payload_json));
          const result = await tx.updateTable('collections').set({
            title: updated.title, summary: updated.summary, kind: updated.kind, visibility: updated.visibility,
            allow_search_indexing: updated.allow_search_indexing,
            publication_slug: updated.publication_slug, published_at: updated.published_at,
            resource_revision: updated.resource_revision, content_revision: updated.content_revision,
            policy_revision: updated.policy_revision, commit_ordinal: updated.commit_ordinal, updated_at: now,
            payload_json: payload as Record<string, unknown>, payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION,
            payload_authority_status: 'backfilled',
          }).where('id', '=', updated.id).executeTakeFirst();
          assertExactlyOneUpdated(result, `canonical collection write for ${updated.id}`);
          await appendRevisions(tx, updated.id, updated.id, allocation, now);
          await assertCollectionReadBack(tx, updated.id, payload, updated);
          return;
  }
  async function writeNode(tx: DatabaseTransaction, write: PreparedWrite): Promise<void> {
        const nowResult = await sql<{ now: Date }>`select current_timestamp as now`.execute(tx);
        const now = nowResult.rows[0]!.now;
        const { mutation, allocation } = write;

        const current = await loadNode(tx, mutation.target.collectionId, mutation.target.resourceId);
        if (mutation.action !== 'delete' && (allocation.rebalancedSiblings?.length ?? 0) > 0) {
          await stageRebalancedPositions(
            tx,
            mutation.target.collectionId,
            mutation.parentId!,
            [
              ...allocation.rebalancedSiblings!.map((sibling) => sibling.resourceId),
              ...(current?.parent_id === mutation.parentId ? [mutation.target.resourceId] : []),
            ],
            allocation.rebalanceBoundaryTokens ?? [],
          );
        }
        let updated: NodeRow;
        // The update branch may strip `urlHash` when an equivalent url
        // write is pinned to the stored string (see below).
        let effectiveKindFields: JsonObject | undefined;
        const extensions = mutation.fields?.extensions ?? existingExtensions(current?.payload_json ?? null);
        if (mutation.action === 'delete') {
          if (!current || !mutation.deletePlan) invariant('planned delete target disappeared');
          const deletedRevisions = allocation.deletedResourceRevisions ?? {};
          const plannedResourceIds = mutation.deletePlan.orderedResourceIds;
          const plannedRows = await sql<PlannedDeleteRow>`
            select n.*, revision_map.revision as expected_revision
            from jsonb_array_elements_text(${JSON.stringify(plannedResourceIds)}::jsonb)
              with ordinality as planned(id, ordinal)
            left join nodes n
              on n.collection_id = ${mutation.target.collectionId}
             and n.id = planned.id
            left join jsonb_each(${JSON.stringify(deletedRevisions)}::jsonb)
              as revision_map(key, revision)
              on revision_map.key = planned.id
            order by planned.ordinal
          `.execute(tx);
          if (plannedRows.rows.length !== plannedResourceIds.length) {
            invariant('planned delete resources disappeared while the collection was locked');
          }
          const validatedDeletes: Array<NodeRow & { expected_revision: string }> = [];
          for (const [index, planned] of plannedRows.rows.entries()) {
            if (planned.id === null) invariant('planned delete resources disappeared while the collection was locked');
            if (planned.id !== plannedResourceIds[index]) invariant('planned delete resource order changed while loading');
            if (planned.expected_revision === null) invariant(`delete revision is missing for ${planned.id}`);
            if (planned.deleted_at !== null || planned.is_root) {
              invariant(`planned delete resource ${planned.id} disappeared or became immutable`);
            }
            validatedDeletes.push({ ...planned, id: planned.id!, expected_revision: planned.expected_revision! });
          }
          let targetUpdated: NodeRow | undefined;
          for (let offset = 0; offset < validatedDeletes.length; offset += DELETE_SUBTREE_WRITE_BATCH_SIZE) {
            const chunk = validatedDeletes.slice(offset, offset + DELETE_SUBTREE_WRITE_BATCH_SIZE);
            const intendedDeletes = chunk.map((deleteRow) => {
              const intendedDelete: NodeRow = {
                ...deleteRow,
                resource_revision: deleteRow.expected_revision,
                updated_at: now,
                deleted_at: now,
                deleted_commit_ordinal: allocation.commitOrdinal,
                payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION,
                payload_authority_status: 'backfilled',
              };
              const deletePayload = assertMaterialized(
                'node',
                deleteRow.id,
                materializeNodePayload(nodeProjection(intendedDelete)),
                assertExistingNodeAuthority(deleteRow),
                existingNodePayloadFields(deleteRow.payload_json),
              );
              return { row: intendedDelete, payload: deletePayload, previousRevision: deleteRow.resource_revision };
            });
            if (!targetUpdated) {
              targetUpdated = intendedDeletes.find((candidate) => candidate.row.id === mutation.target.resourceId)?.row;
            }
            const updateInput = intendedDeletes.map(({ row, payload, previousRevision }) => ({
              id: row.id,
              previous_revision: previousRevision,
              resource_revision: row.resource_revision,
              payload_json: payload,
            }));
            const result = await sql<NodeRow>`
              update nodes as n
              set resource_revision = input.resource_revision,
                  updated_at = ${now},
                  deleted_at = ${now},
                  deleted_commit_ordinal = ${allocation.commitOrdinal},
                  payload_json = input.payload_json,
                  payload_schema_version = ${RESOURCE_PAYLOAD_SCHEMA_VERSION},
                  payload_authority_status = 'backfilled'
              from jsonb_to_recordset(${JSON.stringify(updateInput)}::jsonb)
                as input(id text, previous_revision text, resource_revision text, payload_json jsonb)
              where n.collection_id = ${mutation.target.collectionId}
                and n.id = input.id
                and n.resource_revision = input.previous_revision
                and n.deleted_at is null
                and not n.is_root
              returning n.*
            `.execute(tx);
            if (result.rows.length !== intendedDeletes.length) {
              invariant(`canonical subtree tombstone batch updated ${result.rows.length} rows instead of ${intendedDeletes.length}`);
            }
            const returnedById = new Map(result.rows.map((row) => [row.id, row] as const));
            for (const intended of intendedDeletes) {
              const returned = returnedById.get(intended.row.id);
              if (!returned) invariant(`canonical subtree tombstone write omitted ${intended.row.id}`);
              assertNodeWriteResult(returned, intended.payload, intended.row);
            }
            await deleteBookmarkIconsForNodeIds(tx, chunk.map((row) => row.id));
            await deleteCollectionLinkHealthForNodeIds(tx, chunk.map((row) => row.id));
            const lastIndex = offset + intendedDeletes.length - 1;
            await options.faultInjector?.afterPhase?.({
              phase: 'resource',
              resourceId: intendedDeletes[intendedDeletes.length - 1]!.row.id,
              resourceIndex: lastIndex,
              resourceCount: validatedDeletes.length,
              transaction: tx,
            });
          }
          await cascadeDeleteAnnotations(tx, {
            rows: postgresPlanFacts(write.plan).annotations,
            collectionId: mutation.target.collectionId,
            commitOrdinal: allocation.commitOrdinal,
            operationId: write.operationId,
            now,
            afterPhase: (context) => options.faultInjector?.afterPhase?.({
              phase: 'resource',
              resourceId: context.resourceId,
              resourceIndex: context.resourceIndex,
              resourceCount: context.resourceCount,
              transaction: context.transaction,
            }),
          });
          await cascadeDeleteRelations(tx, {
            rows: postgresPlanFacts(write.plan).relations,
            collectionId: mutation.target.collectionId,
            commitOrdinal: allocation.commitOrdinal,
            operationId: write.operationId,
            now,
            afterPhase: (context) => options.faultInjector?.afterPhase?.({
              phase: 'resource',
              resourceId: context.resourceId,
              resourceIndex: context.resourceIndex,
              resourceCount: context.resourceCount,
              transaction: context.transaction,
            }),
          });
          if (!targetUpdated) invariant('planned delete did not write its admitted target');
          updated = targetUpdated;
        } else if (mutation.action === 'create') {
          const values = readNodeFields(mutation.fields!.kindFields);
          if (options.resourceIdClaimOwner) {
            await options.resourceIdClaimOwner.assertClaimed(tx, mutation.target.resourceId, 'node');
          } else {
            await reserve(tx, mutation.target.resourceId, 'node');
          }
          updated = {
            id: mutation.target.resourceId, collection_id: mutation.target.collectionId,
            parent_id: mutation.parentId!, is_root: false, ...values,
            search_url_host: searchUrlHost(values.url),
            tags: values.tags.length > 0 ? values.tags : null,
            position_token: allocation.positionToken!, resource_revision: allocation.resourceRevision!,
            children_revision: allocation.createdNodeChildrenRevision!, created_at: now, updated_at: now,
            deleted_at: null, deleted_commit_ordinal: null, payload_json: null,
            payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION,
            payload_authority_status: 'backfilled',
          };
          const payload = assertMaterialized(
            'node', updated.id, materializeNodePayload(nodeProjection(updated)), extensions,
            nodePayloadFields(mutation.fields!.kindFields),
          );
          await sql`insert into nodes (
            id, collection_id, parent_id, kind, is_root, title, url, search_url_host, description, tags,
            visibility, position_token, resource_revision, children_revision, created_at,
            updated_at, deleted_at, deleted_commit_ordinal, payload_json,
            payload_schema_version, payload_authority_status
          ) values (
            ${updated.id}, ${updated.collection_id}, ${updated.parent_id}, ${updated.kind}, false,
            ${updated.title}, ${updated.url}, ${updated.search_url_host}, ${updated.description},
            ${values.tags.length > 0 ? JSON.stringify(values.tags) : null}::jsonb,
            ${updated.visibility}, ${updated.position_token}, ${updated.resource_revision},
            ${updated.children_revision}, ${now}, ${now}, null, null,
            ${JSON.stringify(payload)}::jsonb, ${RESOURCE_PAYLOAD_SCHEMA_VERSION}, 'backfilled'
          )`.execute(tx);
          await upsertPendingCollectionLinkHealth(tx, updated);
        } else {
          if (!current) invariant('node disappeared while collection was locked');
          const values = mutation.action === 'move'
            ? { kind: current.kind, title: current.title, url: current.url, description: current.description,
              tags: (current.tags ?? []) as readonly string[], visibility: current.visibility }
            : readNodeFields(mutation.fields!.kindFields, current);
          // Pin a normalization-equivalent bookmark url write to the
          // stored raw string (isEquivalentBookmarkUrlRewrite).
          const urlPinned = isEquivalentBookmarkUrlRewrite(current.url, values.url);
          const url = urlPinned ? current.url : values.url;
          effectiveKindFields = mutation.fields?.kindFields;
          if (urlPinned && effectiveKindFields && Object.hasOwn(effectiveKindFields, 'urlHash')) {
            // The submitted hash digests the unadopted spelling — drop it.
            const rest = { ...effectiveKindFields };
            delete rest.urlHash;
            effectiveKindFields = rest;
          }
          updated = {
            ...current, ...values, url,
            search_url_host: searchUrlHost(url),
            tags: values.tags.length > 0 ? values.tags : null,
            parent_id: mutation.action === 'move' || mutation.action === 'restore' ? mutation.parentId : current.parent_id,
            position_token: mutation.action === 'move' || mutation.action === 'restore' ? allocation.positionToken! : current.position_token,
            resource_revision: allocation.resourceRevision!, updated_at: now,
            deleted_at: null,
            deleted_commit_ordinal: null,
            payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION,
            payload_authority_status: 'backfilled',
          };
          const payload = assertMaterialized(
            'node', updated.id, materializeNodePayload(nodeProjection(updated)), extensions,
            nodePayloadFields(effectiveKindFields, current.payload_json),
          );
          if (mutation.action === 'restore') {
            const consumed = await tx.deleteFrom('sync_node_tombstones')
              .where('collection_id', '=', updated.collection_id).where('target_id', '=', updated.id)
              .where('delete_revision', '=', mutation.expectedResourceRevision!)
              .where('payload_purged_at', 'is', null).executeTakeFirst();
            if (consumed.numDeletedRows !== 1n) invariant('restore lost its tombstone authority');
          }
          const result = await tx.updateTable('nodes').set({
            parent_id: updated.parent_id, kind: sql<NodeRow['kind']>`${updated.kind}`,
            title: sql<string | null>`${updated.title}`, url: updated.url,
            search_url_host: updated.search_url_host,
            description: updated.description,
            tags: values.tags.length > 0
              ? sql<unknown>`${JSON.stringify(values.tags)}::jsonb`
              : null,
            visibility: updated.visibility,
            position_token: updated.position_token, resource_revision: updated.resource_revision, updated_at: now,
            deleted_at: updated.deleted_at, deleted_commit_ordinal: updated.deleted_commit_ordinal,
            payload_json: payload as Record<string, unknown>, payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION,
            payload_authority_status: 'backfilled',
          }).where('collection_id', '=', updated.collection_id).where('id', '=', updated.id).executeTakeFirst();
          assertExactlyOneUpdated(result, `canonical node write for ${updated.id}`);
          if (mutation.action !== 'move' && current.url !== updated.url) {
            await upsertPendingCollectionLinkHealth(tx, updated);
          }
        }
        for (const sibling of allocation.rebalancedSiblings ?? []) {
          const currentSibling = await loadNode(tx, mutation.target.collectionId, sibling.resourceId);
          if (!currentSibling || currentSibling.deleted_at !== null || currentSibling.parent_id !== mutation.parentId) {
            invariant('rebalanced sibling disappeared while collection was locked');
          }
          const siblingPayload = assertMaterialized('node', currentSibling.id, materializeNodePayload(nodeProjection({
            ...currentSibling,
            position_token: sibling.positionToken,
            resource_revision: sibling.resourceRevision,
            updated_at: now,
          })), existingExtensions(currentSibling.payload_json),
          existingNodePayloadFields(currentSibling.payload_json));
          const result = await tx.updateTable('nodes').set({
            position_token: sibling.positionToken,
            resource_revision: sibling.resourceRevision,
            updated_at: now,
            payload_json: siblingPayload as Record<string, unknown>,
            payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION,
            payload_authority_status: 'backfilled',
          }).where('collection_id', '=', mutation.target.collectionId).where('id', '=', sibling.resourceId).executeTakeFirst();
          assertExactlyOneUpdated(result, `canonical rebalance write for ${sibling.resourceId}`);
          await assertNodeReadBack(tx, sibling.resourceId, siblingPayload, {
            ...currentSibling,
            position_token: sibling.positionToken,
            resource_revision: sibling.resourceRevision,
            updated_at: now,
            payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION,
            payload_authority_status: 'backfilled',
          });
        }
        for (const [parentId, revision] of Object.entries(allocation.childrenRevisions)) {
          const parent = await loadNode(tx, mutation.target.collectionId, parentId);
          if (!parent || parent.deleted_at !== null) invariant('parent disappeared while collection was locked');
          const intendedParent: NodeRow = {
            ...parent,
            children_revision: revision,
            updated_at: now,
            payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION,
            payload_authority_status: 'backfilled',
          };
          const parentPayload = assertMaterialized('node', parent.id,
            materializeNodePayload(nodeProjection(intendedParent)), existingExtensions(parent.payload_json),
            existingNodePayloadFields(parent.payload_json));
          const result = await tx.updateTable('nodes').set({
            children_revision: revision,
            updated_at: now,
            payload_json: parentPayload as Record<string, unknown>,
            payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION,
            payload_authority_status: 'backfilled',
          })
            .where('collection_id', '=', mutation.target.collectionId).where('id', '=', parent.id)
            .where('deleted_at', 'is', null).executeTakeFirst();
          assertExactlyOneUpdated(result, `canonical parent revision write for ${parent.id}`);
          await assertNodeReadBack(tx, parent.id, parentPayload, intendedParent);
        }
        const collection = await loadCollection(tx, mutation.target.collectionId);
        if (!collection) invariant('collection disappeared while locked');
        const intendedCollection: CollectionRow = {
          ...collection,
          content_revision: allocation.contentRevision!,
          policy_revision: allocation.policyRevision ?? collection.policy_revision,
          commit_ordinal: allocation.commitOrdinal,
          updated_at: now,
          payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION,
          payload_authority_status: 'backfilled',
        };
        const collectionPayload = assertMaterialized('collection', collection.id,
          materializeCollectionPayload(collectionProjection(intendedCollection)), existingExtensions(collection.payload_json));
        const collectionUpdate = await tx.updateTable('collections').set({
          content_revision: intendedCollection.content_revision,
          policy_revision: intendedCollection.policy_revision,
          commit_ordinal: intendedCollection.commit_ordinal,
          updated_at: now,
          payload_json: collectionPayload as Record<string, unknown>,
          payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION,
          payload_authority_status: 'backfilled',
        })
          .where('id', '=', collection.id).executeTakeFirst();
        assertExactlyOneUpdated(collectionUpdate, `canonical collection evidence write for ${collection.id}`);
        await assertCollectionReadBack(tx, collection.id, collectionPayload, intendedCollection);
        const expected = assertMaterialized(
          'node', updated.id, materializeNodePayload(nodeProjection(updated)), extensions,
          mutation.action === 'create'
            ? nodePayloadFields(mutation.fields!.kindFields)
            : nodePayloadFields(effectiveKindFields ?? mutation.fields?.kindFields, current?.payload_json),
        );
        await assertNodeReadBack(tx, updated.id, expected, updated);
        if (!mutation.deletePlan) {
          await options.faultInjector?.afterPhase?.({ phase: 'resource', resourceId: updated.id });
        }
        if (mutation.deletePlan) {
          const deletedRevisions = allocation.deletedResourceRevisions ?? {};
          const revisionRows = mutation.deletePlan.orderedResourceIds.map((resourceId) => {
            const revision = deletedRevisions[resourceId];
            if (!revision) invariant(`delete revision is missing for ${resourceId}`);
            return { resource_id: resourceId, revision };
          });
          for (let offset = 0; offset < revisionRows.length; offset += DELETE_SUBTREE_WRITE_BATCH_SIZE) {
            const batch = revisionRows.slice(offset, offset + DELETE_SUBTREE_WRITE_BATCH_SIZE);
            const inserted = await sql<{ resource_id: string }>`
              insert into resource_revisions(collection_id, resource_id, revision, ordinal, created_at)
              select ${mutation.target.collectionId}, input.resource_id, input.revision,
                ${allocation.commitOrdinal}, ${now}
              from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
                as input(resource_id text, revision text)
              returning resource_id
            `.execute(tx);
            if (inserted.rows.length !== batch.length) {
              invariant(`canonical subtree revision batch inserted ${inserted.rows.length} rows instead of ${batch.length}`);
            }
          }
          const sidecars = postgresPlanFacts(write.plan).annotations;
          if (sidecars.length > 0) {
            await tx.insertInto('resource_revisions').values(sidecars.map((sidecar) => ({
              collection_id: mutation.target.collectionId,
              resource_id: sidecar.id,
              revision: sidecar.revision!,
              ordinal: allocation.commitOrdinal,
              created_at: now,
            }))).execute();
          }
          const relationSidecars = postgresPlanFacts(write.plan).relations;
          if (relationSidecars.length > 0) {
            await tx.insertInto('resource_revisions').values(relationSidecars.map((relation) => ({
              collection_id: mutation.target.collectionId, resource_id: relation.id,
              revision: relation.revision!, ordinal: allocation.commitOrdinal, created_at: now,
            }))).execute();
          }
        }
        for (const sibling of allocation.rebalancedSiblings ?? []) {
          await tx.insertInto('resource_revisions').values({
            collection_id: mutation.target.collectionId,
            resource_id: sibling.resourceId,
            revision: sibling.resourceRevision,
            ordinal: allocation.commitOrdinal,
            created_at: now,
          }).execute();
        }
        await appendRevisions(
          tx,
          mutation.target.collectionId,
          mutation.target.resourceId,
          allocation,
          now,
          mutation.action === 'create' && updated.kind === 'folder',
          mutation.action === 'delete',
        );
        const historyRevisions = new Map<string, string>();
        if (allocation.resourceRevision) {
          historyRevisions.set(mutation.target.resourceId, allocation.resourceRevision);
        }
        for (const [resourceId, revision] of Object.entries(allocation.deletedResourceRevisions ?? {})) {
          historyRevisions.set(resourceId, revision);
        }
        for (const sibling of allocation.rebalancedSiblings ?? []) {
          historyRevisions.set(sibling.resourceId, sibling.resourceRevision);
        }
        if (historyRevisions.size > 0) {
          const historyRows = await tx.selectFrom('nodes').select([
            'id', 'collection_id', 'kind', 'resource_revision', 'payload_json',
          ]).where('collection_id', '=', mutation.target.collectionId)
            .where('id', 'in', [...historyRevisions.keys()]).execute();
          if (historyRows.length !== historyRevisions.size) {
            invariant('canonical Node revision history read-back is incomplete', true);
          }
          const historyValues = historyRows.map((row) => {
            const revision = historyRevisions.get(row.id);
            if (!revision || row.resource_revision !== revision || !row.payload_json
                || row.payload_json.resourceRevision !== revision
                || row.payload_json.collectionId !== row.collection_id
                || row.payload_json.id !== row.id
                || row.payload_json.kind !== row.kind) {
              invariant(`canonical Node revision history authority mismatch for ${row.id}`, true);
            }
            return {
              collection_id: row.collection_id,
              resource_id: row.id,
              revision,
              kind: row.kind,
              payload_json: row.payload_json,
              commit_ordinal: allocation.commitOrdinal,
              operation_id: write.operationId,
              recorded_at: now,
            };
          });
          for (let offset = 0; offset < historyValues.length;
            offset += DELETE_SUBTREE_WRITE_BATCH_SIZE) {
            await tx.insertInto('sync_node_revision_history')
              .values(historyValues.slice(offset, offset + DELETE_SUBTREE_WRITE_BATCH_SIZE))
              .execute();
          }
        }
        await options.faultInjector?.afterPhase?.({ phase: 'revision' });
  }
  const writeSidecar = (tx: DatabaseTransaction, write: PreparedWrite) => applySidecarCanonicalMutation(tx, write, sidecarWrite);
  const writers = { collection: writeCollection, node: writeNode, annotation: writeSidecar, relation: writeSidecar } satisfies Record<ResourceKind, (tx: DatabaseTransaction, write: PreparedWrite) => Promise<void>>;
  async function appendNodeOrCollectionEvent(tx: DatabaseTransaction, event: PreparedEvent): Promise<void> {
          const routed = await routeCanonicalDomainEvent(tx, event);
          await reserve(tx, event.domainEventId, 'domain-event');
          const outboxId = (options.outboxIdGenerator ?? generateOutboxId)();
          await reserve(tx, outboxId, 'outbox');
          await tx.insertInto('outbox_events').values({
            outbox_id: outboxId, domain_event_id: event.domainEventId,
            event_type: routed.eventType, event_version: routed.eventVersion,
            handler_name: routed.handlerName, handler_mode: 'projection_latest_only',
            aggregate_scope: event.collectionId, aggregate_revision: routed.aggregateRevision,
            commit_ordinal: event.commitOrdinal, payload_json: routed.payload as Record<string, unknown>,
            state: 'pending', attempt_count: 0, available_at: sql<Date>`current_timestamp`,
            locked_until: null, lease_generation: 0n, completed_at: null, last_error: null,
            aggregate_type: event.aggregateType, aggregate_id: event.aggregateId,
            occurred_at: sql<Date>`current_timestamp`, dead_lettered_at: null,
          }).execute();
          await appendCanonicalSecondaryOutbox(tx,event,routed,options);
          if (routed.publicationPurge) {
            const purgeOutboxId = (options.outboxIdGenerator ?? generateOutboxId)();
            await reserve(tx, purgeOutboxId, 'outbox');
            await tx.insertInto('outbox_events').values({
              outbox_id: purgeOutboxId,
              domain_event_id: event.domainEventId,
              event_type: PUBLICATION_CACHE_PURGE_EVENT_TYPE,
              event_version: PUBLICATION_CACHE_PURGE_EVENT_VERSION,
              handler_name: PUBLICATION_CACHE_PURGE_HANDLER_NAME,
              handler_mode: 'delivery_each_event',
              aggregate_scope: event.collectionId,
              aggregate_revision: routed.publicationPurge.contentRevision,
              commit_ordinal: event.commitOrdinal,
              payload_json: {
                collectionId: event.collectionId,
                contentRevision: routed.publicationPurge.contentRevision,
                policyRevision: routed.publicationPurge.policyRevision,
                publicationSlug: routed.publicationPurge.publicationSlug,
                sourceEventType: routed.eventType,
                sourceEventVersion: routed.eventVersion,
                visibility: routed.publicationPurge.visibility,
              },
              state: 'pending',
              attempt_count: 0,
              available_at: sql<Date>`current_timestamp`,
              locked_until: null,
              lease_generation: 0n,
              completed_at: null,
              last_error: null,
              aggregate_type: 'collection',
              aggregate_id: event.collectionId,
              occurred_at: sql<Date>`current_timestamp`,
              dead_lettered_at: null,
            }).execute();
          }
          for (const sidecar of postgresPlanFacts(event.plan).annotations) {
            if (!sidecar.revision || !sidecar.deletedAt || !routed.aggregateRevision) {
              invariant('cascade Annotation event facts are incomplete');
            }
            const payload = {
              affectedCount: 1,
              annotationId: sidecar.id,
              collectionId: sidecar.collection_id,
              contentRevision: routed.aggregateRevision,
              deletedAt: formatUtcDateTime(sidecar.deletedAt),
              deleteRevision: sidecar.revision,
              operationId: event.operationId,
              subjectId: sidecar.subject_id,
              subjectType: sidecar.subject_type,
              visibility: sidecar.visibility,
            };
            assertAnnotationDeletedPayload(payload);
            const domainEventId = generateOutboxId();
            const annotationOutboxId = (options.outboxIdGenerator ?? generateOutboxId)();
            await reserve(tx, domainEventId, 'domain-event');
            await reserve(tx, annotationOutboxId, 'outbox');
            await tx.insertInto('outbox_events').values({
              outbox_id: annotationOutboxId,
              domain_event_id: domainEventId,
              event_type: ANNOTATION_DELETED_EVENT_TYPE,
              event_version: ANNOTATION_DELETED_EVENT_VERSION,
              handler_name: ANNOTATION_DELETED_HANDLER_NAME,
              handler_mode: 'projection_latest_only',
              aggregate_scope: event.collectionId,
              aggregate_revision: sidecar.revision,
              commit_ordinal: event.commitOrdinal,
              payload_json: payload,
              state: 'pending', attempt_count: 0, available_at: sql<Date>`current_timestamp`,
              locked_until: null, lease_generation: 0n, completed_at: null, last_error: null,
              aggregate_type: 'annotation', aggregate_id: sidecar.id,
              occurred_at: sql<Date>`current_timestamp`, dead_lettered_at: null,
            }).execute();
          }
          for (const relation of postgresPlanFacts(event.plan).relations) {
            if (!relation.revision || !relation.deletedAt || !routed.aggregateRevision) {
              invariant('cascade Relation event facts are incomplete');
            }
            const payload = { affectedCount: 1, relationId: relation.id,
              collectionId: relation.collection_id, contentRevision: routed.aggregateRevision,
              deletedAt: formatUtcDateTime(relation.deletedAt), deleteRevision: relation.revision,
              operationId: event.operationId, fromNodeId: relation.from_node_id,
              toNodeId: relation.to_node_id, visibility: relation.visibility };
            const domainEventId = generateOutboxId();
            const relationOutboxId = (options.outboxIdGenerator ?? generateOutboxId)();
            await reserve(tx, domainEventId, 'domain-event');
            await reserve(tx, relationOutboxId, 'outbox');
            await tx.insertInto('outbox_events').values({ outbox_id: relationOutboxId,
              domain_event_id: domainEventId, event_type: RELATION_DELETED_EVENT_TYPE,
              event_version: RELATION_DELETED_EVENT_VERSION, handler_name: RELATION_DELETED_HANDLER_NAME,
              handler_mode: 'projection_latest_only', aggregate_scope: event.collectionId,
              aggregate_revision: relation.revision, commit_ordinal: event.commitOrdinal,
              payload_json: payload, state: 'pending', attempt_count: 0,
              available_at: sql<Date>`current_timestamp`, locked_until: null, lease_generation: 0n,
              completed_at: null, last_error: null, aggregate_type: 'relation', aggregate_id: relation.id,
              occurred_at: sql<Date>`current_timestamp`, dead_lettered_at: null,
            }).execute();
          }
  }
  const appendSidecarEvent = (tx: DatabaseTransaction, event: PreparedEvent) => {
    const facts = postgresPlanFacts(event.plan);
    return appendSidecarDomainEvent(tx, event, { ...sidecarWrite, updateFacts: 'updateFacts' in facts ? facts.updateFacts : undefined });
  };
  const eventWriters = { collection: appendNodeOrCollectionEvent, node: appendNodeOrCollectionEvent, annotation: appendSidecarEvent, relation: appendSidecarEvent } satisfies Record<ResourceKind, (tx: DatabaseTransaction, event: PreparedEvent) => Promise<void>>;
  const ports: CanonicalMutationPorts<DatabaseTransaction, PostgresCanonicalPlanFacts> = {
    collectionLock: {
      async lockForCanonicalMutation(tx, collectionId): Promise<LockedCollectionState | null> {
        if (tx !== transaction) invariant('canonical adapter received a foreign transaction');
        // T-10 lock order (ADR-0027): the "device must resynchronise" update in
        // the operations port below mutates sync_replicas after the node write.
        // Take those replica row locks first so this transaction never holds
        // collections while waiting on sync_replicas, which is the exact
        // inverse of the Sync Push/Pull/Ack authority prefix.
        if (options.invalidateSyncReplicasOnNodeMutation) {
          await lockActiveSyncReplicasForCollection(tx, collectionId);
        }
        const row = await loadCollection(tx, collectionId, true);
        if (!row || row.deleted_at !== null) return null;
        assertExistingCollectionAuthority(row);
        return {
          collectionId: row.id,
          currentCommitOrdinal: BigInt(row.commit_ordinal),
          resourceRevision: row.resource_revision,
          contentRevision: row.content_revision,
          policyRevision: row.policy_revision,
        };
      },
    },
    planner: {
      async planCanonicalMutation(tx, input, locked): Promise<CanonicalMutationPlan<PostgresCanonicalPlanFacts>> {
        const kind = resourceKind(input);
        if (kind === 'annotation' || kind === 'relation') {
          const plan = await planSidecarCanonicalMutation(tx, input);
          const action = plan.mutation.action;
          if (action === 'move' || action === 'restore') invariant('sidecars cannot move or restore');
          const trusted = plan.mutation.trustedFacts;
          const updateFacts = action === 'update' ? {
            previousVisibility: trusted?.previousVisibility as SidecarUpdateFacts['previousVisibility'],
            publicRepresentationChanged: trusted?.publicRepresentationChanged === true,
          } : undefined;
          return { ...plan, facts: Object.freeze({ resourceKind: kind, action, annotations: [], relations: [], updateFacts }) };
        }
        const expected = input.mutation.expectedResourceRevision;
        if (kind === 'collection') {
          const row = await loadCollection(tx, input.collectionId);
          if (!row || row.id !== input.mutation.target.resourceId) invariant('collection mutation target is missing');
          if (input.mutation.action !== 'update') {
            invariant(`collection ${input.mutation.action} is not supported by the locked-collection adapter`);
          }
          if (expected && expected !== row.resource_revision) invariant('resource revision conflict');
          const fields = readCollectionFields(input.mutation.fields!.kindFields, row);
          const content = fields.title !== row.title || fields.summary !== row.summary;
          const policy = fields.visibility !== row.visibility
            || fields.allow_search_indexing !== row.allow_search_indexing;
          return {
            facts: Object.freeze({ resourceKind: 'collection', action: 'update', annotations: [], relations: [] }),
            operationId: input.operationId,
            collectionId: input.collectionId,
            mutation: {
              ...input.mutation,
              parentId: null,
              fields: {
                kindFields: input.mutation.fields!.kindFields,
                extensions: input.mutation.trustedFacts?.replaceExtensions === true
                  ? input.mutation.fields!.extensions
                  : existingExtensions(row.payload_json),
              },
              revisionEffects: { resource: true, content, policy, childrenOf: [] },
            },
          };
        }

        let annotations: readonly CascadedAnnotationPlan[] = [];
        let relations: readonly CascadedRelationPlan[] = [];
        const current = await loadNode(tx, input.collectionId, input.mutation.target.resourceId);
        let currentExtensions: JsonObject | undefined;
        if (input.mutation.action === 'create') {
          if (current) invariant('node already exists');
          if (input.mutation.parentId === null) invariant('non-root node requires a parent');
          readNodeFields(input.mutation.fields!.kindFields);
        } else {
          if (!current || current.is_root || (input.mutation.action === 'restore' ? current.deleted_at === null : current.deleted_at !== null)) invariant('node mutation target is missing or immutable');
          currentExtensions = assertExistingNodeAuthority(current);
          if (expected && expected !== current.resource_revision) invariant('resource revision conflict');
          if (input.mutation.action !== 'delete' && input.mutation.action !== 'move') {
            readNodeFields(input.mutation.fields!.kindFields, current);
          }
        }
        let consumedDeleteOperationId: string | undefined;
        let restoredPositionToken: string | undefined;
        if (input.mutation.action === 'restore') {
          const tombstone = await tx.selectFrom('sync_node_tombstones').selectAll()
            .where('collection_id', '=', input.collectionId).where('target_id', '=', current!.id)
            .forUpdate().executeTakeFirst();
          if (!tombstone || tombstone.payload_purged_at !== null || tombstone.delete_revision !== expected) {
            invariant('restore requires its exact unpurged deletion authority');
          }
          consumedDeleteOperationId = tombstone.operation_id;
          const token = input.mutation.trustedFacts?.restorePositionToken;
          if (typeof token !== 'string') invariant('restore placement is missing');
          restoredPositionToken = token;
        }
        const targetParent = input.mutation.parentId;
        const children = new Set<string>();
        if ((input.mutation.action === 'create' || input.mutation.action === 'restore') && targetParent) {
          await validateNodeParent(tx, input.collectionId, input.mutation.target.resourceId, targetParent, false);
          children.add(targetParent);
        }
        if (input.mutation.action === 'move') {
          if (!targetParent) invariant('move requires a target parent');
          await validateNodeParent(tx, input.collectionId, input.mutation.target.resourceId, targetParent, true);
          if (current?.parent_id) children.add(current.parent_id);
          children.add(targetParent);
        }
        let deletePlan: { readonly orderedResourceIds: readonly string[] } | undefined;
        if (input.mutation.action === 'delete') {
          if (!input.mutation.deleteIntent) invariant('delete intent is missing');
          if (
            input.mutation.deleteIntent.expectedContentRevision
            && input.mutation.deleteIntent.expectedContentRevision !== locked.contentRevision
          ) invariant('content revision conflict');
          const deleteRows = await planLiveDeleteSet(
            tx,
            input.collectionId,
            current!,
            input.mutation.deleteIntent.scope,
            deleteSubtreeLimits,
          );
          for (const deleteRow of deleteRows) assertExistingNodeAuthority(deleteRow);
          deletePlan = { orderedResourceIds: deleteRows.map((row) => row.id) };
          const sidecars = await tx.selectFrom('annotations').select([
            'id', 'collection_id', 'subject_type', 'subject_id', 'visibility',
            'resource_revision', 'payload_json', sql<Date>`current_timestamp`.as('planned_deleted_at'),
          ]).where('collection_id', '=', input.collectionId)
            .where('subject_type', '=', 'node')
            .where('subject_id', 'in', deleteRows.map((row) => row.id))
            .where('deleted_at', 'is', null)
            .orderBy('id').forUpdate().execute() as CascadedAnnotationRow[];
          for (const sidecar of sidecars) assertCascadedAnnotationAuthority(sidecar);
          const timestamp = (sidecars[0] as (CascadedAnnotationRow & { planned_deleted_at: Date }) | undefined)?.planned_deleted_at ?? new Date();
          annotations = Object.freeze(sidecars.map(row => Object.freeze({ ...row, revision: generateRevisionToken(), deletedAt: timestamp })));
          const relationSidecars = await tx.selectFrom('relations').select([
            'id', 'collection_id', 'from_node_id', 'to_node_id', 'visibility',
            'resource_revision', 'payload_json', sql<Date>`current_timestamp`.as('planned_deleted_at'),
          ]).where('collection_id', '=', input.collectionId)
            .where((expression) => expression.or([
              expression('from_node_id', 'in', deleteRows.map((row) => row.id)),
              expression('to_node_id', 'in', deleteRows.map((row) => row.id)),
            ]))
            .where('deleted_at', 'is', null).orderBy('id').forUpdate().execute() as CascadedRelationRow[];
          for (const relation of relationSidecars) assertCascadedRelationAuthority(relation);
          relations = Object.freeze(relationSidecars.map(row => Object.freeze({ ...row, revision: generateRevisionToken(), deletedAt: (row as CascadedRelationRow & { planned_deleted_at: Date }).planned_deleted_at })));
          if (current?.parent_id) children.add(current.parent_id);
        }
        for (const parentId of children) {
          const parent = await loadNode(tx, input.collectionId, parentId);
          if (!parent || parent.deleted_at !== null || parent.kind !== 'folder') {
            invariant(`affected parent ${parentId} is missing or invalid`);
          }
          assertExistingNodeAuthority(parent);
        }
        const visibility = input.mutation.action === 'restore' ? current!.visibility : input.mutation.fields?.kindFields.visibility;
        const policy = input.mutation.action === 'create' || input.mutation.action === 'restore'
          ? visibility !== 'inherit'
          : input.mutation.action === 'update'
            ? visibility !== undefined && visibility !== current!.visibility
            : false;
        const authoritativeFields = input.mutation.action === 'move' || input.mutation.action === 'restore'
          ? {
            fields: {
              kindFields: {
                kind: current!.kind,
                title: current!.title,
                url: current!.url,
                description: current!.description,
                tags: (current!.tags ?? []) as readonly string[],
                visibility: current!.visibility,
              },
              extensions: currentExtensions!,
            },
          }
          : input.mutation.action === 'update'
            ? {
              fields: {
                kindFields: input.mutation.fields!.kindFields,
                extensions: input.mutation.trustedFacts?.replaceExtensions === true
                  ? input.mutation.fields!.extensions
                  : currentExtensions!,
              },
            }
          : input.mutation.action === 'delete'
            ? { fields: undefined }
          : {};
        return {
          facts: Object.freeze({ resourceKind: 'node', action: input.mutation.action, annotations, relations, restoredPositionToken, consumedDeleteOperationId }),
          operationId: input.operationId,
          collectionId: input.collectionId,
          mutation: {
            ...input.mutation,
            ...(
              input.mutation.action === 'update' || input.mutation.action === 'delete'
                ? { parentId: current!.parent_id }
                : {}
            ),
            ...authoritativeFields,
            ...(deletePlan ? { deletePlan } : {}),
            revisionEffects: { resource: true, content: true, policy, childrenOf: [...children] },
          },
        };
      },
    },
    allocator: {
      async allocate(tx, request) {
        const effects = request.mutation.revisionEffects;
        const childrenRevisions = Object.fromEntries(effects.childrenOf.map((id) => [id, generateRevisionToken()]));
        const resourceRevision = effects.resource ? generateRevisionToken() : undefined;
        const facts = postgresPlanFacts(request.plan);
        let positionToken: string | undefined = facts.resourceKind === 'node' ? facts.restoredPositionToken : undefined;
        let rebalancedSiblings: Array<{ resourceId: string; positionToken: string; resourceRevision: string }> = [];
        let rebalanceBoundaryTokens: string[] = [];
        if ((request.mutation.action === 'create' || request.mutation.action === 'move') && request.mutation.parentId) {
          const placementRequest = {
            collectionId: request.collection.collectionId,
            parentId: request.mutation.parentId,
            excludeNodeId: request.mutation.action === 'move' ? request.mutation.target.resourceId : undefined,
            afterId: request.mutation.relativePosition?.afterId,
            beforeId: request.mutation.relativePosition?.beforeId,
            forUpdate: true,
          };
          const bounded = options.preresolvedPlacement
            ? (() => {
              const placement = resolvePlacementPure(
                options.preresolvedPlacement.siblings.map((sibling) => ({
                  id: sibling.id,
                  positionToken: sibling.positionToken,
                })),
                placementRequest.afterId,
                placementRequest.beforeId,
              );
              return {
                siblings: options.preresolvedPlacement.siblings,
                placement,
                insertIndex: placement.insertIndex,
              };
            })()
            : await readBoundedPlacementContext(tx, placementRequest);
          const placement = bounded.placement;
          const collisionTokens = bounded.siblings.map((row) => row.positionToken);
          try {
            positionToken = allocatePosition(
              placement.beforeToken,
              placement.afterToken,
              collisionTokens,
            );
          } catch (error: unknown) {
            if (!(error instanceof CollectionsError) || error.code !== 'invalid_node_anchor') throw error;
            try {
              const window = await readRebalanceWindowSiblings(tx, {
                collectionId: request.collection.collectionId,
                parentId: request.mutation.parentId,
                excludeNodeId: placementRequest.excludeNodeId,
                placement,
                afterId: placementRequest.afterId,
                beforeId: placementRequest.beforeId,
                windowSize: positionRebalanceWindow,
                forUpdate: true,
              });
              rebalanceBoundaryTokens = [
                ...(window.outsideLowerBoundToken ? [window.outsideLowerBoundToken] : []),
                ...(window.outsideUpperBoundToken ? [window.outsideUpperBoundToken] : []),
              ];
              const plan = planBoundedPositionRebalance({
                siblings: window.windowSiblings,
                targetId: request.mutation.target.resourceId,
                insertIndex: window.insertIndex,
                windowSize: positionRebalanceWindow,
                ...(window.outsideLowerBoundToken === null
                  ? {}
                  : { outsideLowerBoundToken: window.outsideLowerBoundToken }),
                ...(window.outsideUpperBoundToken === null
                  ? {}
                  : { outsideUpperBoundToken: window.outsideUpperBoundToken }),
              });
              rebalancedSiblings = plan.siblingAssignments.map((assignment) => ({
                resourceId: assignment.resourceId,
                positionToken: assignment.positionToken,
                resourceRevision: generateRevisionToken(),
              }));
              positionToken = plan.targetPositionToken;
            } catch (rebalanceError: unknown) {
              if (rebalanceError instanceof PositionRebalanceEscalationError) {
                options.metrics?.increment('position.rebalance.escalation_total');
              }
              throw rebalanceError;
            }
          }
        }
        return {
          commitOrdinal: request.collection.currentCommitOrdinal + 1n,
          ...(resourceRevision ? { resourceRevision } : {}),
          ...(request.mutation.action === 'create' && request.mutation.target.resourceKind === 'node'
            ? { createdNodeChildrenRevision: generateRevisionToken() }
            : {}),
          ...(effects.content ? { contentRevision: generateRevisionToken() } : {}),
          ...(effects.policy ? { policyRevision: generateRevisionToken() } : {}),
          childrenRevisions,
          rebalanceBoundaryTokens,
          ...(positionToken ? { positionToken } : {}),
          ...(rebalancedSiblings.length > 0 ? { rebalancedSiblings } : {}),
          ...(request.mutation.deletePlan ? {
            deletedResourceRevisions: Object.fromEntries(
              request.mutation.deletePlan.orderedResourceIds.map((id) => [
                id,
                id === request.mutation.target.resourceId ? resourceRevision! : generateRevisionToken(),
              ]),
            ),
          } : {}),
        };
      },
    },
    resources: {
      applyCanonicalMutation(tx, write) {
        return writers[postgresPlanFacts(write.plan).resourceKind](tx, write);
      },
    },
    operations: {
      async appendCanonicalOperation(tx, record) {
        const affectedAnnotationIds = (postgresPlanFacts(record.plan).annotations).map((row) => row.id),
          affectedRelationIds = (postgresPlanFacts(record.plan).relations).map((row) => row.id);
        if (options.operationIdClaimOwner) {
          await options.operationIdClaimOwner.assertClaimed(tx, record.operationId);
        } else {
          await reserve(tx, record.operationId, 'operation');
        }
        await appendOperationWithPayload(tx, {
          operationId: record.operationId, collectionId: record.collectionId,
          commitOrdinal: record.commitOrdinal, operationType: record.operationType,
          payloadJson: {
            ...record.canonicalPayload,
            ...(affectedAnnotationIds.length > 0 ? { affectedAnnotationIds } : {}),
            ...(affectedRelationIds.length > 0 ? { affectedRelationIds } : {}),
          } as Record<string, unknown>,
          syncWireJson: record.syncWire ?? null,
          actorPrincipalId: record.actorPrincipalId,
        });
        const planned = postgresPlanFacts(record.plan);
        if (planned.resourceKind === 'node' && planned.action === 'restore') {
          await sql`INSERT INTO sync_restored_tombstones
            (collection_id, operation_id, target_id, restore_operation_id)
            VALUES (${record.collectionId}, ${planned.consumedDeleteOperationId!}, ${record.target.resourceId}, ${record.operationId})`.execute(tx);
        }
        if (options.invalidateSyncReplicasOnNodeMutation && record.target.resourceKind === 'node') {
          await tx.updateTable('sync_replicas').set({
            status: 'recovery_required',
            lifecycle_revision: sql<bigint>`lifecycle_revision + 1`,
            wire_json: sql<Record<string, unknown>>`jsonb_set(
              wire_json, '{status}', '"recovery_required"'::jsonb, true
            )`,
          }).where('collection_id', '=', record.collectionId)
            .where('status', '=', 'active').execute();
        }
        await options.faultInjector?.afterPhase?.({
          phase: 'operation',
          resourceId: record.target.resourceId,
        });
      },
    },
    audit: {
      async appendAuditEvent(tx, record) {
        const affectedAnnotationIds = (postgresPlanFacts(record.plan).annotations).map((row) => row.id);
        const affectedRelationIds = (postgresPlanFacts(record.plan).relations).map((row) => row.id);
        await appendAuditEvent(tx, {
          operationId: record.operationId, collectionId: record.collectionId,
          principalId: record.principalId, eventType: record.eventType, details: { ...record.details,
            ...(affectedAnnotationIds.length > 0 ? { affectedAnnotationIds } : {}),
            ...(affectedRelationIds.length > 0 ? { affectedRelationIds } : {}),
          } as Record<string, unknown>,
        });
        await options.faultInjector?.afterPhase?.({ phase: 'audit' });
      },
    },
    outbox: {
      async appendDomainEvents(tx, events) {
        for (const event of events) await eventWriters[postgresPlanFacts(event.plan).resourceKind](tx, event);
        await options.faultInjector?.afterPhase?.({ phase: 'outbox' });
      },
    },
  };
  return { ...ports, resources: {
    applyCanonicalMutation: (tx, write) => write.mutation.action === 'delete'
      ? ports.resources.applyCanonicalMutation(tx, write)
      : (options.treeCapacityAdmission?.execute ?? withCanonicalTreeCapacity)(tx, write.mutation.target.collectionId, () => ports.resources.applyCanonicalMutation(tx, write)),
  } };

}

async function appendRevisions(
  tx: DatabaseTransaction,
  collectionId: string,
  resourceId: string,
  allocation: { resourceRevision?: string; createdNodeChildrenRevision?: string; contentRevision?: string; policyRevision?: string; childrenRevisions: Readonly<Record<string, string>>; commitOrdinal: bigint },
  now: Date,
  recordCreatedNodeChildrenRevision = false,
  skipResourceRevision = false,
): Promise<void> {
  if (allocation.resourceRevision && !skipResourceRevision) await tx.insertInto('resource_revisions').values({
    collection_id: collectionId, resource_id: resourceId, revision: allocation.resourceRevision,
    ordinal: allocation.commitOrdinal, created_at: now,
  }).execute();
  if (allocation.contentRevision) await tx.insertInto('content_revisions').values({
    collection_id: collectionId, revision: allocation.contentRevision, ordinal: allocation.commitOrdinal, created_at: now,
  }).execute();
  if (allocation.policyRevision) await tx.insertInto('policy_revisions').values({
    collection_id: collectionId, revision: allocation.policyRevision, ordinal: allocation.commitOrdinal, created_at: now,
  }).execute();
  if (recordCreatedNodeChildrenRevision && allocation.createdNodeChildrenRevision) await tx.insertInto('children_revisions').values({
    collection_id: collectionId, parent_id: resourceId,
    revision: allocation.createdNodeChildrenRevision, ordinal: allocation.commitOrdinal,
  }).execute();
  for (const [parentId, revision] of Object.entries(allocation.childrenRevisions)) {
    await tx.insertInto('children_revisions').values({
      collection_id: collectionId, parent_id: parentId, revision, ordinal: allocation.commitOrdinal,
    }).execute();
  }
}

async function assertCollectionReadBack(
  tx: DatabaseTransaction,
  id: string,
  expected: JsonObject,
  intended: CollectionRow,
): Promise<void> {
  const row = await loadCollection(tx, id);
  if (!row) invariant('collection read-back failed', true);
  assertAuthoritativeFields('collection', row, intended, COLLECTION_AUTHORITY_FIELDS);
  const comparison = compareResourcePayload({ resourceType: 'collection', resourceId: id, expected, actual: row.payload_json });
  if (!comparison.equal) invariant(`collection authority read-back mismatch at ${comparison.mismatches[0]?.path ?? '$'}`, true);
}

async function assertNodeReadBack(
  tx: DatabaseTransaction,
  id: string,
  expected: JsonObject,
  intended: NodeRow,
): Promise<void> {
  const row = await tx.selectFrom('nodes').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) invariant('node read-back failed', true);
  assertNodeWriteResult(row as NodeRow, expected, intended);
}

function assertNodeWriteResult(row: NodeRow, expected: JsonObject, intended: NodeRow): void {
  assertAuthoritativeFields('node', row, intended, NODE_AUTHORITY_FIELDS);
  const comparison = compareResourcePayload({
    resourceType: 'node',
    resourceId: intended.id,
    expected,
    actual: row.payload_json,
  });
  if (!comparison.equal) invariant(`node authority read-back mismatch at ${comparison.mismatches[0]?.path ?? '$'}`, true);
}

const COLLECTION_AUTHORITY_FIELDS = [
  'id', 'owner_subject_id', 'title', 'summary', 'kind', 'visibility', 'allow_search_indexing', 'root_node_id',
  'resource_revision', 'content_revision', 'policy_revision', 'commit_ordinal',
  'created_at', 'updated_at', 'deleted_at', 'payload_schema_version', 'payload_authority_status',
] as const satisfies readonly (keyof CollectionRow)[];

const NODE_AUTHORITY_FIELDS = [
  'id', 'collection_id', 'parent_id', 'kind', 'is_root', 'title', 'url', 'search_url_host', 'description', 'tags',
  'visibility', 'position_token', 'resource_revision', 'children_revision', 'created_at',
  'updated_at', 'deleted_at', 'deleted_commit_ordinal', 'payload_schema_version',
  'payload_authority_status',
] as const satisfies readonly (keyof NodeRow)[];

function authorityValuesEqual(actual: unknown, intended: unknown): boolean {
  if (actual instanceof Date || intended instanceof Date) {
    return actual instanceof Date && intended instanceof Date && actual.getTime() === intended.getTime();
  }
  if (typeof actual === 'bigint' || typeof intended === 'bigint') {
    return actual !== null && intended !== null && BigInt(actual as bigint) === BigInt(intended as bigint);
  }
  if (typeof actual === 'object' || typeof intended === 'object') {
    return JSON.stringify(actual) === JSON.stringify(intended);
  }
  return actual === intended;
}

function assertAuthoritativeFields<Row extends object>(
  resourceType: CollectionNodeKind,
  actual: Row,
  intended: Row,
  fields: readonly (keyof Row)[],
): void {
  for (const field of fields) {
    if (!authorityValuesEqual(actual[field], intended[field])) {
      invariant(`${resourceType} relational authority read-back mismatch at ${String(field)}`, true);
    }
  }
}

export {
  loadAuthoritativeAnnotationForUpdate,
  loadAuthoritativeRelationForUpdate,
} from './canonical-sidecar-mutation-postgres.js';
