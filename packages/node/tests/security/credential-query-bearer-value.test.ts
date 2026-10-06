import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  CREDENTIAL_QUERY_PARAMETER_NAMES,
  OAUTH_ACCESS_TOKEN_TTL_CEILING_SECONDS,
  enforceApiKeyTransport,
  enforceOAuth21Profile,
} from '../../src/security/index.js';
import type { OAuth21ProfileInput, OAuth21ProfilePorts } from '../../src/security/index.js';

/**
 * U-14: shared query names token/id_token/refresh_token, and decoded values
 * equal to the current bearer or its Bearer form. Query is not authentication.
 */

const evidence = '[review:security.credential-query-bearer]';
const resource = 'https://publisher.example.test/mcp';
const authorizationServer = 'https://authorization.example.test';
const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abc';
const challenge = createHash('sha256').update(verifier).digest('base64url');
const opaqueBearer = 'opaque+bearer~Aa9._-';
const jwtBearer = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.sig';
const otherOpaque = 'k7f3c9a2e4b6d8f0a1c3e5b7d9f2a4c6e8';
const outboundToken = 'outbound-access-token-secret-Bb8';
const previousRefreshToken = 'previous-refresh-token-secret-Cc7';
const currentRefreshToken = 'current-refresh-token-secret-Dd6';

function ports(): { profilePorts: OAuth21ProfilePorts; isAuthorized: ReturnType<typeof vi.fn> } {
  const isAuthorized = vi.fn(async () => true);
  return { profilePorts: { authorizationServerProvenance: { isAuthorized } }, isAuthorized };
}

function profile(bearer: string, requestTarget: string, authorization?: string): OAuth21ProfileInput {
  return {
    integration: 'remote-mcp',
    applicability: 'applicable',
    protectedResourceMetadata: { resource, authorizationServers: [authorizationServer] },
    authorizationServerDiscovery: {
      authorizationServer,
      method: 'authorization-server-metadata',
      discoveryUrl: `${authorizationServer}/.well-known/oauth-authorization-server`,
      issuer: authorizationServer,
      authorizationEndpoint: `${authorizationServer}/authorize`,
      tokenEndpoint: `${authorizationServer}/token`,
    },
    authorizationRequest: { resource },
    tokenRequest: { resource },
    accessToken: {
      audience: resource,
      issuedAt: 1_000_000,
      expiresAt: 1_000_000 + OAUTH_ACCESS_TOKEN_TTL_CEILING_SECONDS,
    },
    transport: {
      requestTarget,
      authorization: authorization === undefined ? `Bearer ${bearer}` : authorization,
    },
    client: { type: 'public', pkce: { challengeMethod: 'S256', challenge, verifier } },
    refreshToken: {
      issued: true,
      rotation: 'rotate-on-use',
      previousToken: previousRefreshToken,
      currentToken: currentRefreshToken,
    },
    tokenFlow: {
      upstream: { value: bearer, source: 'authorization-header' },
      outbound: { value: outboundToken, source: 'server-issued' },
    },
  };
}

