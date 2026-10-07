import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import {
  createPostgresResourceIdLedgerPort,
  type ResourceIdLedgerPort,
} from '../database/resource-id-ledger.js';
const REPORTS_SOURCE_INVALIDATED_EVENT_TYPE = 'reports.source.invalidated@1' as const;
const REPORTS_SOURCE_INVALIDATION_HANDLER_NAME = 'reports_source_invalidation' as const;
const REPORTS_SOURCE_INVALIDATED_EVENT_VERSION = 1 as const;

export interface ReportSourceInvalidationInput {
  readonly domainEventId: string;
  readonly collectionId: string;
  readonly sourceEventType: string;
  readonly sourceEventVersion: number;
  readonly contentRevision: string;
  readonly policyRevision: string;
  readonly commitOrdinal: bigint;
}

/** Infrastructure-only dual-append seam; callers remain independent of Reports. */
export interface ReportSourceInvalidationOutboxPort {
  append(transaction: DatabaseTransaction, input: ReportSourceInvalidationInput): Promise<void>;
  /** Invalidate report-owned public keys when the report owner is disabled/deleted. */
  appendSeries?(transaction: DatabaseTransaction, input: ReportSeriesInvalidationInput): Promise<void>;
}

export interface ReportSeriesInvalidationInput {
  readonly domainEventId: string;
  readonly seriesId: string;
  readonly slug: string;
  readonly revision: string;
  readonly commitOrdinal: bigint;
}

interface ReportSourceEventLike {
  readonly domainEventId: string;
  readonly collectionId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly commitOrdinal: bigint;
  readonly payload: unknown;
  readonly aggregateRevision?: string;
}

// Existing lifecycle seams use deterministic namespaced ids such as
// `identity:account-deleted:<account>:<collection>`; retain the colon while
// rejecting control characters and unbounded input.
const SAFE_ID = /^[A-Za-z0-9._~:-]{1,256}$/u;
const SAFE_REVISION = /^[A-Za-z0-9._~-]{1,128}$/u;

// Bootstrap collections may legitimately still have commit_ordinal=0 before
// their first canonical mutation.  outbox_events requires a positive ordinal
// for projection routes, so use the first valid ordinal as the deterministic
// floor while retaining the source revision as the authority fence.
function outboxCommitOrdinal(value: bigint): bigint {
  return value > 0n ? value : 1n;
}

function sourcePayload(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('source event payload must be a JSON object');
  }
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error('source event payload must be a plain object');
    }
    const keys = Object.keys(value);
    if (keys.length > 64 || keys.some((key) => key.length > 128 || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(key))) {
      throw new Error('source event payload is too large');
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > 16_384) {
      throw new Error('source event payload is too large');
    }
  } catch (error) {
    if (error instanceof Error && /^source event payload/u.test(error.message)) throw error;
    throw new Error('source event payload must be bounded JSON', { cause: error });
  }
  return value as Record<string, unknown>;
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

function safeRevision(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_REVISION.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

function safeEventType(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512
    || value.trim() !== value || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)) {
    throw new Error('invalid source event type');
  }
  return value;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

/** Map canonical mutation envelopes into the single report fan-out contract. */
export async function appendReportSourceInvalidation(
  port: ReportSourceInvalidationOutboxPort | undefined,
  transaction: DatabaseTransaction,
  source: ReportSourceEventLike,
  routed: Pick<ReportSourceEventLike, 'eventType' | 'eventVersion' | 'payload' | 'aggregateRevision'> = source,
): Promise<void> {
  if (!port) return;
  safeId(source.domainEventId, 'domain event id');
  safeId(source.collectionId, 'collection id');
  if (!Number.isSafeInteger(source.eventVersion) || source.eventVersion < 1) {
    throw new Error('invalid source event version');
  }
  if (typeof source.commitOrdinal !== 'bigint' || source.commitOrdinal < 0n) {
    throw new Error('invalid source commit ordinal');
  }
  const sourceEventType = safeEventType(routed.eventType);
  if (!Number.isSafeInteger(routed.eventVersion) || routed.eventVersion < 1) {
    throw new Error('invalid routed source event version');
  }
  const payload = sourcePayload(routed.payload);
  const fallback = routed.aggregateRevision === undefined
    ? source.commitOrdinal.toString()
    : safeRevision(routed.aggregateRevision, 'source aggregate revision');
  const contentRevision = payload.contentRevision === undefined
    ? fallback : safeRevision(payload.contentRevision, 'source content revision');
  const policyRevision = payload.policyRevision === undefined
    ? fallback : safeRevision(payload.policyRevision, 'source policy revision');
  await port.append(transaction, {
    domainEventId: source.domainEventId,
    collectionId: source.collectionId,
    sourceEventType,
    sourceEventVersion: routed.eventVersion,
    contentRevision,
    policyRevision,
    commitOrdinal: source.commitOrdinal,
  });
}

