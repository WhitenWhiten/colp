import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  FK_CASCADE_PERFORMANCE_INDEXES,
  HOT_PATH_PERFORMANCE_INDEXES,
  ONLINE_PERFORMANCE_INDEX_LIST,
  ONLINE_PERFORMANCE_INDEXES,
} from '../../../src/infrastructure/database/online-performance-indexes.js';

const HISTORICAL_ONLINE_INDEX_KEYS = Object.freeze([
  'nodesLiveEditorKeyset',
  'outboxHandlerAggregate',
  'nodesLiveBookmarkCreated',
  'publicationInsightEventsOccurred',
  'publicationInsightDailyDay',
  'socialFeedItemsCollection',
  'socialPublicActivityCollection',
  'notificationsActorProfile',
  'notificationDeliveriesRecipient',
  'notificationDeliveriesLeasedUntil',
  'relationsFromNode',
  'relationsToNode',
] as const);

describe('online performance index manifest', () => {
  test('owns every audited historical hot-table index without duplicate names', () => {
    const historical = HISTORICAL_ONLINE_INDEX_KEYS.map((key) => ONLINE_PERFORMANCE_INDEXES[key]);
    assert.equal(historical.length, 12);
    assert.equal(ONLINE_PERFORMANCE_INDEX_LIST.length, 18);
    assert.equal(
      new Set(ONLINE_PERFORMANCE_INDEX_LIST.map((definition) => definition.name)).size,
      ONLINE_PERFORMANCE_INDEX_LIST.length,
    );
    for (const definition of historical) {
      assert.match(definition.createConcurrentlySql, /^CREATE (?:UNIQUE )?INDEX CONCURRENTLY/iu);
      assert.ok(definition.definitionPatterns.length > 0, `${definition.name} needs validation`);
    }
  });

  test('migration groups contain exactly the indexes introduced together', () => {
    assert.deepEqual(HOT_PATH_PERFORMANCE_INDEXES.map(({ name }) => name), [
      'outbox_events_handler_aggregate_idx',
      'nodes_live_bookmark_created_idx',
      'publication_insight_events_occurred_idx',
      'publication_insight_daily_day_idx',
    ]);
    assert.deepEqual(FK_CASCADE_PERFORMANCE_INDEXES.map(({ name }) => name), [
      'social_feed_items_collection_idx',
      'social_public_activity_collection_idx',
      'notifications_actor_profile_idx',
      'notification_deliveries_recipient_idx',
      'notification_deliveries_leased_until_idx',
      'relations_from_node_idx',
      'relations_to_node_idx',
    ]);
  });
});
