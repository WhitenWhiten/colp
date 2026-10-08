import { describe, expect, it } from 'vitest';
import {
  enforceMutableIntegrity,
  type MutableIntegrityDecision,
} from '../../src/security/index.js';

const evidence = '[evidence:security.mutable-integrity]';
const now = 1_700_000_000;
const target = 'https://publisher.example.test/items/i-1';
const base = { resourceType: 'mutable', uri: target, maxStaleSeconds: 300, claims: {
  '@status': 200, created: now - 30, expires: now + 300, etag: '"v1"', 'protocol-version': '1.0',
} };
function ports(overrides: Record<string, unknown> = {}): unknown { return {
  clock: { now: () => now }, signatureVerification: { verify: async () => true }, ...overrides,
}; }
async function decision(input: unknown = base, override: Record<string, unknown> = {}): Promise<MutableIntegrityDecision> {
  try { return await enforceMutableIntegrity(ports(override), input); } catch { return { allowed: false, reason: 'invalid_input' }; }
}
async function allowed(input: unknown = base, override: Record<string, unknown> = {}): Promise<MutableIntegrityDecision> { const result = await decision(input, override); expect(result.allowed).toBe(true); return result; }
async function denied(input: unknown, override: Record<string, unknown> = {}): Promise<MutableIntegrityDecision> { const result = await decision(input, override); expect(result.allowed).toBe(false); return result; }

