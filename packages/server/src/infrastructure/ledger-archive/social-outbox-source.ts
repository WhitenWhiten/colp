import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';

import type { DatabaseSchema } from '../database/runtime.js';
import type { LedgerArchiveSource } from './source.js';

export const SOCIAL_OUTBOX_ARCHIVE_FAMILY = 'outbox_social';
export const SOCIAL_OUTBOX_ARCHIVE_RELATION = 'public.outbox_events';
export const SOCIAL_OUTBOX_HANDLER = 'social.publish-collection-change';
export const SOCIAL_OUTBOX_EVENT_TYPE = 'social.collection-change';

export class SocialOutboxArchiveSourceError extends Error {
  constructor(readonly stableCode: string, message: string) {
    super(message);
    this.name = 'SocialOutboxArchiveSourceError';
  }
}

interface FloorRow {
  floor_commit_ordinal: string | bigint;
  floor_domain_event_id: string | null;
}

interface PhysicalRow {
  outbox_id: string;
  domain_event_id: string;
  event_type: string;
  event_version: number;
  handler_name: string;
  handler_mode: string;
  aggregate_scope: string | null;
  aggregate_revision: string | null;
  commit_ordinal: string | bigint | null;
  canonical_payload_json: string;
  canonical_event_envelope_json: string;
  state: string;
  attempt_count: number;
  available_at: Date;
  locked_until: Date | null;
  lease_generation: string | bigint;
  completed_at: Date | null;
  last_error: string | null;
  aggregate_type: string;
  aggregate_id: string;
  occurred_at: Date;
  dead_lettered_at: Date | null;
}

export interface SocialOutboxArchiveEvent {
  readonly outboxId: string;
  readonly domainEventId: string;
  readonly eventType: typeof SOCIAL_OUTBOX_EVENT_TYPE;
  readonly eventVersion: number;
  readonly handlerName: typeof SOCIAL_OUTBOX_HANDLER;
  readonly handlerMode: string;
  readonly aggregateScope: string;
  readonly aggregateRevision: string | null;
  readonly commitOrdinal: bigint;
  readonly canonicalPayloadJson: string;
  readonly payloadDigest: string;
  readonly payloadBytes: bigint;
  readonly canonicalEventEnvelopeJson: string;
  readonly envelopeDigest: string;
  readonly envelopeBytes: bigint;
  readonly state: 'completed';
  readonly attemptCount: number;
  readonly availableAt: string;
  readonly lockedUntil: string | null;
  readonly leaseGeneration: bigint;
  readonly completedAt: string;
  readonly lastError: string | null;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly occurredAt: string;
  readonly deadLetteredAt: string | null;
}

export interface SocialOutboxArchiveOrdinalRow {
  readonly aggregateScope: string;
  readonly commitOrdinal: bigint;
  readonly events: readonly SocialOutboxArchiveEvent[];
}

/**
 * One archive row represents one dense aggregate commit ordinal. Multiple
 * physical Outbox deliveries at that ordinal remain ordered and lossless.
 */
