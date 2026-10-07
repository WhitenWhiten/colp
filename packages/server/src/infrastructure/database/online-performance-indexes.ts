import { sql, type Kysely } from 'kysely';
import type { Client, PoolClient, QueryResultRow } from 'pg';

export interface OnlinePerformanceIndexDefinition {
  readonly name: string;
  readonly tableName: string;
  readonly createConcurrentlySql: string;
  readonly definitionPatterns: readonly RegExp[];
}

const nodesLiveEditorKeyset: OnlinePerformanceIndexDefinition = Object.freeze({
  name: 'nodes_live_editor_keyset_idx',
  tableName: 'nodes',
  createConcurrentlySql: `CREATE INDEX CONCURRENTLY nodes_live_editor_keyset_idx
    ON nodes (
      collection_id,
      (COALESCE(parent_id, ''::text) COLLATE "C"),
      (COALESCE(position_token, ''::text) COLLATE "C"),
      (id COLLATE "C")
    )
    WHERE deleted_at IS NULL AND NOT is_root`,
  definitionPatterns: Object.freeze([
    /\(collection_id,\s*COALESCE\(parent_id,\s*''::text\)\s+COLLATE "C",\s*COALESCE\(position_token,\s*''::text\)\s+COLLATE "C",\s*id\s+COLLATE "C"\)/iu,
    /deleted_at\s+IS\s+NULL/iu,
    /NOT\s+is_root/iu,
  ]),
});

const outboxHandlerAggregate: OnlinePerformanceIndexDefinition = Object.freeze({
  name: 'outbox_events_handler_aggregate_idx',
  tableName: 'outbox_events',
  createConcurrentlySql: `CREATE INDEX CONCURRENTLY outbox_events_handler_aggregate_idx
    ON outbox_events (handler_name, aggregate_id, commit_ordinal)
    WHERE state IN ('pending', 'retryable', 'leased')`,
  definitionPatterns: Object.freeze([
    /\(handler_name, aggregate_id, commit_ordinal\)/iu,
    /state\s*=\s*ANY\s*\(ARRAY\['pending'::text,\s*'retryable'::text,\s*'leased'::text\]\)/iu,
  ]),
});

const nodesLiveBookmarkCreated: OnlinePerformanceIndexDefinition = Object.freeze({
  name: 'nodes_live_bookmark_created_idx',
  tableName: 'nodes',
  createConcurrentlySql: `CREATE INDEX CONCURRENTLY nodes_live_bookmark_created_idx
    ON nodes (collection_id, created_at DESC, (id COLLATE "C") DESC)
    WHERE deleted_at IS NULL AND kind = 'bookmark'`,
  definitionPatterns: Object.freeze([
    /\(collection_id, created_at DESC, id COLLATE "C" DESC\)/iu,
    /deleted_at\s+IS\s+NULL/iu,
    /kind\s*=\s*'bookmark'::text/iu,
  ]),
});

const publicationInsightEventsOccurred: OnlinePerformanceIndexDefinition = Object.freeze({
  name: 'publication_insight_events_occurred_idx',
  tableName: 'publication_insight_events',
  createConcurrentlySql: `CREATE INDEX CONCURRENTLY publication_insight_events_occurred_idx
    ON publication_insight_events (occurred_at, id)`,
  definitionPatterns: Object.freeze([/\(occurred_at, id\)/iu]),
});

const publicationInsightDailyDay: OnlinePerformanceIndexDefinition = Object.freeze({
  name: 'publication_insight_daily_day_idx',
  tableName: 'publication_insight_daily',
  createConcurrentlySql: `CREATE INDEX CONCURRENTLY publication_insight_daily_day_idx
    ON publication_insight_daily (day, collection_id, event_type, node_id)`,
  definitionPatterns: Object.freeze([/\(day, collection_id, event_type, node_id\)/iu]),
});

const socialFeedItemsCollection: OnlinePerformanceIndexDefinition = Object.freeze({
  name: 'social_feed_items_collection_idx',
  tableName: 'social_feed_items',
  createConcurrentlySql: `CREATE INDEX CONCURRENTLY social_feed_items_collection_idx
    ON social_feed_items (collection_id, feed_item_id)`,
  definitionPatterns: Object.freeze([/\(collection_id, feed_item_id\)/iu]),
});

const socialPublicActivityCollection: OnlinePerformanceIndexDefinition = Object.freeze({
  name: 'social_public_activity_collection_idx',
  tableName: 'social_public_activity',
  createConcurrentlySql: `CREATE INDEX CONCURRENTLY social_public_activity_collection_idx
    ON social_public_activity (collection_id)`,
  definitionPatterns: Object.freeze([/\(collection_id\)/iu]),
});

