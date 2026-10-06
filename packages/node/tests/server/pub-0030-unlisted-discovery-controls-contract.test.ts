import { describe, expect, it } from 'vitest';

import {
  MAX_PUBLICATION_DISCOVERY_CANDIDATES,
  PUBLICATION_DISCOVERY_CHANNELS,
  buildAnonymousCollectionDirectory,
  buildPublicationDiscoveryOutput,
  createAnonymousCollectionDirectoryPage,
  createPublicationDiscoveryPage,
  mergePublicationAntiDiscoveryHeaders,
  selectAnonymousDirectoryCandidates,
  selectPublicationDiscoveryCandidates,
  type PublicationDiscoveryChannel,
} from '../../src/server/index.js';

const evidence = '[evidence:http.unlisted-discovery-controls]';
const INVALID_DISCOVERY_INPUT = 'Publication discovery input is invalid.';
const INVALID_DISCOVERY_PAGE = 'Publication discovery page is invalid.';
const CANDIDATE_LIMIT = 'Publication discovery candidate limit exceeded.';
const INVALID_HEADERS = 'Publication anti-discovery headers are invalid.';
const OVERSIZE_HEADERS = 'Publication anti-discovery headers exceed the size limit.';

type Visibility = 'public' | 'unlisted' | 'protected' | 'private';

interface DiscoveryItem {
  readonly id: string;
  readonly visibility: Visibility;
  readonly updatedAt: string;
  readonly url: string;
  readonly metadata?: Readonly<{ readonly labels: readonly string[] }>;
}

function item(
  id: string,
  visibility: Visibility = 'public',
  overrides: Record<PropertyKey, unknown> = {},
): Record<PropertyKey, unknown> {
  return {
    id,
    visibility,
    updatedAt: '2026-07-18T00:00:00.000Z',
    url: `https://catalog.example/items/${id}`,
    ...overrides,
  };
}

function isDiscoveryItem(value: unknown): value is DiscoveryItem {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string'
    && candidate.visibility === 'public'
    && typeof candidate.updatedAt === 'string'
    && typeof candidate.url === 'string';
}

