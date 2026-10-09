import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ColpClient,
  preparePublicationQuery,
  PublicationQueryError,
} from '../../src/client/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';
import {
  decodePublicationQuery,
  publicationQueryLimits,
  type PublicationQueryEndpoint,
} from '../../src/server/index.js';

const evidence = 'http.query-codec';
const STABLE_INVALID_QUERY = 'invalid_query: Publication query is invalid.';
const manifestUrl = 'https://manifest.example/.well-known/collection-protocol';
const collectionId = '019b3ca2-8424-7cc2-9a61-4bf44c23f07a';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');

async function fixture(name: string): Promise<string> {
  return readFile(resolve(fixturesRoot, name), 'utf8');
}

async function manifest(): Promise<Record<string, any>> {
  return JSON.parse(await fixture('public-manifest.json')) as Record<string, any>;
}

function href(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString();
}

function prepare(endpoint: PublicationQueryEndpoint, endpointUrl: string | URL, query: unknown): URL {
  return preparePublicationQuery(endpoint, endpointUrl, query, createValidatorRegistry());
}

/** Assert preparePublicationQuery failures use the stable PublicationQueryError contract. */
function expectInvalidQuery(
  run: () => unknown,
  options?: { readonly secret?: string; readonly issues?: readonly string[] },
): PublicationQueryError {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(PublicationQueryError);
  expect(thrown).toBeInstanceOf(TypeError);
  expect(thrown).toMatchObject({
    name: 'PublicationQueryError',
    message: STABLE_INVALID_QUERY,
    code: 'invalid_query',
  });
  const error = thrown as PublicationQueryError;
  expect(Object.isFrozen(error.issues)).toBe(true);
  expect(Array.isArray(error.issues)).toBe(true);
  for (const issue of error.issues) {
    expect(typeof issue).toBe('string');
    expect(issue).not.toMatch(/\bmust (?:be|match|have)\b/iu);
  }
  if (options?.issues !== undefined) {
    expect([...error.issues]).toEqual([...options.issues]);
  }
  if (options?.secret !== undefined) {
    const surface = JSON.stringify({
      message: error.message,
      code: error.code,
      issues: error.issues,
    });
    expect(surface).not.toContain(options.secret);
    expect(String(error)).not.toContain(options.secret);
  }
  return error;
}

