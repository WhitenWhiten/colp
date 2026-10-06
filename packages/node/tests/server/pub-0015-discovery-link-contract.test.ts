import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PUBLICATION_DISCOVERY_HTML_LINK,
  PUBLICATION_DISCOVERY_LINK_HEADER,
  createPublicationDiscoveryLinks,
  createPublicationManifestDiscoveryHandler,
  mergePublicationDiscoveryHeaders,
  PUBLICATION_MANIFEST_DISCOVERY_PATH,
  handlePublicationManifestDiscoveryRequest,
  type PublicationManifestDiscoveryRequest,
} from '../../src/server/index.js';

const evidence = '[evidence:http.discovery-link]';
const expectedHtml = '<link rel="collection-protocol" href="/.well-known/collection-protocol">';
const expectedLink = '</.well-known/collection-protocol>; rel="collection-protocol"';
const fixturePath = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'protocol',
  'examples',
  'public-manifest.json',
);

function request(method: string = 'GET', path: string = PUBLICATION_MANIFEST_DISCOVERY_PATH):
  PublicationManifestDiscoveryRequest {
  return { method, path };
}

function minimalManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
}

describe(`PUB-0015 publication discovery Link contract ${evidence}`, () => {
  it(`publishes the exact HTML discovery fragment as UTF-8 text ${evidence}`, () => {
    expect(PUBLICATION_DISCOVERY_HTML_LINK).toBe(expectedHtml);
    expect(new TextEncoder().encode(PUBLICATION_DISCOVERY_HTML_LINK).byteLength)
      .toBe(expectedHtml.length);
    expect(PUBLICATION_DISCOVERY_HTML_LINK).not.toMatch(/[\u0000-\u001f\u007f]/u);
    expect(PUBLICATION_DISCOVERY_HTML_LINK).not.toContain('<script');
    expect(PUBLICATION_DISCOVERY_HTML_LINK).not.toContain('&quot;');
  });

  it(`publishes the exact HTTP Link value without an injected suffix ${evidence}`, () => {
    expect(PUBLICATION_DISCOVERY_LINK_HEADER).toBe(expectedLink);
    expect(PUBLICATION_DISCOVERY_LINK_HEADER).not.toMatch(/[\u0000-\u001f\u007f]/u);
    expect(PUBLICATION_DISCOVERY_LINK_HEADER).not.toContain('\r');
    expect(PUBLICATION_DISCOVERY_LINK_HEADER).not.toContain('\n');
  });

  it.each(['GET', 'HEAD'])(`adds one exact Link header to %s discovery responses ${evidence}`, (method) => {
    const response = handlePublicationManifestDiscoveryRequest(minimalManifest(), request(method));
    expect(response).not.toBeNull();
    expect(response!.headers.Link).toBe(expectedLink);
    expect(Object.keys(response!.headers).filter((key) => key.toLowerCase() === 'link')).toEqual(['Link']);
    if (method === 'HEAD') expect(response!.body).toBeNull();
    else expect(response!.body).toEqual(expect.any(String));
  });

  it(`adds the same Link metadata through the prevalidated handler ${evidence}`, () => {
    const handler = createPublicationManifestDiscoveryHandler(minimalManifest());
    const get = handler(request('GET'));
    const head = handler(request('HEAD'));
    expect(get?.headers).toEqual({
      'cache-control': 'public, max-age=300',
      'content-length': expect.any(String),
      'content-type': 'application/vnd.collection-protocol.manifest+json;version=0.1',
      etag: expect.stringMatching(/^"pub\.r1\.[A-Za-z0-9_-]+"$/u),
      Link: expectedLink,
    });
    expect(head?.headers).toEqual(get?.headers);
    expect(get?.body).toEqual(expect.any(String));
    expect(head?.body).toBeNull();
  });

  it(`preserves HTTP header casing while freezing response metadata ${evidence}`, () => {
    const response = handlePublicationManifestDiscoveryRequest(minimalManifest(), request());
    expect(response).not.toBeNull();
    expect(response!.headers).toHaveProperty('Link', expectedLink);
    expect(response!.headers).not.toHaveProperty('link');
    expect(Object.isFrozen(response)).toBe(true);
    expect(Object.isFrozen(response!.headers)).toBe(true);
    expect(Reflect.set(response!, 'status', 500)).toBe(false);
    expect(Reflect.set(response!.headers, 'Link', 'attacker')).toBe(false);
    expect(response!.headers.Link).toBe(expectedLink);
  });

  it(`returns an isolated frozen hint factory result on every call ${evidence}`, () => {
    const first = createPublicationDiscoveryLinks();
    const second = createPublicationDiscoveryLinks();
    expect(first).not.toBe(second);
    expect(first.headers).not.toBe(second.headers);
    expect(first).toEqual({ html: expectedHtml, headers: { Link: expectedLink } });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.headers)).toBe(true);
    expect(Reflect.set(first, 'html', 'tampered')).toBe(false);
    expect(Reflect.set(first.headers, 'Link', 'tampered')).toBe(false);
    expect(second.html).toBe(expectedHtml);
    expect(second.headers.Link).toBe(expectedLink);
  });

  it.each([
    { Link: 'caller supplied' },
    { link: 'caller supplied' },
    { LINK: 'caller supplied' },
  ])(`rejects duplicate or overridden Link header keys without reflection ${evidence}`, (source) => {
    expect(() => mergePublicationDiscoveryHeaders(source)).toThrow(TypeError);
    expect(() => mergePublicationDiscoveryHeaders(source)).toThrow(/already exists/u);
  });

  it.each([
    ['a control-character key', { ['x\u0000name']: 'value' }],
    ['a control-character value', { 'x-test': 'value\r\nX-Leak: yes' }],
    ['a symbol key', { [Symbol('secret')]: 'value' }],
    ['a non-string value', { 'x-test': 42 }],
    ['a non-enumerable value', Object.defineProperty({ 'x-test': 'ok' }, 'secret', { value: 'leak' })],
    ['a getter value', Object.defineProperty({}, 'x-test', { enumerable: true, get: () => { throw new Error('header-secret'); } })],
  ] as const)(`fails closed for unsafe header input: %s ${evidence}`, (_name, source) => {
    let error: unknown;
    try {
      mergePublicationDiscoveryHeaders(source);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).not.toContain('header-secret');
  });

  it(`rejects inherited, proxied, array, null, and primitive header sources ${evidence}`, () => {
    const inherited = Object.assign(Object.create({ secret: 'leak' }), { accept: 'text/html' });
    const proxied = new Proxy({ accept: 'text/html' }, { get() { throw new Error('proxy-secret'); } });
    for (const source of [inherited, proxied, [], null, 'headers', 42, true]) {
      expect(() => mergePublicationDiscoveryHeaders(source)).toThrow(TypeError);
    }
  });

  it(`merges ordinary headers without mutating or exposing caller state ${evidence}`, () => {
    const source = { Accept: 'text/html', 'cache-control': 'no-store' };
    const merged = mergePublicationDiscoveryHeaders(source);
    expect(merged).toEqual({ Accept: 'text/html', 'cache-control': 'no-store', Link: expectedLink });
    expect(source).toEqual({ Accept: 'text/html', 'cache-control': 'no-store' });
    expect(Object.getPrototypeOf(merged)).toBeNull();
    expect(Object.isFrozen(merged)).toBe(true);
  });

  it.each([
    ['a wrong method', request('POST')],
    ['a wrong path', request('GET', `${PUBLICATION_MANIFEST_DISCOVERY_PATH}/`)],
    ['a query-bearing path', request('HEAD', `${PUBLICATION_MANIFEST_DISCOVERY_PATH}?secret=yes`)],
    ['an encoded path', request('GET', '/.well-known/%63ollection-protocol')],
  ] as const)(`keeps route misses null and free of fabricated hints: %s ${evidence}`, (_name, input) => {
    const result = handlePublicationManifestDiscoveryRequest(minimalManifest(), input);
    expect(result).toBeNull();
    expect(JSON.stringify(result)).not.toContain(expectedLink);
    expect(JSON.stringify(result)).not.toContain(expectedHtml);
  });

  it(`keeps malformed Manifest errors free of discovery hint leakage ${evidence}`, () => {
    const malformed = { secret: 'private-token', mounts: [] };
    expect(() => handlePublicationManifestDiscoveryRequest(malformed, request())).toThrow(TypeError);
    try {
      handlePublicationManifestDiscoveryRequest(malformed, request());
    } catch (error) {
      expect(String(error)).not.toContain(expectedLink);
      expect(String(error)).not.toContain(expectedHtml);
      expect(String(error)).not.toContain('private-token');
    }
  });

  it(`retains PUB-0011 exact-path GET/HEAD semantics while adding Link ${evidence}`, () => {
    const get = handlePublicationManifestDiscoveryRequest(minimalManifest(), request('GET'));
    const head = handlePublicationManifestDiscoveryRequest(minimalManifest(), request('HEAD'));
    expect(get?.status).toBe(200);
    expect(head?.status).toBe(200);
    expect(head?.headers).toEqual(get?.headers);
    expect(head?.body).toBeNull();
    expect(get?.body).toEqual(expect.any(String));
  });

  it(`keeps hint output bounded and deterministic at the resource boundary ${evidence}`, () => {
    expect(PUBLICATION_DISCOVERY_HTML_LINK.length).toBeLessThan(256);
    expect(PUBLICATION_DISCOVERY_LINK_HEADER.length).toBeLessThan(256);
    const merged = mergePublicationDiscoveryHeaders({ 'x-boundary': 'x'.repeat(1024) });
    expect(merged.Link).toBe(expectedLink);
    expect(merged['x-boundary']).toHaveLength(1024);
  });

  it(`enforces header count and UTF-8 byte resource limits ${evidence}`, () => {
    const acceptedCount = Object.fromEntries(
      Array.from({ length: 128 }, (_, index) => [`x-${index}`, '']),
    );
    expect(Object.keys(mergePublicationDiscoveryHeaders(acceptedCount))).toHaveLength(129);
    expect(() => mergePublicationDiscoveryHeaders({
      ...acceptedCount,
      'x-overflow': '',
    })).toThrow(RangeError);

    expect(mergePublicationDiscoveryHeaders({ 'x-limit': 'x'.repeat(16 * 1024) }))
      .toHaveProperty('x-limit');
    expect(() => mergePublicationDiscoveryHeaders({
      'x-limit': 'x'.repeat((16 * 1024) + 1),
    })).toThrow(RangeError);
    expect(() => mergePublicationDiscoveryHeaders(Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [`x-total-${index}`, 'x'.repeat(16 * 1024)]),
    ))).toThrow(RangeError);
  });
});