function select(channel: PublicationDiscoveryChannel, candidates: unknown) {
  return selectPublicationDiscoveryCandidates(channel, candidates, isDiscoveryItem);
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

describe(`PUB-0030 unlisted discovery controls ${evidence}`, () => {
  it(`registers the five exhaustive anonymous discovery channels ${evidence}`, () => {
    expect(PUBLICATION_DISCOVERY_CHANNELS).toEqual([
      'anonymous-directory',
      'search',
      'instance-feed',
      'sitemap',
      'mcp-list',
    ]);
    expect(new Set(PUBLICATION_DISCOVERY_CHANNELS).size).toBe(5);
    expect(Object.isFrozen(PUBLICATION_DISCOVERY_CHANNELS)).toBe(true);
  });

  it.each(PUBLICATION_DISCOVERY_CHANNELS)(
    `excludes unlisted protected and private records from %s before pagination ${evidence}`,
    (channel) => {
      const candidates = [
        item('hidden-newest', 'unlisted', { updatedAt: '2026-07-18T05:00:00.000Z' }),
        item('public-new', 'public', { updatedAt: '2026-07-18T04:00:00.000Z' }),
        item('protected-newer', 'protected', { updatedAt: '2026-07-18T03:00:00.000Z' }),
        item('public-middle', 'public', { updatedAt: '2026-07-18T02:00:00.000Z' }),
        item('private-newer', 'private', { updatedAt: '2026-07-18T01:00:00.000Z' }),
        item('public-old'),
      ];
      const selected = select(channel, candidates);
      const pageItems = selected.items
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 3);
      const output = buildPublicationDiscoveryOutput(createPublicationDiscoveryPage(selected, {
        items: pageItems,
        nextCursor: 'public-page-3',
      }));

      expect(selected.items.map((entry) => entry.id)).toEqual(['public-new', 'public-middle', 'public-old']);
      expect(output).toEqual({ channel, items: pageItems, nextCursor: 'public-page-3' });
      expect(output.items.every((entry) => entry.visibility === 'public')).toBe(true);

      const wrongWindow = candidates.slice(0, 3).filter((entry) => entry.visibility === 'public');
      expect(wrongWindow.map((entry) => entry.id)).toEqual(['public-new']);
    },
  );

  it.each(PUBLICATION_DISCOVERY_CHANNELS)(
    `preserves public source ordering including duplicate values for %s ${evidence}`,
    (channel) => {
      const duplicate = item('duplicate');
      const selected = select(channel, [
        item('first'),
        duplicate,
        item('hidden-between', 'unlisted'),
        structuredClone(duplicate),
        item('last'),
      ]);
      expect(selected.items.map((entry) => entry.id)).toEqual(['first', 'duplicate', 'duplicate', 'last']);
    },
  );

  it.each(PUBLICATION_DISCOVERY_CHANNELS)(
    `does not traverse validate or leak malformed hidden payloads through %s ${evidence}`,
    (channel) => {
      let hiddenReads = 0;
      let validatorCalls = 0;
      const hidden = item('hidden-secret-741', 'unlisted');
      Object.defineProperty(hidden, 'url', {
        enumerable: true,
        get: () => {
          hiddenReads += 1;
          throw new Error('hidden-url-secret-741');
        },
      });
      const cycle: Record<string, unknown> = {};
      cycle.self = cycle;
      hidden.metadata = cycle;
      hidden[Symbol('hidden-secret')] = 'symbol-secret-741';
      const inheritedSecret = Object.assign(Object.create({ secret: 'prototype-secret-741' }), {
        id: 'prototype-hidden',
        visibility: 'private',
      });
      const validator = (value: unknown): value is DiscoveryItem => {
        validatorCalls += 1;
        return isDiscoveryItem(value);
      };

      const selected = selectPublicationDiscoveryCandidates(
        channel,
        [hidden, inheritedSecret, item('visible')],
        validator,
      );
      const output = buildPublicationDiscoveryOutput(createPublicationDiscoveryPage(selected, {
        items: selected.items,
        nextCursor: null,
      }));
      const serialized = JSON.stringify(output);

      // The validator sees only the public item: once at ingress and once on
      // the final detached representation before serialization.
      expect(validatorCalls).toBe(2);
      expect(hiddenReads).toBe(0);
      expect(output.items.map((entry) => entry.id)).toEqual(['visible']);
      expect(serialized).not.toMatch(/hidden|secret|prototype/iu);
    },
  );

  it.each(PUBLICATION_DISCOVERY_CHANNELS)(
    `returns detached deeply frozen selection page and output values for %s ${evidence}`,
    (channel) => {
      const source = item('public-frozen', 'public', {
        metadata: { labels: ['original'] },
      });
      const candidates = [source];
      const selected = select(channel, candidates);
      const page = createPublicationDiscoveryPage(selected, { items: selected.items, nextCursor: null });
      const output = buildPublicationDiscoveryOutput(page);

      expect(selected.items[0]).not.toBe(source);
      expect(page.items[0]).not.toBe(selected.items[0]);
      expect(output.items[0]).not.toBe(page.items[0]);
      expect(Object.isFrozen(selected)).toBe(true);
      expect(Object.isFrozen(selected.items)).toBe(true);
      expect(Object.isFrozen(selected.items[0])).toBe(true);
      expect(Object.isFrozen(selected.items[0]?.metadata)).toBe(true);
      expect(Object.isFrozen(selected.items[0]?.metadata?.labels)).toBe(true);
      expect(Object.isFrozen(page)).toBe(true);
      expect(Object.isFrozen(page.items)).toBe(true);
      expect(Object.isFrozen(output)).toBe(true);
      expect(Object.isFrozen(output.items)).toBe(true);

      (source.metadata as { labels: string[] }).labels[0] = 'caller-mutated';
      candidates.push(item('later'));
      expect(selected.items[0]?.metadata?.labels).toEqual(['original']);
      expect(output.items.map((entry) => entry.id)).toEqual(['public-frozen']);
      expect(() => Object.assign(output.items[0]!, { visibility: 'unlisted' })).toThrow(TypeError);
    },
  );

  it(`requires issued selections and pages and preserves validator provenance at the final guard ${evidence}`, () => {
    const validator = (value: unknown): value is DiscoveryItem => isDiscoveryItem(value)
      && (value as DiscoveryItem).id.startsWith('allowed-');
    const selected = selectPublicationDiscoveryCandidates('search', [item('allowed-one')], validator);

    expect(() => createPublicationDiscoveryPage({
      channel: 'search',
      items: selected.items,
    } as never, { items: selected.items, nextCursor: null })).toThrow(
      new TypeError(INVALID_DISCOVERY_PAGE),
    );
    expect(() => buildPublicationDiscoveryOutput({
      channel: 'search',
      items: selected.items,
      nextCursor: null,
    } as never)).toThrow(new TypeError(INVALID_DISCOVERY_PAGE));

    const page = createPublicationDiscoveryPage(selected, { items: selected.items, nextCursor: 'opaque-cursor' });
    expect(buildPublicationDiscoveryOutput(page).nextCursor).toBe('opaque-cursor');
  });

  it(`accepts null and bounded opaque cursors but rejects malformed or oversized cursor state ${evidence}`, () => {
    const selected = select('sitemap', [item('cursor-public')]);
    expect(createPublicationDiscoveryPage(selected, { items: selected.items, nextCursor: null }).nextCursor).toBeNull();
    expect(createPublicationDiscoveryPage(selected, {
      items: selected.items,
      nextCursor: 'c'.repeat(8_192),
    }).nextCursor).toHaveLength(8_192);
    expect(() => createPublicationDiscoveryPage(selected, {
      items: selected.items,
      nextCursor: 'c'.repeat(8_193),
    })).toThrow(new TypeError(INVALID_DISCOVERY_PAGE));
    expect(() => createPublicationDiscoveryPage(selected, {
      items: selected.items,
      nextCursor: 42,
    } as never)).toThrow(new TypeError(INVALID_DISCOVERY_PAGE));
    expect(() => createPublicationDiscoveryPage(selected, {
      channel: 'sitemap',
      items: selected.items,
      nextCursor: null,
    } as never)).toThrow(new TypeError(INVALID_DISCOVERY_PAGE));
  });

  it.each(PUBLICATION_DISCOVERY_CHANNELS)(
    `fails closed when a raw or cross-channel page tries to bypass the final %s guard ${evidence}`,
    (channel) => {
      expect(() => buildPublicationDiscoveryOutput({
        channel,
        items: [item('hidden-final-secret', 'unlisted')],
        nextCursor: null,
      } as never)).toThrow(new TypeError(INVALID_DISCOVERY_PAGE));

      const selected = select(channel, [item('public-issued')]);
      const otherChannel = PUBLICATION_DISCOVERY_CHANNELS.find((candidate) => candidate !== channel)!;
      const otherSelection = select(otherChannel, [item('other-public')]);
      expect(() => createPublicationDiscoveryPage(selected, {
        items: otherSelection.items,
        nextCursor: null,
      })).toThrow(new TypeError(INVALID_DISCOVERY_PAGE));
    },
  );

  it.each([
    ['missing visibility', undefined],
    ['unknown visibility', 'discoverable'],
    ['uppercase public', 'PUBLIC'],
    ['numeric visibility', 1],
  ])(`rejects %s instead of guessing anonymous discoverability ${evidence}`, (_name, visibility) => {
    const candidate = item('invalid-visibility');
    if (visibility === undefined) delete candidate.visibility;
    else candidate.visibility = visibility;
    expect(() => select('search', [candidate])).toThrow(new TypeError(INVALID_DISCOVERY_INPUT));
  });

  it(`rejects malformed public payloads while still ignoring the same shape when hidden ${evidence}`, () => {
    const malformedPublic = item('malformed-public', 'public', { url: 42 });
    const malformedHidden = item('malformed-hidden', 'unlisted', { url: 42 });
    expect(() => select('search', [malformedPublic])).toThrow(new TypeError(INVALID_DISCOVERY_INPUT));
    expect(select('search', [malformedHidden]).items).toEqual([]);
  });

  it(`rejects public accessors symbols cycles and unsafe prototypes at the discovery boundary ${evidence}`, () => {
    const accessor = item('accessor');
    Object.defineProperty(accessor, 'url', { enumerable: true, get: () => 'https://secret.example/' });
    const symbol = item('symbol', 'public', { [Symbol('secret')]: true });
    const circular = item('circular');
    circular.metadata = circular;
    const prototype = Object.assign(Object.create({ inherited: true }), item('prototype'));

    for (const candidate of [accessor, symbol, circular, prototype]) {
      expect(() => select('search', [candidate])).toThrow(new TypeError(INVALID_DISCOVERY_INPUT));
    }
  });

  it.each([
    ['one candidate', 1, false],
    ['the exact maximum', MAX_PUBLICATION_DISCOVERY_CANDIDATES, false],
    ['one above the maximum', MAX_PUBLICATION_DISCOVERY_CANDIDATES + 1, true],
  ] as const)(`enforces the bounded candidate limit at %s ${evidence}`, (_name, count, rejects) => {
    // Reuse one plain record so the length boundary is isolated from per-item cost.
    const repeated = item('limit-boundary-public');
    const candidates = Array.from({ length: count }, () => repeated);
    if (rejects) {
      const error = captureError(() => select('search', candidates));
      expect(error).toEqual(new RangeError(CANDIDATE_LIMIT));
      expect(error.message).not.toContain('limit-boundary-public');
      expect(error).not.toBeInstanceOf(TypeError);
    } else {
      expect(select('search', candidates).items).toHaveLength(count);
    }
  });

  it.each(PUBLICATION_DISCOVERY_CHANNELS)(
    `surfaces the exact candidate-limit RangeError on every %s channel ${evidence}`,
    (channel) => {
      const secret = `channel-limit-secret-${channel}`;
      const repeated = item(secret);
      const error = captureError(() => select(
        channel,
        Array.from({ length: MAX_PUBLICATION_DISCOVERY_CANDIDATES + 1 }, () => repeated),
      ));
      expect(error).toBeInstanceOf(RangeError);
      expect(error.message).toBe(CANDIDATE_LIMIT);
      expect(error.message).not.toContain(secret);
      expect(error.message).not.toContain(channel);
    },
  );

  it(`rejects an oversized page item array with the same candidate-limit RangeError ${evidence}`, () => {
    const selected = select('instance-feed', [item('issued-page-public')]);
    const oversize = Array.from(
      { length: MAX_PUBLICATION_DISCOVERY_CANDIDATES + 1 },
      () => selected.items[0]!,
    );
    const error = captureError(() => createPublicationDiscoveryPage(selected, {
      items: oversize,
      nextCursor: null,
    }));
    expect(error).toEqual(new RangeError(CANDIDATE_LIMIT));
    expect(error).not.toBeInstanceOf(TypeError);
  });

  it.each([
    ['null', null],
    ['an object', { 0: item('array-like'), length: 1 }],
    ['a string', 'public-a'],
    ['a Set', new Set([item('set-item')])],
    ['an iterator', [item('iterator-item')].values()],
  ])(`rejects non-array candidates supplied as %s with an exact invalid TypeError ${evidence}`, (_name, candidates) => {
    const error = captureError(() => select('search', candidates));
    expect(error).toEqual(new TypeError(INVALID_DISCOVERY_INPUT));
  });

  it.each([
    ['a sparse hole', () => {
      const value = new Array(2);
      value[1] = item('after-hole');
      return value;
    }],
    ['an extra string property', () => Object.assign([item('public-a')], { metadata: 'secret' })],
    ['a symbol property', () => Object.assign([item('public-a')], { [Symbol('secret')]: true })],
    ['an accessor index', () => {
      const value: unknown[] = [];
      Object.defineProperty(value, 0, { enumerable: true, get: () => item('getter') });
      value.length = 1;
      return value;
    }],
  ] as const)(`rejects candidate arrays with %s using an exact invalid TypeError ${evidence}`, (_name, createCandidates) => {
    expect(() => select('mcp-list', createCandidates())).toThrow(new TypeError(INVALID_DISCOVERY_INPUT));
  });

  it.each([
    ['an unknown channel', 'not-a-channel'],
    ['an empty channel', ''],
    ['a numeric channel', 1],
    ['a null channel', null],
  ])(`rejects %s with an exact invalid TypeError before candidate inspection ${evidence}`, (_name, channel) => {
    const error = captureError(() => selectPublicationDiscoveryCandidates(
      channel as never,
      [item('channel-guard')],
      isDiscoveryItem,
    ));
    expect(error).toEqual(new TypeError(INVALID_DISCOVERY_INPUT));
    expect(error.message).not.toContain('channel-guard');
  });

  it(`rejects a non-function validator with an exact invalid TypeError ${evidence}`, () => {
    expect(() => selectPublicationDiscoveryCandidates(
      'search',
      [item('validator-guard')],
      null as never,
    )).toThrow(new TypeError(INVALID_DISCOVERY_INPUT));
  });

  it(`does not echo secrets while rejecting malformed public discovery input ${evidence}`, () => {
    const secret = 'discovery-input-secret-963';
    const error = captureError(() => select('search', [
      item(secret, 'public', { url: 42, owner: secret }),
    ]));
    expect(error).toEqual(new TypeError(INVALID_DISCOVERY_INPUT));
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain('owner');
  });

  it(`preserves the PUB-0009 anonymous Directory exclusion contract ${evidence}`, () => {
    const directory = (id: string, visibility: Visibility) => ({
      id,
      canonicalUrl: `https://catalog.example/collections/${id}`,
      title: id,
      kind: 'knowledge_collection',
      nodeCount: 1,
      updatedAt: '2026-07-18T00:00:00.000Z',
      visibility,
      links: {
        self: `https://api.example/collections/${id}`,
        canonical: `https://catalog.example/collections/${id}`,
        snapshot: `https://cdn.example/${id}.json`,
      },
    });
    const selected = selectAnonymousDirectoryCandidates([
      directory('public-a', 'public'),
      directory('unlisted-secret', 'unlisted'),
      directory('protected-secret', 'protected'),
      directory('private-secret', 'private'),
      directory('public-b', 'public'),
    ]);
    const output = buildAnonymousCollectionDirectory(createAnonymousCollectionDirectoryPage(selected, {
      collections: selected.collections,
      nextCursor: null,
    }));
    expect(output.collections.map((entry) => entry.id)).toEqual(['public-a', 'public-b']);
    expect(JSON.stringify(output)).not.toContain('secret');
  });
});

