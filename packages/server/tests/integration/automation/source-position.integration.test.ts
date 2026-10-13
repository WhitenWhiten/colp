import { afterEach, beforeEach, expect, test } from 'vitest';
import { sql } from 'kysely';
import { automationFixture } from '../../support/automation-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createAutomationSourceInspector } from '../../../src/infrastructure/automation/source-position-store.js';
import type { OutboxHandlerContext } from '../../../src/infrastructure/outbox/router.js';

describeWithPostgres('ordered automation source positions', () => {
  let f: Awaited<ReturnType<typeof automationFixture>>;
  beforeEach(async () => { f = await automationFixture('aw14');
    await sql`CREATE TABLE inspected_test_operations (operation_id text PRIMARY KEY)`.execute(f.db);
  });
  afterEach(async () => { await f?.isolated.close(); });
  async function delivery(): Promise<OutboxHandlerContext> {
    const row = await f.db.selectFrom('outbox_events').selectAll().where('handler_name', '=', 'automation_ingest')
      .orderBy('commit_ordinal', 'desc').executeTakeFirstOrThrow();
    await f.db.updateTable('outbox_events').set({ state: 'leased', lease_generation: 1n,
      locked_until: sql<Date>`clock_timestamp() + interval '60 seconds'` }).where('outbox_id', '=', row.outbox_id).execute();
    return { signal: new AbortController().signal, idempotencyKey: row.domain_event_id,
      attempt: { outboxId: row.outbox_id, leaseGeneration: '1' }, envelope: {
        event_id: row.domain_event_id, event_type: row.event_type, event_version: row.event_version,
        aggregate_identity: { aggregate_type: row.aggregate_type, aggregate_id: row.aggregate_id, aggregate_scope: row.aggregate_scope },
        aggregate_revision: row.aggregate_revision, commit_ordinal: String(row.commit_ordinal), occurred_at: row.occurred_at.toISOString(),
        payload: row.payload_json as OutboxHandlerContext['envelope']['payload'],
      } };
  }
  test('concurrent redelivery inspects every operation once, including the bootstrap without node facts', async () => {
    const context = await delivery();
    const inspect = createAutomationSourceInspector(f.db, async (tx, _owner, _collection, rows) => {
      for (const row of rows) await sql`INSERT INTO inspected_test_operations VALUES (${row.operation_id})`.execute(tx);
    });
    expect(await Promise.all([inspect(context), inspect(context), inspect(context)])).toEqual([false, false, false]);
    const counts = (await sql<{ inspected: string; operations: string; ordinal: string }>`SELECT
      (SELECT count(*) FROM inspected_test_operations) AS inspected, (SELECT count(*) FROM operations) AS operations,
      (SELECT last_inspected_ordinal FROM automation_source_positions)::text AS ordinal`.execute(f.db)).rows[0]!;
    expect(counts.inspected).toBe(counts.operations);
    expect(counts.ordinal).toBe(context.envelope.commit_ordinal);
  });
  test('a stale lease rolls back both consumer writes and the inspection cursor', async () => {
    const inspect = createAutomationSourceInspector(f.db, async (tx, _owner, _collection, rows) => {
      for (const row of rows) await sql`INSERT INTO inspected_test_operations VALUES (${row.operation_id})`.execute(tx);
    });
    await inspect(await delivery());
    await f.createNode('later', 'root', 'Later', 'https://example.test/later');
    const context = await delivery();
    await expect(inspect({ ...context, attempt: { ...context.attempt!, leaseGeneration: '0' } })).rejects.toThrow('lease lost');
    const count = (await sql<{ count: string }>`SELECT count(*) FROM inspected_test_operations`.execute(f.db)).rows[0]!.count;
    expect(count).toBe('4');
    await inspect(context);
    expect((await sql<{ count: string }>`SELECT count(*) FROM inspected_test_operations`.execute(f.db)).rows[0]!.count).toBe('5');
  });
});
