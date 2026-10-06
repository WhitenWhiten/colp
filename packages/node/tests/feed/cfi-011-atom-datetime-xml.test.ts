import { describe, expect, it } from 'vitest';

import {
  mapFeedToAtom,
  type AtomMapOptions,
  type AtomMapResult,
} from '../../src/feed/atom.js';

const evidence = 'feed.atom';

const invalidXmlCharacters = [
  ['NUL', '\u0000'],
  ['SOH control', '\u0001'],
  ['backspace control', '\u0008'],
  ['vertical-tab control', '\u000b'],
  ['form-feed control', '\u000c'],
  ['shift-out control', '\u000e'],
  ['unit-separator control', '\u001f'],
  ['isolated high surrogate', '\ud800'],
  ['isolated low surrogate', '\udc00'],
  ['U+FFFE noncharacter', '\ufffe'],
  ['U+FFFF noncharacter', '\uffff'],
] as const;

interface TestEvent {
  id: string;
  type: string;
  time: string;
  data: Record<string, unknown>;
}

interface TestFeed {
  feedUrl: string;
  collectionUrl: string;
  title: string;
  events: TestEvent[];
}

function atomEvent(
  time: string,
  index = 0,
  overrides: Partial<TestEvent> = {},
): TestEvent {
  return {
    id: `event-${index}`,
    type: 'org.collectionprotocol.collection.updated.v1',
    time,
    data: { summary: `summary-${index}` },
    ...overrides,
  };
}

function atomFeed(
  times: readonly string[],
  overrides: Partial<Omit<TestFeed, 'events'>> = {},
): TestFeed {
  return {
    feedUrl: 'https://alice.example/collections/c1/feed',
    collectionUrl: 'https://alice.example/collections/c1',
    title: 'Collection updates',
    events: times.map((time, index) => atomEvent(time, index)),
    ...overrides,
  };
}

function successful(
  feed: unknown,
  options?: AtomMapOptions,
): Extract<AtomMapResult, { readonly ok: true }> {
  const result = options === undefined
    ? mapFeedToAtom(feed)
    : mapFeedToAtom(feed, options);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`unexpected Atom mapping failure: ${result.code}`);
  return result;
}

function expectFailure(
  feed: unknown,
  code: Extract<AtomMapResult, { readonly ok: false }>['code'],
  options?: AtomMapOptions,
): void {
  const result = options === undefined
    ? mapFeedToAtom(feed)
    : mapFeedToAtom(feed, options);
  expect(result).toEqual({ ok: false, code });
  expect(Object.isFrozen(result)).toBe(true);
}

