import { sql, type Kysely, type Migration } from 'kysely';

/** ND-03: expand-only News Digest persistence contract in public schema.
 *  Empty `down` leaves objects in place, so `up` must be re-entrant after Kysely
 *  forgets the migration row. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS digest_series (
    id text PRIMARY KEY REFERENCES resource_id_ledger(resource_id) ON DELETE RESTRICT,
    owner_subject_id text NOT NULL REFERENCES accounts(subject_id) ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
    title text NOT NULL CHECK (length(title) BETWEEN 1 AND 512 AND btrim(title) <> ''),
    summary text CHECK (summary IS NULL OR length(summary) <= 2000),
    slug text CHECK (slug IS NULL OR (length(slug) BETWEEN 3 AND 63 AND slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')),
    visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','protected','unlisted','public')),
    allow_search_indexing boolean NOT NULL DEFAULT false,
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','archived')),
    resource_revision text NOT NULL CHECK (length(resource_revision) BETWEEN 1 AND 128),
    content_revision text NOT NULL CHECK (length(content_revision) BETWEEN 1 AND 128),
    policy_revision text NOT NULL CHECK (length(policy_revision) BETWEEN 1 AND 128),
    commit_ordinal bigint NOT NULL DEFAULT 0 CHECK (commit_ordinal >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT digest_series_archive_state_check CHECK ((state = 'active' AND deleted_at IS NULL) OR (state = 'archived' AND deleted_at IS NOT NULL))
  )`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS digest_series_slug_unique ON digest_series(slug) WHERE slug IS NOT NULL`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS digest_series_owner_updated_idx ON digest_series(owner_subject_id, updated_at DESC, id)`.execute(db);

  await sql`CREATE TABLE IF NOT EXISTS digest_editions (
    id text PRIMARY KEY REFERENCES resource_id_ledger(resource_id) ON DELETE RESTRICT,
    series_id text NOT NULL REFERENCES digest_series(id) ON DELETE RESTRICT,
    source_collection_id text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
    issue_key text NOT NULL CHECK (length(issue_key) BETWEEN 1 AND 128 AND btrim(issue_key) <> '' AND issue_key !~ '[[:cntrl:]]'),
    edition_ordinal bigint NOT NULL CHECK (edition_ordinal > 0),
    title_snapshot text NOT NULL CHECK (length(title_snapshot) BETWEEN 1 AND 512 AND btrim(title_snapshot) <> ''),
    summary_snapshot text CHECK (summary_snapshot IS NULL OR length(summary_snapshot) <= 2000),
    source_content_revision text NOT NULL CHECK (length(source_content_revision) BETWEEN 1 AND 128),
    source_policy_revision text CHECK (source_policy_revision IS NULL OR length(source_policy_revision) BETWEEN 1 AND 128),
    resource_revision text NOT NULL CHECK (length(resource_revision) BETWEEN 1 AND 128),
    period_start timestamptz,
    period_end timestamptz,
    state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','published','withdrawn','detached')),
    published_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    withdrawn_at timestamptz,
    detached_at timestamptz,
    CONSTRAINT digest_editions_issue_key_unique UNIQUE (series_id, issue_key),
    CONSTRAINT digest_editions_period_order_check CHECK (period_start IS NULL OR period_end IS NULL OR period_end > period_start),
    CONSTRAINT digest_editions_published_state_check CHECK ((state IN ('draft','detached') AND published_at IS NULL) OR (state IN ('published','withdrawn') AND published_at IS NOT NULL)),
    CONSTRAINT digest_editions_terminal_timestamp_check CHECK ((state = 'withdrawn' AND withdrawn_at IS NOT NULL) OR (state <> 'withdrawn' AND withdrawn_at IS NULL) OR state = 'detached'),
    CONSTRAINT digest_editions_detached_timestamp_check CHECK ((state = 'detached' AND detached_at IS NOT NULL) OR (state <> 'detached' AND detached_at IS NULL))
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS digest_editions_series_state_published_idx ON digest_editions(series_id, state, published_at DESC, edition_ordinal DESC, id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS digest_editions_source_collection_idx ON digest_editions(source_collection_id, state, id)`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION forbid_digest_edition_rebind() RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN
      IF NEW.series_id IS DISTINCT FROM OLD.series_id OR NEW.source_collection_id IS DISTINCT FROM OLD.source_collection_id THEN
        RAISE EXCEPTION 'digest edition identity and source are immutable' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
  $body$`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER digest_editions_rebind_guard
    BEFORE UPDATE OF series_id, source_collection_id ON digest_editions
    FOR EACH ROW EXECUTE FUNCTION forbid_digest_edition_rebind()`.execute(db);

  await sql`CREATE TABLE IF NOT EXISTS digest_members (
    series_id text NOT NULL REFERENCES digest_series(id) ON DELETE RESTRICT,
    subject_id text NOT NULL REFERENCES accounts(subject_id) ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
    role text NOT NULL CHECK (role IN ('owner','editor','viewer')),
    granted_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    PRIMARY KEY (series_id, subject_id),
    CONSTRAINT digest_members_owner_live_check CHECK (role <> 'owner' OR revoked_at IS NULL)
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS digest_members_subject_idx ON digest_members(subject_id, series_id)`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION validate_digest_series_owner_membership() RETURNS trigger LANGUAGE plpgsql AS $body$
    DECLARE target_series text;
    DECLARE owner_subject text;
    BEGIN
      -- OLD/NEW are polymorphic trigger records.  They must only be
      -- dereferenced inside the table-specific branch; PostgreSQL otherwise
      -- attempts to resolve OLD.role while this function handles
      -- digest_series, whose row has no role column.
      IF TG_TABLE_NAME = 'digest_members' THEN
        IF TG_OP = 'DELETE' AND OLD.role = 'owner' THEN
          RAISE EXCEPTION 'digest owner membership cannot be revoked' USING ERRCODE = '23514';
        END IF;
        IF TG_OP = 'UPDATE' AND OLD.role = 'owner'
           AND (NEW.role <> 'owner' OR NEW.revoked_at IS NOT NULL OR NEW.subject_id IS DISTINCT FROM OLD.subject_id) THEN
          RAISE EXCEPTION 'digest owner membership cannot be downgraded' USING ERRCODE = '23514';
        END IF;
      END IF;
      IF TG_TABLE_NAME = 'digest_series' THEN
        target_series := NEW.id;
      ELSIF TG_OP = 'DELETE' THEN
        target_series := OLD.series_id;
      ELSE
        target_series := NEW.series_id;
      END IF;
      SELECT owner_subject_id INTO owner_subject FROM digest_series WHERE id = target_series;
      IF owner_subject IS NULL OR NOT EXISTS (
        SELECT 1 FROM digest_members
         WHERE series_id = target_series AND subject_id = owner_subject
           AND role = 'owner' AND revoked_at IS NULL
      ) THEN
        RAISE EXCEPTION 'digest series must retain an active owner membership' USING ERRCODE = '23514';
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END
  $body$`.execute(db);
  // PostgreSQL cannot replace a constraint trigger in place. A second
  // expand-only up must keep the deferred owner guard without DROP.
  await sql`
    DO $reentrant$
    BEGIN
      CREATE CONSTRAINT TRIGGER digest_series_owner_membership_guard
        AFTER INSERT OR UPDATE ON digest_series
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION validate_digest_series_owner_membership();
    EXCEPTION
      WHEN duplicate_object THEN
        NULL;
    END
    $reentrant$
  `.execute(db);
  await sql`
    DO $reentrant$
    BEGIN
      CREATE CONSTRAINT TRIGGER digest_members_owner_membership_guard
        AFTER INSERT OR UPDATE OR DELETE ON digest_members
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION validate_digest_series_owner_membership();
    EXCEPTION
      WHEN duplicate_object THEN
        NULL;
    END
    $reentrant$
  `.execute(db);

  await sql`CREATE TABLE IF NOT EXISTS digest_follows (
    series_id text NOT NULL REFERENCES digest_series(id) ON DELETE RESTRICT,
    follower_profile_id text NOT NULL REFERENCES profiles(account_id) ON DELETE RESTRICT,
    followed_at timestamptz NOT NULL DEFAULT now(),
    unfollowed_at timestamptz,
    PRIMARY KEY (series_id, follower_profile_id)
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS digest_follows_follower_idx ON digest_follows(follower_profile_id, series_id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS digest_follows_series_idx ON digest_follows(series_id, follower_profile_id) WHERE unfollowed_at IS NULL`.execute(db);

  await sql`CREATE TABLE IF NOT EXISTS digest_schedules (
    id text PRIMARY KEY,
    series_id text NOT NULL UNIQUE REFERENCES digest_series(id) ON DELETE RESTRICT,
    enabled boolean NOT NULL DEFAULT true,
    rrule text NOT NULL CHECK (length(rrule) BETWEEN 1 AND 1024 AND btrim(rrule) <> '' AND rrule !~ '[[:cntrl:]]'),
    dtstart timestamptz NOT NULL,
    time_zone text NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 128 AND time_zone !~ '[[:cntrl:]]'),
    catch_up_policy text NOT NULL DEFAULT 'skip' CHECK (catch_up_policy IN ('skip','one')),
    max_catch_up integer NOT NULL DEFAULT 0 CHECK (max_catch_up BETWEEN 0 AND 100),
    next_run_at timestamptz,
    resource_revision text NOT NULL CHECK (length(resource_revision) BETWEEN 1 AND 128),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS digest_schedules_due_idx ON digest_schedules(next_run_at, id) WHERE enabled AND deleted_at IS NULL`.execute(db);

  await sql`CREATE TABLE IF NOT EXISTS digest_runs (
    id text PRIMARY KEY,
    schedule_id text NOT NULL REFERENCES digest_schedules(id) ON DELETE RESTRICT,
    occurrence_key text NOT NULL CHECK (length(occurrence_key) BETWEEN 1 AND 256 AND occurrence_key !~ '[[:cntrl:]]'),
    scheduled_for timestamptz NOT NULL,
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','succeeded','retryable','failed','cancelled')),
    lease_owner text,
    lease_until timestamptz,
    lease_generation bigint NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at timestamptz,
    last_error_class text,
    issue_key text,
    command_id text,
    edition_id text REFERENCES digest_editions(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (schedule_id, occurrence_key),
    CONSTRAINT digest_runs_lease_state_check CHECK ((state = 'leased' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL) OR state <> 'leased'),
    CONSTRAINT digest_runs_issue_key_shape CHECK (issue_key IS NULL OR (length(issue_key) BETWEEN 1 AND 128 AND btrim(issue_key) <> '' AND issue_key !~ '[[:cntrl:]]')),
    CONSTRAINT digest_runs_error_class_shape CHECK (last_error_class IS NULL OR (length(last_error_class) BETWEEN 1 AND 128 AND last_error_class !~ '[[:cntrl:]]')),
    CONSTRAINT digest_runs_identity_pair_check CHECK ((issue_key IS NULL AND command_id IS NULL) OR (issue_key IS NOT NULL AND command_id IS NOT NULL))
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS digest_runs_lease_idx ON digest_runs(lease_until, id) WHERE state = 'leased'`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS digest_runs_state_attempt_idx ON digest_runs(state, next_attempt_at, id)`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS digest_runs_command_id_unique ON digest_runs(command_id) WHERE command_id IS NOT NULL`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS digest_runs_edition_id_unique ON digest_runs(edition_id) WHERE edition_id IS NOT NULL`.execute(db);

  await sql`CREATE TABLE IF NOT EXISTS digest_audit_events (
    event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    series_id text REFERENCES digest_series(id) ON DELETE RESTRICT,
    edition_id text REFERENCES digest_editions(id) ON DELETE RESTRICT,
    principal_id text NOT NULL,
    principal_type text NOT NULL,
    action text NOT NULL,
    changed jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT digest_audit_events_target_check CHECK (series_id IS NOT NULL OR edition_id IS NOT NULL),
    CONSTRAINT digest_audit_events_json_check CHECK (jsonb_typeof(changed) = 'object' AND jsonb_typeof(details) = 'object')
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS digest_audit_events_series_time_idx ON digest_audit_events(series_id, occurred_at DESC, event_id DESC)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS digest_audit_events_edition_time_idx ON digest_audit_events(edition_id, occurred_at DESC, event_id DESC)`.execute(db);

  await sql`CREATE OR REPLACE FUNCTION forbid_digest_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN
      RAISE EXCEPTION 'digest audit events are append-only' USING ERRCODE = '55000';
    END
  $body$`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER digest_audit_events_append_only
    BEFORE UPDATE OR DELETE ON digest_audit_events
    FOR EACH ROW EXECUTE FUNCTION forbid_digest_audit_mutation()`.execute(db);

  await sql`COMMENT ON TABLE digest_audit_events IS 'known.append_heavy=true; typed ledger authority registry'`.execute(db);
}

/** Expand-only contract: production rollback is flag-off; never run migration down. */
export async function down(_db: Kysely<unknown>): Promise<void> {
  // Intentionally empty. These tables are retained for rollback safety and auditability.
}

export const migration: Migration = { up, down };
export default migration;
