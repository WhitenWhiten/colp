import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

/**
 * T-03 follow-up: rewrite denormalized Know-N subject copies onto the mapped
 * Better Auth `user.id` (ADR D3). Seed apply re-runs this after auth because
 * `data.sql` still writes `sub-uNN` and the one-shot migrations do not.
 *
 * Temp remap tables are dropped at the start of the block so a second call
 * in the same transaction can recreate them (`ON COMMIT DROP` waits for
 * that outer transaction to end).
 */
export async function runSubjectIdReferenceCascade(
  db: Kysely<DatabaseSchema> | DatabaseTransaction,
): Promise<void> {
  await sql`
    DO $cascade$
    DECLARE
      collisions bigint;
      session_binds bigint;
      orphans bigint;
      digest_subject_fks text;
    BEGIN
      DROP TABLE IF EXISTS subject_id_remap_src;
      DROP TABLE IF EXISTS subject_id_remap;
      CREATE TEMP TABLE subject_id_remap_src (
        old_subject_id text NOT NULL,
        new_subject_id text NOT NULL,
        account_id text NOT NULL
      ) ON COMMIT DROP;

      INSERT INTO subject_id_remap_src (old_subject_id, new_subject_id, account_id)
      SELECT a.subject_id, m.auth_user_id, a.id
        FROM accounts a
        INNER JOIN auth_user_account_map m ON m.account_id = a.id
       WHERE a.subject_id IS DISTINCT FROM m.auth_user_id;

      INSERT INTO subject_id_remap_src (old_subject_id, new_subject_id, account_id)
      SELECT leftover.old_subject_id, leftover.new_subject_id, leftover.account_id
        FROM (
          SELECT i.subject AS old_subject_id, a.subject_id AS new_subject_id, a.id AS account_id
            FROM account_identities i
            INNER JOIN accounts a ON a.id = i.account_id
            INNER JOIN auth_user_account_map m
                    ON m.account_id = a.id AND a.subject_id = m.auth_user_id
           WHERE i.subject IS DISTINCT FROM a.subject_id
          UNION
          SELECT ar.subject, a.subject_id, a.id
            FROM legacy_oidc_identity_archive ar
            INNER JOIN accounts a ON a.id = ar.account_id
            INNER JOIN auth_user_account_map m
                    ON m.account_id = a.id AND a.subject_id = m.auth_user_id
           WHERE ar.subject IS DISTINCT FROM a.subject_id
        ) leftover
       WHERE leftover.old_subject_id IS DISTINCT FROM leftover.new_subject_id
         AND NOT EXISTS (
           SELECT 1 FROM accounts cur WHERE cur.subject_id = leftover.old_subject_id
         )
         AND (
           EXISTS (SELECT 1 FROM collections c WHERE c.owner_subject_id = leftover.old_subject_id)
           OR EXISTS (SELECT 1 FROM collection_members m WHERE m.subject_id = leftover.old_subject_id)
           OR EXISTS (SELECT 1 FROM collection_invites inv
                       WHERE inv.invited_subject_id = leftover.old_subject_id
                          OR inv.invited_by_subject_id = leftover.old_subject_id
                          OR inv.accepted_subject_id = leftover.old_subject_id)
           OR EXISTS (SELECT 1 FROM collection_export_jobs j
                       WHERE j.owner_subject_id = leftover.old_subject_id)
           OR EXISTS (SELECT 1 FROM collection_classify_inbox_decision d
                       WHERE d.account_subject_id = leftover.old_subject_id)
           OR EXISTS (SELECT 1 FROM blob_records b WHERE b.owner_subject_id = leftover.old_subject_id)
           OR EXISTS (SELECT 1 FROM attachments at WHERE at.owner_subject_id = leftover.old_subject_id)
         );

      IF to_regclass('digest_series') IS NOT NULL THEN
        EXECUTE $leftover_digest$
          INSERT INTO subject_id_remap_src (old_subject_id, new_subject_id, account_id)
          SELECT leftover.old_subject_id, leftover.new_subject_id, leftover.account_id
            FROM (
              SELECT i.subject AS old_subject_id, a.subject_id AS new_subject_id, a.id AS account_id
                FROM account_identities i
                INNER JOIN accounts a ON a.id = i.account_id
                INNER JOIN auth_user_account_map m
                        ON m.account_id = a.id AND a.subject_id = m.auth_user_id
               WHERE i.subject IS DISTINCT FROM a.subject_id
              UNION
              SELECT ar.subject, a.subject_id, a.id
                FROM legacy_oidc_identity_archive ar
                INNER JOIN accounts a ON a.id = ar.account_id
                INNER JOIN auth_user_account_map m
                        ON m.account_id = a.id AND a.subject_id = m.auth_user_id
               WHERE ar.subject IS DISTINCT FROM a.subject_id
            ) leftover
           WHERE leftover.old_subject_id IS DISTINCT FROM leftover.new_subject_id
             AND NOT EXISTS (
               SELECT 1 FROM accounts cur WHERE cur.subject_id = leftover.old_subject_id
             )
             AND (
               EXISTS (SELECT 1 FROM digest_series s WHERE s.owner_subject_id = leftover.old_subject_id)
               OR EXISTS (SELECT 1 FROM digest_members dm WHERE dm.subject_id = leftover.old_subject_id)
             )
             AND NOT EXISTS (
               SELECT 1 FROM subject_id_remap_src src
                WHERE src.old_subject_id = leftover.old_subject_id
             )
        $leftover_digest$;
      END IF;

      SELECT count(*) INTO collisions
        FROM (
          SELECT old_subject_id
            FROM subject_id_remap_src
           GROUP BY old_subject_id
          HAVING count(DISTINCT new_subject_id) > 1 OR count(DISTINCT account_id) > 1
        ) conflicting;
      IF collisions > 0 THEN
        RAISE EXCEPTION 'subject_id_reference_cascade refused: % old subject_id(s) map to multiple targets',
          collisions;
      END IF;

      CREATE TEMP TABLE subject_id_remap (
        old_subject_id text PRIMARY KEY,
        new_subject_id text NOT NULL,
        account_id text NOT NULL,
        CHECK (old_subject_id IS DISTINCT FROM new_subject_id)
      ) ON COMMIT DROP;

      INSERT INTO subject_id_remap (old_subject_id, new_subject_id, account_id)
      SELECT DISTINCT old_subject_id, new_subject_id, account_id
        FROM subject_id_remap_src;

      SELECT count(*) INTO collisions
        FROM subject_id_remap r
       WHERE EXISTS (
         SELECT 1 FROM accounts other
          WHERE other.subject_id = r.new_subject_id AND other.id <> r.account_id
       );
      IF collisions > 0 THEN
        RAISE EXCEPTION 'subject_id_reference_cascade refused: % mapped target subject_id(s) already belong to a different account',
          collisions;
      END IF;

      SELECT count(*) INTO collisions
        FROM collection_members old_row
        INNER JOIN subject_id_remap r ON old_row.subject_id = r.old_subject_id
        INNER JOIN collection_members new_row
                ON new_row.collection_id = old_row.collection_id
               AND new_row.subject_id = r.new_subject_id;
      IF collisions > 0 THEN
        RAISE EXCEPTION 'subject_id_reference_cascade refused: % collection_members row(s) would collide on (collection_id, subject_id)',
          collisions;
      END IF;

      IF to_regclass('digest_members') IS NOT NULL THEN
        EXECUTE $digest_member_collisions$
          SELECT count(*)
            FROM digest_members old_row
            INNER JOIN subject_id_remap r ON old_row.subject_id = r.old_subject_id
            INNER JOIN digest_members new_row
                    ON new_row.series_id = old_row.series_id
                   AND new_row.subject_id = r.new_subject_id
        $digest_member_collisions$ INTO collisions;
        IF collisions > 0 THEN
          RAISE EXCEPTION 'subject_id_reference_cascade refused: % digest_members row(s) would collide on (series_id, subject_id)',
            collisions;
        END IF;
      END IF;

      SELECT count(*) INTO session_binds
        FROM sync_sessions s
        INNER JOIN subject_id_remap r ON s.principal_subject_id = r.old_subject_id;
      IF session_binds > 0 THEN
        RAISE EXCEPTION 'subject_id_reference_cascade refused: % sync session(s) still bind the old principal_subject_id',
          session_binds;
      END IF;

      UPDATE collections c
         SET owner_subject_id = r.new_subject_id,
             payload_json = CASE
               WHEN c.payload_json ? 'ownerSubjectId'
               THEN jsonb_set(c.payload_json, '{ownerSubjectId}', to_jsonb(r.new_subject_id))
               ELSE c.payload_json
             END
        FROM subject_id_remap r
       WHERE c.owner_subject_id = r.old_subject_id;

      -- News Digest is an expand-only capability added after this migration.
      -- Keep the one-shot cascade usable on a fresh database whose migration
      -- chain has not created digest_series yet; seed re-entry will run the
      -- same block again after the table exists.
      -- Digest subject FKs are immediate on write. Defer them so copies and
      -- accounts.subject_id can move together without a mid-statement orphan.
      -- Phase-1 DROP TABLE accounts CASCADE can leave the expand-only
      -- digest tables while dropping those named FKs. Only defer names that
      -- still exist and are deferrable; SET CONSTRAINTS otherwise 42704s.
      IF to_regclass('digest_series') IS NOT NULL THEN
        SELECT string_agg(quote_ident(c.conname), ', ' ORDER BY c.conname)
          INTO digest_subject_fks
          FROM pg_constraint c
         WHERE c.conname IN (
                 'digest_series_owner_subject_id_fkey',
                 'digest_members_subject_id_fkey'
               )
           AND c.condeferrable
           AND c.connamespace = current_schema()::regnamespace;
        IF digest_subject_fks IS NOT NULL THEN
          EXECUTE 'SET CONSTRAINTS ' || digest_subject_fks || ' DEFERRED';
        END IF;
        EXECUTE $digest_update$
          UPDATE digest_series s
             SET owner_subject_id = r.new_subject_id
            FROM subject_id_remap r
           WHERE s.owner_subject_id = r.old_subject_id;
          UPDATE digest_members m
             SET subject_id = r.new_subject_id
            FROM subject_id_remap r
           WHERE m.subject_id = r.old_subject_id
        $digest_update$;
      END IF;

      UPDATE collection_members m
         SET subject_id = r.new_subject_id
        FROM subject_id_remap r
       WHERE m.subject_id = r.old_subject_id;

      UPDATE collection_invites inv
         SET invited_subject_id = r.new_subject_id
        FROM subject_id_remap r
       WHERE inv.invited_subject_id = r.old_subject_id;

      UPDATE collection_invites inv
         SET invited_by_subject_id = r.new_subject_id
        FROM subject_id_remap r
       WHERE inv.invited_by_subject_id = r.old_subject_id;

      UPDATE collection_invites inv
         SET accepted_subject_id = r.new_subject_id
        FROM subject_id_remap r
       WHERE inv.accepted_subject_id = r.old_subject_id;

      UPDATE collection_export_jobs j
         SET owner_subject_id = r.new_subject_id
        FROM subject_id_remap r
       WHERE j.owner_subject_id = r.old_subject_id;

      UPDATE collection_classify_inbox_decision d
         SET account_subject_id = r.new_subject_id
        FROM subject_id_remap r
       WHERE d.account_subject_id = r.old_subject_id;

      UPDATE blob_records b
         SET owner_subject_id = r.new_subject_id
        FROM subject_id_remap r
       WHERE b.owner_subject_id = r.old_subject_id;

      UPDATE attachments at
         SET owner_subject_id = r.new_subject_id
        FROM subject_id_remap r
       WHERE at.owner_subject_id = r.old_subject_id;

      UPDATE accounts a
         SET subject_id = r.new_subject_id
        FROM subject_id_remap r
       WHERE a.id = r.account_id
         AND a.subject_id = r.old_subject_id;

      SET CONSTRAINTS ALL IMMEDIATE;

      SELECT count(*) INTO orphans
        FROM collections c
       WHERE NOT EXISTS (
         SELECT 1 FROM accounts a WHERE a.subject_id = c.owner_subject_id
       );
      IF orphans > 0 THEN
        RAISE EXCEPTION 'subject_id_reference_cascade refused: % collection(s) still have an owner_subject_id that matches no account',
          orphans;
      END IF;

      IF to_regclass('digest_series') IS NOT NULL THEN
        EXECUTE $digest_orphans$
          SELECT count(*)
            FROM digest_series s
           WHERE NOT EXISTS (
             SELECT 1 FROM accounts a WHERE a.subject_id = s.owner_subject_id
           )
        $digest_orphans$ INTO orphans;
        IF orphans > 0 THEN
          RAISE EXCEPTION 'subject_id_reference_cascade refused: % digest series owner(s) still have no matching account', orphans;
        END IF;
        EXECUTE $digest_member_orphans$
          SELECT count(*)
            FROM digest_members m
           WHERE NOT EXISTS (
             SELECT 1 FROM accounts a WHERE a.subject_id = m.subject_id
           )
        $digest_member_orphans$ INTO orphans;
        IF orphans > 0 THEN
          RAISE EXCEPTION 'subject_id_reference_cascade refused: % digest member(s) still have a subject_id that matches no account', orphans;
        END IF;
      END IF;
    END
    $cascade$
  `.execute(db);
}
