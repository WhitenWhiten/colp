import { sql, type Kysely, type Migration } from 'kysely';
import {
  RESOURCE_PAYLOAD_SCHEMA_VERSION,
  materializeCollectionPayload,
  materializeNodePayload,
  type CollectionRelationalProjection,
  type NodeRelationalProjection,
} from '../src/modules/collections/domain/resource-payload.js';
import { forEachQueryPage, keysetIdPredicate } from './lib/for-each-query-page.js';

/**
 * ADR-0007 expand: add canonical resource payload_json + authority/version metadata
 * to Phase 1 resource tables (collections, nodes), deterministically backfill from
 * relational columns, and retain rollback compatibility (no relational column drops).
 *
 * Expand-only: columns remain nullable so N/N-1 readers/writers that do not yet
 * dual-write can still insert. Backfill marks every materialisable row as
 * backfilled; malformed legacy rows are marked without fabricating data.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE collections
    ADD COLUMN payload_json jsonb,
    ADD COLUMN payload_schema_version integer,
    ADD COLUMN payload_authority_status text`.execute(db);

  await sql`ALTER TABLE collections
    ADD CONSTRAINT collections_payload_schema_version_positive
      CHECK (payload_schema_version IS NULL OR payload_schema_version >= 1),
    ADD CONSTRAINT collections_payload_authority_status_valid
      CHECK (
        payload_authority_status IS NULL
        OR payload_authority_status IN ('pending', 'backfilled', 'malformed')
      ),
    ADD CONSTRAINT collections_payload_authority_consistency
      CHECK (
        (
          payload_authority_status IS NULL
          AND payload_json IS NULL
          AND payload_schema_version IS NULL
        )
        OR (
          payload_authority_status = 'pending'
          AND payload_json IS NULL
          AND payload_schema_version IS NULL
        )
        OR (
          payload_authority_status = 'malformed'
          AND payload_json IS NULL
          AND payload_schema_version IS NULL
        )
        OR (
          payload_authority_status = 'backfilled'
          AND payload_json IS NOT NULL
          AND payload_schema_version IS NOT NULL
        )
      )`.execute(db);

  await sql`ALTER TABLE nodes
    ADD COLUMN payload_json jsonb,
    ADD COLUMN payload_schema_version integer,
    ADD COLUMN payload_authority_status text`.execute(db);

  await sql`ALTER TABLE nodes
    ADD CONSTRAINT nodes_payload_schema_version_positive
      CHECK (payload_schema_version IS NULL OR payload_schema_version >= 1),
    ADD CONSTRAINT nodes_payload_authority_status_valid
      CHECK (
        payload_authority_status IS NULL
        OR payload_authority_status IN ('pending', 'backfilled', 'malformed')
      ),
    ADD CONSTRAINT nodes_payload_authority_consistency
      CHECK (
        (
          payload_authority_status IS NULL
          AND payload_json IS NULL
          AND payload_schema_version IS NULL
        )
        OR (
          payload_authority_status = 'pending'
          AND payload_json IS NULL
          AND payload_schema_version IS NULL
        )
        OR (
          payload_authority_status = 'malformed'
          AND payload_json IS NULL
          AND payload_schema_version IS NULL
        )
        OR (
          payload_authority_status = 'backfilled'
          AND payload_json IS NOT NULL
          AND payload_schema_version IS NOT NULL
        )
      )`.execute(db);

  // Deterministic application-level backfill (single source of truth with dual-read).
  await backfillCollections(db);
  await backfillNodes(db);
}

async function backfillCollections(db: Kysely<unknown>): Promise<void> {
  await forEachQueryPage({
    loadPage: async (afterId, limit) => {
      const result = await sql<{
        id: string;
        owner_subject_id: string;
        title: string;
        summary: string | null;
        kind: string;
        visibility: string;
        root_node_id: string;
        resource_revision: string;
        content_revision: string;
        policy_revision: string;
        commit_ordinal: string;
        created_at: Date;
        updated_at: Date;
        deleted_at: Date | null;
      }>`
        SELECT id, owner_subject_id, title, summary, kind, visibility, root_node_id,
               resource_revision, content_revision, policy_revision, commit_ordinal::text AS commit_ordinal,
               created_at, updated_at, deleted_at
        FROM collections
        WHERE ${keysetIdPredicate(afterId)}
        ORDER BY id
        LIMIT ${limit}
      `.execute(db);
      return result.rows;
    },
    visit: async (row) => {
      const projection: CollectionRelationalProjection = {
        id: row.id,
        ownerSubjectId: row.owner_subject_id,
        title: row.title,
        summary: row.summary,
        kind: row.kind,
        visibility: row.visibility,
        rootNodeId: row.root_node_id,
        resourceRevision: row.resource_revision,
        contentRevision: row.content_revision,
        policyRevision: row.policy_revision,
        commitOrdinal: row.commit_ordinal,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deletedAt: row.deleted_at,
      };
      const materialised = materializeCollectionPayload(projection);
      if (!materialised.ok) {
        if (row.deleted_at === null) {
          throw new Error(
            `canonical payload backfill blocked: live collection ${row.id} is malformed `
            + `(${materialised.fieldPath}: ${materialised.reason})`,
          );
        }
        await sql`
          UPDATE collections
          SET payload_json = NULL,
              payload_schema_version = NULL,
              payload_authority_status = 'malformed'
          WHERE id = ${row.id}
        `.execute(db);
        return;
      }
      await sql`
        UPDATE collections
        SET payload_json = ${JSON.stringify(materialised.payload)}::jsonb,
            payload_schema_version = ${RESOURCE_PAYLOAD_SCHEMA_VERSION},
            payload_authority_status = 'backfilled'
        WHERE id = ${row.id}
      `.execute(db);
    },
  });
}

async function backfillNodes(db: Kysely<unknown>): Promise<void> {
  await forEachQueryPage({
    loadPage: async (afterId, limit) => {
      const result = await sql<{
        id: string;
        collection_id: string;
        parent_id: string | null;
        kind: string;
        is_root: boolean;
        title: string;
        url: string | null;
        description: string | null;
        tags: unknown;
        visibility: string;
        position_token: string | null;
        resource_revision: string;
        children_revision: string;
        created_at: Date;
        updated_at: Date;
        deleted_at: Date | null;
        deleted_commit_ordinal: string | null;
      }>`
        SELECT id, collection_id, parent_id, kind, is_root, title, url, description, tags,
               visibility, position_token, resource_revision, children_revision,
               created_at, updated_at, deleted_at,
               deleted_commit_ordinal::text AS deleted_commit_ordinal
        FROM nodes
        WHERE ${keysetIdPredicate(afterId)}
        ORDER BY id
        LIMIT ${limit}
      `.execute(db);
      return result.rows;
    },
    visit: async (row) => {
      const projection: NodeRelationalProjection = {
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
      const materialised = materializeNodePayload(projection);
      if (!materialised.ok) {
        if (row.deleted_at === null) {
          throw new Error(
            `canonical payload backfill blocked: live node ${row.id} is malformed `
            + `(${materialised.fieldPath}: ${materialised.reason})`,
          );
        }
        await sql`
          UPDATE nodes
          SET payload_json = NULL,
              payload_schema_version = NULL,
              payload_authority_status = 'malformed'
          WHERE id = ${row.id}
        `.execute(db);
        return;
      }
      await sql`
        UPDATE nodes
        SET payload_json = ${JSON.stringify(materialised.payload)}::jsonb,
            payload_schema_version = ${RESOURCE_PAYLOAD_SCHEMA_VERSION},
            payload_authority_status = 'backfilled'
        WHERE id = ${row.id}
      `.execute(db);
    },
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Rollback expand only — never drop relational authority columns.
  await sql`ALTER TABLE nodes
    DROP CONSTRAINT IF EXISTS nodes_payload_authority_consistency,
    DROP CONSTRAINT IF EXISTS nodes_payload_authority_status_valid,
    DROP CONSTRAINT IF EXISTS nodes_payload_schema_version_positive`.execute(db);
  await sql`ALTER TABLE nodes
    DROP COLUMN IF EXISTS payload_authority_status,
    DROP COLUMN IF EXISTS payload_schema_version,
    DROP COLUMN IF EXISTS payload_json`.execute(db);

  await sql`ALTER TABLE collections
    DROP CONSTRAINT IF EXISTS collections_payload_authority_consistency,
    DROP CONSTRAINT IF EXISTS collections_payload_authority_status_valid,
    DROP CONSTRAINT IF EXISTS collections_payload_schema_version_positive`.execute(db);
  await sql`ALTER TABLE collections
    DROP COLUMN IF EXISTS payload_authority_status,
    DROP COLUMN IF EXISTS payload_schema_version,
    DROP COLUMN IF EXISTS payload_json`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