describe(`CFI-011 precise Atom updated selection [evidence:${evidence}]`, () => {
  it('orders different offsets by their actual instant instead of wire text', () => {
    const earlierButLexicallyLarger = '2026-07-16T01:00:00+02:00';
    const laterButLexicallySmaller = '2026-07-16T00:30:00Z';
    const result = successful(atomFeed([
      earlierButLexicallyLarger,
      laterButLexicallySmaller,
    ]));

    expect(result.document.updated).toBe(laterButLexicallySmaller);
    expect(result.xml).toContain(`<updated>${laterButLexicallySmaller}</updated>`);
  });

  it.each([
    [
      'offset form first',
      ['2026-07-16T01:00:00+02:00', '2026-07-15T23:00:00.000000Z'],
      '2026-07-16T01:00:00+02:00',
    ],
    [
      'UTC form first',
      ['2026-07-15T23:00:00.000000Z', '2026-07-16T01:00:00+02:00'],
      '2026-07-15T23:00:00.000000Z',
    ],
    [
      'trailing fractional zeros',
      ['2026-07-16T00:00:00.1Z', '2026-07-16T00:00:00.100000000000Z'],
      '2026-07-16T00:00:00.1Z',
    ],
  ] as const)('uses the first event as the stable tie-break for %s', (_label, times, first) => {
    const result = successful(atomFeed(times));

    expect(result.document.updated).toBe(first);
    expect(result.document.entries.map((entry) => entry.updated)).toEqual(times);
  });

  it('selects the later sub-millisecond instant without precision loss', () => {
    const earlier = '2026-07-16T00:00:00.000000000000000000000000000001Z';
    const later = '2026-07-16T00:00:00.000000000000000000000000000002Z';
    const result = successful(atomFeed([later, earlier]));

    expect(result.document.updated).toBe(later);
    expect(result.document.entries[0]?.updated).toBe(later);
    expect(result.document.entries[1]?.updated).toBe(earlier);
  });

  it('compares arbitrary fractional precision across offsets', () => {
    const earlier = '2026-07-16T08:00:00.123456789012345678901234567890+08:00';
    const later = '2026-07-16T00:00:00.123456789012345678901234567891Z';
    const result = successful(atomFeed([earlier, later]));

    expect(result.document.updated).toBe(later);
  });

  it.each([
    ['event time', atomFeed(['2026-07-16T07:00:00-00:00']), undefined],
    ['empty fallback', atomFeed([]), { emptyFeedUpdated: '2026-07-16T07:00:00-00:00' }],
  ] as const)('rejects the RFC 3339 unknown local offset in %s', (_label, feed, options) => {
    expectFailure(feed, 'invalid_datetime', options);
  });
});

describe(`CFI-011 Atom leap-second policy [evidence:${evidence}]`, () => {
  it.each([
    [
      'after the preceding ordinary second',
      ['1990-12-31T23:59:59.999999999999Z', '1990-12-31T23:59:60Z'],
      '1990-12-31T23:59:60Z',
    ],
    [
      'before the following midnight',
      ['1990-12-31T23:59:60.999999999999Z', '1991-01-01T00:00:00Z'],
      '1991-01-01T00:00:00Z',
    ],
    [
      'at full fractional precision',
      ['1990-12-31T23:59:60.000000000001Z', '1990-12-31T23:59:60.000000000002Z'],
      '1990-12-31T23:59:60.000000000002Z',
    ],
  ] as const)('orders a valid leap second %s', (_label, times, expected) => {
    expect(successful(atomFeed(times)).document.updated).toBe(expected);
  });

  it('treats offset spellings of the same leap-second instant as equal', () => {
    const first = '1991-01-01T00:59:60+01:00';
    const sameInstant = '1990-12-31T22:59:60-01:00';

    expect(successful(atomFeed([first, sameInstant])).document.updated).toBe(first);
  });

  it.each([
    '1990-12-30T23:59:60Z',
    '1990-12-31T23:58:60Z',
    '1991-01-01T00:00:60Z',
    '2024-12-31T22:59:60Z',
    '2025-01-01T00:58:60+01:00',
  ])('rejects an invalid leap-second boundary %s', (time) => {
    expectFailure(atomFeed([time]), 'invalid_datetime');
  });
});

