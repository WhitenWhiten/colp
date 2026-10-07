import { sql } from 'kysely';
import type {
  BootstrapAuditPort,
  BootstrapOperationPort,
  BootstrapOutboxPort,
  CollectionWritePort,
  CollectionsClock,
  CollectionsWritePorts,
  IdLedgerPort,
  NodeWritePort,
  LockedCollectionRow,
  LockedNodeRow,
  RevisionWritePort,
} from '../../modules/collections/index.js';
import {
  CanonicalMutationInvariantError,
  RESOURCE_PAYLOAD_SCHEMA_VERSION,
  compareResourcePayload,
  materializeCollectionPayload,
  materializeNodePayload,
  type JsonObject,
} from '../../modules/collections/index.js';
import {
  createPostgresAccessPolicyFactsPort,
  createPostgresAccessPolicyWritePort,
} from '../access-policy/index.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import { appendOperationWithPayload } from '../database/operation-payload-store.js';
import { appendAuditEvent } from '../database/audit-event-payload.js';
import { databaseNow } from '../database/time.js';
import { createPostgresResourceIdLedgerPort } from '../database/resource-id-ledger.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { Metrics } from '../telemetry/index.js';
import { appendSocialCollectionChangeOutbox } from '../outbox/social-collection-change.js';
import { deleteBookmarkIconsForNodeIds, createPostgresBookmarkIconWritePort } from './bookmark-icon-postgres.js';
import { createPostgresFaviconPolicyPort } from './favicon-policy-postgres.js';
import { createPostgresFaviconSourcePort, createPostgresFaviconSourceMembershipPort } from './favicon-source-postgres.js';
import { createPostgresFaviconJobWritePort, createPostgresFaviconJobReadPort, createPostgresFaviconGcWritePort } from './favicon-job-postgres.js';
import { createPostgresFaviconBatchWritePorts } from './favicon-job-items-postgres.js';
import {
  dualReadCollectionPayload,
  dualReadNodePayload,
} from './resource-payload-dual-read.js';

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

function canonicalPayload(result: ReturnType<typeof materializeCollectionPayload>): JsonObject {
  if (!result.ok) {
    throw new CanonicalMutationInvariantError(
      'resource_field_authority_violation',
      `canonical bootstrap payload is invalid at ${result.fieldPath ?? '$'}: ${result.reason}`,
    );
  }
  return result.payload;
}

function assertBootstrapPayload(
  resourceType: 'collection' | 'node',
  resourceId: string,
  expected: JsonObject,
  actual: unknown,
): void {
  const comparison = compareResourcePayload({ resourceType, resourceId, expected, actual });
  if (!comparison.equal) {
    throw new CanonicalMutationInvariantError(
      'resource_field_authority_violation',
      `${resourceType} bootstrap read-back mismatch at ${comparison.mismatches[0]?.path ?? '$'}`,
    );
  }
}

export function createPostgresCollectionsClock(
  transaction: DatabaseTransaction,
): CollectionsClock {
  return {
    now: () => databaseNow(transaction),
  };
}

export function createPostgresIdLedgerPort(
  transaction: DatabaseTransaction,
): IdLedgerPort {
  return createPostgresResourceIdLedgerPort(transaction);
}

const COLLECTION_LOCK_COLUMNS = [
  'id',
  'owner_subject_id',
  'title',
  'summary',
  'kind',
  'visibility',
  'allow_search_indexing',
  'publication_slug',
  'published_at',
  'root_node_id',
  'resource_revision',
  'content_revision',
  'policy_revision',
  'commit_ordinal',
  'created_at',
  'updated_at',
  'deleted_at',
  'payload_json',
] as const;

async function lockCollectionRow(
  transaction: DatabaseTransaction,
  collectionId: string,
  metrics: Metrics | undefined,
  mode: 'update' | 'share',
): Promise<LockedCollectionRow | null> {
  const base = transaction
    .selectFrom('collections')
    .select([...COLLECTION_LOCK_COLUMNS])
    .where('id', '=', collectionId);
  const row = await (mode === 'update' ? base.forUpdate() : base.forShare()).executeTakeFirst();
  if (!row) return null;
  dualReadCollectionPayload(row, metrics);
  return {
    id: row.id,
    ownerSubjectId: row.owner_subject_id,
    title: row.title,
    summary: row.summary,
    kind: row.kind,
    visibility: row.visibility,
    allowSearchIndexing: row.allow_search_indexing,
    publicationSlug: row.publication_slug,
    publishedAt: row.published_at,
    rootNodeId: row.root_node_id,
    resourceRevision: row.resource_revision,
    contentRevision: row.content_revision,
    policyRevision: row.policy_revision,
    commitOrdinal: row.commit_ordinal,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    payloadJson: row.payload_json as Record<string, unknown> | null,
  };
}

