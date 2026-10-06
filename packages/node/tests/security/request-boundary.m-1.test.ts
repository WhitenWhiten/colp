import { describe, expect, it } from 'vitest';

/**
 * M-1 / H-1: request-boundary composition wiring.
 *
 * Closes the adapter-trusted `remote` / `applicability` skip path for the
 * HTTPS (SEC-0015) + Origin (SEC-0016) MUST guards by deriving remote /
 * applicability only from trusted transport evidence (`networkExposure` +
 * transport scheme / TLS terminator), then composing:
 *
 *   1. HTTPS enforcement for public/private (remote) exposure
 *   2. Origin allowlist for streamable-http after HTTPS succeeds
 *
 * NestJS factory (H-1 wiring residual) must expose a runtime object whose
 * methods invoke this composition — not type-only imports of security ports.
 *
 * Production API (`src/security/request-boundary.ts`, re-exported from
 * `src/security/index.ts` + NestJS factory from `src/nestjs/index.ts`):
 *   - TrustedTransportEvidence
 *   - deriveRemoteApplicability(evidence)
 *   - enforceHttpsFromTransport(evidence)
 *   - enforceOriginFromTransport(evidence, allowedOrigins)
 *   - enforcePublisherStreamableHttpBoundary(evidence, { allowedOrigins })
 *   - createPublisherHttpBoundary(options) → { deriveRemote, enforceHttps,
 *       enforceOrigin, enforceStreamableHttpBoundary }
 */

import {
  deriveRemoteApplicability,
  enforceHttpsFromTransport,
  enforceOriginFromTransport,
  enforcePublisherStreamableHttpBoundary,
  type TrustedTransportEvidence,
} from '../../src/security/index.js';
import { createPublisherHttpBoundary } from '../../src/nestjs/index.js';

const evidence = '[evidence:security.request-boundary]';

const publicOrigin = 'https://publisher.example.test';
const absoluteHttpsTarget = 'https://publisher.example.test/collections/c-1';
const originFormTarget = '/collections/c-1';
const allowlist = [publicOrigin] as const;
const boundaryOptions = { allowedOrigins: allowlist };

function trustedEvidence(
  overrides: Partial<TrustedTransportEvidence> = {},
): TrustedTransportEvidence {
  return {
    networkExposure: 'public',
    tlsTerminated: true,
    transportScheme: 'https',
    protocol: 'other',
    requestTarget: absoluteHttpsTarget,
    ...overrides,
  };
}

function publicStreamable(
  overrides: Partial<TrustedTransportEvidence> = {},
): TrustedTransportEvidence {
  return trustedEvidence({
    protocol: 'streamable-http',
    origin: publicOrigin,
    requestTarget: absoluteHttpsTarget,
    ...overrides,
  });
}

