import { aggregationSemanticDigest } from './aggregation-semantics.js';
import { touchAutomationConfiguration } from './configuration-epoch.js';
import { sql, type Kysely } from 'kysely';
import { ruleSemanticDigest, type Rule } from '@know-n/colp/automation';
import type { DatabaseSchema } from '../database/runtime.js';
import type { RuleStore, StoredRule } from '../../modules/automation/index.js';
export function createRuleStore(db: Kysely<DatabaseSchema>, runtimeEnabled = false): RuleStore {
  const select = () => db.selectFrom('automation_rules as r').innerJoin('automation_rule_revisions as v', 'v.id', 'r.current_revision_id')
    .select(['r.id', 'r.owner_id', 'r.state_revision', 'r.desired_state', 'r.created_at', 'r.updated_at', 'v.id as revision_id',
      sql<string>`to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')`.as('sort_created_at'), 'v.revision', 'v.definition_json', 'v.binding_set_id', 'v.execution_policy_id', 'v.template_ref']);
  const map = (row: Awaited<ReturnType<ReturnType<typeof select>['executeTakeFirstOrThrow']>>): StoredRule => ({
    sortCreatedAt: row.sort_created_at, definitionRevisionId: row.revision_id, definitionRevision: String(row.revision),
    view: { id: row.id, revision: String(row.state_revision), desiredState: row.desired_state,
      effectiveState: row.desired_state === 'enabled' ? (runtimeEnabled ? 'active' : 'blocked') : row.desired_state,
      definition: row.definition_json, bindingSetId: row.binding_set_id,
      ...(row.execution_policy_id ? { executionPolicyId: row.execution_policy_id } : {}), ...(row.template_ref ? { templateRef: row.template_ref } : {}),
      createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() },
  });
  const store: RuleStore = {
    async load(ownerId, id) { const row = await select().where('r.owner_id', '=', ownerId).where('r.id', '=', id).executeTakeFirst(); return row ? map(row) : null; },
    async list(ownerId, after, limit) {
      let query = select().where('r.owner_id', '=', ownerId);
      if (after) query = query.where(sql<boolean>`(r.created_at,r.id) > (${after.createdAt}::timestamptz,${after.id})`);
      return (await query.orderBy('r.created_at').orderBy('r.id').limit(limit).execute()).map(map);
    },
    async count(ownerId) {
      return Number((await db.selectFrom('automation_rules').select(eb => eb.fn.countAll<string>().as('n'))
        .where('owner_id', '=', ownerId).where('desired_state', '!=', 'archived').executeTakeFirstOrThrow()).n);
    },
    async save(ownerId, rule) {
      const { view } = rule;
      if (view.revision === '1') await db.insertInto('automation_rules').values({ id: view.id, owner_id: ownerId, current_revision_id: null,
        desired_state: view.desiredState, created_at: new Date(view.createdAt), updated_at: new Date(view.updatedAt) }).execute();
      const previous = await store.load(ownerId, view.id);
      const sameAggregation = previous && previous.view.bindingSetId === view.bindingSetId
        && aggregationSemanticDigest(previous.view.definition) === aggregationSemanticDigest(view.definition);
      const priorSpace = sameAggregation ? (await sql<{space_id:string;epoch_floor:string}>`SELECT space_id,epoch_floor::text FROM automation_aggregation_spaces
        WHERE revision_id=${previous.definitionRevisionId}`.execute(db)).rows[0] : undefined;
      const space = priorSpace?.space_id ?? (sameAggregation ? previous.definitionRevisionId : rule.definitionRevisionId);
      await db.insertInto('automation_rule_revisions').values({ id: rule.definitionRevisionId, rule_id: view.id, owner_id: ownerId,
        revision: rule.definitionRevision, definition_json: view.definition, binding_set_id: view.bindingSetId,
        execution_policy_id: view.executionPolicyId ?? null, template_ref: view.templateRef ?? null, semantic_digest: ruleSemanticDigest(view.definition) }).execute();
      await sql`INSERT INTO automation_aggregation_spaces(revision_id,space_id,epoch_floor) VALUES(${rule.definitionRevisionId},${space},${priorSpace?.epoch_floor ?? '1'}::bigint)`.execute(db);
      await db.updateTable('automation_rules').set({ current_revision_id: rule.definitionRevisionId, state_revision: view.revision,
        desired_state: view.desiredState, updated_at: new Date(view.updatedAt) }).where('id', '=', view.id).where('owner_id', '=', ownerId).execute();
      await touchAutomationConfiguration(db, ownerId);
    },
    async setState(ownerId, rule) {
      const { view } = rule;
      await db.updateTable('automation_rules').set({ state_revision: view.revision, desired_state: view.desiredState, updated_at: new Date(view.updatedAt) })
        .where('id', '=', view.id).where('owner_id', '=', ownerId).execute();
      await touchAutomationConfiguration(db, ownerId);
    },
  };
  return store;
}