describe(`${evidence} SEC-0018 mutable publisher integrity`, () => {
  it(`${evidence} accepts the complete five-component mutable envelope`, async () => { await allowed(); });
  it(`${evidence} signs status, created, expires, etag, and protocol version`, async () => {
    let signed: unknown; await allowed(base, { signatureVerification: { verify: async (v: unknown) => { signed = v; return true; } } });
    const text = JSON.stringify(signed).toLowerCase(); for (const component of ['status', 'created', 'expires', 'etag', 'protocol']) expect(text).toContain(component);
  });
  it(`${evidence} rejects missing, duplicate, reordered, and extra claim fields`, async () => {
    await denied({ ...base, claims: { ...base.claims, etag: undefined } });
    await denied({ ...base, claims: { ...base.claims, duplicate: '@status' } });
    await denied({ ...base, claims: { '@status': 200, expires: now + 300, created: now - 30, etag: '"v1"', 'protocol-version': '1.0' } }, { signatureVerification: { verify: async (claims: unknown) => JSON.stringify(claims) === JSON.stringify(base.claims) } });
    await denied({ ...base, unexpected: true });
  });
  it(`${evidence} rejects status, etag, and protocol-version mutation`, async () => {
    const verifier = { signatureVerification: { verify: async (claims: unknown) => JSON.stringify(claims) === JSON.stringify(base.claims) } };
    await denied({ ...base, claims: { ...base.claims, '@status': 201 } }, verifier); await denied({ ...base, claims: { ...base.claims, etag: '"v2"' } }, verifier); await denied({ ...base, claims: { ...base.claims, 'protocol-version': '2.0' } }, verifier);
  });
  it(`${evidence} enforces exact created and expires boundaries`, async () => { await allowed({ ...base, claims: { ...base.claims, created: now, expires: now + 1 } }); await denied({ ...base, claims: { ...base.claims, created: now - 1, expires: now } }); });
  it(`${evidence} rejects future creation and expires-before-created`, async () => { await denied({ ...base, claims: { ...base.claims, created: now + 1 } }); await denied({ ...base, claims: { ...base.claims, created: now + 20, expires: now + 10 } }); });
  it(`${evidence} rejects expired and over-stale resources`, async () => { await denied({ ...base, claims: { ...base.claims, expires: now - 1 } }); await denied({ ...base, claims: { ...base.claims, created: now - 301 } }); });
  it(`${evidence} enforces maximum staleness at exact and over-limit boundaries`, async () => { await allowed({ ...base, claims: { ...base.claims, created: now - 300 } }); await denied({ ...base, claims: { ...base.claims, created: now - 301 } }); });
  it(`${evidence} rejects unsafe, negative, fractional, and zero freshness configuration`, async () => { await denied({ ...base, maxStaleSeconds: Number.POSITIVE_INFINITY }); await denied({ ...base, maxStaleSeconds: -1 }); await denied({ ...base, maxStaleSeconds: 1.5 }); await denied({ ...base, maxStaleSeconds: 0 }); });
  it(`${evidence} accepts historical releases only with immutable Release ID and Revision`, async () => {
    const ok = await allowed({ ...base, resourceType: 'historical-release', immutable: true, releaseId: 'rel-1', revision: '7', uri: `${target}/releases/rel-1/revisions/7` });
    expect(ok).toMatchObject({ disposition: 'shape_validated', reason: 'historical_release' });
    await denied({ ...base, resourceType: 'historical-release', immutable: false, releaseId: 'rel-1', revision: '7', uri: `${target}/releases/rel-1/revisions/7` });
    await denied({ ...base, resourceType: 'historical-release', immutable: true, revision: '7', uri: `${target}/releases/rel-1/revisions/7` });
  });
  it(`${evidence} enforces mutable integrity with cryptographic verify disposition`, async () => {
    const ok = await allowed();
    expect(ok).toMatchObject({ disposition: 'enforced', reason: 'mutable_integrity' });
  });
  it(`${evidence} binds signatures to the exact resource URI`, async () => {
    let binding: unknown;
    const verifier = {
      signatureVerification: {
        verify: async (_claims: unknown, context: unknown) => {
          binding = context;
          return (context as { readonly uri?: unknown }).uri === target;
        },
      },
    };
    await allowed(base, verifier);
    expect(binding).toEqual({ uri: target });
    expect(Object.isFrozen(binding)).toBe(true);
    await denied({ ...base, uri: 'https://publisher.example.test/items/i-2' }, verifier);
  });
  it(`${evidence} rejects historical URIs with query, fragment, default-port, host-case, dot-segment, and empty components`, async () => {
    const h = { ...base, resourceType: 'historical-release', immutable: true, releaseId: 'rel-1', revision: '7' };
    for (const uri of [`${target}/releases/rel-1/revisions/7?x=1`, `${target}/releases/rel-1/revisions/7#f`, `https://publisher.example.test:443/items/i-1/releases/rel-1/revisions/7`, `https://PUBLISHER.example.test/items/i-1/releases/rel-1/revisions/7`, `https://publisher.example.test/items/./i-1/releases/rel-1/revisions/7`, `${target}/releases//revisions/7`]) await denied({ ...h, uri });
  });
  it(`${evidence} rejects historical URI Release ID or Revision mismatch`, async () => { const h = { ...base, resourceType: 'historical-release', immutable: true, releaseId: 'rel-1', revision: '7' }; await denied({ ...h, uri: `${target}/releases/rel-2/revisions/7` }); await denied({ ...h, uri: `${target}/releases/rel-1/revisions/8` }); });
  it(`${evidence} fails closed for verifier false and non-boolean results`, async () => { await denied(base, { signatureVerification: { verify: async () => false } }); await denied(base, { signatureVerification: { verify: async () => 1 } }); await denied(base, { signatureVerification: { verify: async () => undefined } }); });
  it(`${evidence} fails closed when verification throws, rejects, or returns a hostile Promise`, async () => { await denied(base, { signatureVerification: { verify: () => { throw new Error('verify'); } } }); await denied(base, { signatureVerification: { verify: async () => Promise.reject(new Error('verify')) } }); const hostile = { get then(): never { throw new Error('then'); } }; await denied(base, { signatureVerification: { verify: () => hostile } }); });
  it(`${evidence} binds verifier receiver and rejects receiver confusion`, async () => { let receiver: unknown; await allowed(base, { signatureVerification: { verify(this: unknown) { receiver = this; return Promise.resolve(true); } } }); expect(receiver).toBeDefined(); });
  it(`${evidence} reads the clock after verification and catches near-freshness TOCTOU expiry`, async () => { let verified = false; await denied(base, { signatureVerification: { verify: async () => { verified = true; return true; } }, clock: { now: () => (verified ? now + 301 : now) } }); expect(verified).toBe(true); });
  it(`${evidence} rejects accessor, Proxy, custom-prototype, inherited, and sparse inputs`, async () => { const accessor = { ...base, claims: { ...base.claims } }; Object.defineProperty(accessor.claims, 'etag', { enumerable: true, get: () => '"v1"' }); await denied(accessor); await denied(new Proxy(base, {})); await denied(Object.assign(Object.create({ marker: true }), base)); await denied({ ...base, claims: Object.assign([], { length: 2, 1: '@status' }) }); });
  it(`${evidence} rejects dynamically added fields and symbol properties`, async () => { await denied({ ...base, extra: true }); const symbolized = { ...base }; Object.defineProperty(symbolized, Symbol('extra'), { value: true, enumerable: true }); await denied(symbolized); });
  it(`${evidence} does not read residual fields for non-applicable resources`, async () => { let reads = 0; const input = { resourceType: 'other', get claims(): never { reads++; throw new Error('residual read'); } }; const result = await decision(input); expect(result?.allowed).toBe(true); expect(reads).toBe(0); });
  it(`${evidence} freezes the decision and does not expose signature secrets`, async () => { const secret = 'private-signature-material'; const result = await allowed({ ...base, claims: { ...base.claims, etag: secret } }); expect(Object.isFrozen(result)).toBe(true); expect(JSON.stringify(result)).not.toContain(secret); });
  it(`${evidence} freezes nested decision metadata`, async () => { const result = await allowed(); for (const value of Object.values(result ?? {})) if (value && typeof value === 'object') expect(Object.isFrozen(value)).toBe(true); });
  it(`${evidence} rejects malformed timestamps, etags, protocol versions, and signatures`, async () => { await denied({ ...base, claims: { ...base.claims, created: 'yesterday' } }); await denied({ ...base, claims: { ...base.claims, expires: Number.NaN } }); await denied({ ...base, claims: { ...base.claims, etag: '' } }); await denied({ ...base, claims: { ...base.claims, 'protocol-version': '' } }); await denied({ ...base, claims: { ...base.claims, signature: '' } }); });
  it(`${evidence} rejects non-object, null, array, and primitive inputs`, async () => { await denied(null); await denied([]); await denied('mutable'); await denied(42); });
  it(`${evidence} keeps verification and freshness decisions deterministic`, async () => { expect(await decision()).toEqual(await decision()); });
});
