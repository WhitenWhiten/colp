import { describe, expect, it } from 'vitest';
import { enforceOAuthAuthorizationServerMetadata as validate } from '../../src/security/mcp-oauth-discovery.js';

const expectedIssuer = 'https://auth.example.test';
const metadata = () => ({
  issuer: expectedIssuer,
  authorization_endpoint: 'https://login.example.test/authorize',
  token_endpoint: 'https://tokens.example.test/token',
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
});

describe('OAuth discovery authority binding', () => {
  it('never returns endpoints without a trusted expected issuer', () => {
    expect(validate(metadata())).toEqual({ allowed: false, reason: 'expected_issuer_required' });
    expect(validate(metadata(), {})).toEqual({ allowed: false, reason: 'expected_issuer_required' });
  });

  it('accepts an exact issuer without requiring legitimate endpoint hosts to coincide', () => {
    const result = validate(metadata(), { expectedIssuer });
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.metadata.issuer).toBe(expectedIssuer);
      expect(result.metadata.authorizationEndpoint).toBe('https://login.example.test/authorize');
      expect(result.metadata.tokenEndpoint).toBe('https://tokens.example.test/token');
      expect(Object.isFrozen(result.metadata)).toBe(true);
    }
  });

  it.each(['https://attacker.example.test', 'https://auth.example.test/',
    'https://auth.example.test:443', 'HTTPS://AUTH.EXAMPLE.TEST'])('rejects substituted or differently spelled issuer %s', issuer => {
    expect(validate({ ...metadata(), issuer }, { expectedIssuer })).toEqual({ allowed: false, reason: 'issuer_mismatch' });
  });

  it('rejects invalid trusted issuer configuration', () => {
    for (const issuer of ['', 'not-a-url', 'http://remote.example.test', `${expectedIssuer}?x=1`]) {
      expect(validate(metadata(), { expectedIssuer: issuer })).toEqual({ allowed: false, reason: 'invalid_input' });
    }
  });

  it('accepts pinned loopback HTTP without normalizing its port or spelling', () => {
    const issuer = 'http://127.0.0.1:8080';
    expect(validate({ ...metadata(), issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token` },
      { expectedIssuer: issuer }).allowed).toBe(true);
  });

  it('rejects executable options without invoking getters', () => {
    let invoked = false;
    expect(validate(metadata(), { get expectedIssuer() { invoked = true; return expectedIssuer; } }))
      .toEqual({ allowed: false, reason: 'invalid_input' });
    expect(invoked).toBe(false);
  });

  it('keeps independent PKCE, endpoint, and DCR validation', () => {
    expect(validate({ ...metadata(), code_challenge_methods_supported: ['plain'] }, { expectedIssuer }))
      .toEqual({ allowed: false, reason: 'pkce_s256_not_supported' });
    expect(validate({ ...metadata(), token_endpoint: 'http://remote.example.test/token' }, { expectedIssuer }))
      .toEqual({ allowed: false, reason: 'insecure_token_endpoint' });
    expect(validate(metadata(), { expectedIssuer, requireDcr: true }))
      .toEqual({ allowed: false, reason: 'missing_registration_endpoint' });
  });
});
