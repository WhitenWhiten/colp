import assert from 'node:assert/strict';
import { connect as rawConnect } from 'node:net';
import { afterEach, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  McpServer,
  SUPPORTED_PROTOCOL_VERSIONS,
  legacyStatelessFallback,
  type AuthInfo,
  type LegacyHttpHandler,
  type McpServerFactory,
} from '@modelcontextprotocol/server';
import {
  MCP_COMPAT_AUTH_TOKEN_SENTINEL,
  MCP_COMPAT_ENDPOINT_PATH,
  MCP_COMPAT_PROTOCOL_VERSIONS,
  MCP_COMPAT_PROTOCOL_VERSION_REJECT_MESSAGE,
} from '../../../src/modules/mcp/index.js';
import {
  McpCompatProtocolVersionAdmissionError,
  admitMcpCompatProtocolVersion,
} from '../../../src/transport/mcp/mcp-compat-admission.js';
import {
  assertCompatProtocolVersionRejected,
  createCompatPingCapture,
  injectCompatLegacyPost,
  injectCompatPost,
  pingMcpApplicationFacade,
  startCompatApp,
} from '../../support/phase4b-mcp-compat-admission.js';
import { MCP_TEST_REQUEST_HOST } from '../../support/phase4b-mcp-transport-scaffold.js';
import { CODEX_CLIENT } from '../../support/phase4b-mcp-compat-matrix-harness.js';
import {
  MCP_COMPAT_CANARY_BEARER,
  asMcpCompatJsonRpc,
  mcpCompatAcceptHeaders,
  mcpCompatInitializeBody,
  mcpCompatInitializedBody,
  mcpCompatResourcesListBody,
  mcpCompatResourcesReadBody,
  mcpCompatToolsCallBody,
  mcpCompatToolsListBody,
  parseMcpCompatHttpPayload,
  postCompatLegacyFetch,
  readConstructedSupportedProtocolVersions,
} from '../../support/phase4b-mcp-compat-spike.js';

const COMPAT_REVISION = '2025-11-25';
const REJECTED_OPERATIONAL_VERSIONS = [
  '2025-06-18',
  '2026-07-28',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
  '1999-01-01',
] as const;
const ILLEGAL_OPERATIONAL_HEADERS = [
  '',
  '2025-11-25,2025-11-25',
  '2025-11-25,2025-06-18',
  ...REJECTED_OPERATIONAL_VERSIONS,
] as const;
const OPERATIONAL_BODIES = [
  ['tools/list', mcpCompatToolsListBody(10)],
  ['tools/call', mcpCompatToolsCallBody('compat.ping', 11)],
  ['resources/list', mcpCompatResourcesListBody(12)],
  ['resources/read', mcpCompatResourcesReadBody('compat://ping', 13)],
  ['notifications/initialized', mcpCompatInitializedBody()],
] as const;

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
});

function startPingApp() {
  const capture = createCompatPingCapture();
  const server = startCompatApp({
    mcpReadTransport: { applicationFacade: pingMcpApplicationFacade(capture) },
  });
  apps.push(server.app);
  return { server, capture };
}

function resetAdmissionSpies(
  server: ReturnType<typeof startCompatApp>,
  capture: ReturnType<typeof createCompatPingCapture>,
): void {
  server.admissions.splice(0);
  server.sdkFactoryCalls.count = 0;
  server.sdkFactoryObservations.splice(0);
  server.postVerifierAuthorization.splice(0);
  capture.listCalls = 0;
  capture.callCalls = 0;
  capture.resourceLists = 0;
  capture.resourceReads = 0;
}

