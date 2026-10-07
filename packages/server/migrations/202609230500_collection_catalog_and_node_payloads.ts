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
 * Follow-up to `202609230400_collection_payload_owner_subject_id`.
 *
 * Aligning `payload_json.ownerSubjectId` was not enough for Library writes:
 * seed catalog fields (`tags`, `language`) sat on the collection payload
 * root, and most seed nodes still had a null payload. Canonical lock then
 * failed closed at `tags`, then at the parent node.
 *
 * Move catalog fields into `extensions`, rematerialize catalog-only
 * collection payloads, and backfill missing node payloads. Tombstoned
 * nodes that cannot materialize stay unmarked. `down` is a documented no-op.
 */
function catalogFromPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return {};
  const root = payload as Record<string, unknown>;
  const rawExtensions = root.extensions;
  const extensions = typeof rawExtensions === 'object' && rawExtensions !== null && !Array.isArray(rawExtensions)
    ? { ...rawExtensions as Record<string, unknown> }
    : {};
  const tags = Array.isArray(root.tags) ? root.tags : (Array.isArray(extensions.tags) ? extensions.tags : []);
  const language = typeof root.language === 'string'
    ? root.language
    : (typeof extensions.language === 'string' ? extensions.language : undefined);
  if (tags.length > 0) extensions.tags = tags;
  if (language !== undefined) extensions.language = language;
  return extensions;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE collections
       SET payload_json = jsonb_set(
             payload_json - 'tags' - 'language',
             '{extensions}',
             COALESCE(payload_json->'extensions', '{}'::jsonb)
               || jsonb_strip_nulls(jsonb_build_object(
                    'tags', payload_json->'tags',
                    'language', payload_json->'language'
                  ))
           )
     WHERE payload_json ? 'ownerSubjectId'
       AND (payload_json ? 'tags' OR payload_json ? 'language')
  `.execute(db);

  await forEachQueryPage({
    loadPage: async (afterId, limit) => {
      const result = await sql<{
        id: string;
        owner_subject_id: string;
        title: string;
        summary: string | null;
        kind: string;
        visibility: string;
        allow_search_indexing: boolean;
        root_node_id: string;
        resource_revision: string;
        content_revision: string;
        policy_revision: string;
        commit_ordinal: string;
        created_at: Date;
        updated_at: Date;
        deleted_at: Date | null;
        payload_json: unknown;
      }>`
        SELECT id, owner_subject_id, title, summary, kind, visibility, allow_search_indexing,
               root_node_id, resource_revision, content_revision, policy_revision,
               commit_ordinal::text AS commit_ordinal, created_at, updated_at, deleted_at, payload_json
          FROM collections
         WHERE (payload_json IS NULL OR NOT (payload_json ? 'ownerSubjectId'))
           AND ${keysetIdPredicate(afterId)}
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
      const materialised = materializeCollectionPayload(projection);
      if (!materialised.ok) {
        if (row.deleted_at === null) {
          throw new Error(
            `catalog payload repair blocked: live collection ${row.id} is malformed `
            + `(${materialised.fieldPath}: ${materialised.reason})`,
          );
        }
        return;
      }
      const payload = { ...materialised.payload, extensions: catalogFromPayload(row.payload_json) };
      await sql`
        UPDATE collections
           SET payload_json = ${JSON.stringify(payload)}::jsonb,
               payload_schema_version = ${RESOURCE_PAYLOAD_SCHEMA_VERSION},
               payload_authority_status = 'backfilled'
         WHERE id = ${row.id}
      `.execute(db);
    },
  });

  await forEachQueryPage({
    loadPage: async (afterId, limit) => {
      const result = await sql<{
        id: string;
        collection_id: string;
        parent_id: string | null;
        kind: string;
        is_root: boolean;
        title: string | null;
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
         WHERE payload_json IS NULL
           AND ${keysetIdPredicate(afterId)}
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
            `catalog payload repair blocked: live node ${row.id} is malformed `
            + `(${materialised.fieldPath}: ${materialised.reason})`,
          );
        }
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

/** Data backfill cannot be undone without stealing later application writes. */
export async function down(_db: Kysely<unknown>): Promise<void> {
  // no-op
}

export const migration: Migration = { up, down };
export default migration;
