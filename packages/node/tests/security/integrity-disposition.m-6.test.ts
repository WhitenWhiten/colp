import { describe, expect, it } from 'vitest';

import * as security from '../../src/security/index.js';
import type { ContentIntegrityInput } from '../../src/security/index.js';

/**
 * M-6 / L-1: honesty of integrity helper dispositions.
 *
 * Content integrity is emit-only (hash body + package caller-supplied 64-byte
 * signature into RFC 9530 / 9421 headers). It must not report `enforced` or
 * imply cryptographic verification succeeded.
 *
 * Historical releases only validate immutability + Release ID / Revision URI
 * shape — disposition must be `shape_validated`, not `enforced`.
 *
 * Mutable resources that pass an injected verifying port remain truly
 * `enforced`.
 */

const evidence = '[evidence:security.integrity-disposition]';

const targetUri = 'https://publisher.example.test/collections/c-1/snapshot';
const body = 'stable public snapshot body';
/** Zero-filled 64-byte buffer — shape-valid Ed25519 length, not a real signature. */
const zeroSignature = new Uint8Array(64);
const zeroSignatureBase64 = `${'A'.repeat(86)}==`;

const mutableTarget = 'https://publisher.example.test/items/i-1';
const now = 1_700_000_000;

function publicSnapshot(overrides: Partial<ContentIntegrityInput> = {}): ContentIntegrityInput {
  return {
    resourceType: 'snapshot',
    visibility: 'public',
    method: 'GET',
    targetUri,
    contentType: 'application/json',
    body,
    signature: Uint8Array.from(zeroSignature),
    algorithm: 'ed25519',
    keySource: 'jwks',
    keyId: 'current',
    rotation: { activeKeyId: 'current', retainedKeyIds: ['old'] },
    ...overrides,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf('object');
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

function successHeaders(result: unknown): Readonly<Record<string, string>> {
  const record = asRecord(result);
  expect(record.allowed).toBe(true);
  expect(record).toHaveProperty('headers');
  const headers = record.headers;
  expect(headers).toBeTypeOf('object');
  expect(headers).not.toBeNull();
  return headers as Readonly<Record<string, string>>;
}

type MutableCall = (ports: unknown, input: unknown) => Promise<unknown>;
const enforceMutable = security.enforceMutableIntegrity as unknown as MutableCall;

function mutablePorts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clock: { now: () => now },
    signatureVerification: { verify: async () => true },
    ...overrides,
  };
}

const mutableBase = {
  resourceType: 'mutable' as const,
  uri: mutableTarget,
  maxStaleSeconds: 300,
  claims: {
    '@status': 200,
    created: now - 30,
    expires: now + 300,
    etag: '"v1"',
    'protocol-version': '1.0',
  },
};

const historicalInput = {
  resourceType: 'historical-release' as const,
  immutable: true,
  releaseId: 'rel-1',
  revision: '7',
  uri: `${mutableTarget}/releases/rel-1/revisions/7`,
};

describe(`${evidence} M-6 content integrity emit-only disposition`, () => {
  it(`${evidence} emitContentIntegrityHeaders on a valid public snapshot returns headers_emitted, not enforced`, () => {
    const result = asRecord(security.emitContentIntegrityHeaders(publicSnapshot()));

    expect(result.allowed).toBe(true);
    expect(result.disposition).toBe('headers_emitted');
    expect(result.disposition).not.toBe('enforced');
    expect(result.applicability).toBe('applicable');
    expect(result.reason).toBe('content_integrity');
  });

  it(`${evidence} emits Content-Digest, Signature-Input, and Signature with digest algorithm shape only (no crypto-verify claim)`, () => {
    const result = security.emitContentIntegrityHeaders(publicSnapshot());
    const headers = successHeaders(result);

    // Key presence only — three integrity header names, no extra route fields.
    expect(Object.keys(headers).sort()).toEqual(
      ['Content-Digest', 'Signature', 'Signature-Input'].sort(),
    );

    // RFC 9530 sha-256 digest framing; assert algorithm token + base64 envelope shape.
    const contentDigest = headers['Content-Digest'];
    expect(contentDigest).toBeDefined();
    expect(contentDigest).toMatch(/^sha-256=:[A-Za-z0-9+/]+=*:$/u);
    expect(contentDigest!.startsWith('sha-256=:')).toBe(true);

    // RFC 9421 component list + alg token — packaging only, not verification success.
    expect(headers['Signature-Input']).toContain('alg="ed25519"');
    expect(headers['Signature-Input']).toContain('keyid="current"');
    expect(headers['Signature']).toMatch(/^sig1=:[A-Za-z0-9+/=]+:$/u);

    // Explicit non-claims: this path packages caller bytes; it does not verify.
    expect(result).not.toHaveProperty('verified');
    expect(result).not.toHaveProperty('signatureValid');
    expect(asRecord(result).disposition).toBe('headers_emitted');
  });

  it(`${evidence} zero-filled 64-byte signature still yields headers_emitted (emit-only contract; not crypto success)`, () => {
    // Documented contract: any 64 raw bytes (including all zeros) are accepted
    // for header emission. Passing zeros proves we do not cryptographically
    // validate the signature material — only its length/shape.
    const zeroed = publicSnapshot({ signature: new Uint8Array(64) });
    const result = asRecord(security.emitContentIntegrityHeaders(zeroed));
    const headers = successHeaders(result);

    expect(result.disposition).toBe('headers_emitted');
    expect(result.disposition).not.toBe('enforced');
    expect(headers['Signature']).toBe(`sig1=:${zeroSignatureBase64}:`);

    // Sanity: zeros base64 is the well-known all-A padding form, not a "valid sig" claim.
    expect(zeroSignature.every((byte) => byte === 0)).toBe(true);
  });

  it(`${evidence} exports only names that describe emit-only behavior`, () => {
    expect(typeof security.emitContentIntegrityHeaders).toBe('function');
    expect(typeof security.serializeContentIntegrity).toBe('function');
    expect(security).not.toHaveProperty('enforceContentIntegrity');
  });
});

describe(`${evidence} L-1 historical-release shape_validated disposition`, () => {
  it(`${evidence} historical release path returns shape_validated, not enforced`, async () => {
    const result = asRecord(await enforceMutable(mutablePorts(), historicalInput));

    expect(result.allowed).toBe(true);
    expect(result.disposition).toBe('shape_validated');
    expect(result.disposition).not.toBe('enforced');
    expect(result.applicability).toBe('applicable');
    expect(result.reason).toBe('historical_release');
  });
});

describe(`${evidence} mutable integrity remains enforced when verify port succeeds`, () => {
  it(`${evidence} mutable resource with verifying port returning true still returns enforced`, async () => {
    let verifiedClaims: unknown;
    const ports = mutablePorts({
      signatureVerification: {
        verify: async (claims: unknown) => {
          verifiedClaims = claims;
          return true;
        },
      },
    });

    const result = asRecord(await enforceMutable(ports, mutableBase));

    expect(result.allowed).toBe(true);
    expect(result.disposition).toBe('enforced');
    expect(result.applicability).toBe('applicable');
    expect(result.reason).toBe('mutable_integrity');
    // Port was actually consulted — this path is real enforcement, not packaging.
    expect(verifiedClaims).toMatchObject({
      '@status': 200,
      etag: '"v1"',
    });
  });
});