const notificationsActorProfile: OnlinePerformanceIndexDefinition = Object.freeze({
  name: 'notifications_actor_profile_idx',
  tableName: 'notifications',
  createConcurrentlySql: `CREATE INDEX CONCURRENTLY notifications_actor_profile_idx
    ON notifications (actor_profile_id)
    WHERE actor_profile_id IS NOT NULL`,
  definitionPatterns: Object.freeze([
    /\(actor_profile_id\)/iu,
    /actor_profile_id\s+IS\s+NOT\s+NULL/iu,
  ]),
});

const notificationDeliveriesRecipient: OnlinePerformanceIndexDefinition = Object.freeze({
  name: 'notification_deliveries_recipient_idx',
  tableName: 'notification_deliveries',
  createConcurrentlySql: `CREATE INDEX CONCURRENTLY notification_deliveries_recipient_idx
    ON notification_deliveries (recipient_account_id, delivery_id)`,
  definitionPatterns: Object.freeze([/\(recipient_account_id, delivery_id\)/iu]),
});

const notificationDeliveriesLeasedUntil: OnlinePerformanceIndexDefinition = Object.freeze({
  name: 'notification_deliveries_leased_until_idx',
  tableName: 'notification_deliveries',
  createConcurrentlySql: `CREATE INDEX CONCURRENTLY notification_deliveries_leased_until_idx
    ON notification_deliveries (leased_until)
    WHERE state = 'leased'`,
  definitionPatterns: Object.freeze([
    /\(leased_until\)/iu,
    /state\s*=\s*'leased'::text/iu,
  ]),
});

const relationsFromNode: OnlinePerformanceIndexDefinition = Object.freeze({
  name: 'relations_from_node_idx',
  tableName: 'relations',
  createConcurrentlySql: `CREATE INDEX CONCURRENTLY relations_from_node_idx
    ON relations (from_node_id)`,
  definitionPatterns: Object.freeze([/\(from_node_id\)/iu]),
});

const relationsToNode: OnlinePerformanceIndexDefinition = Object.freeze({
  name: 'relations_to_node_idx',
  tableName: 'relations',
  createConcurrentlySql: `CREATE INDEX CONCURRENTLY relations_to_node_idx
    ON relations (to_node_id)`,
  definitionPatterns: Object.freeze([/\(to_node_id\)/iu]),
});

const attachmentFinalize: OnlinePerformanceIndexDefinition = Object.freeze({
  name: 'operation_lookup_facts_command_unique',
  tableName: 'operation_lookup_facts',
  createConcurrentlySql: `CREATE UNIQUE INDEX CONCURRENTLY operation_lookup_facts_command_unique
    ON operation_lookup_facts (operation_type, command_id)
    WHERE command_id IS NOT NULL`,
  definitionPatterns: Object.freeze([
    /UNIQUE INDEX/iu,
    /\(operation_type, command_id\)/iu,
    /command_id IS NOT NULL/iu,
  ]),
});

const feedRebuild: OnlinePerformanceIndexDefinition = Object.freeze({
  name: 'outbox_social_feed_rebuild_source_idx',
  tableName: 'outbox_events',
  createConcurrentlySql: `CREATE INDEX CONCURRENTLY outbox_social_feed_rebuild_source_idx
    ON outbox_events (aggregate_scope, commit_ordinal, domain_event_id)
    INCLUDE (event_version, aggregate_revision, occurred_at, payload_json, state)
    WHERE handler_name = 'social.publish-collection-change'
      AND event_type = 'social.collection-change'`,
  definitionPatterns: Object.freeze([
    /\(aggregate_scope, commit_ordinal, domain_event_id\)/iu,
    /INCLUDE \(event_version, aggregate_revision, occurred_at, payload_json, state\)/iu,
    /handler_name\s*=\s*'social\.publish-collection-change'::text/iu,
    /event_type\s*=\s*'social\.collection-change'::text/iu,
  ]),
});

const outboxPending: OnlinePerformanceIndexDefinition = Object.freeze({
  name: 'outbox_pending_due_candidate_idx',
  tableName: 'outbox_events',
  createConcurrentlySql: `CREATE INDEX CONCURRENTLY outbox_pending_due_candidate_idx
    ON outbox_events (available_at, outbox_id)
    WHERE state IN ('pending', 'retryable')`,
  definitionPatterns: Object.freeze([
    /\(available_at, outbox_id\)/iu,
    /state\s*=\s*ANY\s*\(ARRAY\['pending'::text,\s*'retryable'::text\]\)/iu,
  ]),
});

