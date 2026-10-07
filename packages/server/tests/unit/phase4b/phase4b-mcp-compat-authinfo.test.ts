import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAnonymousPublicBinding } from '@know-n/colp/mcp';
import {
  MCP_COMPAT_AUTH_TOKEN_SENTINEL,
  MCP_ACCOUNT_SUBJECT_ID_AUTHORIZATION_KEY,
  createMcpApplicationContext,
} from '../../../src/modules/mcp/index.js';
import {
  MCP_COMPAT_ANONYMOUS_AUTHINFO_CLIENT_ID,
  attachMcpCompatAuthInfo,
  mapMcpCompatAuthInfo,
  type McpCompatKnownBinding,
} from '../../../src/transport/mcp/mcp-compat-authinfo.js';
import { MCP_COMPAT_CANARY_BEARER } from '../../support/phase4b-mcp-compat-spike.js';
import { AUDIENCE, CLIENT_ID } from '../../support/phase4b-mcp-transport-scaffold.js';

const RESOURCE = AUDIENCE;
const EPOCH = 'epoch-1';
const EXPIRES = new Date('2026-08-05T09:00:00.000Z');

function authenticatedBinding() {
  return Object.freeze({
    kind: 'authenticated' as const,
    principalId: 'account-alice-1',
    clientId: CLIENT_ID,
    credentialBindingId: 'binding-digest-not-a-token',
    resourceAudience: RESOURCE,
    securityEpoch: EPOCH,
  });
}

function taint(value: unknown): string {
  return JSON.stringify(value);
}

test('anonymous AuthInfo uses the sentinel token and token-free knownBinding', () => {
  const binding = createAnonymousPublicBinding({
    resourceAudience: RESOURCE,
    securityEpoch: EPOCH,
  });
  const authInfo = mapMcpCompatAuthInfo({
    binding,
    scopes: [],
    resourceAudience: RESOURCE,
  });
  assert.equal(authInfo.token, MCP_COMPAT_AUTH_TOKEN_SENTINEL);
  assert.equal(authInfo.token, 'verified-upstream');
  assert.equal(authInfo.clientId, MCP_COMPAT_ANONYMOUS_AUTHINFO_CLIENT_ID);
  assert.deepEqual(authInfo.scopes, []);
  assert.equal(authInfo.expiresAt, undefined);
  assert.equal(authInfo.resource?.href, RESOURCE);
  assert.equal((authInfo.extra?.knownBinding as McpCompatKnownBinding).kind, 'anonymous');
  assert.equal((authInfo.extra?.knownBinding as McpCompatKnownBinding).principalId, 'public');
  assert.equal(Object.isFrozen(authInfo), true);
  assert.doesNotMatch(taint(authInfo), new RegExp(MCP_COMPAT_CANARY_BEARER, 'u'));
  assert.notEqual(authInfo.token, MCP_COMPAT_CANARY_BEARER);
});

test('authenticated AuthInfo copies verified facts and never accepts a raw token argument', () => {
  const binding = authenticatedBinding();
  const authInfo = mapMcpCompatAuthInfo({
    binding,
    scopes: ['mcp:read:public', 'mcp:read:own'],
    expiresAt: EXPIRES,
    resourceAudience: RESOURCE,
  });
  assert.equal(authInfo.token, MCP_COMPAT_AUTH_TOKEN_SENTINEL);
  assert.equal(authInfo.clientId, CLIENT_ID);
  assert.deepEqual(authInfo.scopes, ['mcp:read:public', 'mcp:read:own']);
  assert.equal(authInfo.expiresAt, Math.floor(EXPIRES.getTime() / 1_000));
  assert.equal(authInfo.resource?.href, RESOURCE);
  assert.equal((authInfo.extra?.knownBinding as McpCompatKnownBinding).kind, 'authenticated');
  assert.equal((authInfo.extra?.knownBinding as McpCompatKnownBinding).principalId, 'account-alice-1');
  assert.equal((authInfo.extra?.knownBinding as McpCompatKnownBinding).clientId, CLIENT_ID);
  assert.equal((authInfo.extra?.knownBinding as McpCompatKnownBinding).credentialBindingId, 'binding-digest-not-a-token');
  assert.equal((authInfo.extra?.knownBinding as McpCompatKnownBinding).resourceAudience, RESOURCE);
  assert.equal((authInfo.extra?.knownBinding as McpCompatKnownBinding).securityEpoch, EPOCH);
  const blob = taint(authInfo);
  assert.doesNotMatch(blob, /Bearer /u);
  assert.doesNotMatch(blob, new RegExp(MCP_COMPAT_CANARY_BEARER, 'u'));
  assert.match(blob, new RegExp(MCP_COMPAT_AUTH_TOKEN_SENTINEL, 'u'));
});

test('sentinel is not a principal, cache key, or credential in knownBinding', () => {
  const authInfo = mapMcpCompatAuthInfo({
    binding: authenticatedBinding(),
    scopes: ['mcp:read:public'],
    expiresAt: EXPIRES,
    resourceAudience: RESOURCE,
  });
  const known = authInfo.extra?.knownBinding as Readonly<Record<string, unknown>>;
  for (const value of Object.values(known)) {
    assert.notEqual(value, MCP_COMPAT_AUTH_TOKEN_SENTINEL);
    assert.notEqual(value, MCP_COMPAT_CANARY_BEARER);
  }
  assert.notEqual(authInfo.clientId, MCP_COMPAT_AUTH_TOKEN_SENTINEL);
});

test('application context is token-free and may carry accountSubjectId without the bearer', () => {
  const binding = authenticatedBinding();
  const context = createMcpApplicationContext({
    principal: {
      kind: 'authenticated',
      principalId: binding.principalId,
      clientId: binding.clientId,
      credentialBindingId: binding.credentialBindingId,
      resourceAudience: binding.resourceAudience,
      securityEpoch: binding.securityEpoch,
    },
    scopes: ['mcp:read:own'],
    abortSignal: new AbortController().signal,
    budgets: {
      maxDepth: 16,
      maxNodes: 10,
      maxBytes: 1_024,
      maxOperations: 10,
    },
    correlationId: 'req-1',
    authorization: {
      requestId: 'req-1',
      [MCP_ACCOUNT_SUBJECT_ID_AUTHORIZATION_KEY]: 'urn:known:subject:alice',
    },
  });
  const blob = taint(context);
  assert.doesNotMatch(blob, new RegExp(MCP_COMPAT_CANARY_BEARER, 'u'));
  assert.doesNotMatch(blob, /Bearer /u);
  assert.equal(context.authorization.requestId, 'req-1');
  assert.equal('token' in context.authorization, false);
});

test('attachMcpCompatAuthInfo writes only sentinel AuthInfo onto req.auth', () => {
  const raw: { headers: Record<string, string>; auth?: { token: string } } = {
    headers: { authorization: `Bearer ${MCP_COMPAT_CANARY_BEARER}` },
  };
  const authInfo = mapMcpCompatAuthInfo({
    binding: createAnonymousPublicBinding({
      resourceAudience: RESOURCE,
      securityEpoch: EPOCH,
    }),
    scopes: [],
    resourceAudience: RESOURCE,
  });
  attachMcpCompatAuthInfo(raw, authInfo);
  assert.equal(raw.auth?.token, MCP_COMPAT_AUTH_TOKEN_SENTINEL);
  assert.doesNotMatch(taint(raw.auth), new RegExp(MCP_COMPAT_CANARY_BEARER, 'u'));
});
