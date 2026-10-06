import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import {
  DPOP_PROOF_MAX_AGE_SECONDS,
  enforceSenderConstraint,
} from '../../src/security/index.js';
import type {
  SenderConstraintInput,
  SenderConstraintPorts,
} from '../../src/security/index.js';

const evidence = '[evidence:security.sender-constraint]';
const observedAt = 1_800_000_000;
const method = 'POST';
const targetUri = 'https://publisher.example.test/admin/keys';
const accessToken = 'access-token-secret-Aa9._~-';
const proof = 'dpop-proof-secret-Bb8._~-';
const certificateSecret = 'certificate-secret-Cc7._~-';
const accessTokenHash = createHash('sha256').update(accessToken).digest('base64url');
const jwkThumbprint = createHash('sha256').update('public-jwk').digest('base64url');
const certificateThumbprint = createHash('sha256').update('public-certificate').digest('base64url');
const jti = 'proof-id-7f466cc0';

type VerifiedProof = {
  valid: true;
  method: string;
  targetUri: string;
  accessTokenHash: string;
  jwkThumbprint: string;
  jti: string;
  issuedAt: number;
};

function verified(overrides: Partial<VerifiedProof> = {}): VerifiedProof {
  return {
    valid: true,
    method,
    targetUri,
    accessTokenHash,
    jwkThumbprint,
    jti,
    issuedAt: observedAt,
    ...overrides,
  };
}

function makePorts(overrides: {
  verify?: (...args: unknown[]) => unknown;
  consume?: (...args: unknown[]) => unknown;
  now?: (...args: unknown[]) => unknown;
} = {}) {
  return {
    dpopProof: {
      verify: vi.fn(overrides.verify ?? (async () => verified())),
    },
    clock: {
      now: vi.fn(overrides.now ?? (() => observedAt)),
    },
    dpopReplay: {
      consume: vi.fn(overrides.consume ?? (async () => true)),
    },
  };
}

function dpopInput(overrides: Record<string, unknown> = {}): SenderConstraintInput {
  return {
    operation: 'key',
    location: 'remote',
    applicability: 'applicable',
    mode: 'dpop',
    accessToken: { value: accessToken, cnf: { jkt: jwkThumbprint } },
    dpop: { proof, method, targetUri },
    ...overrides,
  } as SenderConstraintInput;
}

function mtlsInput(overrides: Record<string, unknown> = {}): SenderConstraintInput {
  return {
    operation: 'acl',
    location: 'remote',
    applicability: 'applicable',
    mode: 'mtls',
    accessToken: { value: accessToken, cnf: { 'x5t#S256': certificateThumbprint } },
    mtls: {
      source: 'tls-session',
      authenticated: true,
      presentedCertificateThumbprintSha256: certificateThumbprint,
    },
    ...overrides,
  } as SenderConstraintInput;
}

function enforce(input: SenderConstraintInput, ports = makePorts()) {
  return enforceSenderConstraint(ports as unknown as SenderConstraintPorts, input);
}

async function expectDenied(input: SenderConstraintInput, ports = makePorts()): Promise<void> {
  await expect(enforce(input, ports)).resolves.toMatchObject({
    allowed: false,
    disposition: 'denied',
  });
}

