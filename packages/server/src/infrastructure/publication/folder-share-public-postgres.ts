import { folderSharePublicationAllowedSql } from './folder-share-access.js';
import { projectPublicNode } from '../../modules/publication/application/public-page-projection.js';
import { readPublicNodeMarks } from './postgres-public-marks-read.js';
import { CompiledQuery, sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork } from '../database/unit-of-work.js';
import { buildPublicationTargetAncestorRestrictionSql, bookmarkHidePublicExistsSql } from '../database/collection-control-sql.js';
import type { FolderSharePosition, PublicFolderShareReadPort } from '../../modules/publication/application/folder-share-public-query.js';
import type { ProductPublicCollectionNode, ProductPublicCollectionPage } from '../../modules/publication/application/product-public-query.js';

export function createPostgresPublicFolderShareReadPort(db: Kysely<DatabaseSchema>): PublicFolderShareReadPort {
  return { load(slug, input) { return createUnitOfWork(db, { isolationLevel: 'repeatable read' }).execute(async ({ transaction: tx }) => {
    const target = await sql<NodeRow & { share_id: string; collection_id: string; owner_subject_id: string }>`
      SELECT folder.id, folder.parent_id, folder.kind, folder.title, folder.url, folder.description,
        folder.position_token, folder.updated_at, s.id AS share_id, c.id AS collection_id, c.owner_subject_id
      FROM folder_shares s JOIN collections c ON c.id = s.collection_id
      JOIN nodes folder ON folder.id = s.node_id AND folder.collection_id = c.id
      WHERE s.slug = ${slug} AND s.revoked_at IS NULL AND c.is_library AND c.deleted_at IS NULL
        AND folder.kind = 'folder' AND NOT folder.is_root AND folder.deleted_at IS NULL
        AND ${sql.raw(folderSharePublicationAllowedSql('c'))}
        AND NOT ${sql.raw(buildPublicationTargetAncestorRestrictionSql('folder'))}`.execute(tx);
    const share = target.rows[0]; if (!share) return null;
    // Root is first; all remaining entities use immutable ids in C order.
    // LIMIT includes one lookahead row; only returned nodes have their marks loaded.
    const rows: NodeRow[] = input.position ? [] : [share];
    if (input.position?.phase !== 'relations') {
      const descendants = await sql<NodeRow>`WITH RECURSIVE ${visibleSubtree(share.id, share.collection_id)} SELECT n.id, n.parent_id, n.kind, n.title, n.url,
          n.description, n.position_token, n.updated_at FROM visible_subtree n
        WHERE n.collection_id = ${share.collection_id} AND n.id <> ${share.id}
          AND n.id COLLATE "C" > ${input.position?.after ?? ''}
          AND NOT ${sql.raw(bookmarkHidePublicExistsSql('n.id', 'n.collection_id'))}
        ORDER BY n.id COLLATE "C" LIMIT ${input.limit + 1 - rows.length}`.execute(tx);
      rows.push(...descendants.rows);
    }
    const relationRows = input.includeRelations && rows.length <= input.limit
      ? (await sql<RelationRow>`WITH RECURSIVE ${visibleSubtree(share.id, share.collection_id)} SELECT r.id, r.from_node_id, r.to_node_id, r.type, r.label FROM visible_subtree source
          JOIN LATERAL (SELECT relation.* FROM relations relation
            WHERE relation.collection_id = ${share.collection_id} AND relation.from_node_id = source.id
              AND relation.deleted_at IS NULL AND relation.visibility = 'public'
              AND relation.id COLLATE "C" > ${input.position?.phase === 'relations' ? input.position.after : ''}
            OFFSET 0) r ON true
          JOIN visible_subtree destination ON destination.id = r.to_node_id
          WHERE NOT ${sql.raw(bookmarkHidePublicExistsSql('source.id', 'source.collection_id'))}
            AND NOT ${sql.raw(bookmarkHidePublicExistsSql('destination.id', 'destination.collection_id'))}
          ORDER BY r.id COLLATE "C" LIMIT ${input.limit + 1 - rows.length}`.execute(tx)).rows : [];
    const hasMore = rows.length + relationRows.length > input.limit;
    const selected = rows.slice(0, input.limit);
    const relations = relationRows.slice(0, input.limit - selected.length);
    const lastRelation = relations.at(-1), lastNode = selected.at(-1);
    const nextPosition: FolderSharePosition | null = !hasMore ? null : lastRelation
      ? { phase: 'relations', after: lastRelation.id }
      : { phase: 'nodes', after: lastNode!.id === share.id ? '' : lastNode!.id };
    const nodeIds = selected.map(row => row.id);
    const marks = await readPublicNodeMarks({
      async query<Row extends import('pg').QueryResultRow>(text: string, values: unknown[]) {
        return tx.executeQuery<Row>(CompiledQuery.raw(text, values));
      },
    }, share.collection_id, nodeIds, { textOnly: true });
    const nodes: ProductPublicCollectionNode[] = selected.map(row => projectPublicNode({
      id: row.id,
      parentId: row.id === share.id ? null : row.parent_id, kind: row.id === share.id ? 'root' : row.kind,
      title: row.title, description: row.description, ...(row.kind === 'bookmark' ? { url: row.url } : {}),
      position: row.id === share.id ? null : row.position_token,
    }, new Map(), undefined, marks, new Map(), false));
    return { shareId: share.share_id, collectionId: share.collection_id, ownerSubjectId: share.owner_subject_id,
      title: share.title, description: share.description, rootId: share.id, updatedAt: share.updated_at.toISOString(),
      nextPosition, nodes,
      relations: relations.map(row => ({ id: row.id, fromNodeId: row.from_node_id, toNodeId: row.to_node_id,
        type: row.type, ...(row.label === null ? {} : { label: row.label }) })) as NonNullable<ProductPublicCollectionPage['relations']> };
  }); } };
}

/** Start at the share and use parent indexes, so unrelated library nodes are never candidates. */
function visibleSubtree(rootId: string, collectionId: string) {
  return sql`visible_subtree AS (
    SELECT member.id, member.parent_id, member.collection_id, member.kind, member.title, member.url,
      member.description, member.position_token, member.updated_at, ARRAY[member.id] AS path
      FROM nodes member WHERE member.id = ${rootId} AND member.collection_id = ${collectionId}
        AND member.deleted_at IS NULL AND member.visibility = 'inherit'
    UNION ALL
    SELECT child.id, child.parent_id, child.collection_id, child.kind, child.title, child.url,
      child.description, child.position_token, child.updated_at, parent.path || child.id
      FROM visible_subtree parent
      JOIN LATERAL (SELECT n.* FROM nodes n
        WHERE n.collection_id = ${collectionId} AND n.parent_id = parent.id
          AND n.deleted_at IS NULL AND n.visibility = 'inherit' AND n.kind IN ('folder', 'bookmark')
          AND NOT n.id = ANY(parent.path)
        OFFSET 0) child ON true
      WHERE parent.kind = 'folder' AND cardinality(parent.path) < 256
  )`;
}
interface NodeRow { id: string; parent_id: string | null; kind: 'folder' | 'bookmark'; title: string;
  url: string | null; description: string | null; position_token: string | null; updated_at: Date }
interface RelationRow { id: string; from_node_id: string; to_node_id: string; type: string; label: string | null }