function createCountingFactory(
  supportedProtocolVersions: readonly string[],
  counters: { toolCalls: number; resourceReads: number },
  constructed: McpServer[],
): McpServerFactory {
  return (ctx) => {
    const server = new McpServer(
      { name: 'known-mcp-compat-spike', version: '0.0.0-t00' },
      {
        capabilities: { tools: {}, resources: {} },
        supportedProtocolVersions: [...supportedProtocolVersions],
      },
    );
    constructed.push(server);
    server.registerTool(
      'spike.ping',
      { description: 'T-00 spike tool; must not run on rejected revisions' },
      async () => {
        counters.toolCalls += 1;
        return { content: [{ type: 'text', text: 'pong' }] };
      },
    );
    server.registerResource(
      'spike-item',
      'spike://item',
      { description: 'T-00 spike resource; must not run on rejected revisions' },
      async (uri) => {
        counters.resourceReads += 1;
        return { contents: [{ uri: String(uri), text: 'spike-body', mimeType: 'text/plain' }] };
      },
    );
    void ctx;
    return server;
  };
}

test('MCP_COMPAT_PROTOCOL_VERSIONS is the frozen singleton 2025-11-25 and is not the SDK default set', () => {
  assert.deepEqual(MCP_COMPAT_PROTOCOL_VERSIONS, [COMPAT_REVISION]);
  assert.equal(Object.isFrozen(MCP_COMPAT_PROTOCOL_VERSIONS), true);
  assert.equal(MCP_COMPAT_PROTOCOL_VERSIONS.length, 1);
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes('2025-06-18'));
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes('2025-03-26'));
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes('2024-11-05'));
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes('2024-10-07'));
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(COMPAT_REVISION));
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.length > 1);
  for (const extra of ['2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']) {
    assert.equal(
      (MCP_COMPAT_PROTOCOL_VERSIONS as readonly string[]).includes(extra),
      false,
      `compat allowlist must not include ${extra}`,
    );
  }
  assert.equal(MCP_COMPAT_AUTH_TOKEN_SENTINEL, 'verified-upstream');
  assert.notEqual(MCP_COMPAT_AUTH_TOKEN_SENTINEL, MCP_COMPAT_CANARY_BEARER);
});

test('legacyStatelessFallback with explicit singleton versions constructs a server that only supports 2025-11-25', async () => {
  const counters = { toolCalls: 0, resourceReads: 0 };
  const constructed: McpServer[] = [];
  const fetch = legacyStatelessFallback(
    createCountingFactory(MCP_COMPAT_PROTOCOL_VERSIONS, counters, constructed),
  );
  const response = await postCompatLegacyFetch(fetch, mcpCompatInitializeBody(COMPAT_REVISION, {
    name: 'claude-code',
    version: '2.1.250',
  }));
  assert.equal(response.status, 200);
  const rpc = asMcpCompatJsonRpc(response.payload);
  assert.equal(rpc.result?.protocolVersion, COMPAT_REVISION);
  assert.ok(constructed.length >= 1);
  for (const server of constructed) {
    assert.deepEqual(readConstructedSupportedProtocolVersions(server), [COMPAT_REVISION]);
  }
  assert.equal(counters.toolCalls, 0);
});

test('initialize offer 2025-11-25 negotiates 2025-11-25 and subsequent initialized/tools use that revision', async () => {
  const counters = { toolCalls: 0, resourceReads: 0 };
  const fetch = legacyStatelessFallback(
    createCountingFactory(MCP_COMPAT_PROTOCOL_VERSIONS, counters, []),
  );
  const initialize = await postCompatLegacyFetch(fetch, mcpCompatInitializeBody(COMPAT_REVISION, {
    name: 'claude-code',
    version: '2.1.250',
  }));
  const initRpc = asMcpCompatJsonRpc(initialize.payload);
  assert.equal(initRpc.result?.protocolVersion, COMPAT_REVISION);
  assert.equal(
    initialize.headers.get('mcp-protocol-version'),
    null,
    'SDK @2.0.0 omits the response MCP-Protocol-Version on initialize; T-04 host still sets 2025-11-25',
  );

  const initialized = await postCompatLegacyFetch(
    fetch,
    mcpCompatInitializedBody(),
    mcpCompatAcceptHeaders(COMPAT_REVISION),
  );
  assert.ok(initialized.status === 202 || initialized.status === 200);

  const listed = await postCompatLegacyFetch(
    fetch,
    mcpCompatToolsListBody(2),
    mcpCompatAcceptHeaders(COMPAT_REVISION),
  );
  assert.equal(listed.status, 200);
  const listRpc = asMcpCompatJsonRpc(listed.payload);
  assert.equal(listRpc.error, undefined);
  const tools = listRpc.result?.tools as readonly { readonly name: string }[] | undefined;
  assert.ok(Array.isArray(tools));
  assert.ok(tools.some((tool) => tool.name === 'spike.ping'));
  assert.equal(
    listed.headers.get('mcp-protocol-version'),
    null,
    'SDK @2.0.0 omits the response MCP-Protocol-Version on tools/list; T-04 host still sets 2025-11-25',
  );

  const called = await postCompatLegacyFetch(
    fetch,
    mcpCompatToolsCallBody('spike.ping', 3),
    mcpCompatAcceptHeaders(COMPAT_REVISION),
  );
  assert.equal(called.status, 200);
  assert.equal(asMcpCompatJsonRpc(called.payload).error, undefined);
  assert.equal(counters.toolCalls, 1);
});

