import { expect, test, vi } from 'vitest';
import { createOwnerMaintenanceBatch, type OwnerMaintenanceClaim, type OwnerMaintenanceQueue } from '../../../src/infrastructure/automation/owner-maintenance-queue.js';

function queue(length: number) {
  const pending = Array.from({ length }, (_, index) => ({ ownerId: String(index), generation: '1' }));
  const finish = vi.fn(async (_claim: OwnerMaintenanceClaim, _succeeded: boolean) => {});
  const port: OwnerMaintenanceQueue = { claim: async () => pending.shift() ?? null, finish };
  return { port, finish, pending };
}

test('one slow owner cannot block other slots and the batch respects its work bound', async () => {
  const { port, pending, finish } = queue(1000);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let active = 0, maximum = 0;
  const seen: string[] = [];
  const run = createOwnerMaintenanceBatch({ queue: port, concurrency: 4, batchSize: 128, onError: error => { throw error; },
    async maintainOwner(owner) {
      active += 1; maximum = Math.max(maximum, active); seen.push(owner);
      if (owner === '0') await blocked;
      await Promise.resolve(); active -= 1;
    },
  });
  const running = run();
  await vi.waitFor(() => expect(seen).toHaveLength(128));
  expect(pending).toHaveLength(872);
  expect(maximum).toBeLessThanOrEqual(4);
  release(); await running;
  expect(finish).toHaveBeenCalledTimes(128);
});

test('a failed owner releases its claim for retry and does not stop other owners', async () => {
  const { port, finish } = queue(3);
  const onError = vi.fn();
  await createOwnerMaintenanceBatch({ queue: port, onError, maintainOwner: async owner => {
    if (owner === '0') throw new Error('owner unavailable');
  } })();
  expect(onError).toHaveBeenCalledOnce();
  expect(finish).toHaveBeenCalledWith({ ownerId: '0', generation: '1' }, false);
  expect(finish).toHaveBeenCalledWith({ ownerId: '2', generation: '1' }, true);
});

test('queue failures drain already started owners before the sweep rejects', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const claim = vi.fn().mockResolvedValueOnce({ ownerId: 'started', generation: '1' }).mockRejectedValue(new Error('queue unavailable'));
  let settled = false;
  const running = createOwnerMaintenanceBatch({ queue: { claim, finish: async () => {} },
    concurrency: 2, batchSize: 2, maintainOwner: () => blocked, onError: () => {},
  })();
  const observed = running.catch(error => { settled = true; return error; });
  await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(2));
  expect(settled).toBe(false);
  release();
  expect(await observed).toMatchObject({ message: 'queue unavailable' });
});
