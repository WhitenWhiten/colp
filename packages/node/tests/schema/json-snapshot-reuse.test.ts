import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import canonicalize from 'canonicalize';
import { describe, expect, it } from 'vitest';

import {
  ColpClient,
  type ClientCache,
  type ClientCacheEntry,
} from '../../src/client/index.js';
import { representationByteDiagnostics } from '../../src/client/representation-bytes.js';
import {
  createValidatorRegistry,
  parseIJson,
  validateWireDocument,
  type ValidatorRegistry,
} from '../../src/schema/index.js';
import { schemaValidationDiagnostics } from '../../src/schema/validation-diagnostics.js';
import { canonicalJsonUtf8ByteLength } from '../../src/shared/canonical-json-utf8-length.js';
import { utf8ByteLength } from '../../src/shared/utf8-length.js';
import { assembleSnapshotPagePayload } from '../../src/semantic/snapshot-page-assembly.js';
import { planPublicationSnapshotDelivery } from '../../src/server/index.js';
import { preparePublicationSnapshotWire } from '../../src/server/publication-snapshot-wire.js';
import { publicationReuseDiagnostics } from '../../src/server/publication-snapshot-reuse.js';
import { canonicalJsonDiagnostics } from '../../src/sync/canonical-json.js';
import { canonicalAuthoritativeEffectDigest } from '../../src/sync/canonical.js';
import { effectCanonicalMaterial } from '../../src/sync/effect-canonical-material.js';
import type { Snapshot } from '../../src/types/index.js';

const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const manifestUrl = 'https://alice.example/.well-known/collection-protocol';

function fixture(name: string): Record<string, any> {
  return JSON.parse(readFileSync(resolve(fixturesRoot, name), 'utf8')) as Record<string, any>;
}

function accept(value: unknown): { valid: true; issues: readonly [] } {
  void value;
  return { valid: true, issues: [] };
}

