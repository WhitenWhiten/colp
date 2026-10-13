import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { defineClosedPayloadValidator, type EventPayloadRegistration } from './envelope.js';
import { OutboxContinuationRequested, type OutboxHandlerContext, type OutboxRoute } from './router.js';

export const AUTOMATION_INGEST_EVENT = 'automation.source.committed';
export const AUTOMATION_INGEST_HANDLER = 'automation_ingest';
const validate = defineClosedPayloadValidator({ collectionId: value => typeof value === 'string' && value.length > 0,
  operationId: value => typeof value === 'string' && value.length > 0 });
export const automationIngestRegistration: EventPayloadRegistration = {
  eventType: AUTOMATION_INGEST_EVENT, eventVersion: 1, validatePayload: validate,
};

/** A redacted wake for every canonical operation, including irrelevant resource mutations. */
export async function appendAutomationIngest(tx: DatabaseTransaction, event: {
  domainEventId: string; operationId: string; collectionId: string; commitOrdinal: bigint;
}): Promise<void> {
  const id = randomUUID();
  await tx.insertInto('resource_id_ledger').values({ resource_id: id, resource_type: 'outbox' }).execute();
  await tx.insertInto('outbox_events').values({ outbox_id: id, domain_event_id: event.domainEventId,
    event_type: AUTOMATION_INGEST_EVENT, event_version: 1, handler_name: AUTOMATION_INGEST_HANDLER,
    handler_mode: 'delivery_each_event', aggregate_type: 'collection', aggregate_id: event.collectionId,
    aggregate_scope: event.collectionId, aggregate_revision: null, commit_ordinal: event.commitOrdinal,
    payload_json: { collectionId: event.collectionId, operationId: event.operationId }, state: 'pending', attempt_count: 0,
    // Allow the canonical Sync receipt to arrive before server fallback intake.
    available_at: sql<Date>`clock_timestamp() + interval '5 seconds'`, occurred_at: sql<Date>`clock_timestamp()`,
    locked_until: null, lease_generation: 0n, completed_at: null, last_error: null, dead_lettered_at: null }).execute();
}
export function createAutomationIngestRoute(inspect: (context: OutboxHandlerContext) => Promise<boolean>): OutboxRoute {
  return { handlerName: AUTOMATION_INGEST_HANDLER, handlerMode: 'delivery_each_event', eventType: AUTOMATION_INGEST_EVENT,
    eventVersion: 1, sideEffectDurability: 'durable', routeClass: 'automation_ingest',
    async handle(context) {
      if (!context.attempt || context.signal.aborted || !validate(context.envelope.payload)
        || context.envelope.aggregate_identity.aggregate_scope !== context.envelope.payload.collectionId
        || context.envelope.aggregate_identity.aggregate_id !== context.envelope.payload.collectionId
        || context.envelope.aggregate_identity.aggregate_type !== 'collection' || !context.envelope.commit_ordinal)
        throw new Error('Invalid automation source delivery');
      if (await inspect(context)) throw new OutboxContinuationRequested();
    } };
}
