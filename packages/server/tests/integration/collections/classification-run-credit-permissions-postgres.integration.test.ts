import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createDatabaseRuntime, runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresAccountCreditsPort } from '../../../src/infrastructure/identity/index.js';
import { createClassificationRunCommands } from '../../../src/infrastructure/collections/classification-run-commands.js';
import { createClassificationRunJobs } from '../../../src/infrastructure/collections/classification-run-jobs.js';
import { createBookmarkClassificationProvider } from '../../../src/infrastructure/collections/classification-provider-factory.js';
import { createCreditTestDatabase, grantCredits } from '../../support/credit-ledger-fixture.js';
import { seedClassificationTaxonomy } from '../../support/classification-database-fixture.js';
import { describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

describeWithPostgres('batch credit recovery under production financial privileges', () => {
  let isolated: IsolatedPostgresRuntime;
  let application: DatabaseRuntime;
  const role = `credit_batch_app_${randomUUID().replaceAll('-', '')}`;
  beforeAll(async () => {
    isolated = await createCreditTestDatabase('credit_batch_permissions');
    await isolated.runtime.pool.query(`DO $$ BEGIN
      IF to_regrole('known_credits_app') IS NULL THEN CREATE ROLE known_credits_app NOLOGIN; END IF;
    END $$`);
    await runMigrations(isolated.runtime.db, 'latest');
    await isolated.runtime.pool.query(`CREATE ROLE "${role}" NOLOGIN`);
    await isolated.runtime.pool.query(`GRANT known_credits_app TO "${role}"`);
    // Existing application business permissions; finance remains SELECT + controlled functions only.
    const tables = await isolated.runtime.pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE 'credit_%' AND tablename NOT LIKE 'kysely_%'");
    for (const { tablename } of tables.rows) {
      await isolated.runtime.pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${tablename}" TO "${role}"`);
    }
    const url = new URL(isolated.databaseUrl);
    url.searchParams.set('options', `-c search_path=public -c role=${role}`);
    application = createDatabaseRuntime(url.toString(), { maxConnections: 6 });
    expect((await application.pool.query('SELECT current_user AS name')).rows[0].name).toBe(role);
  }, 180_000);
  afterAll(async () => {
    await application?.close();
    if (isolated) {
      await isolated.runtime.pool.query(`DROP OWNED BY "${role}"`);
      await isolated.runtime.pool.query(`DROP ROLE "${role}"`);
      await isolated.close();
    }
  });

  test.each(['cancel', 'stop', 'deadline', 'payload-expiry'] as const)('%s releases holds without direct financial write privileges', async operation => {
    const fixture = await seedClassificationTaxonomy(isolated.runtime);
    await grantCredits(isolated.runtime.db, { accountId: fixture.collectionId, grantKey: randomUUID(), amount: 2 });
    const options = { creditEnabled: true, credits: createPostgresAccountCreditsPort, cancelBackend: application.cancelBackend };
    const commands = createClassificationRunCommands(application.db, createBookmarkClassificationProvider(null), options);
    const jobs = createClassificationRunJobs(application.db, options);
    const input = { actor: { principalId: fixture.collectionId, subjectId: fixture.ownerSubjectId },
      collectionId: fixture.collectionId, commandId: randomUUID(), requestId: randomUUID(),
      document: { nodeIds: [fixture.nodeId, fixture.otherNodeId], requested: { folder: true, tags: false }, maxItems: 2,
        billing: { priceVersion: 'bookmark-classify.v1', maxPoints: 2 } } };
    const created = await commands.create(input);
    expect(created.kind).toBe('replay');
    if (created.kind !== 'replay') throw new Error('Expected created run');
    expect(created.result.status).toBe(201);
    const run = JSON.parse(Buffer.from(created.result.body).toString('utf8')) as { runId: string; etag: string };
    if (operation === 'cancel') {
      const cancelled = await commands.cancel({ ...input, runId: run.runId, commandId: randomUUID(), ifMatch: run.etag, document: {} });
      expect(cancelled.kind === 'replay' && cancelled.result.status).toBe(200);
    } else if (operation === 'stop') {
      const lease = await jobs.lease(run.runId);
      expect(lease).not.toBeNull();
      await jobs.stopRun(lease!, 'disabled');
    } else {
      await isolated.runtime.pool.query("UPDATE collection_classification_runs SET created_at=clock_timestamp()-interval '5 minutes', deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1", [run.runId]);
      if (operation === 'payload-expiry') {
        await isolated.runtime.pool.query("UPDATE collection_classification_runs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [run.runId]);
      }
      await jobs.reap();
    }
    const charges = await application.pool.query('SELECT state FROM credit_charges WHERE account_id=$1', [fixture.collectionId]);
    expect(charges.rows).toEqual([{ state: 'released' }, { state: 'released' }]);
    const releases = await application.pool.query("SELECT count(*)::int AS n FROM credit_ledger_entries WHERE account_id=$1 AND kind='release'", [fixture.collectionId]);
    expect(releases.rows[0].n).toBe(2);
    await expect(application.pool.query('UPDATE credit_grants SET amount=amount WHERE false')).rejects.toMatchObject({ code: '42501' });
    const integrity = await application.pool.query('SELECT * FROM credit_audit_account($1,false)', [fixture.collectionId]);
    expect(integrity.rows).toEqual([]);
  });
});