test('Codex-shaped initialize offer 2025-06-18 is selected as 2025-11-25; discovery/supported stay singleton', async () => {
  const counters = { toolCalls: 0, resourceReads: 0 };
  const constructed: McpServer[] = [];
  const fetch = legacyStatelessFallback(
    createCountingFactory(MCP_COMPAT_PROTOCOL_VERSIONS, counters, constructed),
  );
  const initialize = await postCompatLegacyFetch(fetch, mcpCompatInitializeBody('2025-06-18', CODEX_CLIENT));
  assert.equal(initialize.status, 200);
  const initRpc = asMcpCompatJsonRpc(initialize.payload);
  assert.equal(initRpc.result?.protocolVersion, COMPAT_REVISION);
  assert.notEqual(initRpc.result?.protocolVersion, '2025-06-18');
  assert.equal(
    initialize.headers.get('mcp-protocol-version'),
    null,
    'SDK @2.0.0 omits the response MCP-Protocol-Version on Codex initialize; T-04 host still sets 2025-11-25',
  );
  const serialized = JSON.stringify(initRpc);
  assert.doesNotMatch(serialized, /"protocolVersion"\s*:\s*"2025-06-18"/u);
  for (const server of constructed) {
    assert.deepEqual(readConstructedSupportedProtocolVersions(server), [COMPAT_REVISION]);
  }

  const initialized = await postCompatLegacyFetch(
    fetch,
    mcpCompatInitializedBody(),
    mcpCompatAcceptHeaders(COMPAT_REVISION),
  );
  assert.ok(initialized.status === 202 || initialized.status === 200);

  const listed = await postCompatLegacyFetch(
    fetch,
    mcpCompatToolsListBody(2),
    mcpCompatAcceptHeaders(COMPAT_REVISION),
  );
  assert.equal(listed.status, 200);
  assert.equal(asMcpCompatJsonRpc(listed.payload).error, undefined);
  assert.equal(
    listed.headers.get('mcp-protocol-version'),
    null,
    'SDK @2.0.0 omits the response MCP-Protocol-Version on Codex tools/list; T-04 host still sets 2025-11-25',
  );
  assert.equal(counters.toolCalls, 0);
});

test('SDK default full version set would accept a 2025-06-18 offer; explicit singleton must not', async () => {
  const defaultFetch = legacyStatelessFallback(createCountingFactory(SUPPORTED_PROTOCOL_VERSIONS, {
    toolCalls: 0,
    resourceReads: 0,
  }, []));
  const defaultInit = await postCompatLegacyFetch(
    defaultFetch,
    mcpCompatInitializeBody('2025-06-18', CODEX_CLIENT),
  );
  assert.equal(asMcpCompatJsonRpc(defaultInit.payload).result?.protocolVersion, '2025-06-18');

  const singletonFetch = legacyStatelessFallback(createCountingFactory(MCP_COMPAT_PROTOCOL_VERSIONS, {
    toolCalls: 0,
    resourceReads: 0,
  }, []));
  const singletonInit = await postCompatLegacyFetch(
    singletonFetch,
    mcpCompatInitializeBody('2025-06-18', CODEX_CLIENT),
  );
  assert.equal(asMcpCompatJsonRpc(singletonInit.payload).result?.protocolVersion, COMPAT_REVISION);
});

