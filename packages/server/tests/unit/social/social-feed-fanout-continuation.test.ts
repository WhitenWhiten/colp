import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  OutboxContinuationRequested,
  OutboxDeliveryError,
} from '../../../src/infrastructure/outbox/index.js';
import { createSocialFeedWorkerRoutes } from '../../../src/infrastructure/social/index.js';
import type { SocialFeedWorkerRepository } from '../../../src/modules/social/index.js';

const env = { DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known', NODE_ENV: 'test',
  OIDC_ALLOW_TEST_PROVIDER: 'true', OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default' };

const envelope = Object.freeze({
  event_id: 'CAgICAgICAgICAgICAgICA',
  event_type: 'social.collection-change',
  event_version: 2,
  aggregate_identity: Object.freeze({
    aggregate_type: 'collection',
    aggregate_id: 'Dw8PDw8PDw8PDw8PDw8PDw',
    aggregate_scope: 'Dw8PDw8PDw8PDw8PDw8PDw',
  }),
  aggregate_revision: 'publication-revision-101',
  commit_ordinal: '101',
  occurred_at: '2026-07-29T10:01:00.000Z',
  payload: Object.freeze({
    collectionId: 'Dw8PDw8PDw8PDw8PDw8PDw',
    ownerProfileId: 'IiIiIiIiIiIiIiIiIiIiIg',
    publicationRevision: 'publication-revision-101',
    discoverabilityRecheckKey: 'publication.collection:Dw8PDw8PDw8PDw8PDw8PDw',
    producerDiscoverability: 'public_candidate',
  }),
});

function repository(
  overrides: Partial<SocialFeedWorkerRepository> = {},
): SocialFeedWorkerRepository {
  return {
    async projectCollectionChange() {
      return { disposition: 'applied', itemCount: 0 };
    },
    async projectFollowActivity() {
      return { disposition: 'applied', itemCount: 0 };
    },
    async rebuildCollectionScope() {
      return { eventCount: 0, itemCount: 0, highCommitOrdinal: '0' };
    },
    ...overrides,
  };
}

test('R5-04 FEED_FANOUT_PAGE_SIZE defaults to 500 and accepts 1..1000', () => {
  assert.equal(loadConfig(env).feed?.fanoutPageSize, 500);
  assert.equal(loadConfig({ ...env, FEED_FANOUT_PAGE_SIZE: '1' }).feed?.fanoutPageSize, 1);
  assert.equal(loadConfig({ ...env, FEED_FANOUT_PAGE_SIZE: '1000' }).feed?.fanoutPageSize, 1000);
  assert.throws(
    () => loadConfig({ ...env, FEED_FANOUT_PAGE_SIZE: '0' }),
    /FEED_FANOUT_PAGE_SIZE/u,
  );
  assert.throws(
    () => loadConfig({ ...env, FEED_FANOUT_PAGE_SIZE: '1001' }),
    /FEED_FANOUT_PAGE_SIZE/u,
  );
});

test('R5-04 route defaults maxRecipientsPerEvent to 500 and forwards configured page size', async () => {
  const seen: unknown[] = [];
  const routes = createSocialFeedWorkerRoutes({
    repository: repository({
      async projectCollectionChange(input) {
        seen.push(input.maxRecipients);
        return { disposition: 'applied', itemCount: 0 };
      },
    }),
  });
  await routes[1]!.handle({
    envelope,
    idempotencyKey: envelope.event_id,
    signal: new AbortController().signal,
    attempt: { outboxId: 'outbox-default', leaseGeneration: '1' },
  });
  assert.deepEqual(seen, [500]);

  const configured: unknown[] = [];
  const sized = createSocialFeedWorkerRoutes({
    repository: repository({
      async projectCollectionChange(input) {
        configured.push(input.maxRecipients);
        return { disposition: 'applied', itemCount: 0 };
      },
    }),
    maxRecipientsPerEvent: 7,
  });
  await sized[1]!.handle({
    envelope,
    idempotencyKey: envelope.event_id,
    signal: new AbortController().signal,
    attempt: { outboxId: 'outbox-sized', leaseGeneration: '1' },
  });
  assert.deepEqual(configured, [7]);
});

test('R5-04 route requests OutboxContinuationRequested for continued disposition', async () => {
  const route = createSocialFeedWorkerRoutes({
    repository: repository({
      async projectCollectionChange() {
        return { disposition: 'continued', itemCount: 500 };
      },
    }),
    maxRecipientsPerEvent: 500,
  })[1]!;
  await assert.rejects(
    route.handle({
      envelope,
      idempotencyKey: envelope.event_id,
      signal: new AbortController().signal,
      attempt: { outboxId: 'outbox-cont', leaseGeneration: '3' },
    }),
    (error: unknown) => {
      assert.ok(error instanceof OutboxContinuationRequested);
      assert.equal(error instanceof OutboxDeliveryError, false);
      return true;
    },
  );
});

test('R5-04 lease_lost remains a retryable delivery error, not continuation', async () => {
  const route = createSocialFeedWorkerRoutes({
    repository: repository({
      async projectCollectionChange() {
        return { disposition: 'lease_lost', itemCount: 0 };
      },
    }),
  })[1]!;
  await assert.rejects(
    route.handle({
      envelope,
      idempotencyKey: envelope.event_id,
      signal: new AbortController().signal,
      attempt: { outboxId: 'outbox-lease', leaseGeneration: '1' },
    }),
    (error: unknown) => error instanceof OutboxDeliveryError && error.failureKind === 'retryable',
  );
});
