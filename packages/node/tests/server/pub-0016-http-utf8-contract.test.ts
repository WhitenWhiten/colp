import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MAX_PUBLICATION_MANIFEST_BYTES,
  PUBLICATION_MANIFEST_DISCOVERY_PATH,
  PUBLICATION_MANIFEST_MEDIA_TYPE,
  PUBLICATION_PROBLEM_CONTENT_TYPE,
  createPublicationManifestDiscoveryHandler,
  createPublicationProblemResponse,
  handlePublicationManifestDiscoveryRequest,
  type PublicationManifestDiscoveryRequest,
} from '../../src/server/index.js';
import {
  PUBLICATION_JSON_MEDIA_TYPE,
  createPublicationJsonResponse,
  decodePublicationUtf8Json,
  publicationUtf8JsonBytes,
} from '../../src/server/publication-http-utf8.js';

const evidence = '[evidence:http.utf8]';
const fixturePath = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples', 'public-manifest.json');

function manifest(): Record<string, any> {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, any>;
}

function request(method = 'GET', path = PUBLICATION_MANIFEST_DISCOVERY_PATH): PublicationManifestDiscoveryRequest {
  return { method, path };
}

function response(value = manifest(), input = request()) {
  return handlePublicationManifestDiscoveryRequest(value, input)!;
}

function octets(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe(`PUB-0016 Publication HTTP UTF-8 contract ${evidence}`, () => {
  it.each(['ASCII', 'caf\u00e9', '\u4e2d\u6587', '\ud83d\ude00'])(`preserves %s request/response text as UTF-8 ${evidence}`, (label) => {
    const source = manifest();
    source.title = label === 'ASCII' ? 'plain' : label;
    const result = response(source);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body!)).toMatchObject({ title: source.title });
    expect(new TextDecoder('utf-8', { fatal: true }).decode(octets(result.body!))).toContain(source.title);
  });

  it(`uses UTF-8 octet count, including supplementary-plane characters, for Content-Length ${evidence}`, () => {
    const source = manifest();
    source.title = 'cafe\u00e9 \ud83d\ude00';
    const result = response(source);
    expect(result.headers['content-length']).toBe(String(octets(result.body!).byteLength));
    expect(Number(result.headers['content-length'])).toBeGreaterThan(result.body!.length);
  });

  it(`emits canonical UTF-8 media metadata without a duplicate or malformed charset ${evidence}`, () => {
    const result = response();
    const contentType = result.headers['content-type'];
    expect(contentType).toBe(PUBLICATION_MANIFEST_MEDIA_TYPE);
    expect(contentType).toBe('application/vnd.collection-protocol.manifest+json;version=0.1');
    expect(contentType?.match(/charset=/giu) ?? []).toHaveLength(0);
  });

  it(`decodes the exact response bytes as strict UTF-8 rather than replacement text ${evidence}`, () => {
    const result = response();
    const bytes = octets(result.body!);
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).not.toThrow();
    expect(result.body).not.toContain('\ufffd');
  });

  it.each([
    ['truncated sequence', Uint8Array.from([0xc3])],
    ['invalid continuation', Uint8Array.from([0xe2, 0x28, 0xa1])],
    ['overlong encoding', Uint8Array.from([0xc0, 0xaf])],
    ['surrogate encoding', Uint8Array.from([0xed, 0xa0, 0x80])],
  ])(`does not classify %s as valid UTF-8 input ${evidence}`, (_label, bytes) => {
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toThrow();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT'])(`rejects %s without reading or producing a response ${evidence}`, (method) => {
    expect(handlePublicationManifestDiscoveryRequest(manifest(), request(method))).toBeNull();
  });

  it.each([
    '/.well-known/collection-protocol/',
    '/.WELL-KNOWN/collection-protocol',
    '/.well-known/collection-protocol?x=1',
    '/.well-known/collection-protocol#fragment',
    '/api/.well-known/collection-protocol',
  ])(`rejects non-canonical UTF-8 request target %s ${evidence}`, (path) => {
    expect(handlePublicationManifestDiscoveryRequest(manifest(), request('GET', path))).toBeNull();
  });

  it(`serves HEAD with the same UTF-8 byte length and no body ${evidence}`, () => {
    const get = response();
    const head = response(manifest(), request('HEAD'));
    expect(head.body).toBeNull();
    expect(head.headers).toEqual(get.headers);
    expect(head.headers['content-length']).toBe(String(octets(get.body!).byteLength));
  });

  it(`accepts an empty UTF-8 title and enforces the byte boundary ${evidence}`, () => {
    const source = manifest();
    source.title = '';
    const exact = JSON.stringify(source);
    const room = MAX_PUBLICATION_MANIFEST_BYTES - octets(exact).byteLength;
    source.title = 'x'.repeat(Math.max(0, room));
    expect(Number(response(source).headers['content-length'])).toBe(MAX_PUBLICATION_MANIFEST_BYTES);
    source.title += 'x';
    expect(() => response(source)).toThrow(RangeError);
  });

  it(`returns a UTF-8 RFC 9457 Problem body with byte-accurate length ${evidence}`, async () => {
    const result = createPublicationProblemResponse({ code: 'invalid_document' });
    const bytes = new Uint8Array(await result.arrayBuffer());
    expect(result.headers.get('content-type')).toBe(PUBLICATION_PROBLEM_CONTENT_TYPE);
    expect(result.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).not.toContain('\ufffd');
  });

  it(`uses the Publication JSON transport API for exact UTF-8 Response bytes ${evidence}`, async () => {
    const value = { text: 'caf\u00e9 \u4e2d\u6587 \ud83d\ude00' };
    const bytes = publicationUtf8JsonBytes(value);
    const result = createPublicationJsonResponse(value);
    expect(result.headers.get('content-type')).toBe(PUBLICATION_JSON_MEDIA_TYPE);
    expect(result.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(decodePublicationUtf8Json(await result.arrayBuffer())).toEqual(value);
  });

  it.each([
    ['truncated', Uint8Array.from([0xe2, 0x82])],
    ['non-UTF-8', Uint8Array.from([0xff, 0xfe, 0xfd])],
  ])(`rejects %s bytes at the Publication JSON receive boundary ${evidence}`, (_name, bytes) => {
    expect(() => decodePublicationUtf8Json(bytes)).toThrow();
  });

  it(`preserves non-ASCII recovery data in Problem JSON as UTF-8 ${evidence}`, async () => {
    const result = createPublicationProblemResponse({
      code: 'precondition_failed',
      recovery: { errors: [{ path: 'caf\u00e9', keyword: 'required', message: '\u4e2d\u6587 \ud83d\ude00' }] },
    });
    const body = await result.json() as Record<string, any>;
    expect(body.errors[0].path).toContain('caf\u00e9');
    expect(body.errors[0].message).toContain('\ud83d\ude00');
  });

  it(`captures a detached handler response so later non-UTF-8 mutation cannot alter bytes ${evidence}`, () => {
    const source = manifest();
    const handler = createPublicationManifestDiscoveryHandler(source);
    const first = handler(request());
    source.title = '\ud800';
    expect(handler(request())!.body).toBe(first!.body);
  });
});
