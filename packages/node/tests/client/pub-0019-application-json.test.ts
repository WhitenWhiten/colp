import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ColpClient,
  ColpProblemError,
  ColpWireValidationError,
} from '../../src/client/index.js';
import { protocolJsonResponse } from '../helpers/http-responses.js';

const evidence = '[evidence:http.application-json]';
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
  readonly body?: ConstructorParameters<typeof Response>[0];
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly staticHeaders?: Readonly<Record<string, string>>;
  readonly credentialProvider?: (url: URL) => Readonly<Record<string, string>> | undefined;
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

async function run(options: RunOptions = {}): Promise<RunResult> {
  const resource = options.resource ?? 'directory';
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    requests.push({ url: url.href, init });
    const target = resource === 'manifest' ? manifestUrl : resourceUrl(resource);
    if (url.href === manifestUrl && resource !== 'manifest') {
      return protocolJsonResponse(publicationManifest(), {
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
  const client = new ColpClient({
    manifestUrl,
    fetch,
    ...(options.staticHeaders === undefined ? {} : { headers: options.staticHeaders }),
    ...(options.credentialProvider === undefined ? {} : { credentialProvider: options.credentialProvider }),
  });
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

function expectWireParseFailure(result: RunResult, definition: string): ColpWireValidationError {
  expect(result.error).toBeInstanceOf(ColpWireValidationError);
  expect(result.error).toMatchObject({ stage: 'parse', definition });
  return result.error as ColpWireValidationError;
}

describe(`PUB-0019 application/json client media contract ${evidence}`, () => {
  it.each([
    ['exact application/json', 'application/json'],
    ['case-insensitive type', 'APPLICATION/JSON'],
    ['UTF-8 charset', 'application/json; charset=utf-8'],
    ['quoted UTF-8 charset', 'Application/Json ; Charset="UTF-8"'],
    ['HTTP whitespace', ' application/json ; charset = utf-8 '],
  ] as const)('accepts %s through a real Directory request', async (_name, contentType) => {
    const result = await run({ contentType });
    expect(result.error).toBeUndefined();
    expect(result.value).toHaveProperty('collections');
  });

  it('rejects a missing Content-Type instead of inferring JSON from the body', async () => {
    const result = await run({ contentType: null });
    expectWireParseFailure(result, 'collectionDirectory');
  });

  it.each([
    ['Manifest discovery', 'manifest', 'manifest'],
    ['Publication Directory read', 'directory', 'collectionDirectory'],
  ] as const)('cancels the unread body when %s rejects its media type', async (_name, resource, definition) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(resourceBody(resource)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await run({ resource, contentType: 'text/plain', body });

    expectWireParseFailure(result, definition);
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it.each([
    ['wrong', 'application/json'],
    ['missing', null],
  ] as const)('cancels an unread Problem body with %s media metadata', async (_name, contentType) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"status":404}'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await run({ status: 404, contentType, body });

    expectWireParseFailure(result, 'problem');
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it.each([
    ['wrong type', 'text/plain'],
    ['problem type on success', 'application/problem+json'],
    ['suffix disguise', 'application/json.evil'],
    ['ambiguous field value', 'application/json, application/json'],
    ['non-UTF-8 charset', 'application/json; charset=iso-8859-1'],
    ['unregistered UTF-8 alias', 'application/json; charset=utf8'],
    ['duplicate charset', 'application/json; charset=utf-8; CHARSET="UTF-8"'],
    ['unknown parameter', 'application/json; boundary=secret-media-token'],
    ['empty parameter', 'application/json;'],
    ['empty parameter between separators', 'application/json;;charset=utf-8'],
    ['valueless parameter', 'application/json; charset'],
    ['empty parameter name', 'application/json; =utf-8'],
    ['empty charset', 'application/json; charset='],
    ['unterminated quoted charset', 'application/json; charset="utf-8'],
    ['trailing quote', 'application/json; charset=utf-8"'],
    ['quoted charset whitespace', 'application/json; charset=" UTF-8 "'],
  ] as const)('rejects %s at the stable media parse boundary', async (_name, contentType) => {
    const result = await run({ contentType });
    const error = expectWireParseFailure(result, 'collectionDirectory');
    expect(error.message).not.toContain('secret-media-token');
    expect(error.message).not.toContain(directoryJson.slice(0, 24));
  });

  it.each([
    ['manifest', 'serverId'],
    ['directory', 'collections'],
    ['collection', 'collection'],
    ['snapshot', 'snapshotId'],
  ] as const)('accepts application/json for the real %s client path', async (resource, property) => {
    const result = await run({ resource, contentType: 'Application/JSON; Charset="utf-8"' });
    expect(result.error).toBeUndefined();
    expect(result.value).toHaveProperty(property);
  });

  it.each([
    ['manifest', "Alice's Collections", 'manifest'],
    ['directory', 'Interface Systems', 'collectionDirectory'],
    ['collection', 'Interface Systems', 'collectionMetadata'],
    ['snapshot', 'Interface Systems', 'snapshot'],
  ] as const)(
    'rejects fatal UTF-8 embedded inside otherwise valid %s JSON before schema validation',
    async (resource, fixtureText, definition) => {
      const source = resourceBody(resource);
      const result = await run({
        resource,
        contentType: 'application/json',
        body: invalidUtf8Inside(source, fixtureText),
      });
      const error = expectWireParseFailure(result, definition);
      expect(error.message).not.toContain('\ufffd');
      expect(error.message).not.toContain('255');
    },
  );

  it.each([
    ['duplicate member', directoryJson.replace('"protocolVersion": "0.1"', '"protocolVersion":"0.1","protocolVersion":"0.1"')],
    ['unsafe integer', directoryJson.replace('"nodeCount": 48', '"nodeCount": 9007199254740992')],
    ['prohibited member', directoryJson.replace('"collections": [', '"__proto__":{},"collections": [')],
  ])('preserves the production I-JSON parse stage for %s', async (_name, body) => {
    expectWireParseFailure(await run({ body }), 'collectionDirectory');
  });

  it('keeps successful JSON and Problem Details media contracts separate', async () => {
    const problem = JSON.stringify({
      type: 'https://know-n.com/colp/problems/resource-not-found',
      title: 'Resource not found',
      status: 404,
      code: 'resource_not_found',
    });
    const accepted = await run({ status: 404, contentType: 'application/problem+json', body: problem });
    expect(accepted.error).toBeInstanceOf(ColpProblemError);
    expect(accepted.error).toMatchObject({ code: 'resource_not_found', status: 404 });

    const wrongMedia = await run({ status: 404, contentType: 'application/json', body: problem });
    expect(wrongMedia.error).toBeInstanceOf(ColpWireValidationError);
    expect(wrongMedia.error).toMatchObject({ stage: 'parse', definition: 'problem' });

    const missingMedia = await run({ status: 404, contentType: null, body: problem });
    expect(missingMedia.error).toBeInstanceOf(ColpWireValidationError);
    expect(missingMedia.error).toMatchObject({ stage: 'parse', definition: 'problem' });

    const badBytes = await run({
      status: 404,
      contentType: 'application/problem+json',
      body: invalidUtf8Inside(problem, 'Resource not found'),
    });
    const error = expectWireParseFailure(badBytes, 'problem');
    expect(error.message).not.toContain('\ufffd');
  });

  it('preserves the current PUB-0020 vendor catalog response contract', async () => {
    const result = await run({
      contentType: 'application/vnd.collection-protocol.catalog+json;version=0.1;charset=UTF-8',
    });
    expect(result.error).toBeUndefined();
    expect(result.value).toHaveProperty('collections');
  });

  it.each([
    ['Manifest', 'manifest', 'application/vnd.collection-protocol.catalog+json;version=0.1', 'manifest'],
    ['Directory', 'directory', 'application/vnd.collection-protocol.snapshot+json;version=0.1', 'collectionDirectory'],
    ['Snapshot', 'snapshot', 'application/vnd.collection-protocol.node+json;version=0.1', 'snapshot'],
  ] as const)('rejects a vendor representation registered for a different %s definition', async (
    _name,
    resource,
    contentType,
    definition,
  ) => {
    expectWireParseFailure(await run({ resource, contentType }), definition);
  });

  it('keeps cross-Origin credentials, static headers, and JSON request headers scoped correctly', async () => {
    const result = await run({
      staticHeaders: { Authorization: 'Bearer static-secret', 'X-Static-Secret': 'static-secret' },
      credentialProvider: (url) => url.origin === 'https://api.example'
        ? { Authorization: 'Bearer explicitly-delegated' }
        : undefined,
    });
    expect(result.error).toBeUndefined();
    const publication = result.requests.find(({ url }) => url === directoryUrl);
    expect(publication).toBeDefined();
    const headers = new Headers(publication?.init?.headers);
    expect(headers.get('Accept')).toBe('application/json');
    expect(headers.get('Collection-Protocol-Version')).toBe('0.1');
    expect(headers.get('Authorization')).toBe('Bearer explicitly-delegated');
    expect(headers.get('X-Static-Secret')).toBeNull();
    expect(publication?.init?.credentials).toBe('omit');
  });
});
