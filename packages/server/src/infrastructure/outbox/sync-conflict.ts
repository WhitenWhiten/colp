import type { Pool } from 'pg';
import { defineClosedPayloadValidator, type EventPayloadRegistration } from './envelope.js';
import type { OutboxHandlerContext, OutboxRoute } from './router.js';

export const SYNC_CONFLICT_OPENED_EVENT_TYPE = 'sync.conflict.opened';
export const SYNC_CONFLICT_OPENED_EVENT_VERSION = 1;
export const SYNC_CONFLICT_PULL_HANDLER_NAME = 'sync_conflict_pull';

const validateSyncConflictOpenedPayload = defineClosedPayloadValidator({
  action: (value) => value === 'conflict',
  collectionId: nonEmptyString,
  commitOrdinal: positiveDecimal,
  conflictId: nonEmptyString,
  conflictType: (value) => value === 'concurrent_field_update' || value === 'unprovable_base'
    || value === 'untrusted_base' || value === 'delete_update',
  conflictingFields: (value) => Array.isArray(value) && value.length > 0
    && value.every((field) => typeof field === 'string' && /^\/[A-Za-z][A-Za-z0-9]*$/u.test(field)),
  resourceType: (value) => value === 'node',
  targetId: nonEmptyString,
});

export const syncConflictEnvelopeRegistration: EventPayloadRegistration = Object.freeze({
  eventType: SYNC_CONFLICT_OPENED_EVENT_TYPE,
  eventVersion: SYNC_CONFLICT_OPENED_EVENT_VERSION,
  validatePayload: validateSyncConflictOpenedPayload,
});

/** Verifies the durable Pull authority before the worker acknowledges the redacted event. */
export function createSyncConflictOutboxRoute(pool: Pick<Pool, 'query'>): OutboxRoute {
  return Object.freeze({
    handlerName: SYNC_CONFLICT_PULL_HANDLER_NAME,
    handlerMode: 'projection_latest_only' as const,
    eventType: SYNC_CONFLICT_OPENED_EVENT_TYPE,
    eventVersion: SYNC_CONFLICT_OPENED_EVENT_VERSION,
    sideEffectDurability: 'durable' as const,
    routeClass: 'projection' as const,
    async handle(context: OutboxHandlerContext) {
      if (context.signal.aborted || !validateSyncConflictOpenedPayload(context.envelope.payload)) {
        throw new Error('Sync Conflict outbox envelope is invalid');
      }
      const payload = context.envelope.payload as Readonly<{
        conflictId: string; collectionId: string; targetId: string; commitOrdinal: string;
      }>;
      if (context.envelope.aggregate_identity.aggregate_type !== 'conflict'
          || context.envelope.aggregate_identity.aggregate_id !== payload.conflictId
          || context.envelope.aggregate_identity.aggregate_scope !== payload.collectionId
          || context.envelope.commit_ordinal !== payload.commitOrdinal) {
        throw new Error('Sync Conflict outbox envelope binding is invalid');
      }
      const persisted = await pool.query(
        `select 1 from sync_conflicts
         where conflict_id=$1 and collection_id=$2 and operation_id=$3
           and target_id=$4 and commit_ordinal=$5 and status in ('open','resolved')`,
        [payload.conflictId, payload.collectionId, context.envelope.event_id,
          payload.targetId, payload.commitOrdinal],
      );
      if (persisted.rowCount !== 1) throw new Error('Sync Conflict Pull authority is missing');
    },
  });
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function positiveDecimal(value: unknown): boolean {
  return typeof value === 'string' && /^[1-9][0-9]*$/u.test(value);
}
