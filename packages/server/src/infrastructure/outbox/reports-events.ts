import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import {
  validateReportOutboxEvent,
  type ReportOutboxEvent,
} from '../../modules/reports/index.js';
import {
  defineClosedPayloadValidator,
  type ClosedPayload,
  type EventPayloadRegistration,
} from './envelope.js';
import {
  OutboxContinuationRequested,
  OutboxDeliveryError,
  OutboxRouter,
  type OutboxHandlerContext,
  type OutboxRoute,
} from './router.js';
import type { RedisReportCacheInvalidator } from './redis-report-invalidator.js';
import type { PublicSurfacePurgePort } from './reports-public-surface-purge.js';
import {
  createPostgresResourceIdLedgerPort,
  type ResourceIdLedgerPort,
} from '../database/resource-id-ledger.js';

export const REPORTS_SERIES_CHANGED_EVENT_TYPE = 'reports.series.changed@1' as const;
export const REPORTS_EDITION_CHANGED_EVENT_TYPE = 'reports.edition.changed@1' as const;
export const REPORTS_SOURCE_INVALIDATED_EVENT_TYPE = 'reports.source.invalidated@1' as const;
export const REPORTS_PUBLIC_SURFACE_PURGE_EVENT_TYPE = 'reports.public_surface_purge.requested@1' as const;
export const REPORTS_PROJECTION_HANDLER_NAME = 'reports_projection' as const;
export const REPORTS_SOURCE_INVALIDATION_HANDLER_NAME = 'reports_source_invalidation' as const;
export const REPORTS_PUBLIC_SURFACE_PURGE_HANDLER_NAME = 'reports_public_surface_purge' as const;
export const REPORTS_SERIES_CHANGED_EVENT_VERSION = 1 as const;
export const REPORTS_EDITION_CHANGED_EVENT_VERSION = 1 as const;
export const REPORTS_SOURCE_INVALIDATED_EVENT_VERSION = 1 as const;
export const REPORTS_PUBLIC_SURFACE_PURGE_EVENT_VERSION = 1 as const;
export const REPORTS_SOURCE_INVALIDATION_PAGE_SIZE = 1_000 as const;
const REPORT_PUBLIC_PURGE_SURFACES = Object.freeze(['html', 'json', 'sitemap', 'og'] as const);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f\u2028\u2029]/u;
const nonEmpty = (value: unknown): value is string => (
  typeof value === 'string' && value.length > 0 && value.length <= 512
  && value.trim() === value && !CONTROL_CHARACTERS.test(value)
);
const revision = (value: unknown): value is string => (
  typeof value === 'string' && /^[A-Za-z0-9._~-]{1,128}$/u.test(value)
);
const positiveInt = (value: unknown): value is number => (
  typeof value === 'number' && Number.isInteger(value) && value > 0
);
const visibility = (value: unknown): boolean => (
  value === 'private' || value === 'protected' || value === 'unlisted' || value === 'public'
);
const surfaces = (value: unknown): boolean => (
  Array.isArray(value)
  && value.length > 0
  && value.length <= 4
  && value.every((item) => item === 'html' || item === 'json' || item === 'sitemap' || item === 'og')
  && new Set(value).size === value.length
);

function isPlainPayload(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try { return Object.getPrototypeOf(value) === Object.prototype; } catch { return false; }
}

function reportsPayloadValidator(
  fields: Readonly<Record<string, (value: unknown) => boolean>>,
): (payload: unknown) => payload is ClosedPayload {
  const validate = defineClosedPayloadValidator(fields);
  return (payload: unknown): payload is ClosedPayload => isPlainPayload(payload) && validate(payload);
}

function stablePayload(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stablePayload).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${stablePayload(record[key])}`).join(',')}}`;
}

function sameInstant(value: Date | string | null | undefined, expected: Date): boolean {
  const actual = value instanceof Date
    ? value
    : value === null || value === undefined ? null : new Date(value);
  return actual !== null && Number.isFinite(actual.getTime())
    && actual.getTime() === expected.getTime();
}

