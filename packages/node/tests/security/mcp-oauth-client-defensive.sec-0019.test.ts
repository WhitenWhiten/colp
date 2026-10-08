/**
 * COLP-MCP-10 SEC-0019 OAuth client security — defensive validation paths.
 *
 * Companion to `mcp-oauth-client.sec-0019.test.ts`: exercises the fail-closed
 * guards of `src/security/mcp-oauth-client.ts` (malformed inputs, scriptable
 * redirect schemes, unsupported host kinds, non-whitelisted log reasons) so
 * the security domain coverage gate keeps the new module above the enforced
 * floors. All assertions are negative-path (denied / thrown) — no tautologies.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import {
  buildOAuthDcrClientMetadata,
  classifyOAuthClientApplicability,
  enforceOAuthAuthorizationResponseIss,
  enforceOAuthAuthorizationServerMetadata,
  enforceOAuthCredentialIssuerIsolation,
  enforceOAuthDcrApplicationType,
  enforceOAuthPkce,
  enforceOAuthRedirectUri,
  enforceOAuthTokenExchangeIssuer,
  formatOAuthLogContext,
  redactOAuthCredential,
  resolveOAuthApplicationType,
  rotateOAuthRefreshToken,
  type OAuthClientHostKind,
  type OAuthIssuerKeyedClientCredential,
  type OAuthIssuerKeyedRefreshState,
  type OAuthLogOperation,
  type OAuthPkceInput,
} from '../../src/security/index.js';

const evidence = '[evidence:mcp.oauth-issuer-binding]';
const issuerA = 'https://auth.example.test';
const clientId = 'colp-client-app-1';
const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
const currentRefreshToken = 'current-refresh-token-Cc7';
const nextRefreshToken = 'next-refresh-token-Dd6';

function validIssInput(overrides: Record<string, unknown> = {}) {
  return { expectedIssuer: issuerA, iss: issuerA, issParameterSupported: true, ...overrides };
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

function validPkce(overrides: Record<string, unknown> = {}): OAuthPkceInput {
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    challengeMethod: 'S256',
    ...overrides,
  } as OAuthPkceInput;
}

function credential(overrides: Record<string, unknown> = {}): OAuthIssuerKeyedClientCredential {
  return {
    issuer: issuerA,
    clientId,
    clientSecret: 'client-secret-Ee5',
    credentialBindingId: 'credential-binding-oauth-1',
    ...overrides,
  } as OAuthIssuerKeyedClientCredential;
}

function refreshState(overrides: Record<string, unknown> = {}): OAuthIssuerKeyedRefreshState {
  return { issuer: issuerA, currentRefreshToken, ...overrides } as OAuthIssuerKeyedRefreshState;
}

function expectDenied(decision: unknown, reason: string): void {
  expect(decision).toMatchObject({ allowed: false, reason });
}

describe(`${evidence} SEC-0019 MCP OAuth client security defensive paths (COLP-MCP-10)`, () => {
  it(`${evidence} marks service, other and unknown hosts as not-applicable`, () => {
    expect(classifyOAuthClientApplicability('service')).toMatchObject({
      allowed: true,
      disposition: 'not-applicable',
      hostKind: 'service',
      reason: 'service_credentials',
    });
    expect(classifyOAuthClientApplicability('other')).toMatchObject({
      allowed: true,
      disposition: 'not-applicable',
      hostKind: 'other',
      reason: 'unsupported_host',
    });
    expect(classifyOAuthClientApplicability('bogus' as OAuthClientHostKind)).toMatchObject({
      allowed: true,
      disposition: 'not-applicable',
      hostKind: 'other',
      reason: 'unsupported_host',
    });
  });

  it(`${evidence} rejects malformed iss inputs at every snapshot guard`, () => {
    expectDenied(
      enforceOAuthAuthorizationResponseIss({ expectedIssuer: '', iss: issuerA, issParameterSupported: true }),
      'invalid_input',
    );
    expectDenied(
      enforceOAuthAuthorizationResponseIss({ expectedIssuer: 'not-a-url', iss: issuerA, issParameterSupported: true }),
      'invalid_input',
    );
    expectDenied(
      enforceOAuthAuthorizationResponseIss({ expectedIssuer: issuerA, iss: 42, issParameterSupported: true }),
      'invalid_input',
    );
    expectDenied(
      enforceOAuthAuthorizationResponseIss({ expectedIssuer: issuerA, iss: issuerA, issParameterSupported: 'yes' }),
      'invalid_input',
    );
  });

  it(`${evidence} rejects an unparseable iss value as a swap`, () => {
    expectDenied(enforceOAuthAuthorizationResponseIss(validIssInput({ iss: 'not-a-url' })), 'issuer_swap');
  });

  it(`${evidence} rejects non-string or unparseable token-exchange issuers`, () => {
    expectDenied(enforceOAuthTokenExchangeIssuer({ recordedIssuer: 42, exchangeIssuer: issuerA }), 'invalid_input');
    expectDenied(
      enforceOAuthTokenExchangeIssuer({ recordedIssuer: issuerA, exchangeIssuer: 'not-a-url' }),
      'invalid_input',
    );
  });

  it(`${evidence} accepts loopback http metadata and rejects malformed metadata fields`, () => {
    expect(
      enforceOAuthAuthorizationServerMetadata({
        issuer: 'http://127.0.0.1:8080',
        authorization_endpoint: 'http://127.0.0.1:8080/authorize',
        token_endpoint: 'http://127.0.0.1:8080/token',
        registration_endpoint: 'http://127.0.0.1:8080/register',
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true,
      }, { expectedIssuer: 'http://127.0.0.1:8080' }),
    ).toMatchObject({ allowed: true, reason: 'metadata_valid' });
    expect(enforceOAuthAuthorizationServerMetadata(validMetadata({ issuer: 'not-a-url' }))).toMatchObject({
      allowed: false,
      reason: 'invalid_issuer',
    });
    expect(enforceOAuthAuthorizationServerMetadata(validMetadata({ authorization_endpoint: 'not-a-url' }))).toMatchObject({
      allowed: false,
      reason: 'invalid_authorization_endpoint',
    });
    expect(enforceOAuthAuthorizationServerMetadata(validMetadata({ token_endpoint: 'not-a-url' }))).toMatchObject({
      allowed: false,
      reason: 'invalid_token_endpoint',
    });
    expect(
      enforceOAuthAuthorizationServerMetadata(validMetadata({ authorization_response_iss_parameter_supported: 'yes' })),
    ).toMatchObject({ allowed: false, reason: 'invalid_input' });
    expect(
      enforceOAuthAuthorizationServerMetadata(validMetadata({ grant_types_supported: ['authorization_code', 1] })),
    ).toMatchObject({ allowed: false, reason: 'invalid_input' });
  });

  it(`${evidence} rejects missing PKCE metadata and permits only genuinely optional arrays to be absent`, () => {
    expect(enforceOAuthAuthorizationServerMetadata({
      issuer: issuerA,
      authorization_endpoint: `${issuerA}/authorize`,
      token_endpoint: `${issuerA}/token`,
      response_types_supported: ['code'],
    })).toMatchObject({ allowed: false, reason: 'pkce_s256_not_supported' });
    expect(enforceOAuthAuthorizationServerMetadata({
      issuer: issuerA,
      authorization_endpoint: `${issuerA}/authorize`,
      token_endpoint: `${issuerA}/token`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
    }, { expectedIssuer: issuerA })).toMatchObject({ allowed: true, reason: 'metadata_valid' });
  });

  it(`${evidence} rejects malformed DCR inputs`, () => {
    expect(() => buildOAuthDcrClientMetadata({ redirectUris: [] })).toThrow(TypeError);
    expect(() => buildOAuthDcrClientMetadata({ redirectUris: ['not-a-url'] })).toThrow(TypeError);
    expect(() => buildOAuthDcrClientMetadata({ redirectUris: ['javascript:alert(1)'] })).toThrow(TypeError);
    for (const redirectUri of [
      'https://app.example.test/callback#fragment',
      'http://app.example.test/callback',
      'file:///tmp/oauth-callback',
      'ftp://app.example.test/callback',
      'mailto:oauth@example.test',
      'com.example.app://callback/oauth',
      'com.example.app:callback',
      ' https://app.example.test/callback',
    ]) {
      expect(() => buildOAuthDcrClientMetadata({ redirectUris: [redirectUri] })).toThrow(TypeError);
    }
    expect(() => buildOAuthDcrClientMetadata({ redirectUris: ['https://app.example.test/callback'], deploymentType: 'desktop' })).toThrow(TypeError);
    expect(() => buildOAuthDcrClientMetadata({ redirectUris: ['https://app.example.test/callback'], clientName: 42 })).toThrow(TypeError);
    expect(() => buildOAuthDcrClientMetadata({ redirectUris: ['https://app.example.test/callback'], tokenEndpointAuthMethod: 'client_secret_jwt' })).toThrow(TypeError);
    expect(() => buildOAuthDcrClientMetadata({ redirectUris: ['https://app.example.test/callback'], grantTypes: ['authorization_code', ''] })).toThrow(TypeError);
    expect(() => resolveOAuthApplicationType([], 'desktop' as never)).toThrow(TypeError);
    expect(resolveOAuthApplicationType(['not-a-url'])).toBe('web');
  });

  it(`${evidence} builds a valid explicit native DCR body`, () => {
    const metadata = buildOAuthDcrClientMetadata({
      redirectUris: ['http://127.0.0.1:6123/callback'],
      deploymentType: 'native',
      clientName: 'COLP native read client',
      tokenEndpointAuthMethod: 'client_secret_post',
      grantTypes: ['authorization_code', 'refresh_token'],
    });
    expect(metadata.application_type).toBe('native');
    expect(metadata.token_endpoint_auth_method).toBe('client_secret_post');
    expect(metadata.grant_types).toEqual(['authorization_code', 'refresh_token']);
  });

  it(`${evidence} rejects DCR application_type enforcement edge cases`, () => {
    expect(enforceOAuthDcrApplicationType({ application_type: 'desktop' }, 'web')).toMatchObject({
      allowed: false,
      reason: 'application_type_mismatch',
    });
    expect(enforceOAuthDcrApplicationType(null, 'web')).toMatchObject({ allowed: false, reason: 'invalid_input' });
    expect(enforceOAuthDcrApplicationType({ application_type: 'web' }, 'desktop' as never)).toMatchObject({
      allowed: false,
      reason: 'invalid_input',
    });
  });

  it(`${evidence} rejects malformed credential and refresh-state records`, () => {
    expect(enforceOAuthCredentialIssuerIsolation(credential({ clientId: 42 }), issuerA)).toMatchObject({
      allowed: false,
      reason: 'invalid_input',
    });
    expect(enforceOAuthCredentialIssuerIsolation(credential({ clientSecret: 42 }), issuerA)).toMatchObject({
      allowed: false,
      reason: 'invalid_input',
    });
    expect(enforceOAuthCredentialIssuerIsolation(credential({ issuer: 'not-a-url' }), issuerA)).toMatchObject({
      allowed: false,
      reason: 'invalid_input',
    });
    expectDenied(
      rotateOAuthRefreshToken(refreshState({ issuer: 42 }), currentRefreshToken, nextRefreshToken, issuerA),
      'invalid_input',
    );
    expectDenied(rotateOAuthRefreshToken(refreshState(), currentRefreshToken, '', issuerA), 'refresh_token_missing');
    expectDenied(rotateOAuthRefreshToken(refreshState(), currentRefreshToken, nextRefreshToken, ''), 'invalid_input');
    expectDenied(
      rotateOAuthRefreshToken(refreshState({ issuer: 'not-a-url' }), currentRefreshToken, nextRefreshToken, issuerA),
      'invalid_input',
    );
  });

  it(`${evidence} rejects invalid redirect and PKCE inputs`, () => {
    expect(enforceOAuthRedirectUri(null as unknown as string[], 'https://app.example.test/callback')).toMatchObject({
      allowed: false,
      reason: 'invalid_input',
    });
    expect(enforceOAuthRedirectUri(['https://app.example.test/callback', ''], 'https://app.example.test/callback')).toMatchObject({
      allowed: false,
      reason: 'invalid_input',
    });
    expect(enforceOAuthPkce(validPkce({ verifier: 42 }))).toMatchObject({
      allowed: false,
      reason: 'invalid_input',
    });
  });

  it(`${evidence} rejects invalid redaction and log-context inputs`, () => {
    expect(() => redactOAuthCredential(42 as unknown as string)).toThrow(TypeError);
    expect(() => formatOAuthLogContext({ issuer: '', clientId, operation: 'token-exchange', outcome: 'denied' })).toThrow(TypeError);
    expect(() => formatOAuthLogContext({ issuer: issuerA, clientId: '', operation: 'token-exchange', outcome: 'denied' })).toThrow(TypeError);
    expect(() => formatOAuthLogContext({ issuer: issuerA, clientId, operation: 'bogus' as OAuthLogOperation, outcome: 'denied' })).toThrow(TypeError);
    expect(() => formatOAuthLogContext({ issuer: issuerA, clientId, operation: 'token-exchange', outcome: 'maybe' as 'allowed' })).toThrow(TypeError);
    expect(() => formatOAuthLogContext({ issuer: issuerA, clientId, operation: 'token-exchange', outcome: 'denied', reason: 42 as unknown as string })).toThrow(TypeError);
    const line = formatOAuthLogContext({
      issuer: issuerA,
      clientId,
      operation: 'token-exchange',
      outcome: 'denied',
      reason: 'free-form attacker text',
    });
    expect(line).not.toContain('free-form');
    expect(line).not.toContain('attacker');
  });
});
