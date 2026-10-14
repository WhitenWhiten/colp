import { sql, type Kysely } from 'kysely';
import { automationDigestV1 } from './lib/automation-digest-v1.js';

// Only the shapes this migration reads; never the evolving runtime types.
type RuleDefinition = { trigger: { mode: string; partition?: 'folder' | 'collection' | 'rule' } };
type RoleBindings = Record<string, unknown>;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE automation_aggregation_spaces (
    revision_id text PRIMARY KEY REFERENCES automation_rule_revisions(id),
    space_id text NOT NULL REFERENCES automation_rule_revisions(id),
    epoch_floor bigint NOT NULL DEFAULT 1 CHECK(epoch_floor>0)
  );
  INSERT INTO automation_aggregation_spaces(revision_id,space_id) SELECT id,id FROM automation_rule_revisions;
  CREATE INDEX automation_aggregation_space_revisions ON automation_aggregation_spaces(space_id,revision_id);
  ALTER TABLE automation_aggregate_state ADD COLUMN partition_identity text;
  CREATE INDEX automation_aggregate_identity ON automation_aggregate_state(rule_revision_id,epoch,partition_identity)`.execute(db);

  // Decode legacy partition hashes from the immutable configuration history. Keep
  // the original partition/member identities and any already emitted runs intact.
  let after = '';
  for (;;) {
    const rules = (await sql<{ id: string; rule_id: string; binding_set_id: string; execution_policy_id: string | null; definition_json: RuleDefinition }>`
      SELECT * FROM automation_rule_revisions WHERE id>${after} AND definition_json#>>'{trigger,mode}'='countBatch' ORDER BY id LIMIT 100`.execute(db)).rows;
    for (const rule of rules) {
      const bindings = (await sql<{ revision: string; values_json: RoleBindings }>`SELECT revision::text,values_json
        FROM automation_binding_revisions WHERE binding_set_id=${rule.binding_set_id}`.execute(db)).rows;
      const policies = (await sql<{ revision: string }>`SELECT revision::text FROM automation_execution_policy_revisions
        WHERE policy_id=${rule.execution_policy_id}`.execute(db)).rows.map(p => p.revision);
      const states = (await sql<{ epoch: string; partition_key: string; collection_id: string; parent_id: string | null }>`
        SELECT a.epoch::text,a.partition_key,f.collection_id,f.facts_json#>>'{after,parentId}' AS parent_id
        FROM automation_aggregate_state a JOIN LATERAL (
          SELECT source_event_id FROM automation_batch_members m WHERE m.rule_revision_id=a.rule_revision_id
          AND m.epoch=a.epoch AND m.partition_key=a.partition_key ORDER BY m.created_at LIMIT 1
        ) member ON true JOIN automation_event_facts f ON f.source_event_id=member.source_event_id
        WHERE a.rule_revision_id=${rule.id}`.execute(db)).rows;
      for (const state of states) {
        const trigger = rule.definition_json.trigger;
        if (trigger.mode !== 'countBatch') continue;
        const key = trigger.partition === 'folder' ? state.parent_id ?? '' : trigger.partition === 'collection' ? state.collection_id : rule.rule_id;
        const binding = bindings.find(b => [null, ...policies].some(policy => automationDigestV1({
          kind: trigger.partition, key, binding: b.revision, policy,
        }) === state.partition_key));
        // Fail loudly: guessing would strand or merge members of an unfinished batch.
        if (!binding) throw new Error('Cannot identify legacy count partition configuration');
        const identity = automationDigestV1({ kind: trigger.partition, key, binding: automationDigestV1(binding.values_json) });
        await sql`UPDATE automation_aggregate_state SET partition_identity=${identity} WHERE rule_revision_id=${rule.id}
          AND epoch=${state.epoch}::bigint AND partition_key=${state.partition_key}`.execute(db);
      }
    }
    if (rules.length < 100) break;
    after = rules.at(-1)!.id;
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_aggregate_state DROP COLUMN partition_identity; DROP TABLE automation_aggregation_spaces`.execute(db);
}
