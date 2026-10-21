import { sql, type Kysely } from 'kysely';

/**
 * List pages compare each historical version with the live tree. The stored
 * summary keeps id, kind, parentId, title, url, and the sibling index used by
 * that comparison. Folder children take their index from childIds (first
 * duplicate wins, omitted children are -1). Every other parent keeps snapshot
 * row order. Expand each tree once; correlated rescans become quadratic on
 * real bookmark libraries. Restore continues to read tree_json.
 */
export const backfillCollectionTreeVersionChangeSummariesSql = `
WITH nodes AS MATERIALIZED (
  SELECT version.version_id, elem.ord, elem.node->>'id' AS id,
    elem.node->>'kind' AS kind, elem.node->>'parentId' AS parent_id,
    elem.node->>'title' AS title,
    CASE WHEN jsonb_typeof(elem.node->'url') = 'string' THEN elem.node->>'url' END AS url,
    elem.node->'childIds' AS child_ids,
    (row_number() OVER (PARTITION BY version.version_id, elem.node->>'parentId'
      ORDER BY elem.ord) - 1)::int AS fallback_index
  FROM collection_tree_versions version
  CROSS JOIN LATERAL jsonb_array_elements(version.tree_json)
    WITH ORDINALITY AS elem(node, ord)
), parents AS MATERIALIZED (
  SELECT DISTINCT ON (version_id, id) version_id, id, kind, child_ids
  FROM nodes ORDER BY version_id, id, ord
), child_indexes AS MATERIALIZED (
  SELECT parent.version_id, parent.id AS parent_id, child.id AS child_id,
    (min(child.ord) - 1)::int AS sibling_index
  FROM parents parent
  CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(parent.child_ids, '[]'::jsonb))
    WITH ORDINALITY AS child(id, ord)
  WHERE parent.kind = 'folder'
  GROUP BY parent.version_id, parent.id, child.id
), summaries AS (
  SELECT node.version_id, jsonb_agg(jsonb_build_object(
    'id', node.id, 'kind', node.kind, 'parentId', node.parent_id,
    'title', node.title, 'url', node.url,
    'siblingIndex', CASE WHEN parent.kind = 'folder'
      THEN COALESCE(child.sibling_index, -1) ELSE node.fallback_index END
  ) ORDER BY node.ord) AS summary
  FROM nodes node
  LEFT JOIN parents parent ON parent.version_id=node.version_id AND parent.id=node.parent_id
  LEFT JOIN child_indexes child ON child.version_id=node.version_id
    AND child.parent_id=node.parent_id AND child.child_id=node.id
  GROUP BY node.version_id
)
UPDATE collection_tree_versions version
SET change_summary_json = COALESCE(summary.summary, '[]'::jsonb)
FROM collection_tree_versions source
LEFT JOIN summaries summary ON summary.version_id=source.version_id
WHERE version.version_id=source.version_id
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE collection_tree_versions
    ADD COLUMN change_summary_json jsonb`.execute(db);
  await sql.raw(backfillCollectionTreeVersionChangeSummariesSql).execute(db);
  await sql`ALTER TABLE collection_tree_versions
    ALTER COLUMN change_summary_json SET NOT NULL`.execute(db);
  await sql`ALTER TABLE collection_tree_versions
    ADD CONSTRAINT collection_tree_versions_change_summary_array
    CHECK (jsonb_typeof(change_summary_json) = 'array')`.execute(db);
  await sql`COMMENT ON COLUMN collection_tree_versions.change_summary_json IS
    'List projection of id, kind, parentId, title, url, and siblingIndex. Restore still reads tree_json.'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE collection_tree_versions
    DROP CONSTRAINT IF EXISTS collection_tree_versions_change_summary_array`.execute(db);
  await sql`ALTER TABLE collection_tree_versions
    DROP COLUMN IF EXISTS change_summary_json`.execute(db);
}
