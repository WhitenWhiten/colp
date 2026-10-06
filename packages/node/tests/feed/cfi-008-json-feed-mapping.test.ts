import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  JSON_FEED_MAX_ATTACHMENTS_PER_EVENT,
  JSON_FEED_MAX_ATTACHMENT_SIZE_IN_BYTES,
  JSON_FEED_MAX_ATTACHMENT_TITLE_LENGTH,
  JSON_FEED_MAX_AUTHORS,
  JSON_FEED_MAX_AUTHOR_NAME_LENGTH,
  JSON_FEED_MAX_MIME_TYPE_LENGTH,
  JSON_FEED_MAX_TAGS,
  JSON_FEED_MAX_TAG_LENGTH,
  JSON_FEED_MAX_TITLE_LENGTH,
  JSON_FEED_MAX_URL_LENGTH,
  mapFeedToJsonFeed,
  type JsonFeedAttachment,
  type JsonFeedMapOptions,
} from '../../src/feed/json-feed.js';

const evidence = 'feed.json-feed';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const fixture = JSON.parse(
  readFileSync(resolve(fixturesRoot, 'public-feed.json'), 'utf8'),
) as Record<string, unknown>;
const eventId = (
  (fixture.events as Array<Record<string, unknown>>)[0]!.id as string
);

function validFeed(): Record<string, unknown> {
  return structuredClone(fixture);
}

function eventOf(feed: Record<string, unknown>): Record<string, unknown> {
  return (feed.events as Array<Record<string, unknown>>)[0]!;
}

function expectFailure(
  feed: unknown,
  code: 'malformed_feed' | 'unsafe_url' | 'invalid_subject' | 'invalid_options' | 'invalid_attachment',
  options?: unknown,
): void {
  expect(mapFeedToJsonFeed(feed, options as JsonFeedMapOptions)).toEqual({ ok: false, code });
}

function urlWithLength(length: number): string {
  const prefix = 'https://attachments.example/';
  return `${prefix}${'a'.repeat(length - prefix.length)}`;
}

function attachment(
  overrides: Partial<JsonFeedAttachment> = {},
): JsonFeedAttachment {
  return {
    url: 'https://attachments.example/document.pdf',
    mime_type: 'application/pdf',
    title: 'Document',
    size_in_bytes: 42,
    ...overrides,
  };
}

function optionsWithAttachments(
  attachments: readonly JsonFeedAttachment[],
): JsonFeedMapOptions {
  return { attachmentsByEventId: { [eventId]: attachments } };
}

function hiddenProperty(
  source: Record<string, unknown> | unknown[],
  name: string,
  value: unknown,
): void {
  Object.defineProperty(source, name, { enumerable: false, value });
}

function trappedProxy<T extends object>(target: T, onTrap: () => never): T {
  return new Proxy(target, {
    get: onTrap,
    getOwnPropertyDescriptor: onTrap,
    getPrototypeOf: onTrap,
    has: onTrap,
    ownKeys: onTrap,
  });
}

