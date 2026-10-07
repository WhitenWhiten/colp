import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  clearEmailSuppressionFact,
  listEmailSuppressionFacts,
  scrubEmailSuppressionFact,
  verifyEmailOpsToken,
  type EmailSuppressionFactRecord,
  type EmailSuppressionOpsRepository,
} from '../../../src/modules/notifications/index.js';

const records: readonly EmailSuppressionFactRecord[] = Object.freeze([
  Object.freeze({
    recipientAccountId: 'account-11111111',
    source: 'bounce' as const,
    occurredAt: new Date('2026-08-01T00:00:00.000Z'),
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  }),
  Object.freeze({
    recipientAccountId: 'account-22222222',
    source: 'unsubscribe' as const,
    occurredAt: new Date('2026-08-02T00:00:00.000Z'),
    createdAt: new Date('2026-08-02T00:00:00.000Z'),
  }),
]);

function repository(overrides: Partial<EmailSuppressionOpsRepository> = {}): EmailSuppressionOpsRepository {
  return {
    listSuppressionFacts: async () => records,
    countSuppressionFacts: async () => records.length,
    clearSuppressionFact: async (recipientAccountId) =>
      records.some((record) => record.recipientAccountId === recipientAccountId),
    ...overrides,
  };
}

test('P5-31 suppression facts scrub recipient identity: account ids only, never emails or credentials', async () => {
  const views = await listEmailSuppressionFacts(repository());
  assert.equal(views.length, 2);
  for (const view of views) {
    assert.equal(Object.hasOwn(view, 'recipientAccountId'), true);
    assert.equal(Object.hasOwn(view, 'email'), false);
    assert.equal(Object.hasOwn(view, 'recipientEmail'), false);
    assert.equal(Object.hasOwn(view, 'toAddress'), false);
    assert.doesNotMatch(JSON.stringify(view), /@/u);
    assert.doesNotMatch(JSON.stringify(view), /secret|credential|password|token/iu);
    assert.match(view.recipientAccountId, /^account-[\d]+$/u);
  }
  assert.equal(views[0]!.source, 'bounce');
  assert.equal(views[1]!.source, 'unsubscribe');
  assert.equal(typeof views[0]!.occurredAt, 'string');
});

test('P5-31 scrubEmailSuppressionFact never widens the record shape', () => {
  const view = scrubEmailSuppressionFact(records[0]!);
  assert.deepEqual(Object.keys(view).sort(), ['createdAt', 'occurredAt', 'recipientAccountId', 'source']);
});

test('P5-31 clear is documented as resubscribe and reports cleared boolean', async () => {
  const cleared = await clearEmailSuppressionFact(repository(), 'account-11111111');
  assert.equal(cleared.cleared, true);
  assert.equal(cleared.recipientAccountId, 'account-11111111');
  const missing = await clearEmailSuppressionFact(repository(), 'account-99999999');
  assert.equal(missing.cleared, false);
});

test('P5-31 ops token guard is constant-time-style and fail closed', () => {
  assert.equal(verifyEmailOpsToken('ops-secret', 'ops-secret'), true);
  assert.equal(verifyEmailOpsToken('ops-secret', 'wrong'), false);
  assert.equal(verifyEmailOpsToken('ops-secret', undefined), false);
  assert.equal(verifyEmailOpsToken(null, 'ops-secret'), false);
  assert.equal(verifyEmailOpsToken('', 'ops-secret'), false);
  assert.equal(verifyEmailOpsToken('ops-secret', ''), false);
});
