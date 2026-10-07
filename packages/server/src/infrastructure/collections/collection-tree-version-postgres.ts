import { withCanonicalTreeCapacityBatch, type CanonicalTreeCapacityAdmission } from './canonical-tree-capacity.js';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import {
  assertCanonicalCommandId,
  type ProductCommandBinding,
  type ProductCommandClaim,
} from '../../modules/commands/index.js';
import {
  COLLECTION_VERSION_RESTORE_RECEIPT_FIFO_LIMIT,
  CollectionVersionRestoreReceiptConflictError,
  createCanonicalMutationApplication,
  type CaptureCollectionTreeVersionPorts,
  type CollectionTreeLiveMember,
  type CollectionTreeSnapshotNode,
  type CollectionVersionLockedCollection,
  type CollectionVersionReceiptPort,
  type CollectionVersionRecord,
  type CollectionVersionRestoreInnerCommands,
  type CollectionVersionRestoreReceiptDto,
  type CollectionVersionRestoreReceiptRow,
  type CollectionVersionRestoreReceiptStore,
  type CollectionVersionStorePort,
  type CollectionTreeVersionKind,
  type CreateCollectionVersionPorts,
  type ProductCollectionCanonicalPorts,
  type RestoreCollectionVersionPorts,
} from '../../modules/collections/index.js';
import { DatabaseOperationError, isPostgresErrorCode } from '../database/errors.js';
import { createPostgresAccessPolicyFactsPort } from '../access-policy/index.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import { type DatabaseTransaction } from '../database/unit-of-work.js';
import { createRequestUnitOfWork } from '../database/request-unit-of-work.js';
import { lockActiveSyncReplicasForCollection, lockCollectionForReplicaInvalidation } from '../database/lock-order.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createPostgresBookmarkIconWritePort } from './bookmark-icon-postgres.js';
import { createPostgresCanonicalMutationPorts } from './canonical-mutation-postgres-ports.js';
import {
  createPostgresCollectionWritePort,
  createPostgresCollectionsClock,
  createPostgresNodeWritePort,
} from './repositories.js';
import {
  editorNodeIdKey,
  editorParentKey,
  editorPositionKey,
} from './editor-query.js';
import type { ReportSourceInvalidationOutboxPort } from '../outbox/report-source-invalidation-producer.js';

interface VersionRow {
  version_id: string;
  account_id: string;
  collection_id: string;
  content_revision: string;
  kind: CollectionTreeVersionKind;
  label: string;
  etag: string;
  node_count: number;
  tree_json: unknown;
  created_at: Date;
}

