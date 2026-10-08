import { sql, type Kysely, type Migration } from 'kysely';

/**
 * FIX-SC: Better Auth 1.7.1 sends OAuth backchannel logout tokens with the
 * process-global `fetch` and exposes no egress injection seam.  Keeping the
 * feature enabled would permit a DNS-rebinding SSRF when a registered client
 * hostname changes between metadata validation and session deletion.
 *
 * The application rejects all HTTP registration/update attempts.  This
 * migration closes the second write path: clear legacy callbacks and enforce
 * the invariant in PostgreSQL so an adapter, admin script, or older binary
 * cannot re-introduce the unsafe target.  MCP OAuth remains JWT-backed; only
 * the optional RP callback is disabled.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE "auth_oauth_client"
       SET "backchannelLogoutUri" = NULL,
           "backchannelLogoutSessionRequired" = NULL
     WHERE "backchannelLogoutUri" IS NOT NULL
        OR "backchannelLogoutSessionRequired" IS NOT NULL
  `.execute(db);

  await sql`
    ALTER TABLE "auth_oauth_client"
      ADD CONSTRAINT "auth_oauth_client_backchannel_logout_disabled"
      CHECK ("backchannelLogoutUri" IS NULL AND "backchannelLogoutSessionRequired" IS NULL)
  `.execute(db);
}

/** Developer-only rollback; rollback does not restore intentionally cleared callbacks. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE "auth_oauth_client"
      DROP CONSTRAINT IF EXISTS "auth_oauth_client_backchannel_logout_disabled"
  `.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
