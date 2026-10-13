import { sql, type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE automation_connection_profiles (
    id text PRIMARY KEY,owner_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    revision bigint NOT NULL DEFAULT 1,configuration_json jsonb NOT NULL,observation_json jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(owner_id,id)
  );
  CREATE UNIQUE INDEX automation_profile_binding ON automation_connection_profiles(owner_id,(configuration_json->>'authorizedClientId'),(configuration_json->>'credentialBindingId'));
  CREATE TABLE automation_targets (
    id text PRIMARY KEY,owner_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    profile_id text NOT NULL,revision bigint NOT NULL DEFAULT 1,configuration_json jsonb NOT NULL,
    pairing_generation bigint NOT NULL DEFAULT 0,paired boolean NOT NULL DEFAULT false,revoked boolean NOT NULL DEFAULT false,
    dedicated_binding boolean NOT NULL DEFAULT false,last_seen_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(owner_id,id),FOREIGN KEY(owner_id,profile_id) REFERENCES automation_connection_profiles(owner_id,id)
  );
  CREATE TABLE automation_executors (
    id text PRIMARY KEY,owner_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,target_id text NOT NULL,
    revision bigint NOT NULL DEFAULT 1,configuration_json jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY(owner_id,target_id) REFERENCES automation_targets(owner_id,id)
  );
  CREATE TABLE automation_pairings (
    id text PRIMARY KEY,owner_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,target_id text NOT NULL,
    profile_revision bigint NOT NULL,pairing_generation bigint NOT NULL,code_hash text NOT NULL CHECK(code_hash ~ '^[a-f0-9]{64}$'),
    expires_at timestamptz NOT NULL,consumed_at timestamptz,
    FOREIGN KEY(owner_id,target_id) REFERENCES automation_targets(owner_id,id)
  );
  CREATE INDEX automation_pairing_expiry ON automation_pairings(expires_at);
  CREATE INDEX automation_target_profile ON automation_targets(owner_id,profile_id);
  ALTER TABLE automation_jobs ADD CONSTRAINT automation_job_target FOREIGN KEY(target_id) REFERENCES automation_targets(id);
  `.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_jobs DROP CONSTRAINT automation_job_target; DROP TABLE automation_pairings,automation_executors,automation_targets,automation_connection_profiles`.execute(db);
}