export async function createPostgresSocialOutboxLedgerArchiveSource(
  database: Kysely<DatabaseSchema>,
  sourceScope: string,
): Promise<LedgerArchiveSource<SocialOutboxArchiveOrdinalRow>> {
  assertScope(sourceScope);
  const floorResult = await sql<FloorRow>`
    SELECT floor_commit_ordinal, floor_domain_event_id
      FROM outbox_retention_floors
     WHERE handler_name = ${SOCIAL_OUTBOX_HANDLER}
       AND event_type = ${SOCIAL_OUTBOX_EVENT_TYPE}
       AND aggregate_scope = ${sourceScope}
  `.execute(database);
  const floor = floorResult.rows[0];
  if (!floor || BigInt(floor.floor_commit_ordinal) < 1n || floor.floor_domain_event_id === null) {
    throw sourceError('archive_source_outbox_scope_not_ready',
      'Social Outbox aggregate scope has no advanced retention floor.');
  }
  const floorOrdinal = BigInt(floor.floor_commit_ordinal);
  const floorDomainEventId = floor.floor_domain_event_id;

  return Object.freeze({
    ledgerFamily: SOCIAL_OUTBOX_ARCHIVE_FAMILY,
    sourceRelation: SOCIAL_OUTBOX_ARCHIVE_RELATION,
    sourceScope,
    keyOf: (row: SocialOutboxArchiveOrdinalRow) => row.commitOrdinal,
    archiveValue: outboxArchiveValue,
    async readPage(input: Parameters<LedgerArchiveSource<SocialOutboxArchiveOrdinalRow>['readPage']>[0]) {
      assertPage(input.limit, input.bounds.lowerInclusive, input.bounds.upperExclusive, floorOrdinal);
      input.signal?.throwIfAborted();
      const after = input.afterExclusive ?? 0n;
      const result = await sql<PhysicalRow>`
        WITH selected_ordinals AS (
          SELECT DISTINCT source.commit_ordinal
            FROM outbox_events source
           WHERE source.handler_name = ${SOCIAL_OUTBOX_HANDLER}
             AND source.event_type = ${SOCIAL_OUTBOX_EVENT_TYPE}
             AND source.aggregate_scope = ${sourceScope}
             AND source.commit_ordinal > ${after}
             AND source.commit_ordinal < ${input.bounds.upperExclusive}
           ORDER BY source.commit_ordinal
           LIMIT ${input.limit + 1}
        )
        SELECT source.outbox_id, source.domain_event_id, source.event_type,
               source.event_version, source.handler_name, source.handler_mode,
               source.aggregate_scope, source.aggregate_revision, source.commit_ordinal,
               source.payload_json::text AS canonical_payload_json,
               jsonb_build_object(
                 'event_id', source.domain_event_id,
                 'event_type', source.event_type,
                 'event_version', source.event_version,
                 'aggregate_identity', jsonb_build_object(
                   'aggregate_type', source.aggregate_type,
                   'aggregate_id', source.aggregate_id,
                   'aggregate_scope', source.aggregate_scope),
                 'aggregate_revision', source.aggregate_revision,
                 'commit_ordinal', source.commit_ordinal::text,
                 'occurred_at', source.occurred_at,
                 'payload', source.payload_json
               )::text AS canonical_event_envelope_json,
               source.state, source.attempt_count, source.available_at,
               source.locked_until, source.lease_generation, source.completed_at,
               source.last_error, source.aggregate_type, source.aggregate_id,
               source.occurred_at, source.dead_lettered_at
          FROM outbox_events source
          JOIN selected_ordinals selected USING (commit_ordinal)
         WHERE source.handler_name = ${SOCIAL_OUTBOX_HANDLER}
           AND source.event_type = ${SOCIAL_OUTBOX_EVENT_TYPE}
           AND source.aggregate_scope = ${sourceScope}
         ORDER BY source.commit_ordinal,
                  source.domain_event_id COLLATE "C", source.outbox_id COLLATE "C"
      `.execute(database);
      input.signal?.throwIfAborted();
      const groups = groupRows(result.rows, sourceScope);
      assertDense(groups, input.afterExclusive, floorOrdinal, input.limit, floorDomainEventId);
      return Object.freeze({
        rows: Object.freeze(groups.slice(0, input.limit)),
        hasMore: groups.length > input.limit,
      });
    },
  });
}

function groupRows(
  rows: readonly PhysicalRow[],
  sourceScope: string,
): SocialOutboxArchiveOrdinalRow[] {
  const groups: SocialOutboxArchiveOrdinalRow[] = [];
  let currentOrdinal: bigint | undefined;
  let events: SocialOutboxArchiveEvent[] = [];
  const flush = () => {
    if (currentOrdinal !== undefined) groups.push(Object.freeze({
      aggregateScope: sourceScope, commitOrdinal: currentOrdinal,
      events: Object.freeze(events),
    }));
  };
  for (const row of rows) {
    const ordinal = row.commit_ordinal === null ? null : BigInt(row.commit_ordinal);
    if (ordinal === null || row.aggregate_scope !== sourceScope
        || row.handler_name !== SOCIAL_OUTBOX_HANDLER || row.event_type !== SOCIAL_OUTBOX_EVENT_TYPE
        || row.state !== 'completed' || row.completed_at === null) {
      throw sourceError('archive_source_outbox_unresolved',
        'Social Outbox archive range contains an unresolved or incorrectly bound event.');
    }
    if (currentOrdinal !== ordinal) {
      flush();
      currentOrdinal = ordinal;
      events = [];
    }
    events.push(parseEvent(row, sourceScope, ordinal));
  }
  flush();
  for (const group of groups) assertUniqueOrderedIdentities(group.events);
  return groups;
}

