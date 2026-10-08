/**
 * S-03: mapping-exists product email sync (fill-null, no unproved write,
 * email_conflict, session must not rewrite a different address, P9 rewrite).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  BusinessAccountMappingError,
  ensureBusinessAccountForVerifiedEmail,
  type BusinessAccountUnitOfWork,
} from '../../../src/modules/auth/index.js';
import {
  createMemoryBusinessAccountUnitOfWork,
  createMemoryState,
  mapAccountRow,
  seedBusinessAccount,
} from '../../support/business-account-memory.js';

function expectMappingError(error: unknown, code: BusinessAccountMappingError['code']): asserts error is BusinessAccountMappingError {
  assert.ok(error instanceof BusinessAccountMappingError, `expected BusinessAccountMappingError, got ${String(error)}`);
  assert.equal(error.code, code);
}

/** Replaces only the in-transaction bump so a throw uses the fake's rollback. */
function unitOfWorkFailingEpochBump(state: ReturnType<typeof createMemoryState>): BusinessAccountUnitOfWork {
  const inner = createMemoryBusinessAccountUnitOfWork(state);
  return {
    execute(work) {
      return inner.execute((ports) => work({
        ...ports,
        accounts: {
          ...ports.accounts,
          bumpSecurityEpoch() {
            return Promise.reject(new Error('security epoch bump failed'));
          },
        },
      }));
    },
  };
}

function mapExisting(state: ReturnType<typeof createMemoryState>, accountId: string) {
  const account = state.accounts.get(accountId);
  assert.ok(account);
  const mapping = mapAccountRow(account);
  state.mappingsByAuthUser.set(mapping.authUserId, mapping);
  state.mappingsByAccount.set(mapping.accountId, mapping);
  return mapping;
}

