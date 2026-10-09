import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import { composeApiAccountServices } from '../../../src/bootstrap/api-account-services.js';
import { composeApiEmail } from '../../../src/bootstrap/api-email-composition.js';
import { composeApiMcpSurface } from '../../../src/bootstrap/api-mcp-surface-composition.js';
import {
  createApiPostgresPorts,
} from '../../../src/bootstrap/api-postgres-ports.js';
import {
  composeApiSurfaceRateLimiters,
  composeProductSurfaceRateLimiter,
} from '../../../src/bootstrap/api-rate-limit-composition.js';
import { loadConfig } from '../../support/test-config.js';
import type { DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createLogger, InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import type { BrowserSessionAuthority } from '../../../src/modules/auth/index.js';
import { sha256Base64Url } from '../../../src/modules/auth/index.js';
import type { IdentityUnitOfWork } from '../../../src/modules/identity/index.js';
import {
  BETTER_AUTH_PROD_SECRET,
  betterAuthTestEnv,
} from '../../support/better-auth-config-test-helpers.js';
import { testEnv } from '../../support/http-security-config-env.js';

const SECRET_ENV_KEYS = [
  'ATTACHMENTS_R2_PRIMARY_ACCESS_KEY_ID',
  'ATTACHMENTS_R2_PRIMARY_SECRET_ACCESS_KEY',
  'ATTACHMENTS_DELIVERY_CAPABILITY_PRIMARY',
  'AVATAR_R2_ENDPOINT',
  'AVATAR_R2_BUCKET',
  'AVATAR_R2_ACCESS_KEY_ID',
  'AVATAR_R2_SECRET_ACCESS_KEY',
  'ALIBABA_CLOUD_ACCESS_KEY_ID',
  'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
] as const;

afterEach(() => {
  for (const key of SECRET_ENV_KEYS) delete process.env[key];
});

function noSqlDatabase(): DatabaseRuntime & { readonly sqlCalls: string[]; readonly closeCalls: string[] } {
  const sqlCalls: string[] = [];
  const closeCalls: string[] = [];
  const pool = {
    async query() {
      sqlCalls.push('pool.query');
      throw new Error('unexpected SQL during composition');
    },
    async connect() {
      sqlCalls.push('pool.connect');
      throw new Error('unexpected SQL during composition');
    },
  };
  return {
    db: Object.freeze({}) as DatabaseRuntime['db'],
    pool: pool as unknown as DatabaseRuntime['pool'],
    async cancelBackend() {
      sqlCalls.push('cancelBackend');
      throw new Error('unexpected SQL during composition');
    },
    async verifyReady() {
      sqlCalls.push('verifyReady');
      throw new Error('unexpected SQL during composition');
    },
    async close() {
      closeCalls.push('close');
    },
    sqlCalls,
    closeCalls,
  };
}

function identityUnitOfWork(onMarkDeleted?: (accountId: string, deletedAt: Date) => void): IdentityUnitOfWork {
  return {
    async execute<Result>(work: (ports: never) => Promise<Result>): Promise<Result> {
      const ports = {
        accounts: {
          async findBySubjectId() { return null; },
          async markDeleted(accountId: string, deletedAt: Date) {
            onMarkDeleted?.(accountId, deletedAt);
          },
        },
        clock: { async now() { return new Date('2026-09-01T00:00:00.000Z'); } },
      };
      return work(ports as never);
    },
  };
}

function browserAuthority(revoked: string[]): BrowserSessionAuthority {
  const actor = {
    account: { id: 'account-1', subjectId: 'subject-1', status: 'active' },
    session: { id: 'session-1' },
  };
  return {
    async authenticate() { return actor; },
    async requireMutationActor() { return actor; },
    async bootstrap() { return { authenticated: false }; },
    async signOut() {},
    async revokeAll(accountId: string) {
      revoked.push(accountId);
      return { securityEpoch: 1n, revokedAuthSessions: 1, revokedLegacySessions: 0 };
    },
    async revokeOthersKeepingCurrent() {
      return { securityEpoch: 0n, revokedAuthSessions: 0, revokedLegacySessions: 0 };
    },
    async listLiveSessions() { return []; },
    async revokeSessionById() { return { kind: 'not_found' as const }; },
  } as unknown as BrowserSessionAuthority;
}

function betterAuthConfig() {
  return loadConfig(betterAuthTestEnv({
    BETTER_AUTH_ENABLED: 'true',
    BETTER_AUTH_SECRET: BETTER_AUTH_PROD_SECRET,
  }));
}

function destroyPostgresCursorKeys(ports: ReturnType<typeof createApiPostgresPorts>): void {
  ports.ownedCollectionsCursorSigner.destroy();
  ports.sharedCollectionsCursorSigner.destroy();
  ports.collaborationMembersCursorSigner.destroy();
  ports.myCollaborationInvitesCursorSigner.destroy();
  ports.linkHealthCursorSigner.destroy();
  ports.classifyInboxCursorSigner.destroy();
  ports.collectionVersionCursorSigner.destroy();
  ports.publicationCursorKeys.destroy();
}

describe('API composition leaves', () => {
  test('all optional features compose closed and PostgreSQL ports perform no SQL during construction', async () => {
    const config = loadConfig(testEnv());
    const database = noSqlDatabase();
    const metrics = new InMemoryMetrics();
    const metricsLogger = createLogger('silent');
    const identity = identityUnitOfWork();

    const accounts = composeApiAccountServices({
      config,
      identityUnitOfWork: identity,
      browserSessionAuthority: undefined,
      recoveryLinkingAuth: undefined,
    });
    assert.deepEqual(accounts, {
      accountRecovery: undefined,
      accountLinking: undefined,
      accountDeletion: undefined,
    });

    const ports = createApiPostgresPorts({ database, config, metrics, metricsLogger });
    assert.equal(typeof ports.identityUnitOfWork.execute, 'function');
    assert.equal(typeof ports.searchPorts.telemetry.record, 'function');
    assert.ok(ports.searchPorts.clock.now() instanceof Date);
    for (const query of [
      ports.ownedCollectionsQueryPorts,
      ports.sharedCollectionsQueryPorts,
      ports.linkHealthQueryPorts,
      ports.classifyInboxQueryPorts,
    ]) {
      assert.ok(await query.clock.now() instanceof Date);
    }
    assert.equal(database.sqlCalls.length, 0);

    const mcp = await composeApiMcpSurface({
      config,
      database,
      identityUnitOfWork: identity,
      metrics,
      publicationDirectoryReads: ports.publicationDirectoryReads,
      publicationMetadataReads: ports.publicationMetadataReads,
      publicationCursorKeys: ports.publicationCursorKeys,
      accessPolicyFacts: ports.accessPolicyFacts,
      publicationSnapshotQuery: ports.publicationSnapshotQuery,
      ownedCollectionsQuery: ports.ownedCollectionsQueryPorts,
    });
    assert.equal(mcp.mcpChangeSignalSource, undefined);
    assert.equal(mcp.mcpReadResourceProjection, undefined);
    assert.equal(mcp.mcpRateLimiter, undefined);
    assert.equal(mcp.mcpApplicationFacade, undefined);

    const email = composeApiEmail({ config, database, metrics, metricsLogger });
    assert.equal(email.authMailboxSink, undefined);
    assert.equal(email.emailProvider, undefined);
    assert.equal(email.emailCallbackRoutes, undefined);
    assert.equal(email.emailOpsRoutes.enabled, false);

    const rateLimiters = composeApiSurfaceRateLimiters(config);
    assert.equal(rateLimiters.authRateLimiter, undefined);
    assert.equal(rateLimiters.syncColpRateLimiter, undefined);
    assert.equal(rateLimiters.effectPageRateLimiter, undefined);
    assert.equal(rateLimiters.syncAdmissionPolicy, undefined);
    for (const limiter of [
      rateLimiters.searchRateLimiter,
      rateLimiters.exploreDirectoryRateLimiter,
      rateLimiters.publicActivityRateLimiter,
    ]) {
      assert.equal(typeof (limiter as { size?: unknown }).size, 'function');
      assert.equal(limiter.readiness().status, 'healthy');
    }
    for (const limiter of [
      rateLimiters.followRateLimiter,
      rateLimiters.collectionFollowRateLimiter,
      rateLimiters.feedRateLimiter,
      rateLimiters.notificationRateLimiter,
      rateLimiters.libraryOrderRateLimiter,
      rateLimiters.linkHealthRateLimiter,
      rateLimiters.classifyInboxRateLimiter,
      rateLimiters.exportJobRateLimiter,
      rateLimiters.organizePlanRateLimiter,
      rateLimiters.collectionVersionRateLimiter,
      rateLimiters.readableReplicaRateLimiter,
      rateLimiters.publicObjectRateLimiter,
    ]) {
      assert.equal(typeof limiter.consume, 'function');
      assert.equal('readiness' in limiter, false);
    }

    assert.equal(database.sqlCalls.length, 0);
    destroyPostgresCursorKeys(ports);
    await email.authEmailComposition.close();
    await Promise.all([
      rateLimiters.searchRateLimiter.close(),
      rateLimiters.exploreDirectoryRateLimiter.close(),
      rateLimiters.publicActivityRateLimiter.close(),
    ]);
  });

  test('Better Auth mode refuses a missing shared auth instance', () => {
    assert.throws(
      () => composeApiAccountServices({
        config: betterAuthConfig(),
        identityUnitOfWork: identityUnitOfWork(),
        browserSessionAuthority: browserAuthority([]),
        recoveryLinkingAuth: undefined,
      }),
      /Better Auth mode must expose the shared auth instance/u,
    );
  });

  test('Better Auth account facades map recovery, linking, unlinking, and deletion to the shared server API', async () => {
    const calls: Array<{ readonly name: string; readonly input: unknown }> = [];
    const revoked: string[] = [];
    const markedDeleted: Array<{ readonly accountId: string; readonly deletedAt: Date }> = [];
    const deletedAuthUsers: string[] = [];
    const accounts = [
      { id: 'credential-row', providerId: 'credential', accountId: 'account-1' },
      { id: 'github-row', providerId: 'github', accountId: 'github-subject' },
    ];
    const responseHeaders = new Headers();
    responseHeaders.append('set-cookie', 'mcp_link_state=one; Path=/; HttpOnly');
    const sharedAuth = {
      api: {
        async requestPasswordReset(input: unknown) { calls.push({ name: 'requestPasswordReset', input }); },
        async resetPasswordEmailOTP(input: unknown) { calls.push({ name: 'resetPasswordEmailOTP', input }); },
        async linkSocialAccount(input: unknown) {
          calls.push({ name: 'linkSocialAccount', input });
          return new Response(JSON.stringify({ url: 'https://provider.example/authorize' }), {
            headers: responseHeaders,
          });
        },
        async listUserAccounts(input: unknown) {
          calls.push({ name: 'listUserAccounts', input });
          return accounts;
        },
        async unlinkAccount(input: unknown) { calls.push({ name: 'unlinkAccount', input }); },
        async getSession(input: unknown) {
          calls.push({ name: 'getSession', input });
          return { user: { id: 'auth-user-1', email: 'owner@example.test' } };
        },
        async verifyPassword(input: unknown) { calls.push({ name: 'verifyPassword', input }); },
        async checkVerificationOTP(input: unknown) { calls.push({ name: 'checkVerificationOTP', input }); },
      },
      $context: Promise.resolve({
        internalAdapter: {
          async deleteUser(userId: string) { deletedAuthUsers.push(userId); },
          async consumeVerificationValue(identifier: string) {
            if (identifier !== 'email-verification-otp-owner@example.test') return null;
            return {
              value: `${sha256Base64Url('654321')}:0`,
              expiresAt: new Date('2026-09-02T00:00:00.000Z'),
            };
          },
          async createVerificationValue() {},
        },
      }),
    };
    const composed = composeApiAccountServices({
      accountDeletionStore: {
        async complete(accountId, authUserId) {
          revoked.push(accountId);
          markedDeleted.push({ accountId, deletedAt: new Date('2026-09-01T00:00:00.000Z') });
          deletedAuthUsers.push(authUserId);
        },
      },
      config: betterAuthConfig(),
      identityUnitOfWork: identityUnitOfWork((accountId, deletedAt) => {
        markedDeleted.push({ accountId, deletedAt });
      }),
      browserSessionAuthority: browserAuthority(revoked),
      recoveryLinkingAuth: sharedAuth,
    });
    assert.ok(composed.accountRecovery && composed.accountLinking && composed.accountDeletion);

    await composed.accountRecovery.requestPasswordRecovery({ email: 'owner@example.test' });
    await composed.accountRecovery.recoverWithVerifiedEmailOtp({
      email: 'owner@example.test', otp: '123456', newPassword: 'new-password-123',
    });
    const linked = await composed.accountLinking.beginProviderLink({
      cookie: '__Host-known=abc',
      providerId: 'google',
      callbackURL: 'https://app.example.test/settings/accounts?linked=1',
      errorCallbackURL: '/settings/accounts?failed=1',
      reauth: { kind: 'password', password: 'password-123' },
    });
    assert.equal(linked.url, 'https://provider.example/authorize');
    assert.deepEqual(linked.stateCookies, ['mcp_link_state=one; Path=/; HttpOnly']);
    assert.deepEqual(await composed.accountLinking.listLinkedProviders({ cookie: '__Host-known=abc' }), {
      accounts: [{ providerId: 'github', accountId: 'github-subject' }],
      hasPassword: true,
    });
    await composed.accountLinking.unlinkProvider({
      cookie: '__Host-known=abc', providerId: 'github', accountId: 'github-subject',
      reauth: { kind: 'otp', email: 'OWNER@example.test', otp: '654321' },
    });
    await composed.accountDeletion.deleteAccount({
      cookie: '__Host-known=abc', confirmation: 'DELETE',
      reauth: { kind: 'password', password: 'password-123' },
    });

    assert.deepEqual((calls.find((call) => call.name === 'requestPasswordReset')?.input as { body: unknown }).body, {
      email: 'owner@example.test',
    });
    assert.deepEqual((calls.find((call) => call.name === 'resetPasswordEmailOTP')?.input as { body: unknown }).body, {
      email: 'owner@example.test', otp: '123456', password: 'new-password-123',
    });
    const linkInput = calls.find((call) => call.name === 'linkSocialAccount')?.input as {
      headers: Headers;
      body: Record<string, string>;
      asResponse: boolean;
    };
    assert.equal(linkInput.headers.get('cookie'), '__Host-known=abc');
    assert.deepEqual(linkInput.body, {
      provider: 'google',
      callbackURL: '/settings/accounts?linked=1',
      errorCallbackURL: '/settings/accounts?failed=1',
    });
    assert.equal(linkInput.asResponse, true);
    const unlinkInput = calls.find((call) => call.name === 'unlinkAccount')?.input as {
      body: { accountId: string };
    };
    assert.equal(unlinkInput.body.accountId, 'github-row', 'Better Auth unlink must receive the row id');
    assert.deepEqual(revoked, ['account-1']);
    assert.deepEqual(markedDeleted, [{
      accountId: 'account-1', deletedAt: new Date('2026-09-01T00:00:00.000Z'),
    }]);
    assert.deepEqual(deletedAuthUsers, ['auth-user-1']);
  });

  test('enabled product email composes one memory callback limiter without querying PostgreSQL', async () => {
    process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = 'composition-access-id';
    process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = 'composition-access-secret';
    const database = noSqlDatabase();
    const composed = composeApiEmail({
      config: loadConfig(testEnv({
        KNOWN_FEATURE_EMAIL: 'true',
        EMAIL_DM_ACCOUNT_NAME: 'no-reply@example.invalid',
      })),
      database,
      metrics: new InMemoryMetrics(),
      metricsLogger: createLogger('silent'),
    });
    assert.ok(composed.emailProvider);
    assert.ok(composed.emailCallbackRoutes);
    assert.equal(composed.emailCallbackRoutes.enabled, false);
    assert.equal(composed.emailCallbackRoutes.verifier, composed.emailProvider);
    assert.equal(composed.emailCallbackRoutes.rateLimiter, composed.emailCallbackRateLimiter);
    assert.equal(composed.emailCallbackRateLimiter?.readiness().status, 'healthy');
    assert.equal(database.sqlCalls.length, 0);
    await composed.emailCallbackRateLimiter?.close();
    await composed.emailProvider.close();
    await composed.authEmailComposition.close();
  });

  test('product-surface shared rate-limit composition rejects a missing secret', () => {
    assert.throws(
      () => composeProductSurfaceRateLimiter({
        purpose: 'follow',
        environment: 'test',
        sharedFlag: 'FOLLOW_RATE_LIMIT_SHARED',
        redisUrlEnv: 'FOLLOW_RATE_LIMIT_REDIS_URL',
        keySecretEnv: 'FOLLOW_RATE_LIMIT_KEY_SECRET',
        budget: { maxRequests: 10, windowMs: 1_000 },
        shared: {
          enabled: true,
          redisUrl: 'redis://127.0.0.1:6379',
          keySecret: null,
          keyPrefix: 'known-follow',
          commandTimeoutMs: 100,
          connectTimeoutMs: 100,
          maxRetriesPerRequest: 0,
        },
      }),
      /FOLLOW_RATE_LIMIT_SHARED=true requires FOLLOW_RATE_LIMIT_REDIS_URL and FOLLOW_RATE_LIMIT_KEY_SECRET/u,
    );
  });
});
