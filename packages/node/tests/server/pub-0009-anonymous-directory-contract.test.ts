import { describe, expect, it } from 'vitest';

import {
  MAX_ANONYMOUS_DIRECTORY_CANDIDATES,
  buildAnonymousCollectionDirectory,
  createAnonymousCollectionDirectoryPage,
  selectAnonymousDirectoryCandidates,
} from '../../src/server/index.js';

const evidence = '[evidence:http.directory.unlisted]';

type Visibility = 'public' | 'unlisted' | 'protected' | 'private';

function collection(
  id: string,
  visibility: Visibility = 'public',
  overrides: Record<PropertyKey, unknown> = {},
): Record<PropertyKey, unknown> {
  return {
    id,
    canonicalUrl: `https://catalog.example/collections/${id}`,
    title: `Needle ${id}`,
    kind: 'knowledge_collection',
    nodeCount: 3,
    updatedAt: '2026-07-18T00:00:00.000Z',
    visibility,
    links: {
      self: `https://api.example/collections/${id}`,
      canonical: `https://catalog.example/collections/${id}`,
      snapshot: `https://cdn.example/snapshots/${id}.json`,
    },
    ...overrides,
  };
}

function build(
  selected: ReturnType<typeof selectAnonymousDirectoryCandidates>,
  collections = selected.collections,
  nextCursor: string | null = null,
) {
  return buildAnonymousCollectionDirectory(createAnonymousCollectionDirectoryPage(selected, { collections, nextCursor }));
}

function buildRaw(collections: unknown, nextCursor: unknown = null) {
  return buildAnonymousCollectionDirectory({ collections, nextCursor } as never);
}

function captureError(work: () => unknown): Error {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('Expected production API to reject the input.');
}

