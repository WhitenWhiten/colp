import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COMMUNITY_HOT_SCORE_VERSION,
  type CommunityRankingRefreshResult,
} from '../../../src/modules/community/index.js';
import {
  COMMUNITY_RANK_REFRESH_AGGREGATE_ID,
  COMMUNITY_RANK_REFRESH_AGGREGATE_SCOPE,
  COMMUNITY_RANK_REFRESH_AGGREGATE_TYPE,
  COMMUNITY_RANK_REFRESH_EVENT_TYPE,
  COMMUNITY_RANK_REFRESH_EVENT_VERSION,
  COMMUNITY_RANK_REFRESH_HANDLER_MODE,
  COMMUNITY_RANK_REFRESH_HANDLER_NAME,
  communityRankRefreshEnvelopeRegistrations,
  createCommunityRankRefreshWorkerRoutes,
  type CommunityRankRefreshWorkerRouteOptions,
} from '../../../src/infrastructure/community/community-rank-refresh-outbox.js';
import { InvalidEventEnvelopeError } from '../../../src/infrastructure/outbox/envelope.js';
import { OutboxDeliveryError } from '../../../src/infrastructure/outbox/router.js';

const OCCURRED_AT = '2026-10-06T12:00:00.000Z';

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    event_id: 'evt-1',
    event_type: COMMUNITY_RANK_REFRESH_EVENT_TYPE,
    event_version: COMMUNITY_RANK_REFRESH_EVENT_VERSION,
    aggregate_identity: {
      aggregate_type: COMMUNITY_RANK_REFRESH_AGGREGATE_TYPE,
      aggregate_id: COMMUNITY_RANK_REFRESH_AGGREGATE_ID,
      aggregate_scope: COMMUNITY_RANK_REFRESH_AGGREGATE_SCOPE,
    },
    aggregate_revision: COMMUNITY_HOT_SCORE_VERSION,
    commit_ordinal: '7',
    occurred_at: OCCURRED_AT,
    payload: { reason: 'vote' },
    ...overrides,
  };
}

interface RefreshProbe {
  readonly seen: { ran: boolean; signal?: AbortSignal; attempt?: { outboxId: string; leaseGeneration: string } };
  readonly increments: string[];
  readonly options: CommunityRankRefreshWorkerRouteOptions;
}

/**
 * The route never invokes the work callback's ports in this unit harness:
 * the fake unit of work returns the canned rebuild result untouched, so the
 * test pins route/envelope plumbing only (real delivery is covered by the
 * ranking integration suite).
 */
function probe(result: Partial<CommunityRankingRefreshResult> = {}): RefreshProbe {
  const seen: { ran: boolean; signal?: AbortSignal; attempt?: { outboxId: string; leaseGeneration: string } } = { ran: false };
  const increments: string[] = [];
  const options: CommunityRankRefreshWorkerRouteOptions = {
    refreshUnitOfWork: {
      async executeAttempt<Result>(
        _work: (ports: never) => Promise<Result>,
        execution: { readonly signal: AbortSignal; readonly attempt: { outboxId: string; leaseGeneration: string } },
      ): Promise<Result> {
        seen.ran = true;
        seen.signal = execution.signal;
        seen.attempt = execution.attempt;
        return {
          snapshotId: 'snap-1',
          itemCount: 3,
          prunedSnapshots: 0,
          scoreVersion: COMMUNITY_HOT_SCORE_VERSION,
          ...result,
        } as Result;
      },
    },
    metrics: { increment: (name) => { increments.push(name); } },
  };
  return { seen, increments, options };
}

test('the worker route is durable, projection-classed, and projection_latest_only', () => {
  const [route] = createCommunityRankRefreshWorkerRoutes(probe().options);
  assert.equal(route!.handlerName, COMMUNITY_RANK_REFRESH_HANDLER_NAME);
  assert.equal(route!.handlerName, 'community.hot-ranking-refresh');
  assert.equal(route!.handlerMode, COMMUNITY_RANK_REFRESH_HANDLER_MODE);
  assert.equal(route!.handlerMode, 'projection_latest_only');
  assert.equal(route!.eventType, 'community.rank-refresh');
  assert.equal(route!.eventVersion, 1);
  assert.equal(route!.sideEffectDurability, 'durable');
  assert.equal(route!.routeClass, 'projection');
});

