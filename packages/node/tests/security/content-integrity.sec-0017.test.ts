import { describe, expect, it } from 'vitest';

import { emitContentIntegrityHeaders } from '../../src/security/index.js';
import type { ContentIntegrityInput } from '../../src/security/index.js';

const evidence = '[evidence:security.content-integrity-header-emission]';
const targetUri = 'https://publisher.example.test/collections/c-1/snapshot';
const body = 'stable public snapshot body';
const signatureBytes = new Uint8Array(64);
const signatureBase64 = `${'A'.repeat(86)}==`;

function request(overrides: Partial<ContentIntegrityInput> = {}): ContentIntegrityInput {
  return {
    resourceType: 'snapshot',
    visibility: 'public',
    method: 'GET',
    targetUri,
    contentType: 'application/json',
    body,
    signature: Uint8Array.from(signatureBytes),
    algorithm: 'ed25519',
    keySource: 'jwks',
    keyId: 'current',
    rotation: { activeKeyId: 'current', retainedKeyIds: ['old'] },
    ...overrides,
  };
}

function reject(input: unknown): void {
  expect(emitContentIntegrityHeaders(input)).toEqual({ allowed: false, reason: 'invalid_input' });
}

function headers(input: ContentIntegrityInput): Readonly<Record<string, string>> {
  const result = emitContentIntegrityHeaders(input);
  if (!('headers' in result)) throw new Error('expected integrity headers');
  return result.headers;
}

