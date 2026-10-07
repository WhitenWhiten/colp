import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'vitest';
import type {
  Profile,
  ProfileRepository,
} from '../../src/modules/identity/index.js';

const ACCOUNT_ID = 'IiIiIiIiIiIiIiIiIiIiIg';
const UPDATED_AT = new Date('2026-08-30T10:00:00.000Z');

export interface ProfileRepositoryContractOptions {
  readonly name: string;
  readonly createRepository: () => ProfileRepository | Promise<ProfileRepository>;
  readonly reset?: () => void | Promise<void>;
}

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    accountId: ACCOUNT_ID,
    displayName: 'Contract Profile',
    avatarUrl: 'https://cdn.example.test/avatar.png',
    about: 'Profile repository contract',
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function snapshot(value: Profile): Profile {
  return { ...value, updatedAt: new Date(value.updatedAt) };
}

export function defineProfileRepositoryContract(
  options: ProfileRepositoryContractOptions,
): void {
  describe(options.name, () => {
    beforeEach(async () => options.reset?.());

    test('inserts and round-trips every profile field', async () => {
      const repository = await options.createRepository();
      const row = profile();

      assert.equal(await repository.findByAccountId(row.accountId), null);
      await repository.insert(row);
      assert.deepEqual(await repository.findByAccountId(row.accountId), snapshot(row));
    });

    test('rejects duplicate insert without replacing the winner', async () => {
      const repository = await options.createRepository();
      const winner = profile();
      await repository.insert(winner);

      await assert.rejects(() => repository.insert(profile({ displayName: 'Loser' })));
      assert.deepEqual(await repository.findByAccountId(winner.accountId), snapshot(winner));
    });

    test('updates all mutable fields and rejects an update for a missing profile', async () => {
      const repository = await options.createRepository();
      await repository.insert(profile());
      const replacement = profile({
        displayName: 'Updated Profile',
        avatarUrl: null,
        about: '',
        updatedAt: new Date('2026-08-30T10:05:00.000Z'),
      });

      await repository.update(replacement);
      assert.deepEqual(await repository.findByAccountId(ACCOUNT_ID), snapshot(replacement));
      await assert.rejects(() => repository.update(profile({ accountId: 'contract-missing-profile' })));
    });

    test('does not retain or expose caller-owned mutable dates', async () => {
      const repository = await options.createRepository();
      const updatedAt = new Date(UPDATED_AT);
      const row = profile({ updatedAt });
      const expected = snapshot(row);
      await repository.insert(row);

      updatedAt.setUTCFullYear(2035);
      const first = await repository.findByAccountId(ACCOUNT_ID);
      assert.deepEqual(first, expected);
      assert.ok(first);
      first.updatedAt.setUTCFullYear(2040);
      assert.deepEqual(await repository.findByAccountId(ACCOUNT_ID), expected);
    });
  });
}

export const PROFILE_REPOSITORY_CONTRACT_ACCOUNT_ID = ACCOUNT_ID;
