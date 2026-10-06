import { describe, expect, it } from 'vitest';

import { enforceHttpsEndpoint } from '../../src/security/https-enforcement.js';

/**
 * M-5: absolute-form HTTPS request targets with IPv6 literal hosts.
 *
 * Aligns https-enforcement with origin-guard: bracketed IPv6 authorities that
 * the WHATWG URL parser accepts are allowed over trusted HTTPS transport; bad
 * forms fail closed. Explicit default port `:443` is rejected (same rule as
 * hostname absolute-form targets in SEC-0015).
 */

const evidence = '[evidence:security.https-ipv6]';

const enforced = {
  allowed: true,
  disposition: 'enforced',
  location: 'remote',
  reason: 'https_endpoint',
} as const;

function remoteHttps(requestTarget: string): {
  readonly remote: true;
  readonly applicability: 'applicable';
  readonly transport: { readonly scheme: 'https' };
  readonly requestTarget: string;
} {
  return {
    remote: true,
    applicability: 'applicable',
    transport: { scheme: 'https' },
    requestTarget,
  };
}

function denied(input: unknown): void {
  const decision = enforceHttpsEndpoint(input);
  expect(decision).toMatchObject({ allowed: false });
  expect(Object.isFrozen(decision)).toBe(true);
  expect(Object.keys(decision).sort()).toEqual(['allowed', 'reason']);
}

describe(`${evidence} M-5 absolute-form HTTPS IPv6 targets`, () => {
  it(`${evidence} allows bracketed documentation-prefix IPv6 over trusted HTTPS transport`, () => {
    const decision = enforceHttpsEndpoint(remoteHttps('https://[2001:db8::1]/collections/c-1'));
    expect(decision).toEqual(enforced);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.keys(decision).sort()).toEqual(['allowed', 'disposition', 'location', 'reason']);
  });

  it.each([
    ['compressed documentation address', 'https://[2001:db8::1]/collections/c-1'],
    ['loopback compressed form', 'https://[::1]/health'],
    ['fully expanded documentation address', 'https://[2001:db8:0:0:0:0:0:1]/collections/c-1'],
    ['mixed compressed mid-address', 'https://[2001:db8:85a3::8a2e:370:7334]/items'],
  ])(`${evidence} allows compressed/expanded IPv6 form URL accepts: %s`, (_label, requestTarget) => {
    expect(enforceHttpsEndpoint(remoteHttps(requestTarget))).toEqual(enforced);
  });

  it(`${evidence} allows bracketed IPv6 with a non-default HTTPS port`, () => {
    expect(enforceHttpsEndpoint(remoteHttps('https://[2001:db8::1]:8443/path'))).toEqual(enforced);
  });

  it.each([
    ['unbracketed IPv6 in authority', 'https://2001:db8::1/collections/c-1'],
    ['empty brackets', 'https://[]/collections/c-1'],
    ['HTTP scheme with IPv6', 'http://[2001:db8::1]/'],
    ['explicit default port :443 on IPv6', 'https://[2001:db8::1]:443/collections/c-1'],
    ['userinfo with IPv6', 'https://user:secret@[2001:db8::1]/collections/c-1'],
    ['fragment with IPv6', 'https://[2001:db8::1]/collections/c-1#frag'],
  ])(`${evidence} fails closed for %s`, (_label, requestTarget) => {
    const input = remoteHttps(requestTarget);
    denied(input);
    // Absolute-form failures surface as https_required (not origin-form invalid_target).
    expect(enforceHttpsEndpoint(input)).toEqual({ allowed: false, reason: 'https_required' });
    expect(JSON.stringify(enforceHttpsEndpoint(input))).not.toContain(requestTarget);
  });

  it(`${evidence} still allows origin-form targets (regression smoke)`, () => {
    expect(enforceHttpsEndpoint(remoteHttps('/collections/c-1'))).toEqual(enforced);
  });

  it(`${evidence} still allows hostname absolute HTTPS targets (regression smoke)`, () => {
    expect(
      enforceHttpsEndpoint(remoteHttps('https://publisher.example.test/collections/c-1')),
    ).toEqual(enforced);
  });
});
