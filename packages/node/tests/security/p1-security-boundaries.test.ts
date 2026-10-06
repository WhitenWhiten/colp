import { describe, expect, it, vi } from 'vitest';
import {
  canonicalOAuthIssuer,
  enforceOAuthAuthorizationResponseIss,
  enforceOAuthAuthorizationServerMetadata,
  enforceOAuthCredentialIssuerIsolation,
  enforceOAuthTokenExchangeIssuer,
  enforcePublisherStreamableHttpBoundary,
  oauthCredentialStoreKey,
  rotateOAuthRefreshToken,
  selectOAuthClientCredentialForIssuer,
  selectOAuthRefreshStateForIssuer,
} from '../../src/security/index.js';

const issuer = 'https://auth.example.test/tenant';
const metadata = () => ({
  issuer,
  authorization_endpoint: 'https://auth.example.test/authorize',
  token_endpoint: 'https://auth.example.test/token',
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
});
const localEvidence = (origin: unknown) => ({
  networkExposure: 'loopback', tlsTerminated: false, transportScheme: 'http',
  protocol: 'streamable-http', requestTarget: '/mcp', origin,
});

describe('P1-01: loopback is not an Origin exemption', () => {
  it.each(['https://attacker.example.test', 'null', '*', undefined, [],
    ['https://app.example.test', 'https://attacker.example.test']].map(origin => ({ origin })))('denies untrusted local Origin $origin', ({ origin }) => {
    expect(enforcePublisherStreamableHttpBoundary(localEvidence(origin), {
      allowedOrigins: ['https://app.example.test'],
    })).toMatchObject({ allowed: false, reason: 'origin_denied', remote: false });
  });

  it.each(['https://app.example.test', 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173'])(
    'allows an explicitly trusted local Origin %s while retaining the local HTTP exception', origin => {
      expect(enforcePublisherStreamableHttpBoundary(localEvidence(origin), { allowedOrigins: [origin] }))
        .toMatchObject({ allowed: true, remote: false,
          https: { disposition: 'not_applicable' },
          origin: { disposition: 'enforced', location: 'local', reason: 'origin_allowed' } });
    },
  );

  it('does not turn a loopback HTTP allowance into trust of arbitrary HTTP sites', () => {
    const origin = 'http://attacker.example.test';
    expect(enforcePublisherStreamableHttpBoundary(localEvidence(origin), { allowedOrigins: [origin] }).allowed).toBe(false);
  });

  it('non-Streamable local transports retain not_applicable', () => {
    expect(enforcePublisherStreamableHttpBoundary({ ...localEvidence(undefined), protocol: 'other' }, {
      allowedOrigins: [],
    })).toMatchObject({ allowed: true, origin: { disposition: 'not_applicable' } });
  });
});

describe('P1-02/P1-03: extensible discovery with mandatory code and PKCE capabilities', () => {
  it('accepts standard/OIDC fields and extensions without reflecting ignored values', () => {
    const decision = enforceOAuthAuthorizationServerMetadata({
      ...metadata(), jwks_uri: 'https://auth.example.test/jwks', scopes_supported: ['openid'],
      token_endpoint_auth_methods_supported: ['client_secret_basic'],
      id_token_signing_alg_values_supported: ['RS256'], service_documentation: 'https://auth.example.test/docs',
      custom_extension: { unconsumed: 'do-not-reflect' },
    }, { expectedIssuer: issuer });
    expect(decision).toMatchObject({ allowed: true, metadata: { issuer } });
    expect(JSON.stringify(decision)).not.toContain('do-not-reflect');
  });

  it.each([undefined, [], ['plain']].map(methods => ({ methods })))('denies absent/unsupported PKCE declaration $methods', ({ methods }) => {
    expect(enforceOAuthAuthorizationServerMetadata({ ...metadata(), code_challenge_methods_supported: methods }))
      .toMatchObject({ allowed: false, reason: 'pkce_s256_not_supported' });
  });

  it.each([undefined, [], ['token'], [1], 'code'].map(types => ({ types })))('denies absent/invalid response types $types', ({ types }) => {
    expect(enforceOAuthAuthorizationServerMetadata({ ...metadata(), response_types_supported: types }))
      .toMatchObject({ allowed: false, reason: 'response_types_invalid' });
  });

  it('rejects extension getters without evaluating them', () => {
    const getter = vi.fn(() => 'sensitive');
    const value = Object.defineProperty(metadata(), 'extension', { enumerable: true, get: getter });
    expect(enforceOAuthAuthorizationServerMetadata(value)).toMatchObject({ allowed: false, reason: 'invalid_input' });
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('P1-04: exact issuer identity across every credential boundary', () => {
  it.each([
    'https://auth.example.test/tenant/',
    'https://AUTH.example.test/tenant',
    'HTTPS://auth.example.test/tenant',
    'https://auth.example.test:443/tenant',
    'https://auth.example.test/%74enant',
    'https://auth.example.test/path/../tenant',
  ])('does not collapse %s into the recorded issuer', other => {
    expect(canonicalOAuthIssuer(other)).toBe(other);
    expect(oauthCredentialStoreKey(other)).not.toBe(oauthCredentialStoreKey(issuer));
    expect(enforceOAuthAuthorizationResponseIss({ expectedIssuer: issuer, iss: other, issParameterSupported: true }))
      .toMatchObject({ allowed: false, reason: 'issuer_swap' });
    expect(enforceOAuthTokenExchangeIssuer({ recordedIssuer: issuer, exchangeIssuer: other }))
      .toMatchObject({ allowed: false, reason: 'issuer_mixup' });
    const credential = { issuer, clientId: 'client', credentialBindingId: 'binding', clientSecret: 'not-for-other-issuer' };
    expect(selectOAuthClientCredentialForIssuer([credential], other)).toBeUndefined();
    expect(enforceOAuthCredentialIssuerIsolation(credential, other)).toMatchObject({ allowed: false });
    const state = { issuer, currentRefreshToken: 'old-refresh' };
    expect(selectOAuthRefreshStateForIssuer([state], other)).toBeUndefined();
    expect(rotateOAuthRefreshToken(state, 'old-refresh', 'new-refresh', other))
      .toMatchObject({ allowed: false, reason: 'refresh_issuer_mismatch' });
  });

  it.each(['https://user:secret@auth.example.test/tenant', ' https://auth.example.test/tenant',
    'https://auth.example.test/tenant?', 'https://auth.example.test/tenant#'])('rejects malformed issuer %s', value => {
    expect(() => canonicalOAuthIssuer(value)).toThrow(TypeError);
    expect(enforceOAuthAuthorizationServerMetadata({ ...metadata(), issuer: value }).allowed).toBe(false);
  });
});
