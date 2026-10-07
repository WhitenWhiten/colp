/**
 * Task A2 unit tests: business account mapping + concurrent account
 * establishment application logic, exercised over in-memory ports.
 *
 * Production surface:
 *   resolveBusinessAccountForAuthUser(ports, authUserId) → MappedBusinessAccount
 *   resolveMappedBusinessAccount(ports, mapping) → MappedBusinessAccount
 *   ensureBusinessAccountForVerifiedEmail(input, { unitOfWork }) → MappedBusinessAccount
 *
 * 假阳性防护: the ensure facade must NEVER adopt an existing account by email
 * unless a verified email proof or an explicit link command is present. The
 * "same email without proof creates a fresh account (no merge)" test fails as
 * soon as anyone adds an email-fallback merge branch.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  BusinessAccountMappingError,
  ensureBusinessAccountForVerifiedEmail,
  resolveBusinessAccountForAuthUser,
} from '../../../src/modules/auth/index.js';
import type { MappedBusinessAccount } from '../../../src/modules/identity/index.js';
import {
  createMemoryBusinessAccountPorts,
  createMemoryBusinessAccountUnitOfWork,
  createMemoryState,
  mapAccountRow,
  NOW,
  seedBusinessAccount,
} from '../../support/business-account-memory.js';

function expectMappingError(error: unknown, code: BusinessAccountMappingError['code']): asserts error is BusinessAccountMappingError {
  assert.ok(error instanceof BusinessAccountMappingError, `expected BusinessAccountMappingError, got ${String(error)}`);
  assert.equal(error.code, code);
}

describe('business-account-mapping application (in-memory ports)', () => {
  test('resolve returns the mapped account with profile and handle', async () => {
    const state = createMemoryState();
    const { account, handle } = seedBusinessAccount(state, { email: 'mapped@example.test' });
    const mapping = mapAccountRow(account);
    state.mappingsByAuthUser.set(mapping.authUserId, mapping);
    state.mappingsByAccount.set(mapping.accountId, mapping);

    const resolved = await resolveBusinessAccountForAuthUser(
      createMemoryBusinessAccountPorts(state),
      mapping.authUserId,
    );
    assert.equal(resolved.account.id, account.id);
    assert.equal(resolved.mapping.accountId, account.id);
    assert.equal(resolved.profile?.accountId, account.id);
    assert.equal(resolved.handle?.handle, handle.handle);
  });

  test('resolve classifies a missing mapping as mapping_missing', async () => {
    const state = createMemoryState();
    seedBusinessAccount(state);
    await assert.rejects(
      () => resolveBusinessAccountForAuthUser(createMemoryBusinessAccountPorts(state), 'ba-unknown'),
      (error: unknown) => {
        expectMappingError(error, 'mapping_missing');
        return true;
      },
    );
  });

  test('resolve classifies a mapping to a missing account row as account_not_found', async () => {
    const state = createMemoryState();
    state.mappingsByAuthUser.set('ba-user', { authUserId: 'ba-user', accountId: 'acct-missing', createdAt: NOW });
    await assert.rejects(
      () => resolveBusinessAccountForAuthUser(createMemoryBusinessAccountPorts(state), 'ba-user'),
      (error: unknown) => {
        expectMappingError(error, 'account_not_found');
        return true;
      },
    );
  });

  test('resolve classifies disabled accounts as account_disabled', async () => {
    const state = createMemoryState();
    const { account } = seedBusinessAccount(state, { email: 'disabled@example.test', status: 'disabled' });
    const mapping = mapAccountRow(account);
    state.mappingsByAuthUser.set(mapping.authUserId, mapping);
    state.mappingsByAccount.set(mapping.accountId, mapping);

    await assert.rejects(
      () => resolveBusinessAccountForAuthUser(createMemoryBusinessAccountPorts(state), mapping.authUserId),
      (error: unknown) => {
        expectMappingError(error, 'account_disabled');
        return true;
      },
    );
  });

  test('resolve classifies deleted accounts as account_deleted', async () => {
    const state = createMemoryState();
    const { account } = seedBusinessAccount(state, { email: 'deleted@example.test', status: 'deleted' });
    const mapping = mapAccountRow(account);
    state.mappingsByAuthUser.set(mapping.authUserId, mapping);
    state.mappingsByAccount.set(mapping.accountId, mapping);

    await assert.rejects(
      () => resolveBusinessAccountForAuthUser(createMemoryBusinessAccountPorts(state), mapping.authUserId),
      (error: unknown) => {
        expectMappingError(error, 'account_deleted');
        return true;
      },
    );
  });

  test('first verified email proof creates account, profile, handle and mapping and stores the email', async () => {
    const state = createMemoryState();
    const unitOfWork = createMemoryBusinessAccountUnitOfWork(state);
    const ensured = await ensureBusinessAccountForVerifiedEmail(
      { authUserId: 'ba-first', email: 'first@example.test', emailProofVerified: true, displayName: 'First User' },
      { unitOfWork },
    );
    assert.equal(ensured.mapping.authUserId, 'ba-first');
    assert.equal(ensured.account.status, 'active');
    assert.equal(ensured.account.email, 'first@example.test');
    assert.equal(ensured.profile?.displayName, 'First User');
    assert.ok(ensured.handle, 'fresh account must receive a profile handle');
    assert.equal(ensured.account.subjectId, 'ba-first');
    assert.equal(ensured.account.subjectId, ensured.mapping.authUserId);
    assert.equal(state.accounts.size, 1);
    assert.equal(state.profiles.size, 1);
    assert.equal(state.handlesByAccount.size, 1);
    assert.equal(state.mappingsByAuthUser.size, 1);
  });

  test('repeat request for the same auth user is idempotent', async () => {
    const state = createMemoryState();
    const unitOfWork = createMemoryBusinessAccountUnitOfWork(state);
    const input = { authUserId: 'ba-repeat', email: 'repeat@example.test', emailProofVerified: true };
    const first = await ensureBusinessAccountForVerifiedEmail(input, { unitOfWork });
    const second = await ensureBusinessAccountForVerifiedEmail(input, { unitOfWork });
    assert.equal(second.account.id, first.account.id);
    assert.equal(second.mapping.accountId, first.account.id);
    assert.equal(state.accounts.size, 1);
    assert.equal(state.mappingsByAuthUser.size, 1);
  });

  test('same email WITHOUT proof does NOT merge: a fresh account is created with no email stored', async () => {
    const state = createMemoryState();
    const unitOfWork = createMemoryBusinessAccountUnitOfWork(state);
    const holder = await ensureBusinessAccountForVerifiedEmail(
      { authUserId: 'ba-holder', email: 'shared@example.test', emailProofVerified: true },
      { unitOfWork },
    );
    const fresh = await ensureBusinessAccountForVerifiedEmail(
      { authUserId: 'ba-unproved', email: 'shared@example.test', emailProofVerified: false },
      { unitOfWork },
    );
    assert.notEqual(fresh.account.id, holder.account.id, 'unproved email must never adopt the existing account');
    assert.equal(fresh.account.email, null, 'unverified email must not be stored on the business account');
    assert.equal(fresh.account.subjectId, 'ba-unproved');
    assert.equal(holder.account.subjectId, 'ba-holder');
    assert.equal(state.accounts.size, 2);
    assert.equal(state.mappingsByAuthUser.size, 2);
    assert.equal(state.mappingsByAccount.get(holder.account.id)?.authUserId, 'ba-holder');
  });

  test('same email WITH verified proof adopts the existing account (mapping only)', async () => {
    const state = createMemoryState();
    const { account } = seedBusinessAccount(state, { email: 'adopt@example.test' });
    const unitOfWork = createMemoryBusinessAccountUnitOfWork(state);
    const ensured = await ensureBusinessAccountForVerifiedEmail(
      { authUserId: 'ba-adopter', email: 'adopt@example.test', emailProofVerified: true },
      { unitOfWork },
    );
    assert.equal(ensured.account.id, account.id);
    assert.equal(ensured.mapping.authUserId, 'ba-adopter');
    assert.equal(state.accounts.size, 1, 'adoption must not create a second account');
    assert.equal(state.profiles.size, 1, 'adoption must not create a second profile');
    assert.equal(state.handlesByAccount.size, 1, 'adoption must not create a second handle');
    assert.equal(state.mappingsByAuthUser.size, 1);
  });

  test('same email with an explicit link command adopts the existing account', async () => {
    const state = createMemoryState();
    const { account } = seedBusinessAccount(state, { email: 'link@example.test' });
    const unitOfWork = createMemoryBusinessAccountUnitOfWork(state);
    const ensured = await ensureBusinessAccountForVerifiedEmail(
      { authUserId: 'ba-linker', email: 'link@example.test', emailProofVerified: false, explicitLink: true },
      { unitOfWork },
    );
    assert.equal(ensured.account.id, account.id);
    assert.equal(state.accounts.size, 1);
  });

  test('adopting a disabled holder is a stable account_disabled error', async () => {
    const state = createMemoryState();
    seedBusinessAccount(state, { email: 'disabled@example.test', status: 'disabled' });
    const unitOfWork = createMemoryBusinessAccountUnitOfWork(state);
    await assert.rejects(
      () => ensureBusinessAccountForVerifiedEmail(
        { authUserId: 'ba-adopter', email: 'disabled@example.test', emailProofVerified: true },
        { unitOfWork },
      ),
      (error: unknown) => {
        expectMappingError(error, 'account_disabled');
        return true;
      },
    );
    assert.equal(state.mappingsByAuthUser.size, 0, 'failed adoption must not leave a mapping');
  });

  test('adopting a deleted holder is a stable account_deleted error', async () => {
    const state = createMemoryState();
    seedBusinessAccount(state, { email: 'deleted@example.test', status: 'deleted' });
    const unitOfWork = createMemoryBusinessAccountUnitOfWork(state);
    await assert.rejects(
      () => ensureBusinessAccountForVerifiedEmail(
        { authUserId: 'ba-adopter', email: 'deleted@example.test', emailProofVerified: true },
        { unitOfWork },
      ),
      (error: unknown) => {
        expectMappingError(error, 'account_deleted');
        return true;
      },
    );
  });

  test('requested handle collision is a stable handle_collision error and rolls back the fresh account', async () => {
    const state = createMemoryState();
    seedBusinessAccount(state, { id: 'acct-taken', handle: 'taken-handle' });
    const unitOfWork = createMemoryBusinessAccountUnitOfWork(state);
    await assert.rejects(
      () => ensureBusinessAccountForVerifiedEmail(
        { authUserId: 'ba-collide', email: 'collide@example.test', emailProofVerified: true, handle: 'taken-handle' },
        { unitOfWork },
      ),
      (error: unknown) => {
        expectMappingError(error, 'handle_collision');
        return true;
      },
    );
    assert.equal(state.accounts.size, 1, 'handle collision must roll back the provisional account');
    assert.equal(state.profiles.size, 1);
    assert.equal(state.handlesByAccount.size, 1);
    assert.equal(state.mappingsByAuthUser.size, 0);
  });

  test('concurrent same-user creation converges on the winner after duplicate_mapping', async () => {
    const state = createMemoryState();
    // The winner has already committed a full business account + mapping, but
    // our first transaction reads BEFORE the winner commits (masked lookup),
    // then hits the committed winner on the mapping insert — the real race
    // window. The winner holds no email, so the loser takes the fresh-create
    // path and its provisional account/profile/handle must roll back.
    const { account } = seedBusinessAccount(state, { id: 'acct-winner' });
    const winnerMapping = mapAccountRow(account);
    state.mappingsByAuthUser.set(winnerMapping.authUserId, winnerMapping);
    state.mappingsByAccount.set(winnerMapping.accountId, winnerMapping);

    const unitOfWork = createMemoryBusinessAccountUnitOfWork(state, {
      maskFirstLookupOf: winnerMapping.authUserId,
    });
    const ensured = await ensureBusinessAccountForVerifiedEmail(
      { authUserId: winnerMapping.authUserId, email: 'race@example.test', emailProofVerified: true },
      { unitOfWork },
    );
    assert.equal(ensured.account.id, account.id, 'race loser must converge on the winner account');
    assert.equal(ensured.mapping.authUserId, winnerMapping.authUserId);
    assert.equal(state.accounts.size, 1, 'loser provisional account must be rolled back');
    assert.equal(state.profiles.size, 1, 'loser provisional profile must be rolled back');
    assert.equal(state.handlesByAccount.size, 1, 'loser provisional handle must be rolled back');
    assert.equal(state.mappingsByAuthUser.size, 1);
  });

  test('account already mapped to another auth user stays a stable duplicate_mapping error', async () => {
    const state = createMemoryState();
    const { account } = seedBusinessAccount(state, { id: 'acct-owned', email: 'owned@example.test' });
    const ownerMapping = mapAccountRow(account);
    state.mappingsByAuthUser.set(ownerMapping.authUserId, ownerMapping);
    state.mappingsByAccount.set(ownerMapping.accountId, ownerMapping);

    const unitOfWork = createMemoryBusinessAccountUnitOfWork(state);
    await assert.rejects(
      () => ensureBusinessAccountForVerifiedEmail(
        { authUserId: 'ba-intruder', email: 'owned@example.test', emailProofVerified: true },
        { unitOfWork },
      ),
      (error: unknown) => {
        expectMappingError(error, 'duplicate_mapping');
        return true;
      },
    );
    assert.equal(state.accounts.size, 1, 'conflicting adoption must not create or attach anything');
    assert.equal(state.mappingsByAuthUser.size, 1);
  });

  test('a concurrent account insert for the same email is a stable email_conflict error', async () => {
    const state = createMemoryState();
    const unitOfWork = createMemoryBusinessAccountUnitOfWork(state, { injectAccountInsertConflict: true });
    await assert.rejects(
      () => ensureBusinessAccountForVerifiedEmail(
        { authUserId: 'ba-conflict', email: 'conflict@example.test', emailProofVerified: true },
        { unitOfWork },
      ),
      (error: unknown) => {
        expectMappingError(error, 'email_conflict');
        return true;
      },
    );
    assert.equal(state.accounts.size, 0, 'email conflict must roll back the provisional account');
  });

  test('fresh account subjectId equals the bound Better Auth user id', async () => {
    const state = createMemoryState();
    const unitOfWork = createMemoryBusinessAccountUnitOfWork(state);
    const ensured = await ensureBusinessAccountForVerifiedEmail(
      { authUserId: 'ba-bound-user', email: 'bound@example.test', emailProofVerified: true },
      { unitOfWork },
    );
    assert.equal(ensured.account.subjectId, 'ba-bound-user');
    assert.equal(ensured.mapping.authUserId, 'ba-bound-user');
    assert.notEqual(ensured.account.subjectId, '');
    assert.notEqual(ensured.account.subjectId, ensured.account.id);
  });
});

describe('business-account-mapping MappedBusinessAccount shape', () => {
  test('MappedBusinessAccount carries mapping, account, profile and handle', async () => {
    const state = createMemoryState();
    const { account, handle } = seedBusinessAccount(state, { email: 'shape@example.test' });
    const mapping = mapAccountRow(account);
    state.mappingsByAuthUser.set(mapping.authUserId, mapping);
    state.mappingsByAccount.set(mapping.accountId, mapping);

    const resolved: MappedBusinessAccount = await resolveBusinessAccountForAuthUser(
      createMemoryBusinessAccountPorts(state),
      mapping.authUserId,
    );
    assert.equal(resolved.mapping.authUserId, mapping.authUserId);
    assert.equal(resolved.account.subjectId, account.subjectId);
    assert.equal(resolved.profile?.accountId, account.id);
    assert.equal(resolved.handle?.accountId, handle.accountId);
  });
});
