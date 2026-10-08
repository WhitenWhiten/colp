import { sql, type Kysely, type Migration } from 'kysely';

/**
 * SYNC-Q-012: mark every capacity-registry relation as append-heavy.
 *
 * Completeness CI treats `known.append_heavy=true` as the migration-side
 * declaration. An unregistered commented table fails CI; a registered table
 * without this comment also fails. Each statement uses a literal table name so
 * the source scanner can see the contract without executing SQL.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`COMMENT ON TABLE operations IS 'known.append_heavy=true; typed ledger authority registry'`.execute(db);
  await sql`COMMENT ON TABLE operation_payloads IS 'known.append_heavy=true; typed ledger authority registry'`.execute(db);
  await sql`COMMENT ON TABLE operation_lookup_facts IS 'known.append_heavy=true; typed ledger authority registry'`.execute(db);
  await sql`COMMENT ON TABLE audit_events IS 'known.append_heavy=true; typed ledger authority registry'`.execute(db);
  await sql`DO $body$ BEGIN
    -- News Digest is created by a later migration.  Use dynamic SQL so
    -- PostgreSQL does not resolve the optional relation while compiling this
    -- block on a fresh schema.
    IF to_regclass('digest_audit_events') IS NOT NULL THEN
      EXECUTE $comment$
        COMMENT ON TABLE digest_audit_events IS 'known.append_heavy=true; typed ledger authority registry'
      $comment$;
    END IF;
  END $body$`.execute(db);
  await sql`COMMENT ON TABLE audit_event_payloads IS 'known.append_heavy=true; typed ledger authority registry'`.execute(db);
  await sql`COMMENT ON TABLE outbox_events IS 'known.append_heavy=true; typed ledger authority registry'`.execute(db);
  await sql`COMMENT ON TABLE sync_node_revision_history IS 'known.append_heavy=true; typed ledger authority registry'`.execute(db);
  await sql`COMMENT ON TABLE sync_sequence_receipts IS 'known.append_heavy=true; typed ledger authority registry'`.execute(db);
  await sql`COMMENT ON TABLE resource_id_ledger IS 'known.append_heavy=true; typed ledger authority registry'`.execute(db);
  await sql`COMMENT ON TABLE sync_sequence_operation_claims IS 'known.append_heavy=true; typed ledger authority registry'`.execute(db);
  await sql`COMMENT ON TABLE sync_operation_effects IS 'known.append_heavy=true; typed ledger authority registry'`.execute(db);
  await sql`COMMENT ON TABLE sync_operation_effect_pages IS 'known.append_heavy=true; typed ledger authority registry'`.execute(db);
  await sql`COMMENT ON TABLE sync_purged_node_id_watermarks IS 'known.append_heavy=true; typed ledger authority registry'`.execute(db);
  await sql`COMMENT ON TABLE sync_replica_retirement_receipts IS 'known.append_heavy=true; typed ledger authority registry'`.execute(db);
  await sql`COMMENT ON TABLE sync_recovery_ack_receipts IS 'known.append_heavy=true; typed ledger authority registry'`.execute(db);
  await sql`COMMENT ON TABLE sync_bootstrap_snapshot_pages IS 'known.append_heavy=true; typed ledger authority registry'`.execute(db);
  await sql`COMMENT ON TABLE outbox_delivery_receipts IS 'known.append_heavy=true; typed ledger authority registry'`.execute(db);
  await sql`COMMENT ON TABLE product_command_receipts IS 'known.append_heavy=true; typed ledger authority registry'`.execute(db);
  await sql`COMMENT ON TABLE sync_pull_cursor_evidence IS 'known.append_heavy=true; typed ledger authority registry'`.execute(db);
  await sql`COMMENT ON TABLE sync_pull_cursor_recovery_proofs IS 'known.append_heavy=true; typed ledger authority registry'`.execute(db);
  await sql`COMMENT ON TABLE sync_pull_cursor_lineage IS 'known.append_heavy=true; typed ledger authority registry'`.execute(db);
  await sql`COMMENT ON TABLE sync_pull_page_evidence IS 'known.append_heavy=true; typed ledger authority registry'`.execute(db);
  await sql`COMMENT ON TABLE sync_node_tombstones IS 'known.append_heavy=true; typed ledger authority registry'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`COMMENT ON TABLE operations IS NULL`.execute(db);
  await sql`COMMENT ON TABLE operation_payloads IS NULL`.execute(db);
  await sql`COMMENT ON TABLE operation_lookup_facts IS NULL`.execute(db);
  await sql`COMMENT ON TABLE audit_events IS NULL`.execute(db);
  await sql`DO $body$ BEGIN
    IF to_regclass('digest_audit_events') IS NOT NULL THEN
      EXECUTE 'COMMENT ON TABLE digest_audit_events IS NULL';
    END IF;
  END $body$`.execute(db);
  await sql`COMMENT ON TABLE audit_event_payloads IS NULL`.execute(db);
  await sql`COMMENT ON TABLE outbox_events IS NULL`.execute(db);
  await sql`COMMENT ON TABLE sync_node_revision_history IS NULL`.execute(db);
  await sql`COMMENT ON TABLE sync_sequence_receipts IS NULL`.execute(db);
  await sql`COMMENT ON TABLE resource_id_ledger IS NULL`.execute(db);
  await sql`COMMENT ON TABLE sync_sequence_operation_claims IS NULL`.execute(db);
  await sql`COMMENT ON TABLE sync_operation_effects IS NULL`.execute(db);
  await sql`COMMENT ON TABLE sync_operation_effect_pages IS NULL`.execute(db);
  await sql`COMMENT ON TABLE sync_purged_node_id_watermarks IS NULL`.execute(db);
  await sql`COMMENT ON TABLE sync_replica_retirement_receipts IS NULL`.execute(db);
  await sql`COMMENT ON TABLE sync_recovery_ack_receipts IS NULL`.execute(db);
  await sql`COMMENT ON TABLE sync_bootstrap_snapshot_pages IS NULL`.execute(db);
  await sql`COMMENT ON TABLE outbox_delivery_receipts IS NULL`.execute(db);
  await sql`COMMENT ON TABLE product_command_receipts IS NULL`.execute(db);
  await sql`COMMENT ON TABLE sync_pull_cursor_evidence IS NULL`.execute(db);
  await sql`COMMENT ON TABLE sync_pull_cursor_recovery_proofs IS NULL`.execute(db);
  await sql`COMMENT ON TABLE sync_pull_cursor_lineage IS NULL`.execute(db);
  await sql`COMMENT ON TABLE sync_pull_page_evidence IS NULL`.execute(db);
  await sql`COMMENT ON TABLE sync_node_tombstones IS NULL`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
