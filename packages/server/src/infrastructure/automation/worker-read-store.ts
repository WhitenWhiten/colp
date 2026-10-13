import { sql,type Kysely } from 'kysely';
import type { Job,TaskSpec,FolderRef } from '@know-n/colp/automation';
import { AutomationError,createAutomationPagination,type WorkPrincipal,type AutomationWorkerService } from '../../modules/automation/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { databaseNow } from '../database/time.js';
import { lockWorkJob,requireWorkRunning } from './work-authority.js';
import { currentWorkInputs,expireOwnerLeases } from './worker-inputs.js';
import { reconcileRunPlanEffects } from './reconcile-plan-effect.js';
import { advanceRunTasks } from './task-scheduler.js';
import { resumeDailyBudgetJobs } from './budget-holds.js';
import type { TargetWorkerService } from './target-worker.js';

interface JobRow { id: string; revision: string; run_id: string; task_json: TaskSpec; state: Job['status']; input_digest: string;
  target_id: string | null; allowed_folders: FolderRef[]; delivery_handle: string; active_generation: string; created_at: Date; sort_created_at: string; explanation: string | null }
export const workerJobView = (row: JobRow,worker = true): Job => ({ id: row.id,revision: String(row.revision),runId: row.run_id,task: row.task_json,status: row.state,
  inputDigest: row.input_digest,...(row.explanation ? { explanation: row.explanation } : {}),...(row.target_id ? { targetId: row.target_id } : {}),allowedFolders: row.allowed_folders,inputsPaged: true,
  ...(worker ? { deliveryHandle: row.delivery_handle } : {}),attemptGeneration: Number(row.active_generation),createdAt: row.created_at.toISOString() });