describe(`CFI-008 JSON Feed subject mapping [evidence:${evidence}]`, () => {
  it('maps the official public-feed relative subject to items[0].url', () => {
    const result = mapFeedToJsonFeed(validFeed());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.items[0]!.url).toBe(
        'https://alice.example/collections/c/019b3ca2-8424-7cc2-9a61-4bf44c23f07a/releases/release-r_1042',
      );
    }
  });

  it.each([
    ['relative to source', 'events/e1', 'https://alice.example/events/e1'],
    ['root-relative', '/events/e1', 'https://alice.example/events/e1'],
    ['cross-origin network-path reference', '//bob.example/events/e1', 'https://bob.example/events/e1'],
    ['same-origin absolute', 'https://alice.example/events/e1', 'https://alice.example/events/e1'],
    ['cross-origin absolute', 'https://bob.example/events/e1', 'https://bob.example/events/e1'],
  ])('accepts a %s subject', (_label, subject, expected) => {
    const feed = validFeed();
    eventOf(feed).subject = subject;

    const result = mapFeedToJsonFeed(feed);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document.items[0]!.url).toBe(expected);
  });

  it('accepts an absolute HTTP(S) subject independently of a non-HTTP source', () => {
    const feed = validFeed();
    Object.assign(eventOf(feed), {
      source: 'urn:example:collection',
      subject: 'https://bob.example/events/e1',
    });

    const result = mapFeedToJsonFeed(feed);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document.items[0]!.url).toBe('https://bob.example/events/e1');
  });

  it.each([
    ['userinfo HTTP URL', 'https://user:password@example.com/event'],
    ['non-HTTP URL', 'file:///tmp/event'],
    ['non-HTTP scheme', 'urn:example:event'],
    ['unparseable absolute URL', 'https://[invalid/event'],
    ['unparseable network-path reference', '//[invalid/event'],
    ['overlong absolute URL', urlWithLength(JSON_FEED_MAX_URL_LENGTH + 1)],
  ])('fails closed with invalid_subject for a %s', (_label, subject) => {
    const feed = validFeed();
    eventOf(feed).subject = subject;

    expectFailure(feed, 'invalid_subject');
  });

  it.each([
    ['non-HTTP source', 'urn:example:source'],
    ['userinfo source', 'https://user:password@alice.example/base/'],
  ])('fails closed when a relative subject has a %s', (_label, source) => {
    const feed = validFeed();
    Object.assign(eventOf(feed), { source, subject: 'events/e1' });

    expectFailure(feed, 'invalid_subject');
  });

  it.each([
    ['missing required Feed field', (feed: Record<string, unknown>) => { delete feed.nextCursor; }],
    ['invalid Feed field', (feed: Record<string, unknown>) => { feed.hasMore = 'false'; }],
    ['events is not an array', (feed: Record<string, unknown>) => { feed.events = {}; }],
    ['invalid Event id', (feed: Record<string, unknown>) => { eventOf(feed).id = ''; }],
    ['invalid Event type', (feed: Record<string, unknown>) => { eventOf(feed).type = 'unknown'; }],
    ['invalid Event data', (feed: Record<string, unknown>) => { eventOf(feed).data = {}; }],
  ])('rejects a contract-invalid %s as malformed_feed', (_label, mutate) => {
    const feed = validFeed();
    mutate(feed);

    expectFailure(feed, 'malformed_feed');
  });

  it('validates every Event rather than only the first one', () => {
    const feed = validFeed();
    const second = structuredClone(eventOf(feed));
    second.id = '019b3d0b-efcf-7fa7-9778-33e8e77620f5';
    second.data = {};
    (feed.events as Array<Record<string, unknown>>).push(second);

    expectFailure(feed, 'malformed_feed');
  });

  it.each(['file:///tmp/feed', 'https://user:password@example.com/feed'])(
    'keeps unsafe top-level URL failures distinct for %s',
    (feedUrl) => {
      const feed = validFeed();
      feed.feedUrl = feedUrl;

      expectFailure(feed, 'unsafe_url');
    },
  );
});

