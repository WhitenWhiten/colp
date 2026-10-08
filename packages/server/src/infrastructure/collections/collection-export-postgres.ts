import type { Kysely } from 'kysely';
import type {
  CollectionExportReadPort,
  ExportAnnotationSource,
  ExportCollectionSource,
  ExportNodeSource,
  ExportRelationSource,
} from '../../modules/collections/application/export-collection.js';
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
