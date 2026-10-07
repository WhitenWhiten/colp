import { sql, type Kysely, type Migration } from 'kysely';

/**
 * P5-29 expand-only recipient-level email suppression facts + worker lease
 * fencing trigger expansion.
 *
 * 1) Durable, race-safe, recipient-unique suppression facts recorded from
 *    signature-verified delivery-result callbacks (bounce/complaint/unsubscribe)
 *    and lookup reconciliation. The email delivery worker rechecks this table
 *    before every send so a bounced/complaining/unsubscribed recipient is never
 *    contacted again, independent of any individual delivery row lifecycle.
 *    One row per recipient (PRIMARY KEY); concurrent callbacks converge via
 *    upsert (last fact wins). Preference-disable races do NOT write here - the
 *    notification_preferences table is the durable authority for preferences,
 *    and re-enabling email must unblock future deliveries.
 *
 * 2) The P5-29 email worker claims due rows and keeps a lease while a provider
 *    send is in flight. Its two worker-only mutations are both `leased ->
 *    leased`, which the P5-25 transition guard (202607291500) never allowed:
 *    - expired-lease takeover: `state='leased' AND leased_until <= now` is
 *      re-claimed with `attempt_count+1` (frozen gate doc 14.1);
 *    - heartbeat: an active lease is extended with the SAME attempt_count
 *      (gate doc 14.1).
 *    This migration expands the guard with a strict fenced branch: the attempt
 *    bump is only permitted on an EXPIRED lease and the heartbeat only on an
 *    ACTIVE lease with the same attempt_count and an extended leased_until, so
 *    a fresh lease can still never be stolen and a stale owner can never bump
 *    or extend another attempt's lease. `down` restores the pre-P5-29 guard.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE notification_email_suppressions (
    recipient_account_id text NOT NULL,
    source text NOT NULL CHECK (source IN ('bounce','complaint','unsubscribe')),
    occurred_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT current_timestamp,
    CONSTRAINT notification_email_suppressions_pkey PRIMARY KEY (recipient_account_id),
    CONSTRAINT notification_email_suppressions_account_fk
      FOREIGN KEY (recipient_account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    CONSTRAINT notification_email_suppressions_time_finite CHECK (
      occurred_at > '-infinity'::timestamptz AND occurred_at < 'infinity'::timestamptz
      AND created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz
    )
  )`.execute(db);
  await sql`COMMENT ON TABLE notification_email_suppressions IS
    'Durable recipient-level email suppression facts (P5-29); one row per recipient, upserted from verified bounce/complaint/unsubscribe callbacks and lookup reconciliation.'`.execute(db);
  await sql`create or replace function guard_notification_delivery_transition() returns trigger
    language plpgsql as $function$
    begin
      if TG_OP='INSERT' then
        if NEW.state <> 'pending' or NEW.attempt_count <> 0 or NEW.state_revision <> 0
           or NEW.last_error_category is not null then
          raise exception 'Illegal initial Notification delivery state'
            using ERRCODE='23514', CONSTRAINT='notification_deliveries_transition_guard';
        end if;
        return NEW;
      end if;
      if NEW.delivery_id is distinct from OLD.delivery_id
         or NEW.notification_id is distinct from OLD.notification_id
         or NEW.recipient_account_id is distinct from OLD.recipient_account_id
         or NEW.channel is distinct from OLD.channel
         or NEW.created_at is distinct from OLD.created_at
         or NEW.state_revision <> OLD.state_revision + 1
         or not ((OLD.state in ('pending','retryable') and NEW.state in ('leased','suppressed'))
           or (OLD.state='leased' and NEW.state in
             ('retryable','delivered','suppressed','dead_letter'))
           or (OLD.state='dead_letter' and NEW.state='retryable'
             and NEW.attempt_count=OLD.attempt_count
             and NEW.last_error_category is not distinct from OLD.last_error_category)
           or (OLD.state='leased' and NEW.state='leased'
             and ((OLD.leased_until <= current_timestamp
                   and NEW.attempt_count = OLD.attempt_count + 1)
               or (OLD.leased_until > current_timestamp
                   and NEW.attempt_count = OLD.attempt_count
                   and NEW.leased_until > OLD.leased_until)))) then
        raise exception 'Illegal Notification delivery transition'
          using ERRCODE='23514', CONSTRAINT='notification_deliveries_transition_guard';
      end if;
      return NEW;
    end
    $function$`.execute(db);
}

/**
 * Developer-only destructive rollback: drop the suppression table and restore
 * the pre-P5-29 delivery transition guard (202607291500 semantics). Drain
 * email delivery first; re-deploying the P5-29 worker before re-applying this
 * migration would reject lease takeovers again.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`create or replace function guard_notification_delivery_transition() returns trigger
    language plpgsql as $function$
    begin
      if TG_OP='INSERT' then
        if NEW.state <> 'pending' or NEW.attempt_count <> 0 or NEW.state_revision <> 0
           or NEW.last_error_category is not null then
          raise exception 'Illegal initial Notification delivery state'
            using ERRCODE='23514', CONSTRAINT='notification_deliveries_transition_guard';
        end if;
        return NEW;
      end if;
      if NEW.delivery_id is distinct from OLD.delivery_id
         or NEW.notification_id is distinct from OLD.notification_id
         or NEW.recipient_account_id is distinct from OLD.recipient_account_id
         or NEW.channel is distinct from OLD.channel
         or NEW.created_at is distinct from OLD.created_at
         or NEW.state_revision <> OLD.state_revision + 1
         or not ((OLD.state in ('pending','retryable') and NEW.state in ('leased','suppressed'))
           or (OLD.state='leased' and NEW.state in
             ('retryable','delivered','suppressed','dead_letter'))
           or (OLD.state='dead_letter' and NEW.state='retryable'
             and NEW.attempt_count=OLD.attempt_count
             and NEW.last_error_category is not distinct from OLD.last_error_category)) then
        raise exception 'Illegal Notification delivery transition'
          using ERRCODE='23514', CONSTRAINT='notification_deliveries_transition_guard';
      end if;
      return NEW;
    end
    $function$`.execute(db);
  await sql`DROP TABLE IF EXISTS notification_email_suppressions`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;