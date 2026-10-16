import { projectPublicNode } from '../../modules/publication/application/public-page-projection.js';
import { readPublicNodeMarks } from './postgres-public-marks-read.js';
import { CompiledQuery, sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork } from '../database/unit-of-work.js';
import { COLLECTION_OWNER_LIVE_SQL, buildPublicationTargetAncestorRestrictionSql,
  collectionHidePublicControlSql, bookmarkHidePublicExistsSql } from '../database/collection-control-sql.js';
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
        AND ${sql.raw(COLLECTION_OWNER_LIVE_SQL)} AND ${sql.raw(collectionHidePublicControlSql('c'))}
        AND NOT ${sql.raw(buildPublicationTargetAncestorRestrictionSql('folder'))}`.execute(tx);
    const share = target.rows[0]; if (!share) return null;
    // Root is first; all remaining entities use immutable ids in C order.
    // LIMIT includes one lookahead row. Never load a whole subtree or its marks.
    const rows: NodeRow[] = input.position ? [] : [share];
    if (input.position?.phase !== 'relations') {
      const descendants = await sql<NodeRow>`SELECT n.id, n.parent_id, n.kind, n.title, n.url,
          n.description, n.position_token, n.updated_at FROM nodes n
        WHERE n.collection_id = ${share.collection_id} AND n.id <> ${share.id}
          AND n.id COLLATE "C" > ${input.position?.after ?? ''}
          AND n.deleted_at IS NULL AND n.kind IN ('folder', 'bookmark')
          AND ${visibleMember('n', share.id)}
          AND NOT ${sql.raw(bookmarkHidePublicExistsSql('n.id', 'n.collection_id'))}
        ORDER BY n.id COLLATE "C" LIMIT ${input.limit + 1 - rows.length}`.execute(tx);
      rows.push(...descendants.rows);
    }
    const relationRows = input.includeRelations && rows.length <= input.limit
      ? (await sql<RelationRow>`SELECT r.id, r.from_node_id, r.to_node_id, r.type, r.label FROM relations r
          JOIN nodes source ON source.id = r.from_node_id AND source.collection_id = r.collection_id
          JOIN nodes destination ON destination.id = r.to_node_id AND destination.collection_id = r.collection_id
          WHERE r.collection_id = ${share.collection_id} AND r.deleted_at IS NULL AND r.visibility = 'public'
            AND r.id COLLATE "C" > ${input.position?.phase === 'relations' ? input.position.after : ''}
            AND ${visibleMember('source', share.id)} AND ${visibleMember('destination', share.id)}
            AND NOT ${sql.raw(bookmarkHidePublicExistsSql('source.id', 'source.collection_id'))}
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

/** Walk only a candidate's ancestors. The page scan never recursively enumerates the subtree. */
function visibleMember(alias: string, rootId: string) {
  return sql`EXISTS (WITH RECURSIVE lineage AS (
    SELECT member.id, member.parent_id, member.collection_id, ARRAY[member.id] AS path FROM nodes member
      WHERE member.id = ${sql.ref(`${alias}.id`)} AND member.collection_id = ${sql.ref(`${alias}.collection_id`)}
        AND member.deleted_at IS NULL AND member.visibility = 'inherit'
    UNION ALL SELECT parent.id, parent.parent_id, parent.collection_id, child.path || parent.id
      FROM nodes parent JOIN lineage child ON parent.id = child.parent_id AND parent.collection_id = child.collection_id
      WHERE child.id <> ${rootId} AND parent.deleted_at IS NULL AND parent.visibility = 'inherit'
        AND NOT parent.id = ANY(child.path) AND cardinality(child.path) < 256
  ) SELECT 1 FROM lineage WHERE id = ${rootId})`;
}
interface NodeRow { id: string; parent_id: string | null; kind: 'folder' | 'bookmark'; title: string;
  url: string | null; description: string | null; position_token: string | null; updated_at: Date }
interface RelationRow { id: string; from_node_id: string; to_node_id: string; type: string; label: string | null }
