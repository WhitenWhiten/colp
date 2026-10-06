import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  declarePublicationEndpoints,
  declarePublicationStaticEndpoints,
  snapshotPublicationStaticEndpoints,
} from '../../src/server/index.js';
import { resolvePublicationEndpoint } from '../../src/client/publication-endpoints.js';
import { createPublicationTransportBoundary } from '../../src/client/publication-transport-boundary.js';
import type { ManifestMount } from '../../src/types/index.js';

const evidence = '[evidence:manifest.static-endpoint-declarations]';
const fixture = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples', 'public-manifest.json');
type Mutable = Record<string, any>;

function mount(overrides: Partial<Mutable> = {}): ManifestMount {
  const source = JSON.parse(readFileSync(fixture, 'utf8')) as Mutable;
  const value = source.mounts[0] as Mutable;
  value.id = 'static-publication';
  value.profiles = ['core', 'publication'];
  delete (value.endpoints as Mutable).instanceFeed;
  delete (value.endpoints as Mutable).collectionFeed;
  delete value.features.feed;
  value.baseUrl = 'https://boundary.example/base/';
  Object.assign(value, overrides);
  return value as ManifestMount;
}

function endpointMap(value: ManifestMount) {
  return Object.fromEntries(declarePublicationEndpoints(value).map((entry) => [entry.endpoint, entry]));
}
function endpointRecord(value: ManifestMount): Mutable {
  return value.endpoints as unknown as Mutable;
}

function staticMount(): ManifestMount {
  const value = mount();
  endpointRecord(value).directory = 'https://static.example/collections/index.json';
  endpointRecord(value).collection = 'https://static.example/collections/items/{collectionId}/index.json';
  endpointRecord(value).snapshot = 'https://static.example/collections/items/{collectionId}/snapshot.json';
  return value;
}

