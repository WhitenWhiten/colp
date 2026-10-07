import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import {
  COMMUNITY_HOT_SCORE_VERSION,
  refreshCommunityRanking,
  type CommunityRankingRefreshPorts,
} from '../../modules/community/index.js';
import { databaseNow } from '../database/time.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import {
  defineClosedPayloadValidator,
  InvalidEventEnvelopeError,
  type EventPayloadRegistration,
  type VersionedEventEnvelope,
} from '../outbox/envelope.js';
import {
  OutboxDeliveryError,
  type OutboxHandlerContext,
  type OutboxRoute,
} from '../outbox/router.js';

/**
 * CS-02 durable hot-ranking refresh event.
 *
 * One handler identity (`community.hot-ranking-refresh`) on the shared
 * `community_ranking` aggregate serializes all rebuild passes: the outbox
 * claim fence guarantees at most one live lease and claims only the
 * minimum unfinished ordinal, and every pass is a full rebuild from
 * retained vote authority. The `projection_latest_only` claim gate
 * requires a real commit_ordinal, so each event draws one from the
 * dedicated `community_rank_refresh_ordinal` sequence inside the enqueue
 * transaction: a backlogged lower ordinal that the watermark already
 * covers is skipped on claim, converging a vote storm onto the newest
 * committed rebuild instead of replaying every stale pass.
 *
 * Producers: the vote command transaction appends `reason='vote'` inside the
 * same commit; the periodic scheduler appends `reason='scheduled'` only when
 * no unfinished event exists; an ops rebuild may append `reason='rebuild'`.
 * Restart continuation is the shared durable claim/lease machinery — the
 * job row is the job, never a process-local Promise.
 */
export const COMMUNITY_RANK_REFRESH_EVENT_TYPE = 'community.rank-refresh' as const;
export const COMMUNITY_RANK_REFRESH_EVENT_VERSION = 1 as const;
export const COMMUNITY_RANK_REFRESH_HANDLER_NAME = 'community.hot-ranking-refresh' as const;
export const COMMUNITY_RANK_REFRESH_HANDLER_MODE = 'projection_latest_only' as const;
export const COMMUNITY_RANK_REFRESH_AGGREGATE_TYPE = 'community' as const;
export const COMMUNITY_RANK_REFRESH_AGGREGATE_ID = 'community-ranking' as const;
export const COMMUNITY_RANK_REFRESH_AGGREGATE_SCOPE = COMMUNITY_HOT_SCORE_VERSION;

export type CommunityRankRefreshReason = 'vote' | 'scheduled' | 'rebuild';

const REASONS: readonly CommunityRankRefreshReason[] = Object.freeze(['vote', 'scheduled', 'rebuild']);

/** Positive base-10 ordinal shape (no zero, no padding) — same contract as other projection envelopes. */
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u;

