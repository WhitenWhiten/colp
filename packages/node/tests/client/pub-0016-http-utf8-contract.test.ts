import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ColpClient,
  ColpProblemError,
  ColpWireValidationError,
} from '../../src/client/index.js';
import { parseProtocolJsonResponseMediaType } from '../../src/client/protocol-json-media.js';

const evidence = '[evidence:http.utf8]';
const manifestUrl = 'https://manifest.example/.well-known/collection-protocol';
const directoryUrl = 'https://api.example/publication/catalog.json';
const collectionUrl = 'https://api.example/publication/collections/collection-1.json';
const snapshotCollectionId = '019b3ca2-8424-7cc2-9a61-4bf44c23f07a';
const snapshotUrl = `https://api.example/publication/collections/${snapshotCollectionId}/snapshot.json`;
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');

const fixture = (name: string): Promise<string> => readFile(resolve(fixturesRoot, name), 'utf8');
const [manifestJson, directoryJson, collectionJson, snapshotJson] = await Promise.all([
  fixture('public-manifest.json'),
  fixture('collection-directory.json'),
  fixture('collection-metadata.json'),
  fixture('collection-snapshot.json'),
]);

type Resource = 'manifest' | 'directory' | 'collection' | 'snapshot';

interface RunOptions {
  readonly resource?: Resource;
  readonly contentType?: string | null;
  readonly body?: Uint8Array | string;
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

interface RunResult {
  readonly value?: unknown;
  readonly error?: unknown;
  readonly requests: readonly { readonly url: string; readonly init: RequestInit | undefined }[];
}

function publicationManifest(): Record<string, any> {
  const manifest = JSON.parse(manifestJson) as Record<string, any>;
  manifest.mounts[0].endpoints.directory = directoryUrl;
  manifest.mounts[0].endpoints.collection = 'https://api.example/publication/collections/{collectionId}.json';
  manifest.mounts[0].endpoints.snapshot = 'https://api.example/publication/collections/{collectionId}/snapshot.json';
  return manifest;
}

function resourceBody(resource: Resource): string {
  if (resource === 'manifest') return JSON.stringify(publicationManifest());
  if (resource === 'directory') return directoryJson;
  if (resource === 'collection') return collectionJson;
  return snapshotJson;
}

function resourceUrl(resource: Exclude<Resource, 'manifest'>): string {
  if (resource === 'directory') return directoryUrl;
  if (resource === 'collection') return collectionUrl;
  return snapshotUrl;
}

function resourceDefinition(resource: Resource): string {
  if (resource === 'manifest') return 'manifest';
  if (resource === 'directory') return 'collectionDirectory';
  if (resource === 'collection') return 'collectionMetadata';
  return 'snapshot';
}

async function run(options: RunOptions = {}): Promise<RunResult> {
  const resource = options.resource ?? 'directory';
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    requests.push({ url: url.href, init });
    const target = resource === 'manifest' ? manifestUrl : resourceUrl(resource);
    if (url.href === manifestUrl && resource !== 'manifest') {
      return new Response(JSON.stringify(publicationManifest()), {
        headers: { 'Content-Type': 'application/json', ETag: '"manifest"' },
      });
    }
    if (url.href !== target) throw new Error(`Unexpected URL ${url.href}`);
    const headers = new Headers(options.headers);
    if (options.contentType !== null) headers.set('Content-Type', options.contentType ?? 'application/json');
    if (!headers.has('ETag')) headers.set('ETag', `"${resource}"`);
    const responseBody = options.body ?? (options.contentType === null
      ? new TextEncoder().encode(resourceBody(resource))
      : resourceBody(resource));
    return new Response(responseBody, {
      status: options.status ?? 200,
      headers,
    });
  });
  const client = new ColpClient({ manifestUrl, fetch });
  try {
    const value = resource === 'manifest'
      ? await client.discover()
      : resource === 'directory'
        ? await client.getDirectory()
        : resource === 'collection'
          ? await client.getCollection('collection-1')
          : await client.getSnapshot(snapshotCollectionId);
    return { value, requests };
  } catch (error) {
    return { error, requests };
  }
}

/** Corrupts the first character of `text` with an illegal UTF-8 octet while keeping surrounding bytes intact. */
function invalidUtf8Inside(source: string, text: string): Uint8Array {
  const index = source.indexOf(text);
  if (index < 0) throw new Error(`Missing fixture text ${text}`);
  const prefix = new TextEncoder().encode(source.slice(0, index));
  const suffix = new TextEncoder().encode(source.slice(index + 1));
  const result = new Uint8Array(prefix.length + 1 + suffix.length);
  result.set(prefix);
  result[prefix.length] = 0xff;
  result.set(suffix, prefix.length + 1);
  return result;
}

