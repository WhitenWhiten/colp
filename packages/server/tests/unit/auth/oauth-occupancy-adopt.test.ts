/**
 * P1 unit contract: verified-OAuth adopt of unverified occupancy is a
 * narrow exception to disableImplicitLinking, not an ADR reversal.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  createOAuthOccupancyAdoptedHandler,
  decideOAuthOccupancyAdopt,
  executeOAuthOccupancyAdopt,
  isOAuthCallbackPath,
  nextOAuthOccupancyAdoptProfile,
  OAuthOccupancyAdoptError,
  overlayOAuthOccupancyAdoptProfile,
  type OAuthOccupancyAdoptAccountRow,
  type OAuthOccupancyAdoptAdapterPort,
} from '../../../src/modules/auth/application/oauth-occupancy-adopt.js';
import type { SecurityEpochBridge } from '../../../src/modules/auth/application/security-epoch-bridge.js';
import type { Profile } from '../../../src/modules/identity/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('decideOAuthOccupancyAdopt', () => {
  test('unverified occupancy + verified provider adopts the existing row', () => {
    assert.equal(
      decideOAuthOccupancyAdopt({
        occupancy: { emailVerified: false },
        providerEmailVerified: true,
      }),
      'adopt',
    );
  });

  test('verified occupancy + verified provider refuses (G0, no implicit merge)', () => {
    assert.equal(
      decideOAuthOccupancyAdopt({
        occupancy: { emailVerified: true },
        providerEmailVerified: true,
      }),
      'refuse',
    );
  });

  test('unoccupied email + verified provider creates a new user', () => {
    assert.equal(
      decideOAuthOccupancyAdopt({
        occupancy: null,
        providerEmailVerified: true,
      }),
      'create',
    );
  });

  test('unverified occupancy + unverified provider refuses (no mailbox proof)', () => {
    assert.equal(
      decideOAuthOccupancyAdopt({
        occupancy: { emailVerified: false },
        providerEmailVerified: false,
      }),
      'refuse',
    );
  });

  test('verified occupancy + unverified provider refuses', () => {
    assert.equal(
      decideOAuthOccupancyAdopt({
        occupancy: { emailVerified: true },
        providerEmailVerified: false,
      }),
      'refuse',
    );
  });
});

describe('isOAuthCallbackPath', () => {
  test('matches the built-in social and genericOAuth callback paths', () => {
    assert.equal(isOAuthCallbackPath('/callback/google'), true);
    assert.equal(isOAuthCallbackPath('/callback/:id'), true);
    assert.equal(isOAuthCallbackPath('/oauth2/callback/github'), true);
    assert.equal(isOAuthCallbackPath('/oauth2/callback/:providerId'), true);
    assert.equal(isOAuthCallbackPath('/sign-in/email'), false);
    assert.equal(isOAuthCallbackPath('/sign-up/email'), false);
    assert.equal(isOAuthCallbackPath(undefined), false);
  });
});

describe('executeOAuthOccupancyAdopt', () => {
  const userId = 'user-1';
  const googleAccount = {
    providerId: 'google',
    accountId: 'google-sub-1',
    accessToken: 'tok',
  };

  function seedCredential(): OAuthOccupancyAdoptAccountRow[] {
    return [
      { id: 'cred-row-1', providerId: 'credential', accountId: userId },
    ];
  }

  function createFakeAdapter(input: {
    readonly accounts: OAuthOccupancyAdoptAccountRow[];
    readonly fail?: 'find' | 'delete' | 'link' | 'update';
  }): OAuthOccupancyAdoptAdapterPort & { readonly log: string[] } {
    const accounts = [...input.accounts];
    const log: string[] = [];
    return {
      log,
      async findAccounts() {
        if (input.fail === 'find') throw new Error('findAccounts failed');
        log.push('find');
        return [...accounts];
      },
      async deleteAccount(id) {
        if (input.fail === 'delete') throw new Error('deleteAccount failed');
        log.push(`delete:${id}`);
        const index = accounts.findIndex((row) => row.id === id);
        if (index >= 0) accounts.splice(index, 1);
      },
      async linkAccount(account) {
        if (input.fail === 'link') throw new Error('linkAccount failed');
        log.push('link');
        accounts.push({
          id: 'google-row-1',
          providerId: String(account.providerId ?? ''),
          accountId: String(account.accountId ?? ''),
        });
        return { id: 'google-row-1' };
      },
      async updateUser() {
        if (input.fail === 'update') throw new Error('updateUser failed');
        log.push('update');
        return { id: userId, emailVerified: true };
      },
    };
  }

  test('unlinks credential, revokes, then links and verifies (fail-closed order)', async () => {
    const adapter = createFakeAdapter({ accounts: seedCredential() });
    const sideEffects: string[] = [];
    const result = await executeOAuthOccupancyAdopt({
      userId,
      existingUser: { id: userId, emailVerified: false },
      providerUser: { name: 'Victim', emailVerified: true, image: 'https://cdn.example/a.png' },
      account: googleAccount,
      adapter,
      onAdopted: async () => {
        sideEffects.push('revoke');
      },
    });
    assert.equal(result.user.emailVerified, true);
    assert.deepEqual(
      adapter.log.filter((step) => step !== 'find'),
      ['delete:cred-row-1', 'link', 'update'],
    );
    assert.deepEqual(sideEffects, ['revoke']);
    const remaining = await adapter.findAccounts(userId);
    assert.deepEqual(remaining, [
      { id: 'google-row-1', providerId: 'google', accountId: 'google-sub-1' },
    ]);
  });

  test('missing onAdopted throws before any adapter write', async () => {
    const adapter = createFakeAdapter({ accounts: seedCredential() });
    await assert.rejects(
      () => executeOAuthOccupancyAdopt({
        userId,
        existingUser: { id: userId, emailVerified: false },
        providerUser: { name: 'Victim', emailVerified: true },
        account: googleAccount,
        adapter,
      }),
      (error: unknown) => error instanceof OAuthOccupancyAdoptError
        && error.message.includes('session revoke wiring'),
    );
    assert.deepEqual(adapter.log, []);
    assert.equal((await adapter.findAccounts(userId)).some((row) => row.providerId === 'credential'), true);
  });

  test('onAdopted failure unlinks the password and does not link the provider', async () => {
    const adapter = createFakeAdapter({ accounts: seedCredential() });
    await assert.rejects(
      () => executeOAuthOccupancyAdopt({
        userId,
        existingUser: { id: userId, emailVerified: false },
        providerUser: { name: 'Victim', emailVerified: true },
        account: googleAccount,
        adapter,
        onAdopted: async () => {
          throw new Error('revokeAll failed');
        },
      }),
      (error: unknown) => error instanceof OAuthOccupancyAdoptError
        && error.message.includes('revoke existing sessions'),
    );
    assert.equal(adapter.log.includes('link'), false);
    assert.equal(adapter.log.includes('update'), false);
    const remaining = await adapter.findAccounts(userId);
    assert.equal(remaining.some((row) => row.providerId === 'credential'), false);
    assert.equal(remaining.some((row) => row.providerId === 'google'), false);
  });

  test('linkAccount failure does not mark emailVerified', async () => {
    const adapter = createFakeAdapter({ accounts: seedCredential(), fail: 'link' });
    await assert.rejects(
      () => executeOAuthOccupancyAdopt({
        userId,
        existingUser: { id: userId, emailVerified: false },
        providerUser: { name: 'Victim', emailVerified: true },
        account: googleAccount,
        adapter,
        onAdopted: async () => undefined,
      }),
      (error: unknown) => error instanceof OAuthOccupancyAdoptError
        && error.message.includes('link the verified provider'),
    );
    assert.equal(adapter.log.includes('update'), false);
    assert.equal((await adapter.findAccounts(userId)).some((row) => row.providerId === 'google'), false);
  });

  test('updateUser failure unlinks the just-linked provider and leaves email unverified', async () => {
    const adapter = createFakeAdapter({ accounts: seedCredential(), fail: 'update' });
    await assert.rejects(
      () => executeOAuthOccupancyAdopt({
        userId,
        existingUser: { id: userId, emailVerified: false },
        providerUser: { name: 'Victim', emailVerified: true },
        account: googleAccount,
        adapter,
        onAdopted: async () => undefined,
      }),
      (error: unknown) => error instanceof OAuthOccupancyAdoptError
        && error.message.includes('mark the mailbox verified'),
    );
    const remaining = await adapter.findAccounts(userId);
    assert.equal(remaining.some((row) => row.providerId === 'google'), false, 'compensate must drop the linked provider');
    assert.equal(remaining.some((row) => row.providerId === 'credential'), false, 'password stays invalidated');
  });
});

describe('nextOAuthOccupancyAdoptProfile', () => {
  const now = new Date('2026-08-19T00:00:00.000Z');

  test('fills empty name/image and clears a squatter about', () => {
    const profile: Profile = {
      accountId: 'acct-1',
      displayName: '',
      avatarUrl: null,
      about: 'squatter bio',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const next = nextOAuthOccupancyAdoptProfile(
      profile,
      { name: 'Victim Name', image: 'https://cdn.example/avatar.png' },
      now,
    );
    assert.equal(next.displayName, 'Victim Name');
    assert.equal(next.avatarUrl, 'https://cdn.example/avatar.png');
    assert.equal(next.about, '');
    assert.equal(next.updatedAt, now);
  });

  test('does not overwrite a non-empty displayName', () => {
    const profile: Profile = {
      accountId: 'acct-1',
      displayName: 'Already Set',
      avatarUrl: null,
      about: '',
      updatedAt: now,
    };
    const next = nextOAuthOccupancyAdoptProfile(
      profile,
      { name: 'Provider', image: null },
      now,
    );
    assert.equal(next, profile);
  });

  test('clears about without replacing a filled displayName', () => {
    const profile: Profile = {
      accountId: 'acct-1',
      displayName: 'Squatter',
      avatarUrl: null,
      about: 'squatter bio',
      updatedAt: now,
    };
    const next = nextOAuthOccupancyAdoptProfile(
      profile,
      { name: 'Victim', image: null },
      now,
    );
    assert.equal(next.displayName, 'Squatter');
    assert.equal(next.about, '');
  });

  test('overlayOAuthOccupancyAdoptProfile writes through the ports', async () => {
    const stored: Profile = {
      accountId: 'acct-1',
      displayName: '',
      avatarUrl: null,
      about: 'takeover copy',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const now = new Date('2026-08-19T00:00:00.000Z');
    await overlayOAuthOccupancyAdoptProfile(
      {
        profiles: {
          async findByAccountId() { return stored; },
          async insert() { throw new Error('insert unused'); },
          async update(next) { Object.assign(stored, next); },
        },
        clock: { async now() { return now; } },
      },
      'acct-1',
      { name: 'Victim', image: null },
    );
    assert.equal(stored.displayName, 'Victim');
    assert.equal(stored.about, '');
    assert.equal(stored.updatedAt, now);
  });
});

describe('createOAuthOccupancyAdoptedHandler', () => {
  test('raises oauth_occupancy_adopt on the security-epoch bridge then overlays the profile', async () => {
    const events: Array<{ event: string; accountId: string }> = [];
    const stored: Profile = {
      accountId: 'acct-adopt',
      displayName: '',
      avatarUrl: null,
      about: 'squatter',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const now = new Date('2026-08-19T00:00:00.000Z');
    const ports = {
      mappings: {
        async findByAuthUserId(authUserId: string) {
          assert.equal(authUserId, 'auth-user-1');
          return { authUserId, accountId: 'acct-adopt', createdAt: now };
        },
      },
      profiles: {
        async findByAccountId() { return stored; },
        async insert() { throw new Error('insert unused'); },
        async update(next: Profile) { Object.assign(stored, next); },
      },
      clock: { async now() { return now; } },
    };
    const handler = createOAuthOccupancyAdoptedHandler({
      businessAccount: {
        async execute(work) {
          return work(ports as never);
        },
      },
      securityEpochBridge: {
        async raiseAccountSecurityEvent(event, accountId) {
          events.push({ event, accountId });
          return { securityEpoch: 1n, revokedAuthSessions: 1, revokedLegacySessions: 0 };
        },
      } satisfies SecurityEpochBridge,
    });
    await handler({
      authUserId: 'auth-user-1',
      providerName: 'Victim Google',
      providerImage: null,
    });
    assert.deepEqual(events, [{ event: 'oauth_occupancy_adopt', accountId: 'acct-adopt' }]);
    assert.equal(stored.displayName, 'Victim Google');
    assert.equal(stored.about, '');
  });

  test('missing mapping fails closed before the epoch bump', async () => {
    let raised = 0;
    const handler = createOAuthOccupancyAdoptedHandler({
      businessAccount: {
        async execute(work) {
          return work({
            mappings: { async findByAuthUserId() { return null; } },
          } as never);
        },
      },
      securityEpochBridge: {
        async raiseAccountSecurityEvent() {
          raised += 1;
          return { securityEpoch: 1n, revokedAuthSessions: 0, revokedLegacySessions: 0 };
        },
      },
    });
    await assert.rejects(
      () => handler({ authUserId: 'missing', providerName: 'X', providerImage: null }),
      /oauth occupancy adopt requires a business mapping/u,
    );
    assert.equal(raised, 0);
  });

  test('composeBetterAuthComposition assigns this handler (S-01 wiring)', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../src/bootstrap/composition.ts', import.meta.url)),
      'utf8',
    );
    assert.match(source, /occupancyAdopted\.current = createOAuthOccupancyAdoptedHandler\(/u);
    assert.doesNotMatch(source, /authority\.revokeAll\(accountId\)/u);
  });

  test('occupancy and linking integration call production compose (TEST-07)', () => {
    const occupancy = readFileSync(
      fileURLToPath(new URL('../../integration/auth/oauth-occupancy-adopt.integration.test.ts', import.meta.url)),
      'utf8',
    );
    const linking = readFileSync(
      fileURLToPath(new URL('../../integration/auth/oauth-linking.integration.test.ts', import.meta.url)),
      'utf8',
    );
    assert.match(occupancy, /composeBetterAuthComposition\(/u);
    assert.match(linking, /composeBetterAuthComposition\(/u);
    assert.doesNotMatch(occupancy, /occupancyAdopted\.current = createOAuthOccupancyAdoptedHandler\(/u);
    assert.doesNotMatch(linking, /occupancyAdopted\.current = createOAuthOccupancyAdoptedHandler\(/u);
  });
});
