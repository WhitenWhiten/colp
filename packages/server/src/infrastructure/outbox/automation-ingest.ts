import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { defineClosedPayloadValidator, type EventPayloadRegistration } from './envelope.js';
import { OutboxContinuationRequested, type OutboxHandlerContext, type OutboxRoute } from './router.js';

export const AUTOMATION_INGEST_EVENT = 'automation.source.committed';
export const AUTOMATION_RESUME_EVENT = 'automation.intake.resume';
export const AUTOMATION_INGEST_HANDLER = 'automation_ingest';
const validate = defineClosedPayloadValidator({ collectionId: value => typeof value === 'string' && value.length > 0,
  operationId: value => typeof value === 'string' && value.length > 0 });
export const automationIngestRegistration: EventPayloadRegistration = {
  eventType: AUTOMATION_INGEST_EVENT, eventVersion: 1, validatePayload: validate,
};

export const automationResumeRegistration: EventPayloadRegistration = { ...automationIngestRegistration, eventType: AUTOMATION_RESUME_EVENT };

/** A redacted wake for every canonical operation, including irrelevant resource mutations. */
export async function appendAutomationIngest(tx: DatabaseTransaction, event: {
  domainEventId: string; operationId: string; collectionId: string; commitOrdinal: bigint;
}, eventType = AUTOMATION_INGEST_EVENT): Promise<void> {
  const id = randomUUID();
  // Reserve identity and enqueue in one round trip, still in the canonical transaction.
  await sql`WITH reserved AS (
    INSERT INTO resource_id_ledger(resource_id,resource_type) VALUES (${id},'outbox') RETURNING resource_id
  ) INSERT INTO outbox_events(outbox_id,domain_event_id,event_type,event_version,handler_name,handler_mode,
    aggregate_type,aggregate_id,aggregate_scope,aggregate_revision,commit_ordinal,payload_json,state,attempt_count,
    available_at,occurred_at,locked_until,lease_generation,completed_at,last_error,dead_lettered_at)
  SELECT resource_id,${event.domainEventId},${eventType},1,${AUTOMATION_INGEST_HANDLER},'delivery_each_event',
    'collection',${event.collectionId},${event.collectionId},NULL,${event.commitOrdinal},
    ${JSON.stringify({ collectionId: event.collectionId, operationId: event.operationId })}::jsonb,'pending',0,
    clock_timestamp()+interval '10 seconds',clock_timestamp(),NULL,0,NULL,NULL,NULL FROM reserved`.execute(tx);
}
export function createAutomationIngestRoute(inspect: (context: OutboxHandlerContext) => Promise<boolean>, eventType = AUTOMATION_INGEST_EVENT): OutboxRoute {
  return { handlerName: AUTOMATION_INGEST_HANDLER, handlerMode: 'delivery_each_event', eventType,
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

export async function appendAutomationResume(tx: DatabaseTransaction, collectionId: string): Promise<void> {
  const latest = await tx.selectFrom('operations').select(['operation_id','commit_ordinal']).where('collection_id', '=', collectionId)
    .orderBy('commit_ordinal', 'desc').executeTakeFirst();
  if (!latest) return;
  const domainEventId = randomUUID();
  await tx.insertInto('resource_id_ledger').values({ resource_id: domainEventId, resource_type: 'domain-event' }).execute();
  await appendAutomationIngest(tx, { domainEventId, collectionId, operationId: latest.operation_id,
    commitOrdinal: BigInt(latest.commit_ordinal) }, AUTOMATION_RESUME_EVENT);
}
