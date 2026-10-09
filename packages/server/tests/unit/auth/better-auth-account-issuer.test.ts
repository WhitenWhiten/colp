import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { getAuthTables } from '@better-auth/core/db';
import type { DBFieldAttribute } from '@better-auth/core/db';
import { buildBetterAuthOptions } from '../../../src/infrastructure/auth/better-auth-runtime.js';
import {
  AccountIssuerError,
  GOOGLE_ACCOUNT_ISSUER,
  LOCAL_CREDENTIAL_ACCOUNT_ISSUER,
  resolveAccountIssuer,
  withServerAccountIssuer,
  withoutAccountIssuerUpdate,
} from '../../../src/modules/auth/index.js';
import { TEST_SESSION_TOKEN_PROTECTION } from '../../support/better-auth-session-token-protection.js';

/**
 * PR #60 (better-auth 1.7.1 → 1.7.7) regression contract.
 *
 * Better Auth 1.7.3 (#11153) removed `account.issuer` from the SDK schema and
 * reverted account identity to `(providerId, accountId)`. Migration
 * 202609230100 keeps `auth_accounts.issuer NOT NULL` + UNIQUE
 * `(issuer, accountId)`; without a server-owned value every sign-up / link
 * fails with a 23502 and surfaces as HTTP 500 (the CI failure).
 *
 * Pinned here:
 * - the installed SDK really no longer declares `issuer` (the regression
 *   trips again if upstream re-adds it with different semantics);
 * - the runtime options re-declare `issuer` as a non-input additional field
 *   and assign it in `account.create.before` from `providerId` only;
 * - the mapping is byte-identical to the 202609230100 backfill;
 * - request/caller-supplied `issuer` values are never trusted (create or update);
 * - a blank providerId fails closed instead of writing NULL/empty.
 */

function runtimeOptions() {
  return buildBetterAuthOptions({
    enabled: true,
    config: {
      baseURL: 'https://app.example.test',
      basePath: '/api/v1/auth',
      secret: 'x'.repeat(40),
      sessionTokenProtection: TEST_SESSION_TOKEN_PROTECTION,
      trustedOrigins: ['https://app.example.test'],
      cookieName: '__Host-known_session' as const,
      sessionExpiresInSeconds: 86_400,
      sessionUpdateAgeSeconds: 60,
      bodyLimitBytes: 1024,
      emailOtp: null,
      social: null,
      passwordHash: {
        hash: async (password: string) => `hash:${password}`,
        verify: async () => false,
      },
    },
    database: { db: {} as never, type: 'postgres', transaction: true },
  });
}

