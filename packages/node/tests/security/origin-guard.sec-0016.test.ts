import { describe, expect, it } from 'vitest';

import { enforceOriginGuard } from '../../src/security/origin-guard.js';

const evidence = '[evidence:security.origin-guard]';
const origin = 'https://publisher.example.test';

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    remote: true,
    protocol: 'streamable-http',
    applicability: 'applicable',
    requestOrigin: origin,
    allowedOrigins: [origin],
    ...overrides,
  };
}

function denied(input: unknown): void {
  const decision = enforceOriginGuard(input);
  expect(decision).toMatchObject({ allowed: false });
  expect(Object.isFrozen(decision)).toBe(true);
  expect(Object.keys(decision).sort()).toEqual(['allowed', 'reason']);
  expect(typeof decision.reason).toBe('string');
}

describe(`${evidence} SEC-0016 Streamable HTTP publisher Origin guard`, () => {
  it(`${evidence} allows an exact HTTPS Origin in the publisher allowlist`, () => {
    const decision = enforceOriginGuard(request());
    expect(decision).toEqual({
      allowed: true,
      disposition: 'enforced',
      location: 'remote',
      reason: 'origin_allowed',
    });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.keys(decision).sort()).toEqual(['allowed', 'disposition', 'location', 'reason']);
  });

  it(`${evidence} allows a matching Origin when unrelated HTTPS entries are also configured`, () => {
    expect(
      enforceOriginGuard(request({ allowedOrigins: ['https://other.example.test', origin, 'https://third.example.test'] })),
    ).toMatchObject({ allowed: true, reason: 'origin_allowed' });
  });

  it(`${evidence} rejects an HTTP request Origin even when its host is allowlisted`, () => {
    denied(request({ requestOrigin: 'http://publisher.example.test', allowedOrigins: ['http://publisher.example.test'] }));
  });

  it(`${evidence} rejects a null Origin`, () => {
    denied(request({ requestOrigin: 'null' }));
  });

  it(`${evidence} rejects a wildcard Origin or wildcard allowlist`, () => {
    denied(request({ requestOrigin: '*', allowedOrigins: ['*'] }));
    denied(request({ allowedOrigins: ['*'] }));
  });

  it(`${evidence} rejects a missing requestOrigin field`, () => {
    const { requestOrigin: _requestOrigin, ...missing } = request();
    denied(missing);
  });

  it(`${evidence} rejects a multiple-valued request Origin`, () => {
    denied(request({ requestOrigin: [origin, 'https://other.example.test'] }));
  });

  it(`${evidence} rejects duplicate allowlist entries instead of collapsing them`, () => {
    denied(request({ allowedOrigins: [origin, origin] }));
  });

  it(`${evidence} rejects an empty allowlist`, () => {
    denied(request({ allowedOrigins: [] }));
  });

  it(`${evidence} rejects path, query, and fragment variants of an otherwise trusted origin`, () => {
    for (const requestOrigin of [`${origin}/path`, `${origin}?query=1`, `${origin}#fragment`]) {
      denied(request({ requestOrigin }));
    }
  });

  it(`${evidence} rejects userinfo and trailing-dot variants`, () => {
    for (const requestOrigin of [
      `https://user:secret@publisher.example.test`,
      'https://publisher.example.test.',
    ]) {
      denied(request({ requestOrigin }));
    }
  });

  it(`${evidence} applies explicit canonical boundaries for host-case and default-port spellings`, () => {
    for (const requestOrigin of ['https://PUBLISHER.EXAMPLE.TEST', 'https://publisher.example.test:443']) {
      expect(enforceOriginGuard(request({ requestOrigin }))).toMatchObject({
        allowed: true,
        reason: 'origin_allowed',
      });
    }
  });

  it(`${evidence} rejects encoded, control-character, and invalid UTF-8-looking Origin spellings`, () => {
    for (const requestOrigin of [
      'https://publisher.example.test/%2f',
      `https://publisher.example.test/\u0001`,
      `https://publisher.example.test/${'\ud800'}`,
    ]) {
      denied(request({ requestOrigin }));
    }
  });

  it(`${evidence} rejects mismatches and DNS-rebinding lookalike hosts`, () => {
    for (const requestOrigin of [
      'https://attacker.example.test',
      'https://publisher.example.test.attacker.test',
      'https://publisher-example.test',
    ]) {
      denied(request({ requestOrigin }));
    }
  });

  it(`${evidence} rejects array-valued allowlists and nested multi-Origin values`, () => {
    denied(request({ allowedOrigins: [[origin]] }));
    denied(request({ allowedOrigins: [origin, ['https://other.example.test']] }));
  });

  it(`${evidence} rejects a loopback applicability bypass without invoking residual accessors`, () => {
    let originReads = 0;
    let allowlistReads = 0;
    const input = {
      remote: false,
      applicability: 'not_applicable',
      protocol: 'streamable-http',
      get requestOrigin(): string {
        originReads += 1;
        throw new Error('requestOrigin must not be read for non-remote input');
      },
      get allowedOrigins(): string[] {
        allowlistReads += 1;
        throw new Error('allowedOrigins must not be read for non-remote input');
      },
    };
    expect(enforceOriginGuard(input)).toMatchObject({
      allowed: false,
      reason: 'applicability_mismatch',
    });
    expect(originReads).toBe(0);
    expect(allowlistReads).toBe(0);
  });

  it(`${evidence} returns not_applicable for non-streamable protocols without reading Origin evidence`, () => {
    let originReads = 0;
    let allowlistReads = 0;
    const input = {
      remote: true,
      protocol: 'websocket',
      applicability: 'not_applicable',
      get requestOrigin(): string {
        originReads += 1;
        throw new Error('requestOrigin must not be read for non-streamable protocol');
      },
      get allowedOrigins(): string[] {
        allowlistReads += 1;
        throw new Error('allowedOrigins must not be read for non-streamable protocol');
      },
    };
    expect(enforceOriginGuard(input)).toMatchObject({ allowed: true, reason: 'not_applicable' });
    expect(originReads).toBe(0);
    expect(allowlistReads).toBe(0);
  });

  it(`${evidence} fails closed for proxies, custom prototypes, inherited fields, and accessors`, () => {
    denied(new Proxy(request(), {}));
    const custom = Object.create({ protocol: 'streamable_http' });
    Object.assign(custom, { remote: true, applicability: 'applicable', requestOrigin: origin, allowedOrigins: [origin] });
    denied(custom);
    const accessor = request();
    Object.defineProperty(accessor, 'requestOrigin', { get: () => origin, enumerable: true });
    denied(accessor);
  });

  it(`${evidence} fails closed for extra string, symbol, and dynamically-added fields`, () => {
    denied(request({ hint: 'cors' }));
    const symbolInput = request();
    Object.defineProperty(symbolInput, Symbol('extra'), { value: 'unexpected' });
    denied(symbolInput);
    const dynamic = Object.create(null) as Record<string, unknown>;
    Object.assign(dynamic, request(), { lateField: 'unexpected' });
    denied(dynamic);
  });

  it(`${evidence} freezes secret-safe decisions without echoing Origin values`, () => {
    const secret = 'https://user:password@attacker.example.test/secret-token';
    const decision = enforceOriginGuard(request({ requestOrigin: secret }));
    expect(decision).toMatchObject({ allowed: false });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(JSON.stringify(decision)).not.toContain(secret);
    expect(JSON.stringify(decision)).not.toContain('password');
  });
});