/** The version port locks and writes alongside canonical mutations in the caller's transaction. */
export function createPostgresCollectionVersionStore(
  transaction: DatabaseTransaction,
): CollectionVersionStorePort {
  const store: CollectionVersionStorePort = {
    async lockOwnedLive(collectionId, ownerSubjectId) {
      await lockActiveSyncReplicasForCollection(transaction, collectionId);
      return selectOwnedLive(transaction, collectionId, ownerSubjectId, true);
    },
    async getOwnedLive(collectionId, ownerSubjectId) {
      return selectOwnedLive(transaction, collectionId, ownerSubjectId, false);
    },
    async loadLiveMembers(collectionId) {
      const rows = await transaction.selectFrom('nodes')
        .select(['id', 'parent_id', 'kind', 'title', 'url', 'position_token'])
        .where('collection_id', '=', collectionId)
        .where(sql<boolean>`NOT is_root`)
        .where('kind', 'in', ['folder', 'bookmark'])
        .where('deleted_at', 'is', null)
        .orderBy(editorParentKey)
        .orderBy(editorPositionKey)
        .orderBy(editorNodeIdKey)
        .execute();
      const members: CollectionTreeLiveMember[] = [];
      for (const row of rows) {
        if (row.parent_id === null || row.position_token === null || row.title === null) {
          throw new Error(`live non-root node ${row.id} is missing parent, position, or title`);
        }
        if (row.kind !== 'folder' && row.kind !== 'bookmark') continue;
        if (row.kind === 'bookmark' && (typeof row.url !== 'string' || row.url.length < 1)) {
          throw new Error(`live bookmark ${row.id} is missing url`);
        }
        members.push(Object.freeze({
          id: row.id,
          kind: row.kind,
          parentId: row.parent_id,
          title: row.title,
          url: row.kind === 'bookmark' ? row.url : null,
          positionToken: row.position_token,
        }));
      }
      return Object.freeze(members);
    },
    async getByCollectionAndRevision(accountId, collectionId, contentRevision) {
      const row = await transaction.selectFrom('collection_tree_versions')
        .selectAll()
        .where('account_id', '=', accountId)
        .where('collection_id', '=', collectionId)
        .where('content_revision', '=', contentRevision)
        .executeTakeFirst();
      return row ? mapVersionRow(row as VersionRow) : null;
    },
    async getById(accountId, collectionId, versionId) {
      const row = await transaction.selectFrom('collection_tree_versions')
        .selectAll()
        .where('account_id', '=', accountId)
        .where('collection_id', '=', collectionId)
        .where('version_id', '=', versionId)
        .executeTakeFirst();
      return row ? mapVersionRow(row as VersionRow) : null;
    },
    async list(accountId, collectionId, input) {
      let query = transaction.selectFrom('collection_tree_versions')
        .selectAll()
        .where('account_id', '=', accountId)
        .where('collection_id', '=', collectionId);
      if (input.after) {
        query = query.where(sql<boolean>`(created_at, version_id) < (${input.after.createdAt}, ${input.after.versionId})`);
      }
      const rows = await query
        .orderBy('created_at', 'desc')
        .orderBy('version_id', 'desc')
        .limit(input.limit + 1)
        .execute();
      return Object.freeze(rows.map((row) => mapVersionRow(row as VersionRow)));
    },
    async insert(row) {
      await transaction.insertInto('collection_tree_versions').values({
        version_id: row.versionId,
        account_id: row.accountId,
        collection_id: row.collectionId,
        content_revision: row.contentRevision,
        kind: row.kind,
        label: row.label,
        etag: row.etag,
        node_count: row.nodeCount,
        tree_json: sql`${JSON.stringify(row.treeJson)}::jsonb`,
        created_at: row.createdAt,
      }).execute();
    },
    async count(accountId, collectionId) {
      const row = await transaction.selectFrom('collection_tree_versions')
        .select(sql<number>`count(*)::int`.as('count'))
        .where('account_id', '=', accountId)
        .where('collection_id', '=', collectionId)
        .executeTakeFirst();
      return row?.count ?? 0;
    },
    async deleteOldest(accountId, collectionId, excludeVersionId) {
      await sql`
        DELETE FROM collection_tree_versions
        WHERE version_id = (
          SELECT version_id FROM collection_tree_versions
          WHERE account_id = ${accountId}
            AND collection_id = ${collectionId}
            AND (${excludeVersionId ?? null}::text IS NULL OR version_id <> ${excludeVersionId ?? null})
          ORDER BY created_at ASC, version_id ASC
          LIMIT 1
        )
      `.execute(transaction);
    },
    async findLatestManualCreatedAt(accountId, collectionId) {
      const row = await transaction.selectFrom('collection_tree_versions')
        .select('created_at')
        .where('account_id', '=', accountId)
        .where('collection_id', '=', collectionId)
        .where('kind', '=', 'manual')
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      return row?.created_at ?? null;
    },
  };
  return Object.freeze(store);
}

