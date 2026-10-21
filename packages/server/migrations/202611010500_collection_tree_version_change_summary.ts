import { sql, type Kysely } from 'kysely';

/**
 * List pages compare each historical version with the live tree. The stored
 * summary keeps id, kind, parentId, title, url, and the sibling index used by
 * that comparison. Folder children take their index from childIds (first
 * duplicate wins, omitted children are -1). Every other parent keeps snapshot
 * row order. Restore continues to read tree_json.
 */
export const backfillCollectionTreeVersionChangeSummariesSql = `
UPDATE collection_tree_versions AS version
SET change_summary_json = (
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', elem.node->>'id',
        'kind', elem.node->>'kind',
        'parentId', elem.node->>'parentId',
        'title', elem.node->>'title',
        'url', CASE
          WHEN jsonb_typeof(elem.node->'url') = 'string' THEN elem.node->'url'
          ELSE 'null'::jsonb
        END,
        'siblingIndex', CASE
          WHEN parent_row.node->>'kind' = 'folder' THEN COALESCE((
            SELECT (child.ord - 1)::int
            FROM jsonb_array_elements_text(COALESCE(parent_row.node->'childIds', '[]'::jsonb))
              WITH ORDINALITY AS child(child_id, ord)
            WHERE child.child_id = elem.node->>'id'
            ORDER BY child.ord
            LIMIT 1
          ), -1)
          ELSE (
            SELECT COUNT(*)::int
            FROM jsonb_array_elements(version.tree_json) WITH ORDINALITY AS earlier(earlier_node, earlier_ord)
            WHERE earlier.earlier_ord < elem.node_ord
              AND earlier.earlier_node->>'parentId' IS NOT DISTINCT FROM elem.node->>'parentId'
          )
        END
      )
      ORDER BY elem.node_ord
    ),
    '[]'::jsonb
  )
  FROM jsonb_array_elements(version.tree_json) WITH ORDINALITY AS elem(node, node_ord)
  LEFT JOIN LATERAL (
    SELECT candidate AS node
    FROM jsonb_array_elements(version.tree_json) AS candidate
    WHERE candidate->>'id' = elem.node->>'parentId'
    LIMIT 1
  ) AS parent_row ON true
)
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
