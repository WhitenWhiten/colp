import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createValidatorRegistry } from '../../src/schema/index.js';
import {
  composePublicationHttpRead,
  createPublicationRepresentationEtag,
  type AnonymousPublicationHttpReadRepresentation,
  type AuthorizedPublicationHttpReadRepresentation,
  type PublicationHttpReadEndpoint,
  type PublicationHttpReadRepresentation,
} from '../../src/server/index.js';

const evidence = '[evidence:http.publication-read-composition]';
const lastModified = new Date('2026-07-19T01:02:03.000Z');
const secret = 'publication-secret-7f31';
const fixtureNames = {
  manifest: 'public-manifest.json',
  directory: 'collection-directory.json',
  metadata: 'collection-metadata.json',
  snapshot: 'collection-snapshot.json',
  node: 'node-detail.json',
} as const;

function fixture(endpoint: PublicationHttpReadEndpoint): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(
    import.meta.dirname,
    '..',
    '..',
    'fixtures',
    'protocol',
    'examples',
    fixtureNames[endpoint],
  ), 'utf8')) as Record<string, unknown>;
}

function representation(
  value: unknown,
  change?: Partial<AnonymousPublicationHttpReadRepresentation>,
): AnonymousPublicationHttpReadRepresentation;
function representation(
  value: unknown,
  change: Partial<AuthorizedPublicationHttpReadRepresentation> & { readonly principalScope: string },
): AuthorizedPublicationHttpReadRepresentation;
function representation(
  value: unknown,
  change: Partial<PublicationHttpReadRepresentation> = {},
): PublicationHttpReadRepresentation {
  return {
    value,
    revision: 'revision-7',
    projectionKey: 'public',
    protocolVersion: '0.1',
    lastModified,
    ...change,
  };
}

async function bodyText(response: Response): Promise<string> {
  return new TextDecoder().decode(await response.arrayBuffer());
}

async function bodyJson(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await bodyText(response)) as Record<string, unknown>;
}

async function anonymousRead(
  value: unknown,
  change: {
    endpoint?: PublicationHttpReadEndpoint;
    rawSearch?: string;
    method?: 'GET' | 'HEAD';
    ifNoneMatch?: string;
    representation?: Partial<AnonymousPublicationHttpReadRepresentation>;
  } = {},
): Promise<Response> {
  return composePublicationHttpRead({
    access: 'anonymous-public',
    endpoint: change.endpoint ?? 'snapshot',
    method: change.method ?? 'GET',
    rawSearch: change.rawSearch ?? '?root=root_1&depth=2&include=annotations',
    validators: createValidatorRegistry(),
    ...(change.ifNoneMatch === undefined ? {} : { ifNoneMatch: change.ifNoneMatch }),
    resolveRepresentation: () => representation(value, change.representation),
  });
}

