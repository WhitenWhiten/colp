import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { automationPollingFixture } from '../../support/automation-polling-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { registerActivityRoutes } from '../../../src/transport/product/activity-routes.js';
import { installProductAdmission, parseStrictQuery } from '../../../src/transport/product-admission.js';
import { ProductHttpError, sendProductError } from '../../../src/transport/product-error.js';
import { createPostgresProductCommandReceiptPort } from '../../../src/infrastructure/database/product-command-receipt.js';
import { createActivityStore } from '../../../src/infrastructure/activity/index.js';

describeWithPostgres('activity lifecycle transitions', () => {
  let f: Awaited<ReturnType<typeof automationPollingFixture>>;
  let store: ReturnType<typeof createActivityStore>;
  let templateRun: string;
  let app: ReturnType<typeof Fastify>;
  beforeAll(async () => {
    f = await automationPollingFixture('activity_lifecycle');
    templateRun = (await f.db.selectFrom('automation_runs').select('id').executeTakeFirstOrThrow()).id;
    store = createActivityStore(f.db, 'activity-lifecycle-cursor-key-at-least-32-bytes');
    app = Fastify({ exposeHeadRoutes: false, routerOptions: { querystringParser: parseStrictQuery } });
    installProductAdmission(app);
    app.setErrorHandler((error, request, reply) => {
      if (error instanceof ProductHttpError) return sendProductError(request, reply, error);
      throw error;
    });
    registerActivityRoutes(app, { identityUnitOfWork: f.identity, activity: store, allowedOrigins: ['https://automation.example.test'] });
    await app.ready();
  });
  afterAll(async () => { await app?.close(); await f?.close(); });
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
    await store.markRead(f.owner.accountId, { ids: [seen.id] }, randomUUID());
    const read = (await summary()).latest!;
    await sql`UPDATE automation_jobs SET state='awaitingApproval' WHERE id=${first}`.execute(f.db);
    expect((await summary()).latest).toMatchObject({ state: 'read', revision: read.revision });
    await sql`UPDATE automation_jobs SET state='succeeded' WHERE id=${first}`.execute(f.db);
    await sql`UPDATE automation_jobs SET state='awaitingApproval' WHERE id=${second}`.execute(f.db);
    expect((await summary()).latest).toMatchObject({ state: 'unread', run: { attention: 'awaitingApproval' } });
    const next = (await summary()).latest!;
    await store.markRead(f.owner.accountId, { ids: [next.id] }, randomUUID());
    await sql`UPDATE automation_jobs SET state='committing' WHERE id=${second}`.execute(f.db);
    await sql`UPDATE automation_jobs SET state='awaitingApproval' WHERE id=${second}`.execute(f.db);
    expect((await summary()).latest?.state).toBe('unread');
  });
  test('HTTP retries replay the original result without clearing a later outcome, and reject reuse', async () => {
    const run = await newRun();
    await sql`UPDATE automation_runs SET state='completed' WHERE id=${run}`.execute(f.db);
    const item = (await summary()).latest!;
    const commandId = randomUUID();
    const request = { method: 'POST' as const, url: '/api/v1/me/activity/read',
      headers: f.ownerHeaders(commandId), payload: { ids: [item.id] } };
    const first = await app.inject(request);
    expect(first.statusCode, first.body).toBe(200);
    await sql`UPDATE automation_runs SET state='review' WHERE id=${run}`.execute(f.db);
    const reopened = (await summary()).latest!;
    const replay = await app.inject(request);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect((await summary()).latest).toEqual(reopened);
    const reused = await app.inject({ ...request, payload: { ids: ['different'] } });
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ error: { code: 'command_id_reused' } });
    await f.db.updateTable('product_command_receipts').set({
      claimed_at: sql<Date>`current_timestamp - interval '32 days'`,
      completed_at: sql<Date>`current_timestamp - interval '31 days'`,
      result_expires_at: sql<Date>`current_timestamp - interval '1 day'` })
      .where('principal_id', '=', f.owner.accountId).where('command_id', '=', commandId).execute();
    await f.db.transaction().execute(tx => createPostgresProductCommandReceiptPort(tx).purgeExpired());
    const expired = await app.inject(request);
    expect(expired.statusCode).toBe(410);
    expect(expired.json()).toMatchObject({ error: { code: 'command_result_expired' } });
    expect((await summary()).latest).toEqual(reopened);
  });

  test('concurrent duplicate commands commit one read and replay identical results', async () => {
    const run = await newRun();
    await sql`UPDATE automation_runs SET state='completed' WHERE id=${run}`.execute(f.db);
    const item = (await summary()).latest!;
    const commandId = randomUUID();
    const results = await Promise.all([1, 2].map(() => store.markRead(f.owner.accountId, { ids: [item.id] }, commandId)));
    expect(results).toEqual([{ readCount: 1, unreadCount: 0 }, { readCount: 1, unreadCount: 0 }]);
    expect((await summary()).latest?.revision).toBe(String(BigInt(item.revision) + 1n));
  });

});