describe(`PUB-0009 anonymous Directory contract ${evidence}`, () => {
  it(`keeps only public collections from a mixed candidate set ${evidence}`, () => {
    const selected = selectAnonymousDirectoryCandidates([
      collection('public-a'),
      collection('unlisted-a', 'unlisted'),
      collection('protected-a', 'protected'),
      collection('private-a', 'private'),
      collection('public-b'),
    ]);

    expect(selected.collections.map((item) => item.id)).toEqual(['public-a', 'public-b']);
    expect(selected.collections.every((item) => item.visibility === 'public')).toBe(true);
  });

  it(`preserves an all-public candidate set ${evidence}`, () => {
    const selected = selectAnonymousDirectoryCandidates([
      collection('public-a'),
      collection('public-b'),
      collection('public-c'),
    ]);
    expect(selected.collections.map((item) => item.id)).toEqual(['public-a', 'public-b', 'public-c']);
  });

  it(`returns no collections for an all-hidden candidate set ${evidence}`, () => {
    const selected = selectAnonymousDirectoryCandidates([
      collection('unlisted-a', 'unlisted'),
      collection('protected-a', 'protected'),
      collection('private-a', 'private'),
    ]);
    expect(selected.collections).toEqual([]);
  });

  it(`returns no collections for an empty candidate set ${evidence}`, () => {
    const selected = selectAnonymousDirectoryCandidates([]);
    expect(selected.collections).toEqual([]);
    expect(build(selected)).toEqual({ protocolVersion: '0.1', collections: [], nextCursor: null });
  });

  it(`filters hidden matches before sorting and taking the anonymous page window ${evidence}`, () => {
    const candidates = [
      collection('public-old', 'public', { updatedAt: '2026-07-10T00:00:00.000Z' }),
      collection('unlisted-newest', 'unlisted', { updatedAt: '2026-07-18T05:00:00.000Z' }),
      collection('protected-newer', 'protected', { updatedAt: '2026-07-18T04:00:00.000Z' }),
      collection('public-new', 'public', { updatedAt: '2026-07-18T03:00:00.000Z' }),
      collection('private-newer', 'private', { updatedAt: '2026-07-18T02:00:00.000Z' }),
      collection('public-middle', 'public', { updatedAt: '2026-07-18T01:00:00.000Z' }),
      collection('public-oldest', 'public', { updatedAt: '2026-07-01T00:00:00.000Z' }),
    ];

    // This simulates arbitrary query matching and ordering only after the production
    // anonymous candidate boundary has removed every non-public collection.
    const selected = selectAnonymousDirectoryCandidates(candidates);
    const page = selected.collections
      .filter((item) => item.title.toLowerCase().includes('needle'))
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 3);

    expect(page.map((item) => item.id)).toEqual(['public-new', 'public-middle', 'public-old']);
    expect(page).toHaveLength(3);
    expect(build(selected, page, 'cursor-public-3').collections).toHaveLength(3);

    // Counterfactual: paginating before the production selector loses two public slots.
    const wrongWindow = candidates
      .toSorted((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .slice(0, 3)
      .filter((item) => item.visibility === 'public');
    expect(wrongWindow.map((item) => item.id)).toEqual(['public-new']);
  });

  it(`rejects a public-looking narrow window that was paginated from mixed storage before selection ${evidence}`, () => {
    const mixedStorage = [
      collection('hidden-first', 'unlisted'),
      collection('public-only'),
      collection('hidden-third', 'private'),
      collection('public-lost'),
    ];
    const wrongNarrowPage = mixedStorage.slice(0, 2).filter((item) => item.visibility === 'public');
    const forgedSelection = Object.freeze({ collections: Object.freeze(wrongNarrowPage) });

    expect(() => createAnonymousCollectionDirectoryPage(
      forgedSelection as never,
      { collections: wrongNarrowPage as never, nextCursor: 'forged-cursor' },
    )).toThrow(TypeError);
    expect(() => buildRaw(wrongNarrowPage, 'forged-cursor')).toThrow(TypeError);

    const correctlySelected = selectAnonymousDirectoryCandidates(mixedStorage);
    expect(correctlySelected.collections.map((item) => item.id)).toEqual(['public-only', 'public-lost']);
    expect(build(correctlySelected).collections).toHaveLength(2);
  });

  it(`preserves stable order and duplicate public DTOs because the wire array is not uniqueItems ${evidence}`, () => {
    const duplicate = collection('duplicate');
    const selected = selectAnonymousDirectoryCandidates([
      collection('first'),
      duplicate,
      collection('between-hidden', 'unlisted'),
      structuredClone(duplicate),
      collection('last'),
    ]);
    expect(selected.collections.map((item) => item.id)).toEqual(['first', 'duplicate', 'duplicate', 'last']);
  });

  it(`preserves every valid cross-origin public link ${evidence}`, () => {
    const links = {
      self: 'https://api.one.example/collections/public-cross-origin',
      canonical: 'http://catalog.two.example/public-cross-origin',
      snapshot: 'https://cdn.three.example/public-cross-origin.json',
      feed: 'https://feeds.four.example/public-cross-origin',
      access: 'https://auth.five.example/public-cross-origin',
    };
    const selected = selectAnonymousDirectoryCandidates([
      collection('public-cross-origin', 'public', { links }),
    ]);
    const result = build(selected);
    expect(result.collections[0]?.links).toEqual(links);
  });

  it(`does not expose hidden cross-origin identifiers titles URLs or extensions ${evidence}`, () => {
    const secrets = [
      'private-secret-id',
      'PRIVATE SECRET TITLE',
      'hidden-origin.example',
      'signed-hidden-token-928',
    ];
    const hidden = collection('private-secret-id', 'unlisted', {
      title: 'PRIVATE SECRET TITLE',
      canonicalUrl: 'https://hidden-origin.example/private-secret-id',
      links: {
        self: 'https://hidden-origin.example/private-secret-id',
        canonical: 'https://hidden-origin.example/private-secret-id',
        snapshot: 'https://hidden-origin.example/signed-hidden-token-928.json',
      },
      extensions: { 'https://vendor.example/private': { token: 'signed-hidden-token-928' } },
    });
    const selected = selectAnonymousDirectoryCandidates([collection('visible'), hidden]);
    const output = build(selected);
    const serialized = JSON.stringify(output);
    for (const secret of secrets) {
      expect(serialized).not.toContain(secret);
      expect(String(output)).not.toContain(secret);
    }
    expect(output.collections.map((item) => item.id)).toEqual(['visible']);
  });

  it(`ignores malformed hidden payloads without reading or revealing their fields or existence ${evidence}`, () => {
    let hiddenGetterReads = 0;
    const hidden = collection('hidden-malformed-secret', 'unlisted', {
      canonicalUrl: 'not a URL',
      nodeCount: -99,
      [Symbol('hidden-symbol')]: 'hidden-symbol-secret',
    });
    Object.defineProperty(hidden, 'title', {
      enumerable: true,
      get: () => {
        hiddenGetterReads += 1;
        throw new Error('hidden-getter-secret');
      },
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    hidden.extensions = { 'https://hidden.example/cycle': cycle };
    const hiddenWithCustomPrototype = Object.assign(Object.create({ inheritedSecret: 'prototype-secret' }), {
      visibility: 'private',
      id: 'prototype-hidden-secret',
    });

    const withoutHidden = selectAnonymousDirectoryCandidates([collection('visible')]);
    const withHidden = selectAnonymousDirectoryCandidates([hidden, hiddenWithCustomPrototype, collection('visible')]);
    expect(withHidden).toEqual(withoutHidden);
    expect(hiddenGetterReads).toBe(0);
    expect(JSON.stringify(build(withHidden))).not.toMatch(/hidden|secret/iu);
  });

  it(`emits only the Directory DTO and no ACL or principal fields ${evidence}`, () => {
    const output = build(selectAnonymousDirectoryCandidates([collection('public-a')]));
    expect(Object.keys(output)).toEqual(['protocolVersion', 'collections', 'nextCursor']);
    expect(Object.keys(output.collections[0]!).sort()).toEqual([
      'canonicalUrl', 'id', 'kind', 'links', 'nodeCount', 'title', 'updatedAt', 'visibility',
    ]);
    expect(JSON.stringify(output)).not.toMatch(/authorization|principal|scope|acl|grant/iu);
  });

  it(`does not mutate candidate arrays or nested caller-owned objects ${evidence}`, () => {
    const candidates = [
      collection('public-a', 'public', { tags: ['one', 'two'] }),
      collection('unlisted-a', 'unlisted'),
    ];
    const snapshot = structuredClone(candidates);
    const selected = selectAnonymousDirectoryCandidates(candidates);
    build(selected);
    expect(candidates).toEqual(snapshot);
  });

  it(`returns cloned and deeply frozen selections and final DTOs ${evidence}`, () => {
    const input = collection('public-a', 'public', {
      tags: ['one'],
      extensions: { 'https://vendor.example/data': { nested: ['value'] } },
    });
    const selected = selectAnonymousDirectoryCandidates([input]);
    const issuedPage = createAnonymousCollectionDirectoryPage(selected, {
      collections: selected.collections,
      nextCursor: null,
    });
    const output = buildAnonymousCollectionDirectory(issuedPage);

    expect(selected.collections[0]).not.toBe(input);
    expect(issuedPage.collections[0]).not.toBe(selected.collections[0]);
    expect(output.collections[0]).not.toBe(selected.collections[0]);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected.collections)).toBe(true);
    expect(Object.isFrozen(selected.collections[0]?.links)).toBe(true);
    expect(Object.isFrozen(selected.collections[0]?.extensions)).toBe(true);
    expect(Object.isFrozen(selected.collections[0]?.extensions?.['https://vendor.example/data'])).toBe(true);
    expect(Object.isFrozen(issuedPage)).toBe(true);
    expect(Object.isFrozen(issuedPage.collections)).toBe(true);
    expect(Object.isFrozen(issuedPage.collections[0]?.links)).toBe(true);
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.collections)).toBe(true);
    expect(Object.isFrozen(output.collections[0]?.links)).toBe(true);
    expect(Object.isFrozen(output.collections[0]?.extensions?.['https://vendor.example/data'])).toBe(true);
    expect(() => Object.assign(output.collections[0]!, { visibility: 'unlisted' })).toThrow(TypeError);
  });

  it(`isolates outputs across calls and later caller mutation ${evidence}`, () => {
    const input = collection('public-a', 'public', { tags: ['original'] });
    const first = selectAnonymousDirectoryCandidates([input]);
    (input.tags as string[])[0] = 'mutated';
    const second = selectAnonymousDirectoryCandidates([input]);
    const firstPage = build(first);
    const secondPage = build(second);

    expect(first).not.toBe(second);
    expect(first.collections).not.toBe(second.collections);
    expect(firstPage).not.toBe(secondPage);
    expect(firstPage.collections[0]?.tags).toEqual(['original']);
    expect(secondPage.collections[0]?.tags).toEqual(['mutated']);
  });

  it(`is deterministic for identical public candidates and has no credential parameter ${evidence}`, () => {
    const candidates = [collection('public-a'), collection('hidden-a', 'unlisted'), collection('public-b')];
    const first = selectAnonymousDirectoryCandidates(candidates);
    const second = selectAnonymousDirectoryCandidates(candidates);
    expect(selectAnonymousDirectoryCandidates.length).toBe(1);
    expect(createAnonymousCollectionDirectoryPage.length).toBe(2);
    expect(buildAnonymousCollectionDirectory.length).toBe(1);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(JSON.stringify(build(first))).toBe(JSON.stringify(build(second)));
  });

  it.each([
    ['missing visibility', undefined],
    ['unknown visibility', 'discoverable'],
    ['uppercase visibility', 'PUBLIC'],
    ['empty visibility', ''],
    ['numeric visibility', 1],
    ['inherited visibility', 'inherit'],
  ])(`rejects %s instead of guessing anonymous visibility ${evidence}`, (_name, visibility) => {
    const candidate = collection('invalid-visibility');
    if (visibility === undefined) delete candidate.visibility;
    else candidate.visibility = visibility;
    expect(() => selectAnonymousDirectoryCandidates([candidate])).toThrow(TypeError);
  });

  it.each([
    ['a missing id', 'id', undefined],
    ['a missing title', 'title', undefined],
    ['a missing canonicalUrl', 'canonicalUrl', undefined],
    ['a missing kind', 'kind', undefined],
    ['a missing nodeCount', 'nodeCount', undefined],
    ['a missing updatedAt', 'updatedAt', undefined],
    ['a missing links', 'links', undefined],
    ['an ACL field', 'acl', { grants: ['principal:secret'] }],
  ] as const)(`rejects public candidate shape with %s ${evidence}`, (_name, key, value) => {
    const candidate = collection('invalid-shape');
    if (value === undefined) delete candidate[key];
    else candidate[key] = value;
    expect(() => selectAnonymousDirectoryCandidates([candidate])).toThrow(TypeError);
  });

  it.each([
    ['an empty opaque id', { id: '' }],
    ['an overlong opaque id', { id: 'x'.repeat(129) }],
    ['an opaque id with a slash', { id: 'private/id' }],
    ['a relative canonical URL', { canonicalUrl: '/collections/relative' }],
    ['a credential-bearing URL', { canonicalUrl: 'https://user:secret@example.test/collection' }],
    ['an impossible date', { updatedAt: '2026-02-30T00:00:00Z' }],
    ['a negative node count', { nodeCount: -1 }],
    ['a non-URI extension key', { extensions: { privateKey: 'secret' } }],
  ])(`rejects schema-invalid candidate containing %s ${evidence}`, (_name, overrides) => {
    expect(() => selectAnonymousDirectoryCandidates([collection('invalid-format', 'public', overrides)])).toThrow(TypeError);
  });

  it.each([
    ['null', null],
    ['an object', { 0: collection('array-like'), length: 1 }],
    ['a string', 'public-a'],
    ['a Set', new Set([collection('set-item')])],
    ['an iterator', [collection('iterator-item')].values()],
  ])(`rejects non-array candidates supplied as %s ${evidence}`, (_name, candidates) => {
    expect(() => selectAnonymousDirectoryCandidates(candidates)).toThrow(TypeError);
  });

  it.each([
    ['a sparse hole', () => { const value = new Array(2); value[1] = collection('after-hole'); return value; }],
    ['an extra string property', () => Object.assign([collection('public-a')], { metadata: 'secret' })],
    ['a symbol property', () => Object.assign([collection('public-a')], { [Symbol('secret')]: true })],
    ['an accessor index', () => { const value: unknown[] = []; Object.defineProperty(value, 0, { enumerable: true, get: () => collection('getter') }); value.length = 1; return value; }],
  ] as const)(`rejects candidate arrays with %s ${evidence}`, (_name, createCandidates) => {
    expect(() => selectAnonymousDirectoryCandidates(createCandidates())).toThrow(TypeError);
  });

  it.each([
    ['an extra property', (): unknown => collection('extra', 'public', { internalOwner: 'principal:secret' })],
    ['a symbol property', (): unknown => collection('symbol', 'public', { [Symbol('secret')]: true })],
    ['an accessor property', (): unknown => { const value = collection('accessor'); Object.defineProperty(value, 'summary', { enumerable: true, get: () => 'secret' }); return value; }],
    ['an accessor nested link', (): unknown => { const value = collection('link-accessor'); Object.defineProperty(value.links, 'feed', { enumerable: true, get: () => 'https://secret.example/feed' }); return value; }],
    ['a circular extension', (): unknown => { const value = collection('circular'); const extension: Record<string, unknown> = {}; extension.self = extension; value.extensions = { 'https://vendor.example/circular': extension }; return value; }],
    ['an extension deeper than the JSON limit', (): unknown => { const root: Record<string, unknown> = {}; let current = root; for (let depth = 0; depth < 70; depth += 1) { const next: Record<string, unknown> = {}; current.next = next; current = next; } return collection('too-deep', 'public', { extensions: { 'https://vendor.example/deep': root } }); }],
  ] as const)(`rejects a candidate containing %s ${evidence}`, (_name, createCandidate) => {
    expect(() => selectAnonymousDirectoryCandidates([createCandidate()])).toThrow(TypeError);
  });

  it.each([
    ['one candidate', 1, false],
    ['the exact maximum', MAX_ANONYMOUS_DIRECTORY_CANDIDATES, false],
    ['one above the maximum', MAX_ANONYMOUS_DIRECTORY_CANDIDATES + 1, true],
  ] as const)(`enforces the bounded candidate limit at %s ${evidence}`, (_name, count, rejects) => {
    const candidates = Array.from({ length: count }, (_, index) => collection(`public-${index}`));
    if (rejects) expect(() => selectAnonymousDirectoryCandidates(candidates)).toThrow(RangeError);
    else expect(selectAnonymousDirectoryCandidates(candidates).collections).toHaveLength(count);
  });

  it.each(['unlisted', 'protected', 'private'] as const)(
    `final builder fails closed for accidentally forwarded %s collection ${evidence}`,
    (visibility) => {
      const secret = `builder-${visibility}-secret`;
      const error = captureError(() => buildRaw([collection(secret, visibility)]));
      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).not.toContain(secret);
      expect(error.message).not.toContain(visibility);
    },
  );

  it.each([
    ['a non-object envelope', null],
    ['an extra envelope property', { collections: [], nextCursor: null, authorization: 'Bearer secret' }],
    ['a missing collections property', { nextCursor: null }],
    ['a missing nextCursor property', { collections: [] }],
    ['a numeric cursor', { collections: [], nextCursor: 42 }],
    ['an empty cursor', { collections: [], nextCursor: '' }],
    ['a cursor containing a slash', { collections: [], nextCursor: 'cursor/private' }],
  ])(`final builder rejects %s ${evidence}`, (_name, input) => {
    const selected = selectAnonymousDirectoryCandidates([]);
    expect(() => buildAnonymousCollectionDirectory(
      createAnonymousCollectionDirectoryPage(selected, input as never),
    )).toThrow(TypeError);
  });

  it.each([
    ['a sparse collections array', (item: unknown) => { const value = new Array(2); value[1] = item; return { collections: value, nextCursor: null }; }],
    ['a symbol envelope property', (item: unknown) => ({ collections: [item], nextCursor: null, [Symbol('secret')]: true })],
    ['an accessor envelope property', (item: unknown) => { const value = { collections: [item], nextCursor: null }; Object.defineProperty(value, 'nextCursor', { enumerable: true, get: () => 'secret' }); return value; }],
    ['a circular envelope property', (item: unknown) => { const value: Record<string, unknown> = { collections: [item], nextCursor: null }; value.self = value; return value; }],
    ['a page above the record limit', (item: unknown) => ({ collections: Array(MAX_ANONYMOUS_DIRECTORY_CANDIDATES + 1).fill(item), nextCursor: null })],
  ] as const)(`issued page boundary rejects %s ${evidence}`, (_name, createPage) => {
    const selected = selectAnonymousDirectoryCandidates([collection('issued-public')]);
    expect(() => createAnonymousCollectionDirectoryPage(selected, createPage(selected.collections[0]) as never)).toThrow();
  });

  it(`final builder rejects an unissued page even when a TypeScript cast and every public field look valid ${evidence}`, () => {
    const rawPage = { collections: [collection('cast-public')], nextCursor: null };
    expect(() => buildAnonymousCollectionDirectory(rawPage as never)).toThrow(TypeError);
  });

  it.each([
    ['invalid public item', 'candidate-secret-741', () => collection('candidate-secret-741', 'public', { owner: 'principal-secret-741' })],
    ['invalid final item', 'builder-secret-852', () => collection('builder-secret-852', 'unlisted', { title: 'builder secret title' })],
  ] as const)(`does not echo secrets while rejecting %s ${evidence}`, (_name, secret, createCandidate) => {
    const error = captureError(() => _name === 'invalid public item'
      ? selectAnonymousDirectoryCandidates([createCandidate()])
      : buildRaw([createCandidate()]));
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain('principal-secret-741');
    expect(error.message).not.toContain('builder secret title');
  });
});