export const validateReportsSeriesChangedV1 = reportsPayloadValidator({
  contentRevision: revision,
  policyRevision: revision,
  resourceRevision: revision,
  seriesId: nonEmpty,
  state: (value) => value === 'active' || value === 'archived',
  visibility,
});
export const validateReportsEditionChangedV1 = reportsPayloadValidator({
  editionId: nonEmpty,
  resourceRevision: revision,
  seriesId: nonEmpty,
  state: (value) => value === 'draft' || value === 'published'
    || value === 'withdrawn' || value === 'detached',
});
export const validateReportsSourceInvalidatedV1 = reportsPayloadValidator({
  collectionId: nonEmpty,
  contentRevision: revision,
  policyRevision: revision,
  sourceEventType: nonEmpty,
  sourceEventVersion: positiveInt,
});
export const validateReportsPublicSurfacePurgeV1 = reportsPayloadValidator({
  revision,
  seriesId: nonEmpty,
  slug: (value) => typeof value === 'string'
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
    && value.length <= 63,
  surfaces,
});
export const reportsEnvelopeRegistrations: readonly EventPayloadRegistration[] = Object.freeze([
  { eventType: REPORTS_SERIES_CHANGED_EVENT_TYPE, eventVersion: 1,
    validatePayload: validateReportsSeriesChangedV1 },
  { eventType: REPORTS_EDITION_CHANGED_EVENT_TYPE, eventVersion: 1,
    validatePayload: validateReportsEditionChangedV1 },
  { eventType: REPORTS_SOURCE_INVALIDATED_EVENT_TYPE, eventVersion: 1,
    validatePayload: validateReportsSourceInvalidatedV1 },
  { eventType: REPORTS_PUBLIC_SURFACE_PURGE_EVENT_TYPE, eventVersion: 1,
    validatePayload: validateReportsPublicSurfacePurgeV1 },
]);
export const reportEnvelopeRegistrations = reportsEnvelopeRegistrations;
export interface ReportOutboxConsumer {
  readonly seriesChanged: (payload: unknown, context: OutboxHandlerContext) => Promise<void>;
  readonly editionChanged: (payload: unknown, context: OutboxHandlerContext) => Promise<void>;
  readonly sourceInvalidated: (payload: unknown, context: OutboxHandlerContext) => Promise<void>;
  readonly publicSurfacePurge: (payload: unknown, context: OutboxHandlerContext) => Promise<void>;
}

interface ReportSourceFanoutRow {
  readonly seriesId: string;
  readonly slug: string;
  readonly visibility: 'private' | 'protected' | 'unlisted' | 'public';
}

function sourcePurgeIdempotencyKey(eventId: string, seriesId: string): string {
  return createHash('sha256')
    .update(`reports-source-public-purge:${eventId}:${seriesId}`, 'utf8')
    .digest('base64url');
}

async function purgePublicSourcePage(
  provider: PublicSurfacePurgePort,
  rows: readonly ReportSourceFanoutRow[],
  payload: { readonly policyRevision: string },
  context: OutboxHandlerContext,
): Promise<void> {
  for (const row of rows) {
    if (row.visibility !== 'public' && row.visibility !== 'unlisted') continue;
    context.signal.throwIfAborted();
    try {
      await provider.purge({
        seriesId: row.seriesId,
        slug: row.slug,
        revision: payload.policyRevision,
        surfaces: REPORT_PUBLIC_PURGE_SURFACES,
        idempotencyKey: sourcePurgeIdempotencyKey(
          context.envelope?.event_id ?? context.idempotencyKey,
          row.seriesId,
        ),
      });
    } catch (error) {
      if (error instanceof OutboxDeliveryError) throw error;
      throw new OutboxDeliveryError('retryable', 'report source public purge failed', { cause: error });
    }
  }
}

