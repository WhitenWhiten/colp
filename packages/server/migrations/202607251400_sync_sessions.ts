import { sql, type Kysely, type Migration } from 'kysely';

/** P3-07 expand: durable credential evidence, Session authority, bindings, scopes, and replay receipts. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE accounts
    ADD CONSTRAINT accounts_sync_principal_unique UNIQUE (id, subject_id)`.execute(db);
  await sql`ALTER TABLE account_identities
    ADD CONSTRAINT account_identities_issuer_subject_account_unique
      UNIQUE (issuer, subject, account_id)`.execute(db);
  await sql`ALTER TABLE sync_replicas
    ADD CONSTRAINT sync_replicas_account_collection_identity_unique
      UNIQUE (replica_id, account_id, collection_id)`.execute(db);
  await sql`ALTER TABLE sync_replica_id_ledger
    ADD CONSTRAINT sync_replica_id_ledger_session_binding_unique
      UNIQUE (replica_id, account_id, collection_id, binding_mode,
        browser_profile_id, browser_generation)`.execute(db);

  await sql`CREATE TABLE sync_extension_credentials (
    issuer text NOT NULL,
    credential_id text NOT NULL,
    credential_digest text NOT NULL,
    subject text NOT NULL,
    account_id text NOT NULL,
    client_id text NOT NULL,
    audience text NOT NULL,
    scopes_json jsonb NOT NULL CHECK (
      jsonb_typeof(scopes_json) = 'array' AND scopes_json ? 'known.sync'
    ),
    credential_issued_at timestamptz NOT NULL,
    credential_expires_at timestamptz NOT NULL,
    evidence_expires_at timestamptz NOT NULL,
    security_epoch bigint NOT NULL CHECK (security_epoch >= 0),
    revoked_at timestamptz,
    first_seen_at timestamptz NOT NULL DEFAULT current_timestamp,
    last_verified_at timestamptz NOT NULL,
    PRIMARY KEY (issuer, credential_id),
    CONSTRAINT sync_extension_credentials_account_identity_unique
      UNIQUE (issuer, credential_id, account_id),
    CONSTRAINT sync_extension_credentials_identity_fk
      FOREIGN KEY (issuer, subject, account_id)
      REFERENCES account_identities(issuer, subject, account_id) ON DELETE RESTRICT,
    CONSTRAINT sync_extension_credentials_digest_unique UNIQUE (issuer, credential_digest),
    CONSTRAINT sync_extension_credentials_time_check CHECK (
      credential_issued_at < credential_expires_at AND
      evidence_expires_at <= credential_expires_at AND
      last_verified_at <= evidence_expires_at
    ),
    CONSTRAINT sync_extension_credentials_id_check CHECK (
      length(credential_id) BETWEEN 1 AND 512 AND length(credential_digest) BETWEEN 16 AND 512
    )
  )`.execute(db);

  await sql`CREATE TABLE sync_sessions (
    session_id text PRIMARY KEY REFERENCES resource_id_ledger(resource_id) ON DELETE RESTRICT,
    account_id text NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    principal_subject_id text NOT NULL,
    credential_issuer text NOT NULL,
    credential_id text NOT NULL,
    oauth_client_id text NOT NULL,
    origin text,
    session_scope text NOT NULL CHECK (session_scope = 'collection'),
    protocol_version text NOT NULL CHECK (protocol_version = '0.1'),
    collection_id text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
    replica_id text NOT NULL,
    lease_generation bigint NOT NULL CHECK (lease_generation > 0),
    lease_id text NOT NULL,
    lifecycle_revision bigint NOT NULL CHECK (lifecycle_revision >= 0),
    policy_revision text NOT NULL,
    account_security_epoch bigint NOT NULL CHECK (account_security_epoch >= 0),
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    status text NOT NULL CHECK (status IN ('active','terminated')),
    termination_reason text CHECK (termination_reason IN (
      'credential_revoked','scope_reduced','bootstrap_rejected','administrative','lease_expired'
    )),
    terminated_at timestamptz,
    secret_digest text NOT NULL,
    capability_digest text NOT NULL,
    binding_json jsonb NOT NULL CHECK (jsonb_typeof(binding_json) = 'object'),
    CONSTRAINT sync_sessions_credential_fk FOREIGN KEY (credential_issuer, credential_id, account_id)
      REFERENCES sync_extension_credentials(issuer, credential_id, account_id) ON DELETE RESTRICT,
    CONSTRAINT sync_sessions_account_principal_fk FOREIGN KEY (account_id, principal_subject_id)
      REFERENCES accounts(id, subject_id) ON DELETE RESTRICT,
    CONSTRAINT sync_sessions_replica_scope_fk FOREIGN KEY (replica_id, account_id, collection_id)
      REFERENCES sync_replicas(replica_id, account_id, collection_id) ON DELETE RESTRICT,
    CONSTRAINT sync_sessions_replica_generation_fk
      FOREIGN KEY (replica_id, lease_generation, lease_id)
      REFERENCES sync_replica_generations(replica_id, lease_generation, lease_id) ON DELETE RESTRICT,
    CONSTRAINT sync_sessions_expiry_check CHECK (expires_at > issued_at),
    CONSTRAINT sync_sessions_protocol_id_check CHECK (
      length(session_id) BETWEEN 1 AND 128 AND session_id ~ '^[A-Za-z0-9._~-]+$'
    ),
    CONSTRAINT sync_sessions_termination_check CHECK (
      (status = 'active' AND termination_reason IS NULL AND terminated_at IS NULL) OR
      (status = 'terminated' AND termination_reason IS NOT NULL AND terminated_at IS NOT NULL)
    ),
    CONSTRAINT sync_sessions_secret_digest_check CHECK (
      length(secret_digest) BETWEEN 16 AND 512 AND length(capability_digest) BETWEEN 16 AND 512
    ),
    CONSTRAINT sync_sessions_binding_dual_read_check CHECK (
      binding_json->>'accountId' = account_id AND
      binding_json->>'principalSubjectId' = principal_subject_id AND
      binding_json->>'credentialIssuer' = credential_issuer AND
      binding_json->>'credentialId' = credential_id AND
      binding_json->>'oauthClientId' = oauth_client_id AND
      binding_json->>'collectionId' = collection_id AND
      binding_json->>'replicaId' = replica_id AND
      binding_json->>'leaseGeneration' = lease_generation::text AND
      binding_json->>'leaseId' = lease_id AND
      binding_json->>'lifecycleRevision' = lifecycle_revision::text AND
      binding_json->>'policyRevision' = policy_revision AND
      binding_json->>'accountSecurityEpoch' = account_security_epoch::text AND
      binding_json->>'sessionScope' = session_scope AND
      binding_json->>'protocolVersion' = protocol_version
    ),
    CONSTRAINT sync_sessions_scope_identity_unique
      UNIQUE (session_id, account_id, collection_id, replica_id),
    CONSTRAINT sync_sessions_complete_binding_unique UNIQUE (
      session_id, account_id, collection_id, replica_id, lease_generation, lease_id,
      lifecycle_revision, policy_revision
    )
  )`.execute(db);
  await sql`CREATE INDEX sync_sessions_replica_active_idx
    ON sync_sessions(replica_id, expires_at, session_id) WHERE status = 'active'`.execute(db);
  await sql`CREATE INDEX sync_sessions_credential_active_idx
    ON sync_sessions(credential_issuer, credential_id, expires_at) WHERE status = 'active'`.execute(db);

  await sql`CREATE FUNCTION enforce_sync_extension_credential_authority() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' OR
         NEW.issuer IS DISTINCT FROM OLD.issuer OR
         NEW.credential_id IS DISTINCT FROM OLD.credential_id OR
         NEW.credential_digest IS DISTINCT FROM OLD.credential_digest OR
         NEW.subject IS DISTINCT FROM OLD.subject OR
         NEW.account_id IS DISTINCT FROM OLD.account_id OR
         NEW.client_id IS DISTINCT FROM OLD.client_id OR
         NEW.audience IS DISTINCT FROM OLD.audience OR
         NEW.scopes_json IS DISTINCT FROM OLD.scopes_json OR
         NEW.credential_issued_at IS DISTINCT FROM OLD.credential_issued_at OR
         NEW.credential_expires_at IS DISTINCT FROM OLD.credential_expires_at OR
         NEW.security_epoch IS DISTINCT FROM OLD.security_epoch OR
         NEW.first_seen_at IS DISTINCT FROM OLD.first_seen_at OR
         (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
        RAISE EXCEPTION 'Sync extension credential authority and revocation are immutable';
      END IF;
      RETURN NEW;
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_extension_credentials_terminal_revocation
    BEFORE UPDATE OR DELETE ON sync_extension_credentials
    FOR EACH ROW EXECUTE FUNCTION enforce_sync_extension_credential_authority()`.execute(db);

  await sql`CREATE TABLE sync_session_scopes (
    session_id text NOT NULL REFERENCES sync_sessions(session_id) ON DELETE RESTRICT,
    scope text NOT NULL CHECK (scope IN ('sync:bootstrap','sync:pull','sync:push')),
    PRIMARY KEY (session_id, scope)
  )`.execute(db);

  await sql`CREATE TABLE sync_session_bindings (
    session_id text PRIMARY KEY,
    account_id text NOT NULL,
    collection_id text NOT NULL,
    replica_id text NOT NULL,
    lease_generation bigint NOT NULL CHECK (lease_generation > 0),
    lease_id text NOT NULL,
    lifecycle_revision bigint NOT NULL CHECK (lifecycle_revision >= 0),
    policy_revision text NOT NULL,
    binding_mode text NOT NULL CHECK (binding_mode IN ('whole-profile','mounted-folder')),
    browser_profile_id text NOT NULL,
    browser_generation text NOT NULL,
    created_at timestamptz NOT NULL,
    CONSTRAINT sync_session_bindings_session_fk FOREIGN KEY (
      session_id, account_id, collection_id, replica_id, lease_generation, lease_id,
      lifecycle_revision, policy_revision
    ) REFERENCES sync_sessions(
      session_id, account_id, collection_id, replica_id, lease_generation, lease_id,
      lifecycle_revision, policy_revision
    ) ON DELETE RESTRICT,
    CONSTRAINT sync_session_bindings_replica_generation_fk
      FOREIGN KEY (replica_id, lease_generation, lease_id)
      REFERENCES sync_replica_generations(replica_id, lease_generation, lease_id) ON DELETE RESTRICT,
    CONSTRAINT sync_session_bindings_replica_lifetime_fk FOREIGN KEY (
      replica_id, account_id, collection_id, binding_mode, browser_profile_id, browser_generation
    ) REFERENCES sync_replica_id_ledger(
      replica_id, account_id, collection_id, binding_mode, browser_profile_id, browser_generation
    ) ON DELETE RESTRICT
  )`.execute(db);

  await sql`CREATE TABLE sync_session_idempotency_receipts (
    principal_id text NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    session_scope text NOT NULL CHECK (session_scope = 'collection'),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 512),
    request_fingerprint text NOT NULL,
    collection_id text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
    replica_id text NOT NULL REFERENCES sync_replicas(replica_id) ON DELETE RESTRICT,
    session_id text NOT NULL REFERENCES sync_sessions(session_id) ON DELETE RESTRICT,
    result_ciphertext bytea NOT NULL,
    result_iv bytea NOT NULL,
    result_auth_tag bytea NOT NULL,
    result_key_version integer NOT NULL CHECK (result_key_version > 0),
    result_digest text NOT NULL,
    claimed_at timestamptz NOT NULL,
    completed_at timestamptz NOT NULL,
    PRIMARY KEY (principal_id, session_scope, idempotency_key),
    CONSTRAINT sync_session_receipts_cipher_shape CHECK (
      octet_length(result_ciphertext) > 0 AND octet_length(result_iv) = 12 AND
      octet_length(result_auth_tag) = 16 AND length(result_digest) BETWEEN 16 AND 512
    ),
    CONSTRAINT sync_session_receipts_session_scope_fk
      FOREIGN KEY (session_id, principal_id, collection_id, replica_id)
      REFERENCES sync_sessions(session_id, account_id, collection_id, replica_id) ON DELETE RESTRICT
  )`.execute(db);

  await sql`CREATE FUNCTION forbid_sync_session_authority_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Sync Sessions cannot be deleted';
      END IF;
      IF OLD.status <> 'active' OR NEW.status <> 'terminated' OR
         NEW.session_id IS DISTINCT FROM OLD.session_id OR
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
         NEW.capability_digest IS DISTINCT FROM OLD.capability_digest OR
         NEW.binding_json IS DISTINCT FROM OLD.binding_json OR
         NEW.termination_reason IS NULL OR NEW.terminated_at IS NULL THEN
        RAISE EXCEPTION 'Sync Session authority is immutable and termination is irreversible';
      END IF;
      RETURN NEW;
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_sessions_terminal_immutable
    BEFORE UPDATE OR DELETE ON sync_sessions
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_session_authority_mutation()`.execute(db);

  await sql`CREATE FUNCTION forbid_sync_session_binding_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'Sync Session binding and scope facts are immutable';
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_session_bindings_immutable
    BEFORE UPDATE OR DELETE ON sync_session_bindings
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_session_binding_mutation()`.execute(db);
  await sql`CREATE TRIGGER sync_session_scopes_immutable
    BEFORE UPDATE OR DELETE ON sync_session_scopes
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_session_binding_mutation()`.execute(db);
  await sql`CREATE FUNCTION forbid_sync_session_receipt_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'completed Sync Session replay receipts are immutable';
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_session_receipts_immutable
    BEFORE UPDATE OR DELETE ON sync_session_idempotency_receipts
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_session_receipt_mutation()`.execute(db);
}

/** down is a developer-only destructive rollback, never an online production rollback strategy. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS sync_sessions_terminal_immutable ON sync_sessions`.execute(db);
  await sql`DROP FUNCTION IF EXISTS forbid_sync_session_authority_mutation()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS sync_extension_credentials_terminal_revocation
    ON sync_extension_credentials`.execute(db);
  await sql`DROP FUNCTION IF EXISTS enforce_sync_extension_credential_authority()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS sync_session_receipts_immutable
    ON sync_session_idempotency_receipts`.execute(db);
  await sql`DROP FUNCTION IF EXISTS forbid_sync_session_receipt_mutation()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS sync_session_scopes_immutable ON sync_session_scopes`.execute(db);
  await sql`DROP TRIGGER IF EXISTS sync_session_bindings_immutable ON sync_session_bindings`.execute(db);
  await sql`DROP FUNCTION IF EXISTS forbid_sync_session_binding_mutation()`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_session_idempotency_receipts`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_session_bindings`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_session_scopes`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_sessions`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_extension_credentials`.execute(db);
  await sql`ALTER TABLE sync_replicas
    DROP CONSTRAINT IF EXISTS sync_replicas_account_collection_identity_unique`.execute(db);
  await sql`ALTER TABLE sync_replica_id_ledger
    DROP CONSTRAINT IF EXISTS sync_replica_id_ledger_session_binding_unique`.execute(db);
  await sql`ALTER TABLE account_identities
    DROP CONSTRAINT IF EXISTS account_identities_issuer_subject_account_unique`.execute(db);
  await sql`ALTER TABLE accounts
    DROP CONSTRAINT IF EXISTS accounts_sync_principal_unique`.execute(db);
}

export const migration: Migration = { up, down };
