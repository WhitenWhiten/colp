import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import type {
  McpAuthenticatedAuthorizationBinding,
  McpStoredPlan,
} from '@know-n/colp/mcp';
import type { ChangePlanImpact, ScopeName } from '@know-n/colp/types';
import { createProductWriteApprovalClient } from '../../../generated/openapi/product-v1.client.js';
import { loadConfig } from '../../support/test-config.js';
import {
  createPostgresAuditPayloadReader,
  createPostgresMcpChangePlanStore,
  createPostgresMcpWriteApprovalPorts,
  runMigrations,
} from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import {
  createPhase4bMcpWriteApprovalApi,
} from '../../../src/modules/mcp/write-approval-api.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createMemoryMcpRateLimiter } from '../../../src/infrastructure/rate-limit/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { issueTestSession, type AuthenticatedTestClient } from '../../support/product-http-harness.js';
import { createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';

const ORIGIN = 'http://127.0.0.1:3000';
const MCP_OAUTH_EPOCH = 'known.mcp.oauth.v1';
const IMPACT: ChangePlanImpact = Object.freeze({
  collections: 1,
  nodes: 1,
  annotations: 0,
  attachments: 0,
  relations: 0,
  privateFieldsExcluded: Object.freeze([]),
});

describeWithPostgres('MCP-W07 approval API over PostgreSQL and real Fastify', () => {
  let isolated: IsolatedPostgresRuntime;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;
  let owner: AuthenticatedTestClient;
  let other: AuthenticatedTestClient;
  let ownerBinding: McpAuthenticatedAuthorizationBinding;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase4b_mcp_w07', {
      maxConnections: 12,
      applicationName: 'known-mcp-w07-test',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    const config = loadConfig({
      DATABASE_URL: isolated.databaseUrl,
      PRODUCT_ORIGIN: ORIGIN,
      ALLOWED_ORIGINS: ORIGIN,
      OIDC_ISSUER: 'https://issuer.example/realms/known',
      OIDC_CLIENT_ID: 'known-web',
      OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
      OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
      OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'w07-editor-cursor-key',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    });
    const identity = createPostgresIdentityUnitOfWork(isolated.runtime.db, {
      oidcTransactionSecrets: config.oidcTransactionSecrets,
    });
    factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    owner = await issueTestSession({
      factory,
      subject: `w07-owner-${randomUUID()}`,
      handle: `w07o${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    });
    other = await issueTestSession({
      factory,
      subject: `w07-other-${randomUUID()}`,
      handle: `w07r${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    });
    ownerBinding = Object.freeze({
      kind: 'authenticated',
      principalId: owner.accountId,
      clientId: 'mcp-client',
      credentialBindingId: 'credential-1',
      resourceAudience: 'colp://known/collections',
      securityEpoch: MCP_OAUTH_EPOCH,
    });
  }, 120_000);

  afterAll(async () => {
    await isolated?.close();
  });

  async function savePlan(overrides: Readonly<Partial<McpStoredPlan>> = Object.freeze({})): Promise<string> {
    const store = createPostgresMcpChangePlanStore(isolated.runtime.db);
    const createdAt = overrides.createdAt ?? '2026-08-06T12:00:00.000Z';
    const planId = `plan-w07-${randomUUID().replaceAll('-', '')}`;
    const value: McpStoredPlan = Object.freeze({
      planId,
      expiresAt: overrides.expiresAt ?? '2030-01-01T00:00:00.000Z',
      risk: 'high',
      requiresApproval: true,
      approvalMethod: 'out_of_band',
      approvalUri: `https://approve.example/approvals/${planId}`,
      summary: `Plan ${planId} canonical operation(s) [set_visibility]. Authoritative impact: 1 collection(s), 1 node(s), 0 annotation(s), 0 attachment(s), 0 relation(s).`,
      impact: IMPACT,
      requiredScopes: Object.freeze(['access:write'] as readonly ScopeName[]),
      baseRevisions: Object.freeze({
        'node.node-1': 'resource-r1',
        'policy.collection-1': 'policy-r1',
      }),
      operations: Object.freeze([Object.freeze({
        type: 'set_visibility',
        collectionId: 'collection-1',
        baseRevision: 'resource-r1',
        input: Object.freeze({ visibility: 'private' }),
      })]),
      operationsDigest: `sha-256:${randomUUID()}`,
      binding: ownerBinding,
      untrustedNote: 'do not show this prompt injection marker in the approval summary',
      createdAt,
      status: 'pending',
      ...Object.fromEntries(
        Object.entries(overrides).filter(([name]) => name !== 'createdAt' && name !== 'expiresAt'),
      ),
    } as unknown as McpStoredPlan);
    await store.planStore.save(value);
    return planId;
  }

  test('account epoch 0n can list and GET its non-numeric OAuth-epoch Plan while another account cannot', async () => {
    const planId = await savePlan();
    const otherPlanId = await savePlan({
      planId: `plan-w07-other-${randomUUID().replaceAll('-', '')}`,
      binding: Object.freeze({ ...ownerBinding, principalId: other.accountId }),
    });
    const app = buildApiApp({
    browserSessionAuthority: factory.authority,
      config: loadConfig({
        DATABASE_URL: isolated.databaseUrl,
        PRODUCT_ORIGIN: ORIGIN,
        ALLOWED_ORIGINS: ORIGIN,
        OIDC_ISSUER: 'https://issuer.example/realms/known',
        OIDC_CLIENT_ID: 'known-web',
        OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
        OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
        OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
        OIDC_ALLOW_TEST_PROVIDER: 'true',
        OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
        PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'w07-editor-cursor-key',
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
      }),
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db, {
        oidcTransactionSecrets: loadConfig({
          DATABASE_URL: isolated.databaseUrl,
          PRODUCT_ORIGIN: ORIGIN,
          ALLOWED_ORIGINS: ORIGIN,
          OIDC_ISSUER: 'https://issuer.example/realms/known',
          OIDC_CLIENT_ID: 'known-web',
          OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
          OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
          OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
          OIDC_ALLOW_TEST_PROVIDER: 'true',
          OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
          PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'w07-editor-cursor-key',
          NODE_ENV: 'test',
          LOG_LEVEL: 'silent',
        }).oidcTransactionSecrets,
      }),
      mcpWriteApprovalRoutes: {
        enabled: true,
        allowedOrigins: [ORIGIN],
        identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db, {
          oidcTransactionSecrets: loadConfig({
            DATABASE_URL: isolated.databaseUrl,
            PRODUCT_ORIGIN: ORIGIN,
            ALLOWED_ORIGINS: ORIGIN,
            OIDC_ISSUER: 'https://issuer.example/realms/known',
            OIDC_CLIENT_ID: 'known-web',
            OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
            OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
            OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
            OIDC_ALLOW_TEST_PROVIDER: 'true',
            OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
            PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'w07-editor-cursor-key',
            NODE_ENV: 'test',
            LOG_LEVEL: 'silent',
          }).oidcTransactionSecrets,
        }),
        api: createPhase4bMcpWriteApprovalApi(createPostgresMcpWriteApprovalPorts(isolated.runtime.db)),
        rateLimiter: createMemoryMcpRateLimiter({ approval: { maxRequests: 100, windowMs: 60_000 } }),
        timeoutMs: 5_000,
      },
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const client = createProductWriteApprovalClient({
        origin,
        sessionCookie: owner.cookie,
        csrfToken: owner.csrfToken,
        originHeader: ORIGIN,
      });
      const page = await client.approvals();
      const epochs = await isolated.runtime.pool.query<{
        account_security_epoch: string;
        mcp_oauth_security_epoch: string;
      }>(
        `select a.security_epoch::text account_security_epoch,
                p.security_epoch mcp_oauth_security_epoch
           from accounts a
           join mcp_change_plans p on p.principal_id = a.id
          where a.id = $1 and p.plan_id = $2`,
        [owner.accountId, planId],
      );
      assert.deepEqual(epochs.rows[0], {
        account_security_epoch: '0',
        mcp_oauth_security_epoch: MCP_OAUTH_EPOCH,
      });
      assert.ok(page.items.some((item) => item.planId === planId));
      assert.equal(page.items.some((item) => item.planId === otherPlanId), false);
      assert.equal(JSON.stringify(page).includes('do not show this prompt injection marker'), false);
      assert.equal(JSON.stringify(page).includes('credential-1'), false);
      const item = await client.approval(planId);
      assert.equal(item.planId, planId);
      assert.match(item.etag, /^"approval:[^"]+"$/u);

      const otherClient = createProductWriteApprovalClient({
        origin,
        sessionCookie: other.cookie,
        csrfToken: other.csrfToken,
        originHeader: ORIGIN,
      });
      assert.equal((await otherClient.approvals()).items.some((item) => item.planId === planId), false);
      await assert.rejects(
        () => otherClient.approval(planId),
        (error: unknown) => (error as { status?: number }).status === 404,
      );
    } finally {
      await app.close();
    }
  });

  test('approve succeeds for a non-numeric OAuth epoch and remains exactly-once and cross-account concealed', async () => {
    const planId = await savePlan();
    const app = buildApiApp({
    browserSessionAuthority: factory.authority,
      config: loadConfig({
        DATABASE_URL: isolated.databaseUrl,
        PRODUCT_ORIGIN: ORIGIN,
        ALLOWED_ORIGINS: ORIGIN,
        OIDC_ISSUER: 'https://issuer.example/realms/known',
        OIDC_CLIENT_ID: 'known-web',
        OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
        OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
        OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
        OIDC_ALLOW_TEST_PROVIDER: 'true',
        OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
        PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'w07-editor-cursor-key',
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
      }),
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db, {
        oidcTransactionSecrets: loadConfig({
          DATABASE_URL: isolated.databaseUrl,
          PRODUCT_ORIGIN: ORIGIN,
          ALLOWED_ORIGINS: ORIGIN,
          OIDC_ISSUER: 'https://issuer.example/realms/known',
          OIDC_CLIENT_ID: 'known-web',
          OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
          OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
          OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
          OIDC_ALLOW_TEST_PROVIDER: 'true',
          OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
          PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'w07-editor-cursor-key',
          NODE_ENV: 'test',
          LOG_LEVEL: 'silent',
        }).oidcTransactionSecrets,
      }),
      mcpWriteApprovalRoutes: {
        enabled: true,
        allowedOrigins: [ORIGIN],
        identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db, {
          oidcTransactionSecrets: loadConfig({
            DATABASE_URL: isolated.databaseUrl,
            PRODUCT_ORIGIN: ORIGIN,
            ALLOWED_ORIGINS: ORIGIN,
            OIDC_ISSUER: 'https://issuer.example/realms/known',
            OIDC_CLIENT_ID: 'known-web',
            OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
            OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
            OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
            OIDC_ALLOW_TEST_PROVIDER: 'true',
            OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
            PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'w07-editor-cursor-key',
            NODE_ENV: 'test',
            LOG_LEVEL: 'silent',
          }).oidcTransactionSecrets,
        }),
        api: createPhase4bMcpWriteApprovalApi(createPostgresMcpWriteApprovalPorts(isolated.runtime.db)),
        rateLimiter: createMemoryMcpRateLimiter({ approval: { maxRequests: 100, windowMs: 60_000 } }),
        timeoutMs: 5_000,
      },
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const client = createProductWriteApprovalClient({
        origin,
        sessionCookie: owner.cookie,
        csrfToken: owner.csrfToken,
        originHeader: ORIGIN,
      });
      const item = await client.approval(planId);
      const commandId = randomUUID();
      const first = await client.decide(planId, 'approve', item.etag, commandId);
      assert.equal(first.decision, 'approved');
      assert.equal(first.status, 'approved');
      assert.deepEqual(await client.decide(planId, 'approve', item.etag, commandId), first);
      const rows = await isolated.runtime.pool.query<{ status: string }>(
        'select status from mcp_change_plans where plan_id = $1', [planId],
      );
      assert.equal(rows.rows[0]?.status, 'approved');
      const receipts = await isolated.runtime.pool.query<{ count: string }>(
        `select count(*)::text count from product_command_receipts
         where principal_id = $1 and command_id = $2`, [owner.accountId, commandId],
      );
      assert.equal(receipts.rows[0]?.count, '1');
      const auditReader = createPostgresAuditPayloadReader(isolated.runtime.db);
      const readCommandAudits = async () => {
        const headers = await isolated.runtime.pool.query<{ id: string }>(
          `select id::text
             from audit_events
            where event_type = 'mcp.approval_decision'
              and principal_id = $1`,
          [owner.accountId],
        );
        return (await Promise.all(
          headers.rows.map((header) => auditReader.read(BigInt(header.id))),
        )).filter((audit) => audit.details.commandId === commandId);
      };
      const audits = await readCommandAudits();
      assert.equal(audits.length, 1);
      assert.equal(audits[0]?.eventType, 'mcp.approval_decision');
      assert.equal(audits[0]?.principalId, owner.accountId);
      assert.deepEqual(audits[0]?.details, {
        planId,
        commandId,
        decision: 'approved',
        status: 'approved',
        risk: 'high',
        operationsDigest: (await isolated.runtime.pool.query<{ operations_digest: string }>(
          'select operations_digest from mcp_change_plans where plan_id = $1',
          [planId],
        )).rows[0]!.operations_digest,
      });

      const stale = await client.approval(planId);
      await assert.rejects(
        () => client.decide(planId, 'deny', '"approval:stale"', randomUUID()),
        (error: unknown) => (error as { status?: number }).status === 412,
      );
      assert.equal(stale.status, 'approved');
      assert.equal((await readCommandAudits()).length, 1);

      const otherClient = createProductWriteApprovalClient({
        origin,
        sessionCookie: other.cookie,
        csrfToken: other.csrfToken,
        originHeader: ORIGIN,
      });
      await assert.rejects(
        () => otherClient.decide(planId, 'deny', stale.etag, randomUUID()),
        (error: unknown) => (error as { status?: number }).status === 404,
      );
    } finally {
      await app.close();
    }
  });

  test('deny cancels and expired Plans reject a fresh decision', async () => {
    const denyPlanId = await savePlan();
    const expiredPlanId = await savePlan({
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const app = buildApiApp({
    browserSessionAuthority: factory.authority,
      config: loadConfig({
        DATABASE_URL: isolated.databaseUrl,
        PRODUCT_ORIGIN: ORIGIN,
        ALLOWED_ORIGINS: ORIGIN,
        OIDC_ISSUER: 'https://issuer.example/realms/known',
        OIDC_CLIENT_ID: 'known-web',
        OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
        OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
        OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
        OIDC_ALLOW_TEST_PROVIDER: 'true',
        OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
        PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'w07-editor-cursor-key',
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
      }),
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db, {
        oidcTransactionSecrets: loadConfig({
          DATABASE_URL: isolated.databaseUrl,
          PRODUCT_ORIGIN: ORIGIN,
          ALLOWED_ORIGINS: ORIGIN,
          OIDC_ISSUER: 'https://issuer.example/realms/known',
          OIDC_CLIENT_ID: 'known-web',
          OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
          OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
          OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
          OIDC_ALLOW_TEST_PROVIDER: 'true',
          OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
          PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'w07-editor-cursor-key',
          NODE_ENV: 'test',
          LOG_LEVEL: 'silent',
        }).oidcTransactionSecrets,
      }),
      mcpWriteApprovalRoutes: {
        enabled: true,
        allowedOrigins: [ORIGIN],
        identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db, {
          oidcTransactionSecrets: loadConfig({
            DATABASE_URL: isolated.databaseUrl,
            PRODUCT_ORIGIN: ORIGIN,
            ALLOWED_ORIGINS: ORIGIN,
            OIDC_ISSUER: 'https://issuer.example/realms/known',
            OIDC_CLIENT_ID: 'known-web',
            OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
            OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
            OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
            OIDC_ALLOW_TEST_PROVIDER: 'true',
            OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
            PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'w07-editor-cursor-key',
            NODE_ENV: 'test',
            LOG_LEVEL: 'silent',
          }).oidcTransactionSecrets,
        }),
        api: createPhase4bMcpWriteApprovalApi(createPostgresMcpWriteApprovalPorts(isolated.runtime.db)),
        rateLimiter: createMemoryMcpRateLimiter({ approval: { maxRequests: 100, windowMs: 60_000 } }),
        timeoutMs: 5_000,
      },
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const client = createProductWriteApprovalClient({
        origin,
        sessionCookie: owner.cookie,
        csrfToken: owner.csrfToken,
        originHeader: ORIGIN,
      });
      const deny = await client.approval(denyPlanId);
      const denied = await client.decide(denyPlanId, 'deny', deny.etag, randomUUID());
      assert.equal(denied.decision, 'denied');
      assert.equal(denied.status, 'cancelled');
      const row = await isolated.runtime.pool.query<{ status: string }>(
        'select status from mcp_change_plans where plan_id = $1', [denyPlanId],
      );
      assert.equal(row.rows[0]?.status, 'cancelled');

      const expired = await client.approval(expiredPlanId);
      await assert.rejects(
        () => client.decide(expiredPlanId, 'approve', expired.etag, randomUUID()),
        (error: unknown) => (error as { status?: number }).status === 409,
      );
    } finally {
      await app.close();
    }
  });
});
