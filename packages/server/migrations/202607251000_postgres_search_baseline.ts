import { sql, type Kysely, type Migration } from 'kysely';
import { forEachQueryPage, keysetIdPredicate } from './lib/for-each-query-page.js';

interface LegacyNodeUrl {
  readonly id: string;
  readonly url: string | null;
}

function urlHost(value: string | null): string | null {
  if (value === null) return null;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username.length > 0
      || parsed.password.length > 0) return null;
    return parsed.hostname.normalize('NFKC').toLocaleLowerCase('und');
  } catch {
    return null;
  }
}

/** Install and locate pg_trgm. Search must not silently fall back to an unindexed scan. */
export async function ensurePgTrgm<Database>(db: Kysely<Database>): Promise<void> {
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public`.execute(db);
  } catch (error: unknown) {
    throw new Error(
      'pg_trgm is required for Phase 2B search; run as the database owner: '
      + '`CREATE EXTENSION pg_trgm WITH SCHEMA public`, then retry the migration. '
      + `PostgreSQL reported: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const installed = await sql<{
    schema_name: string;
    extversion: string;
    schema_usage: boolean;
    function_execute: boolean;
    word_similarity_oid: string | null;
    similarity_operator_oid: string | null;
    gin_opclass_count: number;
  }>`select n.nspname as schema_name, e.extversion,
      has_schema_privilege(current_user, n.oid, 'USAGE') as schema_usage,
      coalesce(has_function_privilege(current_user,
        to_regprocedure('public.word_similarity(text,text)'), 'EXECUTE'), false) as function_execute,
      to_regprocedure('public.word_similarity(text,text)')::text as word_similarity_oid,
      to_regoperator('public.<%(text,text)')::text as similarity_operator_oid,
      (select count(*)::integer from pg_opclass oc join pg_namespace on pg_namespace.oid=oc.opcnamespace
        where pg_namespace.nspname='public' and oc.opcname='gin_trgm_ops') as gin_opclass_count
    from pg_extension e join pg_namespace n on n.oid=e.extnamespace
    where e.extname='pg_trgm'`.execute(db);
  const extension = installed.rows[0];
  if (extension?.schema_name !== 'public' || !extension.extversion
    || !extension.schema_usage || !extension.function_execute
    || !extension.word_similarity_oid || !extension.similarity_operator_oid
    || extension.gin_opclass_count !== 1) {
    throw new Error(
      'pg_trgm is required for Phase 2B search in schema public with USAGE, EXECUTE, '
      + 'public.<%(text,text), and public.gin_trgm_ops available to the application role; '
      + 'ask the database owner to repair grants or move/reinstall the extension before retrying. '
      + 'Search will not fall back to an unindexed scan.',
    );
  }
}

/** Expand-only P2B-21 synchronous PostgreSQL Collection/Node search baseline. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await ensurePgTrgm(db);

  await sql`ALTER TABLE collections
    ADD COLUMN allow_search_indexing boolean NOT NULL DEFAULT false,
    ADD COLUMN search_text text GENERATED ALWAYS AS (
      lower(normalize(coalesce(title, '') || ' ' || coalesce(summary, ''), NFKC))
    ) STORED,
    ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A') ||
      setweight(to_tsvector('english'::regconfig, coalesce(summary, '')), 'B')
    ) STORED`.execute(db);

  await sql`ALTER TABLE nodes
    ADD COLUMN search_url_host text,
    ADD COLUMN search_text text GENERATED ALWAYS AS (
      lower(normalize(coalesce(title, '') || ' ' || coalesce(description, '')
        || ' ' || coalesce(search_url_host, ''), NFKC))
    ) STORED,
    ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A') ||
      setweight(to_tsvector('english'::regconfig, coalesce(description, '')), 'B') ||
      setweight(to_tsvector('simple'::regconfig, coalesce(search_url_host, '')), 'C')
    ) STORED`.execute(db);
  await sql`CREATE INDEX collections_search_vector_idx ON collections USING gin (search_vector)
    WHERE deleted_at IS NULL AND visibility='public' AND allow_search_indexing`.execute(db);
  await sql`CREATE INDEX collections_search_trgm_idx ON collections
    USING gin (search_text public.gin_trgm_ops)
    WHERE deleted_at IS NULL AND visibility='public' AND allow_search_indexing`.execute(db);
  await sql`CREATE INDEX collections_search_authority_order_idx ON collections(
      visibility, allow_search_indexing, id COLLATE "C"
    ) WHERE deleted_at IS NULL`.execute(db);
  await sql`CREATE INDEX nodes_search_vector_idx ON nodes USING gin (search_vector)
    WHERE deleted_at IS NULL AND NOT is_root AND visibility='inherit'`.execute(db);
  await sql`CREATE INDEX nodes_search_trgm_idx ON nodes
    USING gin (search_text public.gin_trgm_ops)
    WHERE deleted_at IS NULL AND NOT is_root AND visibility='inherit'`.execute(db);
  await sql`CREATE INDEX nodes_search_authority_order_idx ON nodes(
      collection_id, visibility, id COLLATE "C"
    ) WHERE deleted_at IS NULL AND NOT is_root`.execute(db);

  // Run data changes only after all DDL. Existing deferred FK trigger events make
  // subsequent ALTER TABLE / CREATE INDEX statements illegal in one migration transaction.
  await forEachQueryPage({
    loadPage: async (afterId, limit) => {
      const result = await sql<LegacyNodeUrl>`
        select id, url from nodes
        where ${keysetIdPredicate(afterId)}
        order by id
        limit ${limit}
      `.execute(db);
      return result.rows;
    },
    visit: async (node) => {
      await sql`update nodes set search_url_host=${urlHost(node.url)} where id=${node.id}`.execute(db);
    },
  });
  await sql`UPDATE collections SET payload_json = jsonb_set(
      payload_json::jsonb, '{allowSearchIndexing}', 'false'::jsonb, true
    ) WHERE payload_json IS NOT NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS nodes_search_authority_order_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS nodes_search_trgm_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS nodes_search_vector_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS collections_search_authority_order_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS collections_search_trgm_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS collections_search_vector_idx`.execute(db);
  await sql`ALTER TABLE nodes DROP COLUMN IF EXISTS search_vector,
    DROP COLUMN IF EXISTS search_text, DROP COLUMN IF EXISTS search_url_host`.execute(db);
  await sql`ALTER TABLE collections DROP COLUMN IF EXISTS search_vector,
    DROP COLUMN IF EXISTS search_text, DROP COLUMN IF EXISTS allow_search_indexing`.execute(db);
  await sql`UPDATE collections SET payload_json = payload_json::jsonb - 'allowSearchIndexing'
    WHERE payload_json IS NOT NULL`.execute(db);
  // pg_trgm may serve other schemas/features and is intentionally retained.
}

export const migration: Migration = { up, down };
export default migration;