async function deleteSourceProgress(
  pool: Pick<Pool, 'query'>,
  eventId: string,
  after: string | null,
  attempt: OutboxHandlerContext['attempt'],
): Promise<void> {
  const removed = await pool.query(
    `DELETE FROM digest_source_invalidation_progress
      WHERE domain_event_id = $1
        AND after_slug IS NOT DISTINCT FROM $2
        AND EXISTS (
          SELECT 1 FROM outbox_events
           WHERE outbox_id = $3 AND state = 'leased'
             AND lease_generation = $4 AND locked_until > current_timestamp
        )`, [eventId, after, attempt?.outboxId, attempt?.leaseGeneration]);
  if (removed.rowCount !== 1) {
    throw new OutboxDeliveryError('retryable', 'report source continuation fence was lost');
  }
}
export function createPostgresReportOutboxConsumer(pool: Pick<Pool, 'query'>, options: { readonly cacheInvalidator?: RedisReportCacheInvalidator; readonly publicSurfacePurge?: PublicSurfacePurgePort } = {}): ReportOutboxConsumer {
  return {
    async seriesChanged(payload, context) {
      const p = payload as { seriesId: string };
      const row = await pool.query<{ slug: string | null }>('SELECT slug FROM digest_series WHERE id = $1', [p.seriesId]);
      if (row.rowCount !== 1) throw new OutboxDeliveryError('retryable', 'report series authority is missing');
      if (options.cacheInvalidator && row.rows[0]?.slug) {
        await options.cacheInvalidator.rotateSeries(row.rows[0].slug, context.signal);
      }
    },
    async editionChanged(payload, context) {
      const p = payload as { editionId: string; seriesId: string };
      const row = await pool.query<{ slug: string | null }>(
        `SELECT s.slug FROM digest_editions e
           JOIN digest_series s ON s.id = e.series_id
          WHERE e.id = $1 AND e.series_id = $2`, [p.editionId, p.seriesId]);
      if (row.rowCount !== 1) throw new OutboxDeliveryError('retryable', 'report edition authority is missing');
      if (options.cacheInvalidator && row.rows[0]?.slug) {
        await options.cacheInvalidator.rotateSeries(row.rows[0].slug, context.signal);
      }
    },
    async sourceInvalidated(payload, context) {
      const p = payload as { collectionId: string };
      const cache = options.cacheInvalidator;
      const publicPurge = options.publicSurfacePurge;
      if (!cache && !publicPurge) {
        // A queued event can outlive a cache flag rollback. Remove its cursor
        // if present so disabling both providers does not leave orphan progress.
        try {
          await pool.query('DELETE FROM digest_source_invalidation_progress WHERE domain_event_id = $1', [context.envelope?.event_id ?? context.idempotencyKey]);
        } catch {
          // The cursor table may not exist on an N-1 worker; there is no cache
          // side effect to protect, so completion remains safe.
        }
        return;
      }
      // A source row may have been hard-deleted. Historical report editions
      // still identify every cache namespace that must be revoked, so absence
      // of the source is a successful invalidation rather than a poison row.
      const eventId = context.envelope?.event_id ?? context.idempotencyKey;
      const attempt = context.attempt;
      let after: string | null = null;
      let durableCursor = false;
      try {
        const cursor = await pool.query<{ collection_id: string; after_slug: string | null }>(
          `SELECT collection_id, after_slug FROM digest_source_invalidation_progress
             WHERE domain_event_id = $1`, [eventId]);
        // Legacy rows predating the cursor migration drain in-process; new
        // producer rows always have the typed after_slug column.
        if (cursor.rowCount === 1 && cursor.rows[0]
          && cursor.rows[0].collection_id === p.collectionId
          && Object.prototype.hasOwnProperty.call(cursor.rows[0], 'after_slug')) {
          durableCursor = true;
          after = cursor.rows[0].after_slug;
          if (!attempt) {
            throw new OutboxDeliveryError('retryable', 'report source continuation attempt fence is missing');
          }
        } else if (cursor.rowCount === 1) {
          throw new OutboxDeliveryError('permanent', 'report source continuation collection binding is invalid');
        }
      } catch (error) {
        if (error instanceof OutboxDeliveryError && error.failureKind === 'permanent') throw error;
        throw new OutboxDeliveryError('retryable', 'report source continuation store is unavailable', { cause: error });
      }
      for (;;) {
        context.signal.throwIfAborted();
        const previousAfter = after;
        const result: { readonly rows: readonly ReportSourceFanoutRow[] } = after === null
          ? await pool.query<ReportSourceFanoutRow>(
            `SELECT DISTINCT s.id AS "seriesId", s.slug, s.visibility
               FROM digest_series s
               JOIN digest_editions e ON e.series_id = s.id
              WHERE e.source_collection_id = $1 AND s.slug IS NOT NULL
              ORDER BY s.slug ASC LIMIT ${REPORTS_SOURCE_INVALIDATION_PAGE_SIZE}`, [p.collectionId])
          : await pool.query<ReportSourceFanoutRow>(
            `SELECT DISTINCT s.id AS "seriesId", s.slug, s.visibility
               FROM digest_series s
               JOIN digest_editions e ON e.series_id = s.id
              WHERE e.source_collection_id = $1 AND s.slug IS NOT NULL AND s.slug > $2
              ORDER BY s.slug ASC LIMIT ${REPORTS_SOURCE_INVALIDATION_PAGE_SIZE}`, [p.collectionId, after]);
        if (result.rows.length === 0) {
          if (durableCursor) {
            await deleteSourceProgress(pool, eventId, previousAfter, attempt);
          }
          break;
        }
        if (cache) {
          await cache.rotateSource(context.signal, result.rows.map((row) => row.slug));
        }
        if (publicPurge) {
          await purgePublicSourcePage(publicPurge, result.rows, {
            policyRevision: (payload as { readonly policyRevision: string }).policyRevision,
          }, context);
        }
        if (result.rows.length < REPORTS_SOURCE_INVALIDATION_PAGE_SIZE) {
          if (durableCursor) {
            await deleteSourceProgress(pool, eventId, previousAfter, attempt);
          }
          break;
        }
        const nextAfter = result.rows[result.rows.length - 1]?.slug ?? null;
        if (nextAfter === null) break;
        if (durableCursor) {
          const advanced = await pool.query(
            `UPDATE digest_source_invalidation_progress
                SET after_slug = $2, updated_at = current_timestamp
              WHERE domain_event_id = $1
                AND after_slug IS NOT DISTINCT FROM $3
                AND EXISTS (
                  SELECT 1 FROM outbox_events
                   WHERE outbox_id = $4 AND state = 'leased'
                     AND lease_generation = $5 AND locked_until > current_timestamp
                )`, [eventId, nextAfter, previousAfter, attempt?.outboxId, attempt?.leaseGeneration]);
          if (advanced.rowCount !== 1) throw new OutboxDeliveryError('retryable', 'report source continuation fence was lost');
          throw new OutboxContinuationRequested();
        }
        after = nextAfter;
      }
    },
    async publicSurfacePurge(payload, context) {
      const p = payload as { seriesId: string; slug: string; revision: string; surfaces: readonly ('html'|'json'|'sitemap'|'og')[] };
      // Purges must remain effective even after the series row is archived or
      // removed; the event carries the previously validated slug.
      if (options.cacheInvalidator) await options.cacheInvalidator.rotateSeries(p.slug, context.signal);
      if (options.publicSurfacePurge) await options.publicSurfacePurge.purge({ ...p, idempotencyKey: context.idempotencyKey });
    },
  };
}
function assertBinding(
  context: OutboxHandlerContext,
  aggregateType: string,
  aggregateId: string,
  aggregateScope: string | null,
): void {
  const identity = context.envelope.aggregate_identity;
  if (identity.aggregate_type !== aggregateType
    || identity.aggregate_id !== aggregateId
    || identity.aggregate_scope !== aggregateScope) {
    throw new OutboxDeliveryError('permanent', 'report outbox aggregate binding is invalid');
  }
}