describe('business account verified email sync (mapping already exists)', () => {
  test('proof fills a null product email', async () => {
    const state = createMemoryState();
    const { account } = seedBusinessAccount(state, { id: 'acct-null' });
    const mapping = mapExisting(state, account.id);
    const ensured = await ensureBusinessAccountForVerifiedEmail(
      { authUserId: mapping.authUserId, email: 'filled@example.test', emailProofVerified: true },
      { unitOfWork: createMemoryBusinessAccountUnitOfWork(state) },
    );
    assert.equal(ensured.account.email, 'filled@example.test');
    assert.equal(state.accounts.get(account.id)?.email, 'filled@example.test');
    assert.equal(ensured.account.securityEpoch, 0n, 'filling a null email is not an email change');
    assert.equal(state.accounts.get(account.id)?.securityEpoch, 0n);
  });

  test('WITHOUT proof leaves a null product email', async () => {
    const state = createMemoryState();
    const { account } = seedBusinessAccount(state, { id: 'acct-unproved' });
    const mapping = mapExisting(state, account.id);
    const ensured = await ensureBusinessAccountForVerifiedEmail(
      { authUserId: mapping.authUserId, email: 'later@example.test', emailProofVerified: false },
      { unitOfWork: createMemoryBusinessAccountUnitOfWork(state) },
    );
    assert.equal(ensured.account.email, null);
    assert.equal(state.accounts.get(account.id)?.email, null);
  });

  test('explicit link fills a null product email', async () => {
    const state = createMemoryState();
    const { account } = seedBusinessAccount(state, { id: 'acct-link' });
    const mapping = mapExisting(state, account.id);
    const ensured = await ensureBusinessAccountForVerifiedEmail(
      {
        authUserId: mapping.authUserId,
        email: 'linked@example.test',
        emailProofVerified: false,
        explicitLink: true,
      },
      { unitOfWork: createMemoryBusinessAccountUnitOfWork(state) },
    );
    assert.equal(ensured.account.email, 'linked@example.test');
    assert.equal(ensured.account.securityEpoch, 0n, 'filling a null email on explicit link is not an email change');
  });

  test('filling a null email held by another account is email_conflict', async () => {
    const state = createMemoryState();
    seedBusinessAccount(state, { id: 'acct-holder', email: 'taken@example.test' });
    const { account } = seedBusinessAccount(state, { id: 'acct-empty' });
    const mapping = mapExisting(state, account.id);
    await assert.rejects(
      () => ensureBusinessAccountForVerifiedEmail(
        { authUserId: mapping.authUserId, email: 'taken@example.test', emailProofVerified: true },
        { unitOfWork: createMemoryBusinessAccountUnitOfWork(state) },
      ),
      (error: unknown) => {
        expectMappingError(error, 'email_conflict');
        return true;
      },
    );
    assert.equal(state.accounts.get(account.id)?.email, null, 'conflict must not steal the holder email');
    assert.equal(state.accounts.get('acct-holder')?.email, 'taken@example.test');
  });

  test('session-style proof does not rewrite a different existing product email', async () => {
    const state = createMemoryState();
    const { account } = seedBusinessAccount(state, { id: 'acct-p9', email: 'old@example.test' });
    const mapping = mapExisting(state, account.id);
    const ensured = await ensureBusinessAccountForVerifiedEmail(
      { authUserId: mapping.authUserId, email: 'new@example.test', emailProofVerified: true },
      { unitOfWork: createMemoryBusinessAccountUnitOfWork(state) },
    );
    assert.equal(ensured.account.email, 'old@example.test');
    assert.equal(state.accounts.get(account.id)?.securityEpoch, 0n);
  });

  test('allowEmailChange rewrites product email onto the mapped account', async () => {
    const state = createMemoryState();
    const { account } = seedBusinessAccount(state, { id: 'acct-change', email: 'old@example.test' });
    const mapping = mapExisting(state, account.id);
    const ensured = await ensureBusinessAccountForVerifiedEmail(
      {
        authUserId: mapping.authUserId,
        email: 'New@example.test',
        emailProofVerified: true,
        allowEmailChange: true,
      },
      { unitOfWork: createMemoryBusinessAccountUnitOfWork(state) },
    );
    assert.equal(ensured.account.email, 'new@example.test');
    assert.equal(ensured.account.securityEpoch, 1n, 'a replaced address bumps security_epoch once');
    assert.equal(state.accounts.get(account.id)?.securityEpoch, 1n);
    assert.equal(state.accountsByEmail.get('old@example.test'), undefined);
    assert.equal(state.accountsByEmail.get('new@example.test')?.id, account.id);
  });

  test('verifying the same email does not bump security_epoch', async () => {
    const state = createMemoryState();
    const { account } = seedBusinessAccount(state, { id: 'acct-same', email: 'same@example.test' });
    const mapping = mapExisting(state, account.id);
    const ensured = await ensureBusinessAccountForVerifiedEmail(
      {
        authUserId: mapping.authUserId,
        email: 'Same@example.test',
        emailProofVerified: true,
        allowEmailChange: true,
      },
      { unitOfWork: createMemoryBusinessAccountUnitOfWork(state) },
    );
    assert.equal(ensured.account.email, 'same@example.test');
    assert.equal(ensured.account.securityEpoch, 0n);
    assert.equal(state.accounts.get(account.id)?.securityEpoch, 0n);
  });

  test('creating an account does not bump security_epoch', async () => {
    const state = createMemoryState();
    const ensured = await ensureBusinessAccountForVerifiedEmail(
      { authUserId: 'ba-create', email: 'create@example.test', emailProofVerified: true },
      { unitOfWork: createMemoryBusinessAccountUnitOfWork(state) },
    );
    assert.equal(ensured.account.email, 'create@example.test');
    assert.equal(ensured.account.securityEpoch, 0n);
    assert.equal(state.accounts.get(ensured.account.id)?.securityEpoch, 0n);
  });

  test('allowEmailChange revokes pending unbound invites for the old mailbox only', async () => {
    const state = createMemoryState();
    const { account } = seedBusinessAccount(state, { id: 'acct-invite-change', email: 'old@example.test' });
    const mapping = mapExisting(state, account.id);
    state.pendingUnboundInvites.push(
      { emailNormalized: 'old@example.test', invitedSubjectId: null, status: 'pending', resolvedAt: null },
      { emailNormalized: 'old@example.test', invitedSubjectId: 'subject-bound', status: 'pending', resolvedAt: null },
      { emailNormalized: 'new@example.test', invitedSubjectId: null, status: 'pending', resolvedAt: null },
    );
    await ensureBusinessAccountForVerifiedEmail(
      {
        authUserId: mapping.authUserId,
        email: 'new@example.test',
        emailProofVerified: true,
        allowEmailChange: true,
      },
      { unitOfWork: createMemoryBusinessAccountUnitOfWork(state) },
    );
    assert.equal(state.pendingUnboundInvites[0]?.status, 'revoked');
    assert.equal(state.pendingUnboundInvites[1]?.status, 'pending', 'bound invites stay subject-bound');
    assert.equal(state.pendingUnboundInvites[2]?.status, 'pending', 'new mailbox invites are not destroyed');
    assert.equal(
      state.pendingUnboundInvites.some((row) => (
        row.emailNormalized === 'old@example.test'
        && row.invitedSubjectId === null
        && row.status === 'pending'
      )),
      false,
      'a later account on the old mailbox must not find a pending unbound invite',
    );
  });

  test('allowEmailChange onto an occupied mailbox is email_conflict', async () => {
    const state = createMemoryState();
    seedBusinessAccount(state, { id: 'acct-holder', email: 'taken@example.test' });
    const { account } = seedBusinessAccount(state, { id: 'acct-change', email: 'old@example.test' });
    const mapping = mapExisting(state, account.id);
    await assert.rejects(
      () => ensureBusinessAccountForVerifiedEmail(
        {
          authUserId: mapping.authUserId,
          email: 'taken@example.test',
          emailProofVerified: true,
          allowEmailChange: true,
        },
        { unitOfWork: createMemoryBusinessAccountUnitOfWork(state) },
      ),
      (error: unknown) => {
        expectMappingError(error, 'email_conflict');
        return true;
      },
    );
    assert.equal(state.accounts.get(account.id)?.email, 'old@example.test');
    assert.equal(state.accounts.get(account.id)?.securityEpoch, 0n);
  });

  test('address replacement rolls back when the in-transaction security_epoch bump throws', async () => {
    const state = createMemoryState();
    const { account } = seedBusinessAccount(state, { id: 'acct-epoch-fail', email: 'old@example.test' });
    const mapping = mapExisting(state, account.id);
    await assert.rejects(
      () => ensureBusinessAccountForVerifiedEmail(
        {
          authUserId: mapping.authUserId,
          email: 'new@example.test',
          emailProofVerified: true,
          allowEmailChange: true,
        },
        { unitOfWork: unitOfWorkFailingEpochBump(state) },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /security epoch bump failed/);
        return true;
      },
    );
    assert.equal(
      state.accounts.get(account.id)?.email,
      'old@example.test',
      'the email write shares the transaction with the epoch bump',
    );
    assert.equal(state.accountsByEmail.get('old@example.test')?.id, account.id);
    assert.equal(state.accountsByEmail.get('new@example.test'), undefined);
    assert.equal(state.accounts.get(account.id)?.securityEpoch, 0n);
  });
});
