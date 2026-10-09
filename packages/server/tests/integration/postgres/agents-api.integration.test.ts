import { generateKeyPairSync } from 'node:crypto';
import { createPostgresAccountCredentialUnitOfWork } from '../../../src/infrastructure/auth/account-credentials-postgres.js';
import { exchangeAccountKey, type AccountKeyEs256PrivateJwk } from '../../../src/modules/auth/index.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { sql } from 'kysely';
import type { McpAuthenticatedAuthorizationBinding, McpStoredPlan } from '@know-n/colp/mcp';
import type { ChangePlanImpact, ScopeName } from '@know-n/colp/types';
import { loadConfig } from '../../support/test-config.js';
import {
  appendAuditEvent,
  createPostgresMcpChangePlanStore,
  createPostgresMcpOauthRevocationStore,
  createUnitOfWork,
  runMigrations,
} from '../../../src/infrastructure/database/index.js';
import { createPhase4bMcpAgentApprovalApi } from '../../../src/infrastructure/collections/index.js';
import { issueAgentKey } from '../../../src/infrastructure/auth/agent-key-postgres.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { createMemoryMcpRateLimiter } from '../../../src/infrastructure/rate-limit/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { issueTestSession, type AuthenticatedTestClient } from '../../support/product-http-harness.js';
import { createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';

const ORIGIN = 'http://127.0.0.1:3000';
const IMPACT: ChangePlanImpact = Object.freeze({
  collections: 1, nodes: 1, annotations: 0, attachments: 0, relations: 0,
  privateFieldsExcluded: Object.freeze([]),
});

describeWithPostgres('E5 agent directory over PostgreSQL', () => {
  let isolated: IsolatedPostgresRuntime;
  let owner: AuthenticatedTestClient;
  let other: AuthenticatedTestClient;
  let app: ReturnType<typeof buildApiApp>;
  let oauthId: string;
  let sharedOauthId: string;
  let keyId: string;
  let foreignId: string;
  let versionedPlanId: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('e5_agents', {
      maxConnections: 8,
      applicationName: 'known-e5-agents',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    const config = testConfig(isolated.databaseUrl);
    const factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    owner = await issueTestSession({
      factory,
      subject: `e5-owner-${randomUUID()}`,
      handle: `e5o${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    });
    other = await issueTestSession({
      factory,
      subject: `e5-other-${randomUUID()}`,
      handle: `e5r${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    });
    const ownerUser = await authUserId(owner.accountId);
    const otherUser = await authUserId(other.accountId);
    oauthId = `agent-oauth-${randomUUID().slice(0, 8)}`;
    sharedOauthId = `agent-shared-${randomUUID().slice(0, 8)}`;
    foreignId = `agent-foreign-${randomUUID().slice(0, 8)}`;
    keyId = randomUUID();
    await insertOauthClient({
      id: `row-${oauthId}`,
      clientId: oauthId,
      userId: ownerUser,
      name: 'Claude',
      scopes: ['nodes:read', 'nodes:write'],
      createdAt: '2026-08-01T00:00:00.000Z',
      seenAt: '2026-08-02T03:04:05.000Z',
    });
    await insertOauthClient({
      id: `row-${foreignId}`,
      clientId: foreignId,
      userId: otherUser,
      name: 'Other',
      scopes: ['nodes:read'],
      createdAt: '2026-08-03T00:00:00.000Z',
      seenAt: null,
    });
    await insertOauthClient({
      id: `row-${sharedOauthId}`,
      clientId: sharedOauthId,
      userId: ownerUser,
      name: 'Shared agent',
      scopes: ['nodes:read'],
      createdAt: '2026-08-02T00:00:00.000Z',
      seenAt: '2026-08-02T04:00:00.000Z',
    });
    await insertOauthConsent(sharedOauthId, otherUser);
    await insertOauthToken(sharedOauthId, otherUser);
    await insertApiKey(keyId);
    await sql`
      INSERT INTO agent_policies (principal_id, client_id, policy, updated_at)
      VALUES (${owner.accountId}, ${oauthId}, 'trusted', current_timestamp)
    `.execute(isolated.runtime.db);
    versionedPlanId = await savePlan(oauthId, '2026-08-04T00:00:00.000Z');
    await sql`
      UPDATE mcp_change_plans
      SET status = 'approved', updated_at = current_timestamp
      WHERE plan_id = ${versionedPlanId}
    `.execute(isolated.runtime.db);
    await sql`
      INSERT INTO mcp_plan_policy_receipts (
        plan_id, client_id, approved_by, version_id, collection_id, cause
      ) VALUES (
        ${versionedPlanId}, ${oauthId}, 'policy', 'version-before-plan',
        'collection-1', ${`agent-plan:${versionedPlanId}`}
      )
    `.execute(isolated.runtime.db);
    await savePlan(oauthId, '2026-08-05T00:00:00.000Z');
    await savePlan(keyId, '2026-08-06T00:00:00.000Z');
    await createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      await appendAuditEvent(transaction, {
        operationId: null,
        collectionId: null,
        principalId: owner.accountId,
        eventType: 'mcp.direct_write',
        details: {
          clientId: oauthId,
          versionId: 'version-direct-1',
          summary: 'Created a bookmark',
          outcome: 'succeeded',
        },
      });
    });
    const identity = createPostgresIdentityUnitOfWork(isolated.runtime.db, {
      oidcTransactionSecrets: config.oidcTransactionSecrets,
    });
    app = buildApiApp({
      browserSessionAuthority: factory.authority,
      config,
      identityUnitOfWork: identity,
      mcpWriteApprovalRoutes: {
        enabled: true,
        allowedOrigins: [ORIGIN],
        identityUnitOfWork: identity,
        api: createPhase4bMcpAgentApprovalApi(isolated.runtime.db, {
          issueAgentKey: (accountId, name, commandId) => issueAgentKey(
            isolated.runtime.db, 'agent-api-test-hmac-key-0123456789', accountId, name, commandId),
        }),
        rateLimiter: createMemoryMcpRateLimiter({ approval: { maxRequests: 100, windowMs: 60_000 } }),
        timeoutMs: 5_000,
      },
    });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await isolated?.close();
  });

  test('lists oauth clients and API keys with policy, scopes, and last seen', async () => {
    const listed = await send(owner, 'GET', '/api/v1/me/agents');
    assert.equal(listed.status, 200);
    const body = listed.json as { agents: Array<Record<string, unknown>> };
    const oauth = body.agents.find((agent) => agent.id === oauthId);
    const key = body.agents.find((agent) => agent.id === keyId);
    assert.equal(body.agents.some((agent) => agent.id === foreignId), false);
    assert.equal(oauth?.name, 'Claude');
    assert.equal(oauth?.kind, 'oauth_client');
    assert.deepEqual(oauth?.scopes, ['nodes:read', 'nodes:write']);
    assert.equal(oauth?.policy, 'trusted');
    assert.equal(oauth?.createdAt, '2026-08-01T00:00:00.000Z');
    assert.equal(oauth?.lastSeenAt, '2026-08-02T03:04:05.000Z');
    assert.equal(key?.name, 'Script key');
    assert.equal(key?.kind, 'api_key');
    assert.deepEqual(key?.scopes, ['nodes:write']);
    assert.equal(key?.policy, 'manual');
    assert.equal(key?.lastSeenAt, '2026-08-07T01:02:03.000Z');
    const policy = await send(owner, 'GET', `/api/v1/me/agents/${oauthId}/policy`);
    assert.equal(policy.status, 200);
    assert.deepEqual(policy.json, { clientId: oauthId, policy: 'trusted' });
  });

  test('returns recent plans and direct writes with versionId', async () => {
    const response = await send(owner, 'GET', `/api/v1/me/agents/${oauthId}/audit`);
    assert.equal(response.status, 200);
    const records = (response.json as { records: Array<Record<string, unknown>> }).records;
    const versioned = records.find((record) => record.id === versionedPlanId);
    const direct = records.find((record) => record.kind === 'direct_write');
    assert.equal(versioned?.kind, 'plan');
    assert.equal(versioned?.outcome, 'approved');
    assert.equal(versioned?.versionId, 'version-before-plan');
    assert.equal(records.some((record) => record.kind === 'plan' && record.versionId === null), true);
    assert.equal(direct?.summary, 'Created a bookmark');
    assert.equal(direct?.outcome, 'succeeded');
    assert.equal(direct?.versionId, 'version-direct-1');
    const hidden = await send(other, 'GET', `/api/v1/me/agents/${oauthId}/audit`);
    assert.equal(hidden.status, 404);
    const anon = await app.inject({ method: 'GET', url: '/api/v1/me/agents' });
    assert.equal(anon.statusCode, 401);
  });

  test('a consenting account can revoke only its own OAuth consent and tokens', async () => {
    const response = await send(other, 'POST', `/api/v1/me/agents/${sharedOauthId}/revoke`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { id: sharedOauthId, revoked: true, cancelledPlanCount: 0 });

    const client = await sql<{ disabled: boolean | null }>`
      SELECT disabled FROM "auth_oauth_client" WHERE "clientId" = ${sharedOauthId}
    `.execute(isolated.runtime.db);
    assert.notEqual(client.rows[0]?.disabled, true, 'consent revocation must not disable the client');

    const consent = await sql<{ user_id: string }>`
      SELECT "userId" AS user_id FROM "auth_oauth_consent"
      WHERE "clientId" = ${sharedOauthId}
    `.execute(isolated.runtime.db);
    assert.equal(consent.rows.length, 0, 'the caller\'s consent must be removed');

    const tokens = await sql<{ user_id: string; revoked: Date | null }>`
      SELECT "userId" AS user_id, revoked
      FROM "auth_oauth_access_token"
      WHERE "clientId" = ${sharedOauthId}
      ORDER BY "userId"
    `.execute(isolated.runtime.db);
    assert.equal(tokens.rows.length, 2);
    const otherUserId = await authUserId(other.accountId);
    const ownerUserId = await authUserId(owner.accountId);
    const otherToken = tokens.rows.find((row) => row.user_id === otherUserId);
    const ownerToken = tokens.rows.find((row) => row.user_id === ownerUserId);
    assert.ok(otherToken?.revoked instanceof Date, 'consent user token must be revoked');
    assert.equal(ownerToken?.revoked, null, 'owner token must remain active');
    const refresh = await sql<{ revoked: Date | null }>`
      SELECT revoked FROM "auth_oauth_refresh_token"
      WHERE "clientId" = ${sharedOauthId} AND "userId" = ${otherUserId}
    `.execute(isolated.runtime.db);
    assert.ok(refresh.rows[0]?.revoked instanceof Date, 'consent user refresh token must be revoked');

    const store = createPostgresMcpOauthRevocationStore({ db: isolated.runtime.db });
    // The incident epoch floor was provisioned by the migration moments ago;
    // anchor it in the past so only the subject revocation is under test.
    const anchored = new Date(Date.now() - 3_600_000);
    await sql`
      UPDATE mcp_oauth_security_epoch SET effective_at = ${anchored}, updated_at = ${anchored} WHERE id = 1
    `.execute(isolated.runtime.db);
    const beforeRevocation = Math.floor(Date.now() / 1000) - 120;
    const afterRevocation = Math.floor(Date.now() / 1000) + 120;
    // The consenting user's existing bearers (JWT sub = BA user id = subject_id)
    // are retired for this client only; the registration owner keeps theirs,
    // and tokens minted after a later re-consent are accepted again.
    const otherSubject = await authUserId(other.accountId);
    const ownerSubject = await authUserId(owner.accountId);
    assert.equal(await store.isRevoked({ ...revocationQuery(sharedOauthId, beforeRevocation), subject: otherSubject }), true);
    assert.equal(await store.isRevoked({ ...revocationQuery(sharedOauthId, afterRevocation), subject: otherSubject }), false);
    assert.equal(await store.isRevoked({ ...revocationQuery(sharedOauthId, beforeRevocation), subject: ownerSubject }), false);
    assert.equal(await store.isRevoked({ ...revocationQuery(oauthId, beforeRevocation), subject: otherSubject }), false);
    assert.equal(await store.isRevoked(revocationQuery(sharedOauthId, afterRevocation)), false);

    // A repeated revocation moves the boundary forward instead of keeping the
    // first timestamp (ON CONFLICT DO UPDATE), so a re-consented bearer minted
    // in between is retired too.
    await sql`
      UPDATE mcp_oauth_subject_revocations SET revoked_at = current_timestamp - interval '1 hour'
    `.execute(isolated.runtime.db);
    await insertOauthConsent(sharedOauthId, otherSubject);
    const second = await send(other, 'POST', `/api/v1/me/agents/${sharedOauthId}/revoke`);
    assert.equal(second.status, 200);
    assert.equal(await store.isRevoked({ ...revocationQuery(sharedOauthId, beforeRevocation), subject: otherSubject }), true);
  });

  test('revokes one oauth client and one API key without touching the other', async () => {
    const denied = await send(other, 'POST', `/api/v1/me/agents/${oauthId}/revoke`);
    assert.equal(denied.status, 404);
    const missingCsrf = await app.inject({
      method: 'POST',
      url: `/api/v1/me/agents/${oauthId}/revoke`,
      headers: { cookie: owner.cookie, origin: ORIGIN },
    });
    assert.equal(missingCsrf.statusCode, 403);
    const oauth = await send(owner, 'POST', `/api/v1/me/agents/${oauthId}/revoke`);
    assert.equal(oauth.status, 200);
    const oauthBody = oauth.json as { id: string; revoked: boolean; cancelledPlanCount: number };
    assert.equal(oauthBody.id, oauthId);
    assert.equal(oauthBody.revoked, true);
    assert.equal(oauthBody.cancelledPlanCount, 2);
    const key = await send(owner, 'POST', `/api/v1/me/agents/${keyId}/revoke`);
    assert.equal(key.status, 200);
    assert.equal((key.json as { cancelledPlanCount: number }).cancelledPlanCount, 1);
    const again = await send(owner, 'POST', `/api/v1/me/agents/${oauthId}/revoke`);
    assert.equal(again.status, 200);
    assert.equal((again.json as { cancelledPlanCount: number }).cancelledPlanCount, 0);
    const listed = await send(owner, 'GET', '/api/v1/me/agents');
    const ids = (listed.json as { agents: Array<{ id: string }> }).agents.map((agent) => agent.id);
    assert.equal(ids.includes(oauthId), false);
    assert.equal(ids.includes(keyId), false);
    const plans = await sql<{ status: string }>`
      SELECT status FROM mcp_change_plans
      WHERE client_id IN (${oauthId}, ${keyId}) AND principal_id = ${owner.accountId}
    `.execute(isolated.runtime.db);
    assert.equal(plans.rows.every((row) => row.status === 'cancelled'), true);
    const credential = await sql<{ state: string }>`
      SELECT state FROM account_credentials WHERE mcp_client_id = ${keyId}
    `.execute(isolated.runtime.db);
    assert.equal(credential.rows[0]?.state, 'revoked');
    const disabled = await sql<{ disabled: boolean }>`
      SELECT disabled FROM "auth_oauth_client" WHERE "clientId" = ${oauthId}
    `.execute(isolated.runtime.db);
    assert.equal(disabled.rows[0]?.disabled, true);
    const foreign = await sql<{ disabled: boolean | null }>`
      SELECT disabled FROM "auth_oauth_client" WHERE "clientId" = ${foreignId}
    `.execute(isolated.runtime.db);
    assert.notEqual(foreign.rows[0]?.disabled, true);
    const store = createPostgresMcpOauthRevocationStore({ db: isolated.runtime.db });
    const issuedAtSeconds = Math.floor(Date.now() / 1000) + 120;
    assert.equal(await store.isRevoked(revocationQuery(oauthId, issuedAtSeconds)), true);
    assert.equal(await store.isRevoked(revocationQuery(keyId, issuedAtSeconds)), true);
    assert.equal(await store.isRevoked(revocationQuery(foreignId, issuedAtSeconds)), false);
  });

  async function authUserId(accountId: string): Promise<string> {
    const row = await sql<{ auth_user_id: string }>`
      SELECT auth_user_id FROM auth_user_account_map WHERE account_id = ${accountId}
    `.execute(isolated.runtime.db);
    const userId = row.rows[0]?.auth_user_id;
    if (userId === undefined) throw new Error('missing auth user mapping');
    return userId;
  }

  test('issues an owner-bound key once and refuses policies on another account agent', async () => {
    const commandId = randomUUID();
    const headers = { cookie: owner.cookie, origin: ORIGIN, 'x-csrf-token': owner.csrfToken,
      'known-command-id': commandId, 'content-type': 'application/json' };
    const issued = await app.inject({ method: 'POST', url: '/api/v1/me/agents/keys', headers, payload: { name: 'Local script' } });
    assert.equal(issued.statusCode, 201, issued.body);
    const key = issued.json() as { id: string; secret: string };
    assert.ok(key.secret);
    const row = await isolated.runtime.db.selectFrom('account_credentials').select(['account_id', 'manager_account_id'])
      .where('mcp_client_id', '=', key.id).executeTakeFirstOrThrow();
    assert.equal(row.account_id, owner.accountId);
    assert.equal(row.manager_account_id, owner.accountId);
    const replay = await app.inject({ method: 'POST', url: '/api/v1/me/agents/keys', headers, payload: { name: 'Local script' } });
    assert.equal(replay.statusCode, 412, replay.body);
    assert.equal(replay.body.includes(key.secret), false);
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const signing = { ...privateKey.export({ format: 'jwk' }), kid: 'agent-key-test' } as AccountKeyEs256PrivateJwk;
    const uow = createPostgresAccountCredentialUnitOfWork(isolated.runtime.db, undefined, undefined,
      { secretHmacKey: 'agent-api-test-hmac-key-0123456789' });
    await assert.rejects(() => uow.execute((ports) => exchangeAccountKey(ports, {
      body: { grant_type: 'urn:known:params:oauth:grant-type:account-key', credential: key.secret,
        audience: 'product', scope: 'product:write' }, supportedScopes: ['product:write'],
      audienceConfig: { productOrigin: ORIGIN }, privateJwk: signing, issuer: ORIGIN,
    })), (error: unknown) => error instanceof Error && (error as { error?: string }).error === 'invalid_scope');
    const foreign = await send(owner, 'GET', `/api/v1/me/agents/${foreignId}/policy`);
    assert.equal(foreign.status, 404);
  });

  async function insertOauthClient(input: {
    readonly id: string;
    readonly clientId: string;
    readonly userId: string;
    readonly name: string;
    readonly scopes: readonly string[];
    readonly createdAt: string;
    readonly seenAt: string | null;
  }): Promise<void> {
    await sql`
      INSERT INTO "auth_oauth_client" (
        "id", "clientId", "userId", "name", "scopes", "redirectUris", "createdAt", "disabled"
      ) VALUES (
        ${input.id}, ${input.clientId}, ${input.userId}, ${input.name},
        ${JSON.stringify(input.scopes)}::jsonb,
        '["http://127.0.0.1/callback"]'::jsonb,
        ${input.createdAt}::timestamptz,
        false
      )
    `.execute(isolated.runtime.db);
    if (input.seenAt === null) return;
    await sql`
      INSERT INTO "auth_oauth_access_token" (
        "id", "token", "clientId", "userId", "expiresAt", "createdAt", "scopes"
      ) VALUES (
        ${`token-${input.clientId}`}, ${`token-value-${input.clientId}`}, ${input.clientId},
        ${input.userId}, '2030-01-01T00:00:00.000Z'::timestamptz,
        ${input.seenAt}::timestamptz, '["nodes:read"]'::jsonb
      )
    `.execute(isolated.runtime.db);
  }

  async function insertOauthConsent(clientId: string, userId: string): Promise<void> {
    await sql`
      INSERT INTO "auth_oauth_consent" (
        "id", "clientId", "userId", "scopes", "createdAt", "updatedAt"
      ) VALUES (
        ${`consent-${clientId}`}, ${clientId}, ${userId}, '["nodes:read"]'::jsonb,
        '2026-08-02T04:00:00.000Z'::timestamptz, '2026-08-02T04:00:00.000Z'::timestamptz
      )
    `.execute(isolated.runtime.db);
  }

  async function insertOauthToken(clientId: string, userId: string): Promise<void> {
    await sql`
      INSERT INTO "auth_oauth_access_token" (
        "id", "token", "clientId", "userId", "expiresAt", "createdAt", "scopes"
      ) VALUES (
        ${`token-${clientId}-other`}, ${`token-value-${clientId}-other`}, ${clientId}, ${userId},
        '2030-01-01T00:00:00.000Z'::timestamptz, '2026-08-02T04:00:00.000Z'::timestamptz,
        '["nodes:read"]'::jsonb
      )
    `.execute(isolated.runtime.db);
    await sql`
      INSERT INTO "auth_oauth_refresh_token" (
        "id", "token", "clientId", "userId", "expiresAt", "createdAt", "scopes"
      ) VALUES (
        ${`refresh-${clientId}-other`}, ${`refresh-value-${clientId}-other`}, ${clientId}, ${userId},
        '2030-01-01T00:00:00.000Z'::timestamptz, '2026-08-02T04:00:00.000Z'::timestamptz,
        '["nodes:read"]'::jsonb
      )
    `.execute(isolated.runtime.db);
  }

  async function insertApiKey(mcpClientId: string): Promise<void> {
    const parentId = `parent-${mcpClientId}`;
    const childId = `child-${mcpClientId}`;
    const expires = '2030-01-01T00:00:00.000Z';
    await sql`
      INSERT INTO account_credentials (
        id, kind, parent_id, account_id, subject_id, manager_account_id, label, prefix,
        secret_hash, state, revision, epoch, expires_at, created_at, mcp_client_id
      ) VALUES (
        ${parentId}, 'parent', null, ${owner.accountId}, ${owner.subjectId}, ${owner.accountId},
        'Parent', ${`kn_p_${parentId}`.slice(0, 32)}, ${'a'.repeat(64)}, 'active', 1, 1,
        ${expires}::timestamptz, '2026-08-01T00:00:00.000Z'::timestamptz, ${randomUUID()}
      )
    `.execute(isolated.runtime.db);
    await sql`
      INSERT INTO account_credentials (
        id, kind, parent_id, account_id, subject_id, manager_account_id, label, prefix,
        secret_hash, state, revision, epoch, expires_at, created_at, last_used_at, mcp_client_id
      ) VALUES (
        ${childId}, 'child', ${parentId}, ${owner.accountId}, ${owner.subjectId}, ${owner.accountId},
        'Script key', ${`kn_c_${childId}`.slice(0, 32)}, ${'b'.repeat(64)}, 'active', 1, 1,
        ${expires}::timestamptz, '2026-08-03T00:00:00.000Z'::timestamptz,
        '2026-08-07T01:02:03.000Z'::timestamptz, ${mcpClientId}
      )
    `.execute(isolated.runtime.db);
    await sql`
      INSERT INTO account_credential_grants (
        id, credential_id, owner_account_id, resource_kind, resource_id, actions_json,
        state, revision, expires_at
      ) VALUES (
        ${`grant-${childId}`}, ${childId}, ${owner.accountId}, 'collection', 'collection-1',
        '["collection.content.write"]'::jsonb, 'active', 1, ${expires}::timestamptz
      )
    `.execute(isolated.runtime.db);
  }

  async function savePlan(clientId: string, createdAt: string): Promise<string> {
    const store = createPostgresMcpChangePlanStore(isolated.runtime.db);
    const planId = `plan-e5-${randomUUID().replaceAll('-', '')}`;
    const binding: McpAuthenticatedAuthorizationBinding = Object.freeze({
      kind: 'authenticated',
      principalId: owner.accountId,
      clientId,
      credentialBindingId: 'credential-1',
      resourceAudience: 'colp://known/collections',
      securityEpoch: 'known.mcp.oauth.v1',
    });
    const value: McpStoredPlan = Object.freeze({
      planId,
      expiresAt: '2030-01-01T00:00:00.000Z',
      risk: 'low',
      requiresApproval: true,
      approvalMethod: 'out_of_band',
      approvalUri: `https://approve.example/approvals/${planId}`,
      summary: `Plan ${planId}`,
      impact: IMPACT,
      requiredScopes: Object.freeze(['access:write'] as readonly ScopeName[]),
      baseRevisions: Object.freeze({ 'content.collection-1': 'content-r1' }),
      operations: Object.freeze([Object.freeze({
        type: 'create_node',
        collectionId: 'collection-1',
        baseRevision: 'content-r1',
        input: Object.freeze({ title: 'Note' }),
      })]),
      operationsDigest: `sha-256:${randomUUID()}`,
      binding,
      untrustedNote: '',
      createdAt,
      status: 'pending',
    } as unknown as McpStoredPlan);
    await store.planStore.save(value);
    return planId;
  }

  async function send(
    actor: AuthenticatedTestClient,
    method: 'GET' | 'POST',
    url: string,
  ): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = { cookie: actor.cookie };
    if (method === 'POST') {
      headers.origin = ORIGIN;
      headers['x-csrf-token'] = actor.csrfToken;
    }
    const response = await app.inject({ method, url, headers });
    return { status: response.statusCode, json: response.json() };
  }
});

function testConfig(databaseUrl: string) {
  return loadConfig({
    DATABASE_URL: databaseUrl,
    PRODUCT_ORIGIN: ORIGIN,
    ALLOWED_ORIGINS: ORIGIN,
    OIDC_ISSUER: 'https://issuer.example/realms/known',
    OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'e5-editor-cursor-key',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
  });
}

function revocationQuery(clientId: string, issuedAtSeconds: number) {
  return {
    issuer: 'https://issuer.example',
    subject: 'subject',
    clientId,
    tokenId: 'jti-1',
    credentialDigest: 'c'.repeat(43),
    issuedAtSeconds,
  };
}