function parseEvent(row: PhysicalRow, scope: string, ordinal: bigint): SocialOutboxArchiveEvent {
  let payload: unknown;
  let envelope: unknown;
  try {
    payload = JSON.parse(row.canonical_payload_json);
    envelope = JSON.parse(row.canonical_event_envelope_json);
  } catch {
    throw sourceError('archive_source_outbox_canonical_json_invalid',
      'Social Outbox canonical JSON is invalid.');
  }
  if (!isRecord(payload) || !isRecord(envelope)) {
    throw sourceError('archive_source_outbox_canonical_json_invalid',
      'Social Outbox payload or envelope is not an object.');
  }
  const payloadBytes = BigInt(Buffer.byteLength(row.canonical_payload_json, 'utf8'));
  const envelopeBytes = BigInt(Buffer.byteLength(row.canonical_event_envelope_json, 'utf8'));
  return Object.freeze({
    outboxId: row.outbox_id, domainEventId: row.domain_event_id,
    eventType: SOCIAL_OUTBOX_EVENT_TYPE, eventVersion: row.event_version,
    handlerName: SOCIAL_OUTBOX_HANDLER, handlerMode: row.handler_mode,
    aggregateScope: scope, aggregateRevision: row.aggregate_revision, commitOrdinal: ordinal,
    canonicalPayloadJson: row.canonical_payload_json,
    payloadDigest: digest(row.canonical_payload_json), payloadBytes,
    canonicalEventEnvelopeJson: row.canonical_event_envelope_json,
    envelopeDigest: digest(row.canonical_event_envelope_json), envelopeBytes,
    state: 'completed', attemptCount: row.attempt_count,
    availableAt: iso(row.available_at), lockedUntil: nullableIso(row.locked_until),
    leaseGeneration: BigInt(row.lease_generation), completedAt: iso(row.completed_at!),
    lastError: row.last_error, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id,
    occurredAt: iso(row.occurred_at), deadLetteredAt: nullableIso(row.dead_lettered_at),
  });
}

function assertUniqueOrderedIdentities(events: readonly SocialOutboxArchiveEvent[]): void {
  const outboxIds = new Set<string>();
  const eventIds = new Set<string>();
  let previous: SocialOutboxArchiveEvent | undefined;
  for (const event of events) {
    if (outboxIds.has(event.outboxId) || eventIds.has(event.domainEventId)
        || previous && compareIdentity(previous, event) >= 0) {
      throw sourceError('archive_source_outbox_identity_invalid',
        'Social Outbox ordinal contains duplicate or unordered identities.');
    }
    outboxIds.add(event.outboxId);
    eventIds.add(event.domainEventId);
    previous = event;
  }
}

function assertDense(
  groups: readonly SocialOutboxArchiveOrdinalRow[],
  after: bigint | undefined,
  floorOrdinal: bigint,
  limit: number,
  floorDomainEventId: string,
): void {
  let expected = (after ?? 0n) + 1n;
  for (const group of groups) {
    if (group.commitOrdinal !== expected) throw sourceError(
      'archive_source_outbox_range_not_dense', 'Social Outbox ordinal range is not dense.',
    );
    expected += 1n;
  }
  if (groups.length <= limit) {
    if (expected !== floorOrdinal + 1n) throw sourceError(
      'archive_source_outbox_range_not_dense', 'Social Outbox range does not reach its floor.',
    );
    const finalEvent = groups.at(-1)?.events.at(-1);
    if (!finalEvent || finalEvent.domainEventId !== floorDomainEventId) throw sourceError(
      'archive_source_outbox_floor_not_closed', 'Social Outbox floor does not close its final ordinal.',
    );
  }
}

function outboxArchiveValue(row: SocialOutboxArchiveOrdinalRow): unknown {
  return {
    kind: 'outbox-social-ordinal-v1', aggregateScope: row.aggregateScope,
    commitOrdinal: row.commitOrdinal.toString(),
    events: row.events.map((event) => ({
      ...event, commitOrdinal: event.commitOrdinal.toString(),
      payloadBytes: event.payloadBytes.toString(), envelopeBytes: event.envelopeBytes.toString(),
      leaseGeneration: event.leaseGeneration.toString(),
    })),
  };
}

function assertPage(limit: number, lower: bigint, upper: bigint, floor: bigint): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new RangeError('archive_source_page_size_invalid');
  }
  if (lower !== 1n || upper !== floor + 1n) throw sourceError(
    'archive_source_outbox_bounds_invalid', 'Social Outbox archive bounds must be [1, floor + 1).',
  );
}

function assertScope(scope: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_./-]{0,255}$/u.test(scope)) throw sourceError(
    'archive_source_scope_invalid', 'Social Outbox source scope is invalid.',
  );
}

function compareIdentity(left: SocialOutboxArchiveEvent, right: SocialOutboxArchiveEvent): number {
  return Buffer.compare(Buffer.from(left.domainEventId), Buffer.from(right.domainEventId))
    || Buffer.compare(Buffer.from(left.outboxId), Buffer.from(right.outboxId));
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function iso(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw sourceError(
    'archive_source_outbox_timestamp_invalid', 'Social Outbox timestamp is invalid.',
  );
  return value.toISOString();
}

function nullableIso(value: Date | null): string | null {
  return value === null ? null : iso(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sourceError(code: string, message: string): SocialOutboxArchiveSourceError {
  return new SocialOutboxArchiveSourceError(code, message);
}
