/**
 * Shared Fastify/Postgres harness for the MCP-CQ-07 compat write lifecycle.
 * Token subject is Better Auth `accounts.subject_id`; principal is `accounts.id`.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from './test-config.js';
import {
  createMcpChangePlanRateLimitPort,
  createPhase4bMcpWriteComposition,
} from '../../src/bootstrap/mcp-write-composition.js';
import { createPostgresCanonicalMutationUnitOfWork } from '../../src/infrastructure/collections/index.js';
import {
  createPostgresMcpWriteApprovalPorts,
  createPostgresMcpWriteOperationsStore,
  type DatabaseRuntime,
} from '../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../src/infrastructure/identity/index.js';
import { createMemoryMcpRateLimiter } from '../../src/infrastructure/rate-limit/index.js';
import {
  createOwnedCollectionCanonical,
  type CreateOwnedCollectionInput,
} from '../../src/modules/collections/index.js';
import {
  createMcpOauthVerifier,
  createPhase4bMcpChangeSignalSource,
  createPhase4bMcpWriteApprovalApi,
  type McpOauthVerifier,
} from '../../src/modules/mcp/index.js';
import { buildApiApp } from '../../src/transport/app.js';
import type { PostgresBetterAuthTestFactory } from './better-auth-test-factory.js';
import type { AuthenticatedTestClient } from './product-http-harness.js';
import {
  assertCompatCallToolEnvelope,
  assertCompatNegotiatedVersionHeader,
  compatJsonRpc,
  injectCompatLegacyPost,
} from './phase4b-mcp-compat-admission.js';
import {
  COMPAT_REVISION,
  COMPAT_WRITE_SCOPES,
  mintCompatWriteToken,
} from './phase4b-mcp-compat-write-auth.js';
import { emptyReadToolAdapterBundle } from './phase4b-mcp-read-tools-fixture.js';
import {
  AUDIENCE,
  createKeyFixture,
  emptyNodeResourceProjection,
  emptyResourceProjection,
  emptySnapshotResourceProjection,
  mcpEnv,
  staticJwksProvider,
  verifierOptions,
} from './phase4b-mcp-transport-scaffold.js';

export const CQ07_SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
export const CQ07_PRODUCT_ORIGIN = 'http://127.0.0.1:3000';
export const CQ07_APPROVAL_BASE_URI = `${CQ07_PRODUCT_ORIGIN}/approvals`;
export const CQ07_FROZEN_INVALID_WRITE_ARGS = 'Invalid MCP write Tool arguments.';
export const CQ07_FROZEN_POLICY_REJECTED = 'Write policy rejected this request.';
export const CQ07_CSRF_FAILED_MESSAGE = 'The request failed CSRF or Origin validation.';

const REQUEST_STATE_KEY = 'known-mcp-cq07-request-state-key-0123456789abcdef0123456789';

export interface CompatWriteCollectionFixture {
  readonly collectionId: string;
  readonly rootId: string;
}

export interface CompatWriteLifecycleAuth {
  readonly verifier: McpOauthVerifier;
  readonly ownerToken: string;
  readonly outsiderToken: string;
}

export async function mintAlignedCompatWriteTokens(input: {
  readonly runtime: DatabaseRuntime;
  readonly owner: AuthenticatedTestClient;
  readonly outsider: AuthenticatedTestClient;
}): Promise<CompatWriteLifecycleAuth> {
  const key = await createKeyFixture('cq07-compat');
  const ownerToken = await mintCompatWriteToken({
    key: key.privateKey,
    kid: key.kid,
    scopes: COMPAT_WRITE_SCOPES,
    subject: input.owner.subjectId,
    jti: 'cq07-owner-jti',
  });
  const outsiderToken = await mintCompatWriteToken({
    key: key.privateKey,
    kid: key.kid,
    scopes: COMPAT_WRITE_SCOPES,
    subject: input.outsider.subjectId,
    jti: 'cq07-outsider-jti',
  });
  const verifier = createMcpOauthVerifier(verifierOptions({
    allowedScopes: [...COMPAT_WRITE_SCOPES],
    audience: `${AUDIENCE}-compat`,
    jwks: staticJwksProvider([key.jwk]),
    securityEpoch: async () => {
      const row = (await input.runtime.pool.query<{ security_epoch: string }>(
        `select security_epoch::text as security_epoch from accounts where id = $1`,
        [input.owner.accountId],
      )).rows[0];
      return row?.security_epoch ?? '0';
    },
    resolveAccountBySubject: async (sub) => {
      const row = (await input.runtime.pool.query<{
        id: string;
        subject_id: string;
        status: string;
      }>(
        `select id, subject_id, status from accounts
         where subject_id = $1 and deleted_at is null`,
        [sub],
      )).rows[0];
      if (row === undefined || row.status !== 'active') return null;
      return { id: row.id, subjectId: row.subject_id, status: row.status };
    },
  }));
  return { verifier, ownerToken, outsiderToken };
}

export async function createOwnedCompatWriteCollection(
  runtime: DatabaseRuntime,
  owner: AuthenticatedTestClient,
): Promise<CompatWriteCollectionFixture> {
  const collectionId = randomBytes(16).toString('base64url');
  const rootId = randomBytes(16).toString('base64url');
  const created = await createPostgresCanonicalMutationUnitOfWork(runtime.db).execute((ports) =>
    createOwnedCollectionCanonical(ports, {
      actor: {
        principalId: owner.accountId,
        principalType: 'account',
        subjectId: owner.subjectId,
      },
      command: { commandId: randomUUID(), fingerprint: `cq07-${collectionId}` },
      title: 'MCP CQ-07 Collection',
      summary: null,
      kind: 'bookmarks',
      collectionId,
      rootNodeId: rootId,
      operationId: randomUUID(),
    } satisfies CreateOwnedCollectionInput));
  assert.equal(created.kind, 'created');
  return { collectionId, rootId };
}

export async function queryCompatWriteBusinessCounts(
  runtime: DatabaseRuntime,
  fixture: CompatWriteCollectionFixture,
): Promise<Readonly<Record<string, number | string>>> {
  const counts = (await runtime.pool.query<{
    nodes: number;
    operations: number;
    audits: number;
    outbox: number;
    receipts: number;
    resourceRevisions: number;
    contentRevisions: number;
    childrenRevisions: number;
  }>(`select
    (select count(*)::int from nodes) nodes,
    (select count(*)::int from operations) operations,
    (select count(*)::int from audit_events) audits,
    (select count(*)::int from outbox_events) outbox,
    (select count(*)::int from product_command_receipts) receipts,
    (select count(*)::int from resource_revisions) as "resourceRevisions",
    (select count(*)::int from content_revisions) as "contentRevisions",
    (select count(*)::int from children_revisions) as "childrenRevisions"`)).rows[0]!;
  const collection = (await runtime.pool.query<{
    content_revision: string;
    policy_revision: string;
  }>(
    `select content_revision, policy_revision from collections where id = $1`,
    [fixture.collectionId],
  )).rows[0]!;
  const root = (await runtime.pool.query<{ children_revision: string }>(
    `select children_revision from nodes where id = $1`,
    [fixture.rootId],
  )).rows[0]!;
  return Object.freeze({
    ...counts,
    contentRevision: collection.content_revision,
    policyRevision: collection.policy_revision,
    childrenRevision: root.children_revision,
  });
}

export function createCompatWriteLifecycleHarness(input: {
  readonly runtime: DatabaseRuntime;
  readonly databaseUrl: string;
  readonly factory: PostgresBetterAuthTestFactory;
  readonly auth: CompatWriteLifecycleAuth;
}): {
  startApp(): Promise<{ readonly app: FastifyInstance; readonly listenOrigin: string }>;
  closeApp(): Promise<void>;
} {
  let app: FastifyInstance | undefined;
  let listenOrigin = '';

  async function closeApp(): Promise<void> {
    await app?.close().catch(() => undefined);
    app = undefined;
    listenOrigin = '';
  }

  async function startApp(): Promise<{ readonly app: FastifyInstance; readonly listenOrigin: string }> {
    await closeApp();
    const config = loadConfig(lifecycleEnv(input.databaseUrl));
    const composition = createPhase4bMcpWriteComposition({
      db: input.runtime.db,
      serverUuid: CQ07_SERVER_UUID,
      approvalBaseUri: CQ07_APPROVAL_BASE_URI,
      requestStateKey: REQUEST_STATE_KEY,
      allowedScopes: [...COMPAT_WRITE_SCOPES],
      metrics: { increment() {}, gauge() {}, observe() {} },
      rateLimit: createMcpChangePlanRateLimitPort({
        maxPlans: 100,
        windowMs: 60_000,
        now: () => Date.now(),
      }),
      productOrigin: CQ07_PRODUCT_ORIGIN,
    });
    const identityUnitOfWork = createPostgresIdentityUnitOfWork(input.runtime.db, {
      oidcTransactionSecrets: config.oidcTransactionSecrets,
    });
    const readSurface = emptyReadToolAdapterBundle();
    const instance = buildApiApp({
      config,
      browserSessionAuthority: input.factory.authority,
      identityUnitOfWork,
      mcpReadTransport: {
        changeSignalSource: createPhase4bMcpChangeSignalSource(),
        readToolAdapter: readSurface.adapter,
        readToolParamDeclarations: readSurface.paramDeclarations,
        oauthVerifier: input.auth.verifier,
        writeToolAdapter: composition.adapter,
        writeToolParamDeclarations: composition.paramDeclarations,
      },
      mcpReadResourceProjection: emptyResourceProjection(),
      mcpNodeResourceProjection: emptyNodeResourceProjection(),
      mcpSnapshotResourceProjection: emptySnapshotResourceProjection(),
      mcpWriteOperations: createPostgresMcpWriteOperationsStore(input.runtime.db),
      mcpWriteApprovalRoutes: {
        enabled: true,
        allowedOrigins: [CQ07_PRODUCT_ORIGIN],
        identityUnitOfWork,
        api: createPhase4bMcpWriteApprovalApi(createPostgresMcpWriteApprovalPorts(input.runtime.db)),
        rateLimiter: createMemoryMcpRateLimiter({ approval: { maxRequests: 100, windowMs: 60_000 } }),
        timeoutMs: 5_000,
      },
    });
    listenOrigin = await instance.listen({ host: '127.0.0.1', port: 0 });
    app = instance;
    return { app: instance, listenOrigin };
  }

  return { startApp, closeApp };
}

export function callCompat(app: FastifyInstance, payload: unknown, token: string) {
  return injectCompatLegacyPost(
    app,
    payload,
    COMPAT_REVISION,
    { authorization: `Bearer ${token}` },
  );
}

export function assertCompatJsonSuccess(
  response: {
    readonly statusCode: number;
    readonly headers: Record<string, unknown>;
    readonly payload: string;
  },
  id: number,
): void {
  assert.equal(response.statusCode, 200);
  assert.match(
    String(response.headers['content-type'] ?? ''),
    /^(application\/json|text\/event-stream)\b/u,
  );
  assertCompatNegotiatedVersionHeader(response.headers);
  const rpc = compatJsonRpc(response);
  assert.equal(rpc.error, undefined);
  assert.ok(rpc.result, `JSON-RPC id ${String(id)} must have a result`);
  const envelope = parseJsonRpcEnvelope(response.payload);
  assert.equal(envelope.jsonrpc, '2.0');
  assert.equal(envelope.id, id);
}

export function parseJsonRpcEnvelope(payload: string): {
  readonly jsonrpc?: string;
  readonly id?: unknown;
} {
  const trimmed = payload.trim();
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed) as { readonly jsonrpc?: string; readonly id?: unknown };
  }
  for (const line of payload.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice('data:'.length).trim();
    if (data.length === 0) continue;
    return JSON.parse(data) as { readonly jsonrpc?: string; readonly id?: unknown };
  }
  throw new Error('compat response is not JSON-RPC JSON or SSE data');
}

export function assertRejectedCompatCall(
  result: Record<string, unknown> | undefined,
  frozenMessage: string,
): void {
  assertCompatCallToolEnvelope(result);
  assert.equal(result?.isError, true);
  const text = (result?.content as readonly { readonly text?: string }[] | undefined)?.[0]?.text;
  assert.equal(text, frozenMessage);
}

export async function assertCsrfFailed(response: Response): Promise<void> {
  assert.equal(response.status, 403);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/u);
  const body = await response.json() as { readonly error?: { readonly code?: string; readonly message?: string } };
  assert.equal(body.error?.code, 'csrf_failed');
  assert.equal(body.error?.message, CQ07_CSRF_FAILED_MESSAGE);
}

function lifecycleEnv(databaseUrl: string): Record<string, string> {
  return mcpEnv({
    DATABASE_URL: databaseUrl,
    PRODUCT_ORIGIN: CQ07_PRODUCT_ORIGIN,
    ALLOWED_ORIGINS: CQ07_PRODUCT_ORIGIN,
    KNOWN_FEATURE_MCP_COMPAT: 'true',
    KNOWN_FEATURE_MCP_WRITE: 'true',
    MCP_OAUTH_SCOPES: COMPAT_WRITE_SCOPES.join(','),
    MCP_WRITE_REQUEST_STATE_KEY: Buffer.alloc(32, 77).toString('base64'),
    MCP_WRITE_APPROVAL_BASE_URI: CQ07_APPROVAL_BASE_URI,
    PUBLICATION_SERVER_UUID: CQ07_SERVER_UUID,
    MCP_SERVER_UUID: CQ07_SERVER_UUID,
    OIDC_ISSUER: 'https://issuer.example/realms/known',
    OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: `${CQ07_PRODUCT_ORIGIN}/api/v1/auth/oidc/callback`,
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'cq07-editor-cursor-key',
  });
}
