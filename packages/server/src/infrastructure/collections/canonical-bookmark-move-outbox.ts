import { randomUUID } from 'node:crypto';
import { sql, type InsertObject } from 'kysely';
import { NODE_MOVED_EVENT_TYPE, NODE_MOVED_EVENT_VERSION, NODE_MOVED_HANDLER_NAME } from '../../modules/collections/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { AUTOMATION_INGEST_EVENT, AUTOMATION_INGEST_HANDLER } from '../outbox/automation-ingest.js';
import { PUBLICATION_CACHE_PURGE_EVENT_TYPE, PUBLICATION_CACHE_PURGE_EVENT_VERSION,
  PUBLICATION_CACHE_PURGE_HANDLER_NAME } from '../outbox/publication-cache-purge.js';
import type { BookmarkMovePlan } from './canonical-bookmark-move-plan.js';

/** One move event (and optional automation/publication delivery) per operation. */
export function bookmarkMoveOutbox(plan: BookmarkMovePlan, capture: boolean): InsertObject<DatabaseSchema, 'outbox_events'>[] {
  return plan.moves.flatMap(({ event, result, after, input }) => {
    const a = result.allocation, c = plan.collection, sourceId = event.plan!.facts!.before.parent_id!;
    const common = { domain_event_id: event.domainEventId, aggregate_scope: c.id, commit_ordinal: a.commitOrdinal,
      state: 'pending' as const, attempt_count: 0, available_at: sql<Date>`current_timestamp`, locked_until: null,
      lease_generation: 0n, completed_at: null, last_error: null, occurred_at: sql<Date>`current_timestamp`, dead_lettered_at: null };
    const rows: InsertObject<DatabaseSchema, 'outbox_events'>[] = [{ ...common, outbox_id: randomUUID(),
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
      aggregate_id: c.id, aggregate_revision: null, payload_json: { collectionId: c.id, operationId: input.operationId },
      available_at: sql<Date>`clock_timestamp()+interval '10 seconds'`, occurred_at: sql<Date>`clock_timestamp()` });
    if (c.published_at && c.publication_slug) rows.push({ ...common, outbox_id: randomUUID(),
      event_type: PUBLICATION_CACHE_PURGE_EVENT_TYPE, event_version: PUBLICATION_CACHE_PURGE_EVENT_VERSION,
      handler_name: PUBLICATION_CACHE_PURGE_HANDLER_NAME, handler_mode: 'delivery_each_event', aggregate_type: 'collection',
      aggregate_id: c.id, aggregate_revision: a.contentRevision!, payload_json: { collectionId: c.id,
        contentRevision: a.contentRevision!, policyRevision: c.policy_revision, publicationSlug: c.publication_slug,
        sourceEventType: NODE_MOVED_EVENT_TYPE, sourceEventVersion: NODE_MOVED_EVENT_VERSION, visibility: c.visibility } });
    return rows;
  });
}
