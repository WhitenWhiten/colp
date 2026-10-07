import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as nodeHttpRequest } from 'node:http';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SignJWT, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';
import type {
  Mcp20260728WriteToolAdapter,
  Mcp20260728XMcpHeaderDeclaration,
} from '@know-n/colp/mcp';
import { createPostgresMcpWriteOperationsStore, runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresCanonicalMutationUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { createOwnedCollectionCanonical, type CreateOwnedCollectionInput } from '../../../src/modules/collections/index.js';
import {
  PHASE4B_MCP_CONFIG_ENDPOINT_PATH,
  PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES,
  createPhase4bMcpChangeSignalSource,
  createMcpOauthVerifier,
  type McpOauthVerifier,
  type Phase4bMcpCollectionResourceProjection,
  type Phase4bMcpNodeResourceProjection,
  type Phase4bMcpSnapshotResourceProjection,
} from '../../../src/modules/mcp/index.js';
import { loadConfig } from '../../support/test-config.js';
import {
  createMcpChangePlanRateLimitPort,
  createPhase4bMcpWriteComposition,
} from '../../../src/bootstrap/mcp-write-composition.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { emptyReadToolAdapterBundle } from '../../support/phase4b-mcp-read-tools-fixture.js';
import { createPhase4bMcpOfficialClient } from '../../../scripts/evidence/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateFixtureTables,
} from '../../support/postgres-test-runtime.js';
import { McpResourceNotFoundError } from '@know-n/colp/mcp';
import {
  createMcpTestFetch,
  mcpHttpPost,
  withMcpTestHost,
} from '../../support/phase4b-mcp-transport-scaffold.js';

const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const NOW = new Date('2026-08-06T08:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
const ISSUER = 'https://issuer.example.test/realms/known';
const AUDIENCE = 'https://collections.example.test/collections/-/mcp';
const CLIENT_ID = 'mcp-write-client';
const WRITE_SCOPES = ['nodes:write', 'access:write', 'changes:commit', 'changes:cancel'];
const PRINCIPAL_ID = 'BgYGBgYGBgYGBgYGBgYGBg';

function postDuplicateMcpMethod(origin: string): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const request = nodeHttpRequest(new URL(`${origin}${PHASE4B_MCP_CONFIG_ENDPOINT_PATH}`), {
      method: 'POST',
      headers: {
        ...withMcpTestHost({
          'content-type': 'application/json',
          'mcp-protocol-version': '2026-07-28',
          accept: 'application/json;q=1, text/event-stream;q=0.5',
        }),
        'mcp-method': ['server/discover', 'tools/call'],
      },
    }, (incoming) => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk: string) => { body += chunk; });
      incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body }));
    });
    request.on('error', reject);
    request.end(modernBody('server/discover', 10));
  });
}

