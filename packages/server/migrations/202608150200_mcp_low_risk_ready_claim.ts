import { sql, type Kysely, type Migration } from 'kysely';

/**
 * FIX-M-016: unified Change Plan state machine.
 *
 * Low-risk ready Plans (`requires_approval = false`, mode `ready`) claim
 * directly under binding/receipt/row lock: `pending -> committing` is now a
 * legal transition, and `committing -> pending` restores a ready Plan when an
 * abort returns it to its pre-claim state. Approval-required Plans keep the
 * existing transitions (`pending -> approved -> committing -> consumed`).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION guard_mcp_change_plan_transition() RETURNS trigger
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
          OR (OLD.status = 'pending' AND NOT OLD.requires_approval AND NEW.status = 'committing')
          OR (OLD.status = 'approved' AND NEW.status IN ('committing', 'cancelled', 'expired'))
          OR (OLD.status = 'committing' AND NEW.status IN ('approved', 'consumed'))
          OR (OLD.status = 'committing' AND NOT OLD.requires_approval AND NEW.status = 'pending')
      ) THEN
        RAISE EXCEPTION 'Illegal MCP Change Plan state transition'
          USING ERRCODE='23514', CONSTRAINT='mcp_change_plans_transition_guard';
      END IF;
      RETURN NEW;
    END
  $function$`.execute(db);
}

/**
 * Developer-only rollback to the approval-gated state machine of the original
 * MCP-W02 migration.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION guard_mcp_change_plan_transition() RETURNS trigger
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
}

const migration: Migration = { up, down };
export default migration;
