import { sql, type Kysely } from 'kysely';
/** Expand-only M1 configuration. N-1 binaries ignore these owner-private tables. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE automation_settings (
      owner_id text PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      paused boolean NOT NULL DEFAULT false, paused_at timestamptz, paused_by text,
      revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
      CHECK (paused_by IS NULL OR paused_by IN ('owner','restore','capacity'))
    );
    CREATE TABLE automation_rules (
      id text PRIMARY KEY, owner_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      current_revision_id text, state_revision bigint NOT NULL DEFAULT 1 CHECK (state_revision > 0),
      desired_state text NOT NULL DEFAULT 'draft' CHECK (desired_state IN ('draft','enabled','paused','archived')),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, owner_id)
    );
    CREATE INDEX automation_rules_owner_state ON automation_rules(owner_id, desired_state, created_at, id);
    CREATE TABLE automation_binding_sets (
      id text PRIMARY KEY, owner_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      rule_id text, current_revision bigint NOT NULL DEFAULT 1 CHECK (current_revision > 0), name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, owner_id), FOREIGN KEY (rule_id, owner_id) REFERENCES automation_rules(id, owner_id)
    );
    CREATE INDEX automation_bindings_owner ON automation_binding_sets(owner_id, created_at, id);
    CREATE TABLE automation_binding_revisions (
      binding_set_id text NOT NULL REFERENCES automation_binding_sets(id) ON DELETE CASCADE,
      revision bigint NOT NULL CHECK (revision > 0), values_json jsonb NOT NULL CHECK (jsonb_typeof(values_json) = 'object'),
      semantic_digest text NOT NULL CHECK (semantic_digest ~ '^[a-f0-9]{64}$'),
      created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (binding_set_id, revision)
    );
    ALTER TABLE automation_binding_sets ADD CONSTRAINT automation_binding_current_fk
      FOREIGN KEY (id, current_revision) REFERENCES automation_binding_revisions(binding_set_id, revision)
      DEFERRABLE INITIALLY DEFERRED;
    CREATE TABLE automation_rule_revisions (
      id text PRIMARY KEY, rule_id text NOT NULL, owner_id text NOT NULL, revision bigint NOT NULL CHECK (revision > 0),
      definition_json jsonb NOT NULL CHECK (definition_json->>'apiVersion' = 'colp.automation/v1'),
      binding_set_id text NOT NULL, execution_policy_id text, template_ref text,
      semantic_digest text NOT NULL CHECK (semantic_digest ~ '^[a-f0-9]{64}$'), created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (rule_id, revision), UNIQUE (id, rule_id),
      FOREIGN KEY (rule_id, owner_id) REFERENCES automation_rules(id, owner_id) ON DELETE CASCADE,
      FOREIGN KEY (binding_set_id, owner_id) REFERENCES automation_binding_sets(id, owner_id)
    );
    ALTER TABLE automation_rules ADD CONSTRAINT automation_rule_current_fk
      FOREIGN KEY (current_revision_id, id) REFERENCES automation_rule_revisions(id, rule_id) DEFERRABLE INITIALLY DEFERRED;
    CREATE FUNCTION automation_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'automation revisions are immutable'; END $$;
    CREATE TRIGGER automation_rule_revision_immutable BEFORE UPDATE ON automation_rule_revisions
      FOR EACH ROW EXECUTE FUNCTION automation_revision_immutable();
    CREATE TRIGGER automation_binding_revision_immutable BEFORE UPDATE ON automation_binding_revisions
      FOR EACH ROW EXECUTE FUNCTION automation_revision_immutable();
    CREATE TABLE automation_dependencies (
      rule_revision_id text NOT NULL REFERENCES automation_rule_revisions(id) ON DELETE CASCADE,
      role text NOT NULL, resource_kind text NOT NULL, resource_id text NOT NULL,
      dependency_revision text NOT NULL, stage text NOT NULL, snapshot_json jsonb NOT NULL DEFAULT '{}',
      PRIMARY KEY (rule_revision_id, role, resource_kind, resource_id, stage)
    );
    CREATE INDEX automation_dependency_reverse ON automation_dependencies(resource_kind, resource_id);
    CREATE TABLE automation_incidents (
      id text PRIMARY KEY, owner_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      rule_id text NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE, dependency_key text NOT NULL,
      code text NOT NULL, revision text NOT NULL, severity text NOT NULL CHECK (severity IN ('info','warning','error')),
      state text NOT NULL CHECK (state IN ('open','acknowledged','resolved')),
      incident_json jsonb NOT NULL, first_seen timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (rule_id, owner_id) REFERENCES automation_rules(id, owner_id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX automation_incident_active ON automation_incidents(owner_id, rule_id, dependency_key, code, revision)
      WHERE state <> 'resolved';
    CREATE TABLE automation_preview_records (
      id text PRIMARY KEY, owner_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      config_digest text NOT NULL CHECK (config_digest ~ '^[a-f0-9]{64}$'),
      snapshot_json jsonb NOT NULL, result_json jsonb NOT NULL,
      expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX automation_preview_expiry ON automation_preview_records(expires_at);
    CREATE TABLE automation_activations (
      rule_revision_id text NOT NULL REFERENCES automation_rule_revisions(id) ON DELETE CASCADE,
      collection_id text NOT NULL REFERENCES collections(id), generation bigint NOT NULL CHECK (generation > 0),
      after_ordinal bigint NOT NULL CHECK (after_ordinal >= 0), disabled_after_ordinal bigint,
      aggregate_epoch bigint NOT NULL CHECK (aggregate_epoch > 0),
      PRIMARY KEY (rule_revision_id, collection_id, generation)
    );
  `.execute(db);
}
/** Developer-only down; drain writers and take a backup first. Production is forward-only. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE automation_activations, automation_preview_records, automation_incidents, automation_dependencies;
    ALTER TABLE automation_rules DROP CONSTRAINT automation_rule_current_fk;
    ALTER TABLE automation_binding_sets DROP CONSTRAINT automation_binding_current_fk;
    DROP TABLE automation_rule_revisions, automation_binding_revisions, automation_binding_sets, automation_rules, automation_settings;
    DROP FUNCTION automation_revision_immutable()`.execute(db);
}
