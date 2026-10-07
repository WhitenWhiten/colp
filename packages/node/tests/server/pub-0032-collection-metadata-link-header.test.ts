import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createPublicationCollectionMetadataResponse,
  type PublicationCollectionMetadataHeadersInit,
  type PublicationCollectionMetadataResponseInit,
} from '../../src/server/index.js';

const evidence = '[evidence:http.collection-metadata-link-header]';
const fixturePath = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'protocol',
  'examples',
  'collection-metadata.json',
);

const collectionMediaType = 'application/vnd.collection-protocol.collection+json';
const snapshotMediaType = 'application/vnd.collection-protocol.snapshot+json';
const feedMediaType = 'application/vnd.collection-protocol.feed+json';

function metadata(): Record<string, unknown> {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
}

function linksOf(value: Record<string, unknown>): Record<PropertyKey, unknown> {
  return value.links as Record<PropertyKey, unknown>;
}

function create(
  value: unknown = metadata(),
  init: PublicationCollectionMetadataResponseInit = { method: 'GET' },
): Response {
  return createPublicationCollectionMetadataResponse(value, init);
}

function link(response: Response): string | null {
  return response.headers.get('Link');
}

function expectedCoreLinks(value: Record<string, unknown>): string {
  const links = linksOf(value);
  return [
    `<${String(links.self)}>; rel="self"; type="${collectionMediaType}"`,
    `<${String(links.canonical)}>; rel="canonical"; type="text/html"`,
    `<${String(links.snapshot)}>; rel="https://know-n.com/colp/rels/snapshot"; type="${snapshotMediaType}"`,
  ].join(', ');
}

function captureError(work: () => unknown): Error {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('Expected Collection Metadata response construction to fail.');
}