describe(`CFI-011 invalid Atom date-times [evidence:${evidence}]`, () => {
  it.each([
    '',
    'not-a-date-time',
    '2026-07-16T07:00:00',
    '2026-07-16 07:00:00Z',
    '2023-02-29T07:00:00Z',
    '2026-13-01T07:00:00Z',
    '2026-07-16T24:00:00Z',
    '2026-07-16T07:60:00Z',
    '2026-07-16T07:00:61Z',
    '2026-07-16T07:00:00+24:00',
    '2026-07-16T07:00:00.Z',
    '2026-07-16T07:00:00Z trailing-data',
    '2026-07-16T07:00:00Z\u0000',
    '2026-07-16T07:00:00Z\ud800',
    '2026-07-16T07:00:00Z\udc00',
  ])('rejects invalid event time %j', (time) => {
    expectFailure(atomFeed([time]), 'invalid_datetime');
  });

  it.each([
    'not-a-date-time',
    '2026-07-16T07:00:00',
    '2023-02-29T07:00:00Z',
    '2026-07-16T07:00:00Z\u0000',
  ])('rejects invalid empty-feed updated %j', (emptyFeedUpdated) => {
    expectFailure(atomFeed([]), 'invalid_datetime', { emptyFeedUpdated });
  });

  it.each(invalidXmlCharacters)(
    'rejects %s in both updated sources through the date-time contract',
    (_label, value) => {
      expectFailure(
        atomFeed([`2026-07-16T07:00:00Z${value}`]),
        'invalid_datetime',
      );
      expectFailure(
        atomFeed([]),
        'invalid_datetime',
        { emptyFeedUpdated: `2026-07-16T07:00:00Z${value}` },
      );
    },
  );

  it('rejects a non-string event time under the date-time contract', () => {
    const feed = atomFeed(['2026-07-16T07:00:00Z']);
    feed.events[0]!.time = 42 as unknown as string;

    expectFailure(feed, 'malformed_feed');
  });
});

describe(`CFI-011 empty Atom feed updated contract [evidence:${evidence}]`, () => {
  it('rejects an empty feed without caller-provided updated', () => {
    expectFailure(atomFeed([]), 'missing_updated');
  });

  it('accepts and preserves a valid caller-provided empty-feed updated', () => {
    const updated = '2026-07-16T09:30:00.123456789+02:00';
    const result = successful(atomFeed([]), { emptyFeedUpdated: updated });

    expect(result.document.updated).toBe(updated);
    expect(result.document.entries).toEqual([]);
    expect(result.xml).toContain(`<updated>${updated}</updated>`);
    expect(result.xml).not.toContain('<entry>');
  });

  it('validates but does not use the fallback for a non-empty feed', () => {
    const eventTime = '2026-07-16T10:00:00.000000001Z';
    const result = successful(atomFeed([eventTime]), {
      emptyFeedUpdated: '2099-12-31T23:59:59Z',
    });

    expect(result.document.updated).toBe(eventTime);
  });

  it('rejects an invalid fallback even when events are non-empty', () => {
    expectFailure(
      atomFeed(['2026-07-16T10:00:00Z']),
      'invalid_datetime',
      { emptyFeedUpdated: 'invalid' },
    );
  });
});

interface XmlSourceCase {
  readonly label: string;
  readonly inject: (feed: TestFeed, value: string) => void;
}

const xmlSourceCases: readonly XmlSourceCase[] = [
  {
    label: 'feed title element text',
    inject: (feed, value) => {
      feed.title = `title${value}`;
    },
  },
  {
    label: 'feed URL element text and href attribute',
    inject: (feed, value) => {
      feed.feedUrl = `https://alice.example/feed/${value}`;
    },
  },
  {
    label: 'Collection URL href attribute',
    inject: (feed, value) => {
      feed.collectionUrl = `https://alice.example/collection/${value}`;
    },
  },
  {
    label: 'entry id element text',
    inject: (feed, value) => {
      feed.events[0]!.id = `event${value}`;
    },
  },
  {
    label: 'entry type-derived title element text',
    inject: (feed, value) => {
      feed.events[0]!.type = `type${value}`;
      feed.events[0]!.data = {};
    },
  },
  {
    label: 'entry summary-derived title and summary element text',
    inject: (feed, value) => {
      feed.events[0]!.data = { summary: `summary${value}` };
    },
  },
  {
    label: 'Bookmark related-link href attribute',
    inject: (feed, value) => {
      feed.events[0]!.data = {
        node: {
          kind: 'bookmark',
          url: `https://bookmark.example/item/${value}`,
        },
      };
    },
  },
];