describeWithPostgres('MCP-W10 real Fastify Write lifecycle with Read regression', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;
  let app: FastifyInstance | undefined;
  let origin = '';
  let auth: { readonly verifier: McpOauthVerifier; readonly token: string };

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase4b_mcp_w10', {
      maxConnections: 16,
      applicationName: 'known-mcp-w10-test',
    });
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
    await runtime.pool.query(
      `insert into accounts(id, subject_id, status, security_epoch)
       values ($1, $1, 'active', 0)`,
      [PRINCIPAL_ID],
    );
    await runtime.pool.query(
      `insert into profiles(account_id, display_name, avatar_url)
       values ($1, 'MCP W10 owner', null)`,
      [PRINCIPAL_ID],
    );
  }, 120_000);

  afterAll(async () => {
    await isolated?.close();
  });

  beforeEach(async () => {
    await app?.close().catch(() => undefined);
    app = undefined;
    await truncateFixtureTables(runtime.pool, `truncate table product_command_receipts, outbox_events, audit_events,
      operations, policy_revisions, content_revisions, children_revisions, resource_revisions,
      collection_policies, collection_members, nodes, collections, resource_id_ledger,
      profiles, accounts, mcp_commit_receipts, mcp_approvals, mcp_change_plans cascade`);
    await runtime.pool.query(
      `insert into accounts(id, subject_id, status, security_epoch)
       values ($1, $1, 'active', 0)`,
      [PRINCIPAL_ID],
    );
    await runtime.pool.query(
      `insert into profiles(account_id, display_name, avatar_url)
       values ($1, 'MCP W10 owner', null)`,
      [PRINCIPAL_ID],
    );
    auth = await authFixture();
  });

  test('mounted W06 Tools persist canonical writes and MRTR plans over the existing MCP route', async () => {
    const fixture = await createFixture();
    const composition = createPhase4bMcpWriteComposition({
      db: runtime.db,
      serverUuid: SERVER_UUID,
      approvalBaseUri: 'https://approve.example/approvals',
      requestStateKey: 'known-mcp-w10-request-state-key-0123456789abcdef0123456789',
      requestStateClock: () => NOW.getTime(),
      allowedScopes: WRITE_SCOPES,
      metrics: {
        increment() {},
        gauge() {},
        observe() {},
      },
      rateLimit: createMcpChangePlanRateLimitPort({
        maxPlans: 100,
        windowMs: 60_000,
        now: () => NOW.getTime(),
      }),
    });
    const server = await startApi(composition.adapter, composition.paramDeclarations);

    const list = await postJson(server, 'tools/list', 1, {
      headers: { authorization: `Bearer ${auth.token}` },
    });
    const listPayload = await list.json() as { result?: { tools?: Array<{ name: string }> } };
    assert.deepEqual(
      listPayload.result?.tools?.map((tool) => tool.name).sort(),
      [...PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES].sort(),
    );
    assert.equal(listPayload.result?.tools?.some((tool) => tool.name === 'nodes.set_visibility'), false);

    const create = await postJson(server, 'tools/call', 2, {
      headers: {
        authorization: `Bearer ${auth.token}`,
        'mcp-name': 'nodes.create',
        'mcp-param-X-Collection-Id': fixture.collectionId,
      },
      body: modernBody('tools/call', 2, {
        name: 'nodes.create',
        arguments: {
          collectionId: fixture.collectionId,
          parentId: fixture.rootId,
          node: {
            kind: 'bookmark',
            title: 'W10 accepted host bookmark',
            url: 'https://example.test/w10',
            description: null,
            tags: ['w10'],
            visibility: 'private',
          },
          reason: 'create low-risk bookmark',
          confirmApply: true,
        },
      }),
    });
    const createPayload = await create.json() as {
      result?: { resultType?: string; structuredContent?: { node?: { id?: string } } };
    };
    assert.equal(createPayload.result?.resultType, 'complete');
    const createdId = createPayload.result?.structuredContent?.node?.id;
    assert.ok(createdId);
    assert.equal((await runtime.pool.query<{ count: number }>(
      `select count(*)::int count from nodes where id = $1`,
      [createdId],
    )).rows[0]?.count, 1);

    const official = createPhase4bMcpOfficialClient({
      url: `${server}${PHASE4B_MCP_CONFIG_ENDPOINT_PATH}`,
      authorization: `Bearer ${auth.token}`,
      fetch: createMcpTestFetch(),
    });
    await official.connect();
    let planId: string | undefined;
    let afterCommit: { readonly resource_revision: string } | undefined;
    try {
      const discover = await official.discover() as { resultType?: string };
      assert.equal(discover.resultType, 'complete');
      const listed = await official.request('tools/list', {}) as {
        tools?: Array<{ name: string }>;
      };
      assert.deepEqual(
        listed.tools?.map((tool) => tool.name).sort(),
        [...PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES].sort(),
      );
      const plan = await official.request('tools/call', {
        name: 'changes.plan',
        arguments: {
          operations: [{
            type: 'set_visibility',
            collectionId: fixture.collectionId,
            baseRevision: fixture.resourceRevision,
            input: { visibility: 'protected' },
          }],
          reason: 'approve visibility change',
          dryRun: true,
        },
      }) as {
        resultType?: string;
        requestState?: string;
        plan?: { planId?: string };
      };
      assert.equal(plan.resultType, 'input_required');
      planId = plan.plan?.planId;
      assert.ok(planId);

      const waitCommit = await official.request('tools/call', {
        name: 'changes.commit',
        arguments: { planId, idempotencyKey: 'w10-idem' },
      }) as { resultType?: string; requestState?: string };
      assert.equal(waitCommit.resultType, 'input_required');
      const commitState = waitCommit.requestState;
      assert.ok(commitState);

      await composition.changePlanService.recordOutOfBandApproval(planId, await binding());

      const commit = await official.request('tools/call', {
        name: 'changes.commit',
        arguments: { planId, idempotencyKey: 'w10-idem' },
        requestState: commitState,
        inputResponses: { approval: { action: 'accept' } },
      }) as {
        resultType?: string;
        structuredContent?: { planId?: string; operations?: readonly unknown[] };
      };
      assert.equal(commit.resultType, 'complete');
      assert.equal(commit.structuredContent?.planId, planId);
      assert.equal(commit.structuredContent?.operations?.length, 1);

      const replay = await official.request('tools/call', {
        name: 'changes.commit',
        arguments: { planId, idempotencyKey: 'w10-idem' },
        requestState: commitState,
        inputResponses: { approval: { action: 'accept' } },
      }) as { resultType?: string; structuredContent?: { planId?: string } };
      assert.equal(replay.resultType, 'complete');
      assert.equal(replay.structuredContent?.planId, planId);

      assert.equal((await runtime.pool.query<{ count: number }>(
        `select count(*)::int count from nodes
         where id = $1 and visibility = 'protected'`,
        [fixture.nodeId],
      )).rows[0]?.count, 1);
      afterCommit = (await runtime.pool.query<{ resource_revision: string }>(
        `select resource_revision from nodes where id = $1`,
        [fixture.nodeId],
      )).rows[0];
      assert.ok(afterCommit);

      const counts = await runtime.pool.query<{
        plans: number;
        approvals: number;
        consumed_approvals: number;
        receipts: number;
        completed_receipts: number;
      }>(`select
        (select count(*)::int from mcp_change_plans where plan_id = $1) plans,
        (select count(*)::int from mcp_approvals where plan_id = $1) approvals,
        (select count(*)::int from mcp_approvals where plan_id = $1 and consumed_at is not null) consumed_approvals,
        (select count(*)::int from mcp_commit_receipts where plan_id = $1) receipts,
        (select count(*)::int from mcp_commit_receipts where plan_id = $1 and completed_at is not null) completed_receipts`,
      [planId]);
      assert.deepEqual(counts.rows[0], {
        plans: 1,
        approvals: 1,
        consumed_approvals: 1,
        receipts: 1,
        completed_receipts: 1,
      });
    } finally {
      await official.close();
    }

    const cancelPlan = await postJson(server, 'tools/call', 6, {
      headers: { authorization: `Bearer ${auth.token}`, 'mcp-name': 'changes.plan' },
      body: modernBody('tools/call', 6, {
        name: 'changes.plan',
        arguments: {
          operations: [{
            type: 'set_visibility',
            collectionId: fixture.collectionId,
            baseRevision: afterCommit!.resource_revision,
            input: { visibility: 'private' },
          }],
          reason: 'cancel visibility change',
          dryRun: true,
        },
      }),
    });
    const cancelPlanPayload = await cancelPlan.json() as {
      result?: { plan?: { planId?: string }; requestState?: string };
    };
    const cancelPlanId = cancelPlanPayload.result?.plan?.planId;
    assert.ok(cancelPlanId);
    const cancel = await postJson(server, 'tools/call', 7, {
      headers: { authorization: `Bearer ${auth.token}`, 'mcp-name': 'changes.cancel' },
      body: modernBody('tools/call', 7, {
        name: 'changes.cancel',
        arguments: { planId: cancelPlanId },
      }),
    });
    const cancelPayload = await cancel.json() as {
      result?: { resultType?: string; structuredContent?: { status?: string } };
    };
    assert.equal(cancelPayload.result?.resultType, 'complete');
    assert.equal(cancelPayload.result?.structuredContent?.status, 'cancelled');

    const read = await postJson(server, 'resources/templates/list', 8, {});
    assert.equal(read.status, 200);
    const readPayload = await read.json() as { result?: { resourceTemplates?: unknown } };
    assert.ok(readPayload.result?.resourceTemplates !== undefined);

    const anonymousWrite = await postJson(server, 'tools/call', 9, {
      headers: { 'mcp-name': 'nodes.create' },
      body: modernBody('tools/call', 9, { name: 'nodes.create', arguments: {} }),
    });
    assert.equal((await anonymousWrite.json() as { error?: { code?: number } }).error?.code, -32602);

    const operations = createPostgresMcpWriteOperationsStore(runtime.db);
    const readiness = await operations.inspect({
      retryAfterMs: 60_000,
      unknownAfterMs: 300_000,
      permanentFailureAfterMs: 86_400_000,
    });
    assert.equal(readiness.counts.plans >= 2, true);
    await app?.close();
    app = undefined;
  });

  test('MCP canonical Node writes invoke the report source-invalidation seam', async () => {
    const invalidations: Array<{ readonly collectionId: string; readonly sourceEventType: string }> = [];
    await createFixture({
      reportSourceInvalidation: {
        async append(_transaction, input) {
          invalidations.push({
            collectionId: input.collectionId,
            sourceEventType: input.sourceEventType,
          });
        },
      },
    });
    assert.equal(invalidations.length, 1);
    assert.equal(invalidations[0]?.sourceEventType, 'node.created');
  });

  test('real MCP route enforces transport-header contract over HTTP', async () => {
    const fixture = await createFixture();
    const composition = createPhase4bMcpWriteComposition({
      db: runtime.db,
      serverUuid: SERVER_UUID,
      approvalBaseUri: 'https://approve.example/approvals',
      requestStateKey: 'known-mcp-w10-request-state-key-0123456789abcdef0123456789',
      requestStateClock: () => NOW.getTime(),
      allowedScopes: WRITE_SCOPES,
      metrics: { increment() {}, gauge() {}, observe() {} },
      rateLimit: createMcpChangePlanRateLimitPort({
        maxPlans: 100,
        windowMs: 60_000,
        now: () => NOW.getTime(),
      }),
    });
    const server = await startApi(composition.adapter, composition.paramDeclarations);
    try {
      const duplicate = await postDuplicateMcpMethod(server);
      const duplicatePayload = JSON.parse(duplicate.body) as { error?: { code?: number } };
      assert.equal(duplicatePayload.error?.code, -32020);

      const encodedName = `=?base64?${Buffer.from('sentinel', 'utf8').toString('base64')}?=`;
      const valid = await mcpHttpPost(
        `${server}${PHASE4B_MCP_CONFIG_ENDPOINT_PATH}`,
        withMcpTestHost({
          'content-type': 'application/json',
          'mcp-protocol-version': '2026-07-28',
          accept: 'application/json;q=1, text/event-stream;q=0.5',
          'mcp-method': 'resources/read',
          'mcp-name': encodedName,
        }),
        modernBody('resources/read', 11, { uri: 'sentinel' }),
      );
      const validPayload = await valid.json() as { error?: { code?: number } };
      assert.notEqual(validPayload.error?.code, -32020);
    } finally {
      await app?.close();
      app = undefined;
    }
  });

  async function startApi(
    writeAdapter: Mcp20260728WriteToolAdapter,
    writeToolParamDeclarations: readonly Mcp20260728XMcpHeaderDeclaration[],
  ) {
    const config = loadConfig(mcpEnv());
    const readSurface = emptyReadToolAdapterBundle();
    const instance = buildApiApp({
      config,
      mcpReadTransport: {
        changeSignalSource: createPhase4bMcpChangeSignalSource(),
        readToolAdapter: readSurface.adapter,
        readToolParamDeclarations: readSurface.paramDeclarations,
        oauthVerifier: auth.verifier,
        writeToolAdapter: writeAdapter,
        writeToolParamDeclarations,
      },
      mcpReadResourceProjection: emptyResourceProjection(),
      mcpNodeResourceProjection: emptyNodeResourceProjection(),
      mcpSnapshotResourceProjection: emptySnapshotResourceProjection(),
      mcpWriteOperations: createPostgresMcpWriteOperationsStore(runtime.db),
    });
    await instance.listen({ host: '127.0.0.1', port: 0 });
    app = instance;
    const address = instance.server.address();
    if (!address || typeof address === 'string') throw new Error('server is not listening');
    origin = `http://127.0.0.1:${address.port}`;
    return origin;
  }

  async function createFixture(options: {
    readonly reportSourceInvalidation?: {
      append(
        transaction: import('../../../src/infrastructure/database/index.js').DatabaseTransaction,
        input: {
          readonly collectionId: string;
          readonly sourceEventType: string;
          readonly sourceEventVersion: number;
          readonly domainEventId: string;
          readonly contentRevision: string;
          readonly policyRevision: string;
          readonly commitOrdinal: bigint;
        },
      ): Promise<void>;
    };
  } = {}) {
    const collectionId = randomBytes(16).toString('base64url');
    const rootId = randomBytes(16).toString('base64url');
    const created = await createPostgresCanonicalMutationUnitOfWork(runtime.db).execute((ports) =>
      createOwnedCollectionCanonical(ports, {
        actor: { principalId: PRINCIPAL_ID, principalType: 'account', subjectId: PRINCIPAL_ID },
        command: { commandId: randomUUID(), fingerprint: 'w10-fixture' },
        title: 'MCP W10 Collection',
        summary: null,
        kind: 'bookmarks',
        collectionId,
        rootNodeId: rootId,
        operationId: randomUUID(),
      } satisfies CreateOwnedCollectionInput));
    assert.equal(created.kind, 'created');
    const collection = (await runtime.pool.query<{ content_revision: string; policy_revision: string }>(
      `select content_revision, policy_revision from collections where id = $1`,
      [collectionId],
    )).rows[0];
    const root = (await runtime.pool.query<{ children_revision: string }>(
      `select children_revision from nodes where id = $1`,
      [rootId],
    )).rows[0];
    assert.ok(collection && root);
    const composition = createPhase4bMcpWriteComposition({
      db: runtime.db,
      serverUuid: SERVER_UUID,
      approvalBaseUri: 'https://approve.example/approvals',
      requestStateKey: 'known-mcp-w10-request-state-key-0123456789abcdef0123456789',
      allowedScopes: WRITE_SCOPES,
      metrics: { increment() {}, gauge() {}, observe() {} },
      ...(options.reportSourceInvalidation === undefined
        ? {} : { reportSourceInvalidation: options.reportSourceInvalidation }),
      rateLimit: createMcpChangePlanRateLimitPort({
        maxPlans: 100,
        windowMs: 60_000,
        now: () => NOW.getTime(),
      }),
    });
    const node = await composition.nodeCreateService.execute({
      input: {
        tool: 'nodes.create',
        collectionId,
        parentId: rootId,
        afterId: null,
        beforeId: null,
        node: {
          kind: 'bookmark',
          title: 'W10 fixture bookmark',
          url: 'https://example.test/fixture',
          description: null,
          tags: ['fixture'],
          visibility: 'private',
        },
        reason: 'fixture node',
        confirmApply: true,
      },
      idempotencyKey: randomUUID(),
      expectedBaseRevisions: {
        [`children.${rootId}`]: root.children_revision,
        [`content.${collectionId}`]: collection.content_revision,
        [`policy.${collectionId}`]: collection.policy_revision,
      },
    }, { binding: await binding(), accountSubjectId: PRINCIPAL_ID, scope: WRITE_SCOPES });
    if (node.resultType !== 'complete') {
      throw new Error('expected complete nodes.create output');
    }
    const nodeRow = (await runtime.pool.query<{ resource_revision: string }>(
      `select resource_revision from nodes where id = $1`,
      [node.node.id],
    )).rows[0];
    assert.ok(nodeRow);
    return {
      collectionId,
      rootId,
      nodeId: node.node.id,
      resourceRevision: nodeRow.resource_revision,
    };
  }

  async function authFixture(): Promise<{ verifier: McpOauthVerifier; token: string }> {
    const pair = await generateKeyPair('RS256', { extractable: true });
    const jwk = await exportJWK(pair.publicKey);
    Object.assign(jwk, { kid: 'w10-key', alg: 'RS256', use: 'sig' });
    const token = await new SignJWT({ scope: WRITE_SCOPES.join(' '), client_id: CLIENT_ID })
      .setProtectedHeader({ alg: 'RS256', kid: 'w10-key' })
      .setIssuer(ISSUER)
      .setSubject(PRINCIPAL_ID)
      .setAudience(AUDIENCE)
      .setIssuedAt(NOW_SECONDS - 5)
      .setExpirationTime(NOW_SECONDS + 3_600)
      .setJti('w10-token')
      .sign(pair.privateKey);
    const verifier = createMcpOauthVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      allowedScopes: WRITE_SCOPES,
      jwks: { async getKeySet() { return { keys: [jwk] } as JSONWebKeySet; } },
      isRevoked: async () => false,
      securityEpoch: async () => 'epoch-1',
      now: () => NOW,
      clockToleranceSeconds: 0,
      resolveAccountBySubject: async (sub) => ({
        id: `account:${sub}`,
        subjectId: sub,
        status: 'active',
      }),
    });
    return { verifier, token };
  }

  async function binding() {
    return (await auth.verifier.verify({ authorization: `Bearer ${auth.token}` })).binding;
  }

});

