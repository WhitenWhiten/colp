/**
 * A completed provider link raises provider_link once. Split from
 * account-linking.test.ts so that suite stays inside its granularity ceiling.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  createProviderLinkEpochHandler,
  observeCompletedProviderAccount,
  withoutProviderLinkEpoch,
} from '../../../src/modules/auth/index.js';
import {
  createMemoryBusinessAccountUnitOfWork,
  createMemoryState,
  mapAccountRow,
  seedBusinessAccount,
} from '../../support/business-account-memory.js';

describe('completed provider link raises provider_link once', () => {
  test('occupancy adopt does not raise provider_link again for the link it just made', async () => {
    let raised = false;
    await withoutProviderLinkEpoch('auth-user', () => observeCompletedProviderAccount({
      account: { providerId: 'google', userId: 'auth-user' },
      accountCount: async () => 2,
      raiseProviderLink: async () => { raised = true; },
    }));
    assert.equal(raised, false);
  });

  test('a second non-credential account raises; credential insert, sole account, and a password row do not', async () => {
    const raised: string[] = [];
    const raise = async (authUserId: string) => {
      raised.push(authUserId);
    };
    await observeCompletedProviderAccount({
      account: { providerId: 'google', userId: 'auth-user', password: null },
      accountCount: async () => 2,
      raiseProviderLink: raise,
    });
    await observeCompletedProviderAccount({
      account: { providerId: 'credential', userId: 'auth-user', password: 'hash' },
      accountCount: async () => {
        throw new Error('password reset must not count accounts for provider_link');
      },
      raiseProviderLink: async () => {
        throw new Error('password reset must not raise provider_link');
      },
    });
    await observeCompletedProviderAccount({
      account: { providerId: 'google', userId: 'auth-user', password: null },
      accountCount: async () => 1,
      raiseProviderLink: async () => {
        throw new Error('account creation must not raise provider_link');
      },
    });
    await observeCompletedProviderAccount({
      account: { providerId: 'google', userId: 'auth-user', password: 'hash' },
      accountCount: async () => {
        throw new Error('a password insert must not count accounts for provider_link');
      },
      raiseProviderLink: async () => {
        throw new Error('a password insert must not raise provider_link');
      },
    });
    assert.deepEqual(raised, ['auth-user']);
  });

  test('the completion handler raises provider_link for the mapped account', async () => {
    const state = createMemoryState();
    const { account } = seedBusinessAccount(state, { id: 'acct-link' });
    const mapping = mapAccountRow(account);
    state.mappingsByAuthUser.set(mapping.authUserId, mapping);
    state.mappingsByAccount.set(mapping.accountId, mapping);
    const events: Array<{ event: string; accountId: string }> = [];
    const handler = createProviderLinkEpochHandler({
      businessAccount: createMemoryBusinessAccountUnitOfWork(state),
      securityEpochBridge: {
        async raiseAccountSecurityEvent(event, accountId) {
          events.push({ event, accountId });
          const stored = state.accounts.get(accountId);
          if (!stored) throw new Error('missing account');
          const securityEpoch = stored.securityEpoch + 1n;
          state.accounts.set(accountId, { ...stored, securityEpoch });
          return { securityEpoch, revokedAuthSessions: 1, revokedLegacySessions: 0 };
        },
      },
    });
    await observeCompletedProviderAccount({
      account: { providerId: 'github', userId: mapping.authUserId, password: null },
      accountCount: async () => 2,
      raiseProviderLink: async (authUserId) => {
        await handler({ authUserId });
      },
    });
    assert.deepEqual(events, [{ event: 'provider_link', accountId: account.id }]);
    assert.equal(state.accounts.get(account.id)?.securityEpoch, 1n);
  });
});
