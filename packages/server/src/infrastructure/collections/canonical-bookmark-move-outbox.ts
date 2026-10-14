import { randomUUID } from 'node:crypto';
import { sql, type Selectable } from 'kysely';
import { NODE_MOVED_EVENT_TYPE, NODE_MOVED_EVENT_VERSION, NODE_MOVED_HANDLER_NAME } from '../../modules/collections/index.js';
import type { OutboxEventTable } from '../database/outbox-tables.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { AUTOMATION_INGEST_EVENT, AUTOMATION_INGEST_HANDLER } from '../outbox/automation-ingest.js';
import { PUBLICATION_CACHE_PURGE_EVENT_TYPE, PUBLICATION_CACHE_PURGE_EVENT_VERSION,
  PUBLICATION_CACHE_PURGE_HANDLER_NAME } from '../outbox/publication-cache-purge.js';
import type { BookmarkMovePlan } from './canonical-bookmark-move-plan.js';

type MoveOutbox = Pick<Selectable<OutboxEventTable>, 'outbox_id' | 'domain_event_id' | 'aggregate_scope' | 'commit_ordinal'
  | 'event_type' | 'event_version' | 'handler_name' | 'handler_mode' | 'aggregate_type' | 'aggregate_id' | 'aggregate_revision' | 'payload_json'>;

/** One move event (and optional automation/publication delivery) per operation. */
export function bookmarkMoveOutbox(plan: BookmarkMovePlan, capture: boolean): MoveOutbox[] {
  return plan.moves.flatMap(({ event, result, after, input }) => {
    const a = result.allocation, c = plan.collection, sourceId = event.plan!.facts!.before.parent_id!;
    const common = { domain_event_id: event.domainEventId, aggregate_scope: c.id, commit_ordinal: a.commitOrdinal };
    const rows: MoveOutbox[] = [{ ...common, outbox_id: randomUUID(),
      event_type: NODE_MOVED_EVENT_TYPE, event_version: NODE_MOVED_EVENT_VERSION, handler_name: NODE_MOVED_HANDLER_NAME,
      handler_mode: 'projection_latest_only', aggregate_type: 'node', aggregate_id: after.id,
      aggregate_revision: after.resource_revision, payload_json: {
        collectionId: c.id, contentRevision: a.contentRevision!, kind: after.kind, nodeId: after.id,
        policyRevision: c.policy_revision, resourceRevision: after.resource_revision,
        sourceChildrenRevision: a.childrenRevisions[sourceId]!, sourceParentId: sourceId,
        targetChildrenRevision: a.childrenRevisions[after.parent_id!]!, targetParentId: after.parent_id!,
      } }];
    if (capture) rows.push({ ...common, outbox_id: randomUUID(), event_type: AUTOMATION_INGEST_EVENT, event_version: 1,
      handler_name: AUTOMATION_INGEST_HANDLER, handler_mode: 'delivery_each_event', aggregate_type: 'collection',
      aggregate_id: c.id, aggregate_revision: null, payload_json: { collectionId: c.id, operationId: input.operationId } });
    if (c.published_at && c.publication_slug) rows.push({ ...common, outbox_id: randomUUID(),
      event_type: PUBLICATION_CACHE_PURGE_EVENT_TYPE, event_version: PUBLICATION_CACHE_PURGE_EVENT_VERSION,
      handler_name: PUBLICATION_CACHE_PURGE_HANDLER_NAME, handler_mode: 'delivery_each_event', aggregate_type: 'collection',
      aggregate_id: c.id, aggregate_revision: a.contentRevision!, payload_json: { collectionId: c.id,
        contentRevision: a.contentRevision!, policyRevision: c.policy_revision, publicationSlug: c.publication_slug,
        sourceEventType: NODE_MOVED_EVENT_TYPE, sourceEventVersion: NODE_MOVED_EVENT_VERSION, visibility: c.visibility } });
    return rows;
  });
}

export async function appendBookmarkMoveOutbox(tx: DatabaseTransaction, rows: readonly MoveOutbox[]) {
  const encoded = rows.map(row => ({ ...row, commit_ordinal: row.commit_ordinal!.toString() }));
  await sql`INSERT INTO outbox_events(outbox_id,domain_event_id,event_type,event_version,handler_name,handler_mode,
    aggregate_type,aggregate_id,aggregate_scope,aggregate_revision,commit_ordinal,payload_json,state,attempt_count,
    available_at,occurred_at,locked_until,lease_generation,completed_at,last_error,dead_lettered_at)
    SELECT outbox_id,domain_event_id,event_type,event_version,handler_name,handler_mode,aggregate_type,aggregate_id,
      aggregate_scope,aggregate_revision,commit_ordinal,payload_json,'pending',0,
      CASE WHEN event_type=${AUTOMATION_INGEST_EVENT} THEN clock_timestamp()+interval '10 seconds' ELSE current_timestamp END,
      CASE WHEN event_type=${AUTOMATION_INGEST_EVENT} THEN clock_timestamp() ELSE current_timestamp END,NULL,0,NULL,NULL,NULL
    FROM jsonb_to_recordset(${JSON.stringify(encoded)}::jsonb) AS i(outbox_id text,domain_event_id text,event_type text,
      event_version integer,handler_name text,handler_mode text,aggregate_type text,aggregate_id text,aggregate_scope text,
      aggregate_revision text,commit_ordinal bigint,payload_json jsonb)`.execute(tx);
}
