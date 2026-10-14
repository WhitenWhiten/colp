import { setTimeout as delay } from 'node:timers/promises';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { DatabaseSchema } from '../../src/infrastructure/database/runtime.js';
import type { OutboxEventTable } from '../../src/infrastructure/database/outbox-tables.js';
import type { OutboxHandlerContext } from '../../src/infrastructure/outbox/router.js';
import { OutboxContinuationRequested } from '../../src/infrastructure/outbox/router.js';
import { AUTOMATION_MANUAL_HANDLER, createAutomationManualRoute } from '../../src/infrastructure/outbox/automation-manual.js';
import { createManualRunConsumer } from '../../src/infrastructure/automation/manual-run-consumer.js';

/** Real lease-fenced consumer transactions without running unrelated projections. */
export async function claimManualDelivery(db: Kysely<DatabaseSchema>, respectDelay = false): Promise<OutboxHandlerContext | null> {
  const row = (await sql<Selectable<OutboxEventTable>>`UPDATE outbox_events SET state='leased',
    lease_generation=lease_generation+1,locked_until=clock_timestamp()+interval '30 seconds'
    WHERE outbox_id=(SELECT outbox_id FROM outbox_events WHERE handler_name=${AUTOMATION_MANUAL_HANDLER}
      AND (state IN ('pending','retryable') OR (state='leased' AND locked_until<=clock_timestamp()))
      ${respectDelay ? sql`AND available_at<=clock_timestamp()` : sql``}
      ORDER BY occurred_at,outbox_id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`.execute(db)).rows[0];
  if (!row) return null;
  return { signal: new AbortController().signal, idempotencyKey: row.domain_event_id,
    attempt: { outboxId: row.outbox_id, leaseGeneration: String(row.lease_generation) },
    envelope: { event_id: row.domain_event_id, event_type: row.event_type, event_version: row.event_version,
      aggregate_identity: { aggregate_type: row.aggregate_type, aggregate_id: row.aggregate_id, aggregate_scope: row.aggregate_scope },
      aggregate_revision: row.aggregate_revision, commit_ordinal: row.commit_ordinal?.toString() ?? null,
      occurred_at: row.occurred_at.toISOString(), payload: row.payload_json as OutboxHandlerContext['envelope']['payload'] } };
}

export async function deliverManualSlice(db: Kysely<DatabaseSchema>, respectDelay = false) {
  const context = await claimManualDelivery(db, respectDelay);
  if (!context) return false;
  let more = false;
  try { await createAutomationManualRoute(createManualRunConsumer(db, 'server')).handle(context); }
  catch (error) {
    if (error instanceof OutboxContinuationRequested) more = true;
    else {
      await db.updateTable('outbox_events').set({ state: 'retryable', locked_until: null })
        .where('outbox_id', '=', context.attempt!.outboxId)
        .where('lease_generation', '=', BigInt(context.attempt!.leaseGeneration)).execute();
      throw error;
    }
  }
  await db.updateTable('outbox_events').set({ state: more ? 'pending' : 'completed', locked_until: null,
    completed_at: more ? null : sql<Date>`clock_timestamp()` })
    .where('outbox_id', '=', context.attempt!.outboxId).where('lease_generation', '=', BigInt(context.attempt!.leaseGeneration)).execute();
  return true;
}

export async function drainManualRuns(db: Kysely<DatabaseSchema>, respectDelay = false) {
  const deadline = performance.now() + 120000;
  let slices = 0;
  while (performance.now() < deadline) {
    if (await deliverManualSlice(db, respectDelay)) { slices++; continue; }
    const pending = await db.selectFrom('outbox_events').select('outbox_id').where('handler_name', '=', AUTOMATION_MANUAL_HANDLER)
      .where('state', 'in', ['pending','retryable','leased']).executeTakeFirst();
    if (!pending) return slices;
    await delay(25);
  }
  throw new Error('Manual continuation did not drain within 120 seconds');
}
