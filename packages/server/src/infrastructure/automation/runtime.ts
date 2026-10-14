import { resumeCollectionBudgets } from './budget-wakes.js';
import { sql } from 'kysely';
import { advanceRunTasks } from './task-scheduler.js';
import { createAutomationAdmission } from './aggregate-store.js';
import { executePendingIntake } from './intake-executor.js';
import type { InspectAutomationSource } from './source-position-store.js';
/** M1 has no M2 worker-policy, budget, target or event-subscription dependencies. */
export function createAutomationRuntime(serverUuid: string,workerEnabled = false): InspectAutomationSource {
  const admit = createAutomationAdmission(serverUuid,workerEnabled);
  return async (tx, actor, collectionId, sources) => {
    const moreReceipts = await admit(tx, actor, collectionId, sources);
    const more = await executePendingIntake(tx, actor, collectionId, serverUuid);
    let moreBudgets = false;
    if (workerEnabled) {
      moreBudgets = await resumeCollectionBudgets(tx,actor,collectionId);
      const runs = (await sql<{ id: string }>`SELECT r.id FROM automation_runs r JOIN automation_rule_revisions v ON v.id=r.rule_revision_id
        WHERE r.owner_id=${actor.accountId} AND r.explanation_json->>'collectionId'=${collectionId}
          AND r.state IN ('completed','running','review') AND jsonb_array_length(v.definition_json->'tasks')>0
          AND EXISTS(SELECT 1 FROM automation_jobs j WHERE j.run_id=r.id AND (j.state='pending' OR (r.state='completed' AND j.state<>'succeeded'))) ORDER BY r.created_at,r.id LIMIT 100`.execute(tx)).rows;
      for (const run of runs) await advanceRunTasks(tx,actor,serverUuid,run.id);
    }
    return moreReceipts === true || more || moreBudgets;
  };
}