test('operational MCP-Protocol-Version for 06-18, three earlier revisions, and unknown must not execute tools or resources', async () => {
  for (const version of REJECTED_OPERATIONAL_VERSIONS) {
    const counters = { toolCalls: 0, resourceReads: 0 };
    const fetch = legacyStatelessFallback(
      createCountingFactory(MCP_COMPAT_PROTOCOL_VERSIONS, counters, []),
    );
    const headers = mcpCompatAcceptHeaders(version);
    const listed = await postCompatLegacyFetch(fetch, mcpCompatToolsListBody(10), headers);
    assert.notEqual(listed.status, 200, `tools/list must not succeed for ${version}`);
    assert.ok(listed.status >= 400, `tools/list must be rejected for ${version}`);
    assert.equal(counters.toolCalls, 0, `tools must not execute for ${version}`);

    const called = await postCompatLegacyFetch(fetch, mcpCompatToolsCallBody('spike.ping', 11), headers);
    assert.ok(called.status >= 400, `tools/call must be rejected for ${version}`);
    assert.equal(counters.toolCalls, 0, `tools/call must not execute for ${version}`);

    const read = await postCompatLegacyFetch(fetch, mcpCompatResourcesReadBody('spike://item', 12), headers);
    assert.ok(read.status >= 400, `resources/read must be rejected for ${version}`);
    assert.equal(counters.resourceReads, 0, `resources must not execute for ${version}`);
  }
});

test('SDK legacyStatelessFallback GET is JSON-RPC 405; host Claude sequence must not use that body', async () => {
  const fetch: LegacyHttpHandler = legacyStatelessFallback(
    createCountingFactory(MCP_COMPAT_PROTOCOL_VERSIONS, { toolCalls: 0, resourceReads: 0 }, []),
  );
  const response = await fetch(new Request('http://spike.test/mcp-compat-spike', {
    method: 'GET',
    headers: mcpCompatAcceptHeaders(COMPAT_REVISION),
  }));
  assert.equal(response.status, 405);
  const contentType = response.headers.get('content-type') ?? '';
  assert.match(contentType, /application\/json/u);
  const payload = parseMcpCompatHttpPayload(contentType, await response.text());
  const rpc = asMcpCompatJsonRpc(payload);
  assert.equal(typeof rpc.error?.message, 'string');
  assert.match(rpc.error?.message ?? '', /Method not allowed/u);
});

test('sentinel AuthInfo never carries the canary bearer into the SDK factory', async () => {
  const seen: Array<AuthInfo | undefined> = [];
  const fetch = legacyStatelessFallback((ctx) => {
    seen.push(ctx.authInfo);
    return createCountingFactory(MCP_COMPAT_PROTOCOL_VERSIONS, {
      toolCalls: 0,
      resourceReads: 0,
    }, [])(ctx);
  });
  const authInfo: AuthInfo = {
    token: MCP_COMPAT_AUTH_TOKEN_SENTINEL,
    clientId: 'spike-client',
    scopes: ['mcp:read:public'],
    extra: { knownBinding: { kind: 'verified-upstream' } },
  };
  const response = await postCompatLegacyFetch(
    fetch,
    mcpCompatInitializeBody(COMPAT_REVISION, { name: 'claude-code', version: '2.1.250' }),
    { ...mcpCompatAcceptHeaders(), authorization: `Bearer ${MCP_COMPAT_CANARY_BEARER}` },
    authInfo,
  );
  assert.equal(response.status, 200);
  assert.ok(seen[0]);
  assert.equal(seen[0]?.token, MCP_COMPAT_AUTH_TOKEN_SENTINEL);
  assert.doesNotMatch(JSON.stringify(seen), new RegExp(MCP_COMPAT_CANARY_BEARER, 'u'));
  assert.doesNotMatch(response.text, new RegExp(MCP_COMPAT_CANARY_BEARER, 'u'));
});

