import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Reduce user-authored Annotation values to non-executable, bounded text.
 * The result is only a candidate snippet source; P2B-23 still re-authorizes the
 * current resource before it may become a Product response.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE FUNCTION search_strip_unsafe_text(input text)
    RETURNS text
    LANGUAGE plpgsql
    IMMUTABLE
    STRICT
    PARALLEL SAFE
    SET search_path FROM CURRENT
    AS $$
    DECLARE
      cleaned text := normalize(input, NFKC);
      codepoint integer;
    BEGIN
      cleaned := replace(replace(replace(replace(replace(cleaned,
        '&nbsp;', ' '), '&lt;', '<'), '&gt;', '>'), '&amp;', '&'), '&quot;', '"');
      cleaned := regexp_replace(cleaned, '<(script|style)(?:\\s[^>]*)?>.*?</\\1\\s*>', ' ', 'gis');
      cleaned := regexp_replace(cleaned, '<!--.*?-->', ' ', 'gs');
      cleaned := regexp_replace(cleaned, '!?\\[([^]]*)\\]\\([^)]*\\)', '\\1', 'g');
      cleaned := regexp_replace(cleaned, '<[^>]*>', ' ', 'g');
      FOR codepoint IN 1..31 LOOP
        cleaned := replace(cleaned, chr(codepoint), ' ');
      END LOOP;
      FOR codepoint IN 127..159 LOOP
        cleaned := replace(cleaned, chr(codepoint), ' ');
      END LOOP;
      FOREACH codepoint IN ARRAY ARRAY[1564,8206,8207,8234,8235,8236,8237,8238,8294,8295,8296,8297]
      LOOP
        cleaned := replace(cleaned, chr(codepoint), '');
      END LOOP;
      cleaned := regexp_replace(cleaned, '\\s+', ' ', 'g');
      RETURN substring(btrim(cleaned) from 1 for 1024);
    END
    $$`.execute(db);

  await sql`CREATE FUNCTION search_safe_annotation_text(value_json jsonb, annotation_format text)
    RETURNS text
    LANGUAGE plpgsql
    IMMUTABLE
    STRICT
    PARALLEL SAFE
    SET search_path FROM CURRENT
    AS $$
    DECLARE
      source text := '';
    BEGIN
      IF annotation_format IN ('plain','markdown','html') AND jsonb_typeof(value_json) = 'string' THEN
        source := value_json #>> '{}';
      ELSIF annotation_format = 'json' AND jsonb_typeof(value_json) = 'object' THEN
        SELECT coalesce(string_agg(scalar #>> '{}', ' ' ORDER BY key), '') INTO source
          FROM jsonb_each(value_json) AS entry(key, scalar)
         WHERE key = ANY(ARRAY['content','description','quote','summary','text','title'])
           AND jsonb_typeof(scalar) IN ('string','number','boolean');
      END IF;
      RETURN search_strip_unsafe_text(source);
    END
    $$`.execute(db);

  await sql`ALTER TABLE profile_handles
    ADD COLUMN search_handle text GENERATED ALWAYS AS (
      lower(normalize(handle, NFKC))
    ) STORED`.execute(db);
  await sql`ALTER TABLE profiles
    ADD COLUMN search_display_name text GENERATED ALWAYS AS (
      lower(normalize(display_name, NFKC))
    ) STORED,
    ADD COLUMN search_display_vector tsvector GENERATED ALWAYS AS (
      to_tsvector('simple'::regconfig, normalize(display_name, NFKC))
    ) STORED`.execute(db);
  await sql`ALTER TABLE annotations
    ADD COLUMN annotation_search_text text GENERATED ALWAYS AS (
      search_safe_annotation_text(value_json, format)
    ) STORED,
    ADD COLUMN annotation_search_vector tsvector GENERATED ALWAYS AS (
      to_tsvector('simple'::regconfig, search_safe_annotation_text(value_json, format))
    ) STORED`.execute(db);

  await sql`CREATE INDEX profile_handles_search_exact_prefix_idx
    ON profile_handles (search_handle COLLATE "C" text_pattern_ops)`.execute(db);
  await sql`CREATE INDEX profile_handles_search_trgm_idx
    ON profile_handles USING gist (search_handle public.gist_trgm_ops(siglen=32))`.execute(db);
  await sql`CREATE INDEX profiles_search_display_trgm_idx
    ON profiles USING gin (search_display_name public.gin_trgm_ops)`.execute(db);
  await sql`CREATE INDEX profiles_search_display_vector_idx
    ON profiles USING gin (search_display_vector)`.execute(db);
  await sql`CREATE INDEX collections_search_profile_owner_idx
    ON collections (owner_subject_id)
    WHERE deleted_at IS NULL AND visibility='public' AND allow_search_indexing=true`.execute(db);

  await sql`CREATE INDEX annotations_search_trgm_idx
    ON annotations USING gin (annotation_search_text public.gin_trgm_ops)
    WHERE deleted_at IS NULL AND visibility='public' AND type <> 'reading_state'`.execute(db);
  await sql`CREATE INDEX annotations_search_vector_idx
    ON annotations USING gin (annotation_search_vector)
    WHERE deleted_at IS NULL AND visibility='public' AND type <> 'reading_state'`.execute(db);
  await sql`CREATE INDEX annotations_search_authority_order_idx
    ON annotations (collection_id, subject_type COLLATE "C", subject_id COLLATE "C", id COLLATE "C")
    WHERE deleted_at IS NULL AND visibility='public' AND type <> 'reading_state'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS annotations_search_authority_order_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS annotations_search_vector_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS annotations_search_trgm_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS collections_search_profile_owner_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS profiles_search_display_vector_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS profiles_search_display_trgm_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS profile_handles_search_trgm_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS profile_handles_search_exact_prefix_idx`.execute(db);
  await sql`ALTER TABLE annotations
    DROP COLUMN IF EXISTS annotation_search_vector,
    DROP COLUMN IF EXISTS annotation_search_text`.execute(db);
  await sql`ALTER TABLE profiles
    DROP COLUMN IF EXISTS search_display_vector,
    DROP COLUMN IF EXISTS search_display_name`.execute(db);
  await sql`ALTER TABLE profile_handles DROP COLUMN IF EXISTS search_handle`.execute(db);
  await sql`DROP FUNCTION IF EXISTS search_safe_annotation_text(jsonb,text)`.execute(db);
  await sql`DROP FUNCTION IF EXISTS search_strip_unsafe_text(text)`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