export function createPostgresCollectionWritePort(
  transaction: DatabaseTransaction,
  metrics?: Metrics,
): CollectionWritePort {
  return {
    async insertBootstrap(row) {
      const payload = canonicalPayload(materializeCollectionPayload({
        id: row.id,
        ownerSubjectId: row.ownerSubjectId,
        title: row.title,
        summary: row.summary,
        kind: row.kind,
        visibility: row.visibility,
        allowSearchIndexing: false,
        rootNodeId: row.rootNodeId,
        resourceRevision: row.resourceRevision,
        contentRevision: row.contentRevision,
        policyRevision: row.policyRevision,
        commitOrdinal: row.commitOrdinal,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        deletedAt: null,
      }));
      await transaction
        .insertInto('collections')
        .values({
          id: row.id,
          owner_subject_id: row.ownerSubjectId,
          title: row.title,
          summary: row.summary,
          kind: row.kind,
          visibility: row.visibility,
          root_node_id: row.rootNodeId,
          root_node_is_root: true,
          resource_revision: row.resourceRevision,
          content_revision: row.contentRevision,
          policy_revision: row.policyRevision,
          commit_ordinal: row.commitOrdinal,
          created_at: row.createdAt,
          updated_at: row.updatedAt,
          deleted_at: null,
          payload_json: payload,
          payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION,
          payload_authority_status: 'backfilled',
        })
        .execute();
      const inserted = await transaction.selectFrom('collections').selectAll().where('id', '=', row.id).executeTakeFirst();
      if (!inserted) throw new CanonicalMutationInvariantError('resource_field_authority_violation', 'collection bootstrap read-back failed');
      const relational = canonicalPayload(materializeCollectionPayload({
        id: inserted.id, ownerSubjectId: inserted.owner_subject_id, title: inserted.title,
        summary: inserted.summary, kind: inserted.kind, visibility: inserted.visibility,
        allowSearchIndexing: inserted.allow_search_indexing,
        rootNodeId: inserted.root_node_id, resourceRevision: inserted.resource_revision,
        contentRevision: inserted.content_revision, policyRevision: inserted.policy_revision,
        commitOrdinal: inserted.commit_ordinal, createdAt: inserted.created_at,
        updatedAt: inserted.updated_at, deletedAt: inserted.deleted_at,
      }));
      assertBootstrapPayload('collection', row.id, payload, inserted.payload_json);
      assertBootstrapPayload('collection', row.id, relational, inserted.payload_json);
    },

    async lockForUpdate(collectionId) {
      return lockCollectionRow(transaction, collectionId, metrics, 'update');
    },

    async lockForShare(collectionId) {
      return lockCollectionRow(transaction, collectionId, metrics, 'share');
    },

    async advanceContentFence(collectionId, update) {
      const set: {
        content_revision: string;
        commit_ordinal: bigint;
        updated_at: Date;
        policy_revision?: string;
      } = {
        content_revision: update.contentRevision,
        commit_ordinal: update.commitOrdinal,
        updated_at: update.updatedAt,
      };
      if (update.policyRevision !== undefined) {
        set.policy_revision = update.policyRevision;
      }

      const result = await transaction
        .updateTable('collections')
        .set(set)
        .where('id', '=', collectionId)
        .executeTakeFirst();

      if (Number(result.numUpdatedRows) !== 1) {
        throw new Error(
          `collection content fence update affected ${String(result.numUpdatedRows)} rows for ${collectionId}`,
        );
      }
    },
  };
}

const LOCKED_NODE_SELECT = [
  'id',
  'collection_id',
  'parent_id',
  'kind',
  'is_root',
  'title',
  'url',
  'description',
  'tags',
  'visibility',
  'position_token',
  'resource_revision',
  'children_revision',
  'created_at',
  'updated_at',
  'deleted_at',
  'deleted_commit_ordinal',
  'payload_json',
] as const;

function parseNodeTags(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') tags.push(item);
  }
  return tags;
}

