import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { McpAuthorizationBinding } from '@know-n/colp/mcp';
import { mcpRateLimitSubject } from '../../../src/transport/mcp/mcp-shared-admission.js';
import { isMcpAudienceForEndpoint, mcpQuotaResource } from '../../../src/transport/mcp/mcp-endpoint-audience.js';

const strict = '/collections/-/mcp';
const compat = '/collections/-/mcp-compat';
const request = (path: string, ip = '192.0.2.1') => ({ ip, routeOptions: { url: path } }) as FastifyRequest;
const binding = (path: string, overrides: Record<string, string> = {}) => ({
  kind: 'authenticated', principalId: 'principal', clientId: 'client', credentialBindingId: 'digest',
  resourceAudience: `https://known.test${path}`, securityEpoch: 'epoch', ...overrides,
}) as McpAuthorizationBinding;

test('strict and compatibility share authenticated request quota after endpoint validation', () => {
  assert.deepEqual(mcpRateLimitSubject(request(strict), binding(strict), 'https://known.test'),
    mcpRateLimitSubject(request(compat), binding(compat), 'https://known.test'));
  assert.throws(() => mcpRateLimitSubject(request(strict), binding(compat), 'https://known.test'));
  assert.throws(() => mcpRateLimitSubject(request(compat), binding(strict), 'https://known.test'));
});

test('quota normalization preserves origin, principal, client and security epoch', () => {
  const original = mcpRateLimitSubject(request(strict), binding(strict), 'https://known.test');
  for (const overrides of [
    { principalId: 'other' }, { clientId: 'other' }, { securityEpoch: 'other' },
  ]) {
    assert.notDeepEqual(mcpRateLimitSubject(request(strict), binding(strict, overrides), 'https://known.test'), original);
  }
  for (const overrides of [
    { resourceAudience: `https://other.test${strict}` },
    { resourceAudience: `https://known.test:8443${strict}` },
  ]) {
    assert.throws(() => mcpRateLimitSubject(request(strict), binding(strict, overrides), 'https://known.test'));
  }
});

test('anonymous endpoint aliases share quota but different IPs do not', () => {
  const anonymous = (path: string) => ({ kind: 'anonymous', resourceAudience: `https://known.test${path}`,
    securityEpoch: 'epoch' }) as McpAuthorizationBinding;
  const original = mcpRateLimitSubject(request(strict), anonymous(strict), 'https://known.test');
  assert.deepEqual(mcpRateLimitSubject(request(compat), anonymous(compat), 'https://known.test'), original);
  assert.notDeepEqual(mcpRateLimitSubject(request(compat, '192.0.2.2'), anonymous(compat), 'https://known.test'), original);
});

test('quota canonicalization cannot be used to weaken the OAuth route binding', () => {
  assert.equal(mcpQuotaResource(`https://known.test${compat}`), `https://known.test${strict}`);
  assert.equal(isMcpAudienceForEndpoint(`https://known.test${compat}`, strict, 'https://known.test'), false);
  for (const value of ['not a URL', 'https://known.test/other', `https://known.test${strict}?x=1`,
    `https://user:password@known.test${strict}`, `https://known.test${compat}#fragment`]) {
    assert.throws(() => mcpQuotaResource(value), TypeError);
  }
});
