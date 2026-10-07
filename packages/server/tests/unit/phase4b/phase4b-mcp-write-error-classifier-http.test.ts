/**
 * MCP-CQ-04: strict/compat tools/call write-error mapping on the HTTP wire.
 * Companion to phase4b-mcp-write-error-classifier.test.ts.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_MCP_RESOURCE_READ_BUDGET,
  MCP_WIRE_INTERNAL_ERROR_CODE,
  MCP_WIRE_INVALID_PARAMS_ERROR_CODE,
  createAuthenticatedBinding,
  type Mcp20260728WriteToolAdapter,
} from '@know-n/colp/mcp';
import { loadConfig } from '../../support/test-config.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import {
  PHASE4B_MCP_LOW_RISK_NODE_CREATE_ERROR_CODES,
  Phase4bMcpLowRiskNodeCreateError,
  classifyPhase4bMcpWriteError,
  createMcpOauthVerifier,
  createMcpApplicationContext,
  createPhase4bMcpReadOperations,
  createPhase4bMcpReadToolAdapter,
  createPhase4bMcpResourceIdentity,
  redactedPhase4bMcpWriteErrorLogFields,
  toPhase4bMcpWriteRejectedResult,
  toPhase4bMcpWriteRequestError,
  writeErrorHintFrom,
  type Phase4bMcpCollectionResourceProjection,
  type Phase4bMcpLowRiskNodeCreateErrorCode,
  type Phase4bMcpNodeResourceProjection,
  type Phase4bMcpSnapshotResourceProjection,
  type Phase4bMcpWriteErrorClassification,
} from '../../../src/modules/mcp/index.js';
import { COLLECTION_KINDS } from '../../../src/modules/collections/index.js';
import { createPhase4bMcpApplicationFacadeFromColpAdapters } from '../../../src/transport/mcp/mcp-strict-application-adapter.js';
import {
  AUDIENCE,
  SCOPES,
  WRITE_SCOPES,
  apps,
  createKeyFixture,
  mcpEnv,
  mintCredential,
  parseJsonRpc,
  postJson,
  startApi,
  staticJwksProvider,
  verifierOptions,
} from '../../support/phase4b-mcp-transport-scaffold.js';
import {
  createInMemoryWriteToolFixture,
} from '../../support/phase4b-mcp-write-tools-fixture.js';
import {
  COMPAT_REVISION,
  nodeCreateArguments,
  signedCompatWriteClient,
  startCompatWriteApp,
} from '../../support/phase4b-mcp-compat-write.js';
import {
  compatJsonRpc,
  injectCompatLegacyPost,
} from '../../support/phase4b-mcp-compat-admission.js';
import { mcpCompatToolsCallBody } from '../../support/phase4b-mcp-compat-spike.js';

const CANARY = 'CANARY-cq04-password=supersecret-Bearer-eyJhbGciOi';
const CALL_SCOPES = Object.freeze([...SCOPES, ...WRITE_SCOPES]);
const AUTHENTICATED = createAuthenticatedBinding({
  credentialKind: 'oauth',
  principalId: 'urn:known:subject:alice',
  clientId: 'known-mcp-oauth-client',
  credentialBindingId: 'credential-1',
  resourceAudience: AUDIENCE,
  securityEpoch: 'epoch-1',
});

const injectApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
  await Promise.all(injectApps.splice(0).map((app) => app.close().catch(() => undefined)));
});

interface MappedRow {
  readonly id: string;
  readonly error: Error;
  readonly classified: Phase4bMcpWriteErrorClassification;
}

function mappedNodeCreateRows(): readonly MappedRow[] {
  const rows: MappedRow[] = PHASE4B_MCP_LOW_RISK_NODE_CREATE_ERROR_CODES.map((code) => {
    const error = new Phase4bMcpLowRiskNodeCreateError(code, `${code} ${CANARY}`);
    return Object.freeze({
      id: code,
      error,
      classified: classifyPhase4bMcpWriteError(error),
    });
  });
  return Object.freeze(rows);
}

function expectedWriteErrorData(stableClass: string): Readonly<Record<string, unknown>> {
  if (stableClass === 'parent_invalid') {
    return Object.freeze({
      code: stableClass,
      field: 'parentId',
      allowedKinds: Object.freeze(['folder', 'bookmark']),
      allowedVisibilities: Object.freeze(['inherit', 'protected', 'private']),
      nextTool: 'nodes.create',
    });
  }
  if (stableClass === 'invalid_params') {
    return Object.freeze({
      code: stableClass,
      allowedKinds: Object.freeze(['folder', 'bookmark']),
      allowedVisibilities: Object.freeze(['inherit', 'protected', 'private']),
      nextTool: 'nodes.create',
    });
  }
  return Object.freeze({ code: stableClass });
}

test('strict tools/call maps every low-risk node-create code off -32603 for business rejects', async () => {
  let pending: Error | undefined;
  const fixture = createInMemoryWriteToolFixture({
    nodeCreateThrow: () => pending,
  });
  const metrics = new InMemoryMetrics();
  const operations = createPhase4bMcpReadOperations({
    metrics,
    maxConcurrentRequests: 4,
    maxQueuedRequests: 1,
    maxListeners: 1,
  });
  const auth = await writeAuth();
  const server = await startApi(mcpEnv({ MCP_OAUTH_SCOPES: CALL_SCOPES.join(',') }), {
    operations,
    oauthVerifier: auth.verifier,
    writeToolAdapter: fixture.bundle.adapter,
    writeToolParamDeclarations: fixture.bundle.paramDeclarations,
  });
  let rpcId = 100;
  for (const row of mappedNodeCreateRows()) {
    pending = row.error;
    const internalBefore = metrics.get('mcp.read.requests.error.internal');
    const response = await callStrictCreate(server, auth.token, rpcId);
    rpcId += 1;
    const payload = parseJsonRpc(await response.text());
    const body = JSON.stringify(payload);
    assert.equal(body.includes(CANARY), false, row.id);
    const log = redactedPhase4bMcpWriteErrorLogFields(row.classified, 'corr-strict');
    if (row.classified.outcome === 'rejected') {
      assert.equal(response.status, 200, row.id);
      assert.equal(payload.error?.code, row.classified.jsonRpcCode, row.id);
      assert.equal(payload.error?.message, row.classified.safeMessage, row.id);
      assert.deepEqual(payload.error?.data, expectedWriteErrorData(row.classified.stableClass), row.id);
      assert.notEqual(payload.error?.code, MCP_WIRE_INTERNAL_ERROR_CODE, row.id);
      assert.equal(metrics.get('mcp.read.requests.error.internal'), internalBefore, row.id);
      assert.equal(log.errorClass, (payload.error?.data as { code?: string }).code, row.id);
      continue;
    }
    assert.equal(payload.error?.code, MCP_WIRE_INTERNAL_ERROR_CODE, row.id);
    assert.equal(payload.error?.message, 'Internal error', row.id);
    assert.equal(metrics.get('mcp.read.requests.error.internal'), internalBefore + 1, row.id);
    assert.equal(log.errorClass, 'internal_error', row.id);
  }
});

test('compat tools/call maps every low-risk node-create code without JSON-RPC -32603 on business rejects', async () => {
  let pending: Error | undefined;
  const fixture = createInMemoryWriteToolFixture({
    nodeCreateThrow: () => pending,
  });
  const auth = await signedCompatWriteClient();
  const server = startCompatWriteApp({ writeFixture: fixture, verifier: auth.verifier });
  injectApps.push(server.app);
  let rpcId = 200;
  for (const row of mappedNodeCreateRows()) {
    pending = row.error;
    const called = await injectCompatLegacyPost(
      server.app,
      mcpCompatToolsCallBody('nodes.create', rpcId, nodeCreateArguments()),
      COMPAT_REVISION,
      { authorization: `Bearer ${auth.token}` },
    );
    rpcId += 1;
    assert.equal(called.statusCode, 200, row.id);
    assert.equal(called.payload.includes(CANARY), false, row.id);
    const rpc = compatJsonRpc(called);
    const metricDump = JSON.stringify(server.metricNames);
    assert.equal(metricDump.includes(CANARY), false, row.id);
    if (row.classified.outcome === 'rejected') {
      assert.equal(rpc.error, undefined, row.id);
      assert.equal(rpc.result?.isError, true, row.id);
      assert.match(JSON.stringify(rpc.result?.content ?? []), new RegExp(row.classified.safeMessage, 'u'), row.id);
      continue;
    }
    assert.equal(rpc.result?.isError, true, row.id);
    assert.match(JSON.stringify(rpc.result?.content ?? []), /Internal error/u, row.id);
  }
});

test('inherit nodes.create on the wire applies without Plan approval', async () => {
  const strictFixture = createInMemoryWriteToolFixture();
  const auth = await writeAuth();
  const server = await startApi(mcpEnv({ MCP_OAUTH_SCOPES: CALL_SCOPES.join(',') }), {
    oauthVerifier: auth.verifier,
    writeToolAdapter: strictFixture.bundle.adapter,
    writeToolParamDeclarations: strictFixture.bundle.paramDeclarations,
  });
  const inheritArgs = {
    ...nodeCreateArguments(),
    node: {
      ...nodeCreateArguments().node,
      visibility: 'inherit',
    },
  };
  const strict = await postJson(server, 'tools/call', 1, {
    headers: {
      authorization: `Bearer ${auth.token}`,
      'mcp-name': 'nodes.create',
      'mcp-param-X-Collection-Id': 'collection-1',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': { tools: { call: true } },
        },
        name: 'nodes.create',
        arguments: inheritArgs,
      },
    }),
  });
  const strictPayload = parseJsonRpc(await strict.text());
  assert.equal(strict.status, 200);
  assert.equal(strictPayload.error, undefined);
  assert.equal(
    (strictPayload.result?.structuredContent as { appliedVisibility?: string }).appliedVisibility,
    'private',
  );

  const compatFixture = createInMemoryWriteToolFixture();
  const compatAuth = await signedCompatWriteClient();
  const compat = startCompatWriteApp({ writeFixture: compatFixture, verifier: compatAuth.verifier });
  injectApps.push(compat.app);
  const called = await injectCompatLegacyPost(
    compat.app,
    mcpCompatToolsCallBody('nodes.create', 2, inheritArgs),
    COMPAT_REVISION,
    { authorization: `Bearer ${compatAuth.token}` },
  );
  const rpc = compatJsonRpc(called);
  assert.equal(called.statusCode, 200);
  assert.equal(rpc.error, undefined);
  assert.notEqual(rpc.result?.isError, true);
});

test('strict tools/call includes field on hinted nodes.create invalid_params', async () => {
  const hinted = new Phase4bMcpLowRiskNodeCreateError(
    'invalid_catalog_input',
    `missing url ${CANARY}`,
    { field: 'node.url', nextTool: 'nodes.create' },
  );
  const fixture = createInMemoryWriteToolFixture({ nodeCreateThrow: () => hinted });
  const auth = await writeAuth();
  const server = await startApi(mcpEnv({ MCP_OAUTH_SCOPES: CALL_SCOPES.join(',') }), {
    oauthVerifier: auth.verifier,
    writeToolAdapter: fixture.bundle.adapter,
    writeToolParamDeclarations: fixture.bundle.paramDeclarations,
  });
  const response = await callStrictCreate(server, auth.token, 13);
  const payload = parseJsonRpc(await response.text());
  assert.equal(response.status, 200);
  assert.equal(payload.error?.code, MCP_WIRE_INVALID_PARAMS_ERROR_CODE);
  assert.deepEqual(payload.error?.data, {
    code: 'invalid_params',
    field: 'node.url',
    allowedKinds: Object.freeze(['folder', 'bookmark']),
    allowedVisibilities: Object.freeze(['inherit', 'protected', 'private']),
    nextTool: 'nodes.create',
  });
  assert.equal(JSON.stringify(payload).includes(CANARY), false);
});

test('parameter errors are not dependency errors; only unknown faults return internal error', async () => {
  const catalog = new Phase4bMcpLowRiskNodeCreateError('invalid_catalog_input', `missing url ${CANARY}`);
  const unknown = new Error(`relation "nodes" ${CANARY}`);
  const metrics = new InMemoryMetrics();
  const operations = createPhase4bMcpReadOperations({
    metrics,
    maxConcurrentRequests: 4,
    maxQueuedRequests: 1,
    maxListeners: 1,
  });
  let pending: Error = catalog;
  const fixture = createInMemoryWriteToolFixture({ nodeCreateThrow: () => pending });
  const auth = await writeAuth();
  const server = await startApi(mcpEnv({ MCP_OAUTH_SCOPES: CALL_SCOPES.join(',') }), {
    operations,
    oauthVerifier: auth.verifier,
    writeToolAdapter: fixture.bundle.adapter,
    writeToolParamDeclarations: fixture.bundle.paramDeclarations,
  });
  const invalid = await callStrictCreate(server, auth.token, 11);
  const invalidPayload = parseJsonRpc(await invalid.text());
  assert.equal(invalidPayload.error?.code, MCP_WIRE_INVALID_PARAMS_ERROR_CODE);
  assert.equal(metrics.get('mcp.read.requests.error.internal'), 0);
  pending = unknown;
  const fault = await callStrictCreate(server, auth.token, 12);
  const faultPayload = parseJsonRpc(await fault.text());
  assert.equal(faultPayload.error?.code, MCP_WIRE_INTERNAL_ERROR_CODE);
  assert.equal(faultPayload.error?.message, 'Internal error');
  assert.equal(JSON.stringify(faultPayload).includes(CANARY), false);
  assert.equal(metrics.get('mcp.read.requests.error.internal'), 1);
});

async function callStrictCreate(
  server: Awaited<ReturnType<typeof startApi>>,
  token: string,
  id: number,
): Promise<Response> {
  return postJson(server, 'tools/call', id, {
    headers: {
      authorization: `Bearer ${token}`,
      'mcp-name': 'nodes.create',
      'mcp-param-X-Collection-Id': 'collection-1',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': { tools: { call: true } },
        },
        name: 'nodes.create',
        arguments: nodeCreateArguments(),
      },
    }),
  });
}

async function writeAuth(): Promise<{
  readonly verifier: ReturnType<typeof createMcpOauthVerifier>;
  readonly token: string;
}> {
  const key = await createKeyFixture('cq04-write');
  const token = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    scope: CALL_SCOPES,
    jti: 'cq04-write-jti',
  });
  const verifier = createMcpOauthVerifier(verifierOptions({
    allowedScopes: [...CALL_SCOPES],
    jwks: staticJwksProvider([key.jwk]),
  }));
  return { verifier, token };
}

