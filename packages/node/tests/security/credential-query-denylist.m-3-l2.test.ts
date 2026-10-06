import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  OAUTH_ACCESS_TOKEN_TTL_CEILING_SECONDS,
  enforceApiKeyOnlyTransport,
  enforceApiKeyTransport,
  enforceOAuth21Profile,
} from '../../src/security/index.js';
import type {
  ApiKeyTransportInput,
  OAuth21ProfileInput,
  OAuth21ProfilePorts,
} from '../../src/security/index.js';

/**
 * M-3 / L-2: shared credential query denylist + API-key-only transport naming.
 *
 * L-2 — OAuth applicable transport must reject the same credential query
 * parameter names as the API-key guard (`api_key`, `x-api-key`,
 * `authorization`, `access_token`, …), not only `access_token`.
 *
 * M-3 — The API-key transport guard is intentionally API-key-only: ordinary
 * OAuth-looking Bearer tokens that are not `colp_*` / classifier matches stay
 * `invalid_authorization`. The `enforceApiKeyOnlyTransport` alias makes that
 * scope explicit for composition (same function or same behavior as
 * `enforceApiKeyTransport`).
 *
 * Fixtures adapted from oauth-profile.sec-0009 and api-key-transport.sec-0008.
 */

const evidence = '[evidence:security.credential-query-denylist]';

const resource = 'https://publisher.example.test/mcp';
const authorizationServer = 'https://authorization.example.test';
const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abc';
const challenge = createHash('sha256').update(verifier).digest('base64url');
const upstreamToken = 'upstream-access-token-secret-Aa9';
const outboundToken = 'outbound-access-token-secret-Bb8';
const previousRefreshToken = 'previous-refresh-token-secret-Cc7';
const currentRefreshToken = 'current-refresh-token-secret-Dd6';
const liveKey = 'colp_live_Aa9._~-safe';

/** Shared credential query names under test (subset of the built-in denylist). */
const credentialQueryNames = [
  'api_key',
  'x-api-key',
  'authorization',
  'access_token',
  'key',
] as const;

function ports(
  isAuthorized: OAuth21ProfilePorts['authorizationServerProvenance']['isAuthorized'] =
    vi.fn(async () => true),
): OAuth21ProfilePorts {
  return { authorizationServerProvenance: { isAuthorized } };
}

/** Minimal compliant applicable remote-MCP profile (sec-0009 shape). */
function oauthCompliant(overrides: Partial<OAuth21ProfileInput> = {}): OAuth21ProfileInput {
  return {
    integration: 'remote-mcp',
    applicability: 'applicable',
    protectedResourceMetadata: {
      resource,
      authorizationServers: [authorizationServer],
    },
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
      requestTarget: '/mcp',
      authorization: `Bearer ${upstreamToken}`,
    },
    client: {
      type: 'public',
      pkce: { challengeMethod: 'S256', challenge, verifier },
    },
    refreshToken: {
      issued: true,
      rotation: 'rotate-on-use',
      previousToken: previousRefreshToken,
      currentToken: currentRefreshToken,
    },
    tokenFlow: {
      upstream: { value: upstreamToken, source: 'authorization-header' },
      outbound: { value: outboundToken, source: 'server-issued' },
    },
    ...overrides,
  };
}

function oauthTransport(
  requestTarget: string,
  authorization: string | readonly string[] = `Bearer ${upstreamToken}`,
): Pick<OAuth21ProfileInput, 'transport'> {
  return { transport: { requestTarget, authorization } };
}

async function expectOAuthDenied(
  input: OAuth21ProfileInput,
  reason: string,
  profilePorts = ports(),
): Promise<void> {
  await expect(enforceOAuth21Profile(profilePorts, input)).resolves.toMatchObject({
    allowed: false,
    disposition: 'denied',
    reason,
  });
}

function apiKeyInspect(overrides: Partial<ApiKeyTransportInput> = {}) {
  return enforceApiKeyTransport({ requestTarget: '/collections', ...overrides });
}

function rejected(reason: string) {
  return { allowed: false, reason };
}

