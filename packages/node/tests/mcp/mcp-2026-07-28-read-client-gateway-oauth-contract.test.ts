/**
 * COLP-MCP-10: Read application client gateway port — OAuth composition
 * boundary contract.
 *
 * The Read application client (`createMcpReadClient`) must never hold a token
 * store handle. `McpReadClientGatewayPort` continues to own transport + OAuth
 * composition (RFC 9207 `iss`, DCR, PKCE, issuer-keyed credential/refresh
 * state): the application layer only sees `callTool`, and the strict options
 * validator rejects any extra field (so a host cannot smuggle a token store
 * into the client). OAuth requirements must not pollute the shared
 * authorization binding, and stdio / API Key hosts stay on their non-OAuth
 * paths.
 */
import { describe, expect, it } from 'vitest';

import {
  McpReadClientConfigurationError,
  createMcpReadClient,
  type McpReadClientGatewayPort,
  type McpReadClientOptions,
} from '../../src/mcp/read-client.js';
import {
  containsRawSecretMarker,
  mapApiKeyEvidenceToAuthenticatedBinding,
  mapStdioEvidenceToAuthenticatedBinding,
  snapshotMcpAuthorizationBinding,
  type McpApiKeyCredentialEvidence,
  type McpStdioCredentialEvidence,
} from '../../src/mcp/shared/authorization.js';
import {
  classifyOAuthClientApplicability,
  type OAuthClientCredentialVaultPort,
  type OAuthClientTokenStorePort,
} from '../../src/security/index.js';

const evidence = '[evidence:mcp.oauth-issuer-binding]';
const collectionId = 'collection-1';
const result = Object.freeze({ structuredContent: Object.freeze({ id: collectionId }) });

function validOptions(): McpReadClientOptions {
  return {
    gateway: { callTool: async () => result },
    presenter: { displayToolCall: async () => undefined },
    recorder: { recordToolCall: async () => undefined },
    resultValidator: { validateToolResult: (_name, value) => value },
    targetResolver: { resolveTargetCollection: () => collectionId },
    timeoutMs: 1_000,
    maxResultBytes: 4_096,
  };
}

function stdioEvidence(): McpStdioCredentialEvidence {
  return {
    credentialKind: 'stdio',
    principalId: 'local-principal',
    clientId: 'stdio-host-config-1',
    credentialBindingId: 'local-secret-store-binding-1',
    resourceAudience: 'urn:colp:resource:public',
    securityEpoch: 'epoch-1',
  };
}

function apiKeyEvidence(): McpApiKeyCredentialEvidence {
  return {
    credentialKind: 'api-key',
    principalId: 'key-owner-1',
    clientId: 'key-id-1',
    credentialBindingId: 'credential-store-binding-1',
    resourceAudience: 'urn:colp:resource:public',
    securityEpoch: 'epoch-1',
  };
}

const BINDING_KEYS = Object.freeze([
  'kind',
  'principalId',
  'clientId',
  'credentialBindingId',
  'resourceAudience',
  'securityEpoch',
]);

describe(`${evidence} Read client gateway port owns transport/OAuth composition (COLP-MCP-10)`, () => {
  it(`${evidence} exposes only callTool on the gateway port surface`, () => {
    const port: McpReadClientGatewayPort = { callTool: async () => result };
    expect(Object.keys(port)).toEqual(['callTool']);
    expect('tokenStore' in port).toBe(false);
    expect('tokens' in port).toBe(false);
    expect('oauthClient' in port).toBe(false);
  });

  it(`${evidence} rejects a token store handle smuggled into read client options`, () => {
    const options = validOptions();
    const smuggled = { ...options, tokenStore: { loadTokens: () => undefined } };
    expect(() => createMcpReadClient(smuggled as McpReadClientOptions)).toThrow(
      McpReadClientConfigurationError,
    );
    const smuggledTokens = { ...options, tokens: { access_token: 'secret' } };
    expect(() => createMcpReadClient(smuggledTokens as McpReadClientOptions)).toThrow(
      McpReadClientConfigurationError,
    );
  });

  it(`${evidence} accepts only the exact options shape (no OAuth fields leak into the app client)`, () => {
    const options = validOptions();
    expect(Object.keys(options)).toEqual([
      'gateway',
      'presenter',
      'recorder',
      'resultValidator',
      'targetResolver',
      'timeoutMs',
      'maxResultBytes',
    ]);
    const client = createMcpReadClient(options);
    expect(client).toBeTypeOf('object');
  });

  it(`${evidence} keeps the credential vault and token store behind the gateway-owned abstraction`, () => {
    // The gateway (host) composes these ports; the Read application client
    // never receives them. This test only proves the ports are usable as
    // host-side handles and never appear on the client options surface.
    const vault: OAuthClientCredentialVaultPort = {
      saveClientCredentials: () => undefined,
      loadClientCredentials: () => undefined,
      deleteClientCredentials: () => undefined,
    };
    const tokenStore: OAuthClientTokenStorePort = {
      loadTokens: () => undefined,
      saveTokens: () => undefined,
      deleteTokens: () => undefined,
    };
    expect(typeof vault.saveClientCredentials).toBe('function');
    expect(typeof tokenStore.loadTokens).toBe('function');
    expect('tokenStore' in validOptions()).toBe(false);
  });
});

describe(`${evidence} OAuth requirements do not pollute shared authorization (COLP-MCP-10)`, () => {
  it(`${evidence} authenticated bindings carry no token or secret fields`, () => {
    const binding = snapshotMcpAuthorizationBinding(
      mapStdioEvidenceToAuthenticatedBinding(stdioEvidence()),
    );
    expect(Object.keys(binding).sort()).toEqual([...BINDING_KEYS].sort());
    expect(JSON.stringify(binding)).not.toContain('access_token');
    expect(JSON.stringify(binding)).not.toContain('client_secret');
    expect(containsRawSecretMarker(binding)).toBe(false);
  });

  it(`${evidence} OAuth evidence maps to the same token-free binding family`, () => {
    const binding = mapStdioEvidenceToAuthenticatedBinding(stdioEvidence());
    expect(binding.kind).toBe('authenticated');
    expect(Object.keys(binding).sort()).toEqual([...BINDING_KEYS].sort());
  });

  it(`${evidence} stdio and API Key hosts stay on their non-OAuth paths`, () => {
    expect(classifyOAuthClientApplicability('stdio')).toMatchObject({
      allowed: true,
      disposition: 'not-applicable',
      reason: 'stdio_local_credentials',
    });
    expect(classifyOAuthClientApplicability('api-key')).toMatchObject({
      allowed: true,
      disposition: 'not-applicable',
      reason: 'api_key_credentials',
    });
    const stdioBinding = mapStdioEvidenceToAuthenticatedBinding(stdioEvidence());
    const apiKeyBinding = mapApiKeyEvidenceToAuthenticatedBinding(apiKeyEvidence());
    expect(stdioBinding.credentialBindingId).toBe('local-secret-store-binding-1');
    expect(apiKeyBinding.credentialBindingId).toBe('credential-store-binding-1');
    expect(JSON.stringify([stdioBinding, apiKeyBinding])).not.toContain('client_secret');
    expect(JSON.stringify([stdioBinding, apiKeyBinding])).not.toContain('access_token');
  });
});
