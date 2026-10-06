import { describe, expect, it, vi } from 'vitest';

import {
  areUrlHashDeduplicationCandidates,
  createUrlHash,
  evaluateUrlHashDeduplication,
} from '../../src/semantic/index.js';

const evidence = '[evidence:core.url-hash-candidate-prefilter]';

interface BookmarkCandidate {
  id: string;
  collectionId: string;
  url: string;
  urlHash?: string;
  content: string;
}

describe(`CORE-0042 URL-hash candidate prefilter ${evidence}`, () => {
  it('selects equal valid hashes symmetrically and reflexively', () => {
    const left = createUrlHash('https://example.test/saved');
    const right = createUrlHash('https://example.test/saved');

    expect(areUrlHashDeduplicationCandidates(left, left)).toBe(true);
    expect(areUrlHashDeduplicationCandidates(left, right)).toBe(
      areUrlHashDeduplicationCandidates(right, left),
    );
    expect(areUrlHashDeduplicationCandidates(left, right)).toBe(true);
  });

  it.each([
    ['unequal valid hashes', createUrlHash('https://left.example.test/'), createUrlHash('https://right.example.test/')],
    ['left absent', undefined, createUrlHash('https://present.example.test/')],
    ['both absent', undefined, undefined],
    ['left null', null, createUrlHash('https://present.example.test/')],
    ['both null', null, null],
    ['malformed strings', 'not-a-url-hash', 'not-a-url-hash'],
    ['number', 42, createUrlHash('https://present.example.test/')],
    ['plain object', { hash: 'value' }, createUrlHash('https://present.example.test/')],
    ['array', [], createUrlHash('https://present.example.test/')],
    ['boolean', false, createUrlHash('https://present.example.test/')],
  ] as const)('rejects %s in either order', (_label, left, right) => {
    expect(areUrlHashDeduplicationCandidates(left, right)).toBe(false);
    expect(areUrlHashDeduplicationCandidates(right, left)).toBe(false);
  });

  it('compares the digest and wire envelope case-sensitively', () => {
    const hash = createUrlHash('https://example.test/case-sensitive');
    const digestStart = 'sha-256=:'.length;
    const relativeLetterIndex = hash.slice(digestStart, digestStart + 42).search(/[A-Za-z]/u);
    expect(relativeLetterIndex).toBeGreaterThanOrEqual(0);
    const letterIndex = digestStart + relativeLetterIndex;
    const digestCharacter = hash[letterIndex]!;
    const caseChangedDigest = `${hash.slice(0, letterIndex)}${
      digestCharacter === digestCharacter.toUpperCase()
        ? digestCharacter.toLowerCase()
        : digestCharacter.toUpperCase()
    }${hash.slice(letterIndex + 1)}`;
    const caseChangedEnvelope = hash.replace('sha-256', 'SHA-256');

    expect(caseChangedDigest).not.toBe(hash);
    expect(areUrlHashDeduplicationCandidates(hash, caseChangedDigest)).toBe(false);
    expect(areUrlHashDeduplicationCandidates(caseChangedDigest, hash)).toBe(false);
    expect(areUrlHashDeduplicationCandidates(hash, caseChangedEnvelope)).toBe(false);
    expect(areUrlHashDeduplicationCandidates(caseChangedEnvelope, hash)).toBe(false);
  });

  it('rejects an equal-hash collision before content or Collection comparison', () => {
    const collisionHash = createUrlHash('https://collision-input.example.test/');
    const left: BookmarkCandidate = {
      id: 'bookmark-left',
      collectionId: 'collection-one',
      url: 'https://first.example.test/resource',
      urlHash: collisionHash,
      content: 'first saved representation',
    };
    const right: BookmarkCandidate = {
      id: 'bookmark-right',
      collectionId: 'collection-two',
      url: 'https://second.example.test/resource',
      urlHash: collisionHash,
      content: 'second saved representation',
    };
    const before = structuredClone({ left, right });
    const semantics = {
      contentMatches: vi.fn(() => true),
      collectionMatches: vi.fn(() => true),
    };

    const selectedAsCandidate = areUrlHashDeduplicationCandidates(left.urlHash, right.urlHash);
    const result = evaluateUrlHashDeduplication(left, right, semantics);

    expect(areUrlHashDeduplicationCandidates.name).toBe(
      'areUrlHashDeduplicationCandidates',
    );
    expect(selectedAsCandidate).toBe(true);
    expect(result).toEqual({ hashCandidate: true, semanticMatch: false, reason: 'url_mismatch' });
    expect(semantics.contentMatches).not.toHaveBeenCalled();
    expect(semantics.collectionMatches).not.toHaveBeenCalled();
    expect(left.id).not.toBe(right.id);
    expect(left.collectionId).not.toBe(right.collectionId);
    expect({ left, right }).toEqual(before);
  });

  it('rejects equal stale hints in the production decision pipeline', () => {
    const staleHash = createUrlHash('https://old.example.test/');
    const left: BookmarkCandidate = {
      id: 'bookmark-left',
      collectionId: 'collection-one',
      url: 'https://current.example.test/',
      urlHash: staleHash,
      content: 'same content',
    };
    const right = structuredClone(left);
    right.id = 'bookmark-right';
    const semantics = {
      contentMatches: vi.fn(() => true),
      collectionMatches: vi.fn(() => true),
    };

    expect(areUrlHashDeduplicationCandidates(left.urlHash, right.urlHash)).toBe(true);
    expect(evaluateUrlHashDeduplication(left, right, semantics)).toEqual({
      hashCandidate: true, semanticMatch: false, reason: 'hash_not_current',
    });
    expect(semantics.contentMatches).not.toHaveBeenCalled();
    expect(semantics.collectionMatches).not.toHaveBeenCalled();
  });

  it('requires content and Collection semantics after current equal URL hashes', () => {
    const url = 'https://same.example.test/';
    const left: BookmarkCandidate = { id: 'left', collectionId: 'one', url,
      urlHash: createUrlHash(url), content: 'same' };
    const right: BookmarkCandidate = { ...left, id: 'right', collectionId: 'two' };
    const contentMatches = vi.fn((a: BookmarkCandidate, b: BookmarkCandidate) => a.content === b.content);
    const collectionMatches = vi.fn((a: BookmarkCandidate, b: BookmarkCandidate) =>
      a.collectionId === b.collectionId);

    expect(evaluateUrlHashDeduplication(left, { ...right, content: 'different' },
      { contentMatches, collectionMatches })).toEqual({
      hashCandidate: true, semanticMatch: false, reason: 'content_mismatch',
    });
    expect(collectionMatches).not.toHaveBeenCalled();

    expect(evaluateUrlHashDeduplication(left, right, { contentMatches, collectionMatches })).toEqual({
      hashCandidate: true, semanticMatch: false, reason: 'collection_mismatch',
    });
    expect(contentMatches).toHaveBeenCalledWith(left, right);
    expect(collectionMatches).toHaveBeenCalledWith(left, right);

    expect(evaluateUrlHashDeduplication(left, { ...right, collectionId: 'one' },
      { contentMatches, collectionMatches })).toEqual({
      hashCandidate: true, semanticMatch: true, reason: 'semantic_match',
    });
  });

  it('does not invoke semantic comparison when the candidate prefilter rejects the pair', () => {
    const left: BookmarkCandidate = {
      id: 'bookmark-left',
      collectionId: 'collection-one',
      url: 'https://left.example.test/',
      urlHash: createUrlHash('https://left.example.test/'),
      content: 'left content',
    };
    const right: BookmarkCandidate = {
      id: 'bookmark-right',
      collectionId: 'collection-two',
      url: 'https://right.example.test/',
      urlHash: createUrlHash('https://right.example.test/'),
      content: 'right content',
    };
    const before = structuredClone({ left, right });
    const semantics = {
      contentMatches: vi.fn(() => true),
      collectionMatches: vi.fn(() => true),
    };

    expect(evaluateUrlHashDeduplication(left, right, semantics)).toEqual({
      hashCandidate: false, semanticMatch: false, reason: 'hash_not_candidate',
    });
    expect(semantics.contentMatches).not.toHaveBeenCalled();
    expect(semantics.collectionMatches).not.toHaveBeenCalled();
    expect({ left, right }).toEqual(before);
  });
});