test('a well-formed envelope with a positive commit ordinal runs the rebuild and records metrics', async () => {
  const { seen, increments, options } = probe({ itemCount: 5, prunedSnapshots: 2 });
  const [route] = createCommunityRankRefreshWorkerRoutes(options);
  const signal = new AbortController().signal;
  await route!.handle({
    envelope: envelope() as never,
    idempotencyKey: 'ik-1',
    signal,
    attempt: { outboxId: 'ob-1', leaseGeneration: '7' },
  });
  assert.equal(seen.ran, true);
  assert.equal(seen.signal, signal);
  assert.deepEqual(seen.attempt, { outboxId: 'ob-1', leaseGeneration: '7' });
  assert.deepEqual(increments, [
    'community.rank_refresh.completed',
    'community.rank_refresh.vote',
    'community.rank_refresh.items',
    'community.rank_refresh.snapshots_pruned',
  ]);
});

test('envelope normalization requires a real positive commit ordinal', async () => {
  const { options } = probe();
  const [route] = createCommunityRankRefreshWorkerRoutes(options);
  for (const commit_ordinal of [null, '0', '-1', 'abc', '1.5', '']) {
    await assert.rejects(
      () => route!.handle({
        envelope: envelope({ commit_ordinal }) as never,
        idempotencyKey: 'ik-1',
        signal: new AbortController().signal,
        attempt: { outboxId: 'ob-1', leaseGeneration: '7' },
      }),
      InvalidEventEnvelopeError,
    );
  }
});

test('envelope normalization fails closed on identity, revision, or payload drift', async () => {
  const { options } = probe();
  const [route] = createCommunityRankRefreshWorkerRoutes(options);
  for (const bad of [
    envelope({ aggregate_revision: 'hot-v2' }),
    envelope({ aggregate_identity: { aggregate_type: 'other', aggregate_id: COMMUNITY_RANK_REFRESH_AGGREGATE_ID, aggregate_scope: COMMUNITY_RANK_REFRESH_AGGREGATE_SCOPE } }),
    envelope({ aggregate_identity: { aggregate_type: COMMUNITY_RANK_REFRESH_AGGREGATE_TYPE, aggregate_id: 'other', aggregate_scope: COMMUNITY_RANK_REFRESH_AGGREGATE_SCOPE } }),
    envelope({ aggregate_identity: { aggregate_type: COMMUNITY_RANK_REFRESH_AGGREGATE_TYPE, aggregate_id: COMMUNITY_RANK_REFRESH_AGGREGATE_ID, aggregate_scope: 'other' } }),
    envelope({ payload: { reason: 'unknown' } }),
    envelope({ payload: { reason: 'vote', extra: 1 } }),
    envelope({ payload: {} }),
  ]) {
    await assert.rejects(
      () => route!.handle({
        envelope: bad as never,
        idempotencyKey: 'ik-1',
        signal: new AbortController().signal,
        attempt: { outboxId: 'ob-1', leaseGeneration: '7' },
      }),
      InvalidEventEnvelopeError,
    );
  }
});

test('the route retries a missing attempt fence', async () => {
  const { options } = probe();
  const [route] = createCommunityRankRefreshWorkerRoutes(options);
  await assert.rejects(
    () => route!.handle({
      envelope: envelope() as never,
      idempotencyKey: 'ik-1',
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof OutboxDeliveryError
      && (error as OutboxDeliveryError).failureKind === 'retryable',
  );
});

test('the envelope registration pins the event type, version, and closed payload', () => {
  assert.equal(communityRankRefreshEnvelopeRegistrations.length, 1);
  const registration = communityRankRefreshEnvelopeRegistrations[0]!;
  assert.equal(registration.eventType, 'community.rank-refresh');
  assert.equal(registration.eventVersion, 1);
  for (const reason of ['vote', 'scheduled', 'rebuild']) {
    assert.equal(registration.validatePayload({ reason }), true, `reason=${reason}`);
  }
  assert.equal(registration.validatePayload({ reason: 'other' }), false);
  assert.equal(registration.validatePayload({ reason: 'vote', extra: 1 }), false);
});