test('admitMcpCompatProtocolVersion uses raw pairs: omit initialize, require exact 11-25 otherwise', () => {
  const initialize = mcpCompatInitializeBody(COMPAT_REVISION, { name: 'claude-code', version: '2.1.250' });
  admitMcpCompatProtocolVersion([], initialize);
  admitMcpCompatProtocolVersion(
    [['MCP-Protocol-Version', COMPAT_REVISION]],
    initialize,
  );
  assert.throws(
    () => admitMcpCompatProtocolVersion([['MCP-Protocol-Version', '2025-06-18']], initialize),
    McpCompatProtocolVersionAdmissionError,
  );
  for (const [, body] of OPERATIONAL_BODIES) {
    admitMcpCompatProtocolVersion([['mcp-protocol-version', COMPAT_REVISION]], body);
    assert.throws(
      () => admitMcpCompatProtocolVersion([], body),
      McpCompatProtocolVersionAdmissionError,
    );
    assert.throws(
      () => admitMcpCompatProtocolVersion(
        [['MCP-Protocol-Version', COMPAT_REVISION], ['MCP-Protocol-Version', COMPAT_REVISION]],
        body,
      ),
      McpCompatProtocolVersionAdmissionError,
    );
    assert.throws(
      () => admitMcpCompatProtocolVersion([['MCP-Protocol-Version', '2025-11-25,2025-11-25']], body),
      McpCompatProtocolVersionAdmissionError,
    );
    assert.throws(
      () => admitMcpCompatProtocolVersion([['MCP-Protocol-Version', '']], body),
      McpCompatProtocolVersionAdmissionError,
    );
    assert.throws(
      () => admitMcpCompatProtocolVersion([['MCP-Protocol-Version', ` ${COMPAT_REVISION}`]], body),
      McpCompatProtocolVersionAdmissionError,
    );
  }
});

test('production path: missing and illegal operational MCP-Protocol-Version never reach SDK or facade', async () => {
  const { server, capture } = startPingApp();
  let verifyCalls = 0;
  const withOauth = startCompatApp({
    mcpReadTransport: {
      applicationFacade: pingMcpApplicationFacade(capture),
      oauthVerifier: {
        async verify() {
          verifyCalls += 1;
          throw new Error('oauth must not run after version reject');
        },
      },
    },
  });
  apps.push(withOauth.app);

  for (const [method, body] of OPERATIONAL_BODIES) {
    resetAdmissionSpies(server, capture);
    const missing = await injectCompatLegacyPost(server.app, body);
    assertCompatProtocolVersionRejected(missing, server, capture);
    assert.equal(missing.statusCode, 400, `${method} missing header`);

    for (const header of ILLEGAL_OPERATIONAL_HEADERS) {
      resetAdmissionSpies(server, capture);
      const rejected = await injectCompatPost(server.app, body, {
        'mcp-protocol-version': header,
      });
      assertCompatProtocolVersionRejected(rejected, server, capture);
      if (header.length > 0 && header !== COMPAT_REVISION) {
        assert.doesNotMatch(
          rejected.payload,
          new RegExp(header.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
        );
      }
    }
  }

  resetAdmissionSpies(withOauth, capture);
  verifyCalls = 0;
  const bearerMissing = await injectCompatLegacyPost(
    withOauth.app,
    mcpCompatToolsListBody(40),
    undefined,
    { authorization: `Bearer ${MCP_COMPAT_CANARY_BEARER}` },
  );
  assertCompatProtocolVersionRejected(bearerMissing, withOauth, capture);
  assert.equal(verifyCalls, 0);
  assert.doesNotMatch(bearerMissing.payload, new RegExp(MCP_COMPAT_CANARY_BEARER, 'u'));
});

test('production path: exact 2025-11-25 succeeds on operational requests and creates the SDK server', async () => {
  const { server, capture } = startPingApp();
  const listed = await injectCompatLegacyPost(server.app, mcpCompatToolsListBody(2), COMPAT_REVISION);
  assert.equal(listed.statusCode, 200);
  assert.ok(server.sdkFactoryCalls.count >= 1);
  assert.ok(server.admissions.length >= 1);
  assert.ok(capture.listCalls >= 1);

  const called = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsCallBody('compat.ping', 3),
    COMPAT_REVISION,
  );
  assert.equal(called.statusCode, 200);
  assert.equal(capture.callCalls, 1);

  const resources = await injectCompatLegacyPost(
    server.app,
    mcpCompatResourcesListBody(4),
    COMPAT_REVISION,
  );
  assert.equal(resources.statusCode, 200);
  assert.ok(capture.resourceLists >= 1);

  const read = await injectCompatLegacyPost(
    server.app,
    mcpCompatResourcesReadBody('compat://ping', 5),
    COMPAT_REVISION,
  );
  assert.equal(read.statusCode, 200);
  assert.ok(capture.resourceReads >= 1);

  const initialized = await injectCompatLegacyPost(
    server.app,
    mcpCompatInitializedBody(),
    COMPAT_REVISION,
  );
  assert.ok(initialized.statusCode === 202 || initialized.statusCode === 200);
});

