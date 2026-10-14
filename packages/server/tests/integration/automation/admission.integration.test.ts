import { afterEach, beforeEach, expect, test } from 'vitest';
import { sql } from 'kysely';
import { automationRuntimeFixture } from '../../support/automation-runtime-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { setPause } from '../../../src/modules/automation/index.js';

describeWithPostgres('M1 durable each admission', () => {
  let f: Awaited<ReturnType<typeof automationRuntimeFixture>>;
  beforeEach(async () => { f = await automationRuntimeFixture('aw15'); });
  afterEach(async () => { await f?.isolated.close(); });
  const runs = async () => (await sql<{ id: string; held: boolean; policy_revision: string | null; state: string }>`SELECT * FROM automation_runs ORDER BY created_at,id`.execute(f.db)).rows;
  test('pins one run per eligible source despite restart/duplicate delivery, without jobs or M2 policies', async () => {
    await f.createNode('new-paper', 'root', 'New', 'https://arxiv.org/abs/new');
    await f.inspect(); await f.inspect();
    expect(await runs()).toHaveLength(1); expect((await runs())[0]!.policy_revision).toBeNull();
    const jobs = (await sql<{ count: string }>`SELECT count(*) FROM automation_jobs`.execute(f.db)).rows[0]!.count;
    expect(jobs).toBe('0');
  });
  test('pause holds pending runs and skips its interval; resume starts a new epoch at current high water', async () => {
    await f.createNode('new-paper', 'root', 'New', 'https://arxiv.org/abs/new'); await f.inspect();
    await f.uow.execute(f.owner, p => setPause(p, f.owner, { paused: true, reason: 'Pause fixture' }, '"0"'));
    expect(await f.uow.execute(f.owner, p => p.settings.get(f.owner.accountId))).toMatchObject({ paused: true });
    await f.createNode('paused-paper', 'root', 'Paused', 'https://arxiv.org/abs/paused');
    await f.inspect(); expect(await runs()).toHaveLength(1);
    await f.createNode('paused-uninspected', 'root', 'Paused pending', 'https://arxiv.org/abs/paused-pending');
    await f.uow.execute(f.owner, p => setPause(p, f.owner, { paused: false, reason: 'Resume fixture' }, '"1"'));
    await f.inspect(); expect(await runs()).toHaveLength(1);
    await f.createNode('resumed-paper', 'root', 'Resumed', 'https://arxiv.org/abs/resumed');
    await f.inspect(); expect(await runs()).toHaveLength(2);
    expect((await runs()).every(run => !run.held)).toBe(true);
    const epochs = (await sql<{ epoch: string }>`SELECT epoch::text FROM automation_aggregate_state ORDER BY epoch`.execute(f.db)).rows;
    expect(epochs.map(row => row.epoch)).toEqual(['1', '2']);
  });
});