async function decision(input: OAuth21ProfileInput, harness = ports()) {
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
  try {
    const result = await enforceOAuth21Profile(harness.profilePorts, input);
    const rendered = JSON.stringify({
      result,
      logs: spies.map((spy) => spy.mock.calls),
      provenance: harness.isAuthorized.mock.calls,
    });
    return { result, rendered, isAuthorized: harness.isAuthorized };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

describe(`${evidence} U-14 query credential names and current bearer values`, () => {
  it(`${evidence} shares token, id_token, and refresh_token on the denylist`, () => {
    expect(CREDENTIAL_QUERY_PARAMETER_NAMES).toEqual(expect.arrayContaining([
      'token',
      'id_token',
      'refresh_token',
    ]));
  });

  it(`${evidence} rejects alias, case, and percent-encoded credential names`, async () => {
    for (const requestTarget of [
      '/mcp?token=business',
      '/mcp?TOKEN=business',
      '/mcp?Token=business',
      '/mcp?%74oken=business',
      '/mcp?id_token=business',
      '/mcp?ID_TOKEN=biz',
      '/mcp?id%5Ftoken=business',
      '/mcp?refresh_token=business',
      '/mcp?Refresh_Token=business',
      '/mcp?refresh%5Ftoken=business',
    ]) {
      const seen = await decision(profile(opaqueBearer, requestTarget));
      expect(seen.result).toMatchObject({ allowed: false, reason: 'credential_in_query' });
      expect(seen.rendered).not.toContain(opaqueBearer);
    }
  });

  it(`${evidence} rejects q equal to an opaque or JWT bearer, including its Bearer form`, async () => {
    for (const bearer of [opaqueBearer, jwtBearer]) {
      for (const requestTarget of [
        `/mcp?q=${encodeURIComponent(bearer)}`,
        `/mcp?q=${encodeURIComponent(`Bearer ${bearer}`)}`,
        `/mcp?q=${encodeURIComponent(`bEaReR ${bearer}`)}`,
        `/mcp?page=1&q=${encodeURIComponent(bearer)}`,
      ]) {
        const seen = await decision(profile(bearer, requestTarget));
        expect(seen.result).toMatchObject({ allowed: false, disposition: 'denied', reason: 'credential_in_query' });
        expect(seen.rendered).not.toContain(bearer);
      }
    }
  });

  it(`${evidence} allows an ordinary q and a non-credential business value`, async () => {
    for (const bearer of [opaqueBearer, jwtBearer]) {
      for (const requestTarget of [
        '/mcp?q=bookmarks',
        '/mcp?q=',
        '/mcp?page=1&cursor=next',
        `/mcp?q=${encodeURIComponent(otherOpaque)}`,
        `/mcp?q=${encodeURIComponent(`prefix-${bearer}`)}`,
        `/mcp?q=${encodeURIComponent('eyJhbGciOiJub25lIn0.eyJzdWIiOiJ5In0.other')}`,
        `/mcp?next=${encodeURIComponent(`Bearer ${otherOpaque}`)}`,
      ]) {
        const seen = await decision(profile(bearer, requestTarget));
        expect(seen.result).toMatchObject({ allowed: true, disposition: 'enforced', reason: 'profile_satisfied' });
        expect(seen.rendered).not.toContain(bearer);
        expect(seen.isAuthorized).toHaveBeenCalledOnce();
      }
    }
  });

  it(`${evidence} does not authenticate from the query when Authorization is absent or invalid`, async () => {
    const queryOnly = profile(opaqueBearer, `/mcp?q=${encodeURIComponent(opaqueBearer)}`);
    delete (queryOnly.transport as { authorization?: string }).authorization;
    const missing = await decision(queryOnly);
    expect(missing.result).toMatchObject({ allowed: false, reason: 'invalid_input' });
    expect(missing.rendered).not.toContain(opaqueBearer);

    const emptyAuthorization = await decision(profile(
      opaqueBearer,
      `/mcp?q=${encodeURIComponent(opaqueBearer)}`,
      '',
    ));
    expect(emptyAuthorization.result.allowed).toBe(false);
    expect(emptyAuthorization.rendered).not.toContain(opaqueBearer);

    const ordinaryWithoutBearer = await decision(profile(opaqueBearer, '/mcp?q=bookmarks', ''));
    expect(ordinaryWithoutBearer.result).toMatchObject({ allowed: false, reason: 'invalid_authorization' });
    expect(ordinaryWithoutBearer.rendered).not.toContain(opaqueBearer);
  });

  it(`${evidence} keeps the decoded query count budget`, async () => {
    const withinBudget = Array.from({ length: 256 }, () => 'n=1').join('&');
    const overBudget = Array.from({ length: 257 }, () => 'n=1').join('&');
    const allowed = await decision(profile(opaqueBearer, `/mcp?${withinBudget}`));
    expect(allowed.result).toMatchObject({ allowed: true, reason: 'profile_satisfied' });
    const denied = await decision(profile(opaqueBearer, `/mcp?${overBudget}&token=business`));
    expect(denied.result).toMatchObject({ allowed: false, reason: 'invalid_input' });
  });

  it(`${evidence} API-key transport shares the new names and still allows ordinary high-entropy q`, () => {
    for (const requestTarget of [
      '/items?token=business',
      '/items?TOKEN=business',
      '/items?id_token=business',
      '/items?id%5Ftoken=business',
      '/items?refresh_token=business',
      '/items?refresh%5Ftoken=business',
    ]) {
      expect(enforceApiKeyTransport({ requestTarget })).toEqual({
        allowed: false,
        reason: 'credential_in_query',
      });
    }
    expect(enforceApiKeyTransport({
      requestTarget: `/items?q=${encodeURIComponent(otherOpaque)}&page=1`,
    })).toEqual({ allowed: true, reason: 'allowed', authorizationPresent: false });
    expect(enforceApiKeyTransport({
      requestTarget: '/items?q=eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.sig',
    })).toEqual({ allowed: true, reason: 'allowed', authorizationPresent: false });
  });
});
