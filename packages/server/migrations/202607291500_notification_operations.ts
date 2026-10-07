import { sql, type Kysely, type Migration } from 'kysely';

/** P5-25 fixed-category delivery recovery facts; no provider implementation. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table notification_deliveries add column last_error_category text
    check (last_error_category is null or last_error_category in
      ('unknown_future_version','invalid_contract','retry_exhausted','dependency',
       'provider_unavailable','other'))`.execute(db);
  await sql`update notification_deliveries set last_error_category='retry_exhausted'
    where state='dead_letter' and last_error_category is null`.execute(db);
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
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`create or replace function guard_notification_delivery_transition() returns trigger
    language plpgsql as $function$
    begin
      if TG_OP='INSERT' then
        if NEW.state <> 'pending' or NEW.attempt_count <> 0 or NEW.state_revision <> 0 then
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
             ('retryable','delivered','suppressed','dead_letter'))) then
        raise exception 'Illegal Notification delivery transition'
          using ERRCODE='23514', CONSTRAINT='notification_deliveries_transition_guard';
      end if;
      return NEW;
    end
    $function$`.execute(db);
  await sql`alter table notification_deliveries drop column last_error_category`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
