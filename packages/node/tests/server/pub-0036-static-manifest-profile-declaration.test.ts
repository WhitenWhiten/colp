import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { supportedProfiles } from '../../src/index.js';
import {
  MAX_PUBLICATION_STATIC_MANIFEST_BYTES,
  MAX_PUBLICATION_STATIC_MANIFEST_DEPTH,
  MAX_PUBLICATION_STATIC_MANIFEST_VALUES,
  PUBLICATION_MANIFEST_DISCOVERY_PATH,
  createPublicationManifestDiscoveryHandler,
  snapshotPublicationStaticManifestProfiles,
  type PublicationManifestDiscoveryResponse,
} from '../../src/server/index.js';

const evidence = '[evidence:manifest.static-profile-declaration]';
const fixturePath = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'protocol',
  'examples',
  'public-manifest.json',
);
const evidencePath = resolve(
  import.meta.dirname,
  '..',
  '..',
  'src',
  'conformance',
  'generated',
  'evidence.json',
);

type JsonRecord = Record<string, any>;

function staticMount(feed = false): JsonRecord {
  const source = JSON.parse(readFileSync(fixturePath, 'utf8')) as JsonRecord;
  const mount = source.mounts[0] as JsonRecord;
  mount.id = feed ? 'with-feed' : 'publication-only';
  mount.profiles = feed ? ['core', 'publication', 'feed'] : ['core', 'publication'];
  if (feed) {
    mount.endpoints.instanceFeed = 'https://alice.example/collections/-/feed';
    mount.endpoints.collectionFeed = 'https://alice.example/collections/c/{collectionId}/feed';
    mount.features.feed = { modes: ['live', 'release'] };
  } else {
    delete mount.endpoints.instanceFeed;
    delete mount.endpoints.collectionFeed;
    delete mount.features.feed;
  }
  return mount;
}

function staticManifest(...mounts: JsonRecord[]): JsonRecord {
  const source = JSON.parse(readFileSync(fixturePath, 'utf8')) as JsonRecord;
  source.mounts = mounts.length === 0 ? [staticMount()] : mounts;
  return source;
}

