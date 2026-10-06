import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  compareUrlHashCandidateIdentity,
  createUrlHash,
  evaluateUrlHashDeduplication,
  sameGlobalResourceIdentity,
  type GlobalResourceIdentity,
} from '../../src/semantic/index.js';

const evidence = '[evidence:core.url-hash-not-object-identity]';

interface BookmarkRecord {
  readonly identity: GlobalResourceIdentity;
  readonly collectionId: string;
  readonly url: string;
  readonly content: string;
  readonly urlHash?: string;
}

const thisTestPath = resolve(import.meta.dirname, 'url-hash-not-object-identity-contract.test.ts');

function record(overrides: Partial<BookmarkRecord> = {}): BookmarkRecord {
  return {
    identity: { serverUuid: 'server-a', resourceType: 'node', id: 'node-a' },
    collectionId: 'collection-a',
    url: 'https://example.test/resource',
    content: 'saved representation',
    urlHash: createUrlHash('https://example.test/resource'),
    ...overrides,
  };
}

function compare(left: BookmarkRecord, right: BookmarkRecord) {
  return compareUrlHashCandidateIdentity(
    left.urlHash,
    right.urlHash,
    left.identity,
    right.identity,
  );
}

describe(`CORE-0043 equal URL hashes are not object identity ${evidence}`, () => {
  it('keeps equal-hash nodes with distinct IDs and global identity tuples unequal', () => {
    const left = record();
    const right = record({ identity: { ...left.identity, id: 'node-b' } });
    const before = structuredClone({ left, right });

    expect(compare(left, right)).toEqual({ hashCandidate: true, sameObject: false });
    expect(left.identity.id).not.toBe(right.identity.id);
    expect(left.urlHash).toBe(right.urlHash);
    expect({ left, right }).toEqual(before);
  });

  it.each([
    ['server UUID', { serverUuid: 'server-b', resourceType: 'node', id: 'node-a' }],
    ['resource type', { serverUuid: 'server-a', resourceType: 'annotation', id: 'node-a' }],
    ['object ID', { serverUuid: 'server-a', resourceType: 'node', id: 'node-b' }],
  ] as const)('does not override a distinct global %s with equal data', (_dimension, identity) => {
    const left = record();
    const right = record({ identity });

    expect(right).toMatchObject({
      urlHash: left.urlHash,
      url: left.url,
      content: left.content,
      collectionId: left.collectionId,
    });
    expect(compare(left, right)).toEqual({ hashCandidate: true, sameObject: false });
  });

  it.each([
    [
      'simulated collision',
      record(),
      record({
        identity: { serverUuid: 'server-b', resourceType: 'node', id: 'node-b' },
        collectionId: 'collection-b',
        url: 'https://collision.example.test/other',
        content: 'different representation',
      }),
    ],
    [
      'stale hints',
      record({ url: 'https://current-a.example.test/' }),
      record({
        identity: { serverUuid: 'server-a', resourceType: 'node', id: 'node-b' },
        url: 'https://current-b.example.test/',
      }),
    ],
  ] as const)('does not turn equal %s into identity', (_case, left, right) => {
    const before = structuredClone({ left, right });

    expect(compare(left, right)).toEqual({ hashCandidate: true, sameObject: false });
    expect({ left, right }).toEqual(before);
  });

  it('keeps semantic duplicate matching separate from global object identity', () => {
    const left = record();
    const right = record({ identity: { ...left.identity, id: 'node-b' } });

    expect(evaluateUrlHashDeduplication(left, right, {
      contentMatches: (a, b) => a.content === b.content,
      collectionMatches: (a, b) => a.collectionId === b.collectionId,
    })).toEqual({ hashCandidate: true, semanticMatch: true, reason: 'semantic_match' });
    expect(compare(left, right)).toEqual({ hashCandidate: true, sameObject: false });
  });

  it('keeps identity true when unequal URL hashes are not deduplication candidates', () => {
    const left = record();
    const right = record({
      url: 'https://different.example.test/',
      urlHash: createUrlHash('https://different.example.test/'),
    });

    expect(compare(left, right)).toEqual({ hashCandidate: false, sameObject: true });
  });

  it('returns an immutable decision without mutating either record', () => {
    const left = record();
    const right = record({ identity: { ...left.identity, id: 'node-b' } });
    const before = structuredClone({ left, right });
    const decision = compare(left, right);

    expect(Object.isFrozen(decision)).toBe(true);
    expect({ left, right }).toEqual(before);
  });

  it('exposes separate booleans rather than a global identity tuple', () => {
    const left = record();
    const right = record({ identity: { ...left.identity, id: 'node-b' } });
    const decision = compare(left, right);

    expectTypeOf(decision.hashCandidate).toEqualTypeOf<boolean>();
    expectTypeOf(decision.sameObject).toEqualTypeOf<boolean>();
    expectTypeOf(decision).not.toMatchTypeOf<GlobalResourceIdentity>();
    expect(sameGlobalResourceIdentity(left.identity, right.identity)).toBe(false);
  });

  it('has exactly one dedicated evidence marker', () => {
    const testSource = readFileSync(thisTestPath, 'utf8');
    expect(testSource.match(/\[evidence:core\.url-hash-not-object-identity\]/gu)).toHaveLength(1);
  });
});
