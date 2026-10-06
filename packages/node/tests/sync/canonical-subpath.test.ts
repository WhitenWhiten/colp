import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as syncApi from '../../src/sync/index.js';
import * as canonicalApi from '../../src/sync/canonical.js';
import {
  canonicalAuthoritativeEffectDigest,
  canonicalAuthoritativeEffectPageDigest,
  canonicalAuthoritativeMemberDigest,
  canonicalOperationDigest,
  encodeCanonicalJson,
  expandAuthoritativeEffectPageUrl,
} from '../../src/sync/canonical.js';
import type { Operation } from '../../src/types/index.js';
import expectedCorpus from '../fixtures/sync-canonical-digest-corpus.json' with { type: 'json' };
import {
  CANONICAL_DIGEST_CORPUS_COUNT,
  buildCanonicalDigestCorpus,
  digestCorpusCase,
} from './canonical-digest-corpus-cases.js';

// The report inventory recognizes versioned requirements while each release
// certificate remains bound to its own protocol registry.
const evidence = '[evidence:sync.canonical-subpath]';
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

const historicalPull = JSON.parse(
  readFileSync(join(packageRoot, 'fixtures/protocol/examples/sync-pull-v02.json'), 'utf8'),
) as {
  readonly events: readonly [{
    readonly operation: Operation;
    readonly effect: {
      readonly operationDigest: string;
      readonly effectDigest: string;
    };
  }];
};

const sampleOperation = {
  opId: 'op_create_01',
  replicaId: 'replica_source',
  sequence: 1,
  collectionId: 'collection-1',
  type: 'create_node',
  baseRevision: null,
  occurredAt: '2026-07-27T00:00:00Z',
  payload: { parentId: 'root-1', afterId: null, beforeId: null, node: { kind: 'folder', title: 'Created' } },
} as const;