describe('server-owned auth_accounts.issuer (Better Auth 1.7.3+ revert compatibility)', () => {
  test('installed SDK no longer declares account.issuer (the 1.7.3 revert is in effect)', () => {
    const tables = getAuthTables({});
    assert.equal('issuer' in tables.account!.fields, false,
      'upstream re-introduced account.issuer: re-review the server-owned mapping');
  });

  test('resolver reproduces the 202609230100 backfill byte-for-byte', () => {
    assert.equal(resolveAccountIssuer('credential'), 'local:credential');
    assert.equal(resolveAccountIssuer('credential'), LOCAL_CREDENTIAL_ACCOUNT_ISSUER);
    assert.equal(resolveAccountIssuer('siwe'), 'local:siwe');
    assert.equal(resolveAccountIssuer('google'), 'https://accounts.google.com');
    assert.equal(resolveAccountIssuer('google'), GOOGLE_ACCOUNT_ISSUER);
    assert.equal(resolveAccountIssuer('github'), 'local:oauth:github');
    // Same escaping as the SQL `ba17_encode_uri_component` helper.
    assert.equal(resolveAccountIssuer('test provider/ä'), `local:oauth:${encodeURIComponent('test provider/ä')}`);
    assert.equal(resolveAccountIssuer('local:oauth:google'), 'local:oauth:local%3Aoauth%3Agoogle',
      'a providerId that spells an issuer cannot alias another provider');
  });

  test('distinct providers never collapse onto one issuer (identity isolation)', () => {
    const providers = ['credential', 'siwe', 'google', 'github', 'Google', 'google ', 'oauth:google'];
    const issuers = new Set<string>();
    for (const provider of providers) {
      if (provider !== provider.trim()) {
        assert.throws(() => resolveAccountIssuer(provider), AccountIssuerError);
        continue;
      }
      issuers.add(resolveAccountIssuer(provider));
    }
    assert.equal(issuers.size, providers.length - 1);
  });

  test('blank or non-string providerId fails closed', () => {
    for (const bad of ['', '   ', undefined, null, 42, {}]) {
      assert.throws(() => resolveAccountIssuer(bad), AccountIssuerError);
      assert.throws(() => withServerAccountIssuer({ providerId: bad, accountId: 'x' }), AccountIssuerError);
    }
  });

  test('create transform overwrites any caller-supplied issuer; update transform neutralises it', () => {
    const hostile = { providerId: 'github', accountId: 'sub-1', issuer: 'https://accounts.google.com' };
    const created = withServerAccountIssuer(hostile);
    assert.equal(created.issuer, 'local:oauth:github');
    assert.equal(hostile.issuer, 'https://accounts.google.com', 'input is not mutated');

    const update = withoutAccountIssuerUpdate({ scope: 'read', issuer: 'local:credential' });
    assert.equal(Object.hasOwn(update, 'issuer'), true, 'key must be present to win the hook merge');
    assert.equal(update.issuer, undefined);
    const untouched = { scope: 'read' };
    assert.equal(withoutAccountIssuerUpdate(untouched), untouched);
    // A providerId rewrite (BA linkOAuthAccount updates providerId+tokens on
    // the existing row) re-derives issuer from the NEW providerId, so the
    // (providerId, issuer) pair on a row can never diverge.
    const moved = withoutAccountIssuerUpdate({ providerId: 'github', issuer: 'https://accounts.google.com' });
    assert.equal(moved.issuer, 'local:oauth:github');
    assert.throws(() => withoutAccountIssuerUpdate({ providerId: '' }), AccountIssuerError);
  });

  test('runtime options declare issuer as a required, non-input, returned account field', () => {
    const options = runtimeOptions();
    const field = options.account?.additionalFields?.issuer as DBFieldAttribute | undefined;
    assert.ok(field, 'account.additionalFields.issuer must be declared or the adapter drops the column');
    assert.equal(field.type, 'string');
    assert.equal(field.required, true);
    assert.equal(field.input, false);
    assert.equal(field.returned, true);
    assert.equal(field.fieldName, 'issuer');
    const tables = getAuthTables(options);
    assert.equal(tables.account!.modelName, 'auth_accounts');
    assert.equal(tables.account!.fields.issuer?.fieldName, 'issuer');
    assert.equal(typeof options.databaseHooks?.account?.create?.before, 'function');
    assert.equal(typeof options.databaseHooks?.account?.update?.before, 'function');
  });

  test('through the real SDK: credential sign-up, social link and adopt-style linkAccount all carry the server issuer', async () => {
    const options = runtimeOptions();
    const memory = memoryAdapter({ user: [], session: [], account: [], verification: [] });
    const auth = betterAuth({
      ...options,
      database: memory,
      // Memory adapter: no Postgres-only protections; keep the product hooks,
      // database hooks and additionalFields exactly as the runtime builds them.
      plugins: [],
      hooks: undefined,
      logger: { level: 'error' },
    });
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({
      email: 'issuer@example.test', name: 'Issuer', emailVerified: true,
    } as never);

    // 1) credential row the way /sign-up/email writes it in 1.7.7 (no issuer).
    const credential = await ctx.internalAdapter.createAccount({
      userId: user.id, providerId: 'credential', accountId: user.id, password: 'hash:x',
    } as never) as Record<string, unknown>;
    assert.equal(credential.issuer, 'local:credential');

    // 2) OAuth link row carrying an attacker/legacy issuer: overwritten.
    const github = await ctx.internalAdapter.linkAccount({
      userId: user.id, providerId: 'github', accountId: 'gh-1',
      issuer: 'https://accounts.google.com',
    } as never) as Record<string, unknown>;
    assert.equal(github.issuer, 'local:oauth:github');

    // 3) Google row uses the real issuer (same as the 1.7.1 `accountIssuer`).
    const google = await ctx.internalAdapter.linkAccount({
      userId: user.id, providerId: 'google', accountId: 'gh-1',
    } as never) as Record<string, unknown>;
    assert.equal(google.issuer, 'https://accounts.google.com');

    // Same external accountId at two providers stays two rows, two issuers.
    const rows = await ctx.internalAdapter.findAccounts(user.id) as ReadonlyArray<Record<string, unknown>>;
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows.map((row) => `${String(row.issuer)}\u0000${String(row.accountId)}`)).size, 3);

    // 4) Update payloads cannot move a row to another issuer.
    const updated = await ctx.internalAdapter.updateAccount(String(github.id), {
      scope: 'read:user', issuer: 'local:credential',
    } as never) as Record<string, unknown>;
    assert.equal(updated.issuer, 'local:oauth:github');
    assert.equal(updated.scope, 'read:user');
    // ...and a providerId rewrite keeps issuer coupled to the new providerId.
    const rekeyed = await ctx.internalAdapter.updateAccount(String(github.id), {
      providerId: 'google', issuer: 'local:oauth:github',
    } as never) as Record<string, unknown>;
    assert.equal(rekeyed.providerId, 'google');
    assert.equal(rekeyed.issuer, 'https://accounts.google.com');
    await ctx.internalAdapter.updateAccount(String(github.id), { providerId: 'github' } as never);

    // 5) A blank providerId never reaches the store.
    await assert.rejects(
      ctx.internalAdapter.createAccount({ userId: user.id, providerId: '', accountId: 'x' } as never),
      AccountIssuerError,
    );
    assert.equal((await ctx.internalAdapter.findAccounts(user.id)).length, 3);
  });
});
