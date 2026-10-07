import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork, type DatabaseTransaction } from '../database/unit-of-work.js';
import {
  PUBLICATION_INSIGHT_PURGE_LIMIT,
  PUBLICATION_INSIGHT_RETENTION_DAYS,
  type PublicationInsightCollectionFacts,
  type PublicationInsightDailyIncrement,
  type PublicationInsightEventRecord,
  type PublicationInsightFactsPort,
  type PublicationInsightMaintenancePortFactory,
  type PublicationInsightPurgeCounts,
  type PublicationInsightStore,
  type PublishingInsightsDailyCount,
  type PublishingInsightsDashboardPort,
  type PublishingInsightsFunnelEventType,
  type PublishingInsightsTopResourceRow,
} from '../../modules/publication/index.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function createPostgresPublicationInsightFactsPort(
  transaction: DatabaseTransaction,
): PublicationInsightFactsPort {
  return Object.freeze({
    async loadBySlug(slug: string): Promise<PublicationInsightCollectionFacts | null> {
      const result = await sql<{
        id: string;
        owner_subject_id: string;
        visibility: PublicationInsightCollectionFacts['visibility'];
        publication_slug: string | null;
        deleted_at: Date | null;
      }>`
        SELECT id, owner_subject_id, visibility, publication_slug, deleted_at
          FROM collections
         WHERE publication_slug = ${slug}
         LIMIT 1
      `.execute(transaction);
      const row = result.rows[0];
      if (!row) return null;
      return Object.freeze({
        collectionId: row.id,
        ownerSubjectId: row.owner_subject_id,
        visibility: row.visibility,
        publicationSlug: row.publication_slug,
        deletedAt: row.deleted_at,
      });
    },
    async liveBookmarkExists(collectionId: string, nodeId: string): Promise<boolean> {
      const result = await sql<{ present: number }>`
        SELECT 1 AS present
          FROM nodes
         WHERE id = ${nodeId}
           AND collection_id = ${collectionId}
           AND kind = 'bookmark'
           AND deleted_at IS NULL
         LIMIT 1
      `.execute(transaction);
      return result.rows.length > 0;
    },
  });
}

export function createPostgresPublicationInsightStore(
  transaction: DatabaseTransaction,
): PublicationInsightStore {
  return Object.freeze({
    async insertEvent(event: PublicationInsightEventRecord): Promise<void> {
      await sql`
        INSERT INTO publication_insight_events (
          id, collection_id, event_type, node_id, visitor_hash, occurred_at
        ) VALUES (
          ${event.id},
          ${event.collectionId},
          ${event.eventType},
          ${event.nodeId},
          ${Buffer.from(event.visitorHash)},
          ${event.occurredAt}
        )
      `.execute(transaction);
    },
    async incrementDaily(input: PublicationInsightDailyIncrement): Promise<void> {
      const day = utcDay(input.occurredAt);
      const dailyNodeId = input.nodeId ?? '';
      await sql`
        INSERT INTO publication_insight_daily (collection_id, day, event_type, node_id, count)
        VALUES (${input.collectionId}, ${day}::date, ${input.eventType}, ${dailyNodeId}, 1)
        ON CONFLICT (collection_id, day, event_type, node_id) DO UPDATE SET count = publication_insight_daily.count + 1
      `.execute(transaction);
    },
    async purgeExpired(
      now: Date,
      limit = PUBLICATION_INSIGHT_PURGE_LIMIT,
    ): Promise<PublicationInsightPurgeCounts> {
      const batch = clampInsightPurgeLimit(limit);
      const cutoff = new Date(now.getTime() - PUBLICATION_INSIGHT_RETENTION_DAYS * MS_PER_DAY);
      const cutoffDay = utcDay(cutoff);
      const events = await sql<{ id: string }>`
        DELETE FROM publication_insight_events
         WHERE id IN (
           SELECT id FROM publication_insight_events
            WHERE occurred_at < ${cutoff}
            ORDER BY occurred_at ASC, id ASC
            LIMIT ${batch}
         )
        RETURNING id
      `.execute(transaction);
      const daily = await sql<{ collection_id: string }>`
        DELETE FROM publication_insight_daily
         WHERE (collection_id, day, event_type, node_id) IN (
           SELECT collection_id, day, event_type, node_id
             FROM publication_insight_daily
            WHERE day < ${cutoffDay}::date
            ORDER BY day ASC, collection_id ASC, event_type ASC, node_id ASC
            LIMIT ${batch}
         )
        RETURNING collection_id
      `.execute(transaction);
      return Object.freeze({
        events: events.rows.length,
        daily: daily.rows.length,
      });
    },
  });
}