describe(`Publication HTTP read composition boundary ${evidence}`, () => {
  it(`decodes and rejects an invalid query before authorization or resolution ${evidence}`, async () => {
    const events: string[] = [];
    const authorize = vi.fn(() => {
      events.push('authorize');
      return { allowed: true as const, context: { principal: 'alice' } };
    });
    const resolveRepresentation = vi.fn(() => {
      events.push('resolve');
      return representation({ visible: true }, { principalScope: 'alice' });
    });

    const response = await composePublicationHttpRead({
      access: 'authorized-private',
      endpoint: 'snapshot',
      method: 'GET',
      rawSearch: `?root=root_1&unknown=${encodeURIComponent(secret)}`,
      validators: createValidatorRegistry(),
      authorize,
      resolveRepresentation,
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await bodyJson(response.clone())).toMatchObject({ code: 'invalid_query', status: 400 });
    expect(await response.text()).not.toContain(secret);
    expect(events).toEqual([]);
    expect(authorize).not.toHaveBeenCalled();
    expect(resolveRepresentation).not.toHaveBeenCalled();

    const head = await composePublicationHttpRead({
      access: 'authorized-private',
      endpoint: 'snapshot',
      method: 'HEAD',
      rawSearch: `?root=root_1&unknown=${encodeURIComponent(secret)}`,
      validators: createValidatorRegistry(),
      authorize,
      resolveRepresentation,
    });
    expect(head.status).toBe(400);
    expect(Number(head.headers.get('content-length'))).toBeGreaterThan(0);
    expect(await bodyText(head)).toBe('');
    expect(authorize).not.toHaveBeenCalled();
    expect(resolveRepresentation).not.toHaveBeenCalled();
  });

  it(`makes authorization a hard gate and preserves denial concealment ${evidence}`, async () => {
    const resolveRepresentation = vi.fn(() => representation(
      { shouldNeverAppear: secret },
      { principalScope: 'alice' },
    ));
    const response = await composePublicationHttpRead({
      access: 'authorized-private',
      endpoint: 'node',
      method: 'GET',
      rawSearch: '?include=annotations',
      validators: createValidatorRegistry(),
      authorize: (query) => {
        expect(query).toEqual({ include: ['annotations'] });
        return { allowed: false, problem: 'resource_not_found' };
      },
      resolveRepresentation,
    });

    expect(response.status).toBe(404);
    expect(await bodyJson(response.clone())).toMatchObject({ code: 'resource_not_found', status: 404 });
    expect(resolveRepresentation).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain(secret);
  });

  it(`throws stable TypeErrors for illegal authorization decision objects and never resolves ${evidence}`, async () => {
    const resolveRepresentation = vi.fn(() => representation(
      { shouldNeverAppear: secret },
      { principalScope: 'alice' },
    ));
    const illegalDecisions: readonly unknown[] = [
      null,
      [],
      1,
      'yes',
      true,
      new Proxy({ allowed: true as const, context: {} }, {}),
    ];

    for (const decision of illegalDecisions) {
      await expect(composePublicationHttpRead({
        access: 'authorized-private',
        endpoint: 'metadata',
        method: 'GET',
        rawSearch: '',
        validators: createValidatorRegistry(),
        authorize: () => decision as never,
        resolveRepresentation,
      })).rejects.toThrow(/Authorization decision must be a non-Proxy object/u);
    }
    expect(resolveRepresentation).not.toHaveBeenCalled();
  });

  it(`throws a stable TypeError when allowed is missing or not an enumerable data property ${evidence}`, async () => {
    const resolveRepresentation = vi.fn(() => representation(
      { shouldNeverAppear: secret },
      { principalScope: 'alice' },
    ));
    const accessorOnly = Object.defineProperty({}, 'allowed', {
      enumerable: true,
      configurable: true,
      get: () => true,
    });
    const nonEnumerable = Object.defineProperty({}, 'allowed', {
      enumerable: false,
      configurable: true,
      value: true,
    });

    for (const decision of [{}, accessorOnly, nonEnumerable]) {
      await expect(composePublicationHttpRead({
        access: 'authorized-private',
        endpoint: 'metadata',
        method: 'GET',
        rawSearch: '',
        validators: createValidatorRegistry(),
        authorize: () => decision as never,
        resolveRepresentation,
      })).rejects.toThrow(/enumerable data property "allowed"/u);
    }
    expect(resolveRepresentation).not.toHaveBeenCalled();
  });

  it(`throws a stable TypeError when allowed is present but not a valid boolean decision ${evidence}`, async () => {
    const resolveRepresentation = vi.fn(() => representation(
      { shouldNeverAppear: secret },
      { principalScope: 'alice' },
    ));

    for (const decision of [{ allowed: 'yes' }, { allowed: 1 }]) {
      await expect(composePublicationHttpRead({
        access: 'authorized-private',
        endpoint: 'metadata',
        method: 'GET',
        rawSearch: '',
        validators: createValidatorRegistry(),
        authorize: () => decision as never,
        resolveRepresentation,
      })).rejects.toThrow(/invalid "allowed" value/u);
    }
    expect(resolveRepresentation).not.toHaveBeenCalled();
  });

  it.each([
    ['manifest', '', {}],
    ['directory', '?limit=2&q=knowledge', { limit: 2, q: 'knowledge' }],
    ['metadata', '', {}],
    ['snapshot', '?root=root_1&depth=2&include=annotations', { root: 'root_1', depth: 2, include: ['annotations'] }],
    ['node', '?include=relations&include=annotations', { include: ['relations', 'annotations'] }],
  ] as const)(
    `supports the %s representation through the registered query contract ${evidence}`,
    async (endpoint, rawSearch, expectedQuery) => {
      const response = await composePublicationHttpRead({
        access: 'anonymous-public',
        endpoint,
        method: 'GET',
        rawSearch,
        validators: createValidatorRegistry(),
        resolveRepresentation: (query) => {
          expect(query).toEqual(expectedQuery);
          return representation(fixture(endpoint));
        },
      });

      expect(response.status).toBe(200);
      expect(await bodyJson(response)).toEqual(fixture(endpoint));
      expect(response.headers.get('etag')).toMatch(/^"pub\.r1\.[A-Za-z0-9_-]{43}"$/u);
    },
  );

  it(`projects anonymous data before serialization and hashes the exact projected wire bytes ${evidence}`, async () => {
    const input = fixture('snapshot');
    input.apiKey = secret;
    const response = await anonymousRead(input);
    const wire = await bodyText(response.clone());
    const projected = fixture('snapshot');

    expect(JSON.parse(wire)).toEqual(projected);
    expect(wire).not.toContain(secret);
    expect(response.headers.get('content-length')).toBe(String(new TextEncoder().encode(wire).byteLength));
    expect(response.headers.get('etag')).toBe(createPublicationRepresentationEtag({
      representation: new TextEncoder().encode(wire),
      revision: 'revision-7',
      projectionKey: 'public',
      queryContract: 'snapshotQuery',
      query: { root: 'root_1', depth: 2, include: ['annotations'] },
      negotiatedMediaType: 'application/json; charset=utf-8',
      protocolVersion: '0.1',
    }));

    const changedOnlyBehindProjection = await anonymousRead({ ...input, apiKey: `${secret}-changed` });
    const changedPublicWireValue = fixture('snapshot');
    (changedPublicWireValue.collection as Record<string, unknown>).title = 'changed public title';
    const changedPublicWire = await anonymousRead(changedPublicWireValue);
    expect(changedOnlyBehindProjection.headers.get('etag')).toBe(response.headers.get('etag'));
    expect(changedPublicWire.headers.get('etag')).not.toBe(response.headers.get('etag'));
  });

  it(`projects before JSON serialization rather than serializing a secret subtree first ${evidence}`, async () => {
    const input = fixture('snapshot');
    input.apiKey = 1n;
    const response = await anonymousRead(input);

    expect(response.status).toBe(200);
    expect(await bodyJson(response)).toEqual(fixture('snapshot'));
  });

  it(`partitions authorized output and caching by authorization and principal ${evidence}`, async () => {
    async function authorized(principal: string): Promise<Response> {
      return composePublicationHttpRead({
        access: 'authorized-private',
        endpoint: 'metadata',
        method: 'GET',
        rawSearch: '',
        validators: createValidatorRegistry(),
        authorize: () => ({ allowed: true, context: Object.freeze({ principal }) }),
        resolveRepresentation: (query, context) => {
          expect(query).toEqual({});
          return representation(
            fixture('metadata'),
            { projectionKey: 'authorized', principalScope: context.principal, cacheControl: 'public, max-age=600' },
          );
        },
      });
    }

    const alice = await authorized('alice');
    const bob = await authorized('bob');
    expect(await bodyJson(alice.clone())).toEqual(fixture('metadata'));
    expect(await bodyJson(bob.clone())).toEqual(fixture('metadata'));
    expect(alice.headers.get('cache-control')).toBe('private, no-store');
    expect(alice.headers.get('vary')?.split(/\s*,\s*/u)).toEqual(expect.arrayContaining([
      'Accept', 'Collection-Protocol-Version', 'Authorization',
    ]));
    expect(alice.headers.get('etag')).not.toBe(bob.headers.get('etag'));

    const publicResponse = await anonymousRead(
      fixture('snapshot'),
      { representation: { cacheControl: 'public, max-age=60', vary: 'Origin' } },
    );
    expect(publicResponse.headers.get('cache-control')).toBe('public, max-age=60');
    expect(publicResponse.headers.get('vary')?.split(/\s*,\s*/u)).toEqual(expect.arrayContaining([
      'Accept', 'Collection-Protocol-Version', 'Origin',
    ]));
    expect(publicResponse.headers.get('vary')).not.toMatch(/Authorization/iu);
  });

  it(`fails closed when an authorized representation omits its principal ETag partition ${evidence}`, async () => {
    const response = await composePublicationHttpRead({
      access: 'authorized-private',
      endpoint: 'metadata',
      method: 'GET',
      rawSearch: '',
      validators: createValidatorRegistry(),
      authorize: () => ({ allowed: true, context: { principal: 'alice' } }),
      resolveRepresentation: () => representation(fixture('metadata'), {
        projectionKey: 'authorized',
      }) as never,
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('etag')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await bodyJson(response)).toMatchObject({ code: 'internal_error', status: 500 });
  });

  it(`uses no query contract for Metadata and rejects query text before authorization ${evidence}`, async () => {
    const value = fixture('metadata');
    const response = await composePublicationHttpRead({
      access: 'anonymous-public',
      endpoint: 'metadata',
      method: 'GET',
      rawSearch: '',
      validators: createValidatorRegistry(),
      resolveRepresentation: () => representation(value),
    });
    const wire = await bodyText(response.clone());
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe(createPublicationRepresentationEtag({
      representation: new TextEncoder().encode(wire),
      revision: 'revision-7',
      projectionKey: 'public',
      queryContract: 'none',
      query: {},
      negotiatedMediaType: 'application/json; charset=utf-8',
      protocolVersion: '0.1',
    }));

    const authorize = vi.fn(() => ({ allowed: true as const, context: {} }));
    const resolveRepresentation = vi.fn(() => representation(value, { principalScope: 'alice' }));
    const rejected = await composePublicationHttpRead({
      access: 'authorized-private',
      endpoint: 'metadata',
      method: 'GET',
      rawSearch: '?limit=1',
      validators: createValidatorRegistry(),
      authorize,
      resolveRepresentation,
    });
    expect(rejected.status).toBe(400);
    expect(await bodyJson(rejected)).toMatchObject({ code: 'invalid_query' });
    expect(authorize).not.toHaveBeenCalled();
    expect(resolveRepresentation).not.toHaveBeenCalled();
  });

  it(`binds Directory validators to decoded query meaning, not raw parameter order ${evidence}`, async () => {
    async function directory(rawSearch: string): Promise<Response> {
      return composePublicationHttpRead({
        access: 'anonymous-public',
        endpoint: 'directory',
        method: 'GET',
        rawSearch,
        validators: createValidatorRegistry(),
        resolveRepresentation: () => representation(fixture('directory')),
      });
    }

    const canonical = await directory('?limit=2&q=knowledge');
    const reordered = await directory('?q=knowledge&limit=2');
    const changed = await directory('?limit=2&q=different');
    expect(canonical.status).toBe(200);
    expect(reordered.status).toBe(200);
    expect(changed.status).toBe(200);
    expect(reordered.headers.get('etag')).toBe(canonical.headers.get('etag'));
    expect(changed.headers.get('etag')).not.toBe(canonical.headers.get('etag'));
  });

  it(`folds query, media, version, page and principal into the selected representation ETag ${evidence}`, async () => {
    const value = fixture('snapshot');
    const base = await anonymousRead(value);
    const changedQuery = await anonymousRead(value, { rawSearch: '?root=root_2&depth=2&include=annotations' });
    const changedMedia = await anonymousRead(value, {
      representation: { negotiatedMediaType: 'application/vnd.collection.snapshot+json; charset=utf-8' },
    });
    const changedVersion = await anonymousRead(value, {
      representation: { protocolVersion: '0.2' },
    });
    const changedPage = await anonymousRead(value, {
      representation: { pageIdentity: { pageNumber: 2 } },
    });
    const tags = [base, changedQuery, changedMedia, changedVersion, changedPage]
      .map((response) => response.headers.get('etag'));
    expect(new Set(tags).size).toBe(tags.length);
  });

  it(`uses weak If-None-Match comparison and preserves representation headers on HEAD and 304 ${evidence}`, async () => {
    const value = fixture('snapshot');
    const get = await anonymousRead(value, {
      representation: { headers: { Link: '</next>; rel="next"', 'Cache-Control': 'public, max-age=90' } },
    });
    const etag = get.headers.get('etag');
    expect(etag).not.toBeNull();
    const getWire = await bodyText(get.clone());

    const head = await anonymousRead(value, {
      method: 'HEAD',
      representation: { headers: { Link: '</next>; rel="next"', 'Cache-Control': 'public, max-age=90' } },
    });
    const notModified = await anonymousRead(value, {
      ifNoneMatch: `W/${etag}`,
      representation: { headers: { Link: '</next>; rel="next"', 'Cache-Control': 'public, max-age=90' } },
    });

    expect(head.status).toBe(200);
    expect(notModified.status).toBe(304);
    expect(await bodyText(head)).toBe('');
    expect(await bodyText(notModified)).toBe('');
    for (const response of [head, notModified]) {
      expect(response.headers.get('etag')).toBe(etag);
      expect(response.headers.get('content-length')).toBe(String(new TextEncoder().encode(getWire).byteLength));
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(response.headers.get('link')).toBe('</next>; rel="next"');
      expect(response.headers.get('last-modified')).toBe(get.headers.get('last-modified'));
    }
  });

  it(`owns representation metadata headers while merging every Vary source ${evidence}`, async () => {
    const response = await anonymousRead(fixture('snapshot'), {
      representation: {
        headers: {
          'Cache-Control': 'private, max-age=999',
          'Content-Length': '1',
          'Content-Type': 'text/plain',
          ETag: '"caller-controlled"',
          'Last-Modified': 'Thu, 01 Jan 1970 00:00:00 GMT',
          Link: '</next>; rel="next"',
          Vary: 'X-Tenant',
        },
        cacheControl: 'public, max-age=60',
        vary: ['Origin', 'X-Tenant'],
      },
    });
    const wire = await bodyText(response.clone());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    expect(response.headers.get('content-length')).toBe(String(new TextEncoder().encode(wire).byteLength));
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('etag')).toMatch(/^"pub\.r1\.[A-Za-z0-9_-]{43}"$/u);
    expect(response.headers.get('etag')).not.toBe('"caller-controlled"');
    expect(response.headers.get('last-modified')).toBe(lastModified.toUTCString());
    expect(response.headers.get('link')).toBe('</next>; rel="next"');
    expect(response.headers.get('vary')?.split(/\s*,\s*/u)).toEqual([
      'Accept', 'Collection-Protocol-Version', 'X-Tenant', 'Origin',
    ]);

    const authorized = await composePublicationHttpRead({
      access: 'authorized-private',
      endpoint: 'metadata',
      method: 'GET',
      rawSearch: '',
      validators: createValidatorRegistry(),
      authorize: () => ({ allowed: true, context: {} }),
      resolveRepresentation: () => representation(fixture('metadata'), {
        principalScope: 'alice',
        headers: { 'Cache-Control': 'public, max-age=999', Vary: 'X-Tenant' },
      }),
    });
    expect(authorized.headers.get('cache-control')).toBe('private, no-store');
    expect(authorized.headers.get('vary')?.split(/\s*,\s*/u)).toEqual([
      'Accept', 'Collection-Protocol-Version', 'X-Tenant', 'Authorization',
    ]);
  });

  it(`rejects an anonymous principal partition at runtime after type-level prevention ${evidence}`, async () => {
    const response = await composePublicationHttpRead({
      access: 'anonymous-public',
      endpoint: 'metadata',
      method: 'GET',
      rawSearch: '',
      validators: createValidatorRegistry(),
      resolveRepresentation: () => representation(fixture('metadata'), { principalScope: 'alice' }) as never,
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('etag')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it(`does not leak projection failures or emit pre-projection validators ${evidence}`, async () => {
    const accessorRead = vi.fn(() => secret);
    const accessor = Object.defineProperty({ title: 'safe' }, 'privateValue', {
      enumerable: true,
      get: accessorRead,
    });
    const proxyOwnKeys = vi.fn((): never => {
      throw new Error(secret);
    });
    const proxy = new Proxy({ title: secret }, {
      ownKeys: proxyOwnKeys,
    });

    for (const unsafe of [accessor, proxy]) {
      const response = await anonymousRead(unsafe);
      expect(response.status).toBe(500);
      expect(response.headers.get('etag')).toBeNull();
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      expect(await bodyJson(response.clone())).toMatchObject({ code: 'internal_error', status: 500 });
      expect(await response.text()).not.toContain(secret);
    }
    expect(accessorRead).not.toHaveBeenCalled();
    expect(proxyOwnKeys).not.toHaveBeenCalled();
  });

  it(`validates endpoint-specific wire shape after generic projection ${evidence}`, async () => {
    const malformed = fixture('snapshot');
    malformed.attachments = { visibility: 'public' };
    const response = await anonymousRead(malformed);

    expect(response.status).toBe(500);
    expect(response.headers.get('etag')).toBeNull();
    expect(await bodyJson(response)).toMatchObject({ code: 'internal_error', status: 500 });

    const manifest = fixture('manifest');
    const validManifest = await anonymousRead(manifest, { endpoint: 'manifest', rawSearch: '' });
    expect(validManifest.status).toBe(200);
    expect(await bodyJson(validManifest)).toEqual(manifest);
  });

  it(`keeps the canonical response schema authoritative over a permissive validator wrapper ${evidence}`, async () => {
    const canonical = createValidatorRegistry();
    const permissive = {
      definitionNames: canonical.definitionNames,
      get: canonical.get,
      validate: vi.fn(() => ({ valid: true as const, errors: [] as const })),
    };
    const response = await composePublicationHttpRead({
      access: 'anonymous-public',
      endpoint: 'manifest',
      method: 'GET',
      rawSearch: '',
      validators: permissive,
      resolveRepresentation: () => representation({ invalid: true }),
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('etag')).toBeNull();
    expect(permissive.validate).not.toHaveBeenCalled();
  });

  it(`rejects nested Proxy representation data and options without invoking traps ${evidence}`, async () => {
    const getPrototypeOf = vi.fn((): never => { throw new Error(secret); });
    const publicValue = fixture('snapshot');
    (publicValue.collection as Record<string, unknown>).nested = new Proxy({}, { getPrototypeOf });
    const publicResponse = await anonymousRead(publicValue);
    expect(publicResponse.status).toBe(500);

    const authorizedValue = fixture('metadata');
    (authorizedValue.collection as Record<string, unknown>).nested = new Proxy({}, { getPrototypeOf });
    const authorizedResponse = await composePublicationHttpRead({
      access: 'authorized-private',
      endpoint: 'metadata',
      method: 'GET',
      rawSearch: '',
      validators: createValidatorRegistry(),
      authorize: () => ({ allowed: true, context: {} }),
      resolveRepresentation: () => representation(authorizedValue, { principalScope: 'alice' }),
    });
    expect(authorizedResponse.status).toBe(500);

    const headerTrap = vi.fn((): never => { throw new Error(secret); });
    const headers = new Proxy({ Link: '</next>; rel="next"' }, { ownKeys: headerTrap });
    const headerResponse = await anonymousRead(fixture('snapshot'), { representation: { headers } });
    expect(headerResponse.status).toBe(500);
    expect(getPrototypeOf).not.toHaveBeenCalled();
    expect(headerTrap).not.toHaveBeenCalled();
  });

  it(`rejects hostile top-level accessors and proxies without invoking callbacks or reflecting traps ${evidence}`, async () => {
    const resolveRepresentation = vi.fn(() => representation({ visible: true }));
    const validInput = {
      access: 'anonymous-public' as const,
      endpoint: 'manifest' as const,
      method: 'GET' as const,
      rawSearch: '',
      validators: createValidatorRegistry(),
      resolveRepresentation,
    };
    const accessorInput = Object.defineProperty({ ...validInput }, 'endpoint', {
      enumerable: true,
      get: () => {
        throw new Error(secret);
      },
    });
    const proxyInput = new Proxy(validInput, {
      get: (target, property, receiver) => {
        if (property === 'endpoint') throw new Error(secret);
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const inheritedRead = vi.fn(() => 'manifest');
    const inheritedInput = Object.assign(
      Object.create(Object.defineProperty({}, 'endpoint', { get: inheritedRead })),
      Object.fromEntries(Object.entries(validInput).filter(([key]) => key !== 'endpoint')),
    ) as typeof validInput;

    for (const hostile of [accessorInput, proxyInput, inheritedInput]) {
      let rejection: unknown;
      try {
        await composePublicationHttpRead(hostile as never);
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(TypeError);
      expect(String(rejection)).not.toContain(secret);
    }
    expect(inheritedRead).not.toHaveBeenCalled();
    expect(resolveRepresentation).not.toHaveBeenCalled();
  });

  it(`lets adapter callback failures propagate instead of disguising programming errors as HTTP 500 ${evidence}`, async () => {
    await expect(composePublicationHttpRead({
      access: 'anonymous-public',
      endpoint: 'manifest',
      method: 'GET',
      rawSearch: '',
      validators: createValidatorRegistry(),
      resolveRepresentation: () => {
        throw new Error('resolver failed');
      },
    })).rejects.toThrow('resolver failed');
  });

  it(`detaches resolved input without replacing the process fetch implementation ${evidence}`, async () => {
    const originalFetch = globalThis.fetch;
    const source = fixture('snapshot');
    const collection = source.collection as Record<string, unknown>;
    const originalTitle = collection.title;
    const response = await anonymousRead(source);
    collection.title = 'after';

    expect((await bodyJson(response)).collection).toEqual(expect.objectContaining({ title: originalTitle }));
    expect(globalThis.fetch).toBe(originalFetch);
  });
});