describe(`${evidence} M-1/H-1 request-boundary composition`, () => {
  describe(`${evidence} HTTPS derivation from networkExposure + transport`, () => {
    it(`${evidence} public + TLS terminator + https absolute target → HTTPS allowed`, () => {
      const decision = enforceHttpsFromTransport(trustedEvidence());

      expect(decision).toEqual({
        allowed: true,
        disposition: 'enforced',
        location: 'remote',
        reason: 'https_endpoint',
      });
      expect(Object.isFrozen(decision)).toBe(true);
      expect(JSON.stringify(decision)).not.toContain(absoluteHttpsTarget);
    });

    it(`${evidence} public + TLS + origin-form target → HTTPS allowed`, () => {
      const decision = enforceHttpsFromTransport(
        trustedEvidence({ requestTarget: originFormTarget }),
      );
      expect(decision).toMatchObject({
        allowed: true,
        disposition: 'enforced',
        reason: 'https_endpoint',
      });
    });

    it.each([
      [
        'public + http scheme without TLS terminator',
        trustedEvidence({
          tlsTerminated: false,
          transportScheme: 'http',
          requestTarget: originFormTarget,
        }),
      ],
      [
        'public + https scheme but http absolute target',
        trustedEvidence({
          tlsTerminated: false,
          transportScheme: 'https',
          requestTarget: 'http://publisher.example.test/collections/c-1',
        }),
      ],
      [
        'public + http scheme and http absolute target',
        trustedEvidence({
          tlsTerminated: false,
          transportScheme: 'http',
          requestTarget: 'http://publisher.example.test/collections/c-1',
        }),
      ],
    ])(`${evidence} %s → HTTPS denied`, (_label, input) => {
      const decision = enforceHttpsFromTransport(input);

      expect(decision.allowed).toBe(false);
      expect(JSON.stringify(decision)).not.toContain('publisher.example.test');
    });

    it(`${evidence} private exposure is remote and HTTPS-applicable`, () => {
      const derived = deriveRemoteApplicability(
        trustedEvidence({ networkExposure: 'private' }),
      );
      expect(derived).toEqual({ remote: true, applicability: 'applicable' });

      const decision = enforceHttpsFromTransport(
        trustedEvidence({
          networkExposure: 'private',
          requestTarget: originFormTarget,
        }),
      );
      expect(decision).toMatchObject({
        allowed: true,
        disposition: 'enforced',
        reason: 'https_endpoint',
      });
    });

    it(`${evidence} loopback exposure → HTTPS not_applicable (non-remote short-circuit)`, () => {
      const decision = enforceHttpsFromTransport(
        trustedEvidence({
          networkExposure: 'loopback',
          tlsTerminated: false,
          transportScheme: 'http',
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

    it(`${evidence} invalid networkExposure (e.g. local) fails closed — not a remote skip`, () => {
      // Production allowlist is loopback | private | public only.
      const decision = enforceHttpsFromTransport({
        networkExposure: 'local',
        tlsTerminated: true,
        transportScheme: 'https',
        protocol: 'other',
        requestTarget: absoluteHttpsTarget,
      });
      expect(decision).toMatchObject({ allowed: false, reason: 'invalid_input' });
    });
  });

  describe(`${evidence} Origin composition for streamable-http after HTTPS`, () => {
    it(`${evidence} streamable-http + public remote + matching Origin → origin allowed after https`, () => {
      const decision = enforcePublisherStreamableHttpBoundary(
        publicStreamable(),
        boundaryOptions,
      );

      expect(decision.allowed).toBe(true);
      if (decision.allowed) {
        expect(decision.remote).toBe(true);
        expect(decision.https).toMatchObject({
          allowed: true,
          reason: 'https_endpoint',
        });
        expect(decision.origin).toMatchObject({
          allowed: true,
          reason: 'origin_allowed',
        });
      }
      expect(JSON.stringify(decision)).not.toContain(publicOrigin);
    });

    it(`${evidence} streamable-http + public remote + bad Origin → denied`, () => {
      const decision = enforcePublisherStreamableHttpBoundary(
        publicStreamable({ origin: 'https://attacker.example.test' }),
        boundaryOptions,
      );

      expect(decision).toMatchObject({
        allowed: false,
        reason: 'origin_denied',
        remote: true,
      });
      if (!decision.allowed) {
        expect(decision.https).toMatchObject({ allowed: true });
        expect(decision.origin).toMatchObject({ allowed: false });
      }
      expect(JSON.stringify(decision)).not.toContain('attacker.example.test');
    });

    it(`${evidence} streamable-http + public remote + missing Origin → denied`, () => {
      const decision = enforcePublisherStreamableHttpBoundary(
        trustedEvidence({
          protocol: 'streamable-http',
          requestTarget: absoluteHttpsTarget,
          // origin omitted
        }),
        boundaryOptions,
      );

      expect(decision).toMatchObject({
        allowed: false,
        reason: 'origin_denied',
      });
    });

    it(`${evidence} non-streamable protocol → origin not_applicable after HTTPS`, () => {
      const decision = enforcePublisherStreamableHttpBoundary(
        trustedEvidence({
          protocol: 'other',
          origin: publicOrigin,
        }),
        boundaryOptions,
      );

      expect(decision.allowed).toBe(true);
      if (decision.allowed) {
        expect(decision.https).toMatchObject({
          allowed: true,
          reason: 'https_endpoint',
        });
        expect(decision.origin).toMatchObject({
          allowed: true,
          disposition: 'not_applicable',
          reason: 'not_applicable',
        });
      }
    });

    it(`${evidence} public HTTPS without streamable-http protocol does not require Origin`, () => {
      const originDecision = enforceOriginFromTransport(trustedEvidence(), allowlist);
      expect(originDecision).toMatchObject({
        allowed: true,
        reason: 'not_applicable',
      });

      const httpsDecision = enforceHttpsFromTransport(trustedEvidence());
      expect(httpsDecision).toMatchObject({
        allowed: true,
        reason: 'https_endpoint',
      });
    });
  });

  describe(`${evidence} no free-form remote override on composition path`, () => {
    it(`${evidence} rejects caller remote:false when networkExposure is public`, () => {
      // Unknown residual keys fail closed — cannot smuggle remote:false.
      const httpsDecision = enforceHttpsFromTransport({
        networkExposure: 'public',
        tlsTerminated: false,
        transportScheme: 'http',
        protocol: 'other',
        requestTarget: originFormTarget,
        remote: false,
        applicability: 'not_applicable',
      } as unknown as TrustedTransportEvidence);

      expect(httpsDecision).toMatchObject({ allowed: false, reason: 'invalid_input' });

      const boundaryDecision = enforcePublisherStreamableHttpBoundary(
        {
          networkExposure: 'public',
          tlsTerminated: true,
          transportScheme: 'https',
          protocol: 'streamable-http',
          requestTarget: absoluteHttpsTarget,
          origin: publicOrigin,
          remote: false,
        } as unknown as TrustedTransportEvidence,
        boundaryOptions,
      );
      expect(boundaryDecision).toMatchObject({
        allowed: false,
        reason: 'invalid_evidence',
      });
    });

    it(`${evidence} composition input surface does not require a caller remote field`, () => {
      const input = trustedEvidence();
      expect(Object.keys(input)).not.toContain('remote');
      expect(Object.keys(input)).not.toContain('applicability');

      const derived = deriveRemoteApplicability(input);
      expect(derived.remote).toBe(true);
      expect(derived.applicability).toBe('applicable');

      const decision = enforceHttpsFromTransport(input);
      expect(decision).toMatchObject({
        allowed: true,
        reason: 'https_endpoint',
      });
    });

    it(`${evidence} public exposure still enforces HTTPS when residual remote is forged with not_applicable`, () => {
      // Classic M-1 footgun on leaf guards: remote + not_applicable skip.
      // On the composition path unknown residual keys fail closed; never allow.
      const decision = enforceHttpsFromTransport({
        networkExposure: 'public',
        tlsTerminated: false,
        transportScheme: 'http',
        protocol: 'other',
        requestTarget: originFormTarget,
        remote: true,
        applicability: 'not_applicable',
      } as unknown as TrustedTransportEvidence);

      expect(decision.allowed).toBe(false);
      expect(decision).not.toMatchObject({ reason: 'not_applicable' });
    });

    it(`${evidence} loopback cannot be forced into remote skip via residual remote-looking fields`, () => {
      const decision = enforceHttpsFromTransport({
        networkExposure: 'loopback',
        tlsTerminated: false,
        transportScheme: 'http',
        protocol: 'other',
        requestTarget: 'http://127.0.0.1/x',
        remote: true,
        applicability: 'not_applicable',
      } as unknown as TrustedTransportEvidence);

      // Fail closed on unknown residual keys (preferred) — never allow with
      // HTTPS "enforced" after smuggling remote while applicability was forged.
      expect(decision).toMatchObject({ allowed: false, reason: 'invalid_input' });
    });

    it(`${evidence} deriveRemoteApplicability rejects self-asserted remote keys`, () => {
      expect(() =>
        deriveRemoteApplicability({
          remote: false,
          networkExposure: 'public',
          tlsTerminated: true,
          transportScheme: 'https',
          protocol: 'other',
          requestTarget: '/',
        }),
      ).toThrow(/unknown fields/i);
    });
  });

  describe(`${evidence} NestJS factory runtime wiring (H-1)`, () => {
    it(`${evidence} createPublisherHttpBoundary returns runtime methods that invoke the boundary`, () => {
      const boundary = createPublisherHttpBoundary({
        allowedOrigins: [publicOrigin],
      });

      expect(typeof boundary.deriveRemote).toBe('function');
      expect(typeof boundary.enforceHttps).toBe('function');
      expect(typeof boundary.enforceOrigin).toBe('function');
      expect(typeof boundary.enforceStreamableHttpBoundary).toBe('function');

      const input = publicStreamable();
      const fromFactory = boundary.enforceStreamableHttpBoundary(input);
      const fromCompose = enforcePublisherStreamableHttpBoundary(input, boundaryOptions);

      expect(fromFactory.allowed).toBe(true);
      expect(fromCompose.allowed).toBe(true);
      if (fromFactory.allowed && fromCompose.allowed) {
        expect(fromFactory.remote).toBe(fromCompose.remote);
        expect(fromFactory.https.reason).toBe(fromCompose.https.reason);
        expect(fromFactory.origin.reason).toBe(fromCompose.origin.reason);
      }

      expect(boundary.deriveRemote(input)).toEqual({
        remote: true,
        applicability: 'applicable',
      });
      expect(
        boundary.enforceHttps(
          trustedEvidence({ protocol: 'other', requestTarget: originFormTarget }),
        ),
      ).toMatchObject({ allowed: true, reason: 'https_endpoint' });
    });

    it(`${evidence} NestJS factory denies public streamable-http with a bad Origin`, () => {
      const boundary = createPublisherHttpBoundary({ allowedOrigins: [publicOrigin] });

      const decision = boundary.enforceStreamableHttpBoundary(
        publicStreamable({ origin: 'https://attacker.example.test' }),
      );

      expect(decision).toMatchObject({
        allowed: false,
        reason: 'origin_denied',
      });
      expect(JSON.stringify(decision)).not.toContain('attacker.example.test');
    });

    it(`${evidence} NestJS factory does not honor smuggled remote:false on evidence`, () => {
      const boundary = createPublisherHttpBoundary({ allowedOrigins: [publicOrigin] });

      const decision = boundary.enforceStreamableHttpBoundary({
        networkExposure: 'public',
        tlsTerminated: false,
        transportScheme: 'http',
        protocol: 'streamable-http',
        requestTarget: originFormTarget,
        origin: publicOrigin,
        remote: false,
        applicability: 'not_applicable',
      } as unknown as TrustedTransportEvidence);

      // M-1: public + smuggled remote:false must not short-circuit as not_applicable allow.
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason === 'invalid_evidence' || decision.reason === 'https_denied').toBe(
          true,
        );
      }
    });

    it(`${evidence} NestJS module exports createPublisherHttpBoundary as a runtime factory`, async () => {
      const nest = await import('../../src/nestjs/index.js');
      expect(typeof nest.createPublisherHttpBoundary).toBe('function');

      const boundary = nest.createPublisherHttpBoundary({ publicOrigin });
      expect(boundary).toEqual(
        expect.objectContaining({
          deriveRemote: expect.any(Function),
          enforceHttps: expect.any(Function),
          enforceOrigin: expect.any(Function),
          enforceStreamableHttpBoundary: expect.any(Function),
        }),
      );
    });
  });
});