export function createPostgresCollectionVersionUnitOfWork(
  db: Kysely<DatabaseSchema>,
  options: { readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort } = {},
): {
  execute<Result>(
    work: (ports: CreateCollectionVersionPorts & CaptureCollectionTreeVersionPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result>;
} {
  return Object.freeze({
    execute<Result>(
      work: (ports: CreateCollectionVersionPorts) => Promise<Result>,
      request: { readonly signal?: AbortSignal } = {},
    ): Promise<Result> {
      return createRequestUnitOfWork(db, { isolationLevel: 'read committed' })
        .execute(({ transaction }) => withCanonicalTreeCapacityBatch(transaction, undefined, async (admission) => {
          const versions = createPostgresCollectionVersionStore(transaction);
          const ports: RestoreCollectionVersionPorts = {
            versions,
            receipts: createCollectionVersionReceiptPort(transaction),
            clock: { now: () => new Date() },
            mutations: createCollectionVersionCanonicalPorts(transaction, admission, options),
            restoreReceipts: createPostgresCollectionVersionRestoreReceiptStore(transaction),
            commandIds: { next: () => randomUUID() },
          };
          return work(ports);
        }), request);
    },
  });
}

function createCollectionVersionCanonicalPorts(
  transaction: DatabaseTransaction,
  treeCapacityAdmission: CanonicalTreeCapacityAdmission,
  options: { readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort } = {},
): ProductCollectionCanonicalPorts {
  const rawCanonical = createCanonicalMutationApplication(
    createPostgresCanonicalMutationPorts(transaction, {
      invalidateSyncReplicasOnNodeMutation: true,
      treeCapacityAdmission,
      ...(options.reportSourceInvalidation === undefined ? {} : { reportSourceInvalidation: options.reportSourceInvalidation }),
    }),
  );
  const rawReceipts = createPostgresProductCommandReceiptPort(transaction);
  const collections = createPostgresCollectionWritePort(transaction);
  const nodeReader = createPostgresNodeWritePort(transaction);
  return {
    receipts: {
      claim: (binding, fingerprint) => rawReceipts.claim(binding, fingerprint),
      complete: (binding, fingerprint, result) =>
        rawReceipts.complete(binding, fingerprint, result),
    },
    clock: createPostgresCollectionsClock(transaction),
    collections: {
      // T-10 lock order (ADR-0027): replica rows are locked before the
      // collection row because the canonical mutation below invalidates them.
      lockForUpdate: (collectionId) => lockCollectionForReplicaInvalidation(
        transaction, collectionId, () => collections.lockForUpdate(collectionId)),
    },
    nodes: {
      getNode: (collectionId, nodeId) => nodeReader.getNode(collectionId, nodeId),
      readParentAncestry: (collectionId, parentId, maxDepth) =>
        nodeReader.readParentAncestry!(collectionId, parentId, maxDepth),
      listLiveSiblingPositions: (collectionId, parentId) =>
        nodeReader.listLiveSiblingPositions(collectionId, parentId),
      hasLiveChildren: (collectionId, parentId) =>
        nodeReader.hasLiveChildren!(collectionId, parentId),
      listLiveNodes: (collectionId) => nodeReader.listLiveNodes!(collectionId),
    },
    accessPolicy: createPostgresAccessPolicyFactsPort(transaction),
    canonical: {
      execute: (input) => rawCanonical.execute({ transaction }, input),
      async bootstrapOwnedCollection() {
        throw new Error('canonical bootstrap is outside collection-version restore');
      },
    },
    bookmarkIcons: createPostgresBookmarkIconWritePort(transaction),
  };
}

export function createPostgresCollectionVersionRestoreReceiptStore(
  transaction: DatabaseTransaction,
): CollectionVersionRestoreReceiptStore {
  const store: CollectionVersionRestoreReceiptStore = {
    async getByCommandId(accountId, commandId) {
      const row = await transaction.selectFrom('collection_version_restore_receipts')
        .selectAll()
        .where('account_id', '=', accountId)
        .where('command_id', '=', commandId)
        .executeTakeFirst();
      return row ? mapRestoreReceiptRow(row) : null;
    },
    async persist(row) {
      try {
        await transaction.insertInto('collection_version_restore_receipts').values({
          command_id: row.commandId,
          version_id: row.versionId,
          collection_id: row.collectionId,
          account_id: row.accountId,
          inner_commands: sql`${JSON.stringify(row.innerCommands)}::jsonb`,
          result_json: sql`${JSON.stringify(row.result)}::jsonb`,
          created_at: row.createdAt,
        }).execute();
      } catch (error: unknown) {
        if (isUniqueViolation(error)) throw new CollectionVersionRestoreReceiptConflictError();
        throw error;
      }
      await trimRestoreReceipts(transaction, row.collectionId);
    },
  };
  return Object.freeze(store);
}

function isUniqueViolation(error: unknown): boolean {
  if (error instanceof DatabaseOperationError) return error.kind === 'unique_violation';
  if (isPostgresErrorCode(error, '23505')) return true;
  const cause = error instanceof Error ? error.cause : undefined;
  return cause !== undefined && isUniqueViolation(cause);
}

async function trimRestoreReceipts(
  transaction: DatabaseTransaction,
  collectionId: string,
): Promise<void> {
  const extras = await transaction.selectFrom('collection_version_restore_receipts')
    .select('command_id')
    .where('collection_id', '=', collectionId)
    .orderBy('created_at', 'asc')
    .orderBy('command_id', 'asc')
    .execute();
  if (extras.length <= COLLECTION_VERSION_RESTORE_RECEIPT_FIFO_LIMIT) return;
  const toDelete = extras
    .slice(0, extras.length - COLLECTION_VERSION_RESTORE_RECEIPT_FIFO_LIMIT)
    .map((item) => item.command_id);
  await transaction.deleteFrom('collection_version_restore_receipts')
    .where('command_id', 'in', toDelete)
    .execute();
}

function mapRestoreReceiptRow(row: {
  readonly command_id: string;
  readonly version_id: string;
  readonly collection_id: string;
  readonly account_id: string;
  readonly inner_commands: unknown;
  readonly result_json: unknown;
  readonly created_at: Date;
}): CollectionVersionRestoreReceiptRow {
  return Object.freeze({
    commandId: row.command_id,
    versionId: row.version_id,
    collectionId: row.collection_id,
    accountId: row.account_id,
    innerCommands: parseInnerCommands(row.inner_commands),
    result: parseRestoreResult(row.result_json),
    createdAt: row.created_at,
  });
}

function parseInnerCommands(value: unknown): CollectionVersionRestoreInnerCommands {
  const record = asJsonObject(value);
  return Object.freeze({
    updateCommandIds: asStringArray(record.updateCommandIds),
    moveCommandIds: asStringArray(record.moveCommandIds),
    deleteCommandIds: asStringArray(record.deleteCommandIds),
  });
}

function parseRestoreResult(value: unknown): CollectionVersionRestoreReceiptDto {
  const record = asJsonObject(value);
  if (typeof record.versionId !== 'string' || typeof record.noop !== 'boolean') {
    throw new Error('collection_version_restore_receipts.result_json is invalid');
  }
  const preRestoreVersionId = record.preRestoreVersionId;
  if (preRestoreVersionId !== null && typeof preRestoreVersionId !== 'string') {
    throw new Error('collection_version_restore_receipts.result_json is invalid');
  }
  return Object.freeze({
    versionId: record.versionId,
    noop: record.noop,
    updatedNodeIds: asStringArray(record.updatedNodeIds),
    movedNodeIds: asStringArray(record.movedNodeIds),
    deletedNodeIds: asStringArray(record.deletedNodeIds),
    preRestoreVersionId,
  });
}

function asJsonObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('collection_version_restore_receipts json is invalid');
  }
  return parsed as Record<string, unknown>;
}

function asStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('collection_version_restore_receipts array field is invalid');
  }
  return Object.freeze([...value]);
}

function createCollectionVersionReceiptPort(
  transaction: DatabaseTransaction,
): CollectionVersionReceiptPort {
  const base = createPostgresProductCommandReceiptPort(transaction);
  return Object.freeze({
    claim: (binding: ProductCommandBinding, fingerprint: string) =>
      base.claim(binding, fingerprint),
    complete: (
      binding: ProductCommandBinding,
      fingerprint: string,
      result: Parameters<CollectionVersionReceiptPort['complete']>[2],
    ) => base.complete(binding, fingerprint, result),
    lookup: (binding: ProductCommandBinding, fingerprint: string) =>
      lookupCollectionVersionReceipt(transaction, binding, fingerprint),
  });
}

async function lookupCollectionVersionReceipt(
  transaction: DatabaseTransaction,
  binding: ProductCommandBinding,
  fingerprint: string,
): Promise<
  | { readonly kind: 'absent' }
  | Exclude<ProductCommandClaim, { readonly kind: 'claimed' }>
> {
  assertCanonicalCommandId(binding.commandId);
  const row = await transaction.selectFrom('product_command_receipts').selectAll()
    .where('principal_id', '=', binding.principalId)
    .where('command_scope', '=', binding.commandScope)
    .where('command_id', '=', binding.commandId)
    .executeTakeFirst();
  if (!row) return { kind: 'absent' };
  if (row.request_fingerprint !== fingerprint) return { kind: 'reused' };
  if ((row.compact_claim || row.result_purged_at !== null || row.result_bytes === null)
      && row.completed_at !== null) {
    return { kind: 'expired', resultDigest: row.result_digest };
  }
  if (row.completed_at === null) return { kind: 'in_progress', retryAfterSeconds: 1 };
  return {
    kind: 'replay',
    result: {
      status: row.result_status!,
      body: row.result_bytes!,
      stableHeaders: row.result_headers ?? {},
      mediaType: row.result_media_type!,
      contractVersion: row.contract_version,
      targetIdentity: row.target_identity ?? undefined,
    },
  };
}