type ReportRouteClass = 'projection' | 'report_public_surface_purge';
interface ReportRouteSpec {
  readonly handlerName: string;
  readonly handlerMode: 'projection_latest_only' | 'delivery_each_event';
  readonly eventType: string;
  readonly validate: (value: unknown) => boolean;
  readonly aggregateType: string;
  readonly dispatch: (payload: unknown, context: OutboxHandlerContext) => Promise<void>;
  readonly routeClass?: ReportRouteClass;
}

function aggregateId(payload: Record<string, unknown>): string {
  const value = payload.editionId ?? payload.seriesId ?? payload.collectionId;
  if (typeof value !== 'string' || value.length === 0) {
    throw new OutboxDeliveryError('permanent', 'report outbox aggregate id is invalid');
  }
  return value;
}

function aggregateScope(payload: Record<string, unknown>): string | null {
  const value = payload.collectionId ?? payload.seriesId;
  return value === undefined ? null : String(value);
}

function createReportOutboxRoute(input: ReportRouteSpec): OutboxRoute {
  return Object.freeze({
    handlerName: input.handlerName,
    handlerMode: input.handlerMode,
    eventType: input.eventType,
    eventVersion: 1,
    sideEffectDurability: 'durable' as const,
    routeClass: input.routeClass ?? 'projection',
    async handle(context: OutboxHandlerContext): Promise<void> {
      context.signal.throwIfAborted();
      if (!input.validate(context.envelope.payload)) {
        throw new OutboxDeliveryError('permanent', 'invalid report outbox payload');
      }
      const payload = context.envelope.payload as Record<string, unknown>;
      assertBinding(context, input.aggregateType, aggregateId(payload), aggregateScope(payload));
      const expectedRevision = payload.resourceRevision
        ?? payload.policyRevision
        ?? payload.revision;
      if (typeof expectedRevision === 'string'
        && context.envelope.aggregate_revision !== expectedRevision) {
        throw new OutboxDeliveryError('permanent', 'report outbox revision fence is invalid');
      }
      await input.dispatch(context.envelope.payload, context);
    },
  });
}