function expectInvalid(work: () => unknown): TypeError {
  let rejection: unknown;
  try {
    work();
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(TypeError);
  expect((rejection as Error).message).toBe(
    'Static Publication Manifest profile declarations are invalid.',
  );
  return rejection as TypeError;
}

function expectLimit(work: () => unknown): RangeError {
  let rejection: unknown;
  try {
    work();
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(RangeError);
  expect((rejection as Error).message).toBe(
    'Static Publication Manifest profile declaration resource limit exceeded.',
  );
  return rejection as RangeError;
}

function requireResponse(
  response: PublicationManifestDiscoveryResponse | null,
): PublicationManifestDiscoveryResponse {
  expect(response).not.toBeNull();
  return response!;
}

describe(`PUB-0036 static Manifest profile declaration ${evidence}`, () => {
  it(`requires exactly core then publication when no Feed is offered ${evidence}`, () => {
    expect(snapshotPublicationStaticManifestProfiles(staticManifest()).declarations).toEqual([{
      mountId: 'publication-only', profiles: ['core', 'publication'], feed: null,
    }]);
  });

  it(`requires exactly core, publication, feed for coherent static Feed files ${evidence}`, () => {
    expect(snapshotPublicationStaticManifestProfiles(staticManifest(staticMount(true))).declarations)
      .toEqual([{
        mountId: 'with-feed',
        profiles: ['core', 'publication', 'feed'],
        feed: {
          instanceFeed: 'https://alice.example/collections/-/feed',
          collectionFeed: 'https://alice.example/collections/c/{collectionId}/feed',
          feature: { modes: ['live', 'release'] },
        },
      }]);
  });

  it.each([
    ['instanceFeed endpoint', (mount: JsonRecord) => {
      mount.endpoints.instanceFeed = 'https://static.example/feed.json';
    }],
    ['collectionFeed endpoint', (mount: JsonRecord) => {
      mount.endpoints.collectionFeed = 'https://static.example/c/{collectionId}/feed.json';
    }],
    ['feed feature', (mount: JsonRecord) => {
      mount.features.feed = { modes: ['release'] };
    }],
  ] as const)(`rejects a %s provision signal without the feed claim ${evidence}`, (_label, offer) => {
    const mount = staticMount();
    offer(mount);
    expectInvalid(() => snapshotPublicationStaticManifestProfiles(staticManifest(mount)));
  });

  it.each([
    ['instanceFeed endpoint', (mount: JsonRecord) => delete mount.endpoints.instanceFeed],
    ['collectionFeed endpoint', (mount: JsonRecord) => delete mount.endpoints.collectionFeed],
    ['feed feature', (mount: JsonRecord) => delete mount.features.feed],
  ] as const)(`rejects a feed claim missing its %s ${evidence}`, (_label, remove) => {
    const mount = staticMount(true);
    remove(mount);
    expectInvalid(() => snapshotPublicationStaticManifestProfiles(staticManifest(mount)));
  });

  it.each([
    ['an extra profile', ['core', 'publication', 'feed']],
    ['reordered profiles', ['publication', 'core']],
    ['a duplicate profile', ['core', 'publication', 'publication']],
    ['case variation', ['core', 'Publication']],
    ['legacy reader', ['core', 'publication', 'reader']],
    ['legacy sync-server', ['core', 'publication', 'sync-server']],
    ['legacy mcp-server', ['core', 'publication', 'mcp-server']],
    ['publisher', ['core', 'publication', 'publisher']],
    ['sync', ['core', 'publication', 'sync']],
    ['mcp-read', ['core', 'publication', 'mcp-read']],
    ['mcp-write', ['core', 'publication', 'mcp-write']],
    ['empty profiles', []],
  ] as const)(`rejects no-Feed static mode with %s ${evidence}`, (_label, profiles) => {
    const mount = staticMount();
    mount.profiles = [...profiles];
    expectInvalid(() => snapshotPublicationStaticManifestProfiles(staticManifest(mount)));
  });

  it.each([
    ['reordered profiles', ['core', 'feed', 'publication']],
    ['duplicate feed', ['core', 'publication', 'feed', 'feed']],
    ['case variation', ['core', 'publication', 'Feed']],
    ['publisher', ['core', 'publication', 'feed', 'publisher']],
    ['sync', ['core', 'publication', 'feed', 'sync']],
    ['MCP', ['core', 'publication', 'feed', 'mcp-read']],
  ] as const)(`rejects Feed static mode with %s ${evidence}`, (_label, profiles) => {
    const mount = staticMount(true);
    mount.profiles = [...profiles];
    expectInvalid(() => snapshotPublicationStaticManifestProfiles(staticManifest(mount)));
  });

  it(`keeps each Mount independent when static Feed support differs ${evidence}`, () => {
    const first = staticMount();
    const second = staticMount(true);
    first.id = 'first';
    second.id = 'second';
    second.baseUrl = 'https://feed.example/';

    expect(snapshotPublicationStaticManifestProfiles(staticManifest(first, second)).declarations
      .map((declaration) => declaration.profiles)).toEqual([
        ['core', 'publication'],
        ['core', 'publication', 'feed'],
      ]);

    first.endpoints.instanceFeed = 'https://first.example/feed.json';
    expectInvalid(() => snapshotPublicationStaticManifestProfiles(staticManifest(first, second)));
  });

  it(`isolates explicitly selected static Mounts from general Mounts ${evidence}`, () => {
    const general = staticMount();
    general.id = 'general';
    general.profiles = ['core', 'publication', 'publisher'];
    const selected = staticMount(true);
    selected.id = 'selected-static';
    const source = staticManifest(general, selected);

    expectInvalid(() => snapshotPublicationStaticManifestProfiles(source));
    const snapshot = snapshotPublicationStaticManifestProfiles(source, ['selected-static']);
    expect(snapshot.declarations.map((declaration) => declaration.mountId)).toEqual([
      'selected-static',
    ]);
    expect(snapshot.unverifiedCanonicalCandidate.mounts).toHaveLength(2);
  });

  it(`captures detached recursively frozen profile snapshots ${evidence}`, () => {
    const source = staticManifest(staticMount(), staticMount(true));
    const snapshot = snapshotPublicationStaticManifestProfiles(source);
    const profiles = snapshot.declarations.map((declaration) => declaration.profiles);
    source.mounts[0].profiles[0] = 'mutated';
    source.mounts[1].profiles.push('publisher');

    expect(profiles).toEqual([
      ['core', 'publication'],
      ['core', 'publication', 'feed'],
    ]);
    expect(profiles[0]).not.toBe(source.mounts[0].profiles);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.declarations)).toBe(true);
    expect(Object.isFrozen(snapshot.unverifiedCanonicalCandidate)).toBe(true);
    expect(Object.isFrozen(profiles[0])).toBe(true);
    expect(Object.isFrozen(profiles[1])).toBe(true);
    expect(() => (profiles[0] as unknown as string[]).push('feed')).toThrow(TypeError);
    expect(snapshot.unverifiedCanonicalCandidate.mounts[0]!.profiles).toEqual([
      'core', 'publication',
    ]);
  });

  it(`labels the canonical Manifest only as an unverified candidate ${evidence}`, () => {
    const snapshot = snapshotPublicationStaticManifestProfiles(staticManifest());
    expect(snapshot).toHaveProperty('unverifiedCanonicalCandidate');
    expect(snapshot).not.toHaveProperty('canonicalCandidate');
    expect(snapshot).not.toHaveProperty('verifiedProfileClaims');
  });

  it(`rejects missing, duplicate, empty, and malformed Mount selections ${evidence}`, () => {
    const source = staticManifest(staticMount(), staticMount(true));
    expectInvalid(() => snapshotPublicationStaticManifestProfiles(source, []));
    expectInvalid(() => snapshotPublicationStaticManifestProfiles(source, ['missing']));
    expectInvalid(() => snapshotPublicationStaticManifestProfiles(
      source,
      ['publication-only', 'publication-only'],
    ));
    expectInvalid(() => snapshotPublicationStaticManifestProfiles(source, 'publication-only'));
    expectInvalid(() => snapshotPublicationStaticManifestProfiles(source, [42]));
    expectInvalid(() => snapshotPublicationStaticManifestProfiles(source, ['bad\u0000id']));
    expectInvalid(() => snapshotPublicationStaticManifestProfiles(source, ['\ud800']));
  });

  it(`accepts reordered selection while preserving canonical Mount order ${evidence}`, () => {
    const first = staticMount();
    const second = staticMount(true);
    first.id = 'first';
    second.id = 'second';
    const selected = ['second', 'first'];
    const snapshot = snapshotPublicationStaticManifestProfiles(
      staticManifest(first, second),
      selected,
    );
    selected.reverse();
    expect(snapshot.declarations.map(({ mountId }) => mountId)).toEqual(['first', 'second']);
  });

  it(`rejects hostile Mount selection containers without invoking code ${evidence}`, () => {
    const source = staticManifest();
    const accessorSelection = ['publication-only'];
    let reads = 0;
    Object.defineProperty(accessorSelection, '0', {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('private-selection-accessor');
      },
    });
    expectInvalid(() => snapshotPublicationStaticManifestProfiles(source, accessorSelection));
    expect(reads).toBe(0);

    let traps = 0;
    const proxySelection = new Proxy(['publication-only'], {
      get() { traps += 1; throw new Error('private-selection-proxy'); },
      getPrototypeOf() { traps += 1; throw new Error('private-selection-proxy'); },
      ownKeys() { traps += 1; throw new Error('private-selection-proxy'); },
    });
    expectInvalid(() => snapshotPublicationStaticManifestProfiles(source, proxySelection));
    expect(traps).toBe(0);
  });

  it(`rejects sparse and symbol-bearing Mount selections ${evidence}`, () => {
    const source = staticManifest();
    const sparse = ['publication-only'];
    delete sparse[0];
    expectInvalid(() => snapshotPublicationStaticManifestProfiles(source, sparse));

    const symbolBearing = ['publication-only'];
    (symbolBearing as unknown as Record<symbol, boolean>)[Symbol('private')] = true;
    expectInvalid(() => snapshotPublicationStaticManifestProfiles(source, symbolBearing));
  });

  it(`bounds Mount selection count and UTF-8 bytes ${evidence}`, () => {
    const source = staticManifest();
    expectLimit(() => snapshotPublicationStaticManifestProfiles(
      source,
      Array.from({ length: MAX_PUBLICATION_STATIC_MANIFEST_VALUES + 1 }, () => 'x'),
    ));
    expectLimit(() => snapshotPublicationStaticManifestProfiles(
      source,
      ['x'.repeat(MAX_PUBLICATION_STATIC_MANIFEST_BYTES + 1)],
    ));
  });

  it.each(['profiles', 'endpoints', 'features'] as const)(
    `rejects an accessor-backed %s without invoking it ${evidence}`,
    (field) => {
      const mount = staticMount();
      let reads = 0;
      Object.defineProperty(mount, field, {
        enumerable: true,
        get() {
          reads += 1;
          throw new Error(`private-accessor-${field}`);
        },
      });
      expectInvalid(() => snapshotPublicationStaticManifestProfiles(staticManifest(mount)));
      expect(reads).toBe(0);
    },
  );

  it(`rejects a nested Feed accessor without invoking it ${evidence}`, () => {
    const mount = staticMount(true);
    let reads = 0;
    Object.defineProperty(mount.features.feed, 'modes', {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('private-feed-modes');
      },
    });
    expectInvalid(() => snapshotPublicationStaticManifestProfiles(staticManifest(mount)));
    expect(reads).toBe(0);
  });

  it.each(['mount', 'profiles', 'endpoints', 'features'] as const)(
    `rejects a Proxy-backed %s without invoking traps ${evidence}`,
    (field) => {
      const mount = staticMount();
      let trapCalls = 0;
      const target = field === 'mount' ? mount : mount[field] as object;
      const proxy = new Proxy(target, {
        get() {
          trapCalls += 1;
          throw new Error(`private-proxy-${field}`);
        },
        getOwnPropertyDescriptor() {
          trapCalls += 1;
          throw new Error(`private-proxy-${field}`);
        },
        getPrototypeOf() {
          trapCalls += 1;
          throw new Error(`private-proxy-${field}`);
        },
        ownKeys() {
          trapCalls += 1;
          throw new Error(`private-proxy-${field}`);
        },
      });
      if (field === 'mount') {
        expectInvalid(() => snapshotPublicationStaticManifestProfiles({ mounts: [proxy] }));
      } else {
        mount[field] = proxy;
        expectInvalid(() => snapshotPublicationStaticManifestProfiles(staticManifest(mount)));
      }
      expect(trapCalls).toBe(0);
    },
  );

  it.each([
    ['a profiles cycle', (mount: JsonRecord) => mount.profiles.push(mount.profiles)],
    ['an endpoints cycle', (mount: JsonRecord) => { mount.endpoints.self = mount.endpoints; }],
    ['a features cycle', (mount: JsonRecord) => { mount.features.self = mount.features; }],
    ['an endpoints symbol key', (mount: JsonRecord) => { mount.endpoints[Symbol('private')] = true; }],
    ['a features symbol key', (mount: JsonRecord) => { mount.features[Symbol('private')] = true; }],
    ['a sparse profiles array', (mount: JsonRecord) => { delete mount.profiles[0]; }],
  ] as const)(`rejects unsafe input containing %s ${evidence}`, (_label, mutate) => {
    const mount = staticMount();
    mutate(mount);
    expectInvalid(() => snapshotPublicationStaticManifestProfiles(staticManifest(mount)));
  });

  it(`rejects a sparse Mount array ${evidence}`, () => {
    const mounts = [staticMount(), staticMount()];
    delete mounts[0];
    const source = staticManifest();
    source.mounts = mounts;
    expectInvalid(() => snapshotPublicationStaticManifestProfiles(source));
  });

  it(`rejects shared declaration references within and across Mounts ${evidence}`, () => {
    const first = staticMount();
    const shared = { opaque: true };
    first.endpoints.vendor = shared;
    first.features.vendor = shared;
    expectInvalid(() => snapshotPublicationStaticManifestProfiles(staticManifest(first)));

    const left = staticMount();
    const right = staticMount();
    right.profiles = left.profiles;
    expectInvalid(() => snapshotPublicationStaticManifestProfiles(staticManifest(left, right)));
  });

  it(`rejects depth resource exhaustion with a stable RangeError ${evidence}`, () => {
    const deep = staticMount();
    let cursor = deep.features;
    for (let index = 0; index <= MAX_PUBLICATION_STATIC_MANIFEST_DEPTH; index += 1) {
      cursor.next = {};
      cursor = cursor.next;
    }
    expectLimit(() => snapshotPublicationStaticManifestProfiles(staticManifest(deep)));
  });

  it(`rejects value resource exhaustion with a stable RangeError ${evidence}`, () => {
    const broad = staticMount();
    broad.features.values = Array.from(
      { length: MAX_PUBLICATION_STATIC_MANIFEST_VALUES + 1 },
      () => null,
    );
    expectLimit(() => snapshotPublicationStaticManifestProfiles(staticManifest(broad)));
  });

  it(`rejects byte resource exhaustion with a stable RangeError ${evidence}`, () => {
    const oversized = staticManifest();
    oversized.title = 'x'.repeat(MAX_PUBLICATION_STATIC_MANIFEST_BYTES + 1);
    expectLimit(() => snapshotPublicationStaticManifestProfiles(oversized));
  });

  it(`normalizes hostile failures to non-reflective errors ${evidence}`, () => {
    const secret = 'must-not-reflect-static-manifest-secret';
    const mount = staticMount();
    Object.defineProperty(mount, 'profiles', {
      enumerable: true,
      get() {
        throw new Error(secret);
      },
    });
    const error = expectInvalid(
      () => snapshotPublicationStaticManifestProfiles(staticManifest(mount)),
    );
    expect(error.message).not.toContain(secret);
    expect(error).not.toHaveProperty('cause');
  });

  it(`does not narrow the existing general Manifest discovery contract ${evidence}`, () => {
    const source = JSON.parse(readFileSync(fixturePath, 'utf8')) as JsonRecord;
    const handler = createPublicationManifestDiscoveryHandler(source);
    const get = requireResponse(handler({
      method: 'GET',
      path: PUBLICATION_MANIFEST_DISCOVERY_PATH,
    }));
    const head = requireResponse(handler({
      method: 'HEAD',
      path: PUBLICATION_MANIFEST_DISCOVERY_PATH,
    }));
    expect(get.status).toBe(200);
    expect(JSON.parse(get.body!).mounts[0].profiles).toEqual(source.mounts[0].profiles);
    expect(head.status).toBe(200);
    expect(head.headers).toEqual(get.headers);
    expect(head.body).toBeNull();
  });

  it(`keeps package claims exact and bundled evidence bound ${evidence}`, () => {
    const bundled = JSON.parse(readFileSync(evidencePath, 'utf8')) as JsonRecord;
    expect(supportedProfiles).toEqual([
      'core',
      'publication',
      'publisher',
      'feed',
      'sync',
      'mcp-read',
      'mcp-write',
    ]);
    expect(bundled.schemaVersion).toBe(2);
    expect(Array.isArray(bundled.passedRequirementIds)).toBe(true);
  });
});
