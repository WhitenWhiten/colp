import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { sql } from 'kysely';
import { automationRuntimeFixture } from '../../support/automation-runtime-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createJobLeaseStore } from '../../../src/infrastructure/automation/lease-store.js';
import { claimJob, heartbeatJob, failJob, type WorkPrincipal } from '../../../src/modules/automation/index.js';

describeWithPostgres('AW-23 lease generation and uncertainty', () => {
  let f: Awaited<ReturnType<typeof automationRuntimeFixture>>, store: ReturnType<typeof createJobLeaseStore>, actor: WorkPrincipal, jobId: string;
  beforeEach(async () => {
    f = await automationRuntimeFixture('aw23', true);
    await f.createNode('lease-paper','root','Lease','https://arxiv.org/abs/lease'); await f.inspect();
    const run = (await sql<{ id: string }>`SELECT id FROM automation_runs`.execute(f.db)).rows[0]!;
    actor = { ...f.owner,clientId: 'client',credentialBindingId: 'credential',scopes: ['automation:work'] };
    jobId = randomUUID();
    await sql`INSERT INTO automation_jobs(id,run_id,task_id,target_id,target_partition,input_digest,contract_id,state,delivery_handle,max_calls)
      VALUES(${jobId},${run.id},'summary','target','target','digest','summary.sourced.v1','ready','handle',3)`.execute(f.db);
    // Target/profile service arrives in AW-26. This port asserts the binding expected by that service.
    store = createJobLeaseStore(f.db,async (_tx,principal,target) => {
      if (principal.credentialBindingId !== 'credential' || principal.clientId !== 'client' || target !== 'target') throw new Error('Target binding rejected');
    },100);
  });
  afterEach(async () => { await f?.isolated.close(); });
  const claim = () => claimJob(store,actor,jobId,{ deliveryHandle: 'handle' });
  test('concurrent claims have one winner; stored token is hashed; only current binding can heartbeat/complete', async () => {
    const results = await Promise.allSettled([claim(),claim()]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const result = results.find(r => r.status === 'fulfilled'); if (result?.status !== 'fulfilled') throw new Error('No claimant');
    const lease = result.value;
    expect(lease.generation).toBe(1);
    const attempt = (await sql<{ claim_token_hash: string; lease_until: Date }>`SELECT claim_token_hash,lease_until FROM automation_job_attempts`.execute(f.db)).rows[0]!;
    expect(attempt.claim_token_hash).toMatch(/^[a-f0-9]{64}$/); expect(attempt.claim_token_hash).not.toBe(lease.claimToken);
    expect(Date.parse(lease.expiresAt)-Date.now()).toBeLessThanOrEqual(120_000);
    await expect(heartbeatJob(store,actor,jobId,{ claimToken: 'wrong',generation: 1,extendSeconds: 120 })).rejects.toMatchObject({ code: 'automation_lease_lost' });
    await expect(store.verify({ ...actor,credentialBindingId: 'other' },jobId,lease)).rejects.toThrow('binding');
    expect((await heartbeatJob(store,actor,jobId,{ claimToken: lease.claimToken,generation: lease.generation,extendSeconds: 120 })).generation).toBe(1);
    await store.verify(actor,jobId,lease);
  });
  test('safe failure permits a new generation; stale tokens fail; unknown result is held', async () => {
    const first = await claim();
    await failJob(store,actor,jobId,{ claimToken: first.claimToken,generation: first.generation,kind: 'knownRetryable',code: 'not_started',message: 'No external request started' });
    const second = await claim(); expect(second.generation).toBe(2);
    await expect(store.verify(actor,jobId,first)).rejects.toMatchObject({ code: 'automation_lease_lost' });
    await failJob(store,actor,jobId,{ claimToken: second.claimToken,generation: second.generation,kind: 'unknownOutcome',code: 'timeout',message: 'External outcome unknown' });
    await expect(claim()).rejects.toMatchObject({ code: 'automation_claim_conflict' });
    expect((await sql<{ state: string }>`SELECT state FROM automation_jobs WHERE id=${jobId}`.execute(f.db)).rows[0]!.state).toBe('uncertain');
  });
  test('expiry durably records uncertainty and cannot silently reassign', async () => {
    const first = await claim();
    await sql`UPDATE automation_job_attempts SET lease_until=clock_timestamp()-interval '1 second' WHERE job_id=${jobId}`.execute(f.db);
    await expect(store.verify(actor,jobId,first)).rejects.toMatchObject({ code: 'automation_lease_lost' });
    await expect(claim()).rejects.toMatchObject({ code: 'automation_claim_conflict' });
    expect((await sql<{ state: string }>`SELECT state FROM automation_jobs WHERE id=${jobId}`.execute(f.db)).rows[0]!.state).toBe('uncertain');
    expect((await sql<{ outcome: string }>`SELECT outcome FROM automation_job_attempts WHERE job_id=${jobId}`.execute(f.db)).rows[0]!.outcome).toBe('unknownOutcome');
  });
  test('pause, current account revocation, owner loss and explicit run hold fence access', async () => {
    const lease = await claim();
    await sql`INSERT INTO automation_settings(owner_id,paused,revision) VALUES(${actor.accountId},true,1) ON CONFLICT(owner_id) DO UPDATE SET paused=true`.execute(f.db);
    await expect(claim()).rejects.toMatchObject({ code: 'automation_paused' });
    await sql`UPDATE automation_settings SET paused=false WHERE owner_id=${actor.accountId}`.execute(f.db);
    await f.db.updateTable('accounts').set({ status: 'disabled' }).where('id','=',actor.accountId).execute();
    await expect(store.verify(actor,jobId,lease)).rejects.toMatchObject({ code: 'resource_not_found' });
    await f.db.updateTable('accounts').set({ status: 'active' }).where('id','=',actor.accountId).execute();
    const foreign = await f.issue('foreign');
    await f.db.updateTable('collections').set({ owner_subject_id: foreign.subjectId }).where('id','=','collection').execute();
    await expect(store.verify(actor,jobId,lease)).rejects.toMatchObject({ code: 'resource_not_found' });
    await f.db.updateTable('collections').set({ owner_subject_id: actor.subjectId }).where('id','=','collection').execute();
    await sql`UPDATE automation_runs SET held=true`.execute(f.db);
    await expect(store.verify(actor,jobId,lease)).rejects.toMatchObject({ code: 'resource_not_found' });
  });
});
