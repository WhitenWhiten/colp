import { describe, expect, it } from 'vitest';

import { enforceHttpsEndpoint } from '../../src/security/https-enforcement.js';

const evidence = '[evidence:security.https-enforcement]';

function denied(input: unknown): void {
  const decision = enforceHttpsEndpoint(input);
  expect(decision).toMatchObject({ allowed: false });
  expect(Object.isFrozen(decision)).toBe(true);
  expect(Object.keys(decision).sort()).toEqual(['allowed', 'reason']);
}

describe(`${evidence} SEC-0015 publisher HTTPS endpoint enforcement`, () => {
  it(`${evidence} allows a remote origin-form request target over trusted HTTPS transport`, () => {
    const decision = enforceHttpsEndpoint({
      remote: true,
      applicability: 'applicable',
      transport: { scheme: 'https' },
      requestTarget: '/collections/c-1',
    });
    expect(decision).toEqual({
      allowed: true,
      disposition: 'enforced',
      location: 'remote',
      reason: 'https_endpoint',
    });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.keys(decision).sort()).toEqual(['allowed', 'disposition', 'location', 'reason']);
  });

  it(`${evidence} allows an absolute HTTPS request target over trusted HTTPS transport`, () => {
    expect(
      enforceHttpsEndpoint({
        remote: true,
        applicability: 'applicable',
        transport: { scheme: 'https' },
        requestTarget: 'https://publisher.example.test/collections/c-1',
      }),
    ).toEqual({
      allowed: true,
      disposition: 'enforced',
      location: 'remote',
      reason: 'https_endpoint',
    });
  });

  it.each([
    ['compressed IPv6', 'https://[2001:db8::1]/collections/c-1'],
    ['mixed-case IPv6 hex', 'https://[2001:DB8::1]/collections/c-1'],
    ['expanded IPv6', 'https://[2001:0db8:0000:0000:0000:0000:0000:0001]/collections/c-1'],
    ['loopback IPv6', 'https://[::1]/collections/c-1'],
    ['IPv6 with non-default port', 'https://[2001:db8::1]:8443/collections/c-1'],
  ])(`${evidence} allows absolute HTTPS targets with a bracketed %s host`, (_label, requestTarget) => {
    expect(
      enforceHttpsEndpoint({
        remote: true,
        applicability: 'applicable',
        transport: { scheme: 'https' },
        requestTarget,
      }),
    ).toEqual({
      allowed: true,
      disposition: 'enforced',
      location: 'remote',
      reason: 'https_endpoint',
    });
  });

  it.each([
    ['an absolute HTTP scheme', 'http://publisher.example.test/collections/c-1', 'https'],
    ['an HTTP transport', '/collections/c-1', 'http'],
  ])(`${evidence} denies remote traffic using %s`, (_label, requestTarget, scheme) => {
    const input = {
      remote: true,
      applicability: 'applicable',
      transport: { scheme },
      requestTarget,
    } as const;
    denied(input);
    expect(JSON.stringify(enforceHttpsEndpoint(input))).not.toContain(requestTarget);
  });

  it.each([
    ['a protocol-relative target', '//publisher.example.test/collections/c-1'],
    ['a malformed target', 'https:/publisher.example.test/collections/c-1'],
    ['an empty target', ''],
    ['a relative target without an origin-form slash', 'collections/c-1'],
  ])(`${evidence} fails closed for %s`, (_label, requestTarget) => {
    denied({ remote: true, applicability: 'applicable', transport: { scheme: 'https' }, requestTarget });
  });

  it.each([
    ['userinfo', 'https://user:secret@publisher.example.test/collections/c-1'],
    ['a fragment', 'https://publisher.example.test/collections/c-1#fragment'],
    ['a backslash', 'https://publisher.example.test\\collections/c-1'],
    ['an explicit default port', 'https://publisher.example.test:443/collections/c-1'],
    ['an uppercase host spelling', 'https://PUBLISHER.EXAMPLE.TEST/collections/c-1'],
    ['an encoded path octet', 'https://publisher.example.test/collections/%63-1'],
    ['an unbracketed IPv6 host', 'https://2001:db8::1/collections/c-1'],
    ['empty IPv6 brackets', 'https://[]/collections/c-1'],
    ['a malformed IPv6 host', 'https://[::1/collections/c-1'],
    ['an invalid IPv6 host', 'https://[gggg::1]/collections/c-1'],
    ['an IPv6 zone id', 'https://[2001:db8::1%25eth0]/collections/c-1'],
    ['an IPv6 explicit default port', 'https://[2001:db8::1]:443/collections/c-1'],
  ])(`${evidence} fails closed for HTTPS targets containing %s`, (_label, requestTarget) => {
    denied({ remote: true, applicability: 'applicable', transport: { scheme: 'https' }, requestTarget });
  });

  it.each([
    ['a control character', '/collections/\u0001', 'invalid_input'],
    ['an invalid percent escape', '/collections/%ZZ', 'invalid_target'],
    ['a lone surrogate', `/collections/${'\ud800'}`, 'invalid_input'],
    ['an overlong target', `/collections/${'x'.repeat(8192)}`, 'invalid_input'],
  ] as const)(`${evidence} fails closed for %s`, (_label, requestTarget, reason) => {
    expect(enforceHttpsEndpoint({
      remote: true,
      applicability: 'applicable',
      transport: { scheme: 'https' },
      requestTarget,
    })).toEqual({ allowed: false, reason });
  });

  it(`${evidence} returns explicit not_applicable for non-remote input without reading residual fields`, () => {
    let targetReads = 0;
    let transportReads = 0;
    const input = {
      remote: false,
      applicability: 'not_applicable',
      get requestTarget(): string {
        targetReads += 1;
        throw new Error('requestTarget must not be read for non-remote input');
      },
      get transport(): { scheme: 'https' } {
        transportReads += 1;
        throw new Error('transport must not be read for non-remote input');
      },
    };

    expect(enforceHttpsEndpoint(input)).toEqual({
      allowed: true,
      disposition: 'not_applicable',
      location: 'local',
      reason: 'not_applicable',
    });
    expect(targetReads).toBe(0);
    expect(transportReads).toBe(0);
  });

  it(`${evidence} fails closed for proxies, accessors, inherited fields, extra hints, and dynamic inputs`, () => {
    const accessorCalls = { target: 0 };
    const accessor = {
      remote: true as const,
      applicability: 'applicable' as const,
      transport: { scheme: 'https' as const },
      get requestTarget(): string {
        accessorCalls.target += 1;
        return '/collections/c-1';
      },
    };
    denied(new Proxy({
      remote: true,
      applicability: 'applicable',
      transport: { scheme: 'https' },
      requestTarget: '/collections/c-1',
    }, {}));
    denied(accessor);
    expect(accessorCalls.target).toBe(0);

    const inherited = Object.create({
      remote: true,
      applicability: 'applicable',
      transport: { scheme: 'https' },
      requestTarget: '/collections/c-1',
    });
    denied(inherited);
    denied({
      remote: true,
      applicability: 'applicable',
      transport: { scheme: 'https' },
      requestTarget: '/collections/c-1',
      hint: 'tls',
    });

    const dynamic = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(dynamic, 'remote', { value: true, enumerable: true });
    Object.defineProperty(dynamic, 'applicability', { value: 'applicable', enumerable: true });
    Object.defineProperty(dynamic, 'transport', { value: { scheme: 'https' }, enumerable: true });
    Object.defineProperty(dynamic, 'requestTarget', {
      enumerable: true,
      get: () => '/collections/c-1',
    });
    denied(dynamic);
  });
});