function generateOutboxId(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * Append one refresh event inside the caller's transaction. Durable with the
 * triggering write: the event is never emitted from a process-local queue.
 */
export async function appendCommunityRankRefreshOutbox(
  transaction: DatabaseTransaction,
  reason: CommunityRankRefreshReason,
  options: { readonly outboxIdGenerator?: () => string; readonly occurredAt?: Date } = {},
): Promise<void> {
  if (!REASONS.includes(reason)) {
    throw new TypeError('community rank refresh reason is invalid');
  }
  const occurredAt = options.occurredAt ?? await databaseNow(transaction);
  const outboxId = (options.outboxIdGenerator ?? generateOutboxId)();
  const domainEventId = (options.outboxIdGenerator ?? generateOutboxId)();
  // The projection_latest_only claim gate refuses null ordinals, so the
  // event draws its ordinal from the dedicated sequence inside the same
  // transaction. Sequence allocation is not commit-ordered; a
  // late-committing lower ordinal is harmlessly converged by the
  // projection watermark skip on claim.
  const ordinalRow = await sql<{ ordinal: string }>`
    select nextval('community_rank_refresh_ordinal')::text as ordinal
  `.execute(transaction);
  const ordinal = ordinalRow.rows[0]?.ordinal;
  if (ordinal === undefined) {
    throw new TypeError('community rank refresh ordinal sequence returned no value');
  }
  const payload = { reason } as const;
  await transaction.insertInto('resource_id_ledger').values({
    resource_id: outboxId,
    resource_type: 'outbox',
  }).execute();
  await transaction.insertInto('resource_id_ledger').values({
    resource_id: domainEventId,
    resource_type: 'domain-event',
  }).execute();
  await transaction.insertInto('outbox_events').values({
    outbox_id: outboxId,
    domain_event_id: domainEventId,
    event_type: COMMUNITY_RANK_REFRESH_EVENT_TYPE,
    event_version: COMMUNITY_RANK_REFRESH_EVENT_VERSION,
    handler_name: COMMUNITY_RANK_REFRESH_HANDLER_NAME,
    handler_mode: COMMUNITY_RANK_REFRESH_HANDLER_MODE,
    aggregate_type: COMMUNITY_RANK_REFRESH_AGGREGATE_TYPE,
    aggregate_id: COMMUNITY_RANK_REFRESH_AGGREGATE_ID,
    aggregate_scope: COMMUNITY_RANK_REFRESH_AGGREGATE_SCOPE,
    aggregate_revision: COMMUNITY_HOT_SCORE_VERSION,
    commit_ordinal: BigInt(ordinal),
    occurred_at: occurredAt,
    payload_json: payload,
    state: 'pending',
    attempt_count: 0,
    available_at: occurredAt,
    locked_until: null,
    lease_generation: 0n,
    completed_at: null,
    last_error: null,
    dead_lettered_at: null,
  }).execute();
}

/** Whether an unfinished refresh event already exists (scheduler dedupe). */
export async function communityRankRefreshPending(
  transaction: DatabaseTransaction,
): Promise<boolean> {
  const result = await sql<{ present: boolean }>`
    select exists (
      select 1 from outbox_events
      where handler_name = ${COMMUNITY_RANK_REFRESH_HANDLER_NAME}
        and state in ('pending', 'retryable', 'leased')
    ) as present
  `.execute(transaction);
  return result.rows[0]?.present === true;
}

const validateV1 = defineClosedPayloadValidator({
  reason: (value): value is CommunityRankRefreshReason =>
    typeof value === 'string' && (REASONS as readonly string[]).includes(value),
});

export const communityRankRefreshEnvelopeRegistrations: readonly EventPayloadRegistration[] =
  Object.freeze([
    Object.freeze({
      eventType: COMMUNITY_RANK_REFRESH_EVENT_TYPE,
      eventVersion: COMMUNITY_RANK_REFRESH_EVENT_VERSION,
      validatePayload: validateV1,
    }),
  ]);

function normalizeRefreshEvent(envelope: VersionedEventEnvelope): CommunityRankRefreshReason {
  const identity = envelope.aggregate_identity;
  if (identity.aggregate_type !== COMMUNITY_RANK_REFRESH_AGGREGATE_TYPE
      || identity.aggregate_id !== COMMUNITY_RANK_REFRESH_AGGREGATE_ID
      || identity.aggregate_scope !== COMMUNITY_RANK_REFRESH_AGGREGATE_SCOPE) {
    throw new InvalidEventEnvelopeError('community rank refresh aggregate identity is invalid');
  }
  if (envelope.aggregate_revision !== COMMUNITY_HOT_SCORE_VERSION) {
    throw new InvalidEventEnvelopeError('community rank refresh aggregate revision is invalid');
  }
  // The projection_latest_only claim gate requires a real positive ordinal:
  // it serializes same-aggregate claims on the minimum unfinished ordinal
  // and bounds the watermark skip that converges backlogged events.
  if (envelope.commit_ordinal === null || !POSITIVE_DECIMAL.test(envelope.commit_ordinal)) {
    throw new InvalidEventEnvelopeError('community rank refresh commit ordinal must be a positive integer');
  }
  const payload = envelope.payload as { reason?: unknown };
  if (!validateV1(envelope.payload) || typeof payload.reason !== 'string') {
    throw new InvalidEventEnvelopeError('community rank refresh payload is invalid');
  }
  return payload.reason as CommunityRankRefreshReason;
}

export interface CommunityRankRefreshWorkerRouteOptions {
  readonly refreshUnitOfWork: {
    executeAttempt<Result>(
      work: (ports: CommunityRankingRefreshPorts) => Promise<Result>,
      options: { readonly signal: AbortSignal; readonly attempt: NonNullable<OutboxHandlerContext['attempt']> },
    ): Promise<Result>;
  };
  readonly metrics?: { readonly increment: (name: string, value?: number) => void };
}

/**
 * The durable worker route: claim → rebuild the whole projection inside one
 * unit of work → complete. The rebuild reads vote authority only, so it is
 * safe to replay after crash/restart and produces identical snapshots.
 */
export function createCommunityRankRefreshWorkerRoutes(
  options: CommunityRankRefreshWorkerRouteOptions,
): readonly OutboxRoute[] {
  return Object.freeze([Object.freeze<OutboxRoute>({
    handlerName: COMMUNITY_RANK_REFRESH_HANDLER_NAME,
    handlerMode: COMMUNITY_RANK_REFRESH_HANDLER_MODE,
    eventType: COMMUNITY_RANK_REFRESH_EVENT_TYPE,
    eventVersion: COMMUNITY_RANK_REFRESH_EVENT_VERSION,
    sideEffectDurability: 'durable',
    routeClass: 'projection',
    async handle(context: OutboxHandlerContext): Promise<void> {
      context.signal.throwIfAborted();
      if (!context.attempt) {
        throw new OutboxDeliveryError('retryable', 'community rank refresh attempt fence is missing');
      }
      const reason = normalizeRefreshEvent(context.envelope);
      const result = await options.refreshUnitOfWork.executeAttempt(
        (ports) => refreshCommunityRanking(ports),
        { signal: context.signal, attempt: context.attempt },
      );
      options.metrics?.increment('community.rank_refresh.completed');
      options.metrics?.increment(`community.rank_refresh.${reason}`);
      options.metrics?.increment('community.rank_refresh.items', result.itemCount);
      if (result.prunedSnapshots > 0) {
        options.metrics?.increment('community.rank_refresh.snapshots_pruned', result.prunedSnapshots);
      }
    },
  })]);
}
