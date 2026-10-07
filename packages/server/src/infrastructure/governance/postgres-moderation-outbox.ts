import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { createPostgresResourceIdLedgerPort } from '../database/resource-id-ledger.js';
import type { ModerationOutboxPort } from '../../modules/governance/index.js';

export const GOVERNANCE_COLLECTION_CONTROL_EVENT_TYPE = 'governance.collection_control.changed@1';
export const GOVERNANCE_COLLECTION_CONTROL_EVENT_VERSION = 1;
export const GOVERNANCE_COLLECTION_CONTROL_HANDLER_NAME = 'governance_collection_control';
export const GOVERNANCE_BOOKMARK_CONTROL_EVENT_TYPE = 'governance.bookmark_control.changed@1';
export const GOVERNANCE_BOOKMARK_CONTROL_EVENT_VERSION = 1;
export const GOVERNANCE_BOOKMARK_CONTROL_HANDLER_NAME = 'governance_bookmark_control';
export const GOVERNANCE_DIGEST_CONTROL_EVENT_TYPE = 'governance.digest_control.changed@1';
export const GOVERNANCE_DIGEST_CONTROL_EVENT_VERSION = 1;
export const GOVERNANCE_ACCOUNT_CONTROL_EVENT_TYPE = 'governance.account_control.changed@1';
export const GOVERNANCE_ACCOUNT_CONTROL_EVENT_VERSION = 1;

export function createPostgresModerationOutbox(transaction: DatabaseTransaction): ModerationOutboxPort {
  return {
    async appendCollectionControl(event) {
      const ledger = createPostgresResourceIdLedgerPort(transaction);
      await ledger.reserve([
        { resourceId: event.outboxId, resourceType: 'outbox' },
        { resourceId: event.eventId, resourceType: 'domain-event' },
      ]);
      const payload = {
        collectionId: event.collectionId,
        actionId: event.actionId,
        action: event.action,
        state: event.state,
        publicationSlug: event.publicationSlug,
      };
      await transaction.insertInto('outbox_events').values({
        outbox_id: event.outboxId,
        domain_event_id: event.eventId,
        event_type: GOVERNANCE_COLLECTION_CONTROL_EVENT_TYPE,
        event_version: GOVERNANCE_COLLECTION_CONTROL_EVENT_VERSION,
        handler_name: GOVERNANCE_COLLECTION_CONTROL_HANDLER_NAME,
        handler_mode: 'delivery_each_event',
        aggregate_type: 'collection',
        aggregate_id: event.collectionId,
        aggregate_scope: event.collectionId,
        aggregate_revision: event.actionId,
        commit_ordinal: 1n,
        occurred_at: event.occurredAt,
        payload_json: payload,
        state: 'pending',
        attempt_count: 0,
        available_at: event.occurredAt,
        locked_until: null,
        lease_generation: 0n,
        completed_at: null,
        last_error: null,
        dead_lettered_at: null,
      }).execute();
    },
    async appendBookmarkControl(event) {
      const ledger = createPostgresResourceIdLedgerPort(transaction);
      await ledger.reserve([
        { resourceId: event.outboxId, resourceType: 'outbox' },
        { resourceId: event.eventId, resourceType: 'domain-event' },
      ]);
      const payload = {
        collectionId: event.collectionId,
        nodeId: event.nodeId,
        actionId: event.actionId,
        action: event.action,
        state: event.state,
        publicationSlug: event.publicationSlug,
        faviconObjectId: event.faviconObjectId,
      };
      await transaction.insertInto('outbox_events').values({
        outbox_id: event.outboxId,
        domain_event_id: event.eventId,
        event_type: GOVERNANCE_BOOKMARK_CONTROL_EVENT_TYPE,
        event_version: GOVERNANCE_BOOKMARK_CONTROL_EVENT_VERSION,
        handler_name: GOVERNANCE_BOOKMARK_CONTROL_HANDLER_NAME,
        handler_mode: 'delivery_each_event',
        aggregate_type: 'bookmark',
        aggregate_id: event.nodeId,
        aggregate_scope: event.collectionId,
        aggregate_revision: event.actionId,
        commit_ordinal: 1n,
        occurred_at: event.occurredAt,
        payload_json: payload,
        state: 'pending',
        attempt_count: 0,
        available_at: event.occurredAt,
        locked_until: null,
        lease_generation: 0n,
        completed_at: null,
        last_error: null,
        dead_lettered_at: null,
      }).execute();
    },
    async appendDigestControl(event) {
      const ledger = createPostgresResourceIdLedgerPort(transaction);
      await ledger.reserve([
        { resourceId: event.outboxId, resourceType: 'outbox' },
        { resourceId: event.eventId, resourceType: 'domain-event' },
      ]);
      const payload = {
        seriesId: event.seriesId,
        editionId: event.editionId,
        actionId: event.actionId,
        action: event.action,
        state: event.state,
        seriesSlug: event.seriesSlug,
      };
      await transaction.insertInto('outbox_events').values({
        outbox_id: event.outboxId,
        domain_event_id: event.eventId,
        event_type: GOVERNANCE_DIGEST_CONTROL_EVENT_TYPE,
        event_version: GOVERNANCE_DIGEST_CONTROL_EVENT_VERSION,
        handler_name: GOVERNANCE_COLLECTION_CONTROL_HANDLER_NAME,
        handler_mode: 'delivery_each_event',
        aggregate_type: event.editionId === null ? 'digest_series' : 'digest_edition',
        aggregate_id: event.editionId ?? event.seriesId,
        aggregate_scope: event.seriesId,
        aggregate_revision: event.actionId,
        commit_ordinal: 1n,
        occurred_at: event.occurredAt,
        payload_json: payload,
        state: 'pending',
        attempt_count: 0,
        available_at: event.occurredAt,
        locked_until: null,
        lease_generation: 0n,
        completed_at: null,
        last_error: null,
        dead_lettered_at: null,
      }).execute();
    },
    async appendAccountControl(event) {
      const ledger = createPostgresResourceIdLedgerPort(transaction);
      await ledger.reserve([
        { resourceId: event.outboxId, resourceType: 'outbox' },
        { resourceId: event.eventId, resourceType: 'domain-event' },
      ]);
      const payload = {
        accountId: event.accountId,
        actionId: event.actionId,
        action: event.action,
        state: event.state,
        handle: event.handle,
        avatarObjectId: event.avatarObjectId,
      };
      await transaction.insertInto('outbox_events').values({
        outbox_id: event.outboxId,
        domain_event_id: event.eventId,
        event_type: GOVERNANCE_ACCOUNT_CONTROL_EVENT_TYPE,
        event_version: GOVERNANCE_ACCOUNT_CONTROL_EVENT_VERSION,
        handler_name: GOVERNANCE_COLLECTION_CONTROL_HANDLER_NAME,
        handler_mode: 'delivery_each_event',
        aggregate_type: 'account',
        aggregate_id: event.accountId,
        aggregate_scope: event.accountId,
        aggregate_revision: event.actionId,
        commit_ordinal: 1n,
        occurred_at: event.occurredAt,
        payload_json: payload,
        state: 'pending',
        attempt_count: 0,
        available_at: event.occurredAt,
        locked_until: null,
        lease_generation: 0n,
        completed_at: null,
        last_error: null,
        dead_lettered_at: null,
      }).execute();
    },
  };
}
