import { sql, type Kysely, type Migration } from 'kysely';

/**
 * MCP-W02: session-free durable Change Plan, Approval, and Commit receipt
 * authority for MCP `2026-07-28` Write.
 *
 * The schema deliberately has no MCP Session column. Authorization is
 * persisted only as token-free binding facts and a SHA-256 binding digest.
 * Expiry, retention, status transitions, binding immutability, and
 * first-result replay are enforced by PostgreSQL constraints/triggers using
 * the database clock (`current_timestamp`).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE FUNCTION mcp_json_has_legacy_session_key(value jsonb)
    RETURNS boolean
    LANGUAGE sql
    IMMUTABLE
    STRICT
    AS $function$
      SELECT CASE WHEN jsonb_typeof(value) = 'object' THEN EXISTS (
        SELECT 1 FROM jsonb_object_keys(value) AS legacy_key
        WHERE lower(legacy_key) IN (
          'sessionid', 'session_id', 'mcp-session-id', 'mcpsessionid',
          'mcp_session_id', 'session'
        )
      ) ELSE false END
    $function$`.execute(db);

  await sql`CREATE TABLE mcp_change_plans (
    plan_id text PRIMARY KEY,
    binding_kind text NOT NULL CHECK (binding_kind = 'authenticated'),
    principal_id text NOT NULL CHECK (btrim(principal_id) <> ''),
    client_id text NOT NULL CHECK (btrim(client_id) <> ''),
    credential_binding_id text NOT NULL CHECK (btrim(credential_binding_id) <> ''),
    resource_audience text NOT NULL CHECK (btrim(resource_audience) <> ''),
    security_epoch text NOT NULL CHECK (btrim(security_epoch) <> ''),
    binding_digest text NOT NULL CHECK (binding_digest ~ '^[0-9a-f]{64}$'),
    binding_json jsonb NOT NULL,
    status text NOT NULL CHECK (status IN (
      'pending', 'approved', 'committing', 'consumed', 'cancelled', 'expired'
    )),
    risk text NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
    requires_approval boolean NOT NULL,
    approval_method text,
    approval_uri text,
    summary text NOT NULL,
    impact_json jsonb NOT NULL CHECK (jsonb_typeof(impact_json) = 'object'),
    required_scopes_json jsonb NOT NULL CHECK (jsonb_typeof(required_scopes_json) = 'array'),
    base_revisions_json jsonb NOT NULL CHECK (jsonb_typeof(base_revisions_json) = 'object'),
    operations_json jsonb NOT NULL CHECK (jsonb_typeof(operations_json) = 'array'),
    operations_digest text NOT NULL CHECK (length(operations_digest) BETWEEN 1 AND 256),
    untrusted_note text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    retained_until timestamptz NOT NULL DEFAULT current_timestamp + interval '30 days',
    CONSTRAINT mcp_change_plans_binding_no_session_check
      CHECK (NOT mcp_json_has_legacy_session_key(binding_json)),
    CONSTRAINT mcp_change_plans_approval_binding_check CHECK (
      (requires_approval AND approval_method = 'out_of_band' AND approval_uri IS NOT NULL)
      OR (NOT requires_approval AND approval_method IS NULL AND approval_uri IS NULL)
    ),
    CONSTRAINT mcp_change_plans_time_check CHECK (
      created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz
      AND expires_at > '-infinity'::timestamptz AND expires_at < 'infinity'::timestamptz
      AND expires_at > created_at
      AND retained_until > '-infinity'::timestamptz AND retained_until < 'infinity'::timestamptz
    )
  )`.execute(db);

  await sql`CREATE TABLE mcp_approvals (
    plan_id text PRIMARY KEY REFERENCES mcp_change_plans(plan_id) ON DELETE CASCADE,
    binding_digest text NOT NULL CHECK (binding_digest ~ '^[0-9a-f]{64}$'),
    operations_digest text NOT NULL CHECK (length(operations_digest) BETWEEN 1 AND 256),
    decided_at timestamptz NOT NULL DEFAULT current_timestamp,
    consumed_at timestamptz,
    retained_until timestamptz NOT NULL DEFAULT current_timestamp + interval '30 days',
    CONSTRAINT mcp_approvals_binding_unique
      UNIQUE (plan_id, binding_digest, operations_digest),
    CONSTRAINT mcp_approvals_time_check CHECK (
      decided_at > '-infinity'::timestamptz AND decided_at < 'infinity'::timestamptz
      AND retained_until > '-infinity'::timestamptz AND retained_until < 'infinity'::timestamptz
      AND (consumed_at IS NULL OR consumed_at >= decided_at)
    )
  )`.execute(db);

  await sql`CREATE TABLE mcp_commit_receipts (
    plan_id text NOT NULL REFERENCES mcp_change_plans(plan_id) ON DELETE CASCADE,
    idempotency_key text NOT NULL CHECK (btrim(idempotency_key) <> ''),
    binding_digest text NOT NULL CHECK (binding_digest ~ '^[0-9a-f]{64}$'),
    operations_digest text NOT NULL CHECK (length(operations_digest) BETWEEN 1 AND 256),
    result_json jsonb,
    result_digest text CHECK (result_digest IS NULL OR result_digest ~ '^[0-9a-f]{64}$'),
    claimed_at timestamptz NOT NULL DEFAULT current_timestamp,
    completed_at timestamptz,
    retained_until timestamptz NOT NULL DEFAULT current_timestamp + interval '30 days',
    PRIMARY KEY (plan_id, idempotency_key),
    CONSTRAINT mcp_commit_receipts_result_check CHECK (
      (result_json IS NULL AND result_digest IS NULL AND completed_at IS NULL)
      OR (result_json IS NOT NULL AND result_digest IS NOT NULL AND completed_at IS NOT NULL)
    ),
    CONSTRAINT mcp_commit_receipts_time_check CHECK (
      claimed_at > '-infinity'::timestamptz AND claimed_at < 'infinity'::timestamptz
      AND retained_until > '-infinity'::timestamptz AND retained_until < 'infinity'::timestamptz
      AND (completed_at IS NULL OR completed_at >= claimed_at)
    )
  )`.execute(db);

  await sql`CREATE INDEX mcp_change_plans_binding_digest_idx
    ON mcp_change_plans(binding_digest)`.execute(db);
  await sql`CREATE INDEX mcp_change_plans_expiry_status_idx
    ON mcp_change_plans(status, expires_at)`.execute(db);
  await sql`CREATE INDEX mcp_change_plans_retention_idx
    ON mcp_change_plans(retained_until) WHERE status IN (
      'consumed', 'cancelled', 'expired'
    )`.execute(db);
  await sql`CREATE INDEX mcp_approvals_binding_digest_idx
    ON mcp_approvals(binding_digest)`.execute(db);
  await sql`CREATE INDEX mcp_approvals_retention_idx
    ON mcp_approvals(retained_until) WHERE consumed_at IS NOT NULL`.execute(db);
  await sql`CREATE INDEX mcp_commit_receipts_binding_digest_idx
    ON mcp_commit_receipts(binding_digest)`.execute(db);
  await sql`CREATE INDEX mcp_commit_receipts_retention_idx
    ON mcp_commit_receipts(retained_until) WHERE completed_at IS NOT NULL`.execute(db);

  await sql`CREATE FUNCTION guard_mcp_change_plan_transition() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'pending' THEN
          RAISE EXCEPTION 'Illegal initial MCP Change Plan state'
            USING ERRCODE='23514', CONSTRAINT='mcp_change_plans_transition_guard';
        END IF;
        RETURN NEW;
      END IF;

      IF NEW.plan_id IS DISTINCT FROM OLD.plan_id
          OR NEW.binding_kind IS DISTINCT FROM OLD.binding_kind
          OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
          OR NEW.client_id IS DISTINCT FROM OLD.client_id
          OR NEW.credential_binding_id IS DISTINCT FROM OLD.credential_binding_id
          OR NEW.resource_audience IS DISTINCT FROM OLD.resource_audience
          OR NEW.security_epoch IS DISTINCT FROM OLD.security_epoch
          OR NEW.binding_digest IS DISTINCT FROM OLD.binding_digest
          OR NEW.binding_json IS DISTINCT FROM OLD.binding_json
          OR NEW.risk IS DISTINCT FROM OLD.risk
          OR NEW.requires_approval IS DISTINCT FROM OLD.requires_approval
          OR NEW.approval_method IS DISTINCT FROM OLD.approval_method
          OR NEW.approval_uri IS DISTINCT FROM OLD.approval_uri
          OR NEW.summary IS DISTINCT FROM OLD.summary
          OR NEW.impact_json IS DISTINCT FROM OLD.impact_json
          OR NEW.required_scopes_json IS DISTINCT FROM OLD.required_scopes_json
          OR NEW.base_revisions_json IS DISTINCT FROM OLD.base_revisions_json
          OR NEW.operations_json IS DISTINCT FROM OLD.operations_json
          OR NEW.operations_digest IS DISTINCT FROM OLD.operations_digest
          OR NEW.untrusted_note IS DISTINCT FROM OLD.untrusted_note
          OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
          OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'MCP Change Plan binding and content are immutable'
          USING ERRCODE='23514', CONSTRAINT='mcp_change_plans_binding_immutable';
      END IF;

      IF NEW.status <> OLD.status AND NOT (
          (OLD.status = 'pending' AND NEW.status IN ('approved', 'cancelled', 'expired'))
          OR (OLD.status = 'approved' AND NEW.status IN ('committing', 'cancelled', 'expired'))
          OR (OLD.status = 'committing' AND NEW.status IN ('approved', 'consumed'))
      ) THEN
        RAISE EXCEPTION 'Illegal MCP Change Plan state transition'
          USING ERRCODE='23514', CONSTRAINT='mcp_change_plans_transition_guard';
      END IF;
      RETURN NEW;
    END
  $function$`.execute(db);
  await sql`CREATE TRIGGER mcp_change_plans_transition_guard
    BEFORE INSERT OR UPDATE ON mcp_change_plans
    FOR EACH ROW EXECUTE FUNCTION guard_mcp_change_plan_transition()`.execute(db);

  await sql`CREATE FUNCTION guard_mcp_approval_immutable() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.consumed_at IS NOT NULL THEN
          RAISE EXCEPTION 'Approval must start unconsumed'
            USING ERRCODE='23514', CONSTRAINT='mcp_approvals_consume_guard';
        END IF;
        RETURN NEW;
      END IF;
      IF NEW.plan_id IS DISTINCT FROM OLD.plan_id
          OR NEW.binding_digest IS DISTINCT FROM OLD.binding_digest
          OR NEW.operations_digest IS DISTINCT FROM OLD.operations_digest
          OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
          THEN
        RAISE EXCEPTION 'MCP Approval binding is immutable'
          USING ERRCODE='23514', CONSTRAINT='mcp_approvals_binding_immutable';
      END IF;
      IF OLD.consumed_at IS NOT NULL THEN
        IF NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
          RAISE EXCEPTION 'MCP Approval can only transition once from unconsumed to consumed'
            USING ERRCODE='23514', CONSTRAINT='mcp_approvals_consume_guard';
        END IF;
        RETURN NEW;
      END IF;
      IF NEW.consumed_at IS NULL THEN
        RAISE EXCEPTION 'MCP Approval can only transition once from unconsumed to consumed'
          USING ERRCODE='23514', CONSTRAINT='mcp_approvals_consume_guard';
      END IF;
      RETURN NEW;
    END
  $function$`.execute(db);
  await sql`CREATE TRIGGER mcp_approvals_immutable
    BEFORE INSERT OR UPDATE ON mcp_approvals
    FOR EACH ROW EXECUTE FUNCTION guard_mcp_approval_immutable()`.execute(db);

  await sql`CREATE FUNCTION guard_mcp_commit_receipt_immutable() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        IF NEW.plan_id IS DISTINCT FROM OLD.plan_id
            OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
            OR NEW.binding_digest IS DISTINCT FROM OLD.binding_digest
            OR NEW.operations_digest IS DISTINCT FROM OLD.operations_digest
            OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at THEN
          RAISE EXCEPTION 'MCP Commit receipt identity is immutable'
            USING ERRCODE='23514', CONSTRAINT='mcp_commit_receipts_identity_immutable';
        END IF;
        IF OLD.completed_at IS NOT NULL THEN
          IF NEW.completed_at IS DISTINCT FROM OLD.completed_at
              OR NEW.result_json IS DISTINCT FROM OLD.result_json
              OR NEW.result_digest IS DISTINCT FROM OLD.result_digest THEN
            RAISE EXCEPTION 'MCP Commit receipt first result is immutable'
              USING ERRCODE='23514', CONSTRAINT='mcp_commit_receipts_result_immutable';
          END IF;
          RETURN NEW;
        END IF;
        IF NEW.completed_at IS NULL THEN
          RETURN NEW;
        END IF;
        IF NEW.result_json IS NULL OR NEW.result_digest IS NULL THEN
          RAISE EXCEPTION 'MCP Commit receipt must finalize with result and digest'
            USING ERRCODE='23514', CONSTRAINT='mcp_commit_receipts_finalization_guard';
        END IF;
      END IF;
      RETURN NEW;
    END
  $function$`.execute(db);
  await sql`CREATE TRIGGER mcp_commit_receipts_immutable
    BEFORE UPDATE ON mcp_commit_receipts
    FOR EACH ROW EXECUTE FUNCTION guard_mcp_commit_receipt_immutable()`.execute(db);

  await sql`COMMENT ON TABLE mcp_change_plans IS
    'MCP-W02 session-free durable Change Plans; authorization binding facts and canonical digest are immutable.'`.execute(db);
  await sql`COMMENT ON TABLE mcp_approvals IS
    'MCP-W02 one-time out-of-band Approval bound to the Plan authorization digest.'`.execute(db);
  await sql`COMMENT ON TABLE mcp_commit_receipts IS
    'MCP-W02 first Commit result replay rows keyed by Plan + idempotency key.'`.execute(db);
}

/**
 * Developer-only destructive rollback after all MCP-W02 writers are drained.
 * Dropping Plan/Approval/receipt authority is not a production data rollback.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS mcp_commit_receipts_immutable ON mcp_commit_receipts`.execute(db);
  await sql`DROP FUNCTION IF EXISTS guard_mcp_commit_receipt_immutable()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS mcp_approvals_immutable ON mcp_approvals`.execute(db);
  await sql`DROP FUNCTION IF EXISTS guard_mcp_approval_immutable()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS mcp_change_plans_transition_guard ON mcp_change_plans`.execute(db);
  await sql`DROP FUNCTION IF EXISTS guard_mcp_change_plan_transition()`.execute(db);
  await sql`DROP TABLE IF EXISTS mcp_commit_receipts`.execute(db);
  await sql`DROP TABLE IF EXISTS mcp_approvals`.execute(db);
  await sql`DROP TABLE IF EXISTS mcp_change_plans`.execute(db);
  await sql`DROP FUNCTION IF EXISTS mcp_json_has_legacy_session_key(jsonb)`.execute(db);
}

const migration: Migration = { up, down };
export default migration;