describe(`PUB-0030 unlisted HTTP anti-discovery headers ${evidence}`, () => {
  it(`emits the two exact anti-discovery fields ${evidence}`, () => {
    const headers = mergePublicationAntiDiscoveryHeaders();
    expect(headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(headers.get('Referrer-Policy')).toBe('no-referrer');
    expect([...headers]).toEqual([
      ['referrer-policy', 'no-referrer'],
      ['x-robots-tag', 'noindex, nofollow'],
    ]);
  });

  it(`preserves unrelated fields while replacing unsafe anti-discovery values exactly ${evidence}`, () => {
    const headers = mergePublicationAntiDiscoveryHeaders({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'X-Trace-Id': 'trace-741',
      'X-Robots-Tag': 'index, follow',
      'Referrer-Policy': 'unsafe-url',
    });
    expect(Object.fromEntries(headers)).toEqual({
      'cache-control': 'private, no-store',
      'content-type': 'text/html; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow',
      'x-trace-id': 'trace-741',
    });
  });

  it(`handles case-insensitive repeated anti-discovery names without duplicate output ${evidence}`, () => {
    const headers = mergePublicationAntiDiscoveryHeaders([
      ['X-ROBOTS-TAG', 'index'],
      ['x-robots-tag', 'follow'],
      ['Referrer-Policy', 'origin'],
      ['REFERRER-POLICY', 'same-origin'],
      ['X-Unrelated', 'one'],
      ['x-unrelated', 'two'],
    ]);
    expect(headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(headers.get('referrer-policy')).toBe('no-referrer');
    expect([...headers].filter(([name]) => name === 'x-robots-tag')).toHaveLength(1);
    expect([...headers].filter(([name]) => name === 'referrer-policy')).toHaveLength(1);
    expect(headers.get('x-unrelated')).toBe('one, two');
  });

  it.each([
    ['success', 200],
    ['no content', 204],
    ['redirect', 302],
    ['not modified', 304],
    ['client error', 404],
  ] as const)(`retains both anti-discovery fields on a %s response status ${evidence}`, (_name, status) => {
    const response = new Response(status === 204 || status === 304 ? null : 'body', {
      status,
      headers: mergePublicationAntiDiscoveryHeaders({ 'X-Unrelated': 'preserved' }),
    });
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('X-Unrelated')).toBe('preserved');
  });

  it(`returns fresh header snapshots and isolates all caller and sibling mutations ${evidence}`, () => {
    const input = new Headers({ 'X-Caller': 'original' });
    const first = mergePublicationAntiDiscoveryHeaders(input);
    const second = mergePublicationAntiDiscoveryHeaders(input);
    input.set('X-Caller', 'mutated');
    input.set('X-Later', 'later');

    expect(first).not.toBe(input);
    expect(first).not.toBe(second);
    expect(first.get('X-Caller')).toBe('original');
    expect(first.has('X-Later')).toBe(false);
    expect(second.get('X-Caller')).toBe('original');

    // Headers has mutable internal slots; freezing its wrapper would not make
    // those slots immutable. Defensible semantics are fresh isolated copies.
    first.set('X-Caller', 'first-only');
    first.delete('X-Robots-Tag');
    expect(second.get('X-Caller')).toBe('original');
    expect(second.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(input.get('X-Caller')).toBe('mutated');
  });

  it(`isolates tuple and record inputs from later structural mutation ${evidence}`, () => {
    const tuples: [string, string][] = [['X-Caller', 'tuple-original']];
    const record = { 'X-Caller': 'record-original' };
    const tupleOutput = mergePublicationAntiDiscoveryHeaders(tuples);
    const recordOutput = mergePublicationAntiDiscoveryHeaders(record);
    tuples[0]![1] = 'tuple-mutated';
    tuples.push(['X-Later', 'later']);
    record['X-Caller'] = 'record-mutated';

    expect(tupleOutput.get('X-Caller')).toBe('tuple-original');
    expect(tupleOutput.has('X-Later')).toBe(false);
    expect(recordOutput.get('X-Caller')).toBe('record-original');
  });

  it.each([
    ['CR in a name', [['X-Bad\rName', 'value']]],
    ['LF in a name', [['X-Bad\nName', 'value']]],
    ['CRLF in a value', [['X-Safe', 'value\r\nX-Injected: yes']]],
    ['NUL in a name', [[`X-Bad\0Name`, 'value']]],
    ['NUL in a value', [['X-Safe', `value\0suffix`]]],
    ['an invalid name separator', [['Bad Header', 'value']]],
    ['an empty header name', [['', 'value']]],
  ] as const)(`rejects %s without constructing a partial result ${evidence}`, (_name, headers) => {
    expect(() => mergePublicationAntiDiscoveryHeaders(headers)).toThrow(new TypeError(INVALID_HEADERS));
  });

  it.each([
    ['more than 128 entries', Array.from({ length: 129 }, (_, index) => [`X-Field-${index}`, 'v'] as const)],
    ['a name above 256 characters', [[`X-${'n'.repeat(255)}`, 'v']] as const],
    ['a value above 8192 UTF-8 bytes', [['X-Large', 'a'.repeat(8193)]] as const],
    ['a multibyte value above 8192 UTF-8 bytes', [['X-Large', '界'.repeat(2_731)]] as const],
    ['an aggregate above 65536 UTF-8 bytes', Array.from(
      { length: 9 },
      (_, index) => [`X-Aggregate-${index}`, 'a'.repeat(8_000)] as const,
    )],
  ] as const)(`rejects %s at the bounded header boundary ${evidence}`, (_name, headers) => {
    expect(() => mergePublicationAntiDiscoveryHeaders(headers)).toThrow(new RangeError(OVERSIZE_HEADERS));
  });

  it.each([
    ['null', null],
    ['a string', 'X-Test: value'],
    ['a Set', new Set([['X-Test', 'value']])],
    ['a sparse tuple array', (() => { const value = new Array(2); value[1] = ['X-Test', 'value']; return value; })()],
    ['a non-string tuple value', [['X-Test', 42]]],
  ])(`rejects invalid header initialization supplied as %s ${evidence}`, (_name, headers) => {
    expect(() => mergePublicationAntiDiscoveryHeaders(headers as never)).toThrow(new TypeError(INVALID_HEADERS));
  });

  it(`does not echo hostile header data through fixed validation errors ${evidence}`, () => {
    const secret = 'private-header-secret-852';
    const error = captureError(() => {
      mergePublicationAntiDiscoveryHeaders([['X-Test', `${secret}\r\nX-Injected: yes`]]);
    });
    expect(error).toEqual(new TypeError(INVALID_HEADERS));
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain('X-Injected');
  });
});