/** Worker-owned UoW factory; ingest never composes this port. */
export function createPostgresPublicationInsightMaintenancePortFactory(
  db: Kysely<DatabaseSchema>,
): PublicationInsightMaintenancePortFactory {
  return async () => ({
    purgeExpired: (options = {}) => createUnitOfWork(db).execute(({ transaction }) => (
      createPostgresPublicationInsightStore(transaction).purgeExpired(
        options.now ?? new Date(),
        options.limit,
      )
    )),
  });
}

function clampInsightPurgeLimit(limit: number): number {
  if (!Number.isSafeInteger(limit)) return PUBLICATION_INSIGHT_PURGE_LIMIT;
  return Math.max(1, Math.min(limit, 10_000));
}

function utcDay(occurredAt: Date): string {
  return occurredAt.toISOString().slice(0, 10);
}

const OWNER_COLLECTION_PREDICATE = sql`
  c.deleted_at IS NULL
  AND c.visibility IN ('public', 'unlisted')
  AND c.publication_slug IS NOT NULL
  AND c.published_at IS NOT NULL
`;

export function createPostgresPublishingInsightsDashboardPort(
  db: Kysely<DatabaseSchema>,
): PublishingInsightsDashboardPort {
  return Object.freeze({
    async listDailyCounts(input: {
      readonly ownerSubjectId: string;
      readonly fromDayInclusive: string;
      readonly toDayExclusive: string;
      readonly eventTypes: readonly PublishingInsightsFunnelEventType[];
    }): Promise<readonly PublishingInsightsDailyCount[]> {
      if (input.eventTypes.length === 0) return [];
      const eventTypeList = sql.join(
        input.eventTypes.map((eventType) => sql`${eventType}`),
        sql`, `,
      );
      const result = await sql<{
        collection_id: string;
        day: string;
        event_type: PublishingInsightsDailyCount['eventType'];
        node_id: string;
        count: string | number | bigint;
      }>`
        SELECT d.collection_id, d.day::text AS day, d.event_type, d.node_id, d.count
          FROM publication_insight_daily d
          INNER JOIN collections c ON c.id = d.collection_id
         WHERE c.owner_subject_id = ${input.ownerSubjectId}
           AND ${OWNER_COLLECTION_PREDICATE}
           AND d.day >= ${input.fromDayInclusive}::date
           AND d.day < ${input.toDayExclusive}::date
           AND d.event_type IN (${eventTypeList})
      `.execute(db);
      return result.rows.map((row) => Object.freeze({
        collectionId: row.collection_id,
        day: row.day.slice(0, 10),
        eventType: row.event_type,
        nodeId: row.node_id,
        count: Number(row.count),
      }));
    },
    async listTopResourceOpens(input: {
      readonly ownerSubjectId: string;
      readonly fromDayInclusive: string;
      readonly toDayExclusive: string;
      readonly limit: number;
    }): Promise<readonly PublishingInsightsTopResourceRow[]> {
      const result = await sql<{
        node_id: string;
        collection_id: string;
        title: string | null;
        opens: string | number | bigint;
      }>`
        SELECT d.node_id, d.collection_id, coalesce(n.title, '') AS title, sum(d.count) AS opens
          FROM publication_insight_daily d
          INNER JOIN collections c ON c.id = d.collection_id
          INNER JOIN nodes n ON n.id = d.node_id AND n.collection_id = d.collection_id
         WHERE c.owner_subject_id = ${input.ownerSubjectId}
           AND ${OWNER_COLLECTION_PREDICATE}
           AND d.event_type = 'resource_open'
           AND d.node_id <> ''
           AND d.day >= ${input.fromDayInclusive}::date
           AND d.day < ${input.toDayExclusive}::date
           AND n.kind = 'bookmark'
           AND n.deleted_at IS NULL
         GROUP BY d.node_id, d.collection_id, n.title
         ORDER BY sum(d.count) DESC, d.node_id ASC
         LIMIT ${input.limit}
      `.execute(db);
      return result.rows.map((row) => Object.freeze({
        nodeId: row.node_id,
        collectionId: row.collection_id,
        title: row.title ?? '',
        opens: Number(row.opens),
      }));
    },
  });
}