const outboxExpiredLease: OnlinePerformanceIndexDefinition = Object.freeze({
  name: 'outbox_expired_lease_due_candidate_idx',
  tableName: 'outbox_events',
  createConcurrentlySql: `CREATE INDEX CONCURRENTLY outbox_expired_lease_due_candidate_idx
    ON outbox_events (locked_until, outbox_id)
    WHERE state = 'leased'`,
  definitionPatterns: Object.freeze([
    /\(locked_until, outbox_id\)/iu,
    /state\s*=\s*'leased'::text/iu,
  ]),
});

const exploreViews: OnlinePerformanceIndexDefinition = Object.freeze({
  name: 'publication_insight_daily_explore_views_idx',
  tableName: 'publication_insight_daily',
  createConcurrentlySql: `CREATE INDEX CONCURRENTLY publication_insight_daily_explore_views_idx
    ON publication_insight_daily (day, collection_id)
    INCLUDE (count)
    WHERE event_type = 'collection_view' AND node_id = ''`,
  definitionPatterns: Object.freeze([
    /\(day, collection_id\)/iu,
    /INCLUDE \(count\)/iu,
    /event_type\s*=\s*'collection_view'::text/iu,
    /node_id\s*=\s*''::text/iu,
  ]),
});

const authSessionTokenLookup: OnlinePerformanceIndexDefinition = Object.freeze({
  name: 'auth_sessions_token_lookup_hash_uidx',
  tableName: 'auth_sessions',
  createConcurrentlySql: `CREATE UNIQUE INDEX CONCURRENTLY auth_sessions_token_lookup_hash_uidx
    ON auth_sessions ("tokenLookupHash")
    WHERE "tokenLookupHash" IS NOT NULL`,
  definitionPatterns: Object.freeze([
    /UNIQUE INDEX/iu,
    /\("tokenLookupHash"\)/u,
    /"tokenLookupHash" IS NOT NULL/u,
  ]),
});

export const ONLINE_PERFORMANCE_INDEXES = Object.freeze({
  nodesLiveEditorKeyset,
  outboxHandlerAggregate,
  nodesLiveBookmarkCreated,
  publicationInsightEventsOccurred,
  publicationInsightDailyDay,
  socialFeedItemsCollection,
  socialPublicActivityCollection,
  notificationsActorProfile,
  notificationDeliveriesRecipient,
  notificationDeliveriesLeasedUntil,
  relationsFromNode,
  relationsToNode,
  attachmentFinalize,
  feedRebuild,
  outboxPending,
  outboxExpiredLease,
  exploreViews,
  authSessionTokenLookup,
});

export const HOT_PATH_PERFORMANCE_INDEXES: readonly OnlinePerformanceIndexDefinition[] =
  Object.freeze([
    outboxHandlerAggregate,
    nodesLiveBookmarkCreated,
    publicationInsightEventsOccurred,
    publicationInsightDailyDay,
  ]);

export const FK_CASCADE_PERFORMANCE_INDEXES: readonly OnlinePerformanceIndexDefinition[] =
  Object.freeze([
    socialFeedItemsCollection,
    socialPublicActivityCollection,
    notificationsActorProfile,
    notificationDeliveriesRecipient,
    notificationDeliveriesLeasedUntil,
    relationsFromNode,
    relationsToNode,
  ]);

export const ONLINE_PERFORMANCE_INDEX_LIST: readonly OnlinePerformanceIndexDefinition[] =
  Object.freeze(Object.values(ONLINE_PERFORMANCE_INDEXES));

/** Above this size, a transactional migration must be preceded by the online runner. */
export const MAX_TRANSACTIONAL_INDEX_TABLE_BYTES = 64n * 1024n * 1024n;

interface IndexCatalogRow extends QueryResultRow {
  index_name: string;
  table_name: string;
  is_valid: boolean;
  is_ready: boolean;
  definition: string;
}

type PgSession = Client | PoolClient;

export function assertOnlinePerformanceIndexDefinition(
  expected: OnlinePerformanceIndexDefinition,
  observed: Pick<IndexCatalogRow, 'table_name' | 'is_valid' | 'is_ready' | 'definition'>,
): void {
  if (observed.table_name !== expected.tableName) {
    throw new Error(`${expected.name} belongs to unexpected table ${observed.table_name}`);
  }
  if (!observed.is_valid || !observed.is_ready) {
    throw new Error(`${expected.name} exists but is not valid and ready`);
  }
  for (const pattern of expected.definitionPatterns) {
    if (!pattern.test(observed.definition)) {
      throw new Error(
        `${expected.name} definition does not match ${String(pattern)}: ${observed.definition}`,
      );
    }
  }
}