async function selectOwnedLive(
  transaction: DatabaseTransaction | Kysely<DatabaseSchema>,
  collectionId: string,
  ownerSubjectId: string,
  forUpdate: boolean,
): Promise<CollectionVersionLockedCollection | null> {
  const query = transaction.selectFrom('collections')
    .select(['id', 'owner_subject_id', 'content_revision', 'root_node_id', 'deleted_at'])
    .where('id', '=', collectionId)
    .where('owner_subject_id', '=', ownerSubjectId)
    .where('deleted_at', 'is', null);
  const row = await (forUpdate ? query.forUpdate() : query).executeTakeFirst();
  if (!row) return null;
  return Object.freeze({
    collectionId: row.id,
    ownerSubjectId: row.owner_subject_id,
    contentRevision: row.content_revision,
    rootNodeId: row.root_node_id,
  } satisfies CollectionVersionLockedCollection);
}

function mapVersionRow(row: VersionRow): CollectionVersionRecord {
  return Object.freeze({
    versionId: row.version_id,
    accountId: row.account_id,
    collectionId: row.collection_id,
    contentRevision: row.content_revision,
    kind: row.kind,
    label: row.label,
    etag: row.etag,
    nodeCount: row.node_count,
    treeJson: parseTreeJson(row.tree_json),
    createdAt: row.created_at,
  });
}

function parseTreeJson(value: unknown): readonly CollectionTreeSnapshotNode[] {
  if (!Array.isArray(value)) throw new Error('collection_tree_versions.tree_json must be an array');
  return Object.freeze(value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('collection_tree_versions.tree_json node is invalid');
    }
    const node = item as Record<string, unknown>;
    if ((node.kind !== 'folder' && node.kind !== 'bookmark')
      || typeof node.id !== 'string' || typeof node.parentId !== 'string' || typeof node.title !== 'string') {
      throw new Error('collection_tree_versions.tree_json node is invalid');
    }
    const parsed: CollectionTreeSnapshotNode = {
      id: node.id,
      kind: node.kind,
      parentId: node.parentId,
      title: node.title,
      url: node.kind === 'bookmark' && typeof node.url === 'string' ? node.url : null,
      ...(node.kind === 'folder' && Array.isArray(node.childIds)
        ? { childIds: Object.freeze(node.childIds.filter((id): id is string => typeof id === 'string')) }
        : {}),
    };
    return Object.freeze(parsed);
  }));
}
