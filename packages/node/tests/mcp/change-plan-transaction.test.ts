import { expect, it, vi } from 'vitest';
import { runChangePlanTransaction } from '../../src/mcp/change-plan-transaction.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';

function fixture() {
  const transaction = {};
  const coordinator = { receiver: {}, begin: vi.fn(async () => transaction),
    commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}), release: vi.fn(async () => {}) };
  const context = { planId: 'plan', binding: authenticatedBinding(), approval: true as const };
  return { coordinator, transaction, context };
}

it('commits before returning the result and always releases the same transaction', async () => {
  const { coordinator, transaction, context } = fixture();
  const value = await runChangePlanTransaction(coordinator, context, 'Approval', async handle => {
    expect(handle).toBe(transaction); return 'approved';
  });
  expect(value).toBe('approved');
  expect(coordinator.rollback).not.toHaveBeenCalled();
  expect(coordinator.commit).toHaveBeenCalledWith(transaction);
  expect(coordinator.release).toHaveBeenCalledWith(transaction);
  expect(coordinator.commit.mock.invocationCallOrder[0]).toBeLessThan(coordinator.release.mock.invocationCallOrder[0]!);
});

it.each(['Approval', 'Commit', 'Cancel'] as const)('rejects an undefined %s failure after rollback and release', async label => {
  const { coordinator, transaction, context } = fixture();
  await expect(runChangePlanTransaction(coordinator, context, label, async () => { throw undefined; }))
    .rejects.toMatchObject({ code: 'commit_failed' });
  expect(coordinator.commit).not.toHaveBeenCalled();
  expect(coordinator.rollback).toHaveBeenCalledWith(transaction, undefined);
  expect(coordinator.release).toHaveBeenCalledWith(transaction);
});

it('a cleanup failure cannot turn a failed operation into success or expose its original cause', async () => {
  const { coordinator, context } = fixture();
  coordinator.rollback.mockRejectedValueOnce(new Error('private rollback detail'));
  coordinator.release.mockRejectedValueOnce(new Error('private release detail'));
  await expect(runChangePlanTransaction(coordinator, context, 'Commit', async () => { throw new Error('private business detail'); }))
    .rejects.toMatchObject({ code: 'commit_failed', message: 'Commit transaction release failed; the request failed closed.' });
});
