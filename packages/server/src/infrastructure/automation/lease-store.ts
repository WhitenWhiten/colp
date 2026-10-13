import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Lease, LeaseProof } from '@know-n/colp/automation';
import { AutomationError, type WorkPrincipal, type JobLeaseStore } from '../../modules/automation/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { lockWorkJob, type TargetAuthority, type WorkJob } from './work-authority.js';
import { recordOptionalCall, reserveOptionalWork } from './usage-store.js';

export const claimTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const workBinding = (actor: WorkPrincipal) => JSON.stringify([actor.accountId,actor.clientId,actor.credentialBindingId]);
interface Attempt { claim_token_hash: string; generation: string; lease_until: Date; principal_binding: string; outcome: string }
export async function requireJobLease(tx: DatabaseTransaction, actor: WorkPrincipal, job: WorkJob, proof: LeaseProof): Promise<Attempt> {
  const attempt = (await sql<Attempt>`SELECT *,generation::text FROM automation_job_attempts WHERE job_id=${job.id}
    AND generation=${proof.generation}::bigint AND lease_until>clock_timestamp() FOR UPDATE`.execute(tx)).rows[0];
  const supplied = Buffer.from(claimTokenHash(proof.claimToken)), expected = Buffer.from(attempt?.claim_token_hash ?? '');
  if (!attempt || expected.length !== supplied.length || !timingSafeEqual(expected,supplied)
    || attempt.principal_binding !== workBinding(actor) || String(job.active_generation) !== String(proof.generation)
    || attempt.outcome !== 'leased' || job.state !== 'leased')
    throw new AutomationError('automation_lease_lost','Claim generation or lease is no longer current.');
  return attempt;
}
/** Each public method owns a short transaction; no network or plan coordinator is invoked here. */
export function createJobLeaseStore(db: Kysely<DatabaseSchema>, authorize: TargetAuthority, serverDailyCap: number): JobLeaseStore {
  const lease = (job: WorkJob, token: string, generation: number, expires: Date): Lease =>
    ({ jobId: job.id,claimToken: token,generation,expiresAt: expires.toISOString(),inputDigest: job.input_digest });
  return {
    claim: (actor,id,input) => db.transaction().execute(async tx => {
      const job = await lockWorkJob(tx,actor,id,authorize);
      if (job.delivery_handle !== input.deliveryHandle) throw new AutomationError('resource_not_found','Job handle is unavailable.');
      if (job.state === 'leased') {
        const expired = (await sql`SELECT job_id FROM automation_job_attempts WHERE job_id=${id} AND generation=${job.active_generation}::bigint
          AND lease_until<=clock_timestamp()`.execute(tx)).rows[0];
        if (!expired) return { kind: 'conflict' as const };
        await sql`UPDATE automation_job_attempts SET outcome='unknownOutcome' WHERE job_id=${id} AND generation=${job.active_generation}::bigint`.execute(tx);
        await sql`UPDATE automation_jobs SET state='uncertain',revision=revision+1,explanation='Lease expired with unknown external outcome.' WHERE id=${id}`.execute(tx);
        return { kind: 'uncertain' as const };
      }
      if (job.state !== 'ready') return { kind: job.state === 'uncertain' ? 'uncertain' as const : 'conflict' as const };
      const usage = { ownerId: actor.accountId,ruleId: job.rule_id,runId: job.run_id,jobId: id,targetId: job.target_id };
      const attempts = (await sql<{ count: number }>`SELECT count(*)::int AS count FROM automation_job_attempts WHERE job_id=${id}`.execute(tx)).rows[0]!.count;
      if (attempts >= job.max_calls || !await reserveOptionalWork(tx,usage,serverDailyCap)) {
        await sql`UPDATE automation_jobs SET state='blocked',revision=revision+1,explanation='Optional execution budget exhausted.' WHERE id=${id}`.execute(tx);
        return { kind: 'budget' as const };
      }
      const token = randomBytes(32).toString('base64url'), generation = Number(job.active_generation) + 1;
      const seconds = Math.min(input.requestedLeaseSeconds ?? 120,120);
      const row = (await sql<{ lease_until: Date }>`INSERT INTO automation_job_attempts(job_id,generation,executor_id,principal_binding,claim_token_hash,lease_until,outcome)
        VALUES(${id},${generation},${job.target_id},${workBinding(actor)},${claimTokenHash(token)},clock_timestamp()+${seconds}*interval '1 second','leased') RETURNING lease_until`.execute(tx)).rows[0]!;
      await sql`UPDATE automation_jobs SET state='leased',active_generation=${generation},revision=revision+1 WHERE id=${id}`.execute(tx);
      await recordOptionalCall(tx,usage);
      return { kind: 'claimed' as const,lease: lease(job,token,generation,row.lease_until) };
    }),
    heartbeat: (actor,id,input) => db.transaction().execute(async tx => {
      const job = await lockWorkJob(tx,actor,id,authorize);
      await requireJobLease(tx,actor,job,input);
      const row = (await sql<{ lease_until: Date }>`UPDATE automation_job_attempts SET lease_until=clock_timestamp()+${Math.min(input.extendSeconds,120)}*interval '1 second'
        WHERE job_id=${id} AND generation=${input.generation} RETURNING lease_until`.execute(tx)).rows[0]!;
      return lease(job,input.claimToken,input.generation,row.lease_until);
    }),
    fail: (actor,id,input) => db.transaction().execute(async tx => {
      const job = await lockWorkJob(tx,actor,id,authorize,true);
      await requireJobLease(tx,actor,job,input);
      await sql`UPDATE automation_job_attempts SET outcome=${input.kind} WHERE job_id=${id} AND generation=${input.generation}`.execute(tx);
      const state = input.kind === 'unknownOutcome' ? 'uncertain' : input.kind === 'permanent' ? 'failed' : 'ready';
      await sql`UPDATE automation_jobs SET state=${state},revision=revision+1,explanation=${input.message.slice(0,1000)} WHERE id=${id}`.execute(tx);
    }),
    verify: (actor,id,proof) => db.transaction().execute(async tx => { const job = await lockWorkJob(tx,actor,id,authorize); await requireJobLease(tx,actor,job,proof); }),
  };
}