describe(`${evidence} SEC-0017 public Snapshot and Feed content integrity`, () => {
  it(`${evidence} emits Content-Digest, Signature-Input, and Signature for a public Snapshot`, () => {
    const result = emitContentIntegrityHeaders(request());
    expect(result).toMatchObject({ allowed: true, disposition: 'headers_emitted', applicability: 'applicable', reason: 'content_integrity' });
    expect(Object.keys(headers(request()))).toEqual(['Content-Digest', 'Signature-Input', 'Signature']);
  });

  it(`${evidence} emits the same three exact headers for a public Feed`, () => {
    const input = request({ resourceType: 'feed', targetUri: 'https://publisher.example.test/feed' });
    expect(emitContentIntegrityHeaders(input)).toMatchObject({ allowed: true });
    expect(Object.keys(headers(input))).toEqual(['Content-Digest', 'Signature-Input', 'Signature']);
  });

  it(`${evidence} binds Signature-Input to fixed method, target, digest, and content-type components`, () => {
    expect(headers(request())['Signature-Input']).toBe('sig1=("@method" "@target-uri" "content-digest" "content-type");keyid="current";alg="ed25519"');
    expect(headers(request())['Content-Digest']).toMatch(/^sha-256=:[A-Za-z0-9+/]{43}=:$/u);
    expect(headers(request())['Signature']).toBe(`sig1=:${signatureBase64}:`);
  });

  it(`${evidence} requires a valid HTTP method and an absolute HTTPS target`, () => {
    reject(request({ method: 'GET /snapshot' }));
    reject(request({ targetUri: 'http://publisher.example.test/collections/c-1/snapshot' }));
    reject(request({ targetUri: '/collections/c-1/snapshot' }));
  });

  it(`${evidence} requires a valid media content type and fixed base components`, () => {
    expect(emitContentIntegrityHeaders(request({ contentType: 'text/plain' })).allowed).toBe(true);
    reject(request({ contentType: 'text/ plain' }));
    reject(request({ contentType: 'application' }));
    reject(request({ contentType: 'application/json\u0000' }));
  });

  it(`${evidence} computes RFC9530 digest over exact body bytes and preserves base64 boundaries`, () => {
    expect(headers(request())['Content-Digest']).toBe('sha-256=:BCqIyzZf5HOGmepdVEY3vse3/m6n0FeZYJCFefv4DgE=:');
    const first = headers(request({ body: 'one' }))['Content-Digest'];
    const second = headers(request({ body: 'two' }))['Content-Digest'];
    expect(headers(request({ body: new TextEncoder().encode(body) }))['Content-Digest']).toBe('sha-256=:BCqIyzZf5HOGmepdVEY3vse3/m6n0FeZYJCFefv4DgE=:');
    expect(first).toMatch(/^sha-256=:[A-Za-z0-9+/]{43}=:$/u);
    expect(second).toMatch(/^sha-256=:[A-Za-z0-9+/]{43}=:$/u);
    expect(first).not.toBe(second);
  });

  it(`${evidence} requires exactly 64 raw Ed25519 signature bytes and base64-encodes 88 characters`, () => {
    expect(headers(request())['Signature']).toMatch(/^sig1=:[A-Za-z0-9+/]{86}==:$/u);
    reject(request({ signature: new Uint8Array(63) }));
    reject(request({ signature: new Uint8Array(65) }));
  });

  it(`${evidence} permits only the Ed25519 algorithm`, () => {
    reject(request({ algorithm: 'rsa-pss' as never }));
  });

  it(`${evidence} accepts a JWKS key source with an active key`, () => {
    expect(emitContentIntegrityHeaders(request({ keySource: 'jwks' })).allowed).toBe(true);
  });

  it(`${evidence} accepts a Manifest key source with an active key`, () => {
    expect(emitContentIntegrityHeaders(request({ keySource: 'manifest' })).allowed).toBe(true);
  });

  it(`${evidence} retains old keys during rotation while signing with the active key`, () => {
    const input = request({ keyId: 'next', rotation: { activeKeyId: 'next', retainedKeyIds: ['current', 'old'] } });
    expect(emitContentIntegrityHeaders(input)).toMatchObject({ allowed: true });
    expect(headers(input)['Signature-Input']).toContain('keyid="next"');
  });

  it(`${evidence} rejects empty, duplicate, or active-repeated rotation identifiers`, () => {
    reject(request({ keyId: '', rotation: { activeKeyId: '', retainedKeyIds: ['old'] } }));
    reject(request({ rotation: { activeKeyId: 'current', retainedKeyIds: [] } }));
    reject(request({ rotation: { activeKeyId: 'current', retainedKeyIds: ['current', 'old'] } }));
    reject(request({ rotation: { activeKeyId: 'current', retainedKeyIds: ['old', 'old'] } }));
  });

  it(`${evidence} rejects CRLF, controls, and non-ASCII in method, target, content type, and key identifiers`, () => {
    reject(request({ method: 'GET\r\nX-Evil: yes' }));
    reject(request({ targetUri: `${targetUri}\u0000` }));
    reject(request({ contentType: 'application/json\u0000' }));
    reject(request({ keyId: 'caf\u00e9' }));
  });

  it(`${evidence} rejects pre-quoted and whitespace-padded HTTP tokens`, () => {
    reject(request({ method: ' GET' }));
    reject(request({ method: 'GET ' }));
    reject(request({ keyId: '"current"' }));
    reject(request({ keyId: 'current\t' }));
  });

  it(`${evidence} returns explicit not_applicable for non-public resources without reading residual fields`, () => {
    let reads = 0;
    const input = {
      resourceType: 'snapshot',
      visibility: 'private',
      get method(): string { reads += 1; throw new Error('method must not be read'); },
      get targetUri(): string { reads += 1; throw new Error('target must not be read'); },
      get body(): string { reads += 1; throw new Error('body must not be read'); },
    };
    expect(emitContentIntegrityHeaders(input)).toMatchObject({ allowed: true, disposition: 'not_applicable', applicability: 'not_applicable', reason: 'not_applicable' });
    expect(reads).toBe(0);
  });

  it(`${evidence} returns explicit not_applicable for an explicitly other resource type`, () => {
    expect(emitContentIntegrityHeaders({ resourceType: 'other', visibility: 'public' })).toMatchObject({ allowed: true, disposition: 'not_applicable', reason: 'not_applicable' });
  });

  it(`${evidence} fails closed for Proxy, custom-prototype, accessor, inherited, and sparse inputs`, () => {
    reject(new Proxy(request(), {}));
    const custom = Object.create({ resourceType: 'snapshot' });
    Object.assign(custom, request());
    reject(custom);
    const accessor = request();
    Object.defineProperty(accessor, 'body', { get: () => body, enumerable: true });
    reject(accessor);
    reject(request({ rotation: { activeKeyId: 'current', retainedKeyIds: Object.assign([], { 1: 'old', length: 2 }) } }));
  });

  it(`${evidence} rejects extra symbol and dynamically-added fields`, () => {
    const symbolInput = request();
    Object.defineProperty(symbolInput, Symbol('extra'), { value: 'unexpected' });
    reject(symbolInput);
    const dynamic = request() as unknown as Record<string, unknown>;
    dynamic.extra = 'unexpected';
    reject(dynamic);
  });

  it(`${evidence} freezes the decision and all emitted headers`, () => {
    const result = emitContentIntegrityHeaders(request());
    expect(Object.isFrozen(result)).toBe(true);
    if (!('headers' in result)) throw new Error('expected headers');
    expect(Object.isFrozen(result.headers)).toBe(true);
    expect(() => ((result.headers as Record<string, string>).Signature = 'tampered')).toThrow(TypeError);
  });

  it(`${evidence} does not echo secret key IDs, body bytes, or private URL material`, () => {
    const secret = 'private-key-body-token';
    const result = emitContentIntegrityHeaders(request({ body: secret, targetUri: `${targetUri}?token=${secret}` }));
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it(`${evidence} emits no SEC-0018 stale, mutable-signature, history, or extra route fields`, () => {
    const result = emitContentIntegrityHeaders(request());
    expect(result).not.toHaveProperty('stale');
    expect(result).not.toHaveProperty('historyUri');
    expect(result).not.toHaveProperty('mutableSignature');
    if ('headers' in result) expect(Object.keys(result.headers)).toEqual(['Content-Digest', 'Signature-Input', 'Signature']);
  });

  it(`${evidence} does not perform JWKS or Manifest network access`, () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; throw new Error('network access is forbidden'); }) as typeof fetch;
    try {
      expect(emitContentIntegrityHeaders(request({ keySource: 'jwks' })).allowed).toBe(true);
      expect(emitContentIntegrityHeaders(request({ keySource: 'manifest' })).allowed).toBe(true);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
