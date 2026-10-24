import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { automationPollingFixture } from '../../support/automation-polling-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createActivityStore } from '../../../src/infrastructure/activity/index.js';

describeWithPostgres('activity lifecycle transitions', () => {
  let f: Awaited<ReturnType<typeof automationPollingFixture>>;
  let store: ReturnType<typeof createActivityStore>;
  let templateRun: string;
  beforeAll(async () => {
    f = await automationPollingFixture('activity_lifecycle');
    templateRun = (await f.db.selectFrom('automation_runs').select('id').executeTakeFirstOrThrow()).id;
    store = createActivityStore(f.db, 'activity-lifecycle-cursor-key-at-least-32-bytes');
  });
  afterAll(async () => { await f?.close(); });
  beforeEach(async () => { await sql`DELETE FROM activity_items`.execute(f.db); });

  async function newRun() {
    const id = randomUUID();
    await sql`INSERT INTO automation_runs(id,owner_id,kind,rule_revision_id,binding_set_id,binding_revision,policy_revision,member_ids,state,explanation_json)
      SELECT ${id},owner_id,kind,rule_revision_id,binding_set_id,binding_revision,policy_revision,member_ids,'running',explanation_json
      FROM automation_runs WHERE id=${templateRun}`.execute(f.db);
    return id;
  }
  async function job(run: string, task: string) {
    const id = randomUUID();
    await sql`INSERT INTO automation_jobs(id,run_id,task_id,input_digest,contract_id,state)
      VALUES(${id},${run},${task},'digest','contract','ready')`.execute(f.db);
    return id;
  }
  const summary = () => store.summary(f.owner.accountId);

  test('each new job approval reopens the run notification, but repeated writes do not', async () => {
    const run = await newRun(), first = await job(run, 'first'), second = await job(run, 'second');
    await sql`UPDATE automation_jobs SET state='awaitingApproval' WHERE id=${first}`.execute(f.db);
    const seen = (await summary()).latest!;
    await store.markRead(f.owner.accountId, { ids: [seen.id] });
    const read = (await summary()).latest!;
    await sql`UPDATE automation_jobs SET state='awaitingApproval' WHERE id=${first}`.execute(f.db);
    expect((await summary()).latest).toMatchObject({ state: 'read', revision: read.revision });
    await sql`UPDATE automation_jobs SET state='succeeded' WHERE id=${first}`.execute(f.db);
    await sql`UPDATE automation_jobs SET state='awaitingApproval' WHERE id=${second}`.execute(f.db);
    expect((await summary()).latest).toMatchObject({ state: 'unread', run: { attention: 'awaitingApproval' } });
    const next = (await summary()).latest!;
    await store.markRead(f.owner.accountId, { ids: [next.id] });
    await sql`UPDATE automation_jobs SET state='committing' WHERE id=${second}`.execute(f.db);
    await sql`UPDATE automation_jobs SET state='awaitingApproval' WHERE id=${second}`.execute(f.db);
    expect((await summary()).latest?.state).toBe('unread');
  });
});