describe(`CFI-008 JSON Feed attachment option [evidence:${evidence}]`, () => {
  it('maps safe attachments and freezes their detached snapshots', () => {
    const original = attachment() as {
      url: string;
      mime_type: string;
      title?: string;
      size_in_bytes?: number;
    };
    const attachments = [original];
    const byEvent = { [eventId]: attachments };
    const options = { attachmentsByEventId: byEvent };

    const result = mapFeedToJsonFeed(validFeed(), options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mapped = result.document.items[0]!.attachments!;
    expect(mapped).toEqual([original]);
    expect(Object.isFrozen(mapped)).toBe(true);
    expect(Object.isFrozen(mapped[0])).toBe(true);
    expect(() => { (mapped[0] as { title?: string }).title = 'changed'; }).toThrow(TypeError);

    original.title = 'mutated original';
    original.url = 'https://attacker.example/changed';
    attachments.push(attachment({ title: 'late' }));
    byEvent[eventId] = [];
    expect(mapped).toEqual([{
      url: 'https://attachments.example/document.pdf',
      mime_type: 'application/pdf',
      title: 'Document',
      size_in_bytes: 42,
    }]);
  });

  it.each([
    ['HTTP', 'http://attachments.example/a'],
    ['HTTPS', 'https://attachments.example/a'],
    ['maximum URL length', urlWithLength(JSON_FEED_MAX_URL_LENGTH)],
  ])('accepts a safe %s attachment URL', (_label, url) => {
    const result = mapFeedToJsonFeed(
      validFeed(),
      optionsWithAttachments([attachment({ url })]),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document.items[0]!.attachments?.[0]?.url).toBe(url);
  });

  it('accepts an empty attachment list and rejects an attachment without required MIME', () => {
    const empty = mapFeedToJsonFeed(validFeed(), optionsWithAttachments([]));
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.document.items[0]!.attachments).toEqual([]);

    expectFailure(validFeed(), 'invalid_attachment', {
      attachmentsByEventId: {
        [eventId]: [{ url: 'https://attachments.example/missing-mime' }],
      },
    });
  });

  it.each([
    ['userinfo URL', 'https://user:password@example.com/a'],
    ['file URL', 'file:///tmp/a'],
    ['javascript URL', 'javascript:alert(1)'],
    ['relative URL', '/attachments/a'],
    ['malformed URL', 'https://[invalid/a'],
    ['URL over the length limit', urlWithLength(JSON_FEED_MAX_URL_LENGTH + 1)],
  ])('rejects a %s as invalid_attachment', (_label, url) => {
    expectFailure(
      validFeed(),
      'invalid_attachment',
      optionsWithAttachments([attachment({ url })]),
    );
  });

  it.each([
    'application/json',
    'application/vnd.collection+json',
    'text/plain',
    `${'a'.repeat(127)}/${'b'.repeat(127)}`,
  ])('accepts MIME type %s without parameters', (mime_type) => {
    const result = mapFeedToJsonFeed(
      validFeed(),
      optionsWithAttachments([attachment({ mime_type })]),
    );

    expect(result.ok).toBe(true);
  });

  it.each([
    ['parameters', 'application/json; charset=utf-8'],
    ['missing slash', 'application'],
    ['empty type', '/json'],
    ['empty subtype', 'application/'],
    ['space', 'application /json'],
    ['Unicode token', 'application/jso\u2603'],
    ['control character', 'application/json\n'],
    ['overlong MIME', `${'a'.repeat(127)}/${'b'.repeat(128)}`],
  ])('rejects MIME with %s as invalid_attachment', (_label, mime_type) => {
    expectFailure(
      validFeed(),
      'invalid_attachment',
      optionsWithAttachments([attachment({ mime_type })]),
    );
  });

  it.each([0, 1, JSON_FEED_MAX_ATTACHMENT_SIZE_IN_BYTES])(
    'accepts attachment size %s',
    (size_in_bytes) => {
      expect(mapFeedToJsonFeed(
        validFeed(),
        optionsWithAttachments([attachment({ size_in_bytes })]),
      ).ok).toBe(true);
    },
  );

  it.each([
    ['negative', -1],
    ['non-integer', 1.5],
    ['unsafe integer overflow', JSON_FEED_MAX_ATTACHMENT_SIZE_IN_BYTES + 1],
    ['infinity', Number.POSITIVE_INFINITY],
  ])('rejects a %s attachment size as invalid_attachment', (_label, size_in_bytes) => {
    expectFailure(
      validFeed(),
      'invalid_attachment',
      optionsWithAttachments([attachment({ size_in_bytes })]),
    );
  });

  it('enforces attachment title and per-event quantity boundaries', () => {
    const maximumTitle = 't'.repeat(JSON_FEED_MAX_ATTACHMENT_TITLE_LENGTH);
    expect(mapFeedToJsonFeed(
      validFeed(),
      optionsWithAttachments(Array.from(
        { length: JSON_FEED_MAX_ATTACHMENTS_PER_EVENT },
        (_, index) => attachment({ title: index === 0 ? maximumTitle : `a${index}` }),
      )),
    ).ok).toBe(true);

    expectFailure(
      validFeed(),
      'invalid_attachment',
      optionsWithAttachments([attachment({
        title: 't'.repeat(JSON_FEED_MAX_ATTACHMENT_TITLE_LENGTH + 1),
      })]),
    );
    expectFailure(
      validFeed(),
      'invalid_attachment',
      optionsWithAttachments(Array.from(
        { length: JSON_FEED_MAX_ATTACHMENTS_PER_EVENT + 1 },
        () => attachment(),
      )),
    );
  });

  it('rejects unknown event IDs and non-exact attachment shapes', () => {
    expectFailure(validFeed(), 'invalid_attachment', {
      attachmentsByEventId: { unknown: [attachment()] },
    });
    expectFailure(validFeed(), 'invalid_attachment', {
      attachmentsByEventId: { [eventId]: [{ ...attachment(), digest: 'sha-256=:x=:' }] },
    });
    expectFailure(validFeed(), 'invalid_attachment', {
      attachmentsByEventId: { [eventId]: [{ mime_type: 'application/pdf' }] },
    });
    expectFailure(validFeed(), 'invalid_attachment', {
      attachmentsByEventId: { [eventId]: 'not-an-array' },
    });
    expectFailure(validFeed(), 'invalid_attachment', { attachmentsByEventId: [] });
    expectFailure(validFeed(), 'invalid_attachment', { attachmentsByEventId: null });
  });

  it('rejects sparse and augmented attachment arrays', () => {
    const sparse = new Array<JsonFeedAttachment>(1);
    expectFailure(validFeed(), 'invalid_attachment', optionsWithAttachments(sparse));

    const augmented = [attachment()];
    (augmented as unknown as Record<string, unknown>).extra = true;
    expectFailure(validFeed(), 'invalid_attachment', optionsWithAttachments(augmented));
  });

  it('rejects attachment accessors, Proxies, Symbols, and hidden fields without reading them', () => {
    let getterCalls = 0;
    const accessor = { ...attachment() } as Record<string, unknown>;
    Object.defineProperty(accessor, 'title', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'accessed';
      },
    });
    expectFailure(validFeed(), 'invalid_attachment', optionsWithAttachments([
      accessor as unknown as JsonFeedAttachment,
    ]));
    expect(getterCalls).toBe(0);

    let trapCalls = 0;
    const proxy = trappedProxy(attachment(), () => {
      trapCalls += 1;
      throw new Error('attachment Proxy trap must not run');
    });
    expectFailure(validFeed(), 'invalid_attachment', optionsWithAttachments([proxy]));
    expect(trapCalls).toBe(0);

    const symbol = { ...attachment(), [Symbol('secret')]: true };
    expectFailure(validFeed(), 'invalid_attachment', optionsWithAttachments([symbol]));

    const hidden = { ...attachment() } as Record<string, unknown>;
    hiddenProperty(hidden, 'secret', true);
    expectFailure(validFeed(), 'invalid_attachment', optionsWithAttachments([
      hidden as unknown as JsonFeedAttachment,
    ]));
  });

  it('rejects attachment map accessors, Proxies, Symbols, and hidden fields without reads', () => {
    let getterCalls = 0;
    const optionAccessor: Record<string, unknown> = {};
    Object.defineProperty(optionAccessor, 'attachmentsByEventId', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return { [eventId]: [attachment()] };
      },
    });
    expectFailure(validFeed(), 'invalid_attachment', optionAccessor);
    expect(getterCalls).toBe(0);

    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, eventId, {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return [attachment()];
      },
    });
    expectFailure(validFeed(), 'invalid_attachment', { attachmentsByEventId: accessor });
    expect(getterCalls).toBe(0);

    let trapCalls = 0;
    const proxy = trappedProxy({ [eventId]: [attachment()] }, () => {
      trapCalls += 1;
      throw new Error('attachment map Proxy trap must not run');
    });
    expectFailure(validFeed(), 'invalid_attachment', { attachmentsByEventId: proxy });
    expect(trapCalls).toBe(0);

    expectFailure(validFeed(), 'invalid_attachment', {
      attachmentsByEventId: { [eventId]: [attachment()], [Symbol('secret')]: true },
    });
    const hidden: Record<string, unknown> = { [eventId]: [attachment()] };
    hiddenProperty(hidden, 'secret', true);
    expectFailure(validFeed(), 'invalid_attachment', { attachmentsByEventId: hidden });
  });
});