describe.each(xmlSourceCases)(
  `CFI-011 XML 1.0 rejection at $label [evidence:${evidence}]`,
  ({ inject }) => {
    it.each(invalidXmlCharacters)('rejects %s before serialization', (_label, value) => {
      const feed = atomFeed(['2026-07-16T07:00:00Z']);
      inject(feed, value);

      expectFailure(feed, 'invalid_xml');
    });
  },
);

describe(`CFI-011 XML 1.0 allowed characters and escaping [evidence:${evidence}]`, () => {
  it.each([
    ['TAB', '\u0009'],
    ['LF', '\u000a'],
    ['CR', '\u000d'],
    ['lowest ordinary character', '\u0020'],
    ['BMP before surrogate range', '\ud7ff'],
    ['BMP after surrogate range', '\ue000'],
    ['Unicode noncharacter U+FDD0 allowed by XML Char', '\ufdd0'],
    ['last allowed BMP code point', '\ufffd'],
    ['lowest supplementary code point', '\u{10000}'],
    ['supplementary plane-end noncharacter allowed by XML Char', '\u{1fffe}'],
    ['highest Unicode code point', '\u{10ffff}'],
  ])('accepts %s in element text', (_label, value) => {
    const feed = atomFeed(['2026-07-16T07:00:00Z'], { title: `before${value}after` });
    const result = successful(feed);

    expect(result.document.title).toBe(`before${value}after`);
    expect(result.xml).toContain(`before${value}after`);
  });

  it('escapes all five XML predefined characters in element text', () => {
    const special = `ampersand & less < greater > double " apostrophe '`;
    const feed = atomFeed(['2026-07-16T07:00:00Z'], { title: special });
    feed.events[0]!.data = { summary: special };
    const result = successful(feed);
    const escaped = 'ampersand &amp; less &lt; greater &gt; double &quot; apostrophe &apos;';

    expect(result.document.title).toBe(special);
    expect(result.document.entries[0]?.summary).toBe(special);
    expect(result.xml).toContain(`<title>${escaped}</title>`);
    expect(result.xml).toContain(`<summary>${escaped}</summary>`);
    expect(result.xml).not.toContain(`<title>${special}</title>`);
  });

  it('escapes legal XML metacharacters in every caller-controlled href attribute', () => {
    const feed = atomFeed(['2026-07-16T07:00:00Z']);
    feed.feedUrl = "https://alice.example/feed?a=1&owner=O'Hara";
    feed.collectionUrl = "https://alice.example/collection?a=1&owner=O'Hara";
    feed.events[0]!.data = {
      node: {
        kind: 'bookmark',
        url: "https://bookmark.example/item?a=1&owner=O'Hara",
      },
    };
    const result = successful(feed);

    expect(result.xml).toContain(
      'href="https://alice.example/feed?a=1&amp;owner=O&apos;Hara"',
    );
    expect(result.xml).toContain(
      'href="https://alice.example/collection?a=1&amp;owner=O&apos;Hara"',
    );
    expect(result.xml).toContain(
      'href="https://bookmark.example/item?a=1&amp;owner=O&apos;Hara"',
    );
  });
});

