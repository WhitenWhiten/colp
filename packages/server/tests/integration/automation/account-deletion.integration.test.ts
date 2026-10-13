import { afterEach,expect,test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { automationPollingFixture } from '../../support/automation-polling-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';

describeWithPostgres('automation foreign keys on account removal',() => {
  let f: Awaited<ReturnType<typeof automationPollingFixture>>;
  afterEach(async () => { await f?.close(); });
  test('a hard account delete removes every automation row the account owns, whatever the FK path',async () => {
    f = await automationPollingFixture('fk_account_delete');
    const job = (await f.work!.list(f.actor,{ targetId: f.target.id })).items[0]!;
    const inputs = await f.work!.inputs(f.actor,job.id,{ deliveryHandle: job.deliveryHandle! });
    const lease = await f.work!.mutate(f.actor,job.id,'claim',{ deliveryHandle: job.deliveryHandle },randomUUID());
    const submitted = await f.work!.mutate(f.actor,job.id,'submit',{ claimToken: lease.claimToken,generation: lease.generation,inputDigest: lease.inputDigest,
      outputContract: job.task.outputContract,output: { kind: 'text',textType: 'summary',text: 'Summary before removal',language: 'en',
        evidence: [{ kind: 'source',reference: inputs.items[0]!.sourceEventId,observedAt: new Date().toISOString() }] } },randomUUID());
    expect(submitted.status).toBe('succeeded');
    const owned = async () => Number((await sql<{ n: string }>`SELECT
      (SELECT count(*) FROM automation_rules WHERE owner_id=${f.owner.accountId})+(SELECT count(*) FROM automation_runs WHERE owner_id=${f.owner.accountId})
      +(SELECT count(*) FROM automation_targets WHERE owner_id=${f.owner.accountId})+(SELECT count(*) FROM automation_proposals p JOIN automation_jobs j ON j.id=p.job_id
        JOIN automation_runs r ON r.id=j.run_id WHERE r.owner_id=${f.owner.accountId}) AS n`.execute(f.db)).rows[0]!.n);
    expect(await owned()).toBeGreaterThan(3);
    // Withdrawal removes the account's non-automation rows first; automation tables must need no such step.
    const blockers = (await sql<{ table_name: string; column_name: string }>`SELECT c.conrelid::regclass::text AS table_name,a.attname AS column_name
      FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
      WHERE c.contype='f' AND c.confrelid='accounts'::regclass AND c.confdeltype IN ('a','r') AND c.conrelid::regclass::text NOT LIKE 'automation%'`.execute(f.db)).rows;
    await f.db.transaction().execute(async tx => {
      for (const blocker of blockers) await sql`DELETE FROM ${sql.table(blocker.table_name)} WHERE ${sql.ref(blocker.column_name)}=${f.owner.accountId}`.execute(tx);
      await sql`DELETE FROM accounts WHERE id=${f.owner.accountId}`.execute(tx);
    });
    expect(await owned()).toBe(0);
  });
});
