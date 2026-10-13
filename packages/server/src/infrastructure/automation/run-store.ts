import { readRunUsageBatch } from './run-usage-batch.js';
import { readRunEffectsBatch } from './run-effects-batch.js';
import { OUTPUT_SOURCE_AVAILABLE } from './run-output-store.js';
import { sql } from 'kysely';
import type { Run } from '@know-n/colp/automation';
import { explainRun, type RunStore, type StoredRun, type AutomationActor } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
interface RunRow {
  id: string;
  revision: string;
  rule_id: string;
  rule_revision: string;
  binding_revision: string;
  policy_revision: string | null;
  member_ids: string[];
  state: Run['status'];
  created_at: Date;
  updated_at: Date;
  kind: Run['kind'];
  held: boolean;
  explanation_json: Parameters<typeof explainRun>[2] & {
    causationRoot?: string;
    manualSelection?: boolean;
  };
  sort_created_at: string;
}
export function createRunStore(tx: DatabaseTransaction, actor: AutomationActor, eventsEnabled = false): RunStore {
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
      const row = (await sql<RunRow>`${select} AND r.id=${id}`.execute(tx)).rows[0];
      if (!row)
        return null;
      return (await hydrate([row]))[0]!;
    },
    async list(after, limit, bookmark) {
      const cursor = after ? sql`AND (r.created_at,r.id) < (${after.createdAt}::timestamptz,${after.id})` : sql``;
      // A batch run belongs to every member's history, not only its first bookmark.
      const filter = bookmark ? sql`AND c.id=${bookmark.collectionId} AND (r.explanation_json->>'nodeId'=${bookmark.nodeId}
    OR r.explanation_json->'memberSources' @> ${JSON.stringify([{ nodeId: bookmark.nodeId }])}::jsonb)` : sql``;
      const rows = (await sql<RunRow>`${select} ${cursor} ${filter} ORDER BY r.created_at DESC,r.id DESC LIMIT ${limit}`.execute(tx)).rows;
      if (!rows.length)
        return [];
      return hydrate(rows);
    },
    async cancel(id) {
      await sql`UPDATE automation_runs SET state='cancelled', held=false, revision=revision+1, updated_at=clock_timestamp()
   WHERE (id=${id} OR explanation_json->>'parentRunId'=${id}) AND owner_id=${actor.accountId} AND (state IN ('waiting','running','blocked','review') OR explanation_json->>'manualSelection'='true')`.execute(tx);
    },
    async effects(id) {
      return (await readRunEffectsBatch(tx, actor, [id])).get(id) ?? [];
    },
  };
  async function hydrate(rows: RunRow[]): Promise<StoredRun[]> {
    if (!rows.length)
      return [];
    const ids = rows.map(row => row.id), parents = rows.filter(row => row.kind === 'manual' && row.explanation_json.manualSelection).map(row => row.id);
    const children = parents.length ? (await sql<{
      id: string;
      parent_id: string;
      state: Run['status'];
    }>`SELECT id,explanation_json->>'parentRunId' AS parent_id,state
   FROM automation_runs WHERE owner_id=${actor.accountId} AND kind='manual'
   AND explanation_json->>'parentRunId' IN (${sql.join(parents)}) ORDER BY created_at,id`.execute(tx)).rows : [];
    const jobs = (await sql<{
      id: string;
      run_id: string;
      target_id: string | null;
    }>`SELECT id,run_id,target_id FROM automation_jobs
   WHERE run_id IN (${sql.join(ids)}) ORDER BY created_at,id`.execute(tx)).rows;
    const outputs = (await sql<{
      run_id: string;
      n: number;
      unread: boolean;
    }>`SELECT o.run_id,count(*)::int AS n,
   coalesce(bool_or(rd.run_id IS NULL OR (o.created_at,o.id)>(rd.through_created_at,rd.through_output_id)),false) AS unread
   FROM automation_run_outputs o JOIN automation_runs r ON r.id=o.run_id
   LEFT JOIN automation_run_reads rd ON rd.run_id=o.run_id AND rd.owner_id=${actor.accountId}
   WHERE o.run_id IN (${sql.join(ids)}) AND ${OUTPUT_SOURCE_AVAILABLE} GROUP BY o.run_id`.execute(tx)).rows;
    const usage = await readRunUsageBatch(tx, actor, ids, eventsEnabled), effects = await readRunEffectsBatch(tx, actor, ids);
    return rows.map(row => {
      const stored = map(row), members = children.filter(child => child.parent_id === row.id), runJobs = jobs.filter(job => job.run_id === row.id);
      if (members.length) {
        stored.view.childRunIds = members.map(child => child.id);
        stored.view.status = members.some(c => c.state === 'running' || c.state === 'waiting') ? 'running' : members.every(c => c.state === 'completed') ? 'completed'
          : members.every(c => c.state === 'cancelled') ? 'cancelled' : members.some(c => c.state === 'completed') ? 'partial' : 'review';
      }
      stored.view.jobIds = runJobs.map(job => job.id).slice(0, 1600);
      stored.view.recipientTargetIds = [...new Set(runJobs.flatMap(job => job.target_id ? [job.target_id] : []))].slice(0, 100);
      const output = outputs.find(output => output.run_id === row.id);
      stored.view.outputCount = output?.n ?? 0;
      stored.view.unread = output?.unread ?? false;
      stored.view.usage = usage.get(row.id);
      stored.view.effects = effects.get(row.id) ?? [];
      return stored;
    });
  }
}