describe(`${evidence} SEC-0010 sender-constrained publisher administration`, () => {
  it(`${evidence} accepts a DPoP-bound token only after authoritative proof verification and atomic replay consumption`, async () => {
    const ports = makePorts();
    await expect(enforce(dpopInput(), ports)).resolves.toMatchObject({
      allowed: true,
      disposition: 'enforced',
      mode: 'dpop',
    });
    expect(ports.dpopProof.verify).toHaveBeenCalledOnce();
    expect(ports.clock.now).toHaveBeenCalledOnce();
    expect(ports.dpopReplay.consume).toHaveBeenCalledOnce();
    const verificationCheck = ports.dpopProof.verify.mock.calls[0]?.[0];
    const replayCheck = ports.dpopReplay.consume.mock.calls[0]?.[0];
    expect(Object.isFrozen(verificationCheck)).toBe(true);
    expect(Object.isFrozen(replayCheck)).toBe(true);
    expect(JSON.stringify(verificationCheck)).not.toContain(accessToken);
  });

  it(`${evidence} accepts an authenticated mTLS token with an exact certificate confirmation binding`, async () => {
    const ports = makePorts();
    await expect(enforce(mtlsInput(), ports)).resolves.toMatchObject({
      allowed: true,
      disposition: 'enforced',
      mode: 'mtls',
    });
    expect(ports.dpopProof.verify).not.toHaveBeenCalled();
    expect(ports.clock.now).not.toHaveBeenCalled();
    expect(ports.dpopReplay.consume).not.toHaveBeenCalled();
  });

  it(`${evidence} requires a sender constraint for all four high-risk remote administration classes`, async () => {
    for (const operation of ['key', 'acl', 'public-exposure', 'purge'] as const) {
      await expect(enforce(dpopInput({ operation }))).resolves.toMatchObject({
        allowed: true,
        disposition: 'enforced',
      });
      await expectDenied(dpopInput({ operation, mode: 'not_applicable' }));
    }
  });

  it(`${evidence} permits only explicit not_applicable decisions for other or local operations`, async () => {
    for (const input of [
      { operation: 'other', location: 'remote', applicability: 'not_applicable', mode: 'not_applicable' },
      { operation: 'key', location: 'local', applicability: 'not_applicable', mode: 'not_applicable' },
    ]) {
      const ports = makePorts();
      await expect(enforce(input as SenderConstraintInput, ports)).resolves.toEqual({
        allowed: true,
        disposition: 'not_applicable',
        applicability: 'not_applicable',
        mode: 'not_applicable',
        reason: 'not_applicable',
      });
      expect(ports.dpopProof.verify).not.toHaveBeenCalled();
      expect(ports.dpopReplay.consume).not.toHaveBeenCalled();
    }
  });

  it(`${evidence} rejects applicability mismatches instead of letting callers opt out`, async () => {
    for (const input of [
      dpopInput({ operation: 'key', location: 'remote', applicability: 'not_applicable', mode: 'not_applicable' }),
      dpopInput({ operation: 'other', location: 'remote', applicability: 'applicable' }),
      dpopInput({ operation: 'key', location: 'local', applicability: 'applicable' }),
      dpopInput({ operation: 'other', location: 'local', applicability: 'not_applicable', mode: 'dpop' }),
    ]) {
      await expectDenied(input);
    }
  });

  it(`${evidence} rejects Bearer-only, absent-mode, and simultaneous DPoP plus mTLS evidence`, async () => {
    const base = dpopInput() as unknown as Record<string, unknown>;
    const { mode: _mode, ...withoutMode } = base;
    const { dpop: _dpop, ...bearerOnly } = withoutMode;
    for (const input of [
      { ...bearerOnly, mode: 'dpop' },
      withoutMode,
      {
        ...base,
        mtls: mtlsInput().mtls,
      },
      {
        ...(mtlsInput() as unknown as Record<string, unknown>),
        dpop: dpopInput().dpop,
      },
    ]) {
      await expectDenied(input as unknown as SenderConstraintInput);
    }
  });

  it(`${evidence} requires canonical uppercase DPoP methods and rejects lowercase or the wrong method`, async () => {
    await expect(enforce(dpopInput({ dpop: { proof, method: 'PATCH', targetUri } }), makePorts({
      verify: async () => verified({ method: 'PATCH' }),
    }))).resolves.toMatchObject({ allowed: true });

    for (const [requestedMethod, verifiedMethod] of [
      ['post', 'post'],
      ['POST', 'PATCH'],
      ['PATCH', 'POST'],
    ] as const) {
      await expectDenied(
        dpopInput({ dpop: { proof, method: requestedMethod, targetUri } }),
        makePorts({ verify: async () => verified({ method: verifiedMethod }) }),
      );
    }
  });

  it(`${evidence} binds DPoP to the exact URI authority without host case or default-port normalization`, async () => {
    for (const confusedUri of [
      'https://PUBLISHER.example.test/admin/keys',
      'https://publisher.example.test:443/admin/keys',
      'https://publisher.example.test./admin/keys',
      'https://publisher.example.test.evil.test/admin/keys',
      'https://user@publisher.example.test/admin/keys',
    ]) {
      await expectDenied(dpopInput({ dpop: { proof, method, targetUri: confusedUri } }));
      await expectDenied(dpopInput(), makePorts({
        verify: async () => verified({ targetUri: confusedUri }),
      }));
    }
  });

  it(`${evidence} rejects DPoP path, query, fragment, and percent-encoding URI confusion`, async () => {
    for (const confusedUri of [
      'https://publisher.example.test/admin//keys',
      'https://publisher.example.test/admin/keys?rotate=true',
      `${targetUri}?`,
      `${targetUri}#fragment`,
      `${targetUri}#`,
      'https://publisher.example.test/admin/%6beys',
      'https://publisher.example.test/admin/%2e/keys',
      'https://publisher.example.test/admin%2fkeys',
      `https://publisher.example.test/admin/\uD800keys`,
    ]) {
      await expectDenied(dpopInput({ dpop: { proof, method, targetUri: confusedUri } }));
      await expectDenied(dpopInput(), makePorts({
        verify: async () => verified({ targetUri: confusedUri }),
      }));
    }
  });

  it(`${evidence} requires the verifier to report the actual SHA-256 ath for the supplied access token`, async () => {
    expect(accessTokenHash).toHaveLength(43);
    const ports = makePorts();
    await expect(enforce(dpopInput(), ports)).resolves.toMatchObject({ allowed: true });
    expect(ports.dpopProof.verify).toHaveBeenCalledWith({
      proof,
      method,
      targetUri,
      accessTokenHash,
    });
    for (const candidate of [
      createHash('sha256').update(`${accessToken}x`).digest('base64url'),
      createHash('sha512').update(accessToken).digest('base64url'),
      accessTokenHash.toUpperCase(),
    ]) {
      await expectDenied(dpopInput(), makePorts({
        verify: async () => verified({ accessTokenHash: candidate }),
      }));
    }
  });

  it(`${evidence} binds token cnf.jkt to the proof key thumbprint exactly`, async () => {
    for (const candidate of [
      createHash('sha256').update('other-jwk').digest('base64url'),
      jwkThumbprint.toUpperCase(),
      `${jwkThumbprint}=`,
    ]) {
      await expectDenied(dpopInput(), makePorts({
        verify: async () => verified({ jwkThumbprint: candidate }),
      }));
      await expectDenied(dpopInput({
        accessToken: { value: accessToken, cnf: { jkt: candidate } },
      }));
    }
  });

  it(`${evidence} rejects empty, control-bearing, and overlong DPoP jti values`, async () => {
    for (const candidate of ['', 'proof\u0000id', 'proof\r\nInjected: yes', 'x'.repeat(257)]) {
      await expectDenied(dpopInput(), makePorts({
        verify: async () => verified({ jti: candidate }),
      }));
    }
  });

  it(`${evidence} enforces future, stale, inclusive boundary, and safe-integer DPoP iat rules`, async () => {
    for (const issuedAt of [observedAt, observedAt - DPOP_PROOF_MAX_AGE_SECONDS]) {
      await expect(enforce(dpopInput(), makePorts({
        verify: async () => verified({ issuedAt }),
      }))).resolves.toMatchObject({ allowed: true });
    }
    for (const issuedAt of [
      observedAt + 1,
      observedAt - DPOP_PROOF_MAX_AGE_SECONDS - 1,
      1.5,
      Number.NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      await expectDenied(dpopInput(), makePorts({
        verify: async () => verified({ issuedAt }),
      }));
    }
  });

  it(`${evidence} fails closed when the DPoP proof verifier returns false, throws, rejects, or returns nonboolean claims`, async () => {
    const validGetter = vi.fn(() => true);
    const accessorResult = Object.defineProperty({}, 'valid', { get: validGetter });
    const failures = [
      () => Promise.resolve({ valid: false }),
      () => { throw new Error(`invalid ${proof}`); },
      () => Promise.reject(new Error(`rejected ${proof}`)),
      () => Promise.resolve({ ...verified(), valid: 'yes' }),
      () => Promise.resolve(true),
      () => Promise.resolve(null),
      () => Promise.resolve(new Proxy(verified(), {})),
      () => Promise.resolve(accessorResult),
    ];
    for (const verify of failures) {
      await expectDenied(dpopInput(), makePorts({ verify }));
    }
    expect(validGetter).not.toHaveBeenCalled();

    const residualGetter = vi.fn(() => accessToken);
    const invalid = Object.defineProperty({ valid: false }, 'accessTokenHash', {
      get: residualGetter,
    });
    await expect(enforce(dpopInput(), makePorts({
      verify: () => Promise.resolve(invalid),
    }))).resolves.toMatchObject({ allowed: false, reason: 'proof_invalid' });
    expect(residualGetter).not.toHaveBeenCalled();
  });

  it(`${evidence} rejects thenables and hostile Promise objects without invoking attacker-controlled then`, async () => {
    const then = vi.fn(() => Promise.resolve(verified()));
    const thenable = { then };
    await expectDenied(dpopInput(), makePorts({ verify: () => thenable }));
    expect(then).not.toHaveBeenCalled();

    const native = Promise.resolve(verified());
    const hostile = new Proxy(native, {
      get(_target, key) {
        if (key === 'then') throw new Error('hostile then getter');
        return Reflect.get(_target, key);
      },
    });
    await expectDenied(dpopInput(), makePorts({ verify: () => hostile }));

    const crossRealmPromise = runInNewContext('Promise.resolve(value)', { value: verified() });
    await expect(enforce(dpopInput(), makePorts({
      verify: () => crossRealmPromise,
    }))).resolves.toMatchObject({ allowed: true });

    const subclassThen = vi.fn(() => Promise.prototype.then);
    class HostilePromise<T> extends Promise<T> {}
    Object.defineProperty(HostilePromise.prototype, 'then', {
      configurable: true,
      get: subclassThen,
    });
    const subclass = new HostilePromise<VerifiedProof>((resolve) => resolve(verified()));
    const subclassPorts = makePorts();
    subclassPorts.dpopProof.verify = (() => subclass) as typeof subclassPorts.dpopProof.verify;
    await expectDenied(dpopInput(), subclassPorts);
    expect(subclassThen).not.toHaveBeenCalled();
  });

  it(`${evidence} captures the clock before await but observes freshness only after proof verification`, async () => {
    let resolveVerification!: (result: VerifiedProof) => void;
    const pending = new Promise<VerifiedProof>((resolve) => {
      resolveVerification = resolve;
    });
    const ports = makePorts({ verify: () => pending });
    const decision = enforce(dpopInput(), ports);

    expect(ports.clock.now).not.toHaveBeenCalled();
    resolveVerification(verified({ issuedAt: observedAt - DPOP_PROOF_MAX_AGE_SECONDS - 1 }));
    await expect(decision).resolves.toMatchObject({
      allowed: false,
      reason: 'replay_or_stale',
    });
    expect(ports.clock.now).toHaveBeenCalledOnce();
    expect(ports.dpopReplay.consume).not.toHaveBeenCalled();
  });

  it(`${evidence} consumes the authoritative thumbprint and jti exactly once with the complete replay window`, async () => {
    const ports = makePorts();
    await expect(enforce(dpopInput(), ports)).resolves.toMatchObject({ allowed: true });
    expect(ports.dpopReplay.consume).toHaveBeenCalledOnce();
    expect(ports.dpopReplay.consume).toHaveBeenCalledWith({
      jti,
      jwkThumbprint,
      issuedAt: observedAt,
      observedAt,
      maxAgeSeconds: DPOP_PROOF_MAX_AGE_SECONDS,
    });
  });

  it(`${evidence} rejects a replay when the atomic consumer reports the proof was already consumed`, async () => {
    const ports = makePorts({ consume: async () => false });
    await expect(enforce(dpopInput(), ports)).resolves.toMatchObject({
      allowed: false,
      disposition: 'denied',
    });
    expect(ports.dpopReplay.consume).toHaveBeenCalledOnce();
  });

  it(`${evidence} fails closed when replay consumption throws, rejects, or returns a nonboolean`, async () => {
    for (const consume of [
      () => { throw new Error(`replay ${jti}`); },
      () => Promise.reject(new Error(`replay ${jti}`)),
      () => Promise.resolve('consumed'),
      () => Promise.resolve(null),
    ]) {
      await expectDenied(dpopInput(), makePorts({ consume }));
    }
  });

  it(`${evidence} snapshots inputs and all port methods before await to prevent verification TOCTOU`, async () => {
    let resolveVerification!: (result: VerifiedProof) => void;
    const pending = new Promise<VerifiedProof>((resolve) => {
      resolveVerification = resolve;
    });
    const ports = makePorts({ verify: () => pending });
    const originalConsume = ports.dpopReplay.consume;
    const input = dpopInput();
    const decision = enforce(input, ports);

    (input.dpop as { method: string; targetUri: string }).method = 'DELETE';
    (input.dpop as { method: string; targetUri: string }).targetUri = 'https://attacker.test/';
    ports.clock.now = vi.fn(() => observedAt + 99_999);
    ports.dpopReplay.consume = vi.fn(async () => false);
    resolveVerification(verified());

    await expect(decision).resolves.toMatchObject({ allowed: true });
    expect(originalConsume).toHaveBeenCalledOnce();
    expect(ports.dpopReplay.consume).not.toHaveBeenCalled();
  });

  it(`${evidence} supports class, custom-prototype, and null-prototype port receivers`, async () => {
    class ProofPort {
      readonly marker = 'proof';
      async verify(): Promise<VerifiedProof> {
        if (this.marker !== 'proof') throw new Error('lost proof receiver');
        return verified();
      }
    }
    class ClockPort {
      readonly marker = 'clock';
      now(): number {
        if (this.marker !== 'clock') throw new Error('lost clock receiver');
        return observedAt;
      }
    }
    class ReplayPort {
      readonly marker = 'replay';
      async consume(): Promise<boolean> {
        if (this.marker !== 'replay') throw new Error('lost replay receiver');
        return true;
      }
    }
    const customProof = Object.create({ verify: async function (this: { marker: string }) {
      return this.marker === 'custom' ? verified() : { valid: false };
    } }) as { marker: string };
    customProof.marker = 'custom';
    const nullReplay = Object.assign(Object.create(null) as object, {
      consume: async function (this: { marker: string }) { return this.marker === 'null'; },
      marker: 'null',
    });

    for (const ports of [
      { dpopProof: new ProofPort(), clock: new ClockPort(), dpopReplay: new ReplayPort() },
      { dpopProof: customProof, clock: new ClockPort(), dpopReplay: nullReplay },
    ]) {
      await expect(enforceSenderConstraint(
        ports as unknown as SenderConstraintPorts,
        dpopInput(),
      )).resolves.toMatchObject({ allowed: true });
    }
  });

  it(`${evidence} never inherits DPoP verifier, clock, or replay methods from Object.prototype pollution`, async () => {
    const polluted = {
      verify: vi.fn(async () => verified()),
      now: vi.fn(() => observedAt),
      consume: vi.fn(async () => true),
    };
    const prototype = Object.prototype as Record<string, unknown>;
    try {
      prototype.verify = polluted.verify;
      prototype.now = polluted.now;
      prototype.consume = polluted.consume;
      await expect(enforceSenderConstraint({
        dpopProof: {},
        clock: {},
        dpopReplay: {},
      } as unknown as SenderConstraintPorts, dpopInput())).resolves.toMatchObject({ allowed: false });
      expect(polluted.verify).not.toHaveBeenCalled();
      expect(polluted.now).not.toHaveBeenCalled();
      expect(polluted.consume).not.toHaveBeenCalled();
    } finally {
      delete prototype.verify;
      delete prototype.now;
      delete prototype.consume;
    }
  });

  it(`${evidence} rejects mTLS evidence when the TLS session did not authenticate the client`, async () => {
    await expectDenied(mtlsInput({
      mtls: {
        source: 'tls-session',
        authenticated: false,
        presentedCertificateThumbprintSha256: certificateThumbprint,
      },
    }));
  });

  it(`${evidence} rejects malformed, padded, case-changed, or mismatched mTLS certificate thumbprints`, async () => {
    for (const candidate of [
      '',
      'short',
      `${certificateThumbprint}=`,
      certificateThumbprint.toUpperCase(),
      createHash('sha256').update('other-certificate').digest('base64url'),
    ]) {
      await expectDenied(mtlsInput({
        mtls: {
          source: 'tls-session',
          authenticated: true,
          presentedCertificateThumbprintSha256: candidate,
        },
      }));
    }
  });

  it(`${evidence} rejects cnf source confusion between DPoP and mTLS bindings`, async () => {
    for (const input of [
      dpopInput({ accessToken: { value: accessToken, cnf: { 'x5t#S256': certificateThumbprint } } }),
      dpopInput({
        accessToken: { value: accessToken, cnf: { jkt: jwkThumbprint, 'x5t#S256': certificateThumbprint } },
      }),
      mtlsInput({ accessToken: { value: accessToken, cnf: { jkt: jwkThumbprint } } }),
      mtlsInput({
        accessToken: { value: accessToken, cnf: { jkt: jwkThumbprint, 'x5t#S256': certificateThumbprint } },
      }),
      dpopInput({
        accessToken: { value: accessToken, cnf: { jkt: jwkThumbprint, extra: certificateThumbprint } },
      }),
      mtlsInput({
        accessToken: { value: accessToken, cnf: { 'x5t#S256': certificateThumbprint, extra: jwkThumbprint } },
      }),
      mtlsInput({
        mtls: {
          source: 'proxy-assertion',
          authenticated: true,
          presentedCertificateThumbprintSha256: certificateThumbprint,
        },
      }),
      mtlsInput({
        mtls: {
          source: 'request-header',
          authenticated: true,
          presentedCertificateThumbprintSha256: certificateThumbprint,
        },
      }),
    ]) {
      await expectDenied(input);
    }
  });

  it(`${evidence} fails closed on Proxy, accessor, and dynamically mutating sender-constraint input`, async () => {
    const modeGetter = vi.fn(() => 'dpop');
    const accessorInput = Object.defineProperty(dpopInput(), 'mode', {
      enumerable: true,
      get: modeGetter,
    });
    await expectDenied(accessorInput);
    expect(modeGetter).not.toHaveBeenCalled();

    const nestedGetter = vi.fn(() => proof);
    const dynamicDpop = Object.defineProperty({ method, targetUri }, 'proof', {
      enumerable: true,
      get: nestedGetter,
    });
    await expectDenied(dpopInput({ dpop: dynamicDpop }));
    expect(nestedGetter).not.toHaveBeenCalled();

    const proxied = new Proxy(dpopInput(), {
      getOwnPropertyDescriptor() {
        throw new Error(`proxy ${accessToken}`);
      },
    });
    await expectDenied(proxied);

    const residualGetter = vi.fn(() => ({ value: accessToken }));
    for (const base of [
      { operation: 'other', location: 'remote', applicability: 'not_applicable', mode: 'not_applicable' },
      { operation: 'key', location: 'local', applicability: 'not_applicable', mode: 'not_applicable' },
    ]) {
      const residual = Object.defineProperty({ ...base }, 'accessToken', {
        enumerable: true,
        get: residualGetter,
      });
      await expectDenied(residual as SenderConstraintInput);
    }
    expect(residualGetter).not.toHaveBeenCalled();

    await expectDenied(dpopInput({
      accessToken: { value: 'bad\uD800token', cnf: { jkt: jwkThumbprint } },
    }));
  });

  it(`${evidence} returns frozen fixed decisions and never exposes access tokens, proofs, or certificate secrets`, async () => {
    const decisions = [
      await enforce(dpopInput()),
      await enforce(mtlsInput({
        mtls: {
          source: 'tls-session',
          authenticated: false,
          presentedCertificateThumbprintSha256: certificateSecret,
        },
      })),
      await enforce(dpopInput(), makePorts({
        verify: () => { throw new Error(`${accessToken} ${proof} ${certificateSecret}`); },
      })),
      await enforce(dpopInput(), makePorts({
        consume: () => Promise.reject(new Error(`${accessToken} ${proof} ${certificateSecret}`)),
      })),
    ];
    for (const decision of decisions) {
      expect(Object.isFrozen(decision)).toBe(true);
      expect(Object.keys(decision).sort()).toEqual(
        decision.allowed
          ? ['allowed', 'applicability', 'disposition', 'mode', 'reason']
          : ['allowed', 'disposition', 'reason'],
      );
      expect(JSON.stringify(decision)).not.toContain(accessToken);
      expect(JSON.stringify(decision)).not.toContain(proof);
      expect(JSON.stringify(decision)).not.toContain(certificateSecret);
      expect(JSON.stringify(decision)).not.toContain(jti);
      expect(JSON.stringify(decision)).not.toContain(jwkThumbprint);
      expect(JSON.stringify(decision)).not.toContain(certificateThumbprint);
    }
  });
});
