import { sql, type Kysely, type Migration } from 'kysely';

/**
 * FIX-M-003: clear avatar URLs that violate the HttpsUrl contract.
 *
 * The product contract (docs/08 §7.3) defines avatarUrl as `HttpsUrl | null`:
 * an absolute https URI, no userinfo, at most 2048 code points. Until
 * FIX-M-003 the identity writer only checked non-empty and length, so legacy
 * rows may hold `javascript:`/`data:`/`http:` values, relative URLs,
 * userinfo-bearing URLs, fragments, non-default ports, or control characters.
 * Such values must never be served to anonymous readers, so this forward
 * migration backfills them to NULL.
 *
 * The SQL predicate is a conservative approximation of the strict application
 * validator (identity domain assertValidAvatarUrl / isValidAvatarUrl, WHATWG
 * URL parser) and errs toward clearing: it nulls anything that cannot be a
 * compliant absolute https URL. PostgreSQL cannot run the WHATWG parser, so a
 * few parser-normalizable edges are over-cleared (explicit default ports with
 * leading zeros, `https:host` forms, C1 control characters depending on
 * locale) — clearing a benign avatar is safe, serving an illegal one is not.
 * Conversely, exotic values SQL cannot recognize (punycode expansion beyond
 * 2048 canonical characters, IPv6 hosts with explicit ports) are caught by
 * the fail-closed read adapter and the strict write path.
 *
 * Rollback cannot restore the cleared values (irreversible data cleanup).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE profiles
       SET avatar_url = NULL
     WHERE avatar_url IS NOT NULL
       AND (
         length(avatar_url) > 2048
         OR avatar_url ~ '[[:cntrl:]]'
         OR avatar_url !~* '^https://[^/?#]'
         OR avatar_url ~* '^https://[^/@]+@'
         OR avatar_url ~ '#'
         OR (avatar_url ~* '^https://[^/[]+:[0-9]+'
             AND avatar_url !~* '^https://[^/:[]+:443([/?#]|$)')
       )
  `.execute(db);
}

/** Data cleanup cannot be undone; down is a documented no-op. */
export async function down(_db: Kysely<unknown>): Promise<void> {
  // The cleared avatar_url values are not recoverable; nothing to restore.
}

export const migration: Migration = { up, down };
export default migration;