function mapLockedNodeRow(row: {
  id: string;
  collection_id: string;
  parent_id: string | null;
  kind: 'folder' | 'bookmark' | 'separator';
  is_root: boolean;
  title: string | null;
  url: string | null;
  description: string | null;
  tags: unknown;
  visibility: 'inherit' | 'protected' | 'private';
  position_token: string | null;
  resource_revision: string;
  children_revision: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}): import('../../modules/collections/index.js').LockedNodeRow {
  if (row.kind === 'separator' || row.title === null) {
    throw new Error(`node ${row.id} is outside the Product mutation surface`);
  }
  return {
    id: row.id,
    collectionId: row.collection_id,
    parentId: row.parent_id,
    kind: row.kind,
    isRoot: row.is_root,
    title: row.title,
    url: row.url,
    description: row.description,
    tags: parseNodeTags(row.tags),
    visibility: row.visibility,
    positionToken: row.position_token,
    resourceRevision: row.resource_revision,
    childrenRevision: row.children_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export function createPostgresNodeWritePort(
  transaction: DatabaseTransaction,
  metrics?: Metrics,
): NodeWritePort {
  return {
    async insertRoot(row) {
      const payload = canonicalPayload(materializeNodePayload({
        id: row.id,
        collectionId: row.collectionId,
        parentId: null,
        kind: 'folder',
        isRoot: true,
        title: row.title,
        url: null,
        description: null,
        tags: null,
        visibility: 'inherit',
        positionToken: null,
        resourceRevision: row.resourceRevision,
        childrenRevision: row.childrenRevision,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        deletedAt: null,
        deletedCommitOrdinal: null,
      }));
      await transaction
        .insertInto('nodes')
        .values({
          id: row.id,
          collection_id: row.collectionId,
          parent_id: null,
          kind: 'folder',
          is_root: true,
          title: row.title,
          url: null,
          description: null,
          tags: null,
          visibility: 'inherit',
          position_token: null,
          resource_revision: row.resourceRevision,
          children_revision: row.childrenRevision,
          created_at: row.createdAt,
          updated_at: row.updatedAt,
          deleted_at: null,
          deleted_commit_ordinal: null,
          payload_json: payload,
          payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION,
          payload_authority_status: 'backfilled',
        })
        .execute();
      const inserted = await transaction.selectFrom('nodes').selectAll().where('id', '=', row.id).executeTakeFirst();
      if (!inserted) throw new CanonicalMutationInvariantError('resource_field_authority_violation', 'root bootstrap read-back failed');
      const relational = canonicalPayload(materializeNodePayload({
        id: inserted.id, collectionId: inserted.collection_id, parentId: inserted.parent_id,
        kind: inserted.kind, isRoot: inserted.is_root, title: inserted.title, url: inserted.url,
        description: inserted.description, tags: inserted.tags, visibility: inserted.visibility,
        positionToken: inserted.position_token, resourceRevision: inserted.resource_revision,
        childrenRevision: inserted.children_revision, createdAt: inserted.created_at,
        updatedAt: inserted.updated_at, deletedAt: inserted.deleted_at,
        deletedCommitOrdinal: inserted.deleted_commit_ordinal,
      }));
      assertBootstrapPayload('node', row.id, payload, inserted.payload_json);
      assertBootstrapPayload('node', row.id, relational, inserted.payload_json);
    },

    async insertNode(row) {
      await transaction
        .insertInto('nodes')
        .values({
          id: row.id,
          collection_id: row.collectionId,
          parent_id: row.parentId,
          kind: row.kind,
          is_root: false,
          title: row.title,
          url: row.url,
          search_url_host: searchUrlHost(row.url),
          description: row.description,
          tags: row.tags.length > 0 ? [...row.tags] : null,
          visibility: row.visibility,
          position_token: row.positionToken,
          resource_revision: row.resourceRevision,
          children_revision: row.childrenRevision,
          created_at: row.createdAt,
          updated_at: row.updatedAt,
          deleted_at: null,
          deleted_commit_ordinal: null,
        })
        .execute();
    },

    async getNode(collectionId, nodeId) {
      const row = await transaction
        .selectFrom('nodes')
        .select(LOCKED_NODE_SELECT)
        .where('collection_id', '=', collectionId)
        .where('id', '=', nodeId)
        .executeTakeFirst();

      if (!row) return null;
      dualReadNodePayload(row, metrics);
      if (row.kind === 'separator' || row.title === null) return null;
      return mapLockedNodeRow(row);
    },

    async listLiveNodes(collectionId) {
      const rows = await transaction
        .selectFrom('nodes')
        .select(LOCKED_NODE_SELECT)
        .where('collection_id', '=', collectionId)
        .where('deleted_at', 'is', null)
        .where('kind', 'in', ['folder', 'bookmark'])
        .execute();
      const nodes: LockedNodeRow[] = [];
      for (const row of rows) {
        dualReadNodePayload(row, metrics);
        if (row.kind === 'separator' || row.title === null) continue;
        nodes.push(mapLockedNodeRow(row));
      }
      return nodes;
    },

    async readParentAncestry(collectionId, parentId, maxDepth) {
      const result = await sql<{
        id: string; parent_id: string | null; depth: number; is_root: boolean; kind: string;
        collection_id: string; deleted_at: Date | null; cycle: boolean;
        title: string | null; url: string | null; description: string | null; tags: unknown;
        visibility: 'inherit' | 'protected' | 'private'; position_token: string | null;
        resource_revision: string; children_revision: string; created_at: Date; updated_at: Date;
      }>`
        with recursive ancestry as (
          select n.id, n.parent_id, 0::integer as depth, n.is_root, n.kind, n.collection_id, n.deleted_at,
            n.title, n.url, n.description, n.tags, n.visibility, n.position_token, n.resource_revision,
            n.children_revision, n.created_at, n.updated_at,
            array[n.id]::text[] as path, false as cycle
          from nodes n where n.collection_id = ${collectionId} and n.id = ${parentId}
          union all
          select p.id, p.parent_id, a.depth + 1, p.is_root, p.kind, p.collection_id, p.deleted_at,
            p.title, p.url, p.description, p.tags, p.visibility, p.position_token, p.resource_revision,
            p.children_revision, p.created_at, p.updated_at, a.path || p.id,
            p.id = any(a.path) as cycle
          from nodes p join ancestry a on p.id = a.parent_id
          where a.depth < ${maxDepth} and not a.cycle
        )
        select id, parent_id, depth, is_root, kind, collection_id, deleted_at, cycle,
          title, url, description, tags, visibility, position_token, resource_revision,
          children_revision, created_at, updated_at
        from ancestry order by depth
      `.execute(transaction);
      const rows = result.rows.map((row) => ({
        id: row.id, parentId: row.parent_id, depth: row.depth, isRoot: row.is_root,
        kind: row.kind as LockedNodeRow['kind'], collectionId: row.collection_id,
        title: row.title ?? '', url: row.url, description: row.description, tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : [],
        visibility: row.visibility, positionToken: row.position_token, resourceRevision: row.resource_revision,
        childrenRevision: row.children_revision, createdAt: row.created_at, updatedAt: row.updated_at,
        deletedAt: row.deleted_at,
      }));
      for (const [index, row] of result.rows.entries()) {
        if (row.cycle) rows.splice(index + 1, 0, rows[index]!);
      }
      return rows;
    },

    async listLiveSiblingPositions(collectionId, parentId) {
      const rows = await transaction
        .selectFrom('nodes')
        .select(['id', 'position_token'])
        .where('collection_id', '=', collectionId)
        .where('parent_id', '=', parentId)
        .where('deleted_at', 'is', null)
        .where('is_root', '=', false)
        .orderBy('position_token', 'asc')
        .orderBy('id', 'asc')
        .execute();

      return rows.map((row) => {
        if (row.position_token === null) {
          throw new Error(`live sibling ${row.id} is missing position_token`);
        }
        return {
          id: row.id,
          positionToken: row.position_token,
        };
      });
    },

    async hasLiveChildren(collectionId, parentId) {
      const result = await sql<{ exists: boolean }>`
        SELECT EXISTS (
          SELECT 1
          FROM nodes
          WHERE collection_id = ${collectionId}
            AND parent_id = ${parentId}
            AND deleted_at IS NULL
            AND is_root = false
          LIMIT 1
        ) AS exists
      `.execute(transaction);
      return result.rows[0]?.exists === true;
    },

    async updateContent(collectionId, nodeId, update) {
      const result = await transaction
        .updateTable('nodes')
        .set({
          title: update.title,
          url: update.url,
          search_url_host: searchUrlHost(update.url),
          description: update.description,
          tags: update.tags.length > 0 ? [...update.tags] : null,
          visibility: update.visibility,
          resource_revision: update.resourceRevision,
          updated_at: update.updatedAt,
        })
        .where('collection_id', '=', collectionId)
        .where('id', '=', nodeId)
        .executeTakeFirst();

      if (Number(result.numUpdatedRows) !== 1) {
        throw new Error(
          `node content update affected ${String(result.numUpdatedRows)} rows for ${nodeId}`,
        );
      }
    },

    async updatePosition(collectionId, nodeId, update) {
      const result = await transaction
        .updateTable('nodes')
        .set({
          position_token: update.positionToken,
          resource_revision: update.resourceRevision,
          updated_at: update.updatedAt,
        })
        .where('collection_id', '=', collectionId)
        .where('id', '=', nodeId)
        .executeTakeFirst();

      if (Number(result.numUpdatedRows) !== 1) {
        throw new Error(
          `node position update affected ${String(result.numUpdatedRows)} rows for ${nodeId}`,
        );
      }
    },

    async updateParentAndPosition(collectionId, nodeId, update) {
      const result = await transaction
        .updateTable('nodes')
        .set({
          parent_id: update.parentId,
          position_token: update.positionToken,
          resource_revision: update.resourceRevision,
          updated_at: update.updatedAt,
        })
        .where('collection_id', '=', collectionId)
        .where('id', '=', nodeId)
        .executeTakeFirst();

      if (Number(result.numUpdatedRows) !== 1) {
        throw new Error(
          `node parent/position update affected ${String(result.numUpdatedRows)} rows for ${nodeId}`,
        );
      }
    },

    async advanceChildrenRevision(collectionId, nodeId, childrenRevision, updatedAt) {
      const result = await transaction
        .updateTable('nodes')
        .set({
          children_revision: childrenRevision,
          updated_at: updatedAt,
        })
        .where('collection_id', '=', collectionId)
        .where('id', '=', nodeId)
        .executeTakeFirst();

      if (Number(result.numUpdatedRows) !== 1) {
        throw new Error(
          `node children revision update affected ${String(result.numUpdatedRows)} rows for ${nodeId}`,
        );
      }
    },

    async listLiveDescendantIds(collectionId, rootNodeId) {
      // Scoped to collection_id: recursive CTE never walks outside the Collection.
      const result = await sql<{ id: string }>`
        WITH RECURSIVE subtree AS (
          SELECT n.id
          FROM nodes n
          WHERE n.collection_id = ${collectionId}
            AND n.parent_id = ${rootNodeId}
            AND n.deleted_at IS NULL
            AND n.is_root = false
          UNION ALL
          SELECT child.id
          FROM nodes child
          INNER JOIN subtree s ON child.parent_id = s.id
          WHERE child.collection_id = ${collectionId}
            AND child.deleted_at IS NULL
            AND child.is_root = false
        )
        SELECT id FROM subtree
      `.execute(transaction);
      return result.rows.map((row) => row.id);
    },

    async markDeleted(collectionId, nodeId, update) {
      const result = await transaction
        .updateTable('nodes')
        .set({
          deleted_at: update.deletedAt,
          deleted_commit_ordinal: update.deletedCommitOrdinal,
          resource_revision: update.resourceRevision,
          updated_at: update.updatedAt,
        })
        .where('collection_id', '=', collectionId)
        .where('id', '=', nodeId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();

      if (Number(result.numUpdatedRows) !== 1) {
        throw new Error(
          `markDeleted expected 1 row for ${nodeId}, updated ${String(result.numUpdatedRows)}`,
        );
      }
      await deleteBookmarkIconsForNodeIds(transaction, [nodeId]);
    },
  };
}

export function createPostgresRevisionWritePort(
  transaction: DatabaseTransaction,
): RevisionWritePort {
  return {
    async insertResourceRevision(row) {
      await transaction
        .insertInto('resource_revisions')
        .values({
          collection_id: row.collectionId,
          resource_id: row.resourceId,
          revision: row.revision,
          ordinal: row.ordinal,
          created_at: row.createdAt,
        })
        .execute();
    },
    async insertContentRevision(row) {
      await transaction
        .insertInto('content_revisions')
        .values({
          collection_id: row.collectionId,
          revision: row.revision,
          ordinal: row.ordinal,
          created_at: row.createdAt,
        })
        .execute();
    },
    async insertPolicyRevision(row) {
      await transaction
        .insertInto('policy_revisions')
        .values({
          collection_id: row.collectionId,
          revision: row.revision,
          ordinal: row.ordinal,
          created_at: row.createdAt,
        })
        .execute();
    },
    async insertChildrenRevision(row) {
      await transaction
        .insertInto('children_revisions')
        .values({
          collection_id: row.collectionId,
          parent_id: row.parentId,
          revision: row.revision,
          ordinal: row.ordinal,
        })
        .execute();
    },
  };
}

export function createPostgresBootstrapOperationPort(
  transaction: DatabaseTransaction,
): BootstrapOperationPort {
  return {
    async append(record) {
      await appendOperationWithPayload(transaction, {
        operationId: record.operationId, collectionId: record.collectionId,
        commitOrdinal: record.commitOrdinal, operationType: record.operationType,
        payloadJson: record.payload as Record<string, unknown>,
        actorPrincipalId: record.actorPrincipalId, createdAt: record.createdAt,
      });
    },
  };
}

export function createPostgresBootstrapAuditPort(
  transaction: DatabaseTransaction,
): BootstrapAuditPort {
  return {
    async append(record) {
      await appendAuditEvent(transaction, {
        operationId: record.operationId, collectionId: record.collectionId,
        principalId: record.principalId, eventType: record.eventType,
        details: record.details as Record<string, unknown>, createdAt: record.createdAt,
      });
    },
  };
}

export function createPostgresBootstrapOutboxPort(
  transaction: DatabaseTransaction,
): BootstrapOutboxPort {
  return {
    async append(record) {
      await transaction
        .insertInto('outbox_events')
        .values({
          outbox_id: record.outboxId,
          domain_event_id: record.domainEventId,
          event_type: record.eventType,
          event_version: record.eventVersion,
          handler_name: record.handlerName,
          handler_mode: record.handlerMode,
          aggregate_scope: record.aggregateScope,
          aggregate_revision: record.aggregateRevision,
          commit_ordinal: record.commitOrdinal,
          payload_json: record.payload as Record<string, unknown>,
          state: 'pending',
          attempt_count: 0,
          available_at: record.occurredAt,
          locked_until: null,
          lease_generation: 0n,
          completed_at: null,
          last_error: null,
          aggregate_type: record.aggregateType,
          aggregate_id: record.aggregateId,
          occurred_at: record.occurredAt,
          dead_lettered_at: null,
        })
        .execute();
      await appendSocialCollectionChangeOutbox(
        transaction,
        record.domainEventId,
        record.aggregateScope ?? record.aggregateId,
        record.commitOrdinal,
        { occurredAt: record.occurredAt },
      );
    },
  };
}

/**
 * Shared Collection write ports for create + node mutations in one transaction.
 */
export function createPostgresCollectionsWritePorts(
  transaction: DatabaseTransaction,
  metrics?: Metrics,
): CollectionsWritePorts {
  return {
    receipts: createPostgresProductCommandReceiptPort(transaction),
    clock: createPostgresCollectionsClock(transaction),
    idLedger: createPostgresIdLedgerPort(transaction),
    collections: createPostgresCollectionWritePort(transaction, metrics),
    nodes: createPostgresNodeWritePort(transaction, metrics),
    revisions: createPostgresRevisionWritePort(transaction),
    operations: createPostgresBootstrapOperationPort(transaction),
    audit: createPostgresBootstrapAuditPort(transaction),
    outbox: createPostgresBootstrapOutboxPort(transaction),
    accessPolicy: createPostgresAccessPolicyWritePort(transaction),
    accessPolicyFacts: createPostgresAccessPolicyFactsPort(transaction),
    bookmarkIcons: createPostgresBookmarkIconWritePort(transaction),
    faviconPolicies: createPostgresFaviconPolicyPort(transaction),
    faviconSources: createPostgresFaviconSourcePort(transaction),
    faviconJobs: createPostgresFaviconJobWritePort(transaction),
    faviconJobsRead: createPostgresFaviconJobReadPort(transaction),
    faviconGc: createPostgresFaviconGcWritePort(transaction),
    faviconSourceMembership: createPostgresFaviconSourceMembershipPort(transaction),
    ...createPostgresFaviconBatchWritePorts(transaction),
  };
}
