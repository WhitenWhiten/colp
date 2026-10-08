import { expect, test, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../../../src/infrastructure/database/runtime.js';
import { createPostgresCreditHealthObserver } from '../../../src/infrastructure/identity/credit-health-postgres.js';

const execute = vi.hoisted(() => vi.fn());
vi.mock('../../../src/infrastructure/identity/credits-postgres.js', () => ({
  createCreditUnitOfWork: () => ({ execute }),
}));

test('a failed global summary retains metrics and cannot prevent account audits or cause rapid retries', async () => {
  execute.mockReset().mockRejectedValueOnce(new Error('summary timeout')).mockResolvedValue([]);
  const page = {
    select: () => page, where: () => page, orderBy: () => page, limit: () => page,
    execute: async () => [{ account_id: 'account' }],
  };
  const db = { selectFrom: () => page } as unknown as Kysely<DatabaseSchema>;
  const metrics = { increment: vi.fn(), gauge: vi.fn() };
  const observe = createPostgresCreditHealthObserver(db, metrics);
  await observe();
  expect(execute).toHaveBeenCalledTimes(2);
  expect(metrics.increment).toHaveBeenCalledWith('classification.credits.summary_failed');
  expect(metrics.gauge.mock.calls.every(([name]) => name === 'classification.credits.last_audit_at_seconds')).toBe(true);
  await observe();
  expect(execute).toHaveBeenCalledTimes(3); // only the account audit, not another global scan
});