describe(`PUB-0032 Collection Metadata Link response contract ${evidence}`, () => {
  it(`derives exact self canonical snapshot feed and JSON Feed alternate links from the body ${evidence}`, () => {
    const value = metadata();
    const links = linksOf(value);
    links.alternateJsonFeed = 'https://feeds.example/interface-systems.json';

    expect(link(create(value))).toBe([
      expectedCoreLinks(value),
      `<${String(links.feed)}>; rel="https://know-n.com/colp/rels/feed"; type="${feedMediaType}"`,
      '<https://feeds.example/interface-systems.json>; rel="alternate"; type="application/feed+json"',
    ].join(', '));
  });

  it(`uses the Atom media type for the optional Atom alternate ${evidence}`, () => {
    const value = metadata();
    const links = linksOf(value);
    delete links.feed;
    links.alternateAtom = 'https://feeds.example/interface-systems.atom';

    expect(link(create(value))).toBe([
      expectedCoreLinks(value),
      '<https://feeds.example/interface-systems.atom>; rel="alternate"; type="application/atom+xml"',
    ].join(', '));
  });

  it.each([
    ['feed only', { feed: 'https://feeds.example/live' }, `; rel="https://know-n.com/colp/rels/feed"; type="${feedMediaType}"`],
    ['JSON Feed alternate only', { alternateJsonFeed: 'https://feeds.example/live.json' }, '; rel="alternate"; type="application/feed+json"'],
    ['Atom alternate only', { alternateAtom: 'https://feeds.example/live.atom' }, '; rel="alternate"; type="application/atom+xml"'],
  ] as const)(`emits an optional %s only when its body link is present ${evidence}`, (_name, optional, suffix) => {
    const value = metadata();
    const links = linksOf(value);
    delete links.feed;
    Object.assign(links, optional);

    const result = link(create(value))!;
    expect(result).toContain(`<${Object.values(optional)[0]}>${suffix}`);
    expect(result.split(', ')).toHaveLength(4);
  });

  it(`omits all optional feed and alternate relations without fabricating conventional URLs ${evidence}`, () => {
    const value = metadata();
    const links = linksOf(value);
    delete links.feed;
    delete links.alternateJsonFeed;
    delete links.alternateAtom;

    expect(link(create(value))).toBe(expectedCoreLinks(value));
    expect(link(create(value))).not.toMatch(/feed|alternate/iu);
  });

  it(`preserves absolute same-origin and cross-Origin body URLs byte-for-byte ${evidence}`, () => {
    const value = metadata();
    Object.assign(linksOf(value), {
      self: 'https://api.example:8443/v1/c/id%2Fpart?view=public',
      canonical: 'https://www.example/human/%E2%9C%93?lang=zh',
      snapshot: 'https://cdn.example/snapshots/id?signature=a%2Bb%3D',
      feed: 'http://127.0.0.1:8787/live?id=id%2Fpart',
      alternateJsonFeed: 'https://feeds.other.example/f.json?source=collection',
    });

    const result = link(create(value))!;
    for (const key of ['self', 'canonical', 'snapshot', 'feed', 'alternateJsonFeed'] as const) {
      expect(result).toContain(`<${String(linksOf(value)[key])}>`);
    }
    for (const key of ['nodes', 'annotations', 'relations', 'releases'] as const) {
      expect(result).not.toContain(`<${String(linksOf(value)[key])}>`);
    }
    expect(result).not.toContain('api.example/collections/c/');
  });

  it(`merges one unrelated existing Link field before generated resource links ${evidence}`, () => {
    const value = metadata();
    const existing = '<https://schema.example/collection>; rel="describedby"; type="application/schema+json"';
    const response = create(value, { method: 'GET', headers: { Link: existing } });

    expect(link(response)).toBe(`${existing}, ${expectedCoreLinks(value)}, <${String(linksOf(value).feed)}>; rel="https://know-n.com/colp/rels/feed"; type="${feedMediaType}"`);
    expect(Array.from(response.headers.keys()).filter((name) => name.toLowerCase() === 'link')).toEqual(['link']);
  });

  it(`deduplicates an exact pre-existing generated link instead of emitting it twice ${evidence}`, () => {
    const value = metadata();
    const duplicate = `<${String(linksOf(value).self)}>; rel="self"; type="${collectionMediaType}"`;
    const result = link(create(value, { method: 'GET', headers: { Link: duplicate } }))!;

    expect(result.match(/rel="self"/gu)).toHaveLength(1);
    expect(result.split(', ')).toHaveLength(4);
  });

  it.each([
    ['self', '<https://attacker.example/wrong>; rel="self"; type="application/vnd.collection-protocol.collection+json"'],
    ['canonical', '<https://attacker.example/wrong>; rel="canonical"; type="text/html"'],
    ['snapshot', '<https://attacker.example/wrong>; rel="https://know-n.com/colp/rels/snapshot"; type="application/vnd.collection-protocol.snapshot+json"'],
    ['feed', '<https://attacker.example/wrong>; rel="https://know-n.com/colp/rels/feed"; type="application/vnd.collection-protocol.feed+json"'],
    ['case-insensitive self', '<https://attacker.example/wrong>; rel="SELF"; type="application/vnd.collection-protocol.collection+json"'],
  ] as const)(`rejects a conflicting existing %s relation ${evidence}`, (_name, existing) => {
    expect(() => create(metadata(), { method: 'GET', headers: { Link: existing } })).toThrow(TypeError);
  });

  it.each(['GET', 'HEAD'] as const)(`publishes identical metadata headers for %s ${evidence}`, (method) => {
    const response = create(metadata(), {
      method,
      headers: {
        'Cache-Control': 'private, no-store',
        Vary: 'Origin, Authorization',
        Origin: 'https://app.example',
        'X-Request-Id': 'request-0032',
      },
    });

    expect(response.status).toBe(200);
    expect(link(response)).toContain('rel="self"');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('Origin, Authorization');
    expect(response.headers.get('Origin')).toBe('https://app.example');
    expect(response.headers.get('X-Request-Id')).toBe('request-0032');
  });

  it(`keeps GET and HEAD status plus headers identical while HEAD has no body ${evidence}`, async () => {
    const value = metadata();
    const get = create(value, { method: 'GET', headers: { 'Cache-Control': 'public, max-age=60' } });
    const head = create(value, { method: 'HEAD', headers: { 'Cache-Control': 'public, max-age=60' } });

    expect(head.status).toBe(get.status);
    expect(Array.from(head.headers.entries())).toEqual(Array.from(get.headers.entries()));
    expect(await get.json()).toEqual(value);
    expect(await head.text()).toBe('');
    expect(head.body).toBeNull();
  });

  it.each([300, 400, 401, 403, 404, 409, 422, 500, 503])(
    `does not attach success-resource Links to status %s ${evidence}`,
    (status) => {
      const response = create({ type: 'about:blank', status }, { method: 'GET', status });
      expect(response.status).toBe(status);
      expect(link(response)).toBeNull();
    },
  );

  it(`does not preserve a caller-supplied success-resource Link on an error response ${evidence}`, () => {
    const response = create({ status: 404 }, {
      method: 'GET',
      status: 404,
      headers: { Link: '<https://api.example/private>; rel="self"' },
    });
    expect(link(response)).toBeNull();
  });

  it(`preserves unrelated safe Link metadata while removing success-resource relations on errors ${evidence}`, () => {
    const describedBy = '<https://schema.example/collection>; rel="describedby"; type="application/schema+json"';
    const response = create({ status: 404 }, {
      method: 'HEAD',
      status: 404,
      headers: {
        Link: `${describedBy}, <https://api.example/private>; rel="self"`,
        'Cache-Control': 'private, no-store',
        Vary: 'Origin, Authorization',
        Origin: 'https://app.example',
      },
    });

    expect(link(response)).toBe('<https://schema.example/collection>; rel=describedby; type="application/schema+json"');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('Origin, Authorization');
    expect(response.headers.get('Origin')).toBe('https://app.example');
    expect(response.body).toBeNull();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'get', 'head', ''])(
    `rejects unsupported or non-canonical method %j ${evidence}`,
    (method) => {
      expect(() => create(metadata(), { method } as PublicationCollectionMetadataResponseInit)).toThrow(TypeError);
    },
  );

  it.each([
    ['CR in a URL', 'self', 'https://api.example/value\rX-Injected: yes'],
    ['LF in a URL', 'canonical', 'https://www.example/value\nX-Injected: yes'],
    ['userinfo', 'snapshot', 'https://user:password@cdn.example/snapshot'],
    ['a non-HTTP scheme', 'self', 'file:///private/collection.json'],
    ['a JavaScript scheme', 'canonical', 'javascript:alert(1)'],
    ['a relative URL', 'snapshot', '../snapshot'],
    ['a malformed percent escape', 'feed', 'https://feeds.example/%zz'],
    ['an empty URL', 'alternateJsonFeed', ''],
  ] as const)(`rejects %s without emitting a Link header ${evidence}`, (_name, key, target) => {
    const value = metadata();
    linksOf(value)[key] = target;
    expect(() => create(value)).toThrow(TypeError);
  });

  it.each([
    ['CRLF injection', { Link: '<https://safe.example>; rel="describedby"\r\nX-Injected: yes' }],
    ['a malformed Link field', { Link: 'not-a-link-value' }],
    ['a credentialed Link target', { Link: '<https://user:pass@safe.example>; rel="describedby"' }],
    ['a non-HTTP Link target', { Link: '<file:///private>; rel="describedby"' }],
  ] as const)(`rejects unsafe existing headers: %s ${evidence}`, (_name, headers) => {
    expect(() => create(metadata(), { method: 'GET', headers })).toThrow(TypeError);
  });

  it(`rejects accessor and Proxy header sources without invoking hostile code ${evidence}`, () => {
    let getterCalls = 0;
    let proxyTraps = 0;
    const accessor = Object.defineProperty({}, 'Link', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('header-getter-secret');
      },
    });
    const proxied = new Proxy({ Vary: 'Origin' }, {
      get() { proxyTraps += 1; throw new Error('header-proxy-secret'); },
      getOwnPropertyDescriptor() { proxyTraps += 1; throw new Error('header-proxy-secret'); },
      getPrototypeOf() { proxyTraps += 1; throw new Error('header-proxy-secret'); },
      ownKeys() { proxyTraps += 1; throw new Error('header-proxy-secret'); },
    });

    for (const headers of [accessor, proxied]) {
      const error = captureError(() => create(metadata(), {
        method: 'GET',
        headers: headers as PublicationCollectionMetadataHeadersInit,
      }));
      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).not.toMatch(/header-(getter|proxy)-secret/u);
    }
    expect(getterCalls).toBe(0);
    expect(proxyTraps).toBe(0);
  });

  it(`rejects accessor-bearing metadata without invoking the getter ${evidence}`, () => {
    let getterCalls = 0;
    const value = Object.defineProperty(metadata(), 'links', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('metadata-getter-secret');
      },
    });
    const error = captureError(() => create(value));

    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).not.toContain('metadata-getter-secret');
    expect(getterCalls).toBe(0);
  });

  it(`rejects accessor-bearing links without invoking a URL getter ${evidence}`, () => {
    let getterCalls = 0;
    const value = metadata();
    Object.defineProperty(linksOf(value), 'self', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('link-getter-secret');
      },
    });
    const error = captureError(() => create(value));

    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).not.toContain('link-getter-secret');
    expect(getterCalls).toBe(0);
  });

  it(`rejects Proxy metadata and links without invoking traps ${evidence}`, () => {
    let traps = 0;
    const handler: ProxyHandler<object> = {
      get() { traps += 1; throw new Error('proxy-get-secret'); },
      getOwnPropertyDescriptor() { traps += 1; throw new Error('proxy-descriptor-secret'); },
      getPrototypeOf() { traps += 1; throw new Error('proxy-prototype-secret'); },
      ownKeys() { traps += 1; throw new Error('proxy-keys-secret'); },
    };
    const proxiedMetadata = new Proxy(metadata(), handler);
    const value = metadata();
    value.links = new Proxy(linksOf(value), handler);

    for (const candidate of [proxiedMetadata, value]) {
      const error = captureError(() => create(candidate));
      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).not.toContain('proxy-');
    }
    expect(traps).toBe(0);
  });

  it(`rejects inherited metadata and inherited links ${evidence}`, () => {
    const inheritedMetadata = Object.assign(Object.create(metadata()), { collection: metadata().collection });
    const value = metadata();
    value.links = Object.assign(Object.create(linksOf(value)), {});

    expect(() => create(inheritedMetadata)).toThrow(TypeError);
    expect(() => create(value)).toThrow(TypeError);
  });

  it(`rejects an incomplete Collection Metadata body even when its Link object is valid ${evidence}`, () => {
    const value = metadata();
    delete (value.collection as Record<string, unknown>).title;

    expect(() => create(value)).toThrow(TypeError);
  });

  it(`rejects symbol keys non-string URLs and unknown link relations ${evidence}`, () => {
    const symbolValue = metadata();
    linksOf(symbolValue)[Symbol('secret')] = 'https://attacker.example/';
    const numberValue = metadata();
    linksOf(numberValue).self = 42;
    const unknownValue = metadata();
    linksOf(unknownValue).unknown = 'https://attacker.example/';

    for (const value of [symbolValue, numberValue, unknownValue]) {
      expect(() => create(value)).toThrow(TypeError);
    }
  });

  it(`accepts a long but bounded URL and rejects the next byte beyond the limit ${evidence}`, () => {
    const prefix = 'https://www.example/';
    const accepted = metadata();
    linksOf(accepted).canonical = `${prefix}${'a'.repeat(4_096 - prefix.length)}`;
    expect(link(create(accepted))).toContain(String(linksOf(accepted).canonical));

    const rejected = metadata();
    linksOf(rejected).canonical = `${prefix}${'a'.repeat(4_097 - prefix.length)}`;
    expect(() => create(rejected)).toThrow(RangeError);
  });

  it(`detaches the serialized body and Link header from later source mutation ${evidence}`, async () => {
    const value = metadata();
    const originalSelf = String(linksOf(value).self);
    const response = create(value);
    (value.collection as Record<string, unknown>).title = 'Mutated title';
    linksOf(value).self = 'https://attacker.example/mutated';

    expect(link(response)).toContain(`<${originalSelf}>`);
    expect(link(response)).not.toContain('attacker.example');
    expect((await response.json() as { collection: { title: string } }).collection.title).toBe('Interface Systems');
  });

  it(`returns independently mutable Response instances without sharing generated metadata ${evidence}`, () => {
    const value = metadata();
    const first = create(value);
    const second = create(value);
    first.headers.set('Link', '<https://attacker.example/>; rel="self"');
    first.headers.set('Vary', 'X-Attacker');

    expect(link(second)).toContain(`<${String(linksOf(value).self)}>`);
    expect(link(second)).not.toContain('attacker.example');
    expect(second.headers.get('Vary')).toBeNull();
  });
});
