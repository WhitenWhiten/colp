import { sql, type Kysely, type Migration } from 'kysely';

/**
 * FIX-H-005 (KA-P5-SOC-02): state-aware Notification retention contract.
 *
 * The frozen Phase 5 contract (docs/10-phase5-free-social-contract.md) gives
 * unread Notifications a 365-day authoritative retention, read Notifications
 * a 90-day retention and delivery attempts a 30-day retention. The original
 * authority migration (202607290200) forced EVERY row to
 * `retain_until = occurred_at + interval '90 days'`, so day 90 deleted still
 * unread authoritative inbox data; mark-read never moved the deadline and the
 * purge never looked at state.
 *
 * This forward migration never rewrites deployed history:
 *  1) expands: drops the uniform 90-day CHECK and the transition guard that
 *     forbade retain_until changes;
 *  2) backfills BEFORE validating (bounded lock window): unread rows extend to
 *     the 365-day unread deadline (never shortened), read rows converge to
 *     `least(occurred_at + interval '365 days', read_at + interval '90 days')`
 *     which never shortens a legacy read row either (read_at >= occurred_at);
 *  3) contracts: installs a provable state-aware CHECK
 *     (`notifications_retention_window_state`) and a convergence trigger so
 *     mark-read converges the deadline in the same write that marks the row
 *     read (`min(original unread deadline, read_at + 90 days)`) no matter
 *     which writer performs it;
 *  4) gives notification_deliveries an independent 30-day retention: a
 *     trigger-converged `retain_until = created_at + interval '30 days'`
 *     deadline (PostgreSQL forbids generated columns over timestamptz +
 *     interval, 42P17) plus a partial index for the resolved-terminal
 *     purge; existing rows are backfilled before the NOT NULL contract.
 *
 * Rollback restores the historical guard/CHECK WITHOUT deleting any audit or
 * authority data; the restored CHECK is NOT VALID because migrated rows
 * legitimately carry state-aware deadlines the historical contract cannot see.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE notifications
    DROP CONSTRAINT IF EXISTS notifications_retention_window`.execute(db);
  await sql`ALTER TABLE notifications
    DROP CONSTRAINT IF EXISTS notifications_retention_window_state`.execute(db);
  await sql`DROP TRIGGER IF EXISTS notifications_transition_guard ON notifications`.execute(db);

  // Backfill BEFORE validating: extend unread rows to the 365-day unread
  // contract (never shorten) and converge read rows to the explicit read
  // boundary min(original unread deadline, read_at + 90 days).
  await sql`UPDATE notifications SET retain_until = occurred_at + interval '365 days'
    WHERE state='unread' AND retain_until <> occurred_at + interval '365 days'`.execute(db);
  await sql`UPDATE notifications SET retain_until =
      least(occurred_at + interval '365 days', read_at + interval '90 days')
    WHERE state='read' AND retain_until IS DISTINCT FROM
      least(occurred_at + interval '365 days', read_at + interval '90 days')`.execute(db);

  await sql`ALTER TABLE notifications ADD CONSTRAINT notifications_retention_window_state CHECK (
    (state='unread' AND retain_until = occurred_at + interval '365 days')
    OR (state='read' AND retain_until =
      least(occurred_at + interval '365 days', read_at + interval '90 days'))
  )`.execute(db);

  await sql`CREATE OR REPLACE FUNCTION guard_notification_transition() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF TG_OP='INSERT' THEN
        IF NEW.state <> 'unread' OR NEW.read_at IS NOT NULL OR NEW.state_revision <> 0 THEN
          RAISE EXCEPTION 'Illegal initial Notification state'
            USING ERRCODE='23514', CONSTRAINT='notifications_transition_guard';
        END IF;
        RETURN NEW;
      END IF;
      IF NEW.notification_id IS DISTINCT FROM OLD.notification_id
         OR NEW.recipient_account_id IS DISTINCT FROM OLD.recipient_account_id
         OR NEW.source_event_id IS DISTINCT FROM OLD.source_event_id
         OR NEW.notification_type IS DISTINCT FROM OLD.notification_type
         OR NEW.actor_profile_id IS DISTINCT FROM OLD.actor_profile_id
         OR NEW.subject_type IS DISTINCT FROM OLD.subject_type
         OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
         OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
         OR NEW.created_at IS DISTINCT FROM OLD.created_at
         OR NEW.state_revision <> OLD.state_revision + 1
         OR NOT (OLD.state='unread' AND NEW.state='read' AND NEW.read_at IS NOT NULL) THEN
        RAISE EXCEPTION 'Illegal Notification transition'
          USING ERRCODE='23514', CONSTRAINT='notifications_transition_guard';
      END IF;
      -- FIX-H-005: the read deadline converges in the same write that marks
      -- the row read: min(original unread deadline, read_at + 90 days).
      NEW.retain_until := least(OLD.retain_until, NEW.read_at + interval '90 days');
      RETURN NEW;
    END
    $function$`.execute(db);
  await sql`CREATE TRIGGER notifications_transition_guard
    BEFORE INSERT OR UPDATE ON notifications FOR EACH ROW
    EXECUTE FUNCTION guard_notification_transition()`.execute(db);

  await sql`ALTER TABLE notification_deliveries ADD COLUMN retain_until timestamptz`.execute(db);
  // PostgreSQL forbids generated columns over timestamptz + interval
  // (42P17: generation expression is not immutable), so the 30-day delivery
  // horizon is a plain column converged by trigger, backfilled for existing
  // rows BEFORE the NOT NULL contract is validated. The historical delivery
  // transition guard (202607290200) forbids any non-transition UPDATE, so it
  // is suspended around the backfill (transactional DDL, re-enabled below).
  await sql`ALTER TABLE notification_deliveries
    DISABLE TRIGGER notification_deliveries_transition_guard`.execute(db);
  await sql`UPDATE notification_deliveries SET retain_until = created_at + interval '30 days'
    WHERE retain_until IS NULL`.execute(db);
  await sql`ALTER TABLE notification_deliveries
    ENABLE TRIGGER notification_deliveries_transition_guard`.execute(db);
  await sql`ALTER TABLE notification_deliveries
    ALTER COLUMN retain_until SET NOT NULL`.execute(db);
  await sql`CREATE FUNCTION guard_notification_delivery_retention() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      NEW.retain_until := NEW.created_at + interval '30 days';
      RETURN NEW;
    END
    $function$`.execute(db);
  await sql`CREATE TRIGGER notification_deliveries_retention_guard
    BEFORE INSERT ON notification_deliveries FOR EACH ROW
    EXECUTE FUNCTION guard_notification_delivery_retention()`.execute(db);
  await sql`COMMENT ON COLUMN notification_deliveries.retain_until IS
    'FIX-H-005 independent 30-day delivery-attempt horizon; converged from created_at by trigger/backfill.'`.execute(db);
  await sql`CREATE INDEX notification_deliveries_retention_idx
    ON notification_deliveries(retain_until,delivery_id)
    WHERE state IN ('delivered','suppressed')`.execute(db);
}

/** Developer-only rollback; restores the historical guard/CHECK without deleting any data. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS notification_deliveries_retention_idx`.execute(db);
  await sql`DROP TRIGGER IF EXISTS notification_deliveries_retention_guard
    ON notification_deliveries`.execute(db);
  await sql`DROP FUNCTION IF EXISTS guard_notification_delivery_retention()`.execute(db);
  await sql`ALTER TABLE notification_deliveries DROP COLUMN IF EXISTS retain_until`.execute(db);
  await sql`DROP TRIGGER IF EXISTS notifications_transition_guard ON notifications`.execute(db);
  await sql`ALTER TABLE notifications
    DROP CONSTRAINT IF EXISTS notifications_retention_window_state`.execute(db);
  await sql`ALTER TABLE notifications
    DROP CONSTRAINT IF EXISTS notifications_retention_window`.execute(db);
  await sql`ALTER TABLE notifications ADD CONSTRAINT notifications_retention_window CHECK (
    retain_until = occurred_at + interval '90 days') NOT VALID`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION guard_notification_transition() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF TG_OP='INSERT' THEN
        IF NEW.state <> 'unread' OR NEW.read_at IS NOT NULL OR NEW.state_revision <> 0 THEN
          RAISE EXCEPTION 'Illegal initial Notification state'
            USING ERRCODE='23514', CONSTRAINT='notifications_transition_guard';
        END IF;
        RETURN NEW;
      END IF;
      IF NEW.notification_id IS DISTINCT FROM OLD.notification_id
         OR NEW.recipient_account_id IS DISTINCT FROM OLD.recipient_account_id
         OR NEW.source_event_id IS DISTINCT FROM OLD.source_event_id
         OR NEW.notification_type IS DISTINCT FROM OLD.notification_type
         OR NEW.actor_profile_id IS DISTINCT FROM OLD.actor_profile_id
         OR NEW.subject_type IS DISTINCT FROM OLD.subject_type
         OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
         OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
         OR NEW.retain_until IS DISTINCT FROM OLD.retain_until
         OR NEW.created_at IS DISTINCT FROM OLD.created_at
         OR NEW.state_revision <> OLD.state_revision + 1
         OR NOT (OLD.state='unread' AND NEW.state='read' AND NEW.read_at IS NOT NULL) THEN
        RAISE EXCEPTION 'Illegal Notification transition'
          USING ERRCODE='23514', CONSTRAINT='notifications_transition_guard';
      END IF;
      RETURN NEW;
    END
    $function$`.execute(db);
  await sql`CREATE TRIGGER notifications_transition_guard
    BEFORE INSERT OR UPDATE ON notifications FOR EACH ROW
    EXECUTE FUNCTION guard_notification_transition()`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