export function createReportsOutboxRoutes(consumer: ReportOutboxConsumer): readonly OutboxRoute[] {
  return Object.freeze([
    createReportOutboxRoute({
      handlerName: REPORTS_PROJECTION_HANDLER_NAME,
      handlerMode: 'projection_latest_only',
      eventType: REPORTS_SERIES_CHANGED_EVENT_TYPE,
      validate: validateReportsSeriesChangedV1,
      aggregateType: 'digest_series',
      dispatch: (payload, context) => consumer.seriesChanged(payload, context),
    }),
    createReportOutboxRoute({
      handlerName: REPORTS_PROJECTION_HANDLER_NAME,
      handlerMode: 'projection_latest_only',
      eventType: REPORTS_EDITION_CHANGED_EVENT_TYPE,
      validate: validateReportsEditionChangedV1,
      aggregateType: 'digest_edition',
      dispatch: (payload, context) => consumer.editionChanged(payload, context),
    }),
    createReportOutboxRoute({
      handlerName: REPORTS_SOURCE_INVALIDATION_HANDLER_NAME,
      handlerMode: 'projection_latest_only',
      eventType: REPORTS_SOURCE_INVALIDATED_EVENT_TYPE,
      validate: validateReportsSourceInvalidatedV1,
      aggregateType: 'collection',
      dispatch: (payload, context) => consumer.sourceInvalidated(payload, context),
    }),
    createReportOutboxRoute({
      handlerName: REPORTS_PUBLIC_SURFACE_PURGE_HANDLER_NAME,
      handlerMode: 'delivery_each_event',
      eventType: REPORTS_PUBLIC_SURFACE_PURGE_EVENT_TYPE,
      validate: validateReportsPublicSurfacePurgeV1,
      aggregateType: 'digest_series',
      dispatch: (payload, context) => consumer.publicSurfacePurge(payload, context),
      routeClass: 'report_public_surface_purge',
    }),
  ]);
}

export function createReportsOutboxRouter(
  consumer: ReportOutboxConsumer,
): import('./router.js').OutboxRouter {
  return new OutboxRouter(createReportsOutboxRoutes(consumer));
}

