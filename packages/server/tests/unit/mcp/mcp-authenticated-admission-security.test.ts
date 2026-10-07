import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { McpAuthorizationBinding } from '@know-n/colp/mcp';
import { McpOauthVerificationError } from '../../../src/modules/mcp/index.js';
import { mcpRateLimitSubject } from '../../../src/transport/mcp/mcp-shared-admission.js';
import { mapMcpCompatAuthInfo } from '../../../src/transport/mcp/mcp-compat-authinfo.js';

const strict = '/collections/-/mcp', compat = '/collections/-/mcp-compat';
const binding = (path: string): McpAuthorizationBinding => ({ kind: 'authenticated', principalId: 'p',
  clientId: 'c', credentialBindingId: 'digest', resourceAudience: `https://known.test${path}`, securityEpoch: 'e' } as McpAuthorizationBinding);
for (const path of [strict, compat]) {
  test(`shared admission rejects the other resource before ${path} can consume quota or dispatch`, () => {
    const request = { ip: '127.0.0.1', routeOptions: { url: path } } as FastifyRequest;
    const other = path === strict ? compat : strict;
    assert.equal(mcpRateLimitSubject(request, binding(path)).policy, 'request');
    assert.throws(() => mcpRateLimitSubject(request, binding(other)),
      (error: unknown) => error instanceof McpOauthVerificationError && error.reason === 'wrong_audience');
  });
}
test('compat SDK AuthInfo preserves the admitted token resource instead of relabeling it strict', () => {
  const auth = mapMcpCompatAuthInfo({ binding: binding(compat), scopes: [], resourceAudience: `https://known.test${strict}` });
  assert.equal(String(auth.resource), `https://known.test${compat}`);
});