describe(`CFI-011 Atom options and output boundaries [evidence:${evidence}]`, () => {
  it.each([
    ['null', null],
    ['array', []],
    ['string', 'invalid'],
    ['non-string emptyFeedUpdated', { emptyFeedUpdated: 42 }],
  ])('rejects %s options', (_label, options) => {
    expectFailure(atomFeed([]), 'invalid_options', options as unknown as AtomMapOptions);
  });

  it.each([
    ['unknown field', { emptyFeedUpdated: '2026-07-16T07:00:00Z', unknown: true }],
    ['symbol key', {
      emptyFeedUpdated: '2026-07-16T07:00:00Z',
      [Symbol('hidden')]: true,
    }],
  ])('rejects options with an %s', (_label, options) => {
    expectFailure(atomFeed([]), 'invalid_options', options as AtomMapOptions);
  });

  it('rejects non-enumerable options state', () => {
    const options = { emptyFeedUpdated: '2026-07-16T07:00:00Z' } as AtomMapOptions & {
      hidden?: boolean;
    };
    Object.defineProperty(options, 'hidden', {
      enumerable: false,
      value: true,
    });

    expectFailure(atomFeed([]), 'invalid_options', options);
  });

  it('rejects an options accessor without invoking its getter', () => {
    let getters = 0;
    const options: Record<string, unknown> = {};
    Object.defineProperty(options, 'emptyFeedUpdated', {
      enumerable: true,
      get() {
        getters += 1;
        return '2026-07-16T07:00:00Z';
      },
    });

    expectFailure(atomFeed([]), 'invalid_options', options as AtomMapOptions);
    expect(getters).toBe(0);
  });

  it('rejects an options Proxy without invoking any trap', () => {
    let traps = 0;
    const trap = (): never => {
      traps += 1;
      throw new Error('options Proxy trap must not run');
    };
    const options = new Proxy(
      { emptyFeedUpdated: '2026-07-16T07:00:00Z' },
      {
        get: trap,
        getOwnPropertyDescriptor: trap,
        getPrototypeOf: trap,
        has: trap,
        ownKeys: trap,
      },
    );

    expectFailure(atomFeed([]), 'invalid_options', options);
    expect(traps).toBe(0);
  });

  it('rejects hostile Feed input without invoking Proxy traps or accessors', () => {
    let calls = 0;
    const trap = (): never => {
      calls += 1;
      throw new Error('Feed input code must not run');
    };
    const proxiedFeed = new Proxy(atomFeed(['2026-07-16T07:00:00Z']), {
      get: trap,
      getOwnPropertyDescriptor: trap,
      getPrototypeOf: trap,
      has: trap,
      ownKeys: trap,
    });
    expectFailure(proxiedFeed, 'malformed_feed');

    const accessorFeed = atomFeed(['2026-07-16T07:00:00Z']) as unknown as Record<
      string,
      unknown
    >;
    Object.defineProperty(accessorFeed, 'title', {
      enumerable: true,
      get() {
        calls += 1;
        return 'title';
      },
    });
    expectFailure(accessorFeed, 'malformed_feed');
    expect(calls).toBe(0);
  });

  it('returns a detached, deeply frozen document and XML snapshot', () => {
    const feed = atomFeed(['2026-07-16T07:00:00.123456789Z']);
    feed.events[0]!.data = { summary: 'Original summary' };
    const result = successful(feed);
    const beforeDocument = JSON.stringify(result.document);
    const beforeXml = result.xml;

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.document)).toBe(true);
    expect(Object.isFrozen(result.document.links)).toBe(true);
    expect(result.document.links.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(result.document.entries)).toBe(true);
    expect(result.document.entries.every(Object.isFrozen)).toBe(true);
    expect(result.document.entries.every((entry) => Object.isFrozen(entry.links))).toBe(true);
    expect(result.document.entries.flatMap((entry) => entry.links).every(Object.isFrozen)).toBe(true);

    expect(result.document).toMatchObject({
      id: feed.feedUrl,
      title: feed.title,
      updated: '2026-07-16T07:00:00.123456789Z',
      entries: [{
        id: 'urn:collectionprotocol:event:event-0',
        title: 'Original summary',
        updated: '2026-07-16T07:00:00.123456789Z',
        summary: 'Original summary',
        content: 'Original summary',
      }],
    });
    expect(result.xml).toMatch(/^<\?xml version="1\.0" encoding="utf-8"\?>\n<feed /u);
    expect(result.xml).toContain('</feed>');

    feed.title = 'Changed title';
    feed.events[0]!.time = '2099-01-01T00:00:00Z';
    feed.events[0]!.data.summary = 'Changed summary';
    expect(JSON.stringify(result.document)).toBe(beforeDocument);
    expect(result.xml).toBe(beforeXml);
  });
});
