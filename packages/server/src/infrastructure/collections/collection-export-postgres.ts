import { sql, type Kysely } from 'kysely';
import type {
  CollectionExportReadPort,
  ExportAnnotationSource,
  ExportCollectionSource,
  ExportNodeSource,
  ExportRelationSource,
} from '../../modules/collections/index.js';
import {
  COLLECTION_EXPORT_MAX_ANNOTATIONS as MAX_ANNOTATIONS,
  COLLECTION_EXPORT_MAX_BYTES as MAX_BYTES,
  COLLECTION_EXPORT_MAX_NODES as MAX_NODES,
  COLLECTION_EXPORT_MAX_RELATIONS as MAX_RELATIONS,
  CollectionExportCapacityError as CollectionExportCapacityErrorClass,
} from '../../modules/collections/index.js';
import type { DatabaseSchema } from '../database/runtime.js';

export function createPostgresCollectionExportReadPort(
  db: Kysely<DatabaseSchema>,
): CollectionExportReadPort {
  return {
    async listOwnedIds(ownerSubjectId) {
      const rows = await db.selectFrom('collections')
        .select('id')
        .where('owner_subject_id', '=', ownerSubjectId)
        .where('deleted_at', 'is', null)
        .orderBy('title', 'asc')
        .orderBy('id', 'asc')
        .execute();
      return rows.map((row) => row.id);
    },
    async loadForPrincipal(input) {
      // The capacity snapshot and the rows that follow must describe the same
      // database state.  Otherwise concurrent inserts can pass the preflight
      // and then be materialized without the cap.  Reuse the transaction-aware
      // port on the inner connection so callers that already provide a
      // transaction do not nest one.
      if (!db.isTransaction) {
        return db.transaction().setIsolationLevel('repeatable read').execute((transaction) =>
          createPostgresCollectionExportReadPort(transaction).loadForPrincipal(input));
      }
      const collection = await db.selectFrom('collections')
        .select([
          'id', 'owner_subject_id', 'title', 'summary', 'kind', 'visibility',
          'publication_slug', 'root_node_id', 'content_revision', 'policy_revision',
          'created_at', 'updated_at',
        ])
        .where('id', '=', input.collectionId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (collection === undefined) return null;
      const access = await accessFor(db, collection.owner_subject_id, input.collectionId, input.subjectId);
      if (access === null) return null;
      await assertCollectionExportCapacity(db, collection.id);
      const [nodeRows, annotationRows, relationRows] = await Promise.all([
        db.selectFrom('nodes')
          .select([
            'id', 'parent_id', 'kind', 'is_root', 'title', 'url', 'description',
            'tags', 'visibility', 'position_token', 'resource_revision', 'created_at', 'updated_at',
          ])
          .where('collection_id', '=', collection.id)
          .where('deleted_at', 'is', null)
          .execute(),
        db.selectFrom('annotations')
          .select(['visibility', 'creator_principal_id', 'payload_json'])
          .where('collection_id', '=', collection.id)
          .where('deleted_at', 'is', null)
          .execute(),
        db.selectFrom('relations')
          .select(['visibility', 'payload_json'])
          .where('collection_id', '=', collection.id)
          .where('deleted_at', 'is', null)
          .execute(),
      ]);
      const source: ExportCollectionSource = {
        id: collection.id,
        access,
        title: collection.title,
        summary: collection.summary,
        kind: collection.kind,
        visibility: collection.visibility,
        publicationSlug: collection.publication_slug,
        rootNodeId: collection.root_node_id,
        contentRevision: collection.content_revision,
        policyRevision: collection.policy_revision,
        createdAt: collection.created_at,
        updatedAt: collection.updated_at,
        nodes: nodeRows.map((row): ExportNodeSource => ({
          id: row.id,
          parentId: row.parent_id,
          kind: row.kind,
          isRoot: row.is_root,
          title: row.title,
          url: row.url,
          description: row.description,
          tags: parseTags(row.tags),
          visibility: row.visibility,
          position: row.position_token,
          revision: row.resource_revision,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
        annotations: annotationRows.map((row): ExportAnnotationSource => ({
          visibility: row.visibility,
          creatorPrincipalId: row.creator_principal_id,
          payload: row.payload_json,
        })),
        relations: relationRows.map((row): ExportRelationSource => ({
          visibility: row.visibility,
          payload: row.payload_json,
        })),
      };
      return source;
    },
  };
}

interface CollectionExportCapacityRow {
  node_count: string;
  annotation_count: string;
  relation_count: string;
  estimated_bytes: string;
}

/**
 * Check the aggregate size before any rows are materialized in the Node
 * process.  Counts protect the array construction itself, while the byte
 * estimate catches a small number of rows carrying large JSON/text values.
 * The estimate is based on UTF-8 JSON text rather than PostgreSQL's binary
 * jsonb storage size, and doubles each row to leave room for pretty JSON and
 * the export envelope.
 * PostgreSQL returns the numeric aggregates as strings, so the comparison is
 * exact even for values above JavaScript's safe integer range.
 */
async function assertCollectionExportCapacity(
  db: Kysely<DatabaseSchema>,
  collectionId: string,
): Promise<void> {
  const result = await sql<CollectionExportCapacityRow>`
    SELECT
      (SELECT count(*)::text
         FROM nodes
        WHERE collection_id = ${collectionId}
          AND deleted_at IS NULL) AS node_count,
      (SELECT count(*)::text
         FROM annotations
        WHERE collection_id = ${collectionId}
          AND deleted_at IS NULL) AS annotation_count,
      (SELECT count(*)::text
         FROM relations
        WHERE collection_id = ${collectionId}
          AND deleted_at IS NULL) AS relation_count,
      (
        COALESCE((SELECT sum(octet_length(to_jsonb(n)::text) * 2)
                    FROM nodes AS n
                   WHERE n.collection_id = ${collectionId}
                     AND n.deleted_at IS NULL), 0)
        + COALESCE((SELECT sum(octet_length(to_jsonb(a)::text) * 2)
                      FROM annotations AS a
                     WHERE a.collection_id = ${collectionId}
                       AND a.deleted_at IS NULL), 0)
        + COALESCE((SELECT sum(octet_length(to_jsonb(r)::text) * 2)
                      FROM relations AS r
                     WHERE r.collection_id = ${collectionId}
                       AND r.deleted_at IS NULL), 0)
      )::text AS estimated_bytes
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined) throw new CollectionExportCapacityErrorClass();
  const nodeCount = parseAggregate(row.node_count);
  const annotationCount = parseAggregate(row.annotation_count);
  const relationCount = parseAggregate(row.relation_count);
  const estimatedBytes = parseAggregate(row.estimated_bytes);
  if (nodeCount > BigInt(MAX_NODES)
    || annotationCount > BigInt(MAX_ANNOTATIONS)
    || relationCount > BigInt(MAX_RELATIONS)
    || estimatedBytes > BigInt(MAX_BYTES)) {
    throw new CollectionExportCapacityErrorClass();
  }
}

function parseAggregate(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new CollectionExportCapacityErrorClass();
  }
}

async function accessFor(
  db: Kysely<DatabaseSchema>,
  ownerSubjectId: string,
  collectionId: string,
  subjectId: string,
): Promise<ExportCollectionSource['access'] | null> {
  if (ownerSubjectId === subjectId) return 'owner';
  const member = await db.selectFrom('collection_members')
    .select('role')
    .where('collection_id', '=', collectionId)
    .where('subject_id', '=', subjectId)
    .executeTakeFirst();
  if (member === undefined) return null;
  if (member.role === 'owner') return 'owner';
  return member.role;
}

function parseTags(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') tags.push(item);
  }
  return tags;
}
