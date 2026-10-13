import { reconcileRunPlanEffects } from './reconcile-plan-effect.js';
import { readAutomationUsage } from './usage-read-store.js';
import { planEffectView } from './plan-effect-view.js';
import { placementEffectView, type PlacementEffectRow } from './placement-history-store.js';
import { sql } from 'kysely';
import type { Run } from '@know-n/colp/automation';
import { explainRun, type RunStore, type StoredRun, type AutomationActor } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
interface RunRow {
  id: string; revision: string; rule_id: string; rule_revision: string; binding_revision: string; policy_revision: string | null;
  member_ids: string[]; state: Run['status']; created_at: Date; updated_at: Date; kind: Run['kind'];
  held: boolean; explanation_json: Parameters<typeof explainRun>[2] & { causationRoot?: string }; sort_created_at: string;
}
export function createRunStore(tx: DatabaseTransaction, actor: AutomationActor, serverUuid: string): RunStore {
  const select = sql`SELECT r.*, r.revision::text, v.rule_id, v.revision::text AS rule_revision,
    to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_created_at
    FROM automation_runs r JOIN automation_rule_revisions v ON v.id=r.rule_revision_id
    JOIN collections c ON c.id=r.explanation_json->>'collectionId'
    WHERE r.owner_id=${actor.accountId} AND c.owner_subject_id=${actor.subjectId} AND c.deleted_at IS NULL`;
  const map = (row: RunRow): StoredRun => ({ sortCreatedAt: row.sort_created_at, view: {
    id: row.id, revision: String(row.revision), ruleId: row.rule_id, ruleRevision: String(row.rule_revision),
    bindingRevision: String(row.binding_revision), executionPolicyRevision: row.policy_revision, status: row.state,
    held: row.held, explanation: explainRun(row.state, row.held, row.explanation_json),
    memberEventIds: row.member_ids, recipientTargetIds: [], createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    jobIds: [], causationRoot: row.explanation_json.causationRoot ?? row.id, kind: row.kind, effects: [], unread: false, outputCount: 0,
  } });
  return {
    async load(id) {
      await reconcileRunPlanEffects(tx,actor,id,serverUuid);
      const row = (await sql<RunRow>`${select} AND r.id=${id}`.execute(tx)).rows[0];
      if (!row) return null;
      const stored = map(row);
      const children=(await sql<{id:string;state:Run['status']}>`SELECT id,state FROM automation_runs
        WHERE owner_id=${actor.accountId} AND explanation_json->>'parentRunId'=${id} ORDER BY created_at,id LIMIT 1001`.execute(tx)).rows;
      if(children.length){
        stored.view.childRunIds=children.map(child=>child.id);
        stored.view.status=children.some(c=>c.state==='running'||c.state==='waiting')?'running':children.every(c=>c.state==='completed')?'completed'
          :children.every(c=>c.state==='cancelled')?'cancelled':children.some(c=>c.state==='completed')?'partial':'review';
      }
      const jobs = (await sql<{ id: string; target_id: string | null }>`SELECT id,target_id FROM automation_jobs
        WHERE run_id=${id} ORDER BY created_at,id LIMIT 1600`.execute(tx)).rows;
      stored.view.jobIds = jobs.map(job => job.id);
      stored.view.recipientTargetIds = [...new Set(jobs.flatMap(job => job.target_id ? [job.target_id] : []))].slice(0,100);
      const outputs=(await sql<{n:number;unread:boolean}>`SELECT count(*)::int AS n,coalesce(bool_or(rd.run_id IS NULL OR (o.created_at,o.id)>(rd.through_created_at,rd.through_output_id)),false) AS unread
        FROM automation_run_outputs o LEFT JOIN automation_run_reads rd ON rd.run_id=o.run_id AND rd.owner_id=${actor.accountId} WHERE o.run_id=${id}`.execute(tx)).rows[0]!;
      stored.view.outputCount=outputs.n;stored.view.unread=outputs.unread;
      stored.view.usage = await readAutomationUsage(tx,actor,row.rule_id,id);
      return stored;
    },
    async list(after, limit, bookmark) {
      const cursor = after ? sql`AND (r.created_at,r.id) < (${after.createdAt}::timestamptz,${after.id})` : sql``;
      const filter = bookmark ? sql`AND c.id=${bookmark.collectionId} AND r.explanation_json->>'nodeId'=${bookmark.nodeId}` : sql``;
      return (await sql<RunRow>`${select} ${cursor} ${filter} ORDER BY r.created_at DESC,r.id DESC LIMIT ${limit}`.execute(tx)).rows.map(map);
    },
    async cancel(id) { await sql`UPDATE automation_runs SET state='cancelled', held=false, revision=revision+1, updated_at=clock_timestamp()
      WHERE (id=${id} OR explanation_json->>'parentRunId'=${id}) AND owner_id=${actor.accountId} AND (state IN ('waiting','running','blocked','review') OR explanation_json->>'manualSelection'='true')`.execute(tx); },
    async effects(id) {
      const rows = (await sql<PlacementEffectRow>`SELECT e.* FROM automation_effect_receipts e
        JOIN automation_runs r ON r.id=e.run_id WHERE r.id=${id} AND r.owner_id=${actor.accountId}
        ORDER BY e.created_at DESC,e.id DESC LIMIT 100`.execute(tx)).rows;
      return Promise.all(rows.map(row => row.plan_id ? planEffectView(tx,actor,row) : placementEffectView(tx, actor, row)));
    },
  };
}
