import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MAX_PUBLICATION_MANIFEST_BYTES,
  PUBLICATION_DISCOVERY_LINK_HEADER,
  PUBLICATION_MANIFEST_DISCOVERY_PATH,
  PUBLICATION_MANIFEST_MEDIA_TYPE,
  createPublicationManifestDiscoveryHandler,
  handlePublicationManifestDiscoveryRequest,
  type PublicationManifestDiscoveryResponse,
} from '../../src/server/index.js';

const evidence = '[evidence:http.manifest-response-metadata]';
const fixturePath = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'protocol',
  'examples',
  'public-manifest.json',
);
const expectedCacheControl = 'public, max-age=300';
const expectedMediaType = 'application/vnd.collection-protocol.manifest+json;version=0.1';

function manifest(): Record<string, any> {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, any>;
}

function requireResponse(
  response: PublicationManifestDiscoveryResponse | null,
): PublicationManifestDiscoveryResponse {
  expect(response).not.toBeNull();
  return response!;
}

function header(response: PublicationManifestDiscoveryResponse, name: string): string | undefined {
  const match = Object.entries(response.headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1];
}

function headerNames(response: PublicationManifestDiscoveryResponse, name: string): string[] {
  return Object.keys(response.headers).filter((key) => key.toLowerCase() === name.toLowerCase());
}

function responseFor(
  source: unknown = manifest(),
  method: string = 'GET',
  path: string = PUBLICATION_MANIFEST_DISCOVERY_PATH,
): PublicationManifestDiscoveryResponse | null {
  return handlePublicationManifestDiscoveryRequest(source, { method, path });
}

function expectNoReflection(work: () => unknown, secret: string): Error {
  let rejection: unknown;
  try {
    work();
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(Error);
  expect(String(rejection)).not.toContain(secret);
  return rejection as Error;
}

describe(`PUB-0027 Manifest response metadata ${evidence}`, () => {
  it.each(['GET', 'HEAD'])(
    `emits the exact public cache policy and vendor media type for %s ${evidence}`,
    (method) => {
      const response = requireResponse(responseFor(manifest(), method));

      expect(header(response, 'Cache-Control')).toBe(expectedCacheControl);
      expect(header(response, 'Content-Type')).toBe(expectedMediaType);
      expect(headerNames(response, 'Cache-Control')).toHaveLength(1);
      expect(headerNames(response, 'Content-Type')).toHaveLength(1);
      expect(PUBLICATION_MANIFEST_MEDIA_TYPE).toBe(expectedMediaType);
    },
  );

  it.each(['GET', 'HEAD'])(`emits one valid strong entity-tag for %s ${evidence}`, (method) => {
    const etag = header(requireResponse(responseFor(manifest(), method)), 'ETag');

    expect(etag).toBeDefined();
    expect(etag).not.toMatch(/^W\//u);
    expect(etag).toMatch(/^"[\x21\x23-\x7e]+"$/u);
    expect(headerNames(requireResponse(responseFor(manifest(), method)), 'ETag')).toHaveLength(1);
  });

  it(`keeps every GET and HEAD representation metadata field identical ${evidence}`, () => {
    const handler = createPublicationManifestDiscoveryHandler(manifest());
    const get = requireResponse(handler({ method: 'GET', path: PUBLICATION_MANIFEST_DISCOVERY_PATH }));
    const head = requireResponse(handler({ method: 'HEAD', path: PUBLICATION_MANIFEST_DISCOVERY_PATH }));

    expect(head.status).toBe(get.status);
    expect(head.headers).toEqual(get.headers);
    expect(header(head, 'ETag')).toBe(header(get, 'ETag'));
    expect(get.body).toEqual(expect.any(String));
    expect(head.body).toBeNull();
  });

  it(`preserves the PUB-0011 Link and UTF-8 Content-Length metadata ${evidence}`, () => {
    const get = requireResponse(responseFor());
    const head = requireResponse(responseFor(manifest(), 'HEAD'));

    expect(header(get, 'Link')).toBe(PUBLICATION_DISCOVERY_LINK_HEADER);
    expect(headerNames(get, 'Link')).toHaveLength(1);
    expect(header(get, 'Content-Length')).toBe(String(new TextEncoder().encode(get.body!).byteLength));
    expect(header(head, 'Link')).toBe(PUBLICATION_DISCOVERY_LINK_HEADER);
    expect(header(head, 'Content-Length')).toBe(header(get, 'Content-Length'));
  });

  it(`keeps an ETag stable for repeated publication of the same body ${evidence}`, () => {
    const source = manifest();
    const handler = createPublicationManifestDiscoveryHandler(source);
    const first = requireResponse(handler({ method: 'GET', path: PUBLICATION_MANIFEST_DISCOVERY_PATH }));
    const second = requireResponse(handler({ method: 'GET', path: PUBLICATION_MANIFEST_DISCOVERY_PATH }));

    expect(second.body).toBe(first.body);
    expect(header(second, 'ETag')).toBe(header(first, 'ETag'));
  });

  it(`changes the representation ETag when the canonical Manifest body changes ${evidence}`, () => {
    const firstSource = manifest();
    const secondSource = manifest();
    secondSource.title = `${secondSource.title} revised`;
    const first = requireResponse(responseFor(firstSource));
    const second = requireResponse(responseFor(secondSource));

    expect(second.body).not.toBe(first.body);
    expect(header(second, 'ETag')).not.toBe(header(first, 'ETag'));
  });

  it(`retains PUB-0011 exact-route and method miss behavior ${evidence}`, () => {
    const source = manifest();
    for (const [method, path] of [
      ['POST', PUBLICATION_MANIFEST_DISCOVERY_PATH],
      ['OPTIONS', PUBLICATION_MANIFEST_DISCOVERY_PATH],
      ['get', PUBLICATION_MANIFEST_DISCOVERY_PATH],
      ['GET', `${PUBLICATION_MANIFEST_DISCOVERY_PATH}/`],
      ['HEAD', `${PUBLICATION_MANIFEST_DISCOVERY_PATH}?version=0.1`],
    ] as const) {
      expect(responseFor(source, method, path)).toBeNull();
    }
  });

  it.each([
    ['a malformed document', { cacheControl: 'private, no-store', secret: 'malformed-secret-0027' }],
    ['a credential-shaped value', { ...manifest(), password: 'credential-secret-0027' }],
  ] as const)(`fails closed for %s without reflecting private input ${evidence}`, (_name, source) => {
    const secret = String((source as Record<string, unknown>).secret ?? (source as Record<string, unknown>).password);
    const rejection = expectNoReflection(() => responseFor(source), secret);
    expect(rejection).toBeInstanceOf(TypeError);
  });

  it(`fails closed for an oversized Manifest without reflecting its contents ${evidence}`, () => {
    const source = manifest();
    const secret = 'oversize-private-secret-0027';
    source.title = `${secret}${'x'.repeat(MAX_PUBLICATION_MANIFEST_BYTES)}`;

    const rejection = expectNoReflection(() => responseFor(source), secret);
    expect(rejection).toBeInstanceOf(RangeError);
  });

  it(`retains PUB-0020 and PUB-0021 metadata regressions together ${evidence}`, () => {
    const response = requireResponse(responseFor());
    const etag = header(response, 'ETag')!;

    expect(header(response, 'Content-Type')).toBe(expectedMediaType);
    expect(etag).toMatch(/^"pub\.r1\.[A-Za-z0-9_-]+"$/u);
    expect(etag).not.toContain(response.body!);
    expect(Object.isFrozen(response)).toBe(true);
    expect(Object.isFrozen(response.headers)).toBe(true);
  });
});
