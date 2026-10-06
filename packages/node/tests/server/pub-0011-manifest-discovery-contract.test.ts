import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createValidatorRegistry } from '../../src/schema/index.js';
import { validateManifestSemantics } from '../../src/semantic/index.js';
import {
  MAX_PUBLICATION_MANIFEST_BYTES,
  PUBLICATION_MANIFEST_DISCOVERY_PATH,
  PUBLICATION_MANIFEST_MEDIA_TYPE,
  createPublicationManifestDiscoveryHandler,
  handlePublicationManifestDiscoveryRequest,
  type PublicationManifestDiscoveryRequest,
  type PublicationManifestDiscoveryResponse,
} from '../../src/server/index.js';

const evidence = '[evidence:http.manifest-discovery]';
const fixturePath = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'protocol',
  'examples',
  'public-manifest.json',
);

function manifest(): Record<string, any> {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, any>;
}

function request(
  method: string = 'GET',
  path: string = PUBLICATION_MANIFEST_DISCOVERY_PATH,
): PublicationManifestDiscoveryRequest {
  return { method, path };
}

function handle(
  value: unknown = manifest(),
  input: PublicationManifestDiscoveryRequest = request(),
): PublicationManifestDiscoveryResponse | null {
  return handlePublicationManifestDiscoveryRequest(value, input);
}

function requireResponse(
  response: PublicationManifestDiscoveryResponse | null,
): PublicationManifestDiscoveryResponse {
  expect(response).not.toBeNull();
  return response!;
}

function expectRejectedWithoutReflection(work: () => unknown, secret: string): Error {
  let rejection: unknown;
  try {
    work();
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).message).not.toContain(secret);
  return rejection as Error;
}

