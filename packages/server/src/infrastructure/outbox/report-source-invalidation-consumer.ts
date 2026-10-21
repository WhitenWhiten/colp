import { sql, type Kysely } from 'kysely';

import type { DatabaseSchema } from '../database/runtime.js';
import { REPORT_CACHE_SOURCE_BATCH_LIMIT, RedisReportCacheInvalidator } from './redis-report-invalidator.js';
import {
  OutboxContinuationRequested,
  OutboxDeliveryError,
  type OutboxHandlerContext,
  type OutboxRoute,
} from './router.js';

const SOURCE_EVENT = 'reports.source.invalidated@1';
const SERIES_EVENT = 'reports.public_surface_purge.requested@1';

export interface ReportInvalidationCursorStore {
  readAfterSlug(domainEventId: string): Promise<string | null>;
  writeAfterSlug(domainEventId: string, afterSlug: string): Promise<void>;
  listSourceSlugs(input: {
    readonly collectionId: string;
    readonly afterSlug: string | null;
    readonly limit: number;
  }): Promise<readonly string[]>;
}

export function createPostgresReportInvalidationCursorStore(
  db: Kysely<DatabaseSchema>,
): ReportInvalidationCursorStore {
  return {
    async readAfterSlug(domainEventId) {
      const row = await db.selectFrom('digest_source_invalidation_progress')
        .select('after_slug')
        .where('domain_event_id', '=', domainEventId)
        .executeTakeFirst();
      return row?.after_slug ?? null;
    },
    async writeAfterSlug(domainEventId, afterSlug) {
      await db.updateTable('digest_source_invalidation_progress')
        .set({ after_slug: afterSlug, updated_at: new Date() })
        .where('domain_event_id', '=', domainEventId)
        .execute();
    },
    async listSourceSlugs(input) {
      const rows = await sql<{ slug: string }>`
        SELECT series.slug AS slug
        FROM digest_series series
        WHERE series.deleted_at IS NULL
          AND series.slug IS NOT NULL
          AND (${input.afterSlug}::text IS NULL OR series.slug > ${input.afterSlug})
          AND EXISTS (
            SELECT 1 FROM digest_editions edition
            WHERE edition.series_id = series.id
              AND edition.source_collection_id = ${input.collectionId}
          )
        ORDER BY series.slug
        LIMIT ${input.limit}
      `.execute(db);
      return rows.rows.map((row) => row.slug);
    },
  };
}

export async function deliverReportSourceInvalidation(input: {
  readonly store: ReportInvalidationCursorStore;
  readonly invalidator: Pick<RedisReportCacheInvalidator, 'rotateSource'>;
  readonly domainEventId: string;
  readonly collectionId: string;
  readonly signal: AbortSignal;
  readonly limit?: number;
}): Promise<void> {
  const limit = input.limit ?? REPORT_CACHE_SOURCE_BATCH_LIMIT;
  const afterSlug = await input.store.readAfterSlug(input.domainEventId);
  const slugs = await input.store.listSourceSlugs({
    collectionId: input.collectionId,
    afterSlug,
    limit,
  });
  await input.invalidator.rotateSource(input.signal, slugs);
  if (slugs.length === limit) {
    const cursor = slugs[slugs.length - 1];
    if (cursor === undefined) {
      throw new OutboxDeliveryError('permanent', 'report source invalidation page is empty at the batch limit');
    }
    await input.store.writeAfterSlug(input.domainEventId, cursor);
    throw new OutboxContinuationRequested('report source invalidation has another slug page');
  }
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new OutboxDeliveryError('permanent', 'report invalidation payload must be an object');
  }
  return payload as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new OutboxDeliveryError('permanent', `report invalidation payload ${key} is invalid`);
  }
  return value;
}

export function createReportCacheInvalidationRoutes(input: {
  readonly invalidator: RedisReportCacheInvalidator;
  readonly store: ReportInvalidationCursorStore;
}): readonly OutboxRoute[] {
  return Object.freeze([
    {
      handlerName: 'reports_source_invalidation',
      handlerMode: 'projection_latest_only',
      eventType: SOURCE_EVENT,
      eventVersion: 1,
      sideEffectDurability: 'durable',
      routeClass: 'report_public_surface_purge',
      async handle(context: OutboxHandlerContext): Promise<void> {
        const payload = payloadRecord(context.envelope.payload);
        await deliverReportSourceInvalidation({
          store: input.store,
          invalidator: input.invalidator,
          domainEventId: context.envelope.event_id,
          collectionId: requiredString(payload, 'collectionId'),
          signal: context.signal,
        });
      },
    },
    {
      handlerName: 'reports_public_surface_purge',
      handlerMode: 'delivery_each_event',
      eventType: SERIES_EVENT,
      eventVersion: 1,
      sideEffectDurability: 'durable',
      routeClass: 'report_public_surface_purge',
      async handle(context: OutboxHandlerContext): Promise<void> {
        const payload = payloadRecord(context.envelope.payload);
        await input.invalidator.rotateSeries(requiredString(payload, 'slug'), context.signal);
      },
    },
  ]);
}
