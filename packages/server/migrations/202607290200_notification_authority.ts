import { sql, type Kysely, type Migration } from 'kysely';

/** Expand-only P5-16 private Notification authority. No consumer is registered here. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE notification_preferences (
    recipient_account_id text NOT NULL,
    channel text NOT NULL CHECK (channel IN ('in_app','email')),
    enabled boolean NOT NULL,
    state_revision bigint NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
    updated_at timestamptz NOT NULL DEFAULT current_timestamp,
    CONSTRAINT notification_preferences_pkey PRIMARY KEY (recipient_account_id,channel),
    CONSTRAINT notification_preferences_account_fk FOREIGN KEY (recipient_account_id)
      REFERENCES accounts(id) ON DELETE CASCADE,
    CONSTRAINT notification_preferences_time_finite CHECK (
      updated_at > '-infinity'::timestamptz AND updated_at < 'infinity'::timestamptz
    )
  )`.execute(db);

  await sql`CREATE TABLE notifications (
    notification_id text NOT NULL,
    recipient_account_id text NOT NULL,
    source_event_id text NOT NULL,
    notification_type text NOT NULL
      CHECK (notification_type IN ('collection_change','follow_activity')),
    actor_profile_id text,
    subject_type text NOT NULL CHECK (subject_type IN ('collection','profile')),
    subject_id text NOT NULL,
    state text NOT NULL DEFAULT 'unread' CHECK (state IN ('unread','read')),
    read_at timestamptz,
    state_revision bigint NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
    occurred_at timestamptz NOT NULL,
    retain_until timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT current_timestamp,
    CONSTRAINT notifications_pkey PRIMARY KEY (notification_id),
    CONSTRAINT notifications_owner_identity_key UNIQUE (recipient_account_id,notification_id),
    CONSTRAINT notifications_event_recipient_type_key
      UNIQUE (recipient_account_id,source_event_id,notification_type),
    CONSTRAINT notifications_recipient_fk FOREIGN KEY (recipient_account_id)
      REFERENCES accounts(id) ON DELETE CASCADE,
    CONSTRAINT notifications_actor_fk FOREIGN KEY (actor_profile_id)
      REFERENCES profiles(account_id) ON DELETE CASCADE,
    CONSTRAINT notifications_identity_lengths CHECK (
      length(notification_id) BETWEEN 1 AND 128
      AND length(source_event_id) BETWEEN 1 AND 128
      AND length(subject_id) BETWEEN 1 AND 512
    ),
    CONSTRAINT notifications_state_shape CHECK (
      (state='unread' AND read_at IS NULL) OR (state='read' AND read_at IS NOT NULL)
    ),
    CONSTRAINT notifications_retention_window CHECK (
      retain_until = occurred_at + interval '90 days'
    ),
    CONSTRAINT notifications_time_finite CHECK (
      occurred_at > '-infinity'::timestamptz AND occurred_at < 'infinity'::timestamptz
      AND retain_until > '-infinity'::timestamptz AND retain_until < 'infinity'::timestamptz
      AND created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz
      AND (read_at IS NULL OR (read_at > '-infinity'::timestamptz AND read_at < 'infinity'::timestamptz))
    )
  )`.execute(db);
  await sql`COMMENT ON TABLE notifications IS
    'Private Notification authority owned by recipient account; separate from rebuildable Feed.'`.execute(db);
  await sql`CREATE INDEX notifications_recipient_page_idx
    ON notifications(recipient_account_id,occurred_at DESC,notification_id DESC)`.execute(db);
  await sql`CREATE INDEX notifications_recipient_unread_idx
    ON notifications(recipient_account_id,occurred_at DESC,notification_id DESC)
    WHERE state='unread'`.execute(db);
  await sql`CREATE INDEX notifications_retention_idx
    ON notifications(retain_until,notification_id)`.execute(db);

  await sql`CREATE TABLE notification_deliveries (
    delivery_id text NOT NULL,
    notification_id text NOT NULL,
    recipient_account_id text NOT NULL,
    channel text NOT NULL CHECK (channel IN ('email')),
    state text NOT NULL DEFAULT 'pending'
      CHECK (state IN ('pending','leased','retryable','delivered','suppressed','dead_letter')),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    state_revision bigint NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
    next_attempt_at timestamptz NOT NULL DEFAULT current_timestamp,
    leased_until timestamptz,
    delivered_at timestamptz,
    suppressed_at timestamptz,
    dead_lettered_at timestamptz,
    provider_message_id text CHECK (provider_message_id IS NULL OR length(provider_message_id) BETWEEN 1 AND 512),
    created_at timestamptz NOT NULL DEFAULT current_timestamp,
    updated_at timestamptz NOT NULL DEFAULT current_timestamp,
    CONSTRAINT notification_deliveries_pkey PRIMARY KEY (delivery_id),
    CONSTRAINT notification_deliveries_notification_channel_key UNIQUE (notification_id,channel),
    CONSTRAINT notification_deliveries_owner_notification_fk
      FOREIGN KEY (recipient_account_id,notification_id)
      REFERENCES notifications(recipient_account_id,notification_id) ON DELETE CASCADE,
    CONSTRAINT notification_deliveries_identity_lengths CHECK (
      length(delivery_id) BETWEEN 1 AND 128
    ),
    CONSTRAINT notification_deliveries_state_shape CHECK (
      (state='pending' AND attempt_count=0 AND leased_until IS NULL AND delivered_at IS NULL
        AND suppressed_at IS NULL AND dead_lettered_at IS NULL)
      OR (state='leased' AND attempt_count > 0 AND leased_until IS NOT NULL
        AND delivered_at IS NULL AND suppressed_at IS NULL AND dead_lettered_at IS NULL)
      OR (state='retryable' AND attempt_count > 0 AND leased_until IS NULL
        AND delivered_at IS NULL AND suppressed_at IS NULL AND dead_lettered_at IS NULL)
      OR (state='delivered' AND attempt_count > 0 AND leased_until IS NULL
        AND delivered_at IS NOT NULL AND suppressed_at IS NULL AND dead_lettered_at IS NULL)
      OR (state='suppressed' AND leased_until IS NULL AND delivered_at IS NULL
        AND suppressed_at IS NOT NULL AND dead_lettered_at IS NULL)
      OR (state='dead_letter' AND attempt_count > 0 AND leased_until IS NULL
        AND delivered_at IS NULL AND suppressed_at IS NULL AND dead_lettered_at IS NOT NULL)
    ),
    CONSTRAINT notification_deliveries_time_finite CHECK (
      next_attempt_at > '-infinity'::timestamptz AND next_attempt_at < 'infinity'::timestamptz
      AND created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz
      AND updated_at > '-infinity'::timestamptz AND updated_at < 'infinity'::timestamptz
      AND (leased_until IS NULL OR (leased_until > '-infinity'::timestamptz AND leased_until < 'infinity'::timestamptz))
      AND (delivered_at IS NULL OR (delivered_at > '-infinity'::timestamptz AND delivered_at < 'infinity'::timestamptz))
      AND (suppressed_at IS NULL OR (suppressed_at > '-infinity'::timestamptz AND suppressed_at < 'infinity'::timestamptz))
      AND (dead_lettered_at IS NULL OR (dead_lettered_at > '-infinity'::timestamptz AND dead_lettered_at < 'infinity'::timestamptz))
    )
  )`.execute(db);
  await sql`COMMENT ON COLUMN notification_deliveries.provider_message_id IS
    'Opaque non-secret provider locator for later callback reconciliation.'`.execute(db);
  await sql`CREATE INDEX notification_deliveries_state_due_idx
    ON notification_deliveries(state,next_attempt_at,delivery_id)
    WHERE state IN ('pending','retryable')`.execute(db);

  await sql`CREATE FUNCTION validate_notification_recipient_lifecycle() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      PERFORM 1 FROM accounts
       WHERE id=NEW.recipient_account_id AND status='active' AND deleted_at IS NULL
       FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Notification recipient Account is unavailable'
          USING ERRCODE='23503', CONSTRAINT='notification_recipient_active';
      END IF;
      RETURN NEW;
    END
    $function$`.execute(db);
  await sql`CREATE TRIGGER notification_preferences_recipient_guard
    BEFORE INSERT ON notification_preferences FOR EACH ROW
    EXECUTE FUNCTION validate_notification_recipient_lifecycle()`.execute(db);
  await sql`CREATE TRIGGER notifications_recipient_guard
    BEFORE INSERT ON notifications FOR EACH ROW
    EXECUTE FUNCTION validate_notification_recipient_lifecycle()`.execute(db);

  await sql`CREATE FUNCTION validate_notification_actor_lifecycle() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF NEW.actor_profile_id IS NULL THEN
        RETURN NEW;
      END IF;
      PERFORM 1 FROM accounts
       WHERE id=NEW.actor_profile_id AND status='active' AND deleted_at IS NULL
       FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Notification actor Account is unavailable'
          USING ERRCODE='23503', CONSTRAINT='notification_actor_active';
      END IF;
      RETURN NEW;
    END
    $function$`.execute(db);
  await sql`CREATE TRIGGER notifications_actor_guard
    BEFORE INSERT ON notifications FOR EACH ROW
    EXECUTE FUNCTION validate_notification_actor_lifecycle()`.execute(db);

  await sql`CREATE FUNCTION guard_notification_preference_transition() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF NEW.recipient_account_id IS DISTINCT FROM OLD.recipient_account_id
         OR NEW.channel IS DISTINCT FROM OLD.channel
         OR NEW.state_revision <> OLD.state_revision + 1
         OR NEW.updated_at <= OLD.updated_at THEN
        RAISE EXCEPTION 'Illegal Notification preference transition'
          USING ERRCODE='23514', CONSTRAINT='notification_preferences_transition_guard';
      END IF;
      RETURN NEW;
    END
    $function$`.execute(db);
  await sql`CREATE TRIGGER notification_preferences_transition_guard
    BEFORE UPDATE ON notification_preferences FOR EACH ROW
    EXECUTE FUNCTION guard_notification_preference_transition()`.execute(db);

  await sql`CREATE FUNCTION guard_notification_transition() RETURNS trigger
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

  await sql`CREATE FUNCTION guard_notification_delivery_transition() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF TG_OP='INSERT' THEN
        IF NEW.state <> 'pending' OR NEW.attempt_count <> 0 OR NEW.state_revision <> 0 THEN
          RAISE EXCEPTION 'Illegal initial Notification delivery state'
            USING ERRCODE='23514', CONSTRAINT='notification_deliveries_transition_guard';
        END IF;
        RETURN NEW;
      END IF;
      IF NEW.delivery_id IS DISTINCT FROM OLD.delivery_id
         OR NEW.notification_id IS DISTINCT FROM OLD.notification_id
         OR NEW.recipient_account_id IS DISTINCT FROM OLD.recipient_account_id
         OR NEW.channel IS DISTINCT FROM OLD.channel
         OR NEW.created_at IS DISTINCT FROM OLD.created_at
         OR NEW.state_revision <> OLD.state_revision + 1
         OR NOT ((OLD.state IN ('pending','retryable') AND NEW.state IN ('leased','suppressed'))
           OR (OLD.state='leased' AND NEW.state IN
             ('retryable','delivered','suppressed','dead_letter'))) THEN
        RAISE EXCEPTION 'Illegal Notification delivery transition'
          USING ERRCODE='23514', CONSTRAINT='notification_deliveries_transition_guard';
      END IF;
      RETURN NEW;
    END
    $function$`.execute(db);
  await sql`CREATE TRIGGER notification_deliveries_transition_guard
    BEFORE INSERT OR UPDATE ON notification_deliveries FOR EACH ROW
    EXECUTE FUNCTION guard_notification_delivery_transition()`.execute(db);

  await sql`CREATE FUNCTION remove_notification_authority_for_inactive_account() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      DELETE FROM notifications
       WHERE recipient_account_id=NEW.id OR actor_profile_id=NEW.id;
      DELETE FROM notification_preferences WHERE recipient_account_id=NEW.id;
      RETURN NULL;
    END
    $function$`.execute(db);
  await sql`CREATE TRIGGER accounts_remove_notification_authority
    AFTER UPDATE OF status,deleted_at ON accounts FOR EACH ROW
    WHEN (NEW.status <> 'active' OR NEW.deleted_at IS NOT NULL)
    EXECUTE FUNCTION remove_notification_authority_for_inactive_account()`.execute(db);
}

/** Developer-only destructive rollback; drain future Notification writers first. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS accounts_remove_notification_authority ON accounts`.execute(db);
  await sql`DROP FUNCTION IF EXISTS remove_notification_authority_for_inactive_account()`.execute(db);
  await sql`DROP TABLE IF EXISTS notification_deliveries`.execute(db);
  await sql`DROP FUNCTION IF EXISTS guard_notification_delivery_transition()`.execute(db);
  await sql`DROP TABLE IF EXISTS notifications`.execute(db);
  await sql`DROP FUNCTION IF EXISTS guard_notification_transition()`.execute(db);
  await sql`DROP FUNCTION IF EXISTS validate_notification_actor_lifecycle()`.execute(db);
  await sql`DROP TABLE IF EXISTS notification_preferences`.execute(db);
  await sql`DROP FUNCTION IF EXISTS guard_notification_preference_transition()`.execute(db);
  await sql`DROP FUNCTION IF EXISTS validate_notification_recipient_lifecycle()`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
