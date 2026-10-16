import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork } from '../database/unit-of-work.js';
import { COLLECTION_OWNER_LIVE_SQL, buildPublicationTargetAncestorRestrictionSql,
  collectionHidePublicControlSql, bookmarkHidePublicExistsSql } from '../database/collection-control-sql.js';
import type { PublicFolderShareReadPort } from '../../modules/publication/application/folder-share-public-query.js';
import type { ProductPublicCollectionNode, ProductPublicCollectionPage } from '../../modules/publication/application/product-public-query.js';

export function createPostgresPublicFolderShareReadPort(db: Kysely<DatabaseSchema>): PublicFolderShareReadPort {
  return { load(slug, includeRelations = false) { return createUnitOfWork(db, { isolationLevel: 'repeatable read' }).execute(async ({ transaction: tx }) => {
    const target = await sql<{ id: string; collection_id: string; node_id: string; owner_subject_id: string;
      title: string; description: string | null; content_revision: string; policy_revision: string; updated_at: Date }>`
      SELECT s.id, s.collection_id, s.node_id, c.owner_subject_id, folder.title, folder.description,
        c.content_revision, c.policy_revision, folder.updated_at
      FROM folder_shares s JOIN collections c ON c.id = s.collection_id
      JOIN nodes folder ON folder.id = s.node_id AND folder.collection_id = c.id
      WHERE s.slug = ${slug} AND s.revoked_at IS NULL AND c.is_library AND c.deleted_at IS NULL
        AND folder.kind = 'folder' AND NOT folder.is_root AND folder.deleted_at IS NULL
        AND ${sql.raw(COLLECTION_OWNER_LIVE_SQL)} AND ${sql.raw(collectionHidePublicControlSql('c'))}
        AND NOT ${sql.raw(buildPublicationTargetAncestorRestrictionSql('folder'))}`.execute(tx);
    const share = target.rows[0]; if (!share) return null;
    const rows = await sql<NodeRow>`WITH RECURSIVE visible AS (
      SELECT n.*, ARRAY[n.id] AS path FROM nodes n WHERE n.id = ${share.node_id} AND n.collection_id = ${share.collection_id}
      UNION ALL SELECT n.*, parent.path || n.id FROM nodes n JOIN visible parent ON n.parent_id = parent.id
        AND n.collection_id = parent.collection_id
        WHERE n.deleted_at IS NULL AND n.visibility = 'inherit' AND NOT n.id = ANY(parent.path)
          AND cardinality(parent.path) < 256
    ) SELECT n.id, n.parent_id, n.kind, n.title, n.url, n.description, n.position_token, n.updated_at
      FROM visible n WHERE n.kind IN ('folder','bookmark')
        AND NOT ${sql.raw(bookmarkHidePublicExistsSql('n.id', 'n.collection_id'))}
      ORDER BY (n.id = ${share.node_id}) DESC, n.parent_id COLLATE "C", n.position_token COLLATE "C", n.id COLLATE "C"`.execute(tx);
    const nodeIds = rows.rows.map(row => row.id);
    const annotations = await tx.selectFrom('annotations').select(['subject_id', 'type', 'value_json'])
      .where('collection_id', '=', share.collection_id).where('subject_type', '=', 'node')
      .where('subject_id', 'in', nodeIds).where('type', 'in', ['tldr', 'note'])
      .where('visibility', '=', 'public').where('deleted_at', 'is', null)
      .orderBy('updated_at', 'desc').orderBy('id').execute();
    const marks = new Map<string, { note?: string; tldr?: string }>();
    for (const annotation of annotations) {
      // Structured annotations can contain resource references. The public page
      // exposes text marks only; collection and outside-folder subjects never enter this query.
      if (typeof annotation.value_json !== 'string' || !['tldr', 'note'].includes(annotation.type)) continue;
      const value = marks.get(annotation.subject_id) ?? {};
      const type = annotation.type as 'tldr' | 'note';
      value[type] ??= annotation.value_json; marks.set(annotation.subject_id, value);
    }
    const relations = includeRelations ? await tx.selectFrom('relations').select(['id', 'from_node_id', 'to_node_id', 'type', 'label'])
      .where('collection_id', '=', share.collection_id).where('deleted_at', 'is', null).where('visibility', '=', 'public')
      .where('from_node_id', 'in', nodeIds).where('to_node_id', 'in', nodeIds).orderBy('id').execute() : [];
    const nodes: ProductPublicCollectionNode[] = rows.rows.map(row => ({ id: row.id,
      parentId: row.id === share.node_id ? null : row.parent_id, kind: row.id === share.node_id ? 'root' : row.kind,
      title: row.title, description: row.description, url: row.kind === 'bookmark' ? row.url : null,
      position: row.id === share.node_id ? null : row.position_token, iconUrl: null,
      ...(row.kind === 'bookmark' ? { faviconCdnAllowed: false, previewImage: null } : {}), ...marks.get(row.id) }));
    return { shareId: share.id, collectionId: share.collection_id, ownerSubjectId: share.owner_subject_id,
      title: share.title, description: share.description, rootId: share.node_id,
      updatedAt: new Date(Math.max(...rows.rows.map(row => row.updated_at.getTime()))).toISOString(),
      revision: `${share.content_revision}:${share.policy_revision}`, nodes,
      relations: relations.map(row => ({ id: row.id, fromNodeId: row.from_node_id, toNodeId: row.to_node_id,
        type: row.type, ...(row.label === null ? {} : { label: row.label }) })) as NonNullable<ProductPublicCollectionPage['relations']> };
  }); } };
}
interface NodeRow { id: string; parent_id: string | null; kind: 'folder' | 'bookmark'; title: string;
  url: string | null; description: string | null; position_token: string | null; updated_at: Date }
