import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MAX_PUBLICATION_MOUNT_DECLARATION_BYTES,
  MAX_PUBLICATION_MOUNT_DECLARATION_DEPTH,
  MAX_PUBLICATION_MOUNT_DECLARATION_VALUES,
  PUBLICATION_MANIFEST_DISCOVERY_PATH,
  createPublicationManifestDiscoveryHandler,
  handlePublicationManifestDiscoveryRequest,
  snapshotPublicationMountDeclarations,
  type PublicationManifestDiscoveryResponse,
} from '../../src/server/index.js';

const evidence = '[evidence:manifest.mount-declarations]';
const declarationFields = ['profiles', 'endpoints', 'auth', 'limits'] as const;
const fixturePath = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'protocol',
  'examples',
  'public-manifest.json',
);

type JsonRecord = Record<string, any>;

function manifest(): JsonRecord {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as JsonRecord;
}

function mount(source: JsonRecord = manifest()): JsonRecord {
  return source.mounts[0] as JsonRecord;
}

function requireResponse(
  response: PublicationManifestDiscoveryResponse | null,
): PublicationManifestDiscoveryResponse {
  expect(response).not.toBeNull();
  return response!;
}

function expectInvalid(work: () => unknown): TypeError {
  let rejection: unknown;
  try {
    work();
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(TypeError);
  expect((rejection as Error).message).toBe('Publication Manifest Mount declarations are invalid.');
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
    'Publication Manifest Mount declaration resource limit exceeded.',
  );
  return rejection as RangeError;
}

function declarationOnly(value: JsonRecord): JsonRecord {
  return { mounts: [value] };
}

function addNestedValue(target: JsonRecord, depth: number): void {
  let cursor = target;
  for (let index = 0; index < depth; index += 1) {
    const next: JsonRecord = {};
    cursor.next = next;
    cursor = next;
  }
  cursor.value = true;
}

