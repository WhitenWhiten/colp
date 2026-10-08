import { sql, type Kysely } from 'kysely';

/**
 * FIX-M-028: allow the verified-delivered-callback direct finalization
 * `retryable -> delivered`.
 *
 * A delivery row reaches `retryable` only after a provider send/processing
 * attempt, and a VERIFIED delivered callback is authoritative evidence the
 * provider accepted the message. When the send succeeded but the final
 * leased->delivered CAS lost the lease (or any other bounded failure left the
 * row retryable), the callback must finalize the row delivered so the next
 * claim can never re-send on a SenderStatisticsDetailByParam lookup miss.
 *
 * The callback path therefore needs a strict fenced `retryable -> delivered`
 * branch: the SAME attempt_count (the callback CAS binds the attempt, like
 * every callback transition - 202608020800 binds it on the dead_letter re-arm
 * too) and a CLEARED `last_error_category` (delivered is terminal error-free,
 * m1). The write itself also sets `delivered_at` and persists the callback's
 * provider message id as the delivered-confirmed marker.
 *
 * `down` restores the 202608020800 guard.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
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
                   and NEW.leased_until > OLD.leased_until)))
           or (OLD.state='retryable' and NEW.state='delivered'
             and NEW.attempt_count = OLD.attempt_count
             and NEW.last_error_category is null)) then
        raise exception 'Illegal Notification delivery transition'
          using ERRCODE='23514', CONSTRAINT='notification_deliveries_transition_guard';
      end if;
      return NEW;
    end
    $function$`.execute(db);
}

/** Developer-only rollback; restores the 202608020800 delivery transition guard. */
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
