import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { createMcpOauthVerifier } from '../../../src/modules/mcp/index.js';
import { createMcpHttpSdkTransport } from '../../support/mcp-http-sdk-client.js';
import {
  createWriteFixture, signedCompatWriteClient, startCompatWriteApp, nodeCreateArguments, COMPAT_WRITE_SCOPES,
} from '../../support/phase4b-mcp-compat-write.js';
import { AUDIENCE, staticJwksProvider, verifierOptions } from '../../support/phase4b-mcp-transport-scaffold.js';

test('the official client caches its HTTP catalog but revocation still prevents writes', async () => {
  const fixture = createWriteFixture();
  const auth = await signedCompatWriteClient();
  let revoked = false;
  const verifier = createMcpOauthVerifier(verifierOptions({
    allowedScopes: [...COMPAT_WRITE_SCOPES], audience: [AUDIENCE, `${AUDIENCE}-compat`],
    jwks: staticJwksProvider([auth.key.jwk]), isRevoked: async () => revoked,
  }));
  const server = startCompatWriteApp({ writeFixture: fixture, verifier });
  const statuses: number[] = [];
  server.app.addHook('onResponse', async (_request, reply) => { statuses.push(reply.statusCode); });
  let catalogRequests = 0;
  let collectionHeader: string | null = null;
  const transport = createMcpHttpSdkTransport(server.app, auth.strictToken, (body, headers) => {
    if (body.method === 'tools/list') catalogRequests += 1;
    if (body.method === 'tools/call') collectionHeader = headers.get('mcp-param-x-collection-id');
  });
  const client = new Client({ name: 'cache-http-test', version: '1' }, {
    capabilities: {}, versionNegotiation: { mode: { pin: '2026-07-28' } },
  });
  try {
    await client.connect(transport);
    await client.listTools();
    await client.listTools();
    assert.equal(catalogRequests, 1, 'a fresh private catalog must avoid a second HTTP list request');
    const created = await client.callTool({ name: 'nodes.create', arguments: nodeCreateArguments() });
    assert.equal((created.structuredContent as { applied: boolean }).applied, true);
    assert.equal(collectionHeader, 'collection-1', 'the SDK must mirror the advertised routing parameter');
    assert.equal(fixture.nodeCreateCalls.length, 1);
    revoked = true;
    await assert.rejects(client.callTool({ name: 'nodes.create', arguments: nodeCreateArguments('Blocked') }));
    assert.equal(statuses.at(-1), 401);
    assert.equal(fixture.nodeCreateCalls.length, 1, 'cached discovery must not authorize execution');
  } finally {
    await client.close();
    await server.app.close();
  }
});
