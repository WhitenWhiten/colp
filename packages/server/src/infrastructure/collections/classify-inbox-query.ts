import { sql, type Kysely } from 'kysely';
import type {
  ClassifyInboxBookmarkRow,
  ClassifyInboxFolderRow,
  ClassifyInboxReadInput,
  ClassifyInboxReadPort,
} from '../../modules/collections/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { DatabaseSchema } from '../database/runtime.js';

const nodeIdKey = sql<string>`n.id COLLATE "C"`;

export function createPostgresClassifyInboxReadPort(
  transaction: DatabaseTransaction | Kysely<DatabaseSchema>,
): ClassifyInboxReadPort {
  return {
    async listInboxBookmarks(input: ClassifyInboxReadInput) {
      const actor = input.ownerSubjectId;
      let query = transaction.selectFrom('nodes as n')
        .innerJoin('collections as c', 'c.id', 'n.collection_id')
        .innerJoin('nodes as parent', 'parent.id', 'n.parent_id')
        .select([
          'n.id as node_id',
          'n.collection_id',
          'c.title as collection_title',
          'n.title',
          'n.url',
          'n.resource_revision',
          'n.created_at',
        ])
        .where('c.deleted_at', 'is', null)
        .where('c.owner_subject_id', '=', actor)
        .where('n.deleted_at', 'is', null)
        .where('n.kind', '=', 'bookmark')
        .where('n.url', 'is not', null)
        .where(sql<boolean>`n.url <> ''`)
        .where('parent.is_root', '=', true)
        .where('parent.deleted_at', 'is', null)
        .whereRef('parent.collection_id', '=', 'n.collection_id')
        .where(sql<boolean>`NOT EXISTS (
          SELECT 1
          FROM collection_classify_inbox_decision AS d
          WHERE d.node_id = n.id
        )`);
      if (input.after) {
        query = query.where(sql<boolean>`(
          n.created_at < ${input.after.createdAt}
          OR (
            n.created_at = ${input.after.createdAt}
            AND ${nodeIdKey} < ${input.after.nodeId}::text COLLATE "C"
          )
        )`);
      }
      const rows = await query
        .orderBy('n.created_at', 'desc')
        .orderBy(nodeIdKey, 'desc')
        .limit(input.limit + 1)
        .execute();
      return rows.flatMap((row): ClassifyInboxBookmarkRow[] => {
        if (row.url === null) return [];
        return [{
          nodeId: row.node_id,
          collectionId: row.collection_id,
          collectionTitle: row.collection_title,
          title: row.title ?? '',
          url: row.url,
          resourceRevision: row.resource_revision,
          createdAt: row.created_at,
          isOwner: true,
          kind: 'bookmark',
          softDeleted: false,
          parentKind: 'root',
          hasSidecar: false,
        }];
      });
    },
    async listLiveFolders(input) {
      if (input.collectionIds.length === 0) return [];
      const rows = await transaction.selectFrom('nodes as f')
        .innerJoin('collections as c', 'c.id', 'f.collection_id')
        .select(['f.id as folder_id', 'f.title as folder_title', 'f.collection_id'])
        .where('c.deleted_at', 'is', null)
        .where('c.owner_subject_id', '=', input.ownerSubjectId)
        .where('f.deleted_at', 'is', null)
        .where('f.kind', '=', 'folder')
        .where('f.is_root', '=', false)
        .where('f.collection_id', 'in', [...input.collectionIds])
        .execute();
      return rows.map((row): ClassifyInboxFolderRow => ({
        collectionId: row.collection_id,
        folderId: row.folder_id,
        folderTitle: row.folder_title ?? '',
      }));
    },
  };
}
