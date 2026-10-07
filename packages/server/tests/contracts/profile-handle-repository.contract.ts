import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'vitest';
import type {
  ProfileHandle,
  ProfileHandleRepository,
} from '../../src/modules/identity/index.js';

const ACCOUNT_A = 'IiIiIiIiIiIiIiIiIiIiIg';
const ACCOUNT_B = 'RERERERERERERERERERERA';
const CREATED_AT = new Date('2026-08-30T10:30:00.000Z');

export interface ProfileHandleRepositoryContractOptions {
  readonly name: string;
  readonly createRepository: () => ProfileHandleRepository | Promise<ProfileHandleRepository>;
  readonly reset?: () => void | Promise<void>;
}

function handle(
  value: string,
  accountId: string,
  overrides: Partial<ProfileHandle> = {},
): ProfileHandle {
  return {
    handle: value,
    accountId,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function snapshot(value: ProfileHandle): ProfileHandle {
  return { ...value, createdAt: new Date(value.createdAt) };
}

export function defineProfileHandleRepositoryContract(
  options: ProfileHandleRepositoryContractOptions,
): void {
  describe(options.name, () => {
    beforeEach(async () => options.reset?.());

    test('inserts and resolves the same row through both unique identities', async () => {
      const repository = await options.createRepository();
      const row = handle('contract_handle_a', ACCOUNT_A);
      await repository.insert(row);

      assert.deepEqual(await repository.findByHandle(row.handle), snapshot(row));
      assert.deepEqual(await repository.findByAccountId(row.accountId), snapshot(row));
      assert.equal(await repository.findByHandle('contract_missing'), null);
      assert.equal(await repository.findByAccountId('contract-missing-account'), null);
    });

    test('insert rejects conflicts on either handle or account without replacing the winner', async () => {
      const repository = await options.createRepository();
      const winner = handle('contract_handle_a', ACCOUNT_A);
      await repository.insert(winner);

      await assert.rejects(() => repository.insert(handle(winner.handle, ACCOUNT_B)));
      await assert.rejects(() => repository.insert(handle('contract_handle_b', ACCOUNT_A)));
      assert.deepEqual(await repository.findByHandle(winner.handle), snapshot(winner));
      assert.equal(await repository.findByHandle('contract_handle_b'), null);
    });

    test('tryInsert reports both conflict classes without throwing', async () => {
      const repository = await options.createRepository();
      const winner = handle('contract_handle_a', ACCOUNT_A);

      assert.equal(await repository.tryInsert(winner), true);
      assert.equal(await repository.tryInsert(handle(winner.handle, ACCOUNT_B)), false);
      assert.equal(await repository.tryInsert(handle('contract_handle_b', ACCOUNT_A)), false);
      assert.equal(await repository.tryInsert(handle('contract_handle_b', ACCOUNT_B)), true);
    });

    test('deletes through either identity and keeps both indexes consistent', async () => {
      const repository = await options.createRepository();
      const rowA = handle('contract_handle_a', ACCOUNT_A);
      const rowB = handle('contract_handle_b', ACCOUNT_B);
      await repository.insert(rowA);
      await repository.insert(rowB);

      assert.equal(await repository.deleteByHandle(rowA.handle), true);
      assert.equal(await repository.deleteByHandle(rowA.handle), false);
      assert.equal(await repository.findByAccountId(ACCOUNT_A), null);

      assert.equal(await repository.deleteByAccountId(ACCOUNT_B), true);
      assert.equal(await repository.deleteByAccountId(ACCOUNT_B), false);
      assert.equal(await repository.findByHandle(rowB.handle), null);
    });

    test('does not retain or expose caller-owned mutable dates', async () => {
      const repository = await options.createRepository();
      const createdAt = new Date(CREATED_AT);
      const row = handle('contract_handle_a', ACCOUNT_A, { createdAt });
      const expected = snapshot(row);
      await repository.insert(row);

      createdAt.setUTCFullYear(2035);
      const first = await repository.findByHandle(row.handle);
      assert.deepEqual(first, expected);
      assert.ok(first);
      first.createdAt.setUTCFullYear(2040);
      assert.deepEqual(await repository.findByHandle(row.handle), expected);
    });
  });
}

export const PROFILE_HANDLE_CONTRACT_ACCOUNTS = Object.freeze([ACCOUNT_A, ACCOUNT_B]);
