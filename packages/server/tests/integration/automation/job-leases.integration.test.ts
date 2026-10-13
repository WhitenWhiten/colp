import { afterEach, beforeEach, expect, test } from 'vitest';
import { sql } from 'kysely';
import type { Job } from '@know-n/colp/automation';
import { automationPollingFixture } from '../../support/automation-polling-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createJobLeaseStore } from '../../../src/infrastructure/automation/lease-store.js';
import { claimJob, heartbeatJob, failJob } from '../../../src/modules/automation/index.js';

// A job admitted by the real pipeline (paired target, worker rule, execution policy), leased through
// the real target authorization, so no state here is one production cannot reach.
describeWithPostgres('AW-23 lease generation and uncertainty', () => {
  let f: Awaited<ReturnType<typeof automationPollingFixture>>, store: ReturnType<typeof createJobLeaseStore>, job: Job;
  beforeEach(async () => {
    f = await automationPollingFixture('aw23', { maxCalls: 3 });
    job = (await f.work!.list(f.actor,{ targetId: f.target.id })).items[0]!;
    store = createJobLeaseStore(f.db,f.worker.authorize,100);
  });
  afterEach(async () => { await f?.close(); });
  const claim = () => claimJob(store,f.actor,job.id,{ deliveryHandle: job.deliveryHandle! });
  test('concurrent claims have one winner; stored token is hashed; only current binding can heartbeat/complete', async () => {
    const results = await Promise.allSettled([claim(),claim()]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const result = results.find(r => r.status === 'fulfilled'); if (result?.status !== 'fulfilled') throw new Error('No claimant');
    const lease = result.value;
    expect(lease.generation).toBe(1);
    const attempt = (await sql<{ claim_token_hash: string }>`SELECT claim_token_hash FROM automation_job_attempts`.execute(f.db)).rows[0]!;
    expect(attempt.claim_token_hash).toMatch(/^[a-f0-9]{64}$/); expect(attempt.claim_token_hash).not.toBe(lease.claimToken);
    expect(Date.parse(lease.expiresAt)-Date.now()).toBeLessThanOrEqual(120_000);
    await expect(heartbeatJob(store,f.actor,job.id,{ claimToken: 'wrong',generation: 1,extendSeconds: 120 })).rejects.toMatchObject({ code: 'automation_lease_lost' });
    await expect(store.verify({ ...f.actor,credentialBindingId: 'another-connection' },job.id,lease)).rejects.toMatchObject({ code: 'resource_not_found' });
    expect((await heartbeatJob(store,f.actor,job.id,{ claimToken: lease.claimToken,generation: lease.generation,extendSeconds: 120 })).generation).toBe(1);
    await store.verify(f.actor,job.id,lease);
  });
  test('safe failure permits a new generation; stale tokens fail; unknown result is held', async () => {
    const first = await claim();
    await failJob(store,f.actor,job.id,{ claimToken: first.claimToken,generation: first.generation,kind: 'knownRetryable',code: 'not_started',message: 'No external request started' });
    const second = await claim(); expect(second.generation).toBe(2);
    await expect(store.verify(f.actor,job.id,first)).rejects.toMatchObject({ code: 'automation_lease_lost' });
    await failJob(store,f.actor,job.id,{ claimToken: second.claimToken,generation: second.generation,kind: 'unknownOutcome',code: 'timeout',message: 'External outcome unknown' });
    await expect(claim()).rejects.toMatchObject({ code: 'automation_claim_conflict' });
    expect((await sql<{ state: string }>`SELECT state FROM automation_jobs WHERE id=${job.id}`.execute(f.db)).rows[0]!.state).toBe('uncertain');
  });
  test('expiry durably records uncertainty and cannot silently reassign', async () => {
    const first = await claim();
    // Time travel: the lease ends now instead of in 120 seconds.
    await sql`UPDATE automation_job_attempts SET lease_until=clock_timestamp()-interval '1 second' WHERE job_id=${job.id}`.execute(f.db);
    await expect(store.verify(f.actor,job.id,first)).rejects.toMatchObject({ code: 'automation_lease_lost' });
    await expect(claim()).rejects.toMatchObject({ code: 'automation_claim_conflict' });
    expect((await sql<{ state: string }>`SELECT state FROM automation_jobs WHERE id=${job.id}`.execute(f.db)).rows[0]!.state).toBe('uncertain');
    expect((await sql<{ outcome: string }>`SELECT outcome FROM automation_job_attempts WHERE job_id=${job.id}`.execute(f.db)).rows[0]!.outcome).toBe('unknownOutcome');
  });
  test('pause, current account revocation, owner loss and explicit run hold fence access', async () => {
    const lease = await claim();
    const pause = async (paused: boolean) => {
      const current = await f.app.inject({ url: '/api/v1/me/automations/pause',headers: { cookie: f.owner.cookie } });
      const changed = await f.ownerPost('/pause',{ paused },String(current.headers.etag));expect(changed.statusCode,changed.body).toBe(200);
    };
    await pause(true);
    await expect(claim()).rejects.toMatchObject({ code: 'automation_paused' });
    await pause(false);
    // Account status and collection ownership change outside Automation; set them directly.
    await f.db.updateTable('accounts').set({ status: 'disabled' }).where('id','=',f.actor.accountId).execute();
    await expect(store.verify(f.actor,job.id,lease)).rejects.toMatchObject({ code: 'resource_not_found' });
    await f.db.updateTable('accounts').set({ status: 'active' }).where('id','=',f.actor.accountId).execute();
    const foreign = await f.issue('foreign');
    await f.db.updateTable('collections').set({ owner_subject_id: foreign.subjectId }).where('id','=','collection').execute();
    await expect(store.verify(f.actor,job.id,lease)).rejects.toMatchObject({ code: 'resource_not_found' });
    await f.db.updateTable('collections').set({ owner_subject_id: f.actor.subjectId }).where('id','=','collection').execute();
    await sql`UPDATE automation_runs SET held=true WHERE id=${job.runId}`.execute(f.db);
    await expect(store.verify(f.actor,job.id,lease)).rejects.toMatchObject({ code: 'resource_not_found' });
  });
});