describe(`PUB-0011 server Manifest discovery contract ${evidence}`, () => {
  it(`binds discovery to the sole canonical well-known path ${evidence}`, () => {
    expect(PUBLICATION_MANIFEST_DISCOVERY_PATH).toBe('/.well-known/collection-protocol');
    expect(requireResponse(handle()).status).toBe(200);
  });

  it.each([
    ['a trailing slash', '/.well-known/collection-protocol/'],
    ['a case-changed well-known segment', '/.WELL-KNOWN/collection-protocol'],
    ['a case-changed resource name', '/.well-known/Collection-Protocol'],
    ['an encoded initial resource letter', '/.well-known/%63ollection-protocol'],
    ['an encoded hyphen', '/.well-known/collection%2Dprotocol'],
    ['an encoded slash', '/.well-known%2Fcollection-protocol'],
    ['a doubled slash', '//.well-known/collection-protocol'],
    ['a prefixed mount', '/api/.well-known/collection-protocol'],
    ['a suffixed segment', '/.well-known/collection-protocol.json'],
    ['an empty query marker', '/.well-known/collection-protocol?'],
    ['a query', '/.well-known/collection-protocol?version=0.1'],
    ['a fragment', '/.well-known/collection-protocol#manifest'],
    ['a query and fragment', '/.well-known/collection-protocol?x=1#manifest'],
    ['an absolute URL', 'https://example.test/.well-known/collection-protocol'],
    ['an empty path', ''],
  ] as const)(`does not serve %s as the Manifest location ${evidence}`, (_name, path) => {
    expect(handle(manifest(), request('GET', path))).toBeNull();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT'])(
    `does not serve the exact path for %s ${evidence}`,
    (method) => {
      expect(handle(manifest(), request(method))).toBeNull();
    },
  );

  it.each(['get', 'head', ' Get', 'GET ', 'GET\t', 'G\u0000ET', 'GET\r\nX-Test: yes'])(
    `does not normalize an invalid or non-canonical method %s ${evidence}`,
    (method) => {
      expect(handle(manifest(), request(method))).toBeNull();
    },
  );

  it(`short-circuits every non-matching path before reading the Manifest ${evidence}`, () => {
    let manifestReads = 0;
    const inaccessibleManifest = new Proxy(Object.create(null) as object, {
      get() {
        manifestReads += 1;
        throw new Error('loader-secret-must-not-run');
      },
      getOwnPropertyDescriptor() {
        manifestReads += 1;
        throw new Error('loader-secret-must-not-run');
      },
      getPrototypeOf() {
        manifestReads += 1;
        throw new Error('loader-secret-must-not-run');
      },
      ownKeys() {
        manifestReads += 1;
        throw new Error('loader-secret-must-not-run');
      },
    });

    for (const input of [
      request('POST'),
      request('GET', `${PUBLICATION_MANIFEST_DISCOVERY_PATH}/`),
      request('HEAD', `${PUBLICATION_MANIFEST_DISCOVERY_PATH}?secret=one`),
    ]) {
      expect(handle(inaccessibleManifest, input)).toBeNull();
    }
    expect(manifestReads).toBe(0);
  });

  it(`serves a structurally and semantically valid Publication Manifest ${evidence}`, () => {
    const source = manifest();
    const response = requireResponse(handle(source));
    expect(response.status).toBe(200);
    expect(typeof response.body).toBe('string');

    const document = JSON.parse(response.body!) as Record<string, any>;
    expect(document).toEqual(source);
    expect(createValidatorRegistry().validate('manifest', document)).toEqual({ valid: true, errors: [] });
    expect(validateManifestSemantics(document as never)).toEqual({ valid: true, issues: [] });
    expect(document.mounts.some(
      (mount: Record<string, any>) => mount.profiles.includes('publication'),
    )).toBe(true);
  });

  it(`returns exact JSON metadata and a UTF-8 GET body ${evidence}`, () => {
    const response = requireResponse(handle());
    expect(response.headers['content-type']).toBe(PUBLICATION_MANIFEST_MEDIA_TYPE);
    expect(PUBLICATION_MANIFEST_MEDIA_TYPE).toBe(
      'application/vnd.collection-protocol.manifest+json;version=0.1',
    );
    expect(response.body).not.toBeNull();
    expect(response.body).not.toMatch(/^\ufeff/u);
    expect(response.headers['content-length']).toBe(
      String(new TextEncoder().encode(response.body!).byteLength),
    );
  });

  it(`serves HEAD with GET metadata and no body ${evidence}`, () => {
    const source = manifest();
    const get = requireResponse(handle(source, request('GET')));
    const head = requireResponse(handle(source, request('HEAD')));

    expect(head.status).toBe(200);
    expect(head.headers).toEqual(get.headers);
    expect(head.headers['content-type']).toBe(PUBLICATION_MANIFEST_MEDIA_TYPE);
    expect(head.headers['content-length']).toBe(
      String(new TextEncoder().encode(get.body!).byteLength),
    );
    expect(head.body).toBeNull();
    expect(JSON.stringify(head)).not.toContain(source.serverUuid);
  });

  it(`uses UTF-8 octets rather than UTF-16 code units for Content-Length ${evidence}`, () => {
    const source = manifest();
    source.title = 'Collection caf\u00e9 \ud83d\ude00';
    const response = requireResponse(handle(source));
    expect(response.body).toContain('Collection caf\u00e9 \ud83d\ude00');
    expect(Number(response.headers['content-length'])).toBe(
      new TextEncoder().encode(response.body!).byteLength,
    );
    expect(Number(response.headers['content-length'])).toBeGreaterThan(response.body!.length);
  });

  it(`accepts a Manifest when any independently declared mount supports Publication ${evidence}`, () => {
    const source = manifest();
    const publicationMount = structuredClone(source.mounts[0]);
    source.mounts[0].profiles = ['core'];
    publicationMount.id = 'publication-mount';
    publicationMount.baseUrl = 'https://alice.example/publication/';
    source.mounts.push(publicationMount);

    expect(requireResponse(handle(source)).status).toBe(200);
  });

  it(`rejects a structurally valid Manifest with no Publication mount ${evidence}`, () => {
    const source = manifest();
    for (const mount of source.mounts) {
      mount.profiles = ['core'];
    }
    expect(createValidatorRegistry().validate('manifest', source).valid).toBe(true);
    expect(validateManifestSemantics(source as never)).toEqual({ valid: true, issues: [] });
    expect(() => handle(source)).toThrow(TypeError);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'manifest'],
    ['a number', 1],
    ['a boolean', true],
    ['a function', () => manifest()],
    ['a Date', new Date('2026-07-18T00:00:00Z')],
  ])(`rejects malformed Manifest input supplied as %s ${evidence}`, (_name, value) => {
    expect(() => handle(value)).toThrow(TypeError);
    expect(() => createPublicationManifestDiscoveryHandler(value)).toThrow(TypeError);
  });

  it.each([
    ['a missing protocol', (value: Record<string, any>) => { delete value.protocol; }],
    ['an unsupported protocol', (value: Record<string, any>) => { value.protocol = 'https://example.test/not-colp'; }],
    ['an empty mount list', (value: Record<string, any>) => { value.mounts = []; }],
    ['a malformed profile', (value: Record<string, any>) => { value.mounts[0].profiles.push('Publication'); }],
    ['an unknown top-level property', (value: Record<string, any>) => { value.internalSecret = 'private'; }],
    ['a malformed endpoint template', (value: Record<string, any>) => { value.mounts[0].endpoints.node = '/relative/{nodeId}'; }],
  ] as const)(`rejects Manifest with %s ${evidence}`, (_name, mutate) => {
    const source = manifest();
    mutate(source);
    expect(() => handle(source)).toThrow(TypeError);
  });

  it(`accepts the exact Manifest byte limit and rejects the next UTF-8 byte ${evidence}`, () => {
    const source = manifest();
    source.title = '';
    const baseLength = new TextEncoder().encode(JSON.stringify(source)).byteLength;
    const room = MAX_PUBLICATION_MANIFEST_BYTES - baseLength;

    source.title = 'x'.repeat(room);
    const exact = requireResponse(handle(source));
    expect(new TextEncoder().encode(exact.body!).byteLength).toBe(MAX_PUBLICATION_MANIFEST_BYTES);

    source.title += 'x';
    expect(() => handle(source)).toThrow(RangeError);
    expect(() => createPublicationManifestDiscoveryHandler(source)).toThrow(RangeError);
  });

  it(`rejects inherited and non-plain Manifest state ${evidence}`, () => {
    const inherited = Object.assign(Object.create(manifest()), {});
    expect(() => handle(inherited)).toThrow(TypeError);

    const customPrototype = Object.assign(Object.create({ internalSecret: 'prototype-secret' }), manifest());
    expectRejectedWithoutReflection(() => handle(customPrototype), 'prototype-secret');
  });

  it(`rejects Manifest accessors without invoking them ${evidence}`, () => {
    const source = manifest();
    let getterReads = 0;
    Object.defineProperty(source, 'title', {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error('manifest-accessor-secret');
      },
    });

    expectRejectedWithoutReflection(() => handle(source), 'manifest-accessor-secret');
    expect(getterReads).toBe(0);
  });

  it(`rejects nested Manifest accessors without invoking them ${evidence}`, () => {
    const source = manifest();
    let getterReads = 0;
    Object.defineProperty(source.mounts[0].endpoints, 'directory', {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error('nested-accessor-secret');
      },
    });

    expectRejectedWithoutReflection(() => handle(source), 'nested-accessor-secret');
    expect(getterReads).toBe(0);
  });

  it(`rejects Proxy-backed Manifest values without reading arbitrary properties ${evidence}`, () => {
    const source = manifest();
    let propertyReads = 0;
    const proxied = new Proxy(source, {
      get() {
        propertyReads += 1;
        throw new Error('proxy-property-secret');
      },
    });

    expectRejectedWithoutReflection(() => handle(proxied), 'proxy-property-secret');
    expect(propertyReads).toBe(0);
  });

  it.each([
    ['a symbol property', (value: Record<PropertyKey, any>) => { value[Symbol('secret')] = true; }],
    ['a non-enumerable property', (value: Record<PropertyKey, any>) => {
      Object.defineProperty(value, 'internalSecret', { value: 'private', enumerable: false });
    }],
    ['a circular extension', (value: Record<PropertyKey, any>) => {
      const cycle: Record<string, unknown> = {};
      cycle.self = cycle;
      value.extensions = { 'https://vendor.example/cycle': cycle };
    }],
    ['a control character', (value: Record<PropertyKey, any>) => { value.title = 'line\u0000secret'; }],
    ['a lone high surrogate', (value: Record<PropertyKey, any>) => { value.title = 'bad\ud800text'; }],
    ['a lone low surrogate', (value: Record<PropertyKey, any>) => { value.title = 'bad\udc00text'; }],
  ] as const)(`rejects unsafe Manifest containing %s ${evidence}`, (_name, mutate) => {
    const source = manifest();
    mutate(source);
    expect(() => handle(source)).toThrow();
  });

  it.each([
    ['a null request', null],
    ['an array request', ['GET', PUBLICATION_MANIFEST_DISCOVERY_PATH]],
    ['a missing method', { path: PUBLICATION_MANIFEST_DISCOVERY_PATH }],
    ['a missing path', { method: 'GET' }],
    ['an extra request property', { method: 'GET', path: PUBLICATION_MANIFEST_DISCOVERY_PATH, principal: 'secret' }],
    ['a numeric method', { method: 1, path: PUBLICATION_MANIFEST_DISCOVERY_PATH }],
    ['a URL path object', { method: 'GET', path: new URL('https://example.test/') }],
  ])(`fails closed for request control input supplied as %s ${evidence}`, (_name, input) => {
    expect(handle(manifest(), input as never)).toBeNull();
  });

  it(`rejects request accessors without invoking them ${evidence}`, () => {
    let getterReads = 0;
    const input = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(input, 'method', {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error('request-method-secret');
      },
    });
    input.path = PUBLICATION_MANIFEST_DISCOVERY_PATH;

    expect(handle(manifest(), input as never)).toBeNull();
    expect(getterReads).toBe(0);
  });

  it(`captures a detached immutable Manifest snapshot when the handler is created ${evidence}`, () => {
    const source = manifest();
    const originalTitle = source.title;
    const originalDirectory = source.mounts[0].endpoints.directory;
    const handler = createPublicationManifestDiscoveryHandler(source);

    source.title = 'MUTATED PRIVATE TITLE';
    source.mounts[0].endpoints.directory = 'https://private.example/mutated';
    source.mounts.push(structuredClone(source.mounts[0]));

    const response = requireResponse(handler(request()));
    const document = JSON.parse(response.body!) as Record<string, any>;
    expect(document.title).toBe(originalTitle);
    expect(document.mounts[0].endpoints.directory).toBe(originalDirectory);
    expect(response.body).not.toContain('MUTATED PRIVATE TITLE');
    expect(response.body).not.toContain('private.example');
  });

  it(`returns deeply frozen reusable response metadata ${evidence}`, () => {
    const handler = createPublicationManifestDiscoveryHandler(manifest());
    const first = requireResponse(handler(request()));
    const second = requireResponse(handler(request()));

    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.headers)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
    expect(Object.isFrozen(second.headers)).toBe(true);
    expect(() => Object.assign(first.headers, { authorization: 'Bearer leaked' })).toThrow(TypeError);
  });

  it(`does not expose a one-shot Response body across repeated GET and HEAD calls ${evidence}`, () => {
    const handler = createPublicationManifestDiscoveryHandler(manifest());
    const firstGet = requireResponse(handler(request('GET')));
    const head = requireResponse(handler(request('HEAD')));
    const secondGet = requireResponse(handler(request('GET')));

    expect(typeof firstGet.body).toBe('string');
    expect(firstGet).not.toBeInstanceOf(Response);
    expect(head.body).toBeNull();
    expect(secondGet.body).toBe(firstGet.body);
    expect(JSON.parse(firstGet.body!)).toEqual(JSON.parse(secondGet.body!));
  });

  it(`keeps non-matching handler calls bodyless and free of Manifest text ${evidence}`, () => {
    const source = manifest();
    source.title = 'NONMATCH SECRET TITLE';
    const handler = createPublicationManifestDiscoveryHandler(source);

    for (const input of [request('POST'), request('GET', '/'), request('HEAD', `${PUBLICATION_MANIFEST_DISCOVERY_PATH}#x`)]) {
      const result = handler(input);
      expect(result).toBeNull();
      expect(JSON.stringify(result)).not.toContain('NONMATCH SECRET TITLE');
    }
  });
});