function expectUtf8ParseFailure(result: RunResult, definition: string): ColpWireValidationError {
  expect(result.error).toBeInstanceOf(ColpWireValidationError);
  expect(result.error).toMatchObject({ stage: 'parse', definition });
  const error = result.error as ColpWireValidationError;
  expect(error.message).toMatch(/UTF-8/i);
  expect(error.message).not.toContain('\ufffd');
  expect(error.message).not.toContain('255');
  expect(error.message).not.toContain('0xff');
  return error;
}

describe(`PUB-0016 client HTTP UTF-8 contract ${evidence}`, () => {
  describe(`response charset boundary ${evidence}`, () => {
    it.each([
      ['exact UTF-8 charset', 'application/json; charset=utf-8'],
      ['quoted UTF-8 charset', 'Application/Json ; Charset="UTF-8"'],
      ['HTTP whitespace around charset', ' application/json ; charset = utf-8 '],
    ] as const)(`accepts %s on a real Directory response ${evidence}`, async (_name, contentType) => {
      const result = await run({ contentType });
      expect(result.error).toBeUndefined();
      expect(result.value).toHaveProperty('collections');
    });

    it.each([
      ['non-UTF-8 charset', 'application/json; charset=iso-8859-1'],
      ['windows-1252 charset', 'application/json; charset=windows-1252'],
      ['unregistered UTF-8 alias', 'application/json; charset=utf8'],
      ['duplicate charset', 'application/json; charset=utf-8; CHARSET="UTF-8"'],
      ['empty charset', 'application/json; charset='],
      ['quoted charset whitespace', 'application/json; charset=" UTF-8 "'],
      ['unterminated quoted charset', 'application/json; charset="utf-8'],
    ] as const)(`rejects %s at the media parse boundary ${evidence}`, async (_name, contentType) => {
      const result = await run({ contentType });
      expect(result.error).toBeInstanceOf(ColpWireValidationError);
      expect(result.error).toMatchObject({ stage: 'parse', definition: 'collectionDirectory' });
      expect((result.error as ColpWireValidationError).message).not.toContain(directoryJson.slice(0, 24));
    });

    it.each([
      ['manifest', 'serverId', 'Application/JSON; Charset="utf-8"'],
      ['directory', 'collections', 'application/json;charset=utf-8'],
      ['collection', 'collection', 'application/json; charset=UTF-8'],
      ['snapshot', 'snapshotId', 'application/json; charset="utf-8"'],
    ] as const)(
      `accepts UTF-8 charset metadata on the real %s path ${evidence}`,
      async (resource, property, contentType) => {
        const result = await run({ resource, contentType });
        expect(result.error).toBeUndefined();
        expect(result.value).toHaveProperty(property);
      },
    );

    it.each([
      ['application/json; charset=utf-8', 'json', 'application/json'],
      ['Application/Json; Charset="UTF-8"', 'json', 'application/json'],
      ['application/problem+json; charset=utf-8', 'problem', 'application/problem+json'],
      ['application/vnd.collection-protocol.catalog+json;version=0.1;charset=UTF-8', 'json', 'application/vnd.collection-protocol.catalog+json'],
    ] as const)(
      `normalizes accepted UTF-8 media declaration %s ${evidence}`,
      (value, expected, normalized) => {
        expect(parseProtocolJsonResponseMediaType(value, expected)).toBe(normalized);
      },
    );

    it.each([
      ['iso-8859-1', 'application/json; charset=iso-8859-1'],
      ['utf8 alias', 'application/json; charset=utf8'],
      ['utf-16', 'application/json; charset=utf-16'],
      ['problem iso-8859-1', 'application/problem+json; charset=iso-8859-1'],
      ['vendor windows-1252', 'application/vnd.collection-protocol.catalog+json;version=0.1;charset=windows-1252'],
    ] as const)(`rejects non-UTF-8 charset at the media helper for %s ${evidence}`, (_name, value) => {
      const expected = value.includes('problem+json') ? 'problem' : 'json';
      expect(() => parseProtocolJsonResponseMediaType(value, expected)).toThrow(/UTF-8/i);
    });
  });

  describe(`fatal wire UTF-8 rejection ${evidence}`, () => {
    it.each([
      ['manifest', "Alice's Collections", 'manifest'],
      ['directory', 'Interface Systems', 'collectionDirectory'],
      ['collection', 'Interface Systems', 'collectionMetadata'],
      ['snapshot', 'Interface Systems', 'snapshot'],
    ] as const)(
      `rejects fatal UTF-8 embedded inside otherwise valid %s JSON before schema validation ${evidence}`,
      async (resource, fixtureText, definition) => {
        const source = resourceBody(resource);
        const result = await run({
          resource,
          contentType: 'application/json',
          body: invalidUtf8Inside(source, fixtureText),
        });
        expectUtf8ParseFailure(result, definition);
      },
    );

    it.each([
      ['truncated sequence', Uint8Array.from([0xc3])],
      ['invalid continuation', Uint8Array.from([0xe2, 0x28, 0xa1])],
      ['overlong encoding', Uint8Array.from([0xc0, 0xaf])],
      ['surrogate encoding', Uint8Array.from([0xed, 0xa0, 0x80])],
      ['non-UTF-8 lead bytes', Uint8Array.from([0xff, 0xfe, 0xfd])],
    ] as const)(
      `rejects a pure %s body on the Directory receive path ${evidence}`,
      async (_name, bytes) => {
        const result = await run({
          contentType: 'application/json',
          body: bytes,
        });
        expectUtf8ParseFailure(result, 'collectionDirectory');
      },
    );

    it.each([
      ['truncated', Uint8Array.from([0xe2, 0x82])],
      ['invalid continuation', Uint8Array.from([0xe2, 0x28, 0xa1])],
      ['non-UTF-8', Uint8Array.from([0xff, 0xfe, 0xfd])],
    ] as const)(
      `rejects %s bytes on Manifest, Collection, and Snapshot paths ${evidence}`,
      async (_name, bytes) => {
        for (const resource of ['manifest', 'collection', 'snapshot'] as const) {
          const result = await run({
            resource,
            contentType: 'application/json',
            body: bytes,
          });
          expectUtf8ParseFailure(result, resourceDefinition(resource));
        }
      },
    );

    it(`rejects fatal UTF-8 on a Problem Details error body before semantic recovery ${evidence}`, async () => {
      const problem = JSON.stringify({
        type: 'https://collectionprotocol.org/problems/resource-not-found',
        title: 'Resource not found',
        status: 404,
        code: 'resource_not_found',
      });
      const result = await run({
        status: 404,
        contentType: 'application/problem+json',
        body: invalidUtf8Inside(problem, 'Resource not found'),
      });
      expectUtf8ParseFailure(result, 'problem');
      expect(result.error).not.toBeInstanceOf(ColpProblemError);
    });

    it(`rejects pure invalid UTF-8 Problem bodies without reflecting replacement text ${evidence}`, async () => {
      const result = await run({
        status: 503,
        contentType: 'application/problem+json',
        body: Uint8Array.from([0xc0, 0xaf, 0xed, 0xa0, 0x80]),
      });
      expectUtf8ParseFailure(result, 'problem');
    });
  });

  describe(`UTF-8 text preservation and request metadata ${evidence}`, () => {
    it.each([
      ['Latin-1 supplement', 'caf\u00e9'],
      ['CJK', '\u4e2d\u6587'],
      ['emoji supplementary plane', '\ud83d\ude00'],
      ['mixed planes', 'caf\u00e9 \u4e2d\u6587 \ud83d\ude00'],
    ] as const)(
      `preserves %s characters through a real Directory JSON response ${evidence}`,
      async (_name, title) => {
        const source = JSON.parse(directoryJson) as Record<string, any>;
        source.collections[0].title = title;
        const result = await run({
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify(source),
        });
        expect(result.error).toBeUndefined();
        expect(result.value).toMatchObject({
          collections: [expect.objectContaining({ title })],
        });
      },
    );

    it(`keeps successful JSON and Problem Details media contracts separate under UTF-8 ${evidence}`, async () => {
      const problem = JSON.stringify({
        type: 'https://collectionprotocol.org/problems/resource-not-found',
        title: 'Resource not found',
        status: 404,
        code: 'resource_not_found',
      });
      const accepted = await run({
        status: 404,
        contentType: 'application/problem+json; charset=utf-8',
        body: problem,
      });
      expect(accepted.error).toBeInstanceOf(ColpProblemError);
      expect(accepted.error).toMatchObject({ code: 'resource_not_found', status: 404 });

      const wrongMedia = await run({ status: 404, contentType: 'application/json', body: problem });
      expect(wrongMedia.error).toBeInstanceOf(ColpWireValidationError);
      expect(wrongMedia.error).toMatchObject({ stage: 'parse', definition: 'problem' });
    });

    it(`does not set a non-UTF-8 Accept or protocol header on publication GETs ${evidence}`, async () => {
      const result = await run({ contentType: 'application/json; charset=utf-8' });
      expect(result.error).toBeUndefined();
      const publication = result.requests.find(({ url }) => url === directoryUrl);
      expect(publication).toBeDefined();
      const headers = new Headers(publication?.init?.headers);
      expect(headers.get('Accept')).toBe('application/json');
      expect(headers.get('Collection-Protocol-Version')).toBe('0.1');
      expect(headers.get('Content-Type')).toBeNull();
    });
  });
});
