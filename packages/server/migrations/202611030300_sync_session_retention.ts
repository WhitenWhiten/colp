import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Retain terminal Session authority only until its bounded cleanup window.
 *
 * A terminated Session can never authenticate again, but its Session row and
 * binding/scope/replay rows were permanently undeletable, so the server
 * accumulated one full authority record per 15-minute renewal. Permit deletes
 * only for terminated Sessions; live Sessions stay immutable and the worker
 * still refuses to delete one that any protocol child references.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX sync_sessions_terminal_cleanup_idx
    ON sync_sessions(terminated_at, session_id) WHERE status = 'terminated'`.execute(db);

  await sql`CREATE OR REPLACE FUNCTION forbid_sync_session_authority_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $body$
    DECLARE immutable_field_changed boolean;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD.status = 'terminated' THEN RETURN OLD; END IF;
        RAISE EXCEPTION 'Sync Sessions cannot be deleted';
      END IF;
      immutable_field_changed := NEW.session_id IS DISTINCT FROM OLD.session_id OR
         NEW.account_id IS DISTINCT FROM OLD.account_id OR
         NEW.principal_subject_id IS DISTINCT FROM OLD.principal_subject_id OR
         NEW.credential_issuer IS DISTINCT FROM OLD.credential_issuer OR
         NEW.credential_id IS DISTINCT FROM OLD.credential_id OR
         NEW.oauth_client_id IS DISTINCT FROM OLD.oauth_client_id OR
         NEW.origin IS DISTINCT FROM OLD.origin OR
         NEW.session_scope IS DISTINCT FROM OLD.session_scope OR
         NEW.protocol_version IS DISTINCT FROM OLD.protocol_version OR
         NEW.collection_id IS DISTINCT FROM OLD.collection_id OR
         NEW.replica_id IS DISTINCT FROM OLD.replica_id OR
         NEW.lease_generation IS DISTINCT FROM OLD.lease_generation OR
         NEW.lease_id IS DISTINCT FROM OLD.lease_id OR
         NEW.lifecycle_revision IS DISTINCT FROM OLD.lifecycle_revision OR
         NEW.policy_revision IS DISTINCT FROM OLD.policy_revision OR
         NEW.account_security_epoch IS DISTINCT FROM OLD.account_security_epoch OR
         NEW.issued_at IS DISTINCT FROM OLD.issued_at OR
         NEW.expires_at IS DISTINCT FROM OLD.expires_at OR
         NEW.secret_digest IS DISTINCT FROM OLD.secret_digest OR
         NEW.capability_digest IS DISTINCT FROM OLD.capability_digest;
      IF OLD.status = 'active' AND NEW.status = 'active' THEN
        IF immutable_field_changed OR OLD.binding_json ? 'transportBudget' OR
           NOT (NEW.binding_json ? 'transportBudget') OR
           (NEW.binding_json - 'transportBudget') IS DISTINCT FROM OLD.binding_json OR
           NEW.termination_reason IS NOT NULL OR NEW.terminated_at IS NOT NULL THEN
          RAISE EXCEPTION 'Sync Session authority is immutable and termination is irreversible';
        END IF;
        RETURN NEW;
      END IF;
      IF OLD.status <> 'active' OR NEW.status <> 'terminated' OR
         immutable_field_changed OR NEW.binding_json IS DISTINCT FROM OLD.binding_json OR
         NEW.termination_reason IS NULL OR NEW.terminated_at IS NULL THEN
        RAISE EXCEPTION 'Sync Session authority is immutable and termination is irreversible';
      END IF;
      RETURN NEW;
    END
  $body$`.execute(db);

  await sql`CREATE OR REPLACE FUNCTION forbid_sync_session_binding_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' AND EXISTS (SELECT 1 FROM sync_sessions session
          WHERE session.session_id = OLD.session_id AND session.status = 'terminated') THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'Sync Session binding and scope facts are immutable';
    END $$`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION forbid_sync_session_receipt_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' AND EXISTS (SELECT 1 FROM sync_sessions session
          WHERE session.session_id = OLD.session_id AND session.status = 'terminated') THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'completed Sync Session replay receipts are immutable';
    END $$`.execute(db);
}

/** Developer-only destructive rollback; production uses expand/migrate/contract. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION forbid_sync_session_authority_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $body$
    DECLARE immutable_field_changed boolean;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Sync Sessions cannot be deleted';
      END IF;
      immutable_field_changed := NEW.session_id IS DISTINCT FROM OLD.session_id OR
         NEW.account_id IS DISTINCT FROM OLD.account_id OR
         NEW.principal_subject_id IS DISTINCT FROM OLD.principal_subject_id OR
         NEW.credential_issuer IS DISTINCT FROM OLD.credential_issuer OR
         NEW.credential_id IS DISTINCT FROM OLD.credential_id OR
         NEW.oauth_client_id IS DISTINCT FROM OLD.oauth_client_id OR
         NEW.origin IS DISTINCT FROM OLD.origin OR
         NEW.session_scope IS DISTINCT FROM OLD.session_scope OR
         NEW.protocol_version IS DISTINCT FROM OLD.protocol_version OR
         NEW.collection_id IS DISTINCT FROM OLD.collection_id OR
         NEW.replica_id IS DISTINCT FROM OLD.replica_id OR
         NEW.lease_generation IS DISTINCT FROM OLD.lease_generation OR
         NEW.lease_id IS DISTINCT FROM OLD.lease_id OR
         NEW.lifecycle_revision IS DISTINCT FROM OLD.lifecycle_revision OR
         NEW.policy_revision IS DISTINCT FROM OLD.policy_revision OR
         NEW.account_security_epoch IS DISTINCT FROM OLD.account_security_epoch OR
         NEW.issued_at IS DISTINCT FROM OLD.issued_at OR
         NEW.expires_at IS DISTINCT FROM OLD.expires_at OR
         NEW.secret_digest IS DISTINCT FROM OLD.secret_digest OR
         NEW.capability_digest IS DISTINCT FROM OLD.capability_digest;
      IF OLD.status = 'active' AND NEW.status = 'active' THEN
        IF immutable_field_changed OR OLD.binding_json ? 'transportBudget' OR
           NOT (NEW.binding_json ? 'transportBudget') OR
           (NEW.binding_json - 'transportBudget') IS DISTINCT FROM OLD.binding_json OR
           NEW.termination_reason IS NOT NULL OR NEW.terminated_at IS NOT NULL THEN
          RAISE EXCEPTION 'Sync Session authority is immutable and termination is irreversible';
        END IF;
        RETURN NEW;
      END IF;
      IF OLD.status <> 'active' OR NEW.status <> 'terminated' OR
         immutable_field_changed OR NEW.binding_json IS DISTINCT FROM OLD.binding_json OR
         NEW.termination_reason IS NULL OR NEW.terminated_at IS NULL THEN
        RAISE EXCEPTION 'Sync Session authority is immutable and termination is irreversible';
      END IF;
      RETURN NEW;
    END
  $body$`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION forbid_sync_session_binding_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Sync Session binding and scope facts are immutable'; END $$`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION forbid_sync_session_receipt_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'completed Sync Session replay receipts are immutable'; END $$`.execute(db);
  await sql`DROP INDEX sync_sessions_terminal_cleanup_idx`.execute(db);
}

export const migration: Migration = { up, down };