describe(`PUB-0010 client Publication query codec [evidence:${evidence}]`, () => {
  it.each([
    ['directory', 'https://api.example/directory', { limit: undefined, q: 'term' }, 'https://api.example/directory?q=term'],
    ['directory', 'https://api.example/directory', { q: 'last', creator: 'first', limit: 7 }, 'https://api.example/directory?limit=7&creator=first&q=last'],
    ['directory', 'https://api.example/directory', { q: 'caf\u00e9 space+plus%percent' }, 'https://api.example/directory?q=caf%C3%A9+space%2Bplus%25percent'],
    ['directory', 'https://api.example/directory', { updatedSince: '2026-07-18T01:02:03Z' }, 'https://api.example/directory?updatedSince=2026-07-18T01%3A02%3A03Z'],
    ['snapshot', 'https://api.example/snapshot', { depth: 2, include: ['relations', 'annotations'], limit: 25 }, 'https://api.example/snapshot?limit=25&include=relations&include=annotations&depth=2'],
    ['snapshot', 'https://api.example/snapshot', { root: 'root_1', pageCursor: 'page_2' }, 'https://api.example/snapshot?pageCursor=page_2&root=root_1'],
    ['node', new URL('https://api.example/node'), { include: ['attachments', 'relations'] }, 'https://api.example/node?include=attachments&include=relations'],
    ['collection', 'https://api.example/collection', { ignored: undefined }, 'https://api.example/collection'],
  ] as const)(
    'encodes a validated %s DTO deterministically as repeated parameters [evidence:http.query-codec]',
    (endpoint, endpointUrl, query, expected) => {
      expect(prepare(endpoint, endpointUrl, query).href).toBe(expected);
    },
  );

  it.each([
    ['high surrogate at start', 'directory', 'https://api.example/directory', { q: '\ud800value' }],
    ['high surrogate in middle', 'directory', 'https://api.example/directory', { q: 'va\ud800lue' }],
    ['high surrogate at end', 'directory', 'https://api.example/directory', { q: 'value\ud800' }],
    ['low surrogate at start', 'directory', 'https://api.example/directory', { q: '\udc00value' }],
    ['low surrogate in middle', 'directory', 'https://api.example/directory', { q: 'va\udc00lue' }],
    ['low surrogate at end', 'directory', 'https://api.example/directory', { q: 'value\udc00' }],
    ['malformed array item', 'snapshot', 'https://api.example/snapshot', { include: ['annotations', '\ud800'] }],
    ['malformed fixed raw query', 'directory', 'https://api.example/directory?q=secret\udc00', {}],
  ] as const)(
    'rejects malformed UTF-16 %s as a non-reflecting invalid_query PublicationQueryError [evidence:http.query-codec]',
    (_name, endpoint, endpointUrl, query) => {
      const error = expectInvalidQuery(
        () => prepare(endpoint, endpointUrl, query),
        { secret: 'secret' },
      );
      expect(error).not.toBeInstanceOf(URIError);
      expect(error).not.toBeInstanceOf(RangeError);
    },
  );

  it('rejects a malformed UTF-16 DTO property name before URL production [evidence:http.query-codec]', () => {
    const query = Object.defineProperty({}, `na${'\ud800'}me`, {
      enumerable: true,
      value: 'secret-name-value',
    });
    expectInvalidQuery(
      () => prepare('directory', 'https://api.example/directory', query),
      { secret: 'secret-name-value' },
    );
  });

  it('percent-encodes and roundtrips legal supplementary characters exactly [evidence:http.query-codec]', () => {
    const query = { q: 'A\ud83d\ude00\ud801\udc37Z' };
    const encoded = prepare('directory', 'https://api.example/directory', query);
    expect(encoded.href).toBe('https://api.example/directory?q=A%F0%9F%98%80%F0%90%90%B7Z');
    expect(decodePublicationQuery('directory', encoded.search, createValidatorRegistry())).toMatchObject({
      valid: true,
      value: query,
    });
  });

  it.each([
    ['null', 'directory', null],
    ['array root', 'directory', []],
    ['date object', 'directory', new Date('2026-07-18T00:00:00Z')],
    ['string root', 'directory', 'limit=1'],
    ['unknown property', 'directory', { unknown: 'value' }],
    ['prototype property', 'directory', JSON.parse('{"__proto__":"value","limit":1}')],
    ['empty q', 'directory', { q: '' }],
    ['empty cursor', 'directory', { cursor: '' }],
    ['empty include item', 'snapshot', { include: [''] }],
    ['comma array string', 'snapshot', { include: 'annotations,attachments' }],
    ['set array', 'snapshot', { include: new Set(['annotations']) }],
    ['invalid array member', 'snapshot', { include: ['nodes'] }],
    ['duplicate array member', 'snapshot', { include: ['annotations', 'annotations'] }],
    ['string integer', 'directory', { limit: '2' }],
    ['zero limit', 'directory', { limit: 0 }],
    ['fractional limit', 'directory', { limit: 1.5 }],
    ['unsafe limit', 'directory', { limit: Number.MAX_SAFE_INTEGER + 1 }],
    ['negative depth', 'snapshot', { depth: -1 }],
    ['invalid date', 'directory', { updatedSince: '2026-07-18' }],
    ['invalid kind', 'directory', { kind: 'folder' }],
    ['symbol value', 'directory', { q: Symbol('secret') }],
  ] as const)(
    'rejects invalid plain-data case %s before URL production [evidence:http.query-codec]',
    (_name, endpoint, query) => {
      expectInvalidQuery(() => prepare(endpoint, `https://api.example/${endpoint}`, query));
    },
  );

  it('rejects accessors without evaluating them [evidence:http.query-codec]', () => {
    const getter = vi.fn(() => 'do-not-read');
    const query = Object.defineProperty({}, 'q', { enumerable: true, get: getter });
    expectInvalidQuery(() => prepare('directory', 'https://api.example/directory', query));
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects symbol keys even when string fields are otherwise valid [evidence:http.query-codec]', () => {
    const query = { q: 'valid', [Symbol('hidden')]: 'secret' };
    expectInvalidQuery(
      () => prepare('directory', 'https://api.example/directory', query),
      { secret: 'secret' },
    );
  });

  it('bounds DTO properties, array items, and encoded bytes [evidence:http.query-codec]', () => {
    const tooManyProperties = Object.fromEntries(Array.from(
      { length: publicationQueryLimits.maxDtoProperties + 1 },
      (_, index) => [`unknown${index}`, 'value'],
    ));
    const tooManyItems = Array.from(
      { length: publicationQueryLimits.maxArrayItems + 1 },
      () => 'annotations',
    );
    const tooManyBytes = 'a'.repeat(publicationQueryLimits.maxRawBytes);

    expectInvalidQuery(() => prepare('directory', 'https://api.example/directory', tooManyProperties));
    expectInvalidQuery(() => prepare('snapshot', 'https://api.example/snapshot', { include: tooManyItems }));
    expectInvalidQuery(() => prepare('directory', 'https://api.example/directory', { q: tooManyBytes }));
  });

  it('applies the encoded UTF-8 byte budget to supplementary DTO strings [evidence:http.query-codec]', () => {
    const exact = `aa${'\ud83d\ude00'.repeat(1_365)}`;
    expect(prepare('directory', 'https://api.example/directory', { q: exact }).search).toBe(
      `?q=aa${'%F0%9F%98%80'.repeat(1_365)}`,
    );
    expectInvalidQuery(() => prepare('directory', 'https://api.example/directory', { q: `${exact}a` }));
  });

  it.each([
    ['NUL DTO value', 'https://api.example/directory', { q: 'before\u0000after' }],
    ['LF DTO value', 'https://api.example/directory', { q: 'before\nafter' }],
    ['DEL DTO value', 'https://api.example/directory', { q: 'before\u007fafter' }],
    ['C1 DTO value', 'https://api.example/directory', { q: 'before\u0085after' }],
    ['literal TAB in fixed query', 'https://api.example/directory?q=before\tafter', {}],
    ['literal LF in fixed query', 'https://api.example/directory?q=before\nafter', {}],
    ['literal NUL in fixed query', 'https://api.example/directory?q=before\u0000after', {}],
    ['literal C1 in fixed query', 'https://api.example/directory?q=before\u0085after', {}],
  ] as const)(
    'rejects control case %s before URL normalization [evidence:http.query-codec]',
    (_name, endpointUrl, query) => {
      expectInvalidQuery(() => prepare('directory', endpointUrl, query));
    },
  );

  it.each([
    {
      name: 'unknown fixed key',
      endpoint: 'directory' as const,
      endpointUrl: 'https://api.example/directory?secret=fixed-secret',
      query: { q: 'ok' },
      secret: 'fixed-secret',
      issues: ['Unknown query parameter.'] as const,
    },
    {
      name: 'encoded duplicate fixed scalar',
      endpoint: 'directory' as const,
      endpointUrl: 'https://api.example/directory?limit=1&%6cimit=2',
      query: {},
      issues: ['Query parameter must appear once.'] as const,
    },
    {
      name: 'caller duplicates fixed scalar',
      endpoint: 'directory' as const,
      endpointUrl: 'https://api.example/directory?limit=1',
      query: { limit: 2 },
      issues: ['Query parameter must appear once.'] as const,
    },
    {
      name: 'caller duplicates encoded fixed scalar',
      endpoint: 'directory' as const,
      endpointUrl: 'https://api.example/directory?%6cimit=1',
      query: { limit: 2 },
      issues: ['Query parameter must appear once.'] as const,
    },
    {
      name: 'caller duplicates fixed array value',
      endpoint: 'snapshot' as const,
      endpointUrl: 'https://api.example/snapshot?include=annotations',
      query: { include: ['annotations'] },
      issues: undefined,
    },
    {
      name: 'no-query fixed query',
      endpoint: 'collection' as const,
      endpointUrl: 'https://api.example/collection?q=secret',
      query: {},
      secret: 'secret',
      issues: ['This Publication endpoint does not accept a query.'] as const,
    },
    {
      name: 'no-query caller property',
      endpoint: 'collection' as const,
      endpointUrl: 'https://api.example/collection',
      query: { q: 'secret' },
      secret: 'secret',
      issues: undefined,
    },
    {
      name: 'malformed fixed percent',
      endpoint: 'directory' as const,
      endpointUrl: 'https://api.example/directory?q=%',
      query: {},
      issues: ['Publication query encoding is invalid.'] as const,
    },
  ] as const)(
    'rejects fixed-query hazard $name with stable message (no detail suffix) [evidence:http.query-codec]',
    (testCase) => {
      const error = expectInvalidQuery(
        () => prepare(testCase.endpoint, testCase.endpointUrl, testCase.query),
        {
          ...(testCase.secret === undefined ? {} : { secret: testCase.secret }),
          ...(testCase.issues === undefined ? {} : { issues: testCase.issues }),
        },
      );
      // Previously throwInvalidQuery(decoded.errors[0]) could append detail onto message.
      expect(error.message).toBe(STABLE_INVALID_QUERY);
      if (error.issues.length > 0) {
        for (const issue of error.issues) {
          expect(error.message).not.toContain(issue);
          expect(issue).not.toMatch(/\bmust (?:be|match|have)\b/iu);
        }
      }
    },
  );

  it('preserves existing fixed query raw percent bytes and order while appending [evidence:http.query-codec]', () => {
    const source = 'https://api.example/directory?q=a%2fb+%25&tag=first&creator=fixed';
    const result = prepare('directory', source, { limit: 7 });
    expect(result.href).toBe(`${source}&limit=7`);
    expect(result.href).toContain('q=a%2fb+%25');
    expect(result.href).not.toContain('%2F');
  });

  it.each([
    ['directory', { limit: 8, q: 'caf\u00e9 + %', kind: 'mixed' }],
    ['snapshot', { include: ['relations', 'annotations'], limit: 3, depth: 0, root: 'root_7' }],
    ['node', { include: ['attachments', 'relations'] }],
  ] as const)(
    'roundtrips %s encoding through the production server decoder [evidence:http.query-codec]',
    (endpoint, query) => {
      const encoded = prepare(endpoint, `https://roundtrip.example/${endpoint}`, query);
      const decoded = decodePublicationQuery(endpoint, encoded.search, createValidatorRegistry());
      expect(decoded).toMatchObject({ valid: true, value: query });
    },
  );

  it.each([
    {
      name: 'directory',
      endpoint: 'https://directory-cdn.example/static/catalog.json?tag=fixed',
      expected: 'https://directory-cdn.example/static/catalog.json?tag=fixed&limit=7&q=caf%C3%A9+%2B%25',
      response: 'collection-directory.json',
      invoke: (client: ColpClient) => client.getDirectory({ q: 'caf\u00e9 +%', limit: 7 }),
    },
    {
      name: 'snapshot',
      endpoint: 'https://snapshot-cdn.example/export/{collectionId}.json?limit=7',
      expected: `https://snapshot-cdn.example/export/${collectionId}.json?limit=7&include=relations&include=annotations&include=attachments`,
      response: 'collection-snapshot.json',
      invoke: (client: ColpClient) => client.getSnapshot(collectionId, {
        include: ['relations', 'annotations', 'attachments'],
      }),
    },
  ])(
    'uses the declared cross-Origin $name endpoint with the exact encoded URL [evidence:http.query-codec]',
    async (testCase) => {
      const document = await manifest();
      document.mounts[0].endpoints[testCase.name] = testCase.endpoint;
      const representation = await fixture(testCase.response);
      const requested: string[] = [];
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = href(input);
        requested.push(url);
        if (url === manifestUrl) return Response.json(document);
        if (url === testCase.expected) return new Response(representation, { headers: { ETag: '"pub-0010"', 'Content-Type': 'application/json' } });
        throw new Error(`Unexpected request URL: ${url}`);
      });

      await testCase.invoke(new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch }));
      expect(requested).toEqual([manifestUrl, testCase.expected]);
    },
  );

  it.each([
    ['directory invalid DTO', 'directory', 'https://cdn.example/catalog.json', (client: ColpClient) => client.getDirectory({ limit: 0 })],
    ['directory unknown fixed query', 'directory', 'https://cdn.example/catalog.json?secret=private', (client: ColpClient) => client.getDirectory()],
    ['directory caller duplicate', 'directory', 'https://cdn.example/catalog.json?limit=1', (client: ColpClient) => client.getDirectory({ limit: 2 })],
    ['snapshot encoded duplicate', 'snapshot', 'https://cdn.example/{collectionId}.json?depth=1&%64epth=2', (client: ColpClient) => client.getSnapshot(collectionId)],
    ['collection no-query endpoint', 'collection', 'https://cdn.example/{collectionId}.json?token=private', (client: ColpClient) => client.getCollection(collectionId)],
    ['directory fixed literal TAB', 'directory', 'https://cdn.example/catalog.json?q=before\tafter', (client: ColpClient) => client.getDirectory()],
    ['directory fixed literal LF', 'directory', 'https://cdn.example/catalog.json?q=before\nafter', (client: ColpClient) => client.getDirectory()],
    ['directory fixed literal CR', 'directory', 'https://cdn.example/catalog.json?q=before\rafter', (client: ColpClient) => client.getDirectory()],
    ['directory fixed literal C0', 'directory', 'https://cdn.example/catalog.json?q=before\u0000after', (client: ColpClient) => client.getDirectory()],
    ['directory fixed literal C1', 'directory', 'https://cdn.example/catalog.json?q=before\u0085after', (client: ColpClient) => client.getDirectory()],
  ])(
    'performs only Manifest I/O for %s [evidence:http.query-codec]',
    async (_name, endpoint, endpointUrl, invoke) => {
      const document = await manifest();
      document.mounts[0].endpoints[endpoint] = endpointUrl;
      const requested: string[] = [];
      const fetch = vi.fn(async (input: string | URL | Request) => {
        requested.push(href(input));
        return Response.json(document);
      });
      const client = new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch });

      let thrown: unknown;
      try {
        await invoke(client);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TypeError);
      expect((thrown as Error).message).toContain(STABLE_INVALID_QUERY);
      // Client surface must not expose AJV-style schema dumps or reflected fixed secrets.
      expect((thrown as Error).message).not.toMatch(/\bmust (?:be|match|have)\b/iu);
      expect(JSON.stringify({ message: (thrown as Error).message })).not.toContain('private');
      expect(requested).toEqual([manifestUrl]);
      expect(JSON.stringify(requested)).not.toContain('fixed-secret');
    },
  );

  it.each([
    ['high surrogate', 'https://cdn.example/catalog.json?q=before\ud800after&token=fixed-secret'],
    ['low surrogate', 'https://cdn.example/catalog.json?q=before\udc00after&token=fixed-secret'],
  ])(
    'rejects a Manifest carrying an unpaired UTF-16 %s at the I-JSON parse boundary with only Manifest I/O [evidence:http.query-codec]',
    async (_name, endpointUrl) => {
      // RFC 7493 I-JSON strings are Unicode scalar sequences. A Manifest whose
      // fixed endpoint query escapes a lone surrogate is rejected by the wire
      // parser before any query codec or endpoint I/O runs, so the codec-level
      // invalid_query contract above remains the only reflecting-safe path.
      const document = await manifest();
      document.mounts[0].endpoints.directory = endpointUrl;
      const requested: string[] = [];
      const fetch = vi.fn(async (input: string | URL | Request) => {
        requested.push(href(input));
        return Response.json(document);
      });
      const client = new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch });

      let thrown: unknown;
      try {
        await client.getDirectory();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TypeError);
      expect((thrown as Error).message).toMatch(/could not be parsed as I-JSON/u);
      expect((thrown as Error).message).toMatch(/unpaired UTF-16 surrogate/u);
      expect((thrown as Error).message).not.toMatch(/\bmust (?:be|match|have)\b/iu);
      expect(JSON.stringify({ message: (thrown as Error).message })).not.toContain('fixed-secret');
      expect(requested).toEqual([manifestUrl]);
    },
  );

  it('rejects Manifest endpoint URL text with illegal control characters as stable invalid_query [evidence:http.query-codec]', async () => {
    const document = await manifest();
    document.mounts[0].endpoints.directory = 'https://cdn.example/catalog.json?q=before\nafter&token=manifest-control-secret';
    const requested: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      requested.push(href(input));
      return Response.json(document);
    });
    const client = new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch });

    let thrown: unknown;
    try {
      await client.getDirectory();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toContain(STABLE_INVALID_QUERY);
    expect(String(thrown)).not.toContain('manifest-control-secret');
    expect(requested).toEqual([manifestUrl]);
  });
});
