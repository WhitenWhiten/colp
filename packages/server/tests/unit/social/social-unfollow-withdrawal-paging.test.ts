import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'vitest';
import {
  OutboxContinuationRequested,
  OutboxDeliveryError,
} from '../../../src/infrastructure/outbox/index.js';
import { createSocialFeedWithdrawalWorkerRoutes } from '../../../src/infrastructure/social/feed-withdrawal-worker-route.js';
import type {
  ProjectSocialFeedWithdrawalResult,
  SocialFeedWithdrawalWorkerRepository,
} from '../../../src/modules/social/index.js';

const backendRoot = resolve(import.meta.dirname, '../../..');

const ACTOR = 'profile-actor';
const TARGET = 'profile-target';

const envelope = Object.freeze({
  event_id: 'unfollow-event-1',
  event_type: 'social.follow-removed',
  event_version: 1,
  aggregate_identity: Object.freeze({
    aggregate_type: 'profile-follow',
    aggregate_id: ACTOR,
    aggregate_scope: TARGET,
  }),
  aggregate_revision: null,
  commit_ordinal: null,
  occurred_at: '2026-07-29T10:00:00.000Z',
  payload: Object.freeze({
    actorProfileId: ACTOR,
    targetProfileId: TARGET,
  }),
});

function repository(
  disposition: ProjectSocialFeedWithdrawalResult['disposition'],
  withdrawnCount = 0,
  onProject?: (maxRecipients: number) => void,
): SocialFeedWithdrawalWorkerRepository {
  return {
    async project(input) {
      onProject?.(input.maxRecipients);
      return { disposition, withdrawnCount };
    },
  };
}

function handle(
  routes: ReturnType<typeof createSocialFeedWithdrawalWorkerRoutes>,
  attempt: { outboxId: string; leaseGeneration: string } | undefined = {
    outboxId: 'outbox-1', leaseGeneration: '1',
  },
) {
  return routes[0]!.handle({
    envelope,
    idempotencyKey: envelope.event_id,
    signal: new AbortController().signal,
    ...(attempt ? { attempt } : {}),
  });
}

test('P-03 withdrawal route defaults maxRecipientsPerEvent to 500 and forwards page size', async () => {
  const seen: number[] = [];
  await handle(createSocialFeedWithdrawalWorkerRoutes({
    repository: repository('applied', 0, (maxRecipients) => seen.push(maxRecipients)),
  }));
  assert.deepEqual(seen, [500]);

  const configured: number[] = [];
  await handle(createSocialFeedWithdrawalWorkerRoutes({
    repository: repository('applied', 0, (maxRecipients) => configured.push(maxRecipients)),
    maxRecipientsPerEvent: 7,
  }));
  assert.deepEqual(configured, [7]);
});

test('P-03 withdrawal route rejects fan-out bounds outside 1..1000', () => {
  assert.throws(
    () => createSocialFeedWithdrawalWorkerRoutes({
      repository: repository('applied'), maxRecipientsPerEvent: 0,
    }),
    /maxRecipientsPerEvent/u,
  );
  assert.throws(
    () => createSocialFeedWithdrawalWorkerRoutes({
      repository: repository('applied'), maxRecipientsPerEvent: 1_001,
    }),
    /maxRecipientsPerEvent/u,
  );
});

test('P-03 route requests OutboxContinuationRequested for continued disposition', async () => {
  const routes = createSocialFeedWithdrawalWorkerRoutes({
    repository: repository('continued', 500),
    maxRecipientsPerEvent: 500,
  });
  await assert.rejects(
    handle(routes),
    (error: unknown) => {
      assert.ok(error instanceof OutboxContinuationRequested);
      assert.equal(error instanceof OutboxDeliveryError, false);
      return true;
    },
  );
});

test('P-03 route does not throw on applied or duplicate dispositions', async () => {
  await handle(createSocialFeedWithdrawalWorkerRoutes({
    repository: repository('applied', 3),
  }));
  await handle(createSocialFeedWithdrawalWorkerRoutes({
    repository: repository('duplicate', 0),
  }));
});

test('P-03 lease_lost remains a retryable delivery error, not continuation', async () => {
  await assert.rejects(
    handle(createSocialFeedWithdrawalWorkerRoutes({
      repository: repository('lease_lost', 0),
    })),
    (error: unknown) => error instanceof OutboxDeliveryError && error.failureKind === 'retryable',
  );
});

test('P-03 postgres unfollow UPDATE is lock-safe and limited to one configured page', async () => {
  const postgres = await readFile(
    resolve(backendRoot, 'src/infrastructure/social/feed-withdrawal-worker-postgres.ts'),
    'utf8',
  );
  const route = await readFile(
    resolve(backendRoot, 'src/infrastructure/social/feed-withdrawal-worker-route.ts'),
    'utf8',
  );
  assert.match(postgres, /unfollowWithdrawalUpdateSql\(\)/u);
  assert.match(postgres, /for update skip locked/u);
  assert.match(postgres, /limit \$4/u);
  assert.match(postgres, /order by published_at asc, feed_item_id asc/u);
  assert.match(postgres, /kind='follow_activity'/u);
  assert.match(postgres, /kind='collection_change'/u);
  assert.match(postgres, /withdrawal_reason='unfollowed'/u);
  assert.equal(/while\s*\(\s*true\s*\)/u.test(postgres), false);
  assert.match(route, /OutboxContinuationRequested/u);
  assert.equal(route.includes('OutboxDeliveryError') && /disposition === 'continued'/u.test(route), true);
});