describe(`PUB-0012 Manifest Mount declaration contract ${evidence}`, () => {
  it(`preserves every declaration from one Mount in source order ${evidence}`, () => {
    const source = manifest();
    const sourceMount = mount(source);
    const snapshots = snapshotPublicationMountDeclarations(source);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({
      profiles: sourceMount.profiles,
      endpoints: sourceMount.endpoints,
      auth: sourceMount.auth,
      limits: sourceMount.limits,
    });
    expect(Reflect.ownKeys(snapshots[0]!)).toEqual(declarationFields);
  });

  it(`preserves distinct declarations for every Mount without fallback or merging ${evidence}`, () => {
    const source = manifest();
    const first = mount(source);
    const second = structuredClone(first);
    first.profiles = ['core', 'publication'];
    first.endpoints.directory = 'https://one.example/catalog';
    first.auth.anonymousRead = true;
    first.limits.maxPageSize = 11;
    second.id = 'second';
    second.baseUrl = 'https://two.example/';
    second.profiles = ['core', 'feed'];
    second.endpoints.directory = 'https://two.example/directory';
    second.auth.anonymousRead = false;
    second.limits.maxPageSize = 22;
    source.mounts.push(second);

    const snapshots = snapshotPublicationMountDeclarations(source);
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map((entry) => entry.profiles)).toEqual([
      ['core', 'publication'],
      ['core', 'feed'],
    ]);
    expect(snapshots.map((entry) => entry.endpoints.directory)).toEqual([
      'https://one.example/catalog',
      'https://two.example/directory',
    ]);
    expect(snapshots.map((entry) => entry.auth.anonymousRead)).toEqual([true, false]);
    expect(snapshots.map((entry) => entry.limits.maxPageSize)).toEqual([11, 22]);
  });

  it(`accepts a null-prototype Mount when all declarations are own enumerable data ${evidence}`, () => {
    const sourceMount = mount();
    const nullPrototypeMount = Object.assign(Object.create(null) as JsonRecord, sourceMount);
    expect(snapshotPublicationMountDeclarations(declarationOnly(nullPrototypeMount))).toHaveLength(1);
  });

  it.each(declarationFields)(
    `requires %s to be an own declaration on every Mount ${evidence}`,
    (field) => {
      const source = manifest();
      delete mount(source)[field];
      expectInvalid(() => snapshotPublicationMountDeclarations(source));
    },
  );

  it.each(declarationFields)(
    `rejects inherited %s instead of treating it as a Mount declaration ${evidence}`,
    (field) => {
      const source = manifest();
      const original = mount(source);
      const inherited = Object.create({ [field]: original[field] }) as JsonRecord;
      for (const key of Reflect.ownKeys(original)) {
        if (key !== field) Object.defineProperty(inherited, key, Object.getOwnPropertyDescriptor(original, key)!);
      }
      source.mounts[0] = inherited;
      expectInvalid(() => snapshotPublicationMountDeclarations(source));
    },
  );

  it.each(declarationFields)(
    `requires own %s to be enumerable ${evidence}`,
    (field) => {
      const source = manifest();
      const sourceMount = mount(source);
      Object.defineProperty(sourceMount, field, {
        value: sourceMount[field],
        enumerable: false,
        configurable: true,
      });
      expectInvalid(() => snapshotPublicationMountDeclarations(source));
    },
  );

  it.each(declarationFields)(
    `rejects an accessor-backed %s without invoking it ${evidence}`,
    (field) => {
      const source = manifest();
      let reads = 0;
      Object.defineProperty(mount(source), field, {
        enumerable: true,
        configurable: true,
        get() {
          reads += 1;
          throw new Error(`accessor-secret-${field}`);
        },
      });

      expectInvalid(() => snapshotPublicationMountDeclarations(source));
      expect(reads).toBe(0);
    },
  );

  it.each(declarationFields)(
    `rejects a Proxy-backed %s without touching arbitrary Proxy values ${evidence}`,
    (field) => {
      const source = manifest();
      let trapCalls = 0;
      mount(source)[field] = new Proxy(mount(source)[field] as object, {
        get() {
          trapCalls += 1;
          throw new Error(`proxy-secret-${field}`);
        },
        getOwnPropertyDescriptor() {
          trapCalls += 1;
          throw new Error(`proxy-secret-${field}`);
        },
        getPrototypeOf() {
          trapCalls += 1;
          throw new Error(`proxy-secret-${field}`);
        },
        ownKeys() {
          trapCalls += 1;
          throw new Error(`proxy-secret-${field}`);
        },
      });

      expectInvalid(() => snapshotPublicationMountDeclarations(source));
      expect(trapCalls).toBe(0);
    },
  );

  it.each([
    ['an array', []],
    ['null', null],
    ['a string', 'mount'],
    ['a number', 1],
    ['a boolean', false],
    ['a Date', new Date('2026-07-18T00:00:00Z')],
    ['an object with a custom prototype', Object.create({ inherited: true })],
  ])(`rejects a Mount supplied as %s ${evidence}`, (_label, value) => {
    expectInvalid(() => snapshotPublicationMountDeclarations({ mounts: [value] }));
  });

  it(`rejects a Proxy-backed Mount without invoking its traps ${evidence}`, () => {
    let trapCalls = 0;
    const proxiedMount = new Proxy(mount(), {
      get() {
        trapCalls += 1;
        throw new Error('mount-proxy-secret');
      },
      getOwnPropertyDescriptor() {
        trapCalls += 1;
        throw new Error('mount-proxy-secret');
      },
      getPrototypeOf() {
        trapCalls += 1;
        throw new Error('mount-proxy-secret');
      },
      ownKeys() {
        trapCalls += 1;
        throw new Error('mount-proxy-secret');
      },
    });

    expectInvalid(() => snapshotPublicationMountDeclarations({ mounts: [proxiedMount] }));
    expect(trapCalls).toBe(0);
  });

  it.each([
    ['profiles as a primitive', 'profiles', 'core'],
    ['endpoints as an array', 'endpoints', []],
    ['auth as a primitive', 'auth', true],
    ['limits with a non-ordinary prototype', 'limits', new Date('2026-07-18T00:00:00Z')],
  ] as const)(`rejects %s at a declaration root ${evidence}`, (_label, field, value) => {
    const source = manifest();
    mount(source)[field] = value;
    expectInvalid(() => snapshotPublicationMountDeclarations(source));
  });

  it(`preserves JSON arrays and primitive leaves nested inside one declaration ${evidence}`, () => {
    const sourceMount = mount();
    sourceMount.endpoints = {
      vendor: [null, true, false, 0, 1.5, 'text', { nested: ['value'] }],
    };
    const [snapshot] = snapshotPublicationMountDeclarations(declarationOnly(sourceMount));
    expect(snapshot!.endpoints).toEqual(sourceMount.endpoints);
    expect(snapshot!.endpoints).not.toBe(sourceMount.endpoints);
  });

  it.each(declarationFields)(`rejects a self-reference in %s ${evidence}`, (field) => {
    const source = manifest();
    const value = mount(source)[field] as JsonRecord | any[];
    if (Array.isArray(value)) value.push(value);
    else value.self = value;
    expectInvalid(() => snapshotPublicationMountDeclarations(source));
  });

  it.each([
    ['profiles and endpoints', 'profiles', 'endpoints'],
    ['profiles and auth', 'profiles', 'auth'],
    ['profiles and limits', 'profiles', 'limits'],
    ['endpoints and auth', 'endpoints', 'auth'],
    ['endpoints and limits', 'endpoints', 'limits'],
    ['auth and limits', 'auth', 'limits'],
  ] as const)(`rejects one shared value across %s on the same Mount ${evidence}`, (_label, left, right) => {
    const source = manifest();
    mount(source)[right] = mount(source)[left];
    expectInvalid(() => snapshotPublicationMountDeclarations(source));
  });

  it.each(declarationFields)(
    `rejects %s shared by different Mount owners ${evidence}`,
    (field) => {
      const source = manifest();
      const second = structuredClone(mount(source));
      second.id = 'second';
      second.baseUrl = 'https://two.example/';
      second[field] = mount(source)[field];
      source.mounts.push(second);
      expectInvalid(() => snapshotPublicationMountDeclarations(source));
    },
  );

  it(`rejects a nested object shared by otherwise distinct declarations ${evidence}`, () => {
    const source = manifest();
    const shared = { privateValue: 'must-not-alias' };
    mount(source).endpoints.vendorMetadata = { shared };
    mount(source).auth.vendorMetadata = { shared };
    expectInvalid(() => snapshotPublicationMountDeclarations(source));
  });

  it(`returns deeply isolated and recursively frozen declaration snapshots ${evidence}`, () => {
    const source = manifest();
    const sourceMount = mount(source);
    const originalDirectory = sourceMount.endpoints.directory;
    const snapshots = snapshotPublicationMountDeclarations(source);
    const snapshot = snapshots[0]!;

    sourceMount.profiles.push('mutated');
    sourceMount.endpoints.directory = 'https://private.example/mutated';
    sourceMount.auth.anonymousRead = false;
    sourceMount.limits.maxPageSize = 1;

    expect(snapshot.profiles).not.toBe(sourceMount.profiles);
    expect(snapshot.endpoints).not.toBe(sourceMount.endpoints);
    expect(snapshot.auth).not.toBe(sourceMount.auth);
    expect(snapshot.limits).not.toBe(sourceMount.limits);
    expect(snapshot.endpoints.directory).toBe(originalDirectory);
    expect(Object.isFrozen(snapshots)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    for (const field of declarationFields) expect(Object.isFrozen(snapshot[field])).toBe(true);
    expect(() => Object.assign(snapshot.auth, { anonymousRead: false })).toThrow(TypeError);
  });

  it(`accepts the declaration depth boundary and rejects the next level ${evidence}`, () => {
    const atBoundary = mount();
    atBoundary.endpoints = {};
    addNestedValue(atBoundary.endpoints, MAX_PUBLICATION_MOUNT_DECLARATION_DEPTH - 1);
    expect(snapshotPublicationMountDeclarations(declarationOnly(atBoundary))).toHaveLength(1);

    const overBoundary = mount();
    overBoundary.endpoints = {};
    addNestedValue(overBoundary.endpoints, MAX_PUBLICATION_MOUNT_DECLARATION_DEPTH);
    expectLimit(() => snapshotPublicationMountDeclarations(declarationOnly(overBoundary)));
  });

  it(`accepts the declaration value-count boundary and rejects the next value ${evidence}`, () => {
    const exactMount = mount();
    exactMount.profiles = [];
    exactMount.endpoints = {
      values: Array.from(
        { length: MAX_PUBLICATION_MOUNT_DECLARATION_VALUES - 5 },
        () => null,
      ),
    };
    exactMount.auth = {};
    exactMount.limits = {};
    expect(snapshotPublicationMountDeclarations(declarationOnly(exactMount))).toHaveLength(1);

    (exactMount.endpoints.values as null[]).push(null);
    expectLimit(() => snapshotPublicationMountDeclarations(declarationOnly(exactMount)));
  });

  it(`accepts the declaration byte boundary and rejects the next UTF-8 byte ${evidence}`, () => {
    const exactMount = mount();
    exactMount.profiles = [];
    exactMount.endpoints = {
      payload: 'x'.repeat(MAX_PUBLICATION_MOUNT_DECLARATION_BYTES - 'payload'.length),
    };
    exactMount.auth = {};
    exactMount.limits = {};
    expect(snapshotPublicationMountDeclarations(declarationOnly(exactMount))).toHaveLength(1);

    exactMount.endpoints.payload += 'x';
    expectLimit(() => snapshotPublicationMountDeclarations(declarationOnly(exactMount)));
  });

  it(`makes discovery reject a Manifest whose Mount declarations are not independent ${evidence}`, () => {
    const source = manifest();
    mount(source).auth = mount(source).limits;

    expectInvalid(() => snapshotPublicationMountDeclarations(source));
    expect(() => createPublicationManifestDiscoveryHandler(source)).toThrow(TypeError);
    expect(() => handlePublicationManifestDiscoveryRequest(source, {
      method: 'GET',
      path: PUBLICATION_MANIFEST_DISCOVERY_PATH,
    })).toThrow(TypeError);
  });

  it(`serves an isolated discovery snapshot after independent declarations pass ${evidence}`, () => {
    const source = manifest();
    const originalDirectory = mount(source).endpoints.directory;
    const handler = createPublicationManifestDiscoveryHandler(source);
    mount(source).endpoints.directory = 'https://private.example/mutated';
    mount(source).auth.anonymousRead = false;

    const response = requireResponse(handler({ method: 'GET', path: PUBLICATION_MANIFEST_DISCOVERY_PATH }));
    const document = JSON.parse(response.body!) as JsonRecord;
    expect(document.mounts[0].endpoints.directory).toBe(originalDirectory);
    expect(document.mounts[0].auth.anonymousRead).toBe(true);
    expect(response.body).not.toContain('private.example');
  });

  it(`preserves PUB-0011 exact GET and HEAD discovery behavior ${evidence}`, () => {
    const source = manifest();
    const get = requireResponse(handlePublicationManifestDiscoveryRequest(source, {
      method: 'GET',
      path: PUBLICATION_MANIFEST_DISCOVERY_PATH,
    }));
    const head = requireResponse(handlePublicationManifestDiscoveryRequest(source, {
      method: 'HEAD',
      path: PUBLICATION_MANIFEST_DISCOVERY_PATH,
    }));

    expect(get.status).toBe(200);
    expect(typeof get.body).toBe('string');
    expect(head.status).toBe(200);
    expect(head.headers).toEqual(get.headers);
    expect(head.body).toBeNull();
    expect(handlePublicationManifestDiscoveryRequest(source, {
      method: 'GET',
      path: `${PUBLICATION_MANIFEST_DISCOVERY_PATH}/`,
    })).toBeNull();
    expect(handlePublicationManifestDiscoveryRequest(source, {
      method: 'get',
      path: PUBLICATION_MANIFEST_DISCOVERY_PATH,
    })).toBeNull();
  });
});