describe(`${evidence} M-3/L-2 shared credential query denylist + API-key-only naming`, () => {
  describe('L-2 OAuth applicable path rejects shared credential query names', () => {
    it(`${evidence} denies applicable OAuth when ?api_key= is present`, async () => {
      await expectOAuthDenied(
        oauthCompliant(oauthTransport(`/mcp?api_key=${encodeURIComponent('secret')}`)),
        'credential_in_query',
      );
    });

    it(`${evidence} denies applicable OAuth for ?x-api-key= and ?authorization=`, async () => {
      for (const requestTarget of [
        '/mcp?x-api-key=',
        `/mcp?x-api-key=${encodeURIComponent('secret')}`,
        '/mcp?authorization=',
        `/mcp?authorization=${encodeURIComponent('Bearer secret')}`,
      ]) {
        await expectOAuthDenied(
          oauthCompliant(oauthTransport(requestTarget)),
          'credential_in_query',
        );
      }
    });

    it(`${evidence} still denies applicable OAuth for ?access_token=`, async () => {
      for (const requestTarget of [
        `/mcp?access_token=${encodeURIComponent(upstreamToken)}`,
        `/mcp?access_token=`,
        `/mcp?ok=1&access_token=${encodeURIComponent(upstreamToken)}`,
      ]) {
        await expectOAuthDenied(
          oauthCompliant(oauthTransport(requestTarget)),
          'credential_in_query',
        );
      }
    });

    it(`${evidence} does not treat benign query names as credentials on OAuth`, async () => {
      for (const requestTarget of ['/mcp?page=1', '/mcp?limit=20&cursor=next', '/mcp?ok=1&empty=']) {
        await expect(enforceOAuth21Profile(ports(), oauthCompliant(oauthTransport(requestTarget)))).resolves
          .toMatchObject({
            allowed: true,
            disposition: 'enforced',
            reason: 'profile_satisfied',
          });
      }
    });
  });

  describe('L-2 API-key path shares the same query denylist names', () => {
    it(`${evidence} denies API-key transport for the same credential query names`, () => {
      for (const name of credentialQueryNames) {
        expect(apiKeyInspect({ requestTarget: `/items?${name}` })).toEqual(
          rejected('credential_in_query'),
        );
        expect(apiKeyInspect({ requestTarget: `/items?${name}=ordinary-looking` })).toEqual(
          rejected('credential_in_query'),
        );
        expect(
          apiKeyInspect({
            requestTarget: `/items?${name}=${encodeURIComponent('secret')}`,
            authorization: `Bearer ${liveKey}`,
          }),
        ).toEqual(rejected('credential_in_query'));
      }
    });

    it(`${evidence} does not treat benign query names as credentials on API-key paths`, () => {
      for (const requestTarget of [
        '/collections?page=1',
        '/collections?limit=20&cursor=next',
        '/items?monkey=value&polygon=yes&api_keys=metadata',
      ]) {
        expect(apiKeyInspect({ requestTarget })).toEqual({
          allowed: true,
          reason: 'allowed',
          authorizationPresent: false,
        });
      }
    });
  });

  describe('M-3 API-key-only Bearer classification and naming', () => {
    it(`${evidence} allows Bearer colp_live_… when the query has no credential name`, () => {
      const decision = apiKeyInspect({
        requestTarget: '/collections?page=1&limit=20',
        authorization: `Bearer ${liveKey}`,
      });
      expect(decision).toEqual({
        allowed: true,
        reason: 'allowed',
        authorizationPresent: true,
      });
      expect(JSON.stringify(decision)).not.toContain(liveKey);
    });

    it(`${evidence} rejects ordinary OAuth-looking Bearer that is not colp_* / classifier match`, () => {
      for (const authorization of [
        `Bearer ${upstreamToken}`,
        'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
        'Bearer random-oauth-token-not-a-colp-key',
      ]) {
        expect(
          apiKeyInspect({
            requestTarget: '/collections',
            authorization,
          }),
        ).toEqual(rejected('invalid_authorization'));
      }
    });

    it(`${evidence} still accepts a custom classifier match as API-key Bearer`, () => {
      const customSecret = 'deployment-key-4e9c';
      const classifier = vi.fn((candidate: string) => candidate === customSecret);
      expect(
        apiKeyInspect({
          requestTarget: '/collections?page=1',
          authorization: `Bearer ${customSecret}`,
          classifyApiKey: classifier,
        }),
      ).toEqual({
        allowed: true,
        reason: 'allowed',
        authorizationPresent: true,
      });
      expect(classifier).toHaveBeenCalledWith(customSecret);
    });

    it(`${evidence} exports enforceApiKeyOnlyTransport as the same function or same behavior`, () => {
      // Preferred: true alias (same reference) after M-3 naming.
      if (enforceApiKeyOnlyTransport === enforceApiKeyTransport) {
        expect(enforceApiKeyOnlyTransport).toBe(enforceApiKeyTransport);
        return;
      }

      // Fallback: identical decisions on representative inputs.
      const cases: readonly ApiKeyTransportInput[] = [
        { requestTarget: '/collections?page=1' },
        { requestTarget: '/collections', authorization: `Bearer ${liveKey}` },
        { requestTarget: `/items?api_key=secret`, authorization: `Bearer ${liveKey}` },
        { requestTarget: '/collections', authorization: `Bearer ${upstreamToken}` },
      ];
      for (const input of cases) {
        expect(enforceApiKeyOnlyTransport(input)).toEqual(enforceApiKeyTransport(input));
      }
    });
  });
});
