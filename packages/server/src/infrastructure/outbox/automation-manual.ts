import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { defineClosedPayloadValidator, type EventPayloadRegistration } from './envelope.js';
import { OutboxContinuationRequested, type OutboxHandlerContext, type OutboxRoute } from './router.js';

export const AUTOMATION_MANUAL_EVENT = 'automation.manual.continue';
export const AUTOMATION_MANUAL_HANDLER = 'automation_manual';
const nonempty = (value: unknown) => typeof value === 'string' && value.length > 0;
const validate = defineClosedPayloadValidator({ ownerId: nonempty, collectionId: nonempty, runId: nonempty });
export const automationManualRegistration: EventPayloadRegistration = {
  eventType: AUTOMATION_MANUAL_EVENT, eventVersion: 1, validatePayload: validate,
};

export async function appendManualWake(tx: DatabaseTransaction, ownerId: string, collectionId: string, runId: string) {
  const id = randomUUID(), eventId = randomUUID();
  await sql`WITH reserved AS (
    INSERT INTO resource_id_ledger(resource_id,resource_type) VALUES (${id},'outbox'),(${eventId},'domain-event')
  ) INSERT INTO outbox_events(outbox_id,domain_event_id,event_type,event_version,handler_name,handler_mode,
    aggregate_type,aggregate_id,aggregate_scope,aggregate_revision,commit_ordinal,payload_json,state,attempt_count,
    available_at,occurred_at,locked_until,lease_generation,completed_at,last_error,dead_lettered_at)
    VALUES(${id},${eventId},${AUTOMATION_MANUAL_EVENT},1,${AUTOMATION_MANUAL_HANDLER},'delivery_each_event',
      'collection',${collectionId},${collectionId},NULL,NULL,
      ${JSON.stringify({ ownerId, collectionId, runId })}::jsonb,'pending',0,clock_timestamp(),clock_timestamp(),NULL,0,NULL,NULL,NULL)`.execute(tx);
}

export function createAutomationManualRoute(consume: (context: OutboxHandlerContext) => Promise<boolean>): OutboxRoute {
  return { handlerName: AUTOMATION_MANUAL_HANDLER, handlerMode: 'delivery_each_event', eventType: AUTOMATION_MANUAL_EVENT,
    eventVersion: 1, sideEffectDurability: 'durable', routeClass: 'automation_ingest',
    async handle(context) {
      if (!context.attempt || context.signal.aborted || !validate(context.envelope.payload)
        || context.envelope.aggregate_identity.aggregate_scope !== context.envelope.payload.collectionId
        || context.envelope.aggregate_identity.aggregate_id !== context.envelope.payload.collectionId
        || context.envelope.aggregate_identity.aggregate_type !== 'collection') throw new Error('Invalid manual continuation');
      if (await consume(context)) throw new OutboxContinuationRequested();
    } };
}
