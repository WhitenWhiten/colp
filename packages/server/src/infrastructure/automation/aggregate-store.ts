import { initializeRunTasks } from './task-scheduler.js';
import { createReceiptReconciler } from './reconcile-receipts.js';
import { reserveIntakeAdmission } from './intake-capacity.js';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { compilePredicate, type RoleBindings, type RuleDefinition } from '@know-n/colp/automation';
import { admitEvent, intakeAdmissionState, resolveBindings, assessIntakeBindings, type AdmissionCandidate } from '../../modules/automation/index.js';
import { createBindingReadPort } from './bindings.js';
import { sourceEvent } from './source-facts.js';
import type { InspectAutomationSource } from './source-position-store.js';

interface ActiveRule {
  id: string; revision_id: string; definition_json: RuleDefinition; binding_set_id: string;
  binding_revision: string; execution_policy_id: string | null; policy_revision: string | null; values_json: RoleBindings; after_ordinal: string; aggregate_epoch: string;
}
/** Receipts, sequence, pinned run and source cursor share the inspector transaction. */
export function createAutomationAdmission(serverUuid: string,workerEnabled = false): InspectAutomationSource {
  const reconcile = createReceiptReconciler(serverUuid);
  return async (tx, owner, collectionId, sources) => {
    const moreReceipts = await reconcile(tx, owner, collectionId, sources) === true;
    const settings = await tx.selectFrom('automation_settings').select('paused').where('owner_id', '=', owner.accountId).executeTakeFirst();
    if (settings?.paused) return moreReceipts;
    const reads = createBindingReadPort(tx, serverUuid);
    const collection = await reads.readCollection(owner, collectionId);
    if (!collection) return moreReceipts;
    const rows = (await sql<ActiveRule>`SELECT r.id, v.id AS revision_id, v.definition_json, v.binding_set_id,v.execution_policy_id,
      ${workerEnabled ? sql`(SELECT current_revision::text FROM automation_execution_policies p WHERE p.id=v.execution_policy_id AND p.owner_id=r.owner_id)` : sql`NULL`} AS policy_revision,
      b.current_revision::text AS binding_revision, br.values_json, a.after_ordinal::text, a.aggregate_epoch::text
      FROM automation_rules r JOIN automation_rule_revisions v ON v.id=r.current_revision_id
      JOIN automation_binding_sets b ON b.id=v.binding_set_id AND b.owner_id=r.owner_id
      JOIN automation_binding_revisions br ON br.binding_set_id=b.id AND br.revision=b.current_revision
      JOIN automation_activations a ON a.rule_revision_id=v.id AND a.collection_id=${collectionId}
      WHERE r.owner_id=${owner.accountId} AND r.desired_state='enabled' AND a.disabled_after_ordinal IS NULL
      ORDER BY r.id LIMIT 501`.execute(tx)).rows;
    if (rows.length > 500) throw new Error('Automation active rule bound exceeded');
    const prepared: AdmissionCandidate[] = [];
    for (const row of rows) {
      const predicate = compilePredicate(row.definition_json.match);
      if (!predicate.valid) continue;
      const resolutions = await resolveBindings(reads, owner, row.definition_json, row.values_json);
      prepared.push({ ruleId: row.id, revisionId: row.revision_id, afterOrdinal: row.after_ordinal, epoch: row.aggregate_epoch,
        definition: row.definition_json, resolutions, bindings: assessIntakeBindings(row.definition_json, resolutions), predicate });
    }
    const pins = new Map(rows.map(row => [row.revision_id, row]));
    for (const source of sources) {
      const event = sourceEvent(source, serverUuid, collectionId, collection.rootNodeId);
      if (!event) continue;
      for (const decision of admitEvent(prepared, event,workerEnabled)) {
        const { candidate, plan } = decision;
        const inserted = await sql`INSERT INTO automation_admission_receipts (rule_revision_id, source_event_id, stage, decision, run_id)
          VALUES (${candidate.revisionId}, ${event.eventId}, 'intake', ${plan.kind}, NULL)
          ON CONFLICT DO NOTHING RETURNING rule_revision_id`.execute(tx);
        if (!inserted.rows.length || !decision.createRun) continue;
        const pin = pins.get(candidate.revisionId)!;
        const sequence = (await sql<{ sequence: string }>`INSERT INTO automation_aggregate_state
          (rule_revision_id, epoch, partition_key, sequence, remainder_json)
          VALUES (${candidate.revisionId}, ${candidate.epoch}::bigint, ${collectionId}, 1, '[]'::jsonb)
          ON CONFLICT (rule_revision_id, epoch, partition_key) DO UPDATE SET sequence=automation_aggregate_state.sequence+1
          RETURNING sequence::text`.execute(tx)).rows[0]!.sequence;
        const runId = randomUUID();
        const admission = intakeAdmissionState(plan, candidate.definition.policy, workerEnabled && candidate.definition.tasks.length > 0);
        await sql`INSERT INTO automation_runs
          (id, owner_id, kind, rule_revision_id, binding_set_id, binding_revision, policy_revision, member_ids, state, explanation_json)
          VALUES (${runId}, ${owner.accountId}, 'intake', ${candidate.revisionId}, ${pin.binding_set_id}, ${pin.binding_revision}::bigint,
            ${pin.definition_json.tasks.length ? pin.policy_revision : null}, ${JSON.stringify([event.eventId])}::jsonb, ${admission.state},
            ${JSON.stringify({ plan, epoch: candidate.epoch, sequence, operationId: event.operationId, nodeId: event.nodeId,
              collectionId, sourceRevision: source.facts_json!.after!.resourceRevision, causationRoot: event.rootRunId ?? runId,
              ...(admission.explanation ? { explanation: admission.explanation } : {}) })}::jsonb)`.execute(tx);
        if (admission.runnable) await reserveIntakeAdmission(tx, { runId, ownerId: owner.accountId, ruleId: candidate.ruleId,
          collectionId, maxRunsPerDay: candidate.definition.policy.maxRunsPerDay });
        if (workerEnabled && pin.definition_json.tasks.length && admission.runnable) await initializeRunTasks(tx,owner,runId);
        await sql`UPDATE automation_admission_receipts SET run_id=${runId}
          WHERE rule_revision_id=${candidate.revisionId} AND source_event_id=${event.eventId} AND stage='intake'`.execute(tx);
      }
    }
    return moreReceipts;
  };
}
