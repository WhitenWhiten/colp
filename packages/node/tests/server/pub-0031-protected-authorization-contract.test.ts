import { describe, expect, it } from 'vitest';

import {
  buildAnonymousCollectionDirectory,
  buildPublicationAuthorizedCollectionDirectory,
  buildPublicationDiscoveryOutput,
  createAnonymousCollectionDirectoryPage,
  createPublicationAuthorizedDirectoryPage,
  createPublicationAuthorizedDirectoryResponse,
  createPublicationCachePolicy,
  createPublicationDiscoveryPage,
  selectAnonymousDirectoryCandidates,
  selectPublicationAuthorizedDirectoryCandidates,
  selectPublicationDiscoveryCandidates,
} from '../../src/server/index.js';

const evidence = '[evidence:http.directory.protected-authorization]';

type Visibility = 'public' | 'unlisted' | 'protected' | 'private';

interface DirectoryItem {
  readonly id: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly kind: 'knowledge_collection';
  readonly nodeCount: number;
  readonly updatedAt: string;
  readonly visibility: Visibility;
  readonly links: Readonly<Record<string, string>>;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

function collection(
  id: string,
  visibility: Visibility = 'public',
  overrides: Record<PropertyKey, unknown> = {},
): Record<PropertyKey, unknown> {
  return {
    id,
    canonicalUrl: `https://catalog.example/collections/${id}`,
    title: `Collection ${id}`,
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

function allowIds(...ids: readonly string[]) {
  const allowed = new Set(ids);
  return (candidate: Readonly<DirectoryItem>): boolean => allowed.has(candidate.id);
}

function select(candidates: unknown, authorize = allowIds()) {
  return selectPublicationAuthorizedDirectoryCandidates(candidates, authorize as never);
}

function build(
  selected: ReturnType<typeof selectPublicationAuthorizedDirectoryCandidates>,
  collections = selected.collections,
  nextCursor: string | null = null,
) {
  return buildPublicationAuthorizedCollectionDirectory(
    createPublicationAuthorizedDirectoryPage(selected, { collections, nextCursor }),
  );
}

function captureError(work: () => unknown): Error {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('Expected the authorized Directory boundary to reject input.');
}

function isPublicDiscoveryItem(value: unknown): value is DirectoryItem {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<DirectoryItem>;
  return candidate.visibility === 'public'
    && typeof candidate.id === 'string'
    && typeof candidate.canonicalUrl === 'string'
    && typeof candidate.updatedAt === 'string';
}

describe(`PUB-0031 protected Directory authorization ${evidence}`, () => {
  it(`always includes canonical public records without consulting authorization ${evidence}`, () => {
    let calls = 0;
    const selected = selectPublicationAuthorizedDirectoryCandidates([
      collection('public-a'),
      collection('public-b'),
    ], () => {
      calls += 1;
      return false;
    });

    expect(selected.collections.map((item) => item.id)).toEqual(['public-a', 'public-b']);
    expect(calls).toBe(0);
  });

  it(`includes protected records only when the predicate returns boolean true ${evidence}`, () => {
    const selected = select([
      collection('public-a'),
      collection('protected-allowed', 'protected'),
      collection('protected-denied', 'protected'),
      collection('public-b'),
    ], allowIds('protected-allowed'));

    expect(selected.collections.map((item) => item.id)).toEqual([
      'public-a',
      'protected-allowed',
      'public-b',
    ]);
    expect(build(selected).collections.map((item) => item.visibility)).toEqual([
      'public',
      'protected',
      'public',
    ]);
  });

  it(`excludes protected records when authorization returns false ${evidence}`, () => {
    const selected = selectPublicationAuthorizedDirectoryCandidates(
      [collection('protected-secret', 'protected')],
      () => false,
    );
    expect(selected.collections).toEqual([]);
  });

  it.each([
    ['a missing return', () => undefined],
    ['a string', () => 'true'],
    ['one', () => 1],
    ['an object', () => ({ allowed: true })],
  ])(`rejects non-boolean protected authorization result %s ${evidence}`, (_name, authorize) => {
    expect(() => selectPublicationAuthorizedDirectoryCandidates(
      [collection('protected-target', 'protected')],
      authorize as never,
    )).toThrow(TypeError);
  });

  it(`rejects a missing authorization predicate instead of exposing protected records ${evidence}`, () => {
    expect(() => selectPublicationAuthorizedDirectoryCandidates(
      [collection('protected-target', 'protected')],
      undefined as never,
    )).toThrow(TypeError);
  });

  it(`sanitizes a throwing authorization predicate without reflecting its secret ${evidence}`, () => {
    const secret = 'predicate-secret-token-793';
    const error = captureError(() => selectPublicationAuthorizedDirectoryCandidates(
      [collection('protected-target', 'protected')],
      () => { throw new Error(secret); },
    ));

    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain('protected-target');
  });

  it(`excludes unlisted and private records before authorization even when it would allow them ${evidence}`, () => {
    const calls: string[] = [];
    const selected = selectPublicationAuthorizedDirectoryCandidates([
      collection('unlisted-secret', 'unlisted'),
      collection('private-secret', 'private'),
      collection('protected-visible', 'protected'),
    ], (candidate) => {
      calls.push(candidate.id);
      return true;
    });

    expect(calls).toEqual(['protected-visible']);
    expect(selected.collections.map((item) => item.id)).toEqual(['protected-visible']);
    expect(JSON.stringify(build(selected))).not.toMatch(/unlisted-secret|private-secret/iu);
  });

  it(`does not traverse hidden payloads before excluding them ${evidence}`, () => {
    let hiddenReads = 0;
    let authorizationCalls = 0;
    const hidden = collection('hidden-secret', 'private');
    Object.defineProperty(hidden, 'links', {
      enumerable: true,
      get: () => {
        hiddenReads += 1;
        throw new Error('hidden-link-secret-628');
      },
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    hidden.metadata = cycle;

    const selected = selectPublicationAuthorizedDirectoryCandidates([
      hidden,
      collection('public-visible'),
    ], () => {
      authorizationCalls += 1;
      return true;
    });

    expect(hiddenReads).toBe(0);
    expect(authorizationCalls).toBe(0);
    expect(selected.collections.map((item) => item.id)).toEqual(['public-visible']);
  });

  it(`authorizes before query sorting cursor construction and pagination ${evidence}`, () => {
    const candidates = [
      collection('private-newest', 'private', { updatedAt: '2026-07-18T06:00:00.000Z' }),
      collection('protected-denied', 'protected', { updatedAt: '2026-07-18T05:00:00.000Z' }),
      collection('public-new', 'public', { updatedAt: '2026-07-18T04:00:00.000Z' }),
      collection('protected-allowed', 'protected', { updatedAt: '2026-07-18T03:00:00.000Z' }),
      collection('public-middle', 'public', { updatedAt: '2026-07-18T02:00:00.000Z' }),
      collection('public-old', 'public', { updatedAt: '2026-07-18T01:00:00.000Z' }),
    ];
    const selected = select(candidates, allowIds('protected-allowed'));
    const pageItems = selected.collections
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 3);
    const output = buildPublicationAuthorizedCollectionDirectory(
      createPublicationAuthorizedDirectoryPage(selected, {
        collections: pageItems,
        nextCursor: 'authorized-page-3',
      }),
    );

    expect(output.collections.map((item) => item.id)).toEqual([
      'public-new',
      'protected-allowed',
      'public-middle',
    ]);
    expect(output.nextCursor).toBe('authorized-page-3');
    expect(candidates.slice(0, 3).filter((item) => item.visibility === 'public').map((item) => item.id))
      .toEqual(['public-new']);
  });

  it(`preserves selected identity provenance through the page and final guard ${evidence}`, () => {
    const selected = select([
      collection('public-issued'),
      collection('protected-issued', 'protected'),
    ], () => true);

    expect(() => createPublicationAuthorizedDirectoryPage({
      collections: selected.collections,
    } as never, { collections: selected.collections, nextCursor: null })).toThrow(TypeError);
    expect(() => createPublicationAuthorizedDirectoryPage(selected, {
      collections: selected.collections.map((item) => structuredClone(item)),
      nextCursor: null,
    })).toThrow(TypeError);
    expect(() => buildPublicationAuthorizedCollectionDirectory({
      collections: selected.collections,
      nextCursor: null,
    } as never)).toThrow(TypeError);

    const page = createPublicationAuthorizedDirectoryPage(selected, {
      collections: selected.collections,
      nextCursor: null,
    });
    expect(buildPublicationAuthorizedCollectionDirectory(page).collections.map((item) => item.id))
      .toEqual(['public-issued', 'protected-issued']);
  });

  it(`rejects cross-selection records even when their values are canonical and authorized ${evidence}`, () => {
    const first = select([collection('protected-same', 'protected')], () => true);
    const second = select([collection('protected-same', 'protected')], () => true);
    expect(() => createPublicationAuthorizedDirectoryPage(first, {
      collections: second.collections,
      nextCursor: null,
    })).toThrow(TypeError);
  });

  it.each([
    ['public', 'public'],
    ['protected', 'protected'],
  ] as const)(`canonically validates %s records before inclusion ${evidence}`, (_name, visibility) => {
    expect(() => select([collection(`bad-${visibility}`, visibility, { canonicalUrl: 42 })], () => true))
      .toThrow(TypeError);
  });

  it(`ignores the same malformed shape when unlisted or private ${evidence}`, () => {
    expect(select([
      collection('bad-unlisted', 'unlisted', { canonicalUrl: 42 }),
      collection('bad-private', 'private', { links: 42 }),
    ], () => true).collections).toEqual([]);
  });

  it(`passes a detached deeply frozen canonical protected value to authorization ${evidence}`, () => {
    const source = collection('protected-frozen', 'protected', {
      extensions: { 'https://extensions.example/labels': ['original'] },
    });
    let authorizedCandidate: Readonly<DirectoryItem> | undefined;
    const selected = selectPublicationAuthorizedDirectoryCandidates([source], (candidate) => {
      authorizedCandidate = candidate as unknown as Readonly<DirectoryItem>;
      expect(candidate).not.toBe(source);
      expect(Object.isFrozen(candidate)).toBe(true);
      expect(Object.isFrozen(candidate.links)).toBe(true);
      expect(() => Object.assign(candidate, { title: 'predicate mutation' })).toThrow(TypeError);
      return true;
    });

    expect(authorizedCandidate).toBeDefined();
    expect(selected.collections[0]).toBe(authorizedCandidate);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected.collections)).toBe(true);
    expect(Object.isFrozen(selected.collections[0])).toBe(true);

    (source.extensions as Record<string, string[]>)['https://extensions.example/labels']![0] = 'caller mutation';
    source.title = 'caller mutation';
    expect((selected.collections[0] as unknown as DirectoryItem).extensions?.['https://extensions.example/labels'])
      .toEqual(['original']);
    expect(selected.collections[0]?.title).toBe('Collection protected-frozen');
  });

  it(`returns detached deeply frozen page body and response snapshots ${evidence}`, () => {
    const selected = select([collection('protected-output', 'protected')], () => true);
    const page = createPublicationAuthorizedDirectoryPage(selected, {
      collections: selected.collections,
      nextCursor: null,
    });
    const body = buildPublicationAuthorizedCollectionDirectory(page);
    const response = createPublicationAuthorizedDirectoryResponse(page, { existingVary: 'Origin, Accept' });

    expect(page.collections[0]).not.toBe(selected.collections[0]);
    expect(body.collections[0]).not.toBe(page.collections[0]);
    expect(response.body.collections[0]).not.toBe(page.collections[0]);
    expect(response.body).not.toBe(body);
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.collections)).toBe(true);
    expect(Object.isFrozen(body)).toBe(true);
    expect(Object.isFrozen(body.collections)).toBe(true);
    expect(Object.isFrozen(response)).toBe(true);
    expect(Object.isFrozen(response.body)).toBe(true);
    expect(Object.isFrozen(response.headers)).toBe(true);
  });

  it(`emits exact private no-store caching while preserving Origin and Accept in Vary ${evidence}`, () => {
    const selected = select([collection('protected-cache', 'protected')], () => true);
    const page = createPublicationAuthorizedDirectoryPage(selected, {
      collections: selected.collections,
      nextCursor: null,
    });
    const response = createPublicationAuthorizedDirectoryResponse(page, {
      existingCacheControl: 'public, max-age=3600, immutable',
      existingVary: 'Origin, Accept',
    });

    expect(response.headers).toEqual({
      'Cache-Control': 'private, no-store',
      Vary: 'Origin, Accept, Authorization',
    });
  });

  it.each([
    ['success', 200],
    ['no content', 204],
    ['not modified', 304],
    ['authorization denial', 403],
    ['concealed denial', 404],
    ['server error', 500],
  ] as const)(`keeps authorized Directory cache policy applicable to a %s response ${evidence}`, (_name, status) => {
    const selected = select([collection('public-status')]);
    const page = createPublicationAuthorizedDirectoryPage(selected, {
      collections: selected.collections,
      nextCursor: null,
    });
    const { headers } = createPublicationAuthorizedDirectoryResponse(page, { existingVary: 'Origin, Accept' });
    const response = new Response(status === 204 || status === 304 ? null : '{}', { status, headers });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('Origin, Accept, Authorization');
  });

  it(`rejects accessors symbols cycles unsafe prototypes and hostile proxies non-reflectively ${evidence}`, () => {
    const secret = 'malicious-directory-secret-417';
    const accessor = collection('accessor-public');
    Object.defineProperty(accessor, 'title', { enumerable: true, get: () => secret });
    const symbol = collection('symbol-protected', 'protected', { [Symbol(secret)]: true });
    const cycle = collection('cycle-protected', 'protected');
    cycle.metadata = cycle;
    const prototype = Object.assign(Object.create({ [secret]: true }), collection('prototype-public'));
    const proxy = new Proxy(collection('proxy-protected', 'protected'), {
      ownKeys: () => { throw new Error(secret); },
    });

    for (const candidate of [accessor, symbol, cycle, prototype, proxy]) {
      const error = captureError(() => select([candidate], () => true));
      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).not.toContain(secret);
    }
  });

