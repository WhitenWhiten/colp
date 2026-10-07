import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Expand-only authority needed before any physical Outbox history is retired.
 *
 * Dispatch claims survive queue-row retention and preserve the original delivery identity.
 * Retention floors authorize only a monotonic prefix for one handler/event/scope; advancing a
 * floor never deletes source rows.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE outbox_dispatch_claims (
    domain_event_id text NOT NULL,
    handler_name text NOT NULL,
    outbox_id text NOT NULL,
    claimed_at timestamptz NOT NULL DEFAULT current_timestamp,
    CONSTRAINT outbox_dispatch_claims_pkey PRIMARY KEY (domain_event_id, handler_name),
    CONSTRAINT outbox_dispatch_claims_identity_outbox_key
      UNIQUE (domain_event_id, handler_name, outbox_id),
    CONSTRAINT outbox_dispatch_claims_outbox_id_key UNIQUE (outbox_id),
    CONSTRAINT outbox_dispatch_claims_domain_event_id_nonempty CHECK (length(domain_event_id) > 0),
    CONSTRAINT outbox_dispatch_claims_handler_name_nonempty CHECK (length(handler_name) > 0),
    CONSTRAINT outbox_dispatch_claims_outbox_id_nonempty CHECK (length(outbox_id) > 0),
    CONSTRAINT outbox_dispatch_claims_claimed_at_finite CHECK (
      claimed_at > '-infinity'::timestamptz AND claimed_at < 'infinity'::timestamptz
    )
  )`.execute(db);

  await sql`CREATE TABLE outbox_retention_floors (
    handler_name text NOT NULL,
    event_type text NOT NULL,
    aggregate_scope text NOT NULL,
    floor_commit_ordinal bigint NOT NULL DEFAULT 0,
    floor_domain_event_id text,
    state_revision bigint NOT NULL DEFAULT 0,
    advanced_at timestamptz NOT NULL DEFAULT current_timestamp,
    CONSTRAINT outbox_retention_floors_pkey
      PRIMARY KEY (handler_name, event_type, aggregate_scope),
    CONSTRAINT outbox_retention_floors_identity_nonempty CHECK (
      length(handler_name) > 0 AND length(event_type) > 0 AND length(aggregate_scope) > 0
    ),
    CONSTRAINT outbox_retention_floors_position_shape CHECK (
      (floor_commit_ordinal = 0 AND floor_domain_event_id IS NULL)
      OR (floor_commit_ordinal > 0 AND floor_domain_event_id IS NOT NULL
        AND length(floor_domain_event_id) > 0)
    ),
    CONSTRAINT outbox_retention_floors_state_revision_nonnegative CHECK (state_revision >= 0),
    CONSTRAINT outbox_retention_floors_advanced_at_finite CHECK (
      advanced_at > '-infinity'::timestamptz AND advanced_at < 'infinity'::timestamptz
    )
  )`.execute(db);

  await sql`CREATE FUNCTION claim_outbox_dispatch_identity() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      -- Every physical INSERT is a new delivery attempt and must claim two permanent identities.
      PERFORM pg_advisory_xact_lock(hashtextextended(length(NEW.domain_event_id)::text || ':'
        || NEW.domain_event_id || NEW.handler_name, 710));
      IF NEW.aggregate_scope IS NOT NULL AND NEW.commit_ordinal IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(length(NEW.handler_name)::text || ':'
          || NEW.handler_name || length(NEW.event_type)::text || ':' || NEW.event_type
          || NEW.aggregate_scope, 711));
        IF EXISTS (
          SELECT 1 FROM outbox_retention_floors floor
           WHERE floor.handler_name = NEW.handler_name
             AND floor.event_type = NEW.event_type
             AND floor.aggregate_scope = NEW.aggregate_scope
             AND (NEW.commit_ordinal, NEW.domain_event_id)
                   <= (floor.floor_commit_ordinal, floor.floor_domain_event_id)
        ) THEN
          RAISE EXCEPTION 'Outbox source identity is at or below its retention floor'
            USING ERRCODE = '23514', CONSTRAINT = 'outbox_events_below_retention_floor';
        END IF;
      END IF;
      BEGIN
        INSERT INTO outbox_dispatch_claims(domain_event_id, handler_name, outbox_id)
        VALUES(NEW.domain_event_id, NEW.handler_name, NEW.outbox_id);
      EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'Outbox dispatch or outbox id is permanently claimed'
          USING ERRCODE = '23505', CONSTRAINT = 'outbox_dispatch_claims_permanent_once';
      END;
      RETURN NEW;
    END
    $function$`.execute(db);
  await sql`CREATE TRIGGER outbox_events_claim_dispatch_identity
    AFTER INSERT ON outbox_events
    FOR EACH ROW EXECUTE FUNCTION claim_outbox_dispatch_identity()`.execute(db);

  await sql`CREATE FUNCTION guard_outbox_source_below_retention_floor() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF ((OLD.handler_name = 'social.publish-collection-change'
            AND OLD.event_type = 'social.collection-change')
          OR (NEW.handler_name = 'social.publish-collection-change'
            AND NEW.event_type = 'social.collection-change'))
         AND (NEW.outbox_id IS DISTINCT FROM OLD.outbox_id
         OR NEW.domain_event_id IS DISTINCT FROM OLD.domain_event_id
         OR NEW.event_type IS DISTINCT FROM OLD.event_type
         OR NEW.event_version IS DISTINCT FROM OLD.event_version
         OR NEW.handler_name IS DISTINCT FROM OLD.handler_name
         OR NEW.handler_mode IS DISTINCT FROM OLD.handler_mode
         OR NEW.aggregate_type IS DISTINCT FROM OLD.aggregate_type
         OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
         OR NEW.aggregate_scope IS DISTINCT FROM OLD.aggregate_scope
         OR NEW.aggregate_revision IS DISTINCT FROM OLD.aggregate_revision
         OR NEW.commit_ordinal IS DISTINCT FROM OLD.commit_ordinal
         OR NEW.payload_json IS DISTINCT FROM OLD.payload_json
         OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at) THEN
        RAISE EXCEPTION 'Outbox source envelope identity is immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'outbox_events_source_identity_immutable';
      END IF;
      IF NEW.aggregate_scope IS NOT NULL AND NEW.commit_ordinal IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(length(NEW.handler_name)::text || ':'
          || NEW.handler_name || length(NEW.event_type)::text || ':' || NEW.event_type
          || NEW.aggregate_scope, 711));
        IF NEW.state <> 'completed' AND EXISTS (
          SELECT 1 FROM outbox_retention_floors floor
           WHERE floor.handler_name = NEW.handler_name
             AND floor.event_type = NEW.event_type
             AND floor.aggregate_scope = NEW.aggregate_scope
             AND (NEW.commit_ordinal, NEW.domain_event_id)
                   <= (floor.floor_commit_ordinal, floor.floor_domain_event_id)
        ) THEN
          RAISE EXCEPTION 'Outbox source below retention floor must remain completed'
            USING ERRCODE = '23514', CONSTRAINT = 'outbox_events_below_floor_unresolved';
        END IF;
      END IF;
      RETURN NEW;
    END
    $function$`.execute(db);
  await sql`CREATE TRIGGER outbox_events_retention_floor_state_guard
    BEFORE UPDATE OF state,outbox_id,domain_event_id,event_type,event_version,handler_name,
      handler_mode,aggregate_type,aggregate_id,aggregate_scope,aggregate_revision,
      commit_ordinal,payload_json,occurred_at ON outbox_events
    FOR EACH ROW EXECUTE FUNCTION guard_outbox_source_below_retention_floor()`.execute(db);

  // CREATE TRIGGER takes a table lock before the snapshotting backfill. Inserts that predate the
  // lock are visible to this statement; inserts released after commit execute the trigger.
  await sql`INSERT INTO outbox_dispatch_claims(domain_event_id, handler_name, outbox_id, claimed_at)
    SELECT domain_event_id, handler_name, outbox_id, least(occurred_at, current_timestamp)
      FROM outbox_events
    ON CONFLICT (domain_event_id, handler_name) DO NOTHING`.execute(db);

  await sql`CREATE FUNCTION guard_outbox_dispatch_claim_immutable() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      RAISE EXCEPTION 'Outbox dispatch claims are immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'outbox_dispatch_claims_immutable';
    END
    $function$`.execute(db);
  await sql`CREATE TRIGGER outbox_dispatch_claims_immutable_row
    BEFORE UPDATE OR DELETE ON outbox_dispatch_claims
    FOR EACH ROW EXECUTE FUNCTION guard_outbox_dispatch_claim_immutable()`.execute(db);
  await sql`CREATE TRIGGER outbox_dispatch_claims_immutable_truncate
    BEFORE TRUNCATE ON outbox_dispatch_claims
    FOR EACH STATEMENT EXECUTE FUNCTION guard_outbox_dispatch_claim_immutable()`.execute(db);

  await sql`ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_dispatch_claim_fk
    FOREIGN KEY (domain_event_id, handler_name, outbox_id)
    REFERENCES outbox_dispatch_claims(domain_event_id, handler_name, outbox_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED NOT VALID`.execute(db);
  await sql`ALTER TABLE outbox_events
    VALIDATE CONSTRAINT outbox_events_dispatch_claim_fk`.execute(db);

  await sql`CREATE INDEX outbox_retention_unresolved_source_idx ON outbox_events(
      handler_name, event_type, aggregate_scope, commit_ordinal, domain_event_id)
    WHERE commit_ordinal IS NOT NULL AND state <> 'completed'`.execute(db);

  await sql`CREATE FUNCTION guard_outbox_retention_floor_transition() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.floor_commit_ordinal <> 0 OR NEW.floor_domain_event_id IS NOT NULL
           OR NEW.state_revision <> 0 THEN
          RAISE EXCEPTION 'Illegal initial Outbox retention floor state'
            USING ERRCODE = '23514', CONSTRAINT = 'outbox_retention_floors_transition_guard';
        END IF;
        RETURN NEW;
      END IF;
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Outbox retention floors cannot be deleted'
          USING ERRCODE = '23514', CONSTRAINT = 'outbox_retention_floors_immutable';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended(length(NEW.handler_name)::text || ':'
        || NEW.handler_name || length(NEW.event_type)::text || ':' || NEW.event_type
        || NEW.aggregate_scope, 711));
      IF NEW.handler_name IS DISTINCT FROM OLD.handler_name
         OR NEW.event_type IS DISTINCT FROM OLD.event_type
         OR NEW.aggregate_scope IS DISTINCT FROM OLD.aggregate_scope
         OR NEW.state_revision <> OLD.state_revision + 1
         OR (NEW.floor_commit_ordinal, NEW.floor_domain_event_id)
              <= (OLD.floor_commit_ordinal, coalesce(OLD.floor_domain_event_id, ''))
         OR NEW.advanced_at < OLD.advanced_at THEN
        RAISE EXCEPTION 'Illegal Outbox retention floor transition'
          USING ERRCODE = '23514', CONSTRAINT = 'outbox_retention_floors_transition_guard';
      END IF;
      IF NEW.handler_name <> 'social.publish-collection-change'
         OR NEW.event_type <> 'social.collection-change' THEN
        RAISE EXCEPTION 'No retention policy authorizes this Outbox source stream'
          USING ERRCODE = '23514', CONSTRAINT = 'outbox_retention_floors_policy_unsupported';
      END IF;
      IF EXISTS (
        SELECT 1 FROM outbox_events source
         WHERE source.handler_name = NEW.handler_name
           AND source.event_type = NEW.event_type
           AND source.aggregate_scope = NEW.aggregate_scope
           AND source.commit_ordinal IS NOT NULL
           AND (source.commit_ordinal, source.domain_event_id)
                 <= (NEW.floor_commit_ordinal, NEW.floor_domain_event_id)
           AND source.state <> 'completed'
      ) THEN
        RAISE EXCEPTION 'Outbox retention floor cannot pass unresolved source rows'
          USING ERRCODE = '23514', CONSTRAINT = 'outbox_retention_floors_unresolved_source';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM outbox_events source
         WHERE source.handler_name = NEW.handler_name
           AND source.event_type = NEW.event_type
           AND source.aggregate_scope = NEW.aggregate_scope
           AND source.commit_ordinal = NEW.floor_commit_ordinal
           AND source.domain_event_id = NEW.floor_domain_event_id
           AND source.state = 'completed'
      ) THEN
        RAISE EXCEPTION 'Outbox retention floor boundary is not a completed source tuple'
          USING ERRCODE = '23514', CONSTRAINT = 'outbox_retention_floors_boundary_missing';
      END IF;
      IF EXISTS (
        SELECT 1 FROM outbox_events source
         WHERE source.handler_name = NEW.handler_name
           AND source.event_type = NEW.event_type
           AND source.aggregate_scope = NEW.aggregate_scope
           AND source.commit_ordinal IS NOT NULL
           AND (source.commit_ordinal, source.domain_event_id)
                 <= (NEW.floor_commit_ordinal, NEW.floor_domain_event_id)
           AND source.occurred_at > current_timestamp - interval '90 days'
      ) THEN
        RAISE EXCEPTION 'Social Feed retention floor violates the 90-day minimum'
          USING ERRCODE = '23514', CONSTRAINT = 'outbox_retention_floors_policy_window';
      END IF;
      RETURN NEW;
    END
    $function$`.execute(db);
  await sql`CREATE TRIGGER outbox_retention_floors_transition_guard
    BEFORE INSERT OR UPDATE OR DELETE ON outbox_retention_floors
    FOR EACH ROW EXECUTE FUNCTION guard_outbox_retention_floor_transition()`.execute(db);
  await sql`CREATE TRIGGER outbox_retention_floors_no_truncate
    BEFORE TRUNCATE ON outbox_retention_floors
    FOR EACH STATEMENT EXECUTE FUNCTION guard_outbox_dispatch_claim_immutable()`.execute(db);

  await sql`ALTER TABLE social_feed_watermarks
    ADD COLUMN rebuild_high_source_event_id text`.execute(db);
  await sql`UPDATE social_feed_watermarks watermark
    SET rebuild_high_source_event_id = (
      SELECT event.domain_event_id FROM outbox_events event
       WHERE event.handler_name = 'social.publish-collection-change'
         AND event.event_type = 'social.collection-change'
         AND event.aggregate_scope = watermark.aggregate_scope
         AND event.commit_ordinal = watermark.rebuild_high_commit_ordinal
       ORDER BY event.domain_event_id DESC LIMIT 1
    )
    WHERE watermark.projection_state = 'rebuilding'`.execute(db);
  await sql`ALTER TABLE social_feed_watermarks
    ADD CONSTRAINT social_feed_watermarks_rebuild_high_source_shape CHECK (
      (projection_state = 'live' AND rebuild_high_source_event_id IS NULL)
      OR (projection_state = 'rebuilding' AND (
        (rebuild_high_commit_ordinal = 0 AND rebuild_high_source_event_id IS NULL)
        OR (rebuild_high_commit_ordinal > 0 AND rebuild_high_source_event_id IS NOT NULL
          AND length(rebuild_high_source_event_id) > 0)
      ))
    )`.execute(db);
  await sql`CREATE FUNCTION guard_social_feed_rebuild_high_source_transition() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF OLD.projection_state = 'rebuilding' AND NEW.projection_state = 'rebuilding'
         AND NEW.rebuild_generation = OLD.rebuild_generation
         AND NEW.rebuild_high_commit_ordinal = OLD.rebuild_high_commit_ordinal
         AND NEW.rebuild_high_source_event_id IS DISTINCT FROM OLD.rebuild_high_source_event_id THEN
        RAISE EXCEPTION 'Social Feed captured high source identity is immutable'
          USING ERRCODE = '23514',
            CONSTRAINT = 'social_feed_watermarks_rebuild_high_source_transition';
      END IF;
      RETURN NEW;
    END
    $function$`.execute(db);
  await sql`CREATE TRIGGER social_feed_watermarks_rebuild_high_source_transition
    BEFORE UPDATE OF projection_state,rebuild_generation,rebuild_high_commit_ordinal,
      rebuild_high_source_event_id ON social_feed_watermarks
    FOR EACH ROW EXECUTE FUNCTION guard_social_feed_rebuild_high_source_transition()`.execute(db);

  await sql`COMMENT ON TABLE outbox_dispatch_claims IS
    'Permanent delivery identity facts; never update, delete, or truncate rows.'`.execute(db);
  await sql`COMMENT ON TABLE outbox_retention_floors IS
    'Monotonic inclusive retained-source deletion authority; advancement does not delete Outbox rows.'`.execute(db);
}

/** Developer-only rollback; production must never remove permanent dispatch identity facts. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS social_feed_watermarks_rebuild_high_source_transition
    ON social_feed_watermarks`.execute(db);
  await sql`DROP FUNCTION IF EXISTS guard_social_feed_rebuild_high_source_transition()`.execute(db);
  await sql`ALTER TABLE social_feed_watermarks
    DROP CONSTRAINT IF EXISTS social_feed_watermarks_rebuild_high_source_shape`.execute(db);
  await sql`ALTER TABLE social_feed_watermarks
    DROP COLUMN IF EXISTS rebuild_high_source_event_id`.execute(db);
  await sql`DROP TRIGGER IF EXISTS outbox_events_retention_floor_state_guard ON outbox_events`.execute(db);
  await sql`DROP FUNCTION IF EXISTS guard_outbox_source_below_retention_floor()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS outbox_events_claim_dispatch_identity ON outbox_events`.execute(db);
  await sql`DROP FUNCTION IF EXISTS claim_outbox_dispatch_identity()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS outbox_retention_floors_no_truncate
    ON outbox_retention_floors`.execute(db);
  await sql`DROP TRIGGER IF EXISTS outbox_retention_floors_transition_guard
    ON outbox_retention_floors`.execute(db);
  await sql`DROP FUNCTION IF EXISTS guard_outbox_retention_floor_transition()`.execute(db);
  await sql`DROP TABLE IF EXISTS outbox_retention_floors`.execute(db);
  await sql`DROP INDEX IF EXISTS outbox_retention_unresolved_source_idx`.execute(db);
  await sql`ALTER TABLE outbox_events DROP CONSTRAINT IF EXISTS outbox_events_dispatch_claim_fk`.execute(db);
  await sql`DROP TRIGGER IF EXISTS outbox_dispatch_claims_immutable_truncate
    ON outbox_dispatch_claims`.execute(db);
  await sql`DROP TRIGGER IF EXISTS outbox_dispatch_claims_immutable_row
    ON outbox_dispatch_claims`.execute(db);
  await sql`DROP FUNCTION IF EXISTS guard_outbox_dispatch_claim_immutable() CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS outbox_dispatch_claims`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