/** Append a report event atomically with the caller's transaction. */
export async function appendReportOutboxEvent(
  tx: DatabaseTransaction,
  event: ReportOutboxEvent,
  options: { readonly ledger?: ResourceIdLedgerPort } = {},
): Promise<void> {
  validateReportOutboxEvent(event);
  const ledger = options.ledger ?? createPostgresResourceIdLedgerPort(tx);
  await ledger.reserve([
    { resourceId: event.outboxId, resourceType: 'outbox' },
    { resourceId: event.eventId, resourceType: 'domain-event' },
  ]);
  const payload = event.payload as Record<string, unknown>;
  const aggregateType = event.eventType === REPORTS_SOURCE_INVALIDATED_EVENT_TYPE
    ? 'collection'
    : event.eventType.includes('.edition.') ? 'digest_edition' : 'digest_series';
  const aggregateId = String(payload.collectionId ?? payload.editionId ?? payload.seriesId);
  const ordinalTable = aggregateType === 'collection' ? 'collections'
    : aggregateType === 'digest_edition' ? 'digest_editions' : 'digest_series';
  const ordinalColumn = aggregateType === 'digest_edition' ? 'edition_ordinal' : 'commit_ordinal';
  const ordinalRow = await tx.selectFrom(ordinalTable as never)
    .select(ordinalColumn as never)
    .where('id' as never, '=', aggregateId as never)
    .executeTakeFirst() as Record<string, bigint> | undefined;
  const commitOrdinal = ordinalRow?.[ordinalColumn] ?? 1n;
  const existing = await tx.selectFrom('outbox_events')
    .select([
      'domain_event_id', 'event_type', 'event_version', 'handler_name', 'handler_mode',
      'aggregate_type', 'aggregate_id', 'aggregate_scope', 'aggregate_revision',
      'commit_ordinal', 'occurred_at', 'payload_json',
    ])
    .where('outbox_id', '=', event.outboxId)
    .executeTakeFirst();
  if (existing) {
    if (existing.domain_event_id !== event.eventId
      || existing.event_type !== event.eventType
      || existing.event_version !== event.eventVersion
      || existing.handler_name !== event.handlerName
      || existing.handler_mode !== event.handlerMode
      || existing.aggregate_type !== aggregateType
      || existing.aggregate_id !== aggregateId
      || existing.aggregate_scope !== ((payload.seriesId as string | undefined)
        ?? (payload.collectionId as string | undefined) ?? null)
      || existing.aggregate_revision !== ((payload.revision as string | undefined)
        ?? (payload.resourceRevision as string | undefined)
        ?? (payload.policyRevision as string | undefined) ?? null)
      || BigInt(existing.commit_ordinal ?? 0) !== (commitOrdinal > 0n ? commitOrdinal : 1n)
      || !sameInstant(existing.occurred_at, event.occurredAt)
      || stablePayload(existing.payload_json) !== stablePayload(payload)) {
      throw new Error('report outbox id collision');
    }
    return;
  }
  await tx.insertInto('outbox_events').values({
    outbox_id: event.outboxId,
    domain_event_id: event.eventId,
    event_type: event.eventType,
    event_version: event.eventVersion,
    handler_name: event.handlerName,
    handler_mode: event.handlerMode,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    aggregate_scope: (payload.seriesId as string | undefined)
      ?? (payload.collectionId as string | undefined) ?? null,
    aggregate_revision: (payload.revision as string | undefined)
      ?? (payload.resourceRevision as string | undefined)
      ?? (payload.policyRevision as string | undefined) ?? null,
    // The outbox schema requires a positive ordinal. A missing aggregate row
    // is an invariant violation in production, but keeping a positive floor
    // preserves deterministic test/replay behavior without inserting an
    // invalid row; the aggregate revision remains the authoritative fence.
    commit_ordinal: commitOrdinal > 0n ? commitOrdinal : 1n,
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
  if (event.eventType === REPORTS_SOURCE_INVALIDATED_EVENT_TYPE) {
    await sql`INSERT INTO digest_source_invalidation_progress
      (domain_event_id, collection_id, after_slug)
      VALUES (${event.eventId}, ${(payload.collectionId as string)}, NULL)
      ON CONFLICT (domain_event_id) DO NOTHING`.execute(tx);
  }
}

export const appendReportsSeriesChangedOutbox = appendReportOutboxEvent;
export const appendReportsEditionChangedOutbox = appendReportOutboxEvent;
export const appendReportsSourceInvalidatedOutbox = appendReportOutboxEvent;
export const appendReportsPublicSurfacePurgeOutbox = appendReportOutboxEvent;
