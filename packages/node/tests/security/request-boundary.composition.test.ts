import { describe, expect, it } from 'vitest';

import {
  deriveRemoteApplicability,
  enforceHttpsFromTransport,
  enforceOriginFromTransport,
  enforcePublisherStreamableHttpBoundary,
  type TrustedTransportEvidence,
} from '../../src/security/index.js';
import { createPublisherHttpBoundary } from '../../src/nestjs/index.js';

const evidenceTag = '[evidence:security.request-boundary]';

function publicHttpsStreamable(
  overrides: Partial<TrustedTransportEvidence> = {},
): TrustedTransportEvidence {
  return {
    networkExposure: 'public',
    tlsTerminated: true,
    transportScheme: 'https',
    protocol: 'streamable-http',
    requestTarget: '/mcp',
    origin: 'https://app.example.test',
    ...overrides,
  };
}

describe(`${evidenceTag} request-boundary composition (H-1 / M-1)`, () => {
  describe('deriveRemoteApplicability', () => {
    it(`${evidenceTag} marks public and private exposure as remote + applicable`, () => {
      expect(deriveRemoteApplicability(publicHttpsStreamable())).toEqual({
        remote: true,
        applicability: 'applicable',
      });
      expect(
        deriveRemoteApplicability(publicHttpsStreamable({ networkExposure: 'private' })),
      ).toEqual({ remote: true, applicability: 'applicable' });
    });

    it(`${evidenceTag} marks loopback as non-remote with HTTPS not_applicable`, () => {
      expect(
        deriveRemoteApplicability(publicHttpsStreamable({ networkExposure: 'loopback' })),
      ).toEqual({ remote: false, applicability: 'not_applicable' });
    });

    it(`${evidenceTag} rejects self-asserted remote by requiring networkExposure only`, () => {
      // Callers cannot pass { remote: false } — that key is not part of evidence.
      expect(() =>
        deriveRemoteApplicability({
          remote: false,
          networkExposure: 'public',
          tlsTerminated: true,
          transportScheme: 'https',
          protocol: 'streamable-http',
          requestTarget: '/mcp',
        }),
      ).toThrow(/unknown fields/i);
    });

    it(`${evidenceTag} fails closed on Proxy / accessor / incomplete evidence`, () => {
      expect(() => deriveRemoteApplicability(new Proxy({}, {}))).toThrow();
      expect(() =>
        deriveRemoteApplicability({
          get networkExposure() {
            return 'public';
          },
          tlsTerminated: true,
          transportScheme: 'https',
          protocol: 'other',
          requestTarget: '/',
        }),
      ).toThrow();
      expect(() =>
        deriveRemoteApplicability({
          networkExposure: 'public',
          tlsTerminated: true,
          transportScheme: 'https',
          protocol: 'other',
          // missing requestTarget
        }),
      ).toThrow();
    });
  });

  describe('enforceHttpsFromTransport', () => {
    it(`${evidenceTag} enforces HTTPS for public exposure with terminator signal`, () => {
      const decision = enforceHttpsFromTransport(
        publicHttpsStreamable({
          transportScheme: 'http',
          tlsTerminated: true,
          requestTarget: '/collections/c-1',
          protocol: 'other',
        }),
      );
      expect(decision).toEqual({
        allowed: true,
        disposition: 'enforced',
        location: 'remote',
        reason: 'https_endpoint',
      });
      expect(Object.isFrozen(decision)).toBe(true);
    });

    it(`${evidenceTag} denies public HTTP without TLS terminator`, () => {
      const decision = enforceHttpsFromTransport({
        networkExposure: 'public',
        tlsTerminated: false,
        transportScheme: 'http',
        protocol: 'other',
        requestTarget: '/collections/c-1',
      });
      expect(decision).toMatchObject({ allowed: false });
      expect(Object.isFrozen(decision)).toBe(true);
    });

    it(`${evidenceTag} short-circuits loopback without reading a free-form remote flag`, () => {
      const decision = enforceHttpsFromTransport(
        publicHttpsStreamable({
          networkExposure: 'loopback',
          transportScheme: 'http',
          tlsTerminated: false,
          protocol: 'other',
          requestTarget: 'http://127.0.0.1/secret',
        }),
      );
      expect(decision).toEqual({
        allowed: true,
        disposition: 'not_applicable',
        location: 'local',
        reason: 'not_applicable',
      });
    });

    it(`${evidenceTag} does not accept a remote override on the composition path`, () => {
      // Even if a hostile bag includes remote:false, unknown fields fail closed.
      const decision = enforceHttpsFromTransport({
        networkExposure: 'public',
        tlsTerminated: false,
        transportScheme: 'http',
        protocol: 'other',
        requestTarget: '/x',
        remote: false,
      });
      expect(decision).toMatchObject({ allowed: false, reason: 'invalid_input' });
    });
  });

  describe('enforceOriginFromTransport', () => {
    const allowlist = ['https://app.example.test'] as const;

    it(`${evidenceTag} enforces origin for remote streamable-http`, () => {
      expect(enforceOriginFromTransport(publicHttpsStreamable(), allowlist)).toEqual({
        allowed: true,
        disposition: 'enforced',
        location: 'remote',
        reason: 'origin_allowed',
      });
    });

    it(`${evidenceTag} denies origin not on allowlist`, () => {
      const decision = enforceOriginFromTransport(
        publicHttpsStreamable({ origin: 'https://evil.example.test' }),
        allowlist,
      );
      expect(decision).toMatchObject({ allowed: false, reason: 'origin_not_allowed' });
    });

    it(`${evidenceTag} skips only non-streamable protocols and enforces loopback Origin`, () => {
      expect(
        enforceOriginFromTransport(
          publicHttpsStreamable({ protocol: 'other' }),
          allowlist,
        ),
      ).toEqual({
        allowed: true,
        disposition: 'not_applicable',
        location: 'local',
        reason: 'not_applicable',
      });
      expect(
        enforceOriginFromTransport(
          publicHttpsStreamable({ networkExposure: 'loopback' }),
          allowlist,
        ),
      ).toEqual({
        allowed: true,
        disposition: 'enforced',
        location: 'local',
        reason: 'origin_allowed',
      });
    });

    it(`${evidenceTag} accepts single-element multi-value origin arrays and multi-entry allowlists`, () => {
      const multiAllowlist = [
        'https://other.example.test',
        'https://app.example.test',
        'https://third.example.test',
      ];
      const singleElementOrigin = ['https://app.example.test'];

      const decision = enforceOriginFromTransport(
        publicHttpsStreamable({ origin: singleElementOrigin }),
        multiAllowlist,
      );
      expect(decision).toEqual({
        allowed: true,
        disposition: 'enforced',
        location: 'remote',
        reason: 'origin_allowed',
      });
      expect(Object.isFrozen(decision)).toBe(true);

      // Multi-valued Origin headers (>1 entry) still fail closed.
      expect(
        enforceOriginFromTransport(
          publicHttpsStreamable({
            origin: ['https://app.example.test', 'https://other.example.test'],
          }),
          multiAllowlist,
        ),
      ).toMatchObject({ allowed: false });
    });

    it(`${evidenceTag} snapshots allowlist and origin arrays so caller mutation cannot freeze or alias`, () => {
      const allowedOrigins = ['https://app.example.test'];
      const originValues = ['https://app.example.test'];

      const decision = enforceOriginFromTransport(
        publicHttpsStreamable({ origin: originValues }),
        allowedOrigins,
      );
      expect(decision).toMatchObject({ allowed: true, reason: 'origin_allowed' });
      expect(Object.isFrozen(decision)).toBe(true);

      // Snapshot isolation: caller arrays remain mutable and are not frozen in place.
      expect(Object.isFrozen(allowedOrigins)).toBe(false);
      expect(Object.isFrozen(originValues)).toBe(false);
      allowedOrigins[0] = 'https://evil.example.test';
      originValues[0] = 'https://evil.example.test';
      expect(allowedOrigins[0]).toBe('https://evil.example.test');
      expect(originValues[0]).toBe('https://evil.example.test');

      // Subsequent calls observe the mutated caller arrays (fresh snapshot each time).
      expect(
        enforceOriginFromTransport(
          publicHttpsStreamable({ origin: 'https://app.example.test' }),
          allowedOrigins,
        ),
      ).toMatchObject({ allowed: false });
    });
  });

  describe('enforcePublisherStreamableHttpBoundary', () => {
    const options = { allowedOrigins: ['https://app.example.test'] };

    it(`${evidenceTag} allows ordered HTTPS then Origin success`, () => {
      const decision = enforcePublisherStreamableHttpBoundary(publicHttpsStreamable(), options);
      expect(decision.allowed).toBe(true);
      if (decision.allowed) {
        expect(decision.remote).toBe(true);
        expect(decision.https).toMatchObject({ allowed: true, reason: 'https_endpoint' });
        expect(decision.origin).toMatchObject({ allowed: true, reason: 'origin_allowed' });
      }
      expect(Object.isFrozen(decision)).toBe(true);
    });

    it(`${evidenceTag} freezes boundary decisions and isolates multi-entry allowedOrigins snapshots`, () => {
      const allowedOrigins = [
        'https://other.example.test',
        'https://app.example.test',
      ];
      const boundaryOptions = { allowedOrigins };

      const decision = enforcePublisherStreamableHttpBoundary(
        publicHttpsStreamable(),
        boundaryOptions,
      );
      expect(decision.allowed).toBe(true);
      if (decision.allowed) {
        expect(decision.origin).toMatchObject({ allowed: true, reason: 'origin_allowed' });
        expect(Object.isFrozen(decision.https)).toBe(true);
        expect(Object.isFrozen(decision.origin)).toBe(true);
      }
      expect(Object.isFrozen(decision)).toBe(true);

      // SnapshotDenseArray already copies: mutating the caller's allowlist must not
      // freeze it in place, and a later call uses the mutated values.
      expect(Object.isFrozen(allowedOrigins)).toBe(false);
      allowedOrigins.length = 0;
      allowedOrigins.push('https://evil.example.test');
      expect(
        enforcePublisherStreamableHttpBoundary(publicHttpsStreamable(), boundaryOptions),
      ).toMatchObject({ allowed: false, reason: 'origin_denied' });
    });

    it(`${evidenceTag} fails closed on first HTTPS denial`, () => {
      const decision = enforcePublisherStreamableHttpBoundary(
        publicHttpsStreamable({
          tlsTerminated: false,
          transportScheme: 'http',
          requestTarget: 'http://publisher.example.test/mcp',
        }),
        options,
      );
      expect(decision).toMatchObject({ allowed: false, reason: 'https_denied', remote: true });
      if (!decision.allowed) {
        expect(decision.origin).toBeUndefined();
      }
    });

    it(`${evidenceTag} fails closed on Origin denial after HTTPS`, () => {
      const decision = enforcePublisherStreamableHttpBoundary(
        publicHttpsStreamable({ origin: 'https://other.example.test' }),
        options,
      );
      expect(decision).toMatchObject({ allowed: false, reason: 'origin_denied', remote: true });
      if (!decision.allowed) {
        expect(decision.https).toMatchObject({ allowed: true });
        expect(decision.origin).toMatchObject({ allowed: false });
      }
    });

    it(`${evidenceTag} allows loopback HTTP only after Origin validation`, () => {
      const decision = enforcePublisherStreamableHttpBoundary(
        publicHttpsStreamable({
          networkExposure: 'loopback',
          tlsTerminated: false,
          transportScheme: 'http',
          requestTarget: '/mcp',
        }),
        options,
      );
      expect(decision.allowed).toBe(true);
      if (decision.allowed) {
        expect(decision.remote).toBe(false);
        expect(decision.https.reason).toBe('not_applicable');
        expect(decision.origin.reason).toBe('origin_allowed');
      }
    });

    it(`${evidenceTag} denies invalid evidence without echoing secrets`, () => {
      const secret = 'https://secret.example.test/token-abc';
      const decision = enforcePublisherStreamableHttpBoundary(
        { requestTarget: secret },
        options,
      );
      expect(decision).toEqual({ allowed: false, reason: 'invalid_evidence' });
      expect(JSON.stringify(decision)).not.toContain(secret);
    });

    it(`${evidenceTag} distinguishes invalid_options from invalid_evidence`, () => {
      const goodEvidence = publicHttpsStreamable();

      expect(
        enforcePublisherStreamableHttpBoundary(goodEvidence, {
          allowedOrigins: ['https://app.example.test', 42 as unknown as string],
        }),
      ).toEqual({ allowed: false, reason: 'invalid_options' });

      expect(
        enforcePublisherStreamableHttpBoundary(goodEvidence, {
          // missing allowedOrigins
        } as { allowedOrigins: readonly string[] }),
      ).toEqual({ allowed: false, reason: 'invalid_options' });

      expect(
        enforcePublisherStreamableHttpBoundary(goodEvidence, null as unknown as { allowedOrigins: readonly string[] }),
      ).toEqual({ allowed: false, reason: 'invalid_options' });

      // Options ok, evidence incomplete → invalid_evidence (not invalid_options)
      expect(
        enforcePublisherStreamableHttpBoundary({ requestTarget: '/only' }, options),
      ).toEqual({ allowed: false, reason: 'invalid_evidence' });
    });

    it(`${evidenceTag} reuses one evidence snapshot for ordered HTTPS then Origin`, () => {
      // Mutating residual fields after the call would be impossible for plain
      // snapshots; this pins the composition path still returns a coherent
      // remote + dual-stage decision from one evidence view.
      const decision = enforcePublisherStreamableHttpBoundary(publicHttpsStreamable(), options);
      expect(decision.allowed).toBe(true);
      if (decision.allowed) {
        expect(decision.remote).toBe(true);
        expect(decision.https).toMatchObject({ allowed: true, reason: 'https_endpoint' });
        expect(decision.origin).toMatchObject({ allowed: true, reason: 'origin_allowed' });
      }
    });
  });

  describe('createPublisherHttpBoundary (NestJS wiring)', () => {
    it(`${evidenceTag} wires publicOrigin into Origin allowlist composition`, () => {
      const boundary = createPublisherHttpBoundary({
        publicOrigin: 'https://app.example.test',
      });
      const decision = boundary.enforceStreamableHttpBoundary(publicHttpsStreamable());
      expect(decision.allowed).toBe(true);
      expect(boundary.deriveRemote(publicHttpsStreamable()).remote).toBe(true);
      expect(
        boundary.enforceHttps(
          publicHttpsStreamable({
            protocol: 'other',
            requestTarget: '/collections/c-1',
          }),
        ),
      ).toMatchObject({ allowed: true, reason: 'https_endpoint' });
    });

    it(`${evidenceTag} prefers explicit allowedOrigins over publicOrigin`, () => {
      const boundary = createPublisherHttpBoundary({
        publicOrigin: 'https://unused.example.test',
        allowedOrigins: ['https://app.example.test'],
      });
      expect(boundary.enforceOrigin(publicHttpsStreamable()).allowed).toBe(true);
      expect(
        boundary.enforceOrigin(
          publicHttpsStreamable({ origin: 'https://unused.example.test' }),
        ).allowed,
      ).toBe(false);
    });
  });
});