function mcpEnv(): Record<string, string> {
  return {
    DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PUBLICATION_ORIGIN: 'https://collections.example.test',
    PUBLICATION_SERVER_UUID: SERVER_UUID,
    KNOWN_FEATURE_MCP_READ: 'true',
    KNOWN_FEATURE_MCP_WRITE: 'true',
    MCP_SERVER_UUID: SERVER_UUID,
    MCP_ALLOWED_ORIGINS: 'https://app.example.test',
    MCP_OAUTH_ISSUER: ISSUER,
    MCP_OAUTH_AUDIENCE: AUDIENCE,
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL:
      'https://issuer.example.test/.well-known/oauth-authorization-server',
    MCP_OAUTH_JWKS_URI: 'https://issuer.example.test/realms/known/protocol/openid-connect/certs',
    // FIX-M-016 acceptance: loadConfig requires a coherent OIDC issuer/JWKS
    // triple whenever the test provider is disabled; the suite never fetches
    // this endpoint (the MCP verifier is injected), so an HTTPS test URI is
    // sufficient to boot the real API surface.
    OIDC_ISSUER: ISSUER,
    OIDC_JWKS_URI: 'https://issuer.example.test/realms/known/protocol/openid-connect/certs',
    MCP_OAUTH_SCOPES: WRITE_SCOPES.join(','),
    MCP_WRITE_REQUEST_STATE_KEY: Buffer.alloc(32, 77).toString('base64'),
  };
}