  it(`rejects oversized candidate sets with a bounded non-reflective error ${evidence}`, () => {
    const repeated = collection('oversize-public');
    const error = captureError(() => select(Array.from({ length: 10_001 }, () => repeated)));
    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).not.toContain('oversize-public');
  });

  it(`preserves the PUB-0009 anonymous public-only Directory contract ${evidence}`, () => {
    const selected = selectAnonymousDirectoryCandidates([
      collection('anonymous-public'),
      collection('anonymous-protected', 'protected'),
    ]);
    const output = buildAnonymousCollectionDirectory(createAnonymousCollectionDirectoryPage(selected, {
      collections: selected.collections,
      nextCursor: null,
    }));
    expect(output.collections.map((item) => item.id)).toEqual(['anonymous-public']);
  });

  it(`preserves the PUB-0023 authorization-varying cache contract ${evidence}`, () => {
    expect(createPublicationCachePolicy({
      kind: 'authorization-varying',
      existingCacheControl: 'public, max-age=60',
      existingVary: 'Origin, Accept',
    })).toEqual({
      'Cache-Control': 'private, no-store',
      Vary: 'Origin, Accept, Authorization',
    });
  });

  it(`preserves the PUB-0030 anonymous discovery exclusion contract ${evidence}`, () => {
    const selected = selectPublicationDiscoveryCandidates('anonymous-directory', [
      collection('discovery-public'),
      collection('discovery-unlisted', 'unlisted'),
      collection('discovery-protected', 'protected'),
      collection('discovery-private', 'private'),
    ], isPublicDiscoveryItem);
    const output = buildPublicationDiscoveryOutput(createPublicationDiscoveryPage(selected, {
      items: selected.items,
      nextCursor: null,
    }));
    expect(output.items.map((item) => item.id)).toEqual(['discovery-public']);
  });
});