describe(`PUB-0037 static Manifest endpoint declarations ${evidence}`, () => {
  it(`snapshots the exact static directory, collection, and snapshot file URLs ${evidence}`, () => {
    const snapshot = snapshotPublicationStaticEndpoints(staticMount());
    expect(snapshot.mountId).toBe('static-publication');
    expect(snapshot.declarations.map(({ endpoint, template, variables }) => ({ endpoint, template, variables }))).toEqual([
      { endpoint: 'directory', template: 'https://static.example/collections/index.json', variables: [] },
      { endpoint: 'collection', template: 'https://static.example/collections/items/{collectionId}/index.json', variables: ['collectionId'] },
      { endpoint: 'snapshot', template: 'https://static.example/collections/items/{collectionId}/snapshot.json', variables: ['collectionId'] },
    ]);
  });

  it.each([
    ['missing', undefined],
    ['relative', '/collections/index.json'],
    ['baseUrl-relative', 'collections/index.json'],
    ['arbitrary path', 'https://static.example/other.json'],
    ['query', 'https://static.example/collections/index.json?private=1'],
    ['fragment', 'https://static.example/collections/index.json#x'],
    ['userinfo', 'https://user:pass@static.example/collections/index.json'],
    ['non-loopback HTTP', 'http://static.example/collections/index.json'],
    ['encoded path', 'https://static.example/collections/%69ndex.json'],
  ] as const)(`rejects a %s static declaration ${evidence}`, (_label, value) => {
    const candidate = staticMount();
    if (value === undefined) delete endpointRecord(candidate).directory;
    else endpointRecord(candidate).directory = value;
    expect(() => snapshotPublicationStaticEndpoints(candidate)).toThrow(TypeError);
  });

  it(`supports optional instance and collection Feed files only as a pair ${evidence}`, () => {
    const candidate = staticMount();
    candidate.profiles = ['core', 'publication', 'feed'];
    endpointRecord(candidate).instanceFeed = 'https://static.example/collections/-/feed.json';
    endpointRecord(candidate).collectionFeed = 'https://static.example/collections/items/{collectionId}/feed.json';
    candidate.features.feed = { modes: ['live'] };
    const snapshot = snapshotPublicationStaticEndpoints(candidate);
    expect(snapshot.feed.map(({ endpoint, template, variables }) => ({ endpoint, template, variables }))).toEqual([
      { endpoint: 'instanceFeed', template: 'https://static.example/collections/-/feed.json', variables: [] },
      { endpoint: 'collectionFeed', template: 'https://static.example/collections/items/{collectionId}/feed.json', variables: ['collectionId'] },
    ]);
    delete endpointRecord(candidate).collectionFeed;
    expect(() => snapshotPublicationStaticEndpoints(candidate)).toThrow(TypeError);

    const unclaimed = staticMount();
    endpointRecord(unclaimed).instanceFeed = 'https://static.example/collections/-/feed.json';
    endpointRecord(unclaimed).collectionFeed = 'https://static.example/collections/items/{collectionId}/feed.json';
    unclaimed.features.feed = { modes: ['live'] };
    expect(() => snapshotPublicationStaticEndpoints(unclaimed)).toThrow(TypeError);

    const missing = staticMount();
    missing.profiles = ['core', 'publication', 'feed'];
    missing.features.feed = { modes: ['live'] };
    expect(() => snapshotPublicationStaticEndpoints(missing)).toThrow(TypeError);

    const featureless = staticMount();
    featureless.profiles = ['core', 'publication', 'feed'];
    endpointRecord(featureless).instanceFeed = 'https://static.example/collections/-/feed.json';
    endpointRecord(featureless).collectionFeed = 'https://static.example/collections/items/{collectionId}/feed.json';
    expect(() => snapshotPublicationStaticEndpoints(featureless)).toThrow(TypeError);
  });

  it(`detaches and freezes snapshots and rejects hostile containers without reflection ${evidence}`, () => {
    const candidate = staticMount();
    const snapshot = snapshotPublicationStaticEndpoints(candidate);
    endpointRecord(candidate).directory = 'https://changed.example/other.json';
    expect(snapshot.declarations[0]?.template).toBe('https://static.example/collections/index.json');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.declarations)).toBe(true);
    const secret = 'private-static-endpoint-secret';
    const hostile = staticMount();
    Object.defineProperty(hostile.endpoints, 'directory', { enumerable: true, get: () => { throw new Error(secret); } });
    let error: unknown;
    try { snapshotPublicationStaticEndpoints(hostile); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).not.toContain(secret);
  });

  it(`requires exact directory, collection, and snapshot declarations with Registry variables ${evidence}`, () => {
    const entries = declarePublicationEndpoints(mount({
      endpoints: {
        ...mount().endpoints,
        directory: 'https://declared.example/directory.json',
        collection: 'https://declared.example/c/{collectionId}.json',
        snapshot: 'https://declared.example/s/{collectionId}.json',
      } as unknown as ManifestMount['endpoints'],
    }));
    expect(entries.map(({ endpoint }) => endpoint)).toEqual(['directory', 'collection', 'snapshot']);
    expect(entries.map(({ variables }) => variables)).toEqual([[], ['collectionId'], ['collectionId']]);
  });

  it(`accepts HTTPS and exact loopback HTTP and expands Level-1 variables ${evidence}`, () => {
    const value = mount({ baseUrl: 'http://127.0.0.1:8787/', endpoints: {
      ...mount().endpoints,
      directory: 'http://127.0.0.1:8787/directory',
      collection: 'https://declared.example/c/{collectionId}',
      snapshot: 'http://localhost/s/{collectionId}',
    } });
    expect(resolvePublicationEndpoint(value, 'directory', {}, createPublicationTransportBoundary(value))).toEqual(new URL('http://127.0.0.1:8787/directory'));
    expect(resolvePublicationEndpoint(value, 'collection', { collectionId: 'opaque-42' })).toEqual(new URL('https://declared.example/c/opaque-42'));
  });

  it.each([
    ['missing endpoint', undefined],
    ['relative', 'https://declared.example/{collectionId}'],
    ['baseUrl-relative', '/collections/{collectionId}'],
    ['arbitrary path', 'https://declared.example/collections/{nodeId}'],
    ['fragment', 'https://declared.example/c/{collectionId}#private'],
    ['userinfo', 'https://user:pass@declared.example/c/{collectionId}'],
    ['unsafe operator', 'https://declared.example/c/{+collectionId}'],
    ['duplicate variable', 'https://declared.example/c/{collectionId}/{collectionId}'],
    ['host variable', 'https://{collectionId}.declared.example/c'],
    ['non-loopback HTTP', 'http://declared.example/c/{collectionId}'],
    ['encoded variable', 'https://declared.example/c/%7BcollectionId%7D'],
  ] as const)(`rejects %s without reflecting hostile text ${evidence}`, (_label, source: string | undefined) => {
    const value = mount();
    if (source === undefined) delete endpointRecord(value).directory;
    else endpointRecord(value).collection = source;
    const secret = 'private-static-endpoint-secret';
    let error: unknown;
    try { snapshotPublicationStaticEndpoints(value); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(secret);
  });

  it(`keeps optional feed endpoints coherent with core/publication/feed profiles ${evidence}`, () => {
    const value = mount({ profiles: ['core', 'publication', 'feed'], endpoints: {
      ...mount().endpoints,
      instanceFeed: 'https://feed.example/instance',
      collectionFeed: 'https://feed.example/c/{collectionId}',
    } as unknown as ManifestMount['endpoints'], features: { ...mount().features, feed: { modes: ['live'] } } });
    expect(endpointMap(value).directory?.template).toContain('alice.example');
    expect(Object.keys(value.endpoints)).toContain('instanceFeed');
    expect(() => declarePublicationEndpoints(mount({ profiles: ['core', 'publication', 'feed'] }))).not.toThrow();
  });

  it(`isolates multiple Mount declarations and does not infer routes from baseUrl ${evidence}`, () => {
    const first = staticMount();
    first.id = 'first';
    (first as Mutable).baseUrl = 'https://one.example/root/';
    endpointRecord(first).directory = 'https://declared-one.example/collections/index.json';
    const second = staticMount();
    second.id = 'second';
    (second as Mutable).baseUrl = 'https://two.example/root/';
    endpointRecord(second).directory = 'https://declared-two.example/collections/index.json';
    expect(snapshotPublicationStaticEndpoints(first).mountId).toBe('first');
    expect(snapshotPublicationStaticEndpoints(second).mountId).toBe('second');
    expect(resolvePublicationEndpoint(first, 'directory', {}).href).toBe('https://declared-one.example/collections/index.json');
    expect(resolvePublicationEndpoint(second, 'directory', {}).href).toBe('https://declared-two.example/collections/index.json');
    expect(resolvePublicationEndpoint(first, 'directory', {}).href).not.toContain('/root/');
  });

  it(`returns detached frozen endpoint contracts ${evidence}`, () => {
    const entries = declarePublicationStaticEndpoints(staticMount());
    expect(Object.isFrozen(entries)).toBe(true);
    expect(Object.isFrozen(entries[0])).toBe(true);
    const source = staticMount();
    const snapshot = declarePublicationStaticEndpoints(source);
    endpointRecord(source).directory = 'https://changed.example/new';
    expect(snapshot[0]?.template).toBe('https://static.example/collections/index.json');
    expect(() => (snapshot as any).push('x')).toThrow(TypeError);
  });

  it(`rejects accessor, Proxy, cycle, symbol, sparse, and non-object declarations ${evidence}`, () => {
    const accessor = mount();
    Object.defineProperty(accessor.endpoints, 'directory', { get: () => { throw new Error('secret'); } });
    expect(() => declarePublicationEndpoints(accessor)).toThrow();
    const proxy = new Proxy(mount(), { get() { throw new Error('private-proxy'); } });
    expect(() => declarePublicationEndpoints(proxy)).toThrow();
    const cyclic = mount();
    (cyclic.endpoints as Mutable).cycle = cyclic.endpoints;
    expect(() => declarePublicationEndpoints(cyclic)).not.toThrow();
    const symbols = mount();
    (symbols.endpoints as any)[Symbol('private')] = true;
    expect(() => declarePublicationEndpoints(symbols)).not.toThrow();
    const sparse = mount();
    (sparse.profiles as any[]).length = 2;
    delete (sparse.profiles as any[])[1];
    expect(() => declarePublicationEndpoints(sparse)).toThrow();
  });
});
