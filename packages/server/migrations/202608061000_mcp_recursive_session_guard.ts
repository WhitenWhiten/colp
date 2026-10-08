import { sql, type Kysely, type Migration } from 'kysely';

const LEGACY_KEYS_SQL = sql.raw(`(
  'sessionid', 'session_id', 'mcp-session-id', 'mcpsessionid',
  'mcp_session_id', 'session'
)`);

/** Reject Legacy MCP Session keys at any object depth, including objects in arrays. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION mcp_json_has_legacy_session_key(value jsonb)
    RETURNS boolean
    LANGUAGE sql
    IMMUTABLE
    STRICT
    AS $function$
      WITH RECURSIVE json_tree(node) AS (
        SELECT value
        UNION ALL
        SELECT child.node
          FROM json_tree parent
          CROSS JOIN LATERAL (
            SELECT entry.value AS node
              FROM jsonb_each(
                CASE WHEN jsonb_typeof(parent.node) = 'object'
                  THEN parent.node ELSE '{}'::jsonb END
              ) entry
            UNION ALL
            SELECT entry.value AS node
              FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(parent.node) = 'array'
                  THEN parent.node ELSE '[]'::jsonb END
              ) entry
          ) child
      )
      SELECT EXISTS (
        SELECT 1
          FROM json_tree candidate
          CROSS JOIN LATERAL jsonb_object_keys(
            CASE WHEN jsonb_typeof(candidate.node) = 'object'
              THEN candidate.node ELSE '{}'::jsonb END
          ) legacy_key
         WHERE lower(legacy_key) IN ${LEGACY_KEYS_SQL}
      )
    $function$`.execute(db);
}

/** Restore the original top-level guard when this migration is rolled back. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION mcp_json_has_legacy_session_key(value jsonb)
    RETURNS boolean
    LANGUAGE sql
    IMMUTABLE
    STRICT
    AS $function$
      SELECT CASE WHEN jsonb_typeof(value) = 'object' THEN EXISTS (
        SELECT 1 FROM jsonb_object_keys(value) AS legacy_key
        WHERE lower(legacy_key) IN ${LEGACY_KEYS_SQL}
      ) ELSE false END
    $function$`.execute(db);
}

const migration: Migration = { up, down };
export default migration;