test('initialize may omit MCP-Protocol-Version and still returns 2025-11-25; wrong initialize header is 400', async () => {
  const { server, capture } = startPingApp();
  const omitted = await injectCompatLegacyPost(
    server.app,
    mcpCompatInitializeBody(COMPAT_REVISION, { name: 'claude-code', version: '2.1.250' }),
  );
  assert.equal(omitted.statusCode, 200);
  assert.equal(omitted.headers['mcp-protocol-version'], COMPAT_REVISION);
  assert.ok(server.sdkFactoryCalls.count >= 1);

  resetAdmissionSpies(server, capture);
  const exact = await injectCompatLegacyPost(
    server.app,
    mcpCompatInitializeBody(COMPAT_REVISION, { name: 'probe', version: '0' }),
    COMPAT_REVISION,
  );
  assert.equal(exact.statusCode, 200);
  assert.equal(exact.headers['mcp-protocol-version'], COMPAT_REVISION);

  resetAdmissionSpies(server, capture);
  const wrong = await injectCompatLegacyPost(
    server.app,
    mcpCompatInitializeBody(COMPAT_REVISION, { name: 'probe', version: '0' }),
    '2025-06-18',
  );
  assertCompatProtocolVersionRejected(wrong, server, capture);
  assert.equal(wrong.payload.includes(MCP_COMPAT_PROTOCOL_VERSION_REJECT_MESSAGE), true);

  resetAdmissionSpies(server, capture);
  const modernHeader = await injectCompatLegacyPost(
    server.app,
    mcpCompatInitializeBody(COMPAT_REVISION, { name: 'probe', version: '0' }),
    '2026-07-28',
  );
  assertCompatProtocolVersionRejected(modernHeader, server, capture);
});

test('raw duplicate MCP-Protocol-Version headers are rejected before SDK factory and facade', async () => {
  const { server, capture } = startPingApp();
  await server.app.ready();
  const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
  const url = new URL(
    typeof address === 'string' ? address : `http://127.0.0.1:${(server.app.server.address() as { port: number }).port}`,
  );
  const body = JSON.stringify(mcpCompatToolsListBody(70));
  const raw = await new Promise<string>((resolve, reject) => {
    const socket = rawConnect({ host: url.hostname, port: Number(url.port) }, () => {
      socket.end([
        `POST ${MCP_COMPAT_ENDPOINT_PATH} HTTP/1.1`,
        `Host: ${MCP_TEST_REQUEST_HOST}`,
        'Content-Type: application/json',
        'Accept: application/json, text/event-stream',
        `MCP-Protocol-Version: ${COMPAT_REVISION}`,
        `MCP-Protocol-Version: ${COMPAT_REVISION}`,
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        body,
      ].join('\r\n'));
    });
    let data = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', (chunk: string) => {
      data += chunk;
    });
    socket.once('end', () => resolve(data));
  });
  assert.match(raw, /^HTTP\/1\.1 400 /u);
  assert.match(raw, /Unsupported protocol version/u);
  assert.match(raw, /"jsonrpc"\s*:\s*"2.0"/u);
  assert.equal(server.admissions.length, 0);
  assert.equal(server.sdkFactoryCalls.count, 0);
  assert.equal(capture.listCalls, 0);
  assert.doesNotMatch(raw, /Bearer |canary/iu);
});
