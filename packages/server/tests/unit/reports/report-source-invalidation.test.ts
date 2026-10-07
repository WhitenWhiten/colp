import assert from 'node:assert/strict';
import { test } from 'vitest';
import { appendReportSourceInvalidation } from '../../../src/infrastructure/outbox/report-source-invalidation-producer.js';

const transaction = {} as never;

function source(overrides: Record<string, unknown> = {}) {
  return {
    domainEventId: 'identity:account-deleted:account-1:collection-1',
    collectionId: 'collection-1',
    eventType: 'collection.updated',
    eventVersion: 1,
    commitOrdinal: 7n,
    payload: { contentRevision: 'content-7', policyRevision: 'policy-7' },
    aggregateRevision: 'policy-7',
    ...overrides,
  };
}

test('source invalidation mapper fails closed on non-object payloads and unsafe revisions', async () => {
  let calls = 0;
  const port = { async append() { calls += 1; } };
  await assert.rejects(
    appendReportSourceInvalidation(port, transaction, source({ payload: null })),
    /JSON object/u,
  );
  await assert.rejects(
    appendReportSourceInvalidation(port, transaction, source({ payload: { contentRevision: 'secret\u0000' } })),
    /content revision/u,
  );
  assert.equal(calls, 0);
});

test('source invalidation mapper rejects non-plain and oversized payloads', async () => {
  let calls = 0;
  const port = { async append() { calls += 1; } };
  class Payload {}
  await assert.rejects(
    appendReportSourceInvalidation(port, transaction, source({
      payload: Object.assign(new Payload(), { contentRevision: 'c1', policyRevision: 'p1' }),
    })),
    /plain object/u,
  );
  await assert.rejects(
    appendReportSourceInvalidation(port, transaction, source({
      payload: { contentRevision: 'c1', policyRevision: 'p1', extra: 'x'.repeat(17_000) },
    })),
    /too large/u,
  );
  await assert.rejects(
    appendReportSourceInvalidation(port, transaction, source({ eventType: ' collection.updated' })),
    /event type/u,
  );
  assert.equal(calls, 0);
});

test('source invalidation mapper preserves namespaced lifecycle ids and supplies bounded fallback revisions', async () => {
  let received: Record<string, unknown> | undefined;
  const port = { async append(_transaction: unknown, input: Record<string, unknown>) { received = input; } };
  await appendReportSourceInvalidation(port, transaction, source({ payload: {}, aggregateRevision: undefined }));
  assert.equal(received?.domainEventId, 'identity:account-deleted:account-1:collection-1');
  assert.equal(received?.contentRevision, '7');
  assert.equal(received?.policyRevision, '7');
});
