import { sql, type Kysely, type Migration } from 'kysely';

/** Expand-only P3-05 authority. N-1 binaries ignore these tables. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE sync_devices (
    device_id text PRIMARY KEY REFERENCES resource_id_ledger(resource_id) ON DELETE RESTRICT,
    account_id text NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    device_name text NOT NULL CHECK (length(device_name) BETWEEN 1 AND 512),
    created_at timestamptz NOT NULL DEFAULT current_timestamp,
    CONSTRAINT sync_devices_protocol_id_check CHECK (
      length(device_id) BETWEEN 1 AND 128 AND device_id ~ '^[A-Za-z0-9._~-]+$'
    ),
    CONSTRAINT sync_devices_account_identity_unique UNIQUE (device_id, account_id)
  )`.execute(db);

  await sql`CREATE TABLE sync_replica_id_ledger (
    replica_id text PRIMARY KEY REFERENCES resource_id_ledger(resource_id) ON DELETE RESTRICT,
    account_id text NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    device_id text NOT NULL,
    collection_id text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
    initial_lease_generation bigint NOT NULL CHECK (initial_lease_generation = 1),
    binding_mode text NOT NULL CHECK (binding_mode IN ('whole-profile','mounted-folder')),
    browser_profile_id text NOT NULL,
    browser_generation text NOT NULL,
    reserved_at timestamptz NOT NULL DEFAULT current_timestamp,
    CONSTRAINT sync_replica_id_protocol_check CHECK (
      length(replica_id) BETWEEN 1 AND 128 AND replica_id ~ '^[A-Za-z0-9._~-]+$'
    ),
    CONSTRAINT sync_replica_browser_profile_check CHECK (
      length(browser_profile_id) BETWEEN 1 AND 128 AND browser_profile_id ~ '^[A-Za-z0-9._~-]+$'
    ),
    CONSTRAINT sync_replica_browser_generation_check CHECK (
      length(browser_generation) BETWEEN 1 AND 128 AND browser_generation ~ '^[A-Za-z0-9._~-]+$'
    ),
    CONSTRAINT sync_replica_lifetime_device_account_fk FOREIGN KEY (device_id, account_id)
      REFERENCES sync_devices(device_id, account_id) ON DELETE RESTRICT,
    CONSTRAINT sync_replica_lifetime_scope_unique UNIQUE (
      replica_id, account_id, collection_id, device_id, binding_mode,
      browser_profile_id, browser_generation
    )
  )`.execute(db);

  await sql`CREATE TABLE sync_replica_generations (
    replica_id text NOT NULL REFERENCES sync_replica_id_ledger(replica_id) ON DELETE RESTRICT,
    lease_generation bigint NOT NULL CHECK (lease_generation > 0),
    lease_id text NOT NULL UNIQUE CHECK (
      length(lease_id) BETWEEN 1 AND 128 AND lease_id ~ '^[A-Za-z0-9._~-]+$'
    ),
    issued_at timestamptz NOT NULL DEFAULT current_timestamp,
    PRIMARY KEY (replica_id, lease_generation),
    CONSTRAINT sync_replica_generation_binding_unique
      UNIQUE (replica_id, lease_generation, lease_id)
  )`.execute(db);

  await sql`CREATE TABLE sync_replicas (
    replica_id text PRIMARY KEY,
    account_id text NOT NULL,
    device_id text NOT NULL,
    collection_id text NOT NULL,
    replica_name text NOT NULL CHECK (length(replica_name) BETWEEN 1 AND 512),
    kind text NOT NULL CHECK (kind IN (
      'browser_extension','desktop_client','mobile_client','server','importer','other'
    )),
    lease_generation bigint NOT NULL CHECK (lease_generation > 0),
    lease_id text NOT NULL,
    binding_mode text NOT NULL CHECK (binding_mode IN ('whole-profile','mounted-folder')),
    browser_profile_id text NOT NULL,
    browser_generation text NOT NULL,
    adapter_profile text NOT NULL CHECK (length(adapter_profile) BETWEEN 1 AND 512),
    adapter_version text NOT NULL CHECK (length(adapter_version) BETWEEN 1 AND 512),
    capabilities_json jsonb NOT NULL CHECK (
      jsonb_typeof(capabilities_json) = 'object' AND
      capabilities_json ?& ARRAY['read','write','events','separator','alias','annotations','maxBatchOperations'] AND
      capabilities_json - ARRAY['read','write','events','separator','alias','annotations','maxBatchOperations'] = '{}'::jsonb AND
      jsonb_typeof(capabilities_json->'read') = 'boolean' AND
      jsonb_typeof(capabilities_json->'write') = 'boolean' AND
      jsonb_typeof(capabilities_json->'events') = 'boolean' AND
      jsonb_typeof(capabilities_json->'separator') = 'boolean' AND
      jsonb_typeof(capabilities_json->'alias') = 'boolean' AND
      capabilities_json->>'annotations' IN ('native','sidecar','none') AND
      jsonb_typeof(capabilities_json->'maxBatchOperations') = 'number' AND
      (capabilities_json->>'maxBatchOperations')::numeric BETWEEN 1 AND 10000 AND
      (capabilities_json->>'maxBatchOperations')::numeric = trunc((capabilities_json->>'maxBatchOperations')::numeric)
    ),
    checkpoint_cursor text,
    checkpoint_commit_ordinal bigint CHECK (
      checkpoint_commit_ordinal IS NULL OR checkpoint_commit_ordinal >= 0
    ),
    status text NOT NULL CHECK (status IN ('active','expired','recovery_required','retired')),
    created_at timestamptz NOT NULL DEFAULT current_timestamp,
    last_seen_at timestamptz NOT NULL DEFAULT current_timestamp,
    lease_expires_at timestamptz NOT NULL,
    retired_at timestamptz,
    wire_json jsonb NOT NULL CHECK (jsonb_typeof(wire_json) = 'object'),
    CONSTRAINT sync_replicas_lifetime_scope_fk FOREIGN KEY (
      replica_id, account_id, collection_id, device_id, binding_mode,
      browser_profile_id, browser_generation
    ) REFERENCES sync_replica_id_ledger(
      replica_id, account_id, collection_id, device_id, binding_mode,
      browser_profile_id, browser_generation
    ) ON DELETE RESTRICT,
    CONSTRAINT sync_replicas_device_account_fk FOREIGN KEY (device_id, account_id)
      REFERENCES sync_devices(device_id, account_id) ON DELETE RESTRICT,
    CONSTRAINT sync_replicas_generation_fk FOREIGN KEY (replica_id, lease_generation, lease_id)
      REFERENCES sync_replica_generations(replica_id, lease_generation, lease_id) ON DELETE RESTRICT,
    CONSTRAINT sync_replicas_binding_lifetime_fk FOREIGN KEY (replica_id)
      REFERENCES sync_replica_id_ledger(replica_id) ON DELETE RESTRICT,
    CONSTRAINT sync_replicas_lease_deadline_check CHECK (lease_expires_at > last_seen_at),
    CONSTRAINT sync_replicas_retired_status_check CHECK (
      (status = 'retired' AND retired_at IS NOT NULL) OR
      (status <> 'retired' AND retired_at IS NULL)
    )
  )`.execute(db);
  await sql`CREATE INDEX sync_replicas_account_device_idx
    ON sync_replicas(account_id,device_id,replica_id)`.execute(db);
  await sql`CREATE INDEX sync_replicas_collection_status_lease_idx
    ON sync_replicas(collection_id,status,lease_expires_at,replica_id)`.execute(db);

  await sql`CREATE FUNCTION forbid_sync_replica_lifetime_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'sync Replica lifetime and generation ledger rows are immutable';
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_replica_id_ledger_immutable
    BEFORE UPDATE OR DELETE ON sync_replica_id_ledger
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_replica_lifetime_mutation()`.execute(db);
  await sql`CREATE TRIGGER sync_replica_generations_immutable
    BEFORE UPDATE OR DELETE ON sync_replica_generations
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_replica_lifetime_mutation()`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS sync_replicas`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_replica_generations`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_replica_id_ledger`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_devices`.execute(db);
  await sql`DROP FUNCTION IF EXISTS forbid_sync_replica_lifetime_mutation()`.execute(db);
}

export const migration: Migration = { up, down };
