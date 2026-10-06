/**
 * COLP-MCP-10 SEC-0019 OAuth client security contracts.
 *
 * Tests are written first against the security/client adapter module
 * `src/security/mcp-oauth-client.ts` (produced by COLP-MCP-10). Covers:
 * RFC 9207 authorization-response `iss` (missing / swap / mix-up), RFC 8414
 * authorization-server metadata validation, RFC 7591 DCR `application_type`
 * (web/native), exact issuer identity and credential/refresh
 * isolation, refresh-token rotation, redirect-URI and PKCE S256 checks, and
 * secret storage/logging discipline (no token/secret values in decisions or
 * log output).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  OAUTH_SECRET_REDACTION,
  buildOAuthDcrClientMetadata,
  canonicalOAuthIssuer,
  classifyOAuthClientApplicability,
  enforceOAuthAuthorizationResponseIss,
  enforceOAuthAuthorizationServerMetadata,
  enforceOAuthCredentialIssuerIsolation,
  enforceOAuthDcrApplicationType,
  enforceOAuthPkce,
  enforceOAuthRedirectUri,
  enforceOAuthTokenExchangeIssuer,
  formatOAuthLogContext,
  oauthCredentialStoreKey,
  redactOAuthCredential,
  resolveOAuthApplicationType,
  rotateOAuthRefreshToken,
  selectOAuthClientCredentialForIssuer,
  selectOAuthRefreshStateForIssuer,
  type OAuthIssuerKeyedClientCredential,
  type OAuthIssuerKeyedRefreshState,
  type OAuthLogSafeContext,
  type OAuthPkceInput,
} from '../../src/security/index.js';

const evidence = '[evidence:mcp.oauth-issuer-binding]';
const issuerA = 'https://auth.example.test';
const issuerAAlias = 'https://auth.example.test/';
const issuerB = 'https://other-issuer.example.test';
const clientId = 'colp-client-app-1';
const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
const challenge = createHash('sha256').update(verifier).digest('base64url');
const currentRefreshToken = 'current-refresh-token-Cc7';
const nextRefreshToken = 'next-refresh-token-Dd6';
const presentedAccessToken = 'access-token-secret-Aa9';
const clientSecret = 'client-secret-Ee5';

function validIssInput(overrides: Partial<{
  expectedIssuer: string;
  iss: string | undefined;
  issParameterSupported: boolean;
}> = {}) {
  return {
    expectedIssuer: issuerA,
    iss: issuerA,
    issParameterSupported: true,
    ...overrides,
  };
}

function validMetadata(overrides: Record<string, unknown> = {}) {
  return {
    issuer: issuerA,
    authorization_endpoint: `${issuerA}/authorize`,
    token_endpoint: `${issuerA}/token`,
    registration_endpoint: `${issuerA}/register`,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    grant_types_supported: ['authorization_code', 'refresh_token'],
    ...overrides,
  };
}

function validPkce(overrides: Partial<OAuthPkceInput> = {}): OAuthPkceInput {
  return { verifier, challenge, challengeMethod: 'S256', ...overrides };
}

function credential(overrides: Partial<OAuthIssuerKeyedClientCredential> = {}): OAuthIssuerKeyedClientCredential {
  return {
    issuer: issuerA,
    clientId,
    clientSecret,
    credentialBindingId: 'credential-binding-oauth-1',
    ...overrides,
  };
}

function refreshState(overrides: Partial<OAuthIssuerKeyedRefreshState> = {}): OAuthIssuerKeyedRefreshState {
  return { issuer: issuerA, currentRefreshToken, ...overrides };
}

function expectDenied(decision: unknown, reason: string): void {
  expect(decision).toMatchObject({ allowed: false, reason });
}

describe(`${evidence} SEC-0019 MCP OAuth client security (COLP-MCP-10)`, () => {
  describe(`${evidence} exact issuer identity`, () => {
    it(`${evidence} preserves issuer spelling instead of merging URL aliases`, () => {
      const issuers = [issuerA, issuerAAlias, 'https://auth.example.test:443/',
        'HTTPS://AUTH.EXAMPLE.TEST', 'https://auth.example.test/issuer1/',
        'https://auth.example.test/issuer1'];
      expect(issuers.map(canonicalOAuthIssuer)).toEqual(issuers);
      expect(new Set(issuers.map(oauthCredentialStoreKey)).size).toBe(issuers.length);
    });

    it(`${evidence} keeps distinct origins and paths distinct`, () => {
      expect(canonicalOAuthIssuer(issuerA)).not.toBe(canonicalOAuthIssuer(issuerB));
      expect(canonicalOAuthIssuer('https://auth.example.test/issuer1')).not.toBe(
        canonicalOAuthIssuer('https://auth.example.test/issuer2'),
      );
    });

    it(`${evidence} rejects non-URL, non-http(s), query or fragment issuers`, () => {
      for (const bad of [
        '',
        'not-a-url',
        'ftp://auth.example.test',
        'https://auth.example.test/path?query=1',
        'https://auth.example.test/path#fragment',
      ]) {
        expect(() => canonicalOAuthIssuer(bad)).toThrow(TypeError);
      }
    });

    it(`${evidence} uses the exact issuer as the credential store key`, () => {
      expect(oauthCredentialStoreKey(issuerAAlias)).not.toBe(oauthCredentialStoreKey(issuerA));
      expect(oauthCredentialStoreKey(issuerA)).toBe(issuerA);
    });
  });

  describe(`${evidence} RFC 9207 authorization response iss`, () => {
    it(`${evidence} accepts an exact issuer echo`, () => {
      expect(enforceOAuthAuthorizationResponseIss(validIssInput())).toEqual({
        allowed: true,
        reason: 'issuer_matches',
        matchedIssuer: issuerA,
      });
    });

    it(`${evidence} rejects a differently spelled issuer echo`, () => {
      expectDenied(enforceOAuthAuthorizationResponseIss(validIssInput({ iss: issuerAAlias })), 'issuer_swap');
    });

    it(`${evidence} rejects a missing iss when the metadata requires it`, () => {
      expectDenied(
        enforceOAuthAuthorizationResponseIss(validIssInput({ iss: undefined })),
        'issuer_missing',
      );
    });

    it(`${evidence} tolerates a missing iss when the metadata does not advertise support`, () => {
      expect(
        enforceOAuthAuthorizationResponseIss(validIssInput({ iss: undefined, issParameterSupported: false })),
      ).toMatchObject({ allowed: true, reason: 'issuer_matches' });
    });

    it(`${evidence} rejects an iss swap (different issuer string)`, () => {
      expectDenied(
        enforceOAuthAuthorizationResponseIss(validIssInput({ iss: issuerB })),
        'issuer_swap',
      );
    });

    it(`${evidence} rejects an invalid input snapshot`, () => {
      expectDenied(enforceOAuthAuthorizationResponseIss(undefined), 'invalid_input');
      expectDenied(enforceOAuthAuthorizationResponseIss({ expectedIssuer: '', iss: issuerA }), 'invalid_input');
    });
  });

  describe(`${evidence} authorization-server mix-up defense at token exchange`, () => {
    it(`${evidence} accepts when the exchange issuer equals the recorded issuer`, () => {
      expect(enforceOAuthTokenExchangeIssuer({ recordedIssuer: issuerA, exchangeIssuer: issuerA })).toEqual({
        allowed: true,
        reason: 'issuer_bound',
        issuer: issuerA,
      });
    });

    it(`${evidence} rejects a mix-up where the exchange issuer differs from the recorded issuer`, () => {
      expectDenied(
        enforceOAuthTokenExchangeIssuer({ recordedIssuer: issuerA, exchangeIssuer: issuerB }),
        'issuer_mixup',
      );
    });

    it(`${evidence} rejects malformed exchange-issuer input`, () => {
      expectDenied(enforceOAuthTokenExchangeIssuer({ recordedIssuer: issuerA, exchangeIssuer: '' }), 'invalid_input');
    });
  });

  describe(`${evidence} RFC 8414 authorization server metadata`, () => {
    it(`${evidence} accepts a complete remote metadata document`, () => {
      const decision = enforceOAuthAuthorizationServerMetadata(validMetadata(), { expectedIssuer: issuerA });
      expect(decision).toMatchObject({ allowed: true, reason: 'metadata_valid' });
      if (decision.allowed) {
        expect(decision.metadata).toEqual({
          issuer: issuerA,
          authorizationEndpoint: `${issuerA}/authorize`,
          tokenEndpoint: `${issuerA}/token`,
          registrationEndpoint: `${issuerA}/register`,
          codeChallengeMethodsSupported: ['S256'],
          authorizationResponseIssParameterSupported: true,
          grantTypesSupported: ['authorization_code', 'refresh_token'],
        });
      }
    });

    it(`${evidence} rejects a missing or insecure issuer`, () => {
      expect(enforceOAuthAuthorizationServerMetadata(validMetadata({ issuer: undefined }))).toMatchObject({
        allowed: false,
        reason: 'invalid_issuer',
      });
      expect(enforceOAuthAuthorizationServerMetadata(validMetadata({ issuer: 'http://insecure.example.test' }))).toMatchObject({
        allowed: false,
        reason: 'insecure_issuer',
      });
      expect(enforceOAuthAuthorizationServerMetadata(validMetadata({ issuer: `${issuerA}/issuer?x=1` }))).toMatchObject({
        allowed: false,
        reason: 'issuer_has_query_or_fragment',
      });
    });

    it(`${evidence} rejects missing or insecure endpoints`, () => {
      expect(enforceOAuthAuthorizationServerMetadata(validMetadata({ authorization_endpoint: undefined }))).toMatchObject({
        allowed: false,
        reason: 'missing_authorization_endpoint',
      });
      expect(enforceOAuthAuthorizationServerMetadata(validMetadata({ token_endpoint: undefined }))).toMatchObject({
        allowed: false,
        reason: 'missing_token_endpoint',
      });
      expect(enforceOAuthAuthorizationServerMetadata(validMetadata({ authorization_endpoint: 'http://x.test/a' }))).toMatchObject({
        allowed: false,
        reason: 'insecure_authorization_endpoint',
      });
      expect(enforceOAuthAuthorizationServerMetadata(validMetadata({ token_endpoint: 'http://x.test/t' }))).toMatchObject({
        allowed: false,
        reason: 'insecure_token_endpoint',
      });
    });

    it(`${evidence} requires registration endpoint when DCR is required and rejects invalid ones`, () => {
      expect(
        enforceOAuthAuthorizationServerMetadata(validMetadata({ registration_endpoint: undefined }), {
          requireDcr: true,
        }),
      ).toMatchObject({ allowed: false, reason: 'missing_registration_endpoint' });
      expect(
        enforceOAuthAuthorizationServerMetadata(validMetadata({ registration_endpoint: 'not-a-url' })),
      ).toMatchObject({ allowed: false, reason: 'invalid_registration_endpoint' });
    });

    it(`${evidence} requires PKCE S256 support and rejects malformed code challenge methods`, () => {
      expect(
        enforceOAuthAuthorizationServerMetadata(validMetadata({ code_challenge_methods_supported: ['plain'] })),
      ).toMatchObject({ allowed: false, reason: 'pkce_s256_not_supported' });
      expect(
        enforceOAuthAuthorizationServerMetadata(validMetadata({ code_challenge_methods_supported: 'S256' })),
      ).toMatchObject({ allowed: false, reason: 'code_challenge_methods_invalid' });
    });

    it(`${evidence} rejects non-plain metadata but accepts extensible own-data fields`, () => {
      expect(enforceOAuthAuthorizationServerMetadata(null)).toMatchObject({ allowed: false, reason: 'invalid_input' });
      expect(enforceOAuthAuthorizationServerMetadata({ ...validMetadata(), extra: 1 }, { expectedIssuer: issuerA })).toMatchObject({
        allowed: true,
        reason: 'metadata_valid',
      });
    });
  });

  describe(`${evidence} RFC 7591 DCR application_type`, () => {
    it(`${evidence} derives native from loopback and custom-scheme redirect URIs`, () => {
      expect(resolveOAuthApplicationType(['https://app.example.test/callback'])).toBe('web');
      expect(resolveOAuthApplicationType(['http://127.0.0.1:6123/callback'])).toBe('native');
      expect(resolveOAuthApplicationType(['http://localhost:6123/callback'])).toBe('native');
      expect(resolveOAuthApplicationType(['com.example.app:/oauth/callback'])).toBe('native');
    });

    it(`${evidence} honours an explicit deployment type over derivation`, () => {
      expect(resolveOAuthApplicationType(['http://127.0.0.1:6123/callback'], 'web')).toBe('web');
      expect(resolveOAuthApplicationType(['https://app.example.test/callback'], 'native')).toBe('native');
    });

    it(`${evidence} builds a DCR metadata body with a declared application_type`, () => {
      const metadata = buildOAuthDcrClientMetadata({ redirectUris: ['https://app.example.test/callback'] });
      expect(metadata.application_type).toBe('web');
      expect(metadata.redirect_uris.map((uri) => uri.toString())).toEqual(['https://app.example.test/callback']);
      expect(metadata.grant_types).toEqual(['authorization_code', 'refresh_token']);
      expect(metadata.response_types).toEqual(['code']);
      expect(metadata.token_endpoint_auth_method).toBe('none');
    });

    it(`${evidence} builds a native DCR body for loopback redirects`, () => {
      const metadata = buildOAuthDcrClientMetadata({
        redirectUris: ['http://127.0.0.1:6123/callback'],
        clientName: 'COLP native read client',
      });
      expect(metadata.application_type).toBe('native');
      expect(metadata.client_name).toBe('COLP native read client');
    });

    it(`${evidence} rejects DCR bodies that omit or contradict application_type`, () => {
      expect(enforceOAuthDcrApplicationType({}, 'web')).toMatchObject({
        allowed: false,
        reason: 'missing_application_type',
      });
      expect(enforceOAuthDcrApplicationType({ application_type: 'native' }, 'web')).toMatchObject({
        allowed: false,
        reason: 'application_type_mismatch',
      });
      expect(enforceOAuthDcrApplicationType({ application_type: 'web' }, 'web')).toMatchObject({
        allowed: true,
        reason: 'application_type_matches',
      });
    });
  });

  describe(`${evidence} issuer-keyed credential isolation`, () => {
    it(`${evidence} selects the credential whose exact issuer matches`, () => {
      const credentials = [credential(), credential({ issuer: issuerB, clientId: 'client-b' })];
      expect(selectOAuthClientCredentialForIssuer(credentials, issuerA)?.clientId).toBe(clientId);
      expect(selectOAuthClientCredentialForIssuer(credentials, issuerAAlias)).toBeUndefined();
      expect(selectOAuthClientCredentialForIssuer(credentials, issuerB)?.clientId).toBe('client-b');
    });

    it(`${evidence} returns undefined when no credential is registered for the issuer`, () => {
      expect(selectOAuthClientCredentialForIssuer([credential()], issuerB)).toBeUndefined();
    });

    it(`${evidence} accepts a credential bound to the same exact issuer`, () => {
      expect(enforceOAuthCredentialIssuerIsolation(credential(), issuerA)).toMatchObject({
        allowed: true,
        reason: 'credential_issuer_matches',
        credentialBindingId: 'credential-binding-oauth-1',
      });
    });

    it(`${evidence} rejects reusing a credential across issuers (re-registration required)`, () => {
      expect(enforceOAuthCredentialIssuerIsolation(credential(), issuerB)).toMatchObject({
        allowed: false,
        reason: 'credential_issuer_mismatch',
      });
    });

    it(`${evidence} rejects credentials with a missing issuer`, () => {
      expect(enforceOAuthCredentialIssuerIsolation(credential({ issuer: '' }), issuerA)).toMatchObject({
        allowed: false,
        reason: 'credential_issuer_missing',
      });
    });
  });

  describe(`${evidence} refresh-token rotation and issuer-bound refresh state`, () => {
    it(`${evidence} selects refresh state only under the matching exact issuer`, () => {
      const states = [refreshState(), refreshState({ issuer: issuerB, currentRefreshToken: 'b-token' })];
      expect(selectOAuthRefreshStateForIssuer(states, issuerA)?.currentRefreshToken).toBe(currentRefreshToken);
      expect(selectOAuthRefreshStateForIssuer(states, issuerAAlias)).toBeUndefined();
      expect(selectOAuthRefreshStateForIssuer(states, issuerB)?.currentRefreshToken).toBe('b-token');
      expect(selectOAuthRefreshStateForIssuer([refreshState()], issuerB)).toBeUndefined();
    });

    it(`${evidence} rotates to the next token and records the new current token`, () => {
      const decision = rotateOAuthRefreshToken(refreshState(), currentRefreshToken, nextRefreshToken, issuerA);
      expect(decision).toMatchObject({
        allowed: true,
        reason: 'rotated',
        nextState: { issuer: issuerA, currentRefreshToken: nextRefreshToken },
      });
    });

    it(`${evidence} rejects reuse of an already-rotated (old) refresh token`, () => {
      expectDenied(
        rotateOAuthRefreshToken(refreshState(), 'revoked-old-token', nextRefreshToken, issuerA),
        'refresh_token_reuse',
      );
    });

    it(`${evidence} rejects a refresh that does not rotate the token`, () => {
      expectDenied(
        rotateOAuthRefreshToken(refreshState(), currentRefreshToken, currentRefreshToken, issuerA),
        'refresh_token_not_rotated',
      );
    });

    it(`${evidence} rejects refreshing against a different issuer than the state`, () => {
      expectDenied(
        rotateOAuthRefreshToken(refreshState(), currentRefreshToken, nextRefreshToken, issuerB),
        'refresh_issuer_mismatch',
      );
    });

    it(`${evidence} rejects missing or malformed rotation input`, () => {
      expectDenied(rotateOAuthRefreshToken(refreshState(), '', nextRefreshToken, issuerA), 'refresh_token_missing');
      expectDenied(rotateOAuthRefreshToken(undefined, currentRefreshToken, nextRefreshToken, issuerA), 'invalid_input');
    });
  });

  describe(`${evidence} redirect URI and PKCE S256`, () => {
    it(`${evidence} accepts an exact registered redirect URI`, () => {
      expect(enforceOAuthRedirectUri(['https://app.example.test/callback'], 'https://app.example.test/callback')).toMatchObject({
        allowed: true,
        reason: 'redirect_uri_matches',
      });
    });

    it(`${evidence} rejects an unregistered or empty redirect URI`, () => {
      expect(enforceOAuthRedirectUri(['https://app.example.test/callback'], 'https://evil.example.test/callback')).toMatchObject({
        allowed: false,
        reason: 'redirect_uri_mismatch',
      });
      expect(enforceOAuthRedirectUri(['https://app.example.test/callback'], '')).toMatchObject({
        allowed: false,
        reason: 'redirect_uri_missing',
      });
    });

    it(`${evidence} accepts a valid PKCE S256 verifier/challenge pair`, () => {
      expect(enforceOAuthPkce(validPkce())).toMatchObject({ allowed: true, reason: 'pkce_s256_matches' });
    });

    it(`${evidence} rejects plain or missing PKCE challenge methods`, () => {
      expect(enforceOAuthPkce(validPkce({ challengeMethod: 'plain' }))).toMatchObject({
        allowed: false,
        reason: 'pkce_challenge_method_not_s256',
      });
      expect(enforceOAuthPkce(validPkce({ challengeMethod: '' }))).toMatchObject({
        allowed: false,
        reason: 'pkce_challenge_method_not_s256',
      });
    });

    it(`${evidence} rejects invalid verifier lengths and characters`, () => {
      expect(enforceOAuthPkce(validPkce({ verifier: 'short' }))).toMatchObject({
        allowed: false,
        reason: 'pkce_verifier_invalid',
      });
      expect(enforceOAuthPkce(validPkce({ verifier: `${'a'.repeat(43)}!` }))).toMatchObject({
        allowed: false,
        reason: 'pkce_verifier_invalid',
      });
    });

    it(`${evidence} rejects a challenge that does not match the verifier`, () => {
      expect(enforceOAuthPkce(validPkce({ challenge: createHash('sha256').update('other').digest('base64url') }))).toMatchObject({
        allowed: false,
        reason: 'pkce_challenge_mismatch',
      });
    });
  });

  describe(`${evidence} secret storage and logging discipline`, () => {
    it(`${evidence} redacts any credential value to a stable marker`, () => {
      expect(redactOAuthCredential(presentedAccessToken)).toBe(OAUTH_SECRET_REDACTION);
      expect(redactOAuthCredential(clientSecret)).toBe(OAUTH_SECRET_REDACTION);
      expect(OAUTH_SECRET_REDACTION).not.toContain('token');
      expect(OAUTH_SECRET_REDACTION).not.toContain(clientSecret);
    });

    it(`${evidence} formats log context from stable identifiers only`, () => {
      const context: OAuthLogSafeContext = {
        issuer: issuerA,
        clientId,
        operation: 'token-exchange',
        outcome: 'denied',
        reason: 'issuer_swap',
      };
      const line = formatOAuthLogContext(context);
      expect(line).toContain(canonicalOAuthIssuer(issuerA));
      expect(line).toContain(clientId);
      expect(line).toContain('token-exchange');
      expect(line).toContain('issuer_swap');
      expect(line).not.toContain(presentedAccessToken);
      expect(line).not.toContain(clientSecret);
    });

    it(`${evidence} never embeds free-form secret material in the reason slot`, () => {
      const line = formatOAuthLogContext({
        issuer: issuerA,
        clientId,
        operation: 'token-exchange',
        outcome: 'denied',
        reason: `Bearer ${presentedAccessToken}`,
      });
      expect(line).not.toContain(presentedAccessToken);
      expect(line).not.toContain('Bearer');
    });

    it(`${evidence} keeps decision objects free of token and secret values`, () => {
      const decisions = [
        enforceOAuthAuthorizationResponseIss(validIssInput({ iss: issuerB })),
        enforceOAuthPkce(validPkce()),
        enforceOAuthAuthorizationServerMetadata(validMetadata(), { expectedIssuer: issuerA }),
        enforceOAuthDcrApplicationType({ application_type: 'native' }, 'web'),
      ];
      const serialized = JSON.stringify(decisions);
      expect(serialized).not.toContain(presentedAccessToken);
      expect(serialized).not.toContain(clientSecret);
      expect(serialized).not.toContain(currentRefreshToken);
    });
  });

  describe(`${evidence} OAuth applicability by host kind`, () => {
    it(`${evidence} marks remote MCP as OAuth-applicable`, () => {
      expect(classifyOAuthClientApplicability('remote-mcp')).toEqual({
        allowed: true,
        disposition: 'applicable',
        hostKind: 'remote-mcp',
        reason: 'oauth_applicable',
      });
    });

    it(`${evidence} marks stdio and API Key hosts as not-applicable (non-OAuth path)`, () => {
      expect(classifyOAuthClientApplicability('stdio')).toMatchObject({
        allowed: true,
        disposition: 'not-applicable',
        hostKind: 'stdio',
        reason: 'stdio_local_credentials',
      });
      expect(classifyOAuthClientApplicability('api-key')).toMatchObject({
        allowed: true,
        disposition: 'not-applicable',
        hostKind: 'api-key',
        reason: 'api_key_credentials',
      });
      expect(classifyOAuthClientApplicability('local-mcp')).toMatchObject({
        allowed: true,
        disposition: 'not-applicable',
        hostKind: 'local-mcp',
        reason: 'local_mcp_credentials',
      });
    });
  });

  describe(`${evidence} production boundary discipline`, () => {
    it(`${evidence} never imports the OAuth client package from production security code`, async () => {
      const source = await readFile(
        resolve(import.meta.dirname, '..', '..', 'src', 'security', 'mcp-oauth-client.ts'),
        'utf8',
      );
      expect(source).not.toMatch(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]@modelcontextprotocol\/client['"]/u);
      expect(source).not.toMatch(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]@modelcontextprotocol\/server['"]/u);
      expect(source).toContain('sdk-boundary');
    });
  });
});
