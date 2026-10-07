import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'vitest';
import type {
  Account,
  AccountRepository,
} from '../../src/modules/identity/index.js';

const ACCOUNT_A = 'IiIiIiIiIiIiIiIiIiIiIg';
const ACCOUNT_B = 'RERERERERERERERERERERA';
const CREATED_AT = new Date('2026-08-30T11:00:00.000Z');

export interface AccountRepositoryContractOptions {
  readonly name: string;
  readonly createRepository: () => AccountRepository | Promise<AccountRepository>;
  readonly reset?: () => void | Promise<void>;
}

function account(
  id: string,
  subjectId: string,
  email: string | null,
  overrides: Partial<Account> = {},
): Account {
  return {
    id,
    subjectId,
    status: 'active',
    email,
    securityEpoch: 0n,
    createdAt: CREATED_AT,
    deletedAt: null,
    ...overrides,
  };
}

function snapshot(value: Account): Account {
  return {
    ...value,
    createdAt: new Date(value.createdAt),
    deletedAt: value.deletedAt === null ? null : new Date(value.deletedAt),
  };
}

export function defineAccountRepositoryContract(
  options: AccountRepositoryContractOptions,
): void {
  describe(options.name, () => {
    beforeEach(async () => options.reset?.());

    test('inserts and resolves an account by id, subject, and exact email', async () => {
      const repository = await options.createRepository();
      const row = account(ACCOUNT_A, 'contract-account-subject-a', 'a@example.test');
      await repository.insert(row);

      assert.deepEqual(await repository.findById(row.id), snapshot(row));
      assert.deepEqual(await repository.findBySubjectId(row.subjectId), snapshot(row));
      assert.deepEqual(await repository.findByEmail(row.email!), snapshot(row));
      assert.equal(await repository.findByEmail('A@example.test'), null);
      assert.equal(await repository.findById('contract-account-missing'), null);
    });

    test('enforces uniqueness for id, subject, and non-null email', async () => {
      const repository = await options.createRepository();
      const winner = account(ACCOUNT_A, 'contract-account-subject-a', 'a@example.test');
      await repository.insert(winner);

      await assert.rejects(() => repository.insert(account(
        ACCOUNT_A,
        'contract-account-subject-b',
        'b@example.test',
      )));
      await assert.rejects(() => repository.insert(account(
        ACCOUNT_B,
        winner.subjectId,
        'b@example.test',
      )));
      await assert.rejects(() => repository.insert(account(
        ACCOUNT_B,
        'contract-account-subject-b',
        winner.email,
      )));
      assert.deepEqual(await repository.findById(ACCOUNT_A), snapshot(winner));
      assert.equal(await repository.findById(ACCOUNT_B), null);
    });

    test('atomically increments security epoch and rejects a missing account', async () => {
      const repository = await options.createRepository();
      await repository.insert(account(ACCOUNT_A, 'contract-account-subject-a', null, {
        securityEpoch: 5n,
      }));

      assert.equal(await repository.bumpSecurityEpoch(ACCOUNT_A), 6n);
      assert.equal(await repository.bumpSecurityEpoch(ACCOUNT_A), 7n);
      assert.equal((await repository.findById(ACCOUNT_A))?.securityEpoch, 7n);
      await assert.rejects(() => repository.bumpSecurityEpoch('contract-account-missing'));
    });

    test('moves the exact-email lookup and refuses to steal another account email', async () => {
      const repository = await options.createRepository();
      await repository.insert(account(ACCOUNT_A, 'contract-account-subject-a', 'old@example.test'));
      await repository.insert(account(ACCOUNT_B, 'contract-account-subject-b', 'held@example.test'));

      await repository.updateEmail(ACCOUNT_A, 'new@example.test');
      assert.equal(await repository.findByEmail('old@example.test'), null);
      assert.equal((await repository.findByEmail('new@example.test'))?.id, ACCOUNT_A);
      await assert.rejects(() => repository.updateEmail(ACCOUNT_A, 'held@example.test'));
      assert.equal((await repository.findByEmail('new@example.test'))?.id, ACCOUNT_A);

      await repository.updateEmail(ACCOUNT_A, null);
      assert.equal(await repository.findByEmail('new@example.test'), null);
      await assert.rejects(() => repository.updateEmail('contract-account-missing', null));
    });

    test('soft deletion clears the reusable email and records the deletion time', async () => {
      const repository = await options.createRepository();
      const deletedAt = new Date('2026-08-30T11:05:00.000Z');
      const row = account(ACCOUNT_A, 'contract-account-subject-a', 'reusable@example.test');
      await repository.insert(row);

      await repository.markDeleted(ACCOUNT_A, deletedAt);
      assert.deepEqual(await repository.findById(ACCOUNT_A), snapshot({
        ...row,
        status: 'deleted',
        email: null,
        deletedAt,
      }));
      assert.equal(await repository.findByEmail('reusable@example.test'), null);
      await assert.rejects(() => repository.markDeleted('contract-account-missing', deletedAt));
    });

    test('does not retain or expose caller-owned mutable dates', async () => {
      const repository = await options.createRepository();
      const createdAt = new Date(CREATED_AT);
      const row = account(ACCOUNT_A, 'contract-account-subject-a', null, { createdAt });
      const expected = snapshot(row);
      await repository.insert(row);

      createdAt.setUTCFullYear(2035);
      const first = await repository.findById(ACCOUNT_A);
      assert.deepEqual(first, expected);
      assert.ok(first);
      first.createdAt.setUTCFullYear(2040);
      assert.deepEqual(await repository.findById(ACCOUNT_A), expected);
    });
  });
}