describe('validated JSON snapshot and byte reuse', () => {
  it('keeps the caller object for trusted success and reuses the first snapshot', () => {
    const validators = createValidatorRegistry();
    const value = { 'https://example.com/ext/marker': 'caller-owned' };
    const seen: unknown[] = [];
    schemaValidationDiagnostics.reset();

    const result = validateWireDocument(validators, 'extensions', value, (semanticValue) => {
      seen.push(semanticValue);
      return accept(semanticValue);
    });

    expect(result).toEqual({ valid: true, value });
    expect(seen).toEqual([value]);
    expect(Object.isFrozen(value)).toBe(false);
    expect(schemaValidationDiagnostics.boundaryWalks).toBe(1);
    expect(schemaValidationDiagnostics.boundaryReuses).toBeGreaterThanOrEqual(1);
    expect(schemaValidationDiagnostics.uniqueWalks).toBe(1);
    expect(schemaValidationDiagnostics.uniqueReuses).toBeGreaterThanOrEqual(1);
  });

  it('still boundary-checks a frozen caller object that has no proof', () => {
    const validators = createValidatorRegistry();
    const frozen = Object.freeze({ mode: 'publication' });
    schemaValidationDiagnostics.reset();

    const result = validators.validate('snapshot', frozen);

    expect(result.valid).toBe(false);
    expect(schemaValidationDiagnostics.boundaryWalks).toBeGreaterThan(0);
    expect(schemaValidationDiagnostics.boundaryReuses).toBe(0);
  });

  it('rejects accessors, depth, and oversized unique arrays', () => {
    const validators = createValidatorRegistry();
    const accessor = {};
    Object.defineProperty(accessor, 'marker', { enumerable: true, get: () => 'nope' });
    const accessorResult = validateWireDocument(validators, 'extensions', accessor, accept);
    expect(accessorResult).toMatchObject({
      valid: false,
      stage: 'structural',
      errors: [expect.objectContaining({ keyword: 'x-colp-boundary' })],
    });

    let deep: unknown = 'leaf';
    for (let index = 0; index < 130; index += 1) deep = { child: deep };
    expect(validateWireDocument(validators, 'extensions', deep, accept)).toMatchObject({
      valid: false,
      stage: 'structural',
    });

    const creators = Array.from({ length: 513 }, () => ({ name: 'a' }));
    const unique = validators.validate('node', { creators });
    expect(unique.valid).toBe(false);
    if (unique.valid) return;
    expect(unique.errors[0]).toEqual(expect.objectContaining({ keyword: 'maxItems' }));
  });

  it('rechecks an untrusted registry after mutation and does not reuse the first snapshot', () => {
    const delegate = createValidatorRegistry();
    const snapshot = fixture('collection-snapshot.json');
    const mutatedCandidate: ValidatorRegistry = {
      definitionNames: delegate.definitionNames,
      get: (name) => delegate.get(name),
      validate(_name, value: any) {
        value.generatedAt = '2026-02-30T12:00:00Z';
        return { valid: true, errors: [] };
      },
    };
    const candidateResult = validateWireDocument(mutatedCandidate, 'snapshot', snapshot, accept);
    expect(candidateResult).toMatchObject({ valid: false, stage: 'structural' });

    const aliased = fixture('collection-snapshot.json');
    const aliasedRegistry: ValidatorRegistry = {
      definitionNames: delegate.definitionNames,
      get: (name) => delegate.get(name),
      validate() {
        aliased.generatedAt = '2026-02-30T12:00:00Z';
        return { valid: true, errors: [] };
      },
    };
    schemaValidationDiagnostics.reset();
    const aliasResult = validateWireDocument(aliasedRegistry, 'snapshot', aliased, accept);

    expect(aliasResult).toMatchObject({ valid: false, stage: 'structural' });
    expect(schemaValidationDiagnostics.boundaryWalks).toBeGreaterThanOrEqual(2);
  });

  it('keeps untrusted success values detached from the caller object', () => {
    const delegate = createValidatorRegistry();
    const wrapper: ValidatorRegistry = {
      definitionNames: delegate.definitionNames,
      get: (name) => delegate.get(name),
      validate: (name, value) => delegate.validate(name, value),
    };
    const original = { 'https://example.com/ext/marker': 'caller-owned' };
    let semanticValue: unknown;
    const result = validateWireDocument(wrapper, 'extensions', original, (value) => {
      semanticValue = value;
      return accept(value);
    });

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.value).not.toBe(original);
    expect(result.value).toBe(semanticValue);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(original)).toBe(false);
  });

  it('hashes an effect digest separately from the full effect byte budget', () => {
    const effect = {
      effectDigest: 'sha-256=:abcdefghijklmnopqrstuvwxyz0123456789ABCDE=:',
      Z: 1,
      a: 2,
    };
    canonicalJsonDiagnostics.reset();
    const digest = canonicalAuthoritativeEffectDigest(effect);
    expect(canonicalJsonDiagnostics.snapshotWalks).toBe(1);

    canonicalJsonDiagnostics.reset();
    const material = effectCanonicalMaterial(effect);
    expect(material.digest).toBe(digest);
    expect(canonicalJsonDiagnostics.snapshotWalks).toBe(1);
    expect(canonicalJsonDiagnostics.encodes).toBe(1);

    const omitted = canonicalize({ Z: 1, a: 2 });
    expect(omitted).toBeTypeOf('string');
    expect(material.encodedEffect).not.toBe(omitted);
    expect(Buffer.byteLength(material.encodedEffect, 'utf8')).not.toBe(
      new TextEncoder().encode(omitted!).byteLength,
    );
    expect(material.encodedEffect).toContain('effectDigest');
    const expectedDigest = `sha-256=:${createHash('sha256').update(omitted!).digest('base64')}:`;
    expect(material.digest).toBe(expectedDigest);
  });

  it('counts canonical JSON bytes without building a different encoding', () => {
    const samples = [
      { Z: 1, a: 2 },
      { a: 2, Z: 1 },
      { nested: { b: 'é', a: [1, null, true, false] }, '键': '值' },
      { empty: {}, list: [[], [1, 2, 3]] },
      { sparse: [1, undefined, 3] },
    ];
    for (const sample of samples) {
      const canonical = canonicalize(sample);
      expect(canonical).toBeTypeOf('string');
      expect(canonicalJsonUtf8ByteLength(sample)).toBe(new TextEncoder().encode(canonical!).byteLength);
    }
    expect(canonicalJsonUtf8ByteLength({ Z: 1, a: 2 })).toBe(canonicalJsonUtf8ByteLength({ a: 2, Z: 1 }));
    expect(utf8ByteLength('é')).toBe(new TextEncoder().encode('é').byteLength);

    const page = fixture('collection-snapshot.json') as Snapshot;
    const exact = canonicalJsonUtf8ByteLength(page);
    expect(exact).toBe(new TextEncoder().encode(canonicalize(page)!).byteLength);
    if (exact === undefined) return;
    expect(assembleSnapshotPagePayload([page], { maxBytes: exact }).valid).toBe(true);
    const tight = assembleSnapshotPagePayload([page], { maxBytes: exact - 1 });
    expect(tight.valid).toBe(false);
    if (!tight.valid) expect(tight.issues[0]?.code).toBe('snapshot_assembly_byte_budget');
  });

  it('reuses delivery observations only for the same inspected snapshot', () => {
    const source = fixture('collection-snapshot.json');
    publicationReuseDiagnostics.reset();
    const first = planPublicationSnapshotDelivery({
      classification: 'static',
      query: {},
      snapshot: source,
    });
    expect(publicationReuseDiagnostics.deliveryWalks).toBe(1);
    expect(publicationReuseDiagnostics.projectionCensusWalks).toBe(1);

    const second = planPublicationSnapshotDelivery({
      classification: 'static',
      query: {},
      snapshot: first.snapshot,
    });
    expect(publicationReuseDiagnostics.deliveryWalks).toBe(1);
    expect(publicationReuseDiagnostics.deliveryReuses).toBe(1);
    expect(publicationReuseDiagnostics.projectionCensusReuses).toBe(1);
    expect(second.delivery).toBe(first.delivery);
    if (first.delivery === 'single-page' && second.delivery === 'single-page') {
      expect(second.metrics).toEqual(first.metrics);
    }

    publicationReuseDiagnostics.reset();
    const frozen = Object.freeze(structuredClone(source));
    planPublicationSnapshotDelivery({ classification: 'static', query: {}, snapshot: frozen });
    expect(publicationReuseDiagnostics.deliveryWalks).toBe(1);
    expect(publicationReuseDiagnostics.deliveryReuses).toBe(0);
  });

  it('revalidates a changed publication projection and does not trust a frozen caller snapshot', () => {
    const source = fixture('collection-snapshot.json');
    publicationReuseDiagnostics.reset();
    const prepared = preparePublicationSnapshotWire(source);
    expect(publicationReuseDiagnostics.schemaValidations).toBe(1);
    expect(publicationReuseDiagnostics.projectionValidations).toBe(1);
    expect(publicationReuseDiagnostics.outboundReuses).toBe(0);

    publicationReuseDiagnostics.reset();
    const again = preparePublicationSnapshotWire(prepared);
    expect(again).toBe(prepared);
    expect(publicationReuseDiagnostics.outboundReuses).toBe(1);
    expect(publicationReuseDiagnostics.schemaValidations).toBe(0);
    expect(publicationReuseDiagnostics.projectionValidations).toBe(0);

    publicationReuseDiagnostics.reset();
    const reprojected = preparePublicationSnapshotWire(prepared, {
      publicExtensionNamespaces: ['https://example.com/ext/audited'],
    });
    expect(reprojected).not.toBe(prepared);
    expect(publicationReuseDiagnostics.outboundReuses).toBe(0);
    expect(publicationReuseDiagnostics.projectionValidations).toBe(1);

    publicationReuseDiagnostics.reset();
    const frozen = Object.freeze(structuredClone(source));
    preparePublicationSnapshotWire(frozen);
    expect(publicationReuseDiagnostics.schemaReuses).toBe(0);
    expect(publicationReuseDiagnostics.schemaValidations).toBe(1);
    preparePublicationSnapshotWire(frozen);
    expect(publicationReuseDiagnostics.outboundReuses).toBe(0);
    expect(publicationReuseDiagnostics.schemaValidations).toBe(2);
  });

  it('reuses one byte count for a 304 representation and returns a detached value', async () => {
    const manifest = readFileSync(resolve(fixturesRoot, 'public-manifest.json'), 'utf8');
    const directory = readFileSync(resolve(fixturesRoot, 'collection-directory.json'), 'utf8');
    let cachedEntry: ClientCacheEntry | undefined;
    const cache: ClientCache = {
      delete() {},
      get(key) {
        return key.includes('/.well-known/') ? undefined : cachedEntry;
      },
      set(key, value) {
        if (!key.includes('/.well-known/')) cachedEntry = value;
      },
    };
    let directoryCalls = 0;
    const fetch = async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') {
        return new Response(manifest, { headers: { 'Content-Type': 'application/json', ETag: '"manifest"' } });
      }
      directoryCalls += 1;
      return directoryCalls === 1
        ? new Response(directory, { headers: { 'Content-Type': 'application/json', ETag: '"directory"' } })
        : new Response(null, { status: 304, headers: { ETag: '"directory"' } });
    };
    const client = new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      cache,
    });
    representationByteDiagnostics.reset();
    const first = await client.getDirectory();
    const measuresAfterFirst = representationByteDiagnostics.measures;
    const second = await client.getDirectory();

    expect(representationByteDiagnostics.measures).toBe(measuresAfterFirst + 1);
    expect(representationByteDiagnostics.reuses).toBe(1);
    expect(second).not.toBe(cachedEntry?.representation);
    expect(second).not.toBe(first);
    expect(Object.isFrozen(cachedEntry?.representation)).toBe(true);
    expect(Object.isFrozen(second)).toBe(false);
    first.collections[0]!.title = 'CALLER-TAMPER';
    expect((cachedEntry?.representation as { collections: Array<{ title: string }> }).collections[0]?.title)
      .not.toBe('CALLER-TAMPER');
    expect(second.collections[0]?.title).not.toBe('CALLER-TAMPER');
  });

  it('still rejects escaped surrogates and duplicate I-JSON keys', () => {
    expect(() => parseIJson('"\\ud800"')).toThrow(/unpaired UTF-16 surrogate/u);
    expect(() => parseIJson('{"id":1,"id":2}')).toThrow(/duplicate member/u);
    expect(() => parseIJson('{"name":1,"na\\u006de":2}')).toThrow(/duplicate member/u);
    expect(parseIJson('{"a":1}', { maxDepth: 1, maxMembers: 1 })).toEqual({ a: 1 });
    expect(() => parseIJson('{"a":{"b":1}}', { maxDepth: 1 })).toThrow(/max_depth|nesting depth/u);
  });
});
