import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import {
  OAUTH_ACCESS_TOKEN_TTL_CEILING_SECONDS,
  enforceOAuth21Profile,
} from '../../src/security/index.js';
import type {
  OAuth21ProfileInput,
  OAuth21ProfilePorts,
} from '../../src/security/index.js';

const evidence = '[evidence:security.oauth21-profile]';
const resource = 'https://publisher.example.test/mcp';
const authorizationServer = 'https://authorization.example.test';
const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abc';
const challenge = createHash('sha256').update(verifier).digest('base64url');
const upstreamToken = 'upstream-access-token-secret-Aa9';
const outboundToken = 'outbound-access-token-secret-Bb8';
const previousRefreshToken = 'previous-refresh-token-secret-Cc7';
const currentRefreshToken = 'current-refresh-token-secret-Dd6';

function ports(
  isAuthorized: OAuth21ProfilePorts['authorizationServerProvenance']['isAuthorized'] =
    vi.fn(async () => true),
): OAuth21ProfilePorts {
  return { authorizationServerProvenance: { isAuthorized } };
}

function compliant(overrides: Partial<OAuth21ProfileInput> = {}): OAuth21ProfileInput {
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

async function expectDenied(
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

describe(`${evidence} SEC-0009 OAuth 2.1 profile`, () => {
  it(`${evidence} accepts a complete remote MCP exchange using authorization-server metadata`, async () => {
    const profilePorts = ports();
    await expect(enforceOAuth21Profile(profilePorts, compliant())).resolves.toMatchObject({
      allowed: true,
      disposition: 'enforced',
      integration: 'remote-mcp',
      reason: 'profile_satisfied',
    });
    expect(profilePorts.authorizationServerProvenance.isAuthorized).toHaveBeenCalledOnce();
    expect(profilePorts.authorizationServerProvenance.isAuthorized).toHaveBeenCalledWith({
      resource,
      authorizationServer,
      method: 'authorization-server-metadata',
      discoveryUrl: `${authorizationServer}/.well-known/oauth-authorization-server`,
      issuer: authorizationServer,
      authorizationEndpoint: `${authorizationServer}/authorize`,
      tokenEndpoint: `${authorizationServer}/token`,
    });
  });

  it(`${evidence} accepts a third-party exchange using OIDC discovery`, async () => {
    await expect(enforceOAuth21Profile(ports(), compliant({
      integration: 'third-party',
      authorizationServerDiscovery: {
        authorizationServer,
        method: 'openid-connect-discovery',
        discoveryUrl: `${authorizationServer}/.well-known/openid-configuration`,
        issuer: authorizationServer,
        authorizationEndpoint: `${authorizationServer}/authorize`,
        tokenEndpoint: `${authorizationServer}/token`,
      },
    }))).resolves.toMatchObject({
      allowed: true,
      disposition: 'enforced',
      integration: 'third-party',
    });
  });

  it(`${evidence} permits only explicit and non-contradictory not-applicable declarations`, async () => {
    for (const integration of ['local-mcp', 'first-party', 'other'] as const) {
      const profilePorts = ports();
      await expect(enforceOAuth21Profile(profilePorts, {
        integration,
        applicability: 'not-applicable',
      } as OAuth21ProfileInput)).resolves.toEqual({
        allowed: true,
        disposition: 'not_applicable',
        integration,
        reason: 'not_applicable',
      });
      expect(profilePorts.authorizationServerProvenance.isAuthorized).not.toHaveBeenCalled();
    }
    for (const input of [
      { integration: 'remote-mcp', applicability: 'not-applicable' },
      { integration: 'third-party', applicability: 'not-applicable' },
      { integration: 'local-mcp', applicability: 'applicable' },
      { integration: 'first-party' },
    ]) {
      await expect(enforceOAuth21Profile(ports(), input as OAuth21ProfileInput)).resolves.toMatchObject({
        allowed: false,
        disposition: 'denied',
      });
    }
  });

  it(`${evidence} ignores hostile residual profile fields only for explicit non-applicable integrations`, async () => {
    const residualGetter = vi.fn(() => {
      throw new Error('residual profile data must not be inspected');
    });
    const input = Object.defineProperty({
      integration: 'local-mcp',
      applicability: 'not-applicable',
    }, 'protectedResourceMetadata', { enumerable: true, get: residualGetter });
    Object.defineProperty(input, 'authorizationServerDiscovery', {
      enumerable: true,
      value: new Proxy({}, { get: () => { throw new Error('residual Proxy trap'); } }),
    });

    await expect(enforceOAuth21Profile(ports(), input as unknown as OAuth21ProfileInput)).resolves.toEqual({
      allowed: true,
      disposition: 'not_applicable',
      integration: 'local-mcp',
      reason: 'not_applicable',
    });
    expect(residualGetter).not.toHaveBeenCalled();
  });

  it(`${evidence} requires RFC 9728 metadata and authorization-server discovery`, async () => {
    const base = compliant();
    const { protectedResourceMetadata: _metadata, ...withoutMetadata } = base;
    const { authorizationServerDiscovery: _discovery, ...withoutDiscovery } = base;
    await expectDenied(withoutMetadata as OAuth21ProfileInput, 'invalid_input');
    await expectDenied(withoutDiscovery as OAuth21ProfileInput, 'invalid_input');
  });

  it(`${evidence} rejects insecure, credential-bearing, fragmented, and confused resource URLs`, async () => {
    for (const candidate of [
      'http://publisher.example.test/mcp',
      'https://user:pass@publisher.example.test/mcp',
      'https://publisher.example.test/mcp#fragment',
      'https://publisher.example.test\\@attacker.example/mcp',
      'https://publisher.example.test.evil.example/mcp',
      'https://publisher.example.test/%2e%2e/mcp',
    ]) {
      await expect(enforceOAuth21Profile(ports(), compliant({
        protectedResourceMetadata: {
          resource: candidate,
          authorizationServers: [authorizationServer],
        },
      }))).resolves.toMatchObject({ allowed: false, disposition: 'denied' });
    }
  });

  it(`${evidence} validates RFC 8414 and OIDC discovery URLs, issuer, and endpoints`, async () => {
    const base = compliant().authorizationServerDiscovery;
    for (const authorizationServerDiscovery of [
      { ...base, discoveryUrl: 'http://authorization.example.test/.well-known/oauth-authorization-server' },
      { ...base, discoveryUrl: `https://user:pass@authorization.example.test/.well-known/oauth-authorization-server` },
      { ...base, discoveryUrl: `${base.discoveryUrl}#fragment` },
      { ...base, issuer: `${authorizationServer}/other` },
      { ...base, authorizationEndpoint: 'http://authorization.example.test/authorize' },
      { ...base, tokenEndpoint: 'https://authorization.example.test\\@attacker.example/token' },
      { ...base, method: 'openid-connect-discovery', discoveryUrl: base.discoveryUrl },
    ]) {
      await expectDenied(
        compliant({ authorizationServerDiscovery: authorizationServerDiscovery as never }),
        'invalid_authorization_server_discovery',
      );
    }
  });

  it(`${evidence} constructs RFC 8414 and OIDC well-known paths for path issuers`, async () => {
    const pathIssuer = `${authorizationServer}/tenant/issuer/`;
    for (const [method, discoveryUrl] of [
      ['authorization-server-metadata', `${authorizationServer}/.well-known/oauth-authorization-server/tenant/issuer/`],
      ['openid-connect-discovery', `${pathIssuer}.well-known/openid-configuration`],
    ] as const) {
      const profilePorts = ports();
      await expect(enforceOAuth21Profile(profilePorts, compliant({
        protectedResourceMetadata: { resource, authorizationServers: [pathIssuer] },
        authorizationServerDiscovery: {
          authorizationServer: pathIssuer,
          method,
          discoveryUrl,
          issuer: pathIssuer,
          authorizationEndpoint: `${pathIssuer}authorize`,
          tokenEndpoint: `${pathIssuer}token`,
        },
      }))).resolves.toMatchObject({ allowed: true });
      expect(profilePorts.authorizationServerProvenance.isAuthorized).toHaveBeenCalledWith(
        expect.objectContaining({ authorizationServer: pathIssuer, issuer: pathIssuer, discoveryUrl }),
      );
    }
  });

  it(`${evidence} rejects URL normalization and encoded-path confusion`, async () => {
    const base = compliant().authorizationServerDiscovery;
    for (const authorizationServerDiscovery of [
      { ...base, authorizationServer: 'https://authorization.example.test:443' },
      { ...base, issuer: 'https://AUTHORIZATION.example.test' },
      { ...base, issuer: `${authorizationServer}/` },
      { ...base, discoveryUrl: `${authorizationServer}/.well-known/%6fauth-authorization-server` },
      { ...base, discoveryUrl: `${authorizationServer}/.well-known/%2e/oauth-authorization-server` },
      { ...base, discoveryUrl: `${authorizationServer}/.well-known%2foauth-authorization-server` },
      { ...base, discoveryUrl: `${authorizationServer}/.well-known%5coauth-authorization-server` },
      { ...base, discoveryUrl: `${authorizationServer}/.well-known/%00oauth-authorization-server` },
      { ...base, discoveryUrl: `${authorizationServer}/.well-known/%c0%af` },
    ]) {
      await expectDenied(
        compliant({ authorizationServerDiscovery }),
        'invalid_authorization_server_discovery',
      );
    }
  });

  it(`${evidence} requires RFC 8707 resource in both authorization and token requests`, async () => {
    await expectDenied(compliant({ authorizationRequest: {} as never }), 'invalid_input');
    await expectDenied(compliant({ tokenRequest: {} as never }), 'invalid_input');
  });

  it(`${evidence} rejects either RFC 8707 resource when it mismatches metadata`, async () => {
    await expectDenied(
      compliant({ authorizationRequest: { resource: `${resource}/other` } }),
      'authorization_resource_mismatch',
    );
    await expectDenied(
      compliant({ tokenRequest: { resource: `${resource}/other` } }),
      'token_resource_mismatch',
    );
    await expectDenied(compliant({
      authorizationRequest: { resource: `${resource}/one` },
      tokenRequest: { resource: `${resource}/two` },
    }), 'authorization_resource_mismatch');
  });

  it(`${evidence} requires exact singleton RFC 8707 values in each request`, async () => {
    await expect(enforceOAuth21Profile(ports(), compliant({
      authorizationRequest: { resource: [resource] },
      tokenRequest: { resource: [resource] },
    }))).resolves.toMatchObject({ allowed: true });
    await expectDenied(
      compliant({ authorizationRequest: { resource: [resource, resource] } }),
      'authorization_resource_mismatch',
    );
    await expectDenied(
      compliant({ tokenRequest: { resource: [resource, resource] } }),
      'token_resource_mismatch',
    );
  });

  it(`${evidence} accepts an exact access-token audience string or singleton array`, async () => {
    await expect(enforceOAuth21Profile(ports(), compliant({
      accessToken: { ...compliant().accessToken, audience: resource },
    }))).resolves.toMatchObject({ allowed: true });
    await expect(enforceOAuth21Profile(ports(), compliant({
      accessToken: { ...compliant().accessToken, audience: [resource] },
    }))).resolves.toMatchObject({ allowed: true });
  });

  it(`${evidence} rejects missing, duplicate, mixed, and URL-confused token audiences`, async () => {
    for (const audience of [
      undefined,
      [],
      [resource, resource],
      [resource, 'https://other.example.test/mcp'],
      `${resource}/`,
      'https://publisher.example.test.evil.example/mcp',
      'https://publisher.example.test/%6dcp',
    ]) {
      await expect(enforceOAuth21Profile(ports(), compliant({
        accessToken: { ...compliant().accessToken, audience } as never,
      }))).resolves.toMatchObject({ allowed: false, disposition: 'denied' });
    }
  });

  it(`${evidence} forbids query access_token including encoded names and duplicates`, async () => {
    for (const requestTarget of [
      `/mcp?access_token=${upstreamToken}`,
      `/mcp?access%5Ftoken=${upstreamToken}`,
      `/mcp?ACCESS_TOKEN=${upstreamToken}`,
      `/mcp?ok=1&access_token=&access_token=${upstreamToken}`,
    ]) {
      await expectDenied(compliant({
        transport: { ...compliant().transport, requestTarget },
      }), 'credential_in_query');
    }
  });

  it(`${evidence} rejects a query token even when a valid Bearer header is present`, async () => {
    await expectDenied(compliant({
      transport: {
        requestTarget: `/mcp?access_token=${encodeURIComponent(upstreamToken)}`,
        authorization: `Bearer ${upstreamToken}`,
      },
    }), 'credential_in_query');
  });

  it(`${evidence} does not mistake benign query names or values for credential parameters`, async () => {
    // Shared denylist (SEC-0008/0009) rejects authorization / access-token as names;
    // values and non-denylist lookalikes remain allowed.
    for (const requestTarget of [
      '/mcp?bearer_token=display-label',
      '/mcp?next=access_token',
      '/mcp?api_keys=metadata',
      '/mcp?page=1&cursor=abc',
    ]) {
      await expect(enforceOAuth21Profile(ports(), compliant({
        transport: { ...compliant().transport, requestTarget },
      }))).resolves.toMatchObject({ allowed: true });
    }
  });

  it(`${evidence} forbids shared credential query aliases (api_key, authorization, …)`, async () => {
    for (const requestTarget of [
      `/mcp?api_key=${upstreamToken}`,
      '/mcp?authorization=consent',
      '/mcp?access-token=display-label',
      '/mcp?x-api-key=',
      `/mcp?API_KEY=${upstreamToken}`,
    ]) {
      await expectDenied(compliant({
        transport: { ...compliant().transport, requestTarget },
      }), 'credential_in_query');
    }
  });

  it(`${evidence} accepts one Bearer header and rejects multiple, Basic, controls, and malformed values`, async () => {
    await expect(enforceOAuth21Profile(ports(), compliant({
      transport: { requestTarget: '/mcp', authorization: [`Bearer ${upstreamToken}`] },
    }))).resolves.toMatchObject({ allowed: true });

    for (const authorization of [
      [`Bearer ${upstreamToken}`, `Bearer ${upstreamToken}`],
      `Basic ${upstreamToken}`,
      '',
      'Bearer',
      `Bearer ${upstreamToken}\u0000`,
      `Bearer ${upstreamToken}\r\nX-Leak: yes`,
    ]) {
      await expectDenied(compliant({
        transport: { requestTarget: '/mcp', authorization },
      }), 'invalid_authorization');
    }
  });

  it(`${evidence} rejects coalesced and conflicting Authorization values and malformed token68`, async () => {
    for (const authorization of [
      `Bearer ${upstreamToken}, Bearer ${upstreamToken}`,
      `Bearer ${upstreamToken}, Basic other`,
      `Bearer\t${upstreamToken}`,
      `Bearer ${upstreamToken}=middle`,
      [`Bearer ${upstreamToken}`, `Basic other`],
    ]) {
      await expectDenied(
        compliant({ transport: { requestTarget: '/mcp', authorization } }),
        'invalid_authorization',
      );
    }
  });

  it(`${evidence} requires public clients to use PKCE S256 with a matching challenge`, async () => {
    for (const pkce of [
      undefined,
      { challengeMethod: 'plain', challenge: verifier, verifier },
      { challengeMethod: 'S256', challenge: undefined, verifier },
      { challengeMethod: 'S256', challenge: 'wrong-challenge', verifier },
      { challengeMethod: 'S256', challenge, verifier: 'x'.repeat(43) },
    ]) {
      await expectDenied(compliant({
        client: { type: 'public', pkce } as never,
      }), 'pkce_s256_required');
    }
  });

  it(`${evidence} rejects missing, short, long, and non-unreserved public-client verifiers`, async () => {
    for (const invalidVerifier of [undefined, '', 'short', 'x'.repeat(129), 'x'.repeat(42) + ' ']) {
      await expect(enforceOAuth21Profile(ports(), compliant({
        client: {
          type: 'public',
          pkce: { challengeMethod: 'S256', challenge, verifier: invalidVerifier },
        } as never,
      }))).resolves.toMatchObject({ allowed: false, disposition: 'denied' });
    }
  });

  it(`${evidence} accepts 43 and 128 byte PKCE verifier boundaries and rejects Unicode`, async () => {
    for (const boundaryVerifier of ['x'.repeat(43), 'x'.repeat(128)]) {
      const boundaryChallenge = createHash('sha256').update(boundaryVerifier, 'ascii').digest('base64url');
      await expect(enforceOAuth21Profile(ports(), compliant({
        client: {
          type: 'public',
          pkce: { challengeMethod: 'S256', challenge: boundaryChallenge, verifier: boundaryVerifier },
        },
      }))).resolves.toMatchObject({ allowed: true });
    }
    const unicodeVerifier = `${'x'.repeat(42)}é`;
    const unicodeChallenge = createHash('sha256').update(unicodeVerifier).digest('base64url');
    await expectDenied(compliant({
      client: {
        type: 'public',
        pkce: { challengeMethod: 'S256', challenge: unicodeChallenge, verifier: unicodeVerifier },
      },
    }), 'pkce_s256_required');
  });

  it(`${evidence} permits confidential clients without PKCE while retaining all other bindings`, async () => {
    await expect(enforceOAuth21Profile(ports(), compliant({
      client: { type: 'confidential' },
    }))).resolves.toMatchObject({ allowed: true, disposition: 'enforced' });
  });

  it(`${evidence} accepts access-token TTL exactly at the fixed short-lived ceiling`, async () => {
    expect(OAUTH_ACCESS_TOKEN_TTL_CEILING_SECONDS).toBe(3_600);
    await expect(enforceOAuth21Profile(ports(), compliant({
      accessToken: {
        audience: resource,
        issuedAt: 10,
        expiresAt: 10 + OAUTH_ACCESS_TOKEN_TTL_CEILING_SECONDS,
      },
    }))).resolves.toMatchObject({ allowed: true });
  });

  it(`${evidence} rejects zero, negative, over-ceiling, fractional, and unsafe token lifetimes`, async () => {
    for (const [issuedAt, expiresAt] of [
      [10, 10],
      [11, 10],
      [10, 11 + OAUTH_ACCESS_TOKEN_TTL_CEILING_SECONDS],
      [10.5, 310],
      [10, Number.MAX_SAFE_INTEGER + 1],
      [-1, 10],
    ] as const) {
      await expect(enforceOAuth21Profile(ports(), compliant({
        accessToken: { audience: resource, issuedAt, expiresAt },
      }))).resolves.toMatchObject({ allowed: false, disposition: 'denied' });
    }
  });

  it(`${evidence} requires refresh rotation and a genuinely new refresh token`, async () => {
    for (const refreshToken of [
      { issued: true, rotation: 'none', previousToken: previousRefreshToken, currentToken: currentRefreshToken },
      { issued: true, rotation: 'rotate-on-use' },
      { issued: true, rotation: 'rotate-on-use', previousToken: previousRefreshToken, currentToken: previousRefreshToken },
      { issued: false, rotation: 'none', previousToken: previousRefreshToken },
    ]) {
      await expectDenied(
        compliant({ refreshToken: refreshToken as never }),
        'refresh_token_rotation_required',
      );
    }
  });

  it(`${evidence} accepts explicit absence of a refresh token`, async () => {
    await expect(enforceOAuth21Profile(ports(), compliant({
      refreshToken: { issued: false, rotation: 'none' },
    }))).resolves.toMatchObject({ allowed: true });
  });

  it(`${evidence} forbids passthrough, same-token forwarding, and token-source confusion`, async () => {
    for (const tokenFlow of [
      {
        upstream: { value: upstreamToken, source: 'authorization-header' },
        outbound: { value: upstreamToken, source: 'server-issued' },
      },
      {
        upstream: { value: upstreamToken, source: 'authorization-header' },
        outbound: { value: outboundToken, source: 'upstream' },
      },
      {
        upstream: { value: upstreamToken, source: 'authorization-header' },
        outbound: { value: upstreamToken, source: 'upstream' },
      },
      {
        upstream: { value: upstreamToken, source: 'token-exchange' },
        outbound: { value: outboundToken, source: 'token-exchange' },
      },
    ]) {
      await expect(enforceOAuth21Profile(ports(), compliant({ tokenFlow: tokenFlow as never })))
        .resolves.toMatchObject({ allowed: false, disposition: 'denied' });
    }
  });

  it(`${evidence} accepts a separately issued audience-bound outbound token`, async () => {
    for (const source of ['server-issued', 'token-exchange'] as const) {
      await expect(enforceOAuth21Profile(ports(), compliant({
        tokenFlow: {
          upstream: { value: upstreamToken, source: 'authorization-header' },
          outbound: { value: outboundToken, source },
        },
      }))).resolves.toMatchObject({ allowed: true });
    }
  });

  it(`${evidence} fails closed for accessor, Proxy, sparse, and dynamic input`, async () => {
    const accessor = Object.defineProperty({}, 'integration', {
      enumerable: true,
      get: vi.fn(() => 'remote-mcp'),
    });
    const proxied = new Proxy(compliant(), {});
    const sparseServers = new Array<string>(2);
    sparseServers[1] = authorizationServer;
    const dynamicAudience = Object.defineProperty([resource], '0', {
      get: vi.fn(() => resource),
    });

    for (const input of [
      accessor,
      proxied,
      compliant({
        protectedResourceMetadata: { resource, authorizationServers: sparseServers },
      }),
      compliant({ accessToken: { ...compliant().accessToken, audience: dynamicAudience } }),
    ]) {
      await expect(enforceOAuth21Profile(ports(), input as OAuth21ProfileInput)).resolves.toMatchObject({
        allowed: false,
        disposition: 'denied',
      });
    }
    expect(Object.getOwnPropertyDescriptor(accessor, 'integration')?.get).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyDescriptor(dynamicAudience, '0')?.get).not.toHaveBeenCalled();
  });

  it(`${evidence} denies unauthorized discovery and fails closed on hostile port results`, async () => {
    const throwing = (() => {
      throw new Error('provenance failure');
    }) as OAuth21ProfilePorts['authorizationServerProvenance']['isAuthorized'];
    const rejecting = vi.fn(async () => Promise.reject(new Error('provenance rejected')));
    const nonBoolean = (async () => 'yes') as unknown as
      OAuth21ProfilePorts['authorizationServerProvenance']['isAuthorized'];

    await expectDenied(compliant(), 'discovery_not_authorized', ports(vi.fn(async () => false)));
    for (const isAuthorized of [throwing, rejecting, nonBoolean]) {
      await expectDenied(compliant(), 'port_failure', ports(isAuthorized));
    }
  });

  it(`${evidence} preserves class, custom-prototype, and null-prototype port receivers`, async () => {
    class StatefulProvenance {
      calls = 0;
      readonly #authorized = true;

      async isAuthorized(): Promise<boolean> {
        this.calls += 1;
        return this.#authorized;
      }
    }
    const stateful = new StatefulProvenance();
    await expect(enforceOAuth21Profile(
      { authorizationServerProvenance: stateful },
      compliant(),
    )).resolves.toMatchObject({ allowed: true });
    expect(stateful.calls).toBe(1);

    const prototype = {
      async isAuthorized(this: { readonly authorized: boolean }): Promise<boolean> {
        return this.authorized;
      },
    };
    const custom = Object.assign(Object.create(prototype) as object, { authorized: true }) as unknown as
      OAuth21ProfilePorts['authorizationServerProvenance'];
    await expect(enforceOAuth21Profile(
      { authorizationServerProvenance: custom },
      compliant(),
    )).resolves.toMatchObject({ allowed: true });

    const nullPrototype = Object.assign(Object.create(null) as object, {
      isAuthorized: vi.fn(async () => true),
    }) as OAuth21ProfilePorts['authorizationServerProvenance'];
    await expect(enforceOAuth21Profile(
      { authorizationServerProvenance: nullPrototype },
      compliant(),
    )).resolves.toMatchObject({ allowed: true });
    expect(nullPrototype.isAuthorized).toHaveBeenCalledOnce();
  });

  it(`${evidence} rejects port accessors, Proxies, sync values, and non-native thenables`, async () => {
    const accessor = Object.defineProperty({}, 'isAuthorized', {
      get: vi.fn(() => vi.fn(async () => true)),
    }) as OAuth21ProfilePorts['authorizationServerProvenance'];
    const proxied = new Proxy({ isAuthorized: vi.fn(async () => true) }, {});
    const syncBoolean = vi.fn(() => true) as unknown as
      OAuth21ProfilePorts['authorizationServerProvenance']['isAuthorized'];
    const thenGetter = vi.fn(() => vi.fn());
    const thenable = vi.fn(() => Object.defineProperty({}, 'then', { get: thenGetter })) as unknown as
      OAuth21ProfilePorts['authorizationServerProvenance']['isAuthorized'];

    for (const authorizationServerProvenance of [
      accessor,
      proxied,
      { isAuthorized: syncBoolean },
      { isAuthorized: thenable },
    ]) {
      await expectDenied(
        compliant(),
        'port_failure',
        { authorizationServerProvenance },
      );
    }
    expect(Object.getOwnPropertyDescriptor(accessor, 'isAuthorized')?.get).not.toHaveBeenCalled();
    expect(thenGetter).not.toHaveBeenCalled();
  });

  it(`${evidence} never obtains a missing port method from Object.prototype`, async () => {
    const poisoned = vi.fn(async () => true);
    expect(Object.getOwnPropertyDescriptor(Object.prototype, 'isAuthorized')).toBeUndefined();
    Object.defineProperty(Object.prototype, 'isAuthorized', { configurable: true, value: poisoned });
    try {
      await expectDenied(compliant(), 'port_failure', {
        authorizationServerProvenance: {} as OAuth21ProfilePorts['authorizationServerProvenance'],
      });
      expect(poisoned).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(Object.prototype, 'isAuthorized');
    }
    expect(Object.getOwnPropertyDescriptor(Object.prototype, 'isAuthorized')).toBeUndefined();
  });

  it(`${evidence} accepts cross-realm native Promises and bypasses hostile subclass then overrides`, async () => {
    const crossRealm = vi.fn(() => runInNewContext('Promise.resolve(true)')) as
      OAuth21ProfilePorts['authorizationServerProvenance']['isAuthorized'];
    await expect(enforceOAuth21Profile(ports(crossRealm), compliant())).resolves.toMatchObject({ allowed: true });

    class HostileThenPromise extends Promise<boolean> {}
    const pending = new HostileThenPromise((resolve) => resolve(true));
    const hostileThen = vi.fn(() => { throw new Error('overridden then must not run'); });
    Object.defineProperty(pending, 'then', { value: hostileThen });
    let subclassCalls = 0;
    const nativeSubclass = (() => {
      subclassCalls += 1;
      return pending;
    }) as OAuth21ProfilePorts['authorizationServerProvenance']['isAuthorized'];
    await expect(enforceOAuth21Profile(ports(nativeSubclass), compliant())).resolves.toMatchObject({
      allowed: true,
    });
    expect(subclassCalls).toBe(1);
    expect(hostileThen).not.toHaveBeenCalled();
  });

  it(`${evidence} supplies one frozen token-free check and snapshots input and port before awaiting`, async () => {
    let settle: ((value: boolean) => void) | undefined;
    const pending = new Promise<boolean>((resolve) => { settle = resolve; });
    let captured: unknown;
    const original = vi.fn((check) => {
      captured = check;
      return pending;
    });
    const replacement = vi.fn(async () => false);
    const profilePorts = ports(original);
    const input = compliant();
    const decision = enforceOAuth21Profile(profilePorts, input);

    (input.protectedResourceMetadata.authorizationServers as string[])[0] = 'https://attacker.example.test';
    Object.assign(input.authorizationServerDiscovery, { issuer: 'https://attacker.example.test' });
    Object.assign(profilePorts.authorizationServerProvenance, { isAuthorized: replacement });
    settle?.(true);

    await expect(decision).resolves.toMatchObject({ allowed: true });
    expect(original).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
    expect(Object.isFrozen(captured)).toBe(true);
    expect(captured).toEqual({
      resource,
      authorizationServer,
      method: 'authorization-server-metadata',
      discoveryUrl: `${authorizationServer}/.well-known/oauth-authorization-server`,
      issuer: authorizationServer,
      authorizationEndpoint: `${authorizationServer}/authorize`,
      tokenEndpoint: `${authorizationServer}/token`,
    });
    expect(JSON.stringify(captured)).not.toContain(upstreamToken);
    expect(JSON.stringify(captured)).not.toContain(previousRefreshToken);
  });

  it(`${evidence} never echoes access or refresh tokens through decisions and errors`, async () => {
    for (const secret of [upstreamToken, outboundToken, previousRefreshToken, currentRefreshToken]) {
      let decision: unknown;
      let thrown: unknown;
      try {
        decision = await enforceOAuth21Profile(ports(), compliant({
          transport: {
            requestTarget: `/mcp?access_token=${encodeURIComponent(secret)}`,
            authorization: `Bearer ${upstreamToken}`,
          },
        }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeUndefined();
      expect(`${String(decision)}\n${JSON.stringify(decision)}\n${String(thrown)}`).not.toContain(secret);
    }
  });
});