export function createPostgresReportSourceInvalidationOutboxPort(options: {
  readonly outboxIdGenerator?: () => string;
  /** A test/composition seam; production should prefer the transaction factory. */
  readonly ledger?: ResourceIdLedgerPort;
  /** Optional transaction-bound ledger seam for integration tests/composition. */
  readonly ledgerFactory?: (transaction: DatabaseTransaction) => ResourceIdLedgerPort;
} = {}): ReportSourceInvalidationOutboxPort {
  return {
    async append(transaction, input) {
      safeId(input.domainEventId, 'domain event id');
      safeId(input.collectionId, 'collection id');
      safeEventType(input.sourceEventType);
      if (!Number.isSafeInteger(input.sourceEventVersion) || input.sourceEventVersion < 1) {
        throw new Error('invalid source event version');
      }
      safeRevision(input.contentRevision, 'source content revision');
      safeRevision(input.policyRevision, 'source policy revision');
      if (typeof input.commitOrdinal !== 'bigint' || input.commitOrdinal < 0n) {
        throw new Error('invalid source commit ordinal');
      }
      const outboxId = (options.outboxIdGenerator ?? (() => createHash('sha256').update(`reports-source-invalidation:${input.domainEventId}`, 'utf8').digest('base64url').slice(0, 43)))();
      safeId(outboxId, 'source invalidation outbox id');
      const ledger = options.ledgerFactory?.(transaction) ?? options.ledger ?? createPostgresResourceIdLedgerPort(transaction);
      await ledger.reserve([
        { resourceId: outboxId, resourceType: 'outbox' },
        // Policy/account/seed writers may supply a synthetic domain event id.
        // It still belongs in the global ledger so the outbox FK is provable.
        { resourceId: input.domainEventId, resourceType: 'domain-event' },
      ]);
      const payload = {
        collectionId: input.collectionId,
        contentRevision: input.contentRevision,
        policyRevision: input.policyRevision,
        sourceEventType: input.sourceEventType,
        sourceEventVersion: input.sourceEventVersion,
      };
      const existing = await transaction.selectFrom('outbox_events')
        .select([
          'domain_event_id', 'event_type', 'event_version', 'handler_name', 'handler_mode',
          'aggregate_type', 'aggregate_id', 'aggregate_scope', 'aggregate_revision',
          'commit_ordinal', 'payload_json',
        ])
        .where('outbox_id','=',outboxId).executeTakeFirst();
      if (existing) {
        if (existing.domain_event_id !== input.domainEventId
          || existing.event_type !== REPORTS_SOURCE_INVALIDATED_EVENT_TYPE
          || existing.event_version !== REPORTS_SOURCE_INVALIDATED_EVENT_VERSION
          || existing.handler_name !== REPORTS_SOURCE_INVALIDATION_HANDLER_NAME
          || existing.handler_mode !== 'projection_latest_only'
          || existing.aggregate_type !== 'collection'
          || existing.aggregate_id !== input.collectionId
          || existing.aggregate_scope !== input.collectionId
          || existing.aggregate_revision !== input.policyRevision
          || BigInt(existing.commit_ordinal ?? 0) !== outboxCommitOrdinal(input.commitOrdinal)
          || stableJson(existing.payload_json) !== stableJson(payload)) {
          throw new Error('report source invalidation outbox id collision');
        }
        return;
      }
      // The cursor is created in the same source mutation transaction as the
      // new outbox row.  Check idempotence first so a replay after a completed
      // fan-out cannot resurrect an orphan progress row.
      await sql`INSERT INTO digest_source_invalidation_progress
        (domain_event_id, collection_id, after_slug)
        VALUES (${input.domainEventId}, ${input.collectionId}, NULL)
        ON CONFLICT (domain_event_id) DO NOTHING`.execute(transaction);
      await transaction.insertInto('outbox_events').values({
        outbox_id: outboxId,
        domain_event_id: input.domainEventId,
        event_type: REPORTS_SOURCE_INVALIDATED_EVENT_TYPE,
        event_version: REPORTS_SOURCE_INVALIDATED_EVENT_VERSION,
        handler_name: REPORTS_SOURCE_INVALIDATION_HANDLER_NAME,
        handler_mode: 'projection_latest_only',
        aggregate_type: 'collection',
        aggregate_id: input.collectionId,
        aggregate_scope: input.collectionId,
        aggregate_revision: input.policyRevision,
        commit_ordinal: outboxCommitOrdinal(input.commitOrdinal),
        payload_json: payload,
        state: 'pending', attempt_count: 0, available_at: sql<Date>`current_timestamp`,
        locked_until: null, lease_generation: 0n, completed_at: null, last_error: null,
        occurred_at: sql<Date>`current_timestamp`, dead_lettered_at: null,
      }).execute();
    },
    async appendSeries(transaction, input) {
      if (typeof input.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(input.slug) || input.slug.length > 63) {
        throw new Error('invalid report series slug for lifecycle invalidation');
      }
      if (!/^[A-Za-z0-9._~-]{1,128}$/u.test(input.seriesId)
        || !/^[A-Za-z0-9._~-]{1,128}$/u.test(input.revision)
        || typeof input.domainEventId !== 'string' || !/^[^\u0000-\u001f\u007f]{1,256}$/u.test(input.domainEventId)
        || typeof input.commitOrdinal !== 'bigint' || input.commitOrdinal < 0n) {
        throw new Error('invalid report series lifecycle invalidation');
      }
      const outboxId = (options.outboxIdGenerator ?? (() => createHash('sha256')
        .update(`reports-series-invalidation:${input.domainEventId}`, 'utf8')
        .digest('base64url').slice(0, 43)))();
      const ledger = options.ledgerFactory?.(transaction) ?? options.ledger
        ?? createPostgresResourceIdLedgerPort(transaction);
      if (!/^[A-Za-z0-9._~-]{1,128}$/u.test(outboxId)) {
        throw new Error('invalid report series lifecycle outbox id');
      }
      await ledger.reserve([
        { resourceId: outboxId, resourceType: 'outbox' },
        { resourceId: input.domainEventId, resourceType: 'domain-event' },
      ]);
      const payload = {
        seriesId: input.seriesId,
        slug: input.slug,
        revision: input.revision,
        surfaces: ['html', 'json', 'sitemap', 'og'],
      } as const;
      const existing = await transaction.selectFrom('outbox_events')
        .select([
          'domain_event_id', 'event_type', 'event_version', 'handler_name', 'handler_mode',
          'aggregate_type', 'aggregate_id', 'aggregate_scope', 'aggregate_revision',
          'commit_ordinal', 'payload_json',
        ])
        .where('outbox_id', '=', outboxId)
        .executeTakeFirst();
      if (existing) {
        if (existing.domain_event_id !== input.domainEventId
          || existing.event_type !== 'reports.public_surface_purge.requested@1'
          || existing.event_version !== 1
          || existing.handler_name !== 'reports_public_surface_purge'
          || existing.handler_mode !== 'delivery_each_event'
          || existing.aggregate_type !== 'digest_series'
          || existing.aggregate_id !== input.seriesId
          || existing.aggregate_scope !== input.seriesId
          || existing.aggregate_revision !== input.revision
          || BigInt(existing.commit_ordinal ?? 0) !== outboxCommitOrdinal(input.commitOrdinal)
          || stableJson(existing.payload_json) !== stableJson(payload)) {
          throw new Error('report series lifecycle outbox id collision');
        }
        return;
      }
      await transaction.insertInto('outbox_events').values({
        outbox_id: outboxId,
        domain_event_id: input.domainEventId,
        event_type: 'reports.public_surface_purge.requested@1',
        event_version: 1,
        handler_name: 'reports_public_surface_purge',
        handler_mode: 'delivery_each_event',
        aggregate_type: 'digest_series',
        aggregate_id: input.seriesId,
        aggregate_scope: input.seriesId,
        aggregate_revision: input.revision,
        commit_ordinal: outboxCommitOrdinal(input.commitOrdinal),
        payload_json: payload,
        state: 'pending', attempt_count: 0,
        available_at: sql<Date>`current_timestamp`, locked_until: null,
        lease_generation: 0n, completed_at: null, last_error: null,
        occurred_at: sql<Date>`current_timestamp`, dead_lettered_at: null,
      }).execute();
    },
  };
}