/** Install/repair one index outside a transaction using PostgreSQL online DDL. */
export async function installOnlinePerformanceIndex(
  client: PgSession,
  definition: OnlinePerformanceIndexDefinition,
): Promise<'present' | 'created' | 'repaired'> {
  assertSafeIdentifier(definition.name);
  let existing = await readIndexCatalog(client, definition.name);
  if (existing && existing.is_valid && existing.is_ready) {
    assertOnlinePerformanceIndexDefinition(definition, existing);
    return 'present';
  }
  const repairing = existing !== undefined;
  if (existing) {
    if (existing.table_name !== definition.tableName) {
      throw new Error(`${definition.name} belongs to unexpected table ${existing.table_name}`);
    }
    // A failed CREATE INDEX CONCURRENTLY leaves an invalid catalog entry. It is
    // never planner-usable; remove exactly this manifest-owned index before retry.
    await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${quoteIdentifier(definition.name)}`);
  }
  await client.query(definition.createConcurrentlySql);
  existing = await readIndexCatalog(client, definition.name);
  if (!existing) throw new Error(`${definition.name} was not created`);
  assertOnlinePerformanceIndexDefinition(definition, existing);
  return repairing ? 'repaired' : 'created';
}

/**
 * Kysely wraps a migration in one transaction, so CONCURRENTLY is impossible.
 * Empty/small installs may use ordinary DDL; a non-trivial table fails before
 * acquiring the write-blocking index-build lock and points at the online CLI.
 */
export async function ensureTransactionalPerformanceIndex(
  db: Kysely<unknown>,
  definition: OnlinePerformanceIndexDefinition,
): Promise<void> {
  const existing = await readKyselyIndexCatalog(db, definition.name);
  if (existing) {
    assertOnlinePerformanceIndexDefinition(definition, existing);
    return;
  }
  const size = await sql<{ bytes: string }>`
    SELECT pg_total_relation_size(c.oid)::text AS bytes
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND c.relname = ${definition.tableName}
  `.execute(db);
  const bytes = BigInt(size.rows[0]?.bytes ?? '0');
  if (bytes > MAX_TRANSACTIONAL_INDEX_TABLE_BYTES) {
    throw new Error(
      `${definition.name} requires an online build for ${bytes} bytes; run `
      + `npm run db:indexes:online -- --only=${definition.name} before db:migrate`,
    );
  }
  const transactional = definition.createConcurrentlySql.replace(
    /^CREATE (UNIQUE )?INDEX CONCURRENTLY/iu,
    (_match, unique: string | undefined) => `CREATE ${unique ?? ''}INDEX`,
  );
  await sql.raw(transactional).execute(db);
  const created = await readKyselyIndexCatalog(db, definition.name);
  if (!created) throw new Error(`${definition.name} was not created transactionally`);
  assertOnlinePerformanceIndexDefinition(definition, created);
}

async function readIndexCatalog(
  client: PgSession,
  indexName: string,
): Promise<IndexCatalogRow | undefined> {
  const result = await client.query<IndexCatalogRow>(`
    SELECT index_relation.relname AS index_name,
           table_relation.relname AS table_name,
           catalog.indisvalid AS is_valid,
           catalog.indisready AS is_ready,
           pg_get_indexdef(index_relation.oid) AS definition
      FROM pg_index catalog
      JOIN pg_class index_relation ON index_relation.oid = catalog.indexrelid
      JOIN pg_class table_relation ON table_relation.oid = catalog.indrelid
      JOIN pg_namespace namespace ON namespace.oid = index_relation.relnamespace
     WHERE namespace.nspname = current_schema()
       AND index_relation.relname = $1
  `, [indexName]);
  return result.rows[0];
}

async function readKyselyIndexCatalog(
  db: Kysely<unknown>,
  indexName: string,
): Promise<IndexCatalogRow | undefined> {
  const result = await sql<IndexCatalogRow>`
    SELECT index_relation.relname AS index_name,
           table_relation.relname AS table_name,
           catalog.indisvalid AS is_valid,
           catalog.indisready AS is_ready,
           pg_get_indexdef(index_relation.oid) AS definition
      FROM pg_index catalog
      JOIN pg_class index_relation ON index_relation.oid = catalog.indexrelid
      JOIN pg_class table_relation ON table_relation.oid = catalog.indrelid
      JOIN pg_namespace namespace ON namespace.oid = index_relation.relnamespace
     WHERE namespace.nspname = current_schema()
       AND index_relation.relname = ${indexName}
  `.execute(db);
  return result.rows[0];
}

function assertSafeIdentifier(value: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value)) throw new Error(`unsafe index identifier: ${value}`);
}

function quoteIdentifier(value: string): string {
  assertSafeIdentifier(value);
  return `"${value}"`;
}