function modernBody(method: string, id: number, params: Record<string, unknown> = {}): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': { tools: { call: true } },
        'io.modelcontextprotocol/clientInfo': { name: 'known-w10-test', version: '1.0.0' },
      },
      ...params,
    },
  });
}

async function postJson(
  origin: string,
  method: string,
  id: number,
  init: RequestInit = {},
): Promise<Response> {
  return mcpHttpPost(
    `${origin}${PHASE4B_MCP_CONFIG_ENDPOINT_PATH}`,
    withMcpTestHost({
      'content-type': 'application/json',
      'mcp-method': method,
      'mcp-protocol-version': '2026-07-28',
      accept: 'application/json;q=1, text/event-stream;q=0.5',
      ...(init.headers as Record<string, string> | undefined),
    }),
    (init.body as string | Uint8Array | undefined) ?? modernBody(method, id),
  );
}

function emptyResourceProjection(): Phase4bMcpCollectionResourceProjection {
  return Object.freeze({
    async listResources() {
      return Object.freeze({ resources: Object.freeze([]) });
    },
    async readResource() {
      throw new McpResourceNotFoundError();
    },
    async cacheForList() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
}

function emptySnapshotResourceProjection(): Phase4bMcpSnapshotResourceProjection {
  return Object.freeze({
    async readResource() {
      throw new McpResourceNotFoundError();
    },
    async readPage() {
      throw new McpResourceNotFoundError();
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
}

function emptyNodeResourceProjection(): Phase4bMcpNodeResourceProjection {
  return Object.freeze({
    async readResource() {
      throw new McpResourceNotFoundError();
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
}