describe(`CFI-008 JSON Feed mapper option boundary [evidence:${evidence}]`, () => {
  it('accepts authors, tags, and title at their exact quantity and length limits', () => {
    const authors = Array.from({ length: JSON_FEED_MAX_AUTHORS }, (_, index) => ({
      name: index === 0 ? 'a'.repeat(JSON_FEED_MAX_AUTHOR_NAME_LENGTH) : `author-${index}`,
      url: `https://authors.example/${index}`,
    }));
    const tags = Array.from(
      { length: JSON_FEED_MAX_TAGS },
      (_, index) => index === 0 ? 't'.repeat(JSON_FEED_MAX_TAG_LENGTH) : `tag-${index}`,
    );
    const titleOverride = 'T'.repeat(JSON_FEED_MAX_TITLE_LENGTH);

    const result = mapFeedToJsonFeed(validFeed(), { authors, tags, titleOverride });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.authors).toHaveLength(JSON_FEED_MAX_AUTHORS);
      expect(result.document.items[0]!.tags).toHaveLength(JSON_FEED_MAX_TAGS);
      expect(result.document.title).toBe(titleOverride);
    }
  });

  it.each([
    ['options is null', null],
    ['options is an array', []],
    ['options is a string', 'options'],
    ['authors is not an array', { authors: {} }],
    ['tags is not an array', { tags: 'tag' }],
    ['title is not a string', { titleOverride: 1 }],
    ['author name is not a string', { authors: [{ name: 1 }] }],
    ['author URL is not a string', { authors: [{ name: 'A', url: 1 }] }],
    ['tag is not a string', { tags: ['tag', 1] }],
    ['unknown option', { unknown: true }],
    ['unknown author field', { authors: [{ name: 'A', unknown: true }] }],
  ])('rejects runtime type/shape error: %s', (_label, options) => {
    expectFailure(validFeed(), 'invalid_options', options);
  });

  it('rejects authors, tags, and title one past each budget', () => {
    expectFailure(validFeed(), 'invalid_options', {
      authors: Array.from({ length: JSON_FEED_MAX_AUTHORS + 1 }, () => ({ name: 'A' })),
    });
    expectFailure(validFeed(), 'invalid_options', {
      authors: [{ name: 'a'.repeat(JSON_FEED_MAX_AUTHOR_NAME_LENGTH + 1) }],
    });
    expectFailure(validFeed(), 'invalid_options', {
      tags: Array.from({ length: JSON_FEED_MAX_TAGS + 1 }, () => 'tag'),
    });
    expectFailure(validFeed(), 'invalid_options', {
      tags: ['t'.repeat(JSON_FEED_MAX_TAG_LENGTH + 1)],
    });
    expectFailure(validFeed(), 'invalid_options', {
      titleOverride: 'T'.repeat(JSON_FEED_MAX_TITLE_LENGTH + 1),
    });
  });

  it.each([
    ['author URL with userinfo', 'https://user:password@example.com/'],
    ['non-HTTP author URL', 'mailto:alice@example.com'],
    ['relative author URL', '/authors/alice'],
    ['overlong author URL', urlWithLength(JSON_FEED_MAX_URL_LENGTH + 1)],
  ])('rejects %s as invalid_options', (_label, url) => {
    expectFailure(validFeed(), 'invalid_options', { authors: [{ name: 'Alice', url }] });
  });

  it('rejects sparse and augmented author/tag arrays', () => {
    const sparseAuthors = new Array(1);
    expectFailure(validFeed(), 'invalid_options', { authors: sparseAuthors });
    const sparseTags = new Array(1);
    expectFailure(validFeed(), 'invalid_options', { tags: sparseTags });

    const authors = [{ name: 'A' }];
    (authors as unknown as Record<string, unknown>).extra = true;
    expectFailure(validFeed(), 'invalid_options', { authors });
    const tags = ['tag'];
    (tags as unknown as Record<string, unknown>).extra = true;
    expectFailure(validFeed(), 'invalid_options', { tags });
  });

  it('rejects option and author accessors, Proxies, Symbols, and hidden fields without reads', () => {
    let getterCalls = 0;
    for (const key of ['authors', 'tags', 'titleOverride']) {
      const accessor: Record<string, unknown> = {};
      Object.defineProperty(accessor, key, {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return key === 'titleOverride' ? 'Title' : [];
        },
      });
      expectFailure(validFeed(), 'invalid_options', accessor);
    }
    expect(getterCalls).toBe(0);

    let trapCalls = 0;
    const proxy = trappedProxy({ tags: ['tag'] }, () => {
      trapCalls += 1;
      throw new Error('option Proxy trap must not run');
    });
    expectFailure(validFeed(), 'invalid_options', proxy);
    expect(trapCalls).toBe(0);

    const authorAccessor: Record<string, unknown> = {};
    Object.defineProperty(authorAccessor, 'name', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'A';
      },
    });
    expectFailure(validFeed(), 'invalid_options', { authors: [authorAccessor] });
    expect(getterCalls).toBe(0);

    const authorProxy = trappedProxy({ name: 'A' }, () => {
      trapCalls += 1;
      throw new Error('author Proxy trap must not run');
    });
    expectFailure(validFeed(), 'invalid_options', { authors: [authorProxy] });
    expect(trapCalls).toBe(0);

    expectFailure(validFeed(), 'invalid_options', { tags: ['tag'], [Symbol('secret')]: true });
    expectFailure(validFeed(), 'invalid_options', {
      authors: [{ name: 'A', [Symbol('secret')]: true }],
    });
    const hidden: Record<string, unknown> = { tags: ['tag'] };
    hiddenProperty(hidden, 'secret', true);
    expectFailure(validFeed(), 'invalid_options', hidden);
  });

  it('detaches and deeply freezes every option-derived output', () => {
    const author = { name: 'Alice', url: 'https://alice.example/' };
    const authors = [author];
    const tags = ['design'];
    const options = { authors, tags, titleOverride: 'Original title' };

    const result = mapFeedToJsonFeed(validFeed(), options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const document = result.document;
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.authors)).toBe(true);
    expect(Object.isFrozen(document.authors?.[0])).toBe(true);
    expect(Object.isFrozen(document.items[0]!.tags)).toBe(true);
    expect(() => { (document.authors?.[0] as { name?: string }).name = 'changed'; }).toThrow(TypeError);
    expect(() => { (document.items[0]!.tags as string[])[0] = 'changed'; }).toThrow(TypeError);

    author.name = 'Mutated';
    authors.push({ name: 'Late', url: 'https://late.example/' });
    tags[0] = 'mutated';
    tags.push('late');
    options.titleOverride = 'Mutated title';
    expect(document.title).toBe('Original title');
    expect(document.authors).toEqual([{ name: 'Alice', url: 'https://alice.example/' }]);
    expect(document.items[0]!.tags).toEqual(['design']);
  });
});
