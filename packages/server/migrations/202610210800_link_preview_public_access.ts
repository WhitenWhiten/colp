import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Anonymous preview bytes stay readable only while some live bookmark still
 * exposes that object. `link_preview_url_key` matches `linkPreviewTargetIdentity`
 * for accepted http(s) URLs (WHATWG href, fragment removed, sha256 hex), so the
 * object route can find those bookmarks with an index instead of a table scan.
 * Non-ASCII hosts return null and fail closed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION public.link_preview_normalized_url(raw text)
    RETURNS text
    LANGUAGE plpgsql
    IMMUTABLE
    PARALLEL SAFE
    AS $fn$
    DECLARE
      input text := btrim(raw);
      scheme text;
      rest text;
      query text := '';
      authority text;
      path text;
      host text;
      port text;
      qpos int;
      slash int;
      bracket int;
      segments text[];
      resolved text[] := ARRAY[]::text[];
      seg text;
      decoded text;
      i int;
      out_path text;
    BEGIN
      IF input IS NULL OR char_length(input) < 8 OR char_length(input) > 4096 THEN
        RETURN NULL;
      END IF;
      IF input !~* '^https?://' THEN
        RETURN NULL;
      END IF;
      scheme := lower((regexp_match(input, '^([Hh][Tt][Tt][Pp][Ss]?)'))[1]);
      rest := substring(input from char_length(scheme) + 4);
      qpos := position('#' in rest);
      IF qpos > 0 THEN
        rest := substring(rest from 1 for qpos - 1);
      END IF;
      qpos := position('?' in rest);
      IF qpos > 0 THEN
        query := substring(rest from qpos);
        rest := substring(rest from 1 for qpos - 1);
      END IF;
      rest := replace(rest, E'\\\\', '/');
      slash := position('/' in rest);
      IF slash = 0 THEN
        authority := rest;
        path := '';
      ELSE
        authority := substring(rest from 1 for slash - 1);
        path := substring(rest from slash);
      END IF;
      IF authority = '' OR position('@' in authority) > 0 OR authority ~ '[^[:ascii:]]' THEN
        RETURN NULL;
      END IF;
      IF left(authority, 1) = '[' THEN
        bracket := position(']' in authority);
        IF bracket = 0 THEN RETURN NULL; END IF;
        host := lower(substring(authority from 1 for bracket));
        port := substring(authority from bracket + 1);
        IF port IS NULL OR port = '' THEN
          port := NULL;
        ELSIF port ~ '^:[0-9]+$' THEN
          port := substring(port from 2);
        ELSE
          RETURN NULL;
        END IF;
      ELSIF authority ~ ':[0-9]+$' THEN
        host := lower(regexp_replace(authority, ':[0-9]+$', ''));
        port := substring(authority from char_length(host) + 2);
      ELSE
        host := lower(authority);
        port := NULL;
      END IF;
      IF host = '' OR host ~ '[[:space:]@/]' THEN
        RETURN NULL;
      END IF;
      IF (scheme = 'http' AND port = '80') OR (scheme = 'https' AND port = '443') THEN
        port := NULL;
      END IF;
      IF path = '' THEN
        out_path := '/';
      ELSE
        segments := string_to_array(path, '/');
        FOR i IN 1..coalesce(array_length(segments, 1), 0) LOOP
          seg := segments[i];
          decoded := replace(lower(seg), '%2e', '.');
          IF seg = '' THEN
            resolved := array_append(resolved, '');
          ELSIF decoded IN ('.', '..') AND lower(seg) ~ '^(%2e|\\.){1,2}$' THEN
            IF decoded = '..' AND coalesce(array_length(resolved, 1), 0) > 1 THEN
              resolved := resolved[1:array_length(resolved, 1) - 1];
            END IF;
            IF i = array_length(segments, 1) THEN
              resolved := array_append(resolved, '');
            END IF;
          ELSE
            resolved := array_append(resolved, seg);
          END IF;
        END LOOP;
        out_path := array_to_string(resolved, '/');
        IF out_path = '' THEN
          out_path := '/';
        END IF;
      END IF;
      RETURN scheme || '://' || host
        || CASE WHEN port IS NULL THEN '' ELSE ':' || port END
        || out_path || query;
    END;
    $fn$
  `.execute(db);
  await sql`
    CREATE OR REPLACE FUNCTION public.link_preview_url_key(raw text)
    RETURNS text
    LANGUAGE sql
    IMMUTABLE
    PARALLEL SAFE
    AS $fn$
      SELECT CASE
        WHEN public.link_preview_normalized_url(raw) IS NULL THEN NULL
        WHEN char_length(public.link_preview_normalized_url(raw)) > 4096 THEN NULL
        ELSE encode(public.digest(convert_to(public.link_preview_normalized_url(raw), 'UTF8'), 'sha256'), 'hex')
      END;
    $fn$
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS nodes_live_bookmark_preview_url_key
      ON nodes (public.link_preview_url_key(url))
      WHERE kind = 'bookmark' AND deleted_at IS NULL AND url IS NOT NULL
        AND public.link_preview_url_key(url) IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS nodes_live_bookmark_preview_url_key`.execute(db);
  await sql`DROP FUNCTION IF EXISTS public.link_preview_url_key(text)`.execute(db);
  await sql`DROP FUNCTION IF EXISTS public.link_preview_normalized_url(text)`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