export function createWorkerReadStore(db: Kysely<DatabaseSchema>,serverUuid: string,worker: TargetWorkerService,cursorKey: string): Pick<AutomationWorkerService,'list' | 'get' | 'inputs'> {
  const pages = createAutomationPagination(cursorKey);
  const identity = (a: WorkPrincipal) => JSON.stringify([a.accountId,a.clientId,a.credentialBindingId]);
  const row = async (tx: Kysely<DatabaseSchema>,id: string) => (await sql<JobRow>`SELECT *,revision::text,active_generation::text,
    to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_created_at FROM automation_jobs WHERE id=${id}`.execute(tx)).rows[0]!;
  return {
    list: (actor,query) => db.transaction().execute(async tx => {
      await tx.selectFrom('accounts').select('id').where('id','=',actor.accountId).forUpdate().executeTakeFirstOrThrow();
      const profile = await worker.profile(tx,actor);
      const targets = (await sql<{ id: string }>`SELECT id FROM automation_targets WHERE owner_id=${actor.accountId} AND profile_id=${profile.id} AND paired AND NOT revoked ORDER BY id LIMIT 501`.execute(tx)).rows;
      const targetId = query.targetId ?? (targets.length === 1 ? targets[0]!.id : undefined);
      if (!targetId) throw new AutomationError('invalid_request','Choose one targetId when a profile has multiple targets.');
      await worker.authorize(tx,actor,targetId);await requireWorkRunning(tx,actor.accountId);await expireOwnerLeases(tx,actor.accountId);
      await resumeDailyBudgetJobs(tx,actor,targetId);
      const pending = (await sql<{ run_id: string }>`SELECT DISTINCT j.run_id FROM automation_jobs j JOIN automation_runs r ON r.id=j.run_id
        JOIN collections c ON c.id=r.explanation_json->>'collectionId' AND c.owner_subject_id=${actor.subjectId} AND c.deleted_at IS NULL
        WHERE r.owner_id=${actor.accountId} AND j.target_partition=${targetId} AND NOT r.held AND r.state NOT IN ('cancelled','waiting') AND j.state IN ('pending','committing','awaitingApproval')
          AND (j.state='pending' OR EXISTS (SELECT 1 FROM automation_proposals p JOIN mcp_change_plans m ON m.plan_id=p.plan_id
            WHERE p.job_id=j.id AND m.status='consumed' AND NOT EXISTS (SELECT 1 FROM automation_effect_receipts e WHERE e.job_id=j.id)))
          AND NOT EXISTS (SELECT 1 FROM automation_jobs busy WHERE busy.run_id=r.id AND
            (busy.state IN ('ready','leased','uncertain') OR (busy.state='blocked' AND busy.budget_block_reason='daily') OR (busy.state IN ('committing','awaitingApproval') AND NOT EXISTS (
              SELECT 1 FROM automation_proposals bp JOIN mcp_change_plans bm ON bm.plan_id=bp.plan_id WHERE bp.job_id=busy.id AND bm.status='consumed'))))
        ORDER BY j.run_id LIMIT 100`.execute(tx)).rows;
      for (const run of pending) { await reconcileRunPlanEffects(tx,actor,run.run_id,serverUuid);await advanceRunTasks(tx,actor,serverUuid,run.run_id); }
      const now = await databaseNow(tx),scope = JSON.stringify(['ready',targetId]),{ limit,after } = pages.read(query,identity(actor),scope,now);
      const cursor = after ? sql`AND (j.created_at,j.id)>(${after.createdAt}::timestamptz,${after.id})` : sql``;
      const rows = (await sql<JobRow>`SELECT j.*,j.revision::text,j.active_generation::text,
        to_char(j.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_created_at
        FROM automation_jobs j JOIN automation_runs r ON r.id=j.run_id JOIN collections c ON c.id=r.explanation_json->>'collectionId'
        WHERE j.target_partition=${targetId} AND r.owner_id=${actor.accountId} AND c.owner_subject_id=${actor.subjectId} AND c.deleted_at IS NULL
          AND r.state<>'cancelled' AND NOT r.held AND j.state='ready' ${cursor} ORDER BY j.created_at,j.id LIMIT ${limit+1}`.execute(tx)).rows;
      // Each job rechecks pinned rule privacy; a shared standard target cannot reveal restricted inputs.
      const visible = [];
      for (const job of rows.slice(0,limit)) {
        try { await currentWorkInputs(tx,actor,job.id,serverUuid,worker.authorize);visible.push(workerJobView(job)); }
        catch (error) {
          if (!(error instanceof AutomationError)) throw error;
          if (error.code === 'automation_stale_input' || error.code === 'automation_binding_unavailable') {
            await sql`UPDATE automation_jobs SET state='stale',revision=revision+1,explanation=${error.message} WHERE id=${job.id}`.execute(tx);
            await advanceRunTasks(tx,actor,serverUuid,job.run_id);
          } else if (error.code !== 'resource_not_found') throw error;
        }
      }
      const last = rows[limit-1];
      return { items: visible,nextCursor: rows.length>limit && last ? pages.next(identity(actor),scope,limit,{ createdAt: last.sort_created_at,id: last.id },now) : null };
    }),
    get: (actor,id,handle) => db.transaction().execute(async tx => {
      await tx.selectFrom('accounts').select('id').where('id','=',actor.accountId).forUpdate().executeTakeFirstOrThrow();
      await expireOwnerLeases(tx,actor.accountId);
      const job = await lockWorkJob(tx,actor,id,worker.authorize,true);
      if (job.delivery_handle !== handle) throw new AutomationError('resource_not_found','Job handle is unavailable.');
      return workerJobView(await row(tx,id));
    }),
    inputs: (actor,id,query) => db.transaction().execute(async tx => {
      const { job,pin } = await currentWorkInputs(tx,actor,id,serverUuid,worker.authorize);
      if (query.deliveryHandle !== job.delivery_handle) throw new AutomationError('resource_not_found','Job handle is unavailable.');
      const now = await databaseNow(tx),scope = JSON.stringify(['inputs',id,job.input_digest]),{ limit,after } = pages.read(query,identity(actor),scope,now);
      const start = after ? Number(after.id)+1 : 0,items = pin.input_json.slice(start,start+limit);
      if (!Number.isSafeInteger(start) || start<0 || start>pin.input_json.length) throw new AutomationError('invalid_cursor','Input page cursor is invalid.');
      return { items,nextCursor: start+limit<pin.input_json.length ? pages.next(identity(actor),scope,limit,{ createdAt: now.toISOString(),id: String(start+limit-1) },now) : null };
    }),
  };
}