describe(`browser-safe ./sync/canonical identity ${evidence}`, () => {
  it('keeps production ./sync digest helpers identical to ./sync/canonical', () => {
    expect(syncApi.canonicalOperationDigest).toBe(canonicalApi.canonicalOperationDigest);
    expect(syncApi.canonicalAuthoritativeEffectDigest).toBe(canonicalApi.canonicalAuthoritativeEffectDigest);
    expect(syncApi.canonicalAuthoritativeEffectPageDigest).toBe(
      canonicalApi.canonicalAuthoritativeEffectPageDigest,
    );
    expect(syncApi.canonicalAuthoritativeMemberDigest).toBe(canonicalApi.canonicalAuthoritativeMemberDigest);
    expect(syncApi.expandAuthoritativeEffectPageUrl).toBe(canonicalApi.expandAuthoritativeEffectPageUrl);
    expect(syncApi.assertAuthoritativeEffectPageUrlSafe).toBe(canonicalApi.assertAuthoritativeEffectPageUrlSafe);
  });

  it('does not import Node builtins from the canonical sources', () => {
    for (const relative of ['src/sync/canonical.ts', 'src/sync/canonical-json.ts']) {
      expect(readFileSync(join(packageRoot, relative), 'utf8')).not.toMatch(/\bnode:/u);
    }
  });

  it('preserves historical protocol example operation digest', () => {
    const event = historicalPull.events[0];
    expect(canonicalOperationDigest(event.operation)).toBe(event.effect.operationDigest);
    expect(canonicalAuthoritativeEffectDigest(event.effect as never)).toMatch(/^sha-256=:[A-Za-z0-9+/]{43}=:$/u);
  });

  it('matches Node SHA-256 base64 framing on the canonical JSON bytes', () => {
    const encoded = encodeCanonicalJson(sampleOperation, 'Canonical Operation digest input');
    expect(canonicalOperationDigest(sampleOperation as never)).toBe(
      `sha-256=:${createHash('sha256').update(encoded, 'utf8').digest('base64')}:`,
    );
  });

  it('does not Unicode-normalize; NFC and NFD titles digest differently', () => {
    const nfc = { ...sampleOperation, payload: { ...sampleOperation.payload, node: { kind: 'folder', title: '\u00e9' } } };
    const nfd = { ...sampleOperation, payload: { ...sampleOperation.payload, node: { kind: 'folder', title: 'e\u0301' } } };
    expect(canonicalOperationDigest(nfc as never)).not.toBe(canonicalOperationDigest(nfd as never));
  });

  it('is stable under key insertion order', () => {
    const left = { z: 1, a: 2, payload: { b: true, a: false } };
    const right = { a: 2, payload: { a: false, b: true }, z: 1 };
    expect(canonicalOperationDigest(left as never)).toBe(canonicalOperationDigest(right as never));
  });

  it('fails closed when sort, framing, or effectDigest omission is mutated', () => {
    const encoded = encodeCanonicalJson({ z: 1, a: 2 }, 'Canonical JSON input');
    expect(encoded).toBe('{"a":2,"z":1}');
    expect(encoded).not.toBe(JSON.stringify({ z: 1, a: 2 }));

    const effect = {
      kind: 'node_deleted',
      opId: 'op_1',
      extra: { n: 1 },
      effectDigest: `sha-256=:${'A'.repeat(43)}=:` ,
    };
    const otherDigest = { ...effect, effectDigest: `sha-256=:${'B'.repeat(43)}=:` };
    expect(canonicalAuthoritativeEffectDigest(effect as never))
      .toBe(canonicalAuthoritativeEffectDigest(otherDigest as never));
    expect(canonicalAuthoritativeEffectDigest(effect as never)).not.toBe(
      `sha-256=:${createHash('sha256').update(encodeCanonicalJson(effect, 'Canonical JSON input'), 'utf8').digest('base64')}:`,
    );

    const digest = canonicalOperationDigest(sampleOperation as never);
    expect(digest).toMatch(/^sha-256=:[A-Za-z0-9+/]{43}=:$/u);
    expect(digest.startsWith('sha256:')).toBe(false);
  });

  it('rejects undefined, non-finite / unsafe numbers, cycles, and non-plain objects', () => {
    expect(() => canonicalOperationDigest({ payload: { x: undefined } } as never)).toThrow(/plain JSON|I-JSON|data properties/i);
    expect(() => canonicalOperationDigest({ payload: { x: Number.NaN } } as never)).toThrow(/JSON-safe number/i);
    expect(() => canonicalOperationDigest({ payload: { x: Number.POSITIVE_INFINITY } } as never)).toThrow(/JSON-safe number/i);
    expect(() => canonicalOperationDigest({ payload: { x: Number.MAX_SAFE_INTEGER + 1 } } as never)).toThrow(/JSON-safe number/i);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalOperationDigest({ payload: cyclic } as never)).toThrow(/cycles/i);
    expect(() => canonicalOperationDigest({ payload: new Date('2026-07-27T00:00:00Z') } as never)).toThrow(/plain object/i);
    const accessor = {};
    Object.defineProperty(accessor, 'title', { get: () => 'x', enumerable: true });
    expect(() => canonicalAuthoritativeEffectDigest('not-an-effect')).toThrow(/plain object/i);
    expect(() => canonicalAuthoritativeEffectPageDigest(['not-a-page'])).toThrow(/plain object/i);
  });

  it('expands effect-page URLs with the protocol template lock', () => {
    expect(expandAuthoritativeEffectPageUrl(
      'https://sync.example/effects/{effectId}/pages/{pageNumber}',
      'effect-1',
      20,
    )).toBe('https://sync.example/effects/effect-1/pages/20');
    expect(() => expandAuthoritativeEffectPageUrl(
      'https://user:pass@sync.example/effects/{effectId}/pages/{pageNumber}',
      'effect-1',
      1,
    )).toThrow(/credential/i);
    expect(() => expandAuthoritativeEffectPageUrl(
      'https://127.0.0.1/effects/{effectId}/pages/{pageNumber}',
      'effect-1',
      1,
    )).toThrow(/private|local|localhost/i);
  });

  it(`locks the committed ${CANONICAL_DIGEST_CORPUS_COUNT}-case golden corpus`, () => {
    expect(expectedCorpus.seed).toBe(20_260_830);
    expect(expectedCorpus.count).toBe(CANONICAL_DIGEST_CORPUS_COUNT);
    expect(expectedCorpus.digests).toHaveLength(CANONICAL_DIGEST_CORPUS_COUNT);
    expect(digestCorpusCase(0)).toBe(expectedCorpus.digests[0]);
    expect(digestCorpusCase(849)).toBe(expectedCorpus.digests[849]);
    expect(digestCorpusCase(899)).toBe(expectedCorpus.digests[899]);
    expect(digestCorpusCase(900)).toBe(digestCorpusCase(901));
    expect(buildCanonicalDigestCorpus()).toEqual(expectedCorpus);
  });

  it('keeps member and page digest helpers on the canonical subpath', () => {
    expect(canonicalAuthoritativeMemberDigest(['a', 'b'])).toMatch(/^sha-256=:[A-Za-z0-9+/]{43}=:$/u);
    expect(canonicalAuthoritativeEffectPageDigest({
      effectId: 'effect-1',
      pageNumber: 1,
      pageCount: 1,
      members: ['node-1'],
      memberCount: 1,
      pageDigest: `sha-256=:${'A'.repeat(43)}=:` ,
      previousPageDigest: null,
    } as never)).toMatch(/^sha-256=:[A-Za-z0-9+/]{43}=:$/u);
  });
});
