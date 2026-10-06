import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as clientBoundary from '../../src/client/index.js';
import * as packageBoundary from '../../src/client/index.js';
import * as semanticBoundary from '../../src/semantic/index.js';
import * as serverBoundary from '../../src/server/index.js';
import { validateSnapshotSemantics } from '../../src/semantic/index.js';
import type { Snapshot } from '../../src/types/index.js';

type ResourceType =
  | 'collection'
  | 'node'
  | 'annotation'
  | 'attachment'
  | 'relation'
  | 'operation'
  | 'event';

interface ResourceIdentity {
  readonly serverUuid: string;
  readonly resourceType: ResourceType;
  readonly id: string;
}

interface ReferenceContext {
  /** Bare IDs are local only when this context is explicitly supplied. */
  readonly localServerUuid: string;
  readonly resourceType: ResourceType;
  /** When supplied, the reference must encode this exact global identity. */
  readonly claimedIdentity?: ResourceIdentity;
}

interface CanonicalIdentityApi {
  readonly formatCanonicalResourceUri?: (identity: ResourceIdentity) => string;
  readonly parseCanonicalResourceUri?: (uri: string, claimedIdentity?: ResourceIdentity) => ResourceIdentity;
  readonly resolveResourceReference?: (reference: string, context: ReferenceContext) => ResourceIdentity;
}

const packageApi = packageBoundary as CanonicalIdentityApi;
const boundaries = [
  ['client', clientBoundary as CanonicalIdentityApi],
  ['semantic', semanticBoundary as CanonicalIdentityApi],
  ['server', serverBoundary as CanonicalIdentityApi],
] as const;

const resourceTypes = [
  'collection',
  'node',
  'annotation',
  'attachment',
  'relation',
  'operation',
  'event',
] as const satisfies readonly ResourceType[];

const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');

function api(): Required<CanonicalIdentityApi> {
  expect(
    typeof packageApi.formatCanonicalResourceUri,
    'CORE-0017 needs a public canonical URI formatter',
  ).toBe('function');
  expect(
    typeof packageApi.parseCanonicalResourceUri,
    'CORE-0017 needs a public canonical URI parser',
  ).toBe('function');
  expect(
    typeof packageApi.resolveResourceReference,
    'CORE-0017 needs a public local/foreign reference resolver',
  ).toBe('function');
  return packageApi as Required<CanonicalIdentityApi>;
}

function identity(overrides: Partial<ResourceIdentity> = {}): ResourceIdentity {
  return {
    serverUuid: 'Server-A',
    resourceType: 'node',
    id: 'Resource-A',
    ...overrides,
  };
}

function canonical(value: ResourceIdentity = identity()): string {
  return api().formatCanonicalResourceUri(value);
}

function replaceFinalId(uri: string, replacement: string): string {
  const marker = 'Resource-A';
  const index = uri.lastIndexOf(marker);
  expect(index, 'formatted URI must carry the resource ID as a URI component').toBeGreaterThanOrEqual(0);
  return `${uri.slice(0, index)}${replacement}${uri.slice(index + marker.length)}`;
}

describe('CORE-0017 canonical global resource identity [evidence:core.canonical-resource-identity]', () => {
  it('exposes the formatter, parser, and resolver at the client public boundary', () => {
    api();
  });

  it.each(boundaries)('exposes the resolver contract at the %s boundary', (_name, boundary) => {
    expect(typeof boundary.resolveResourceReference).toBe('function');
  });

  it.each(resourceTypes)('round-trips the exact tuple for %s', (resourceType) => {
    const value = identity({ resourceType, id: `${resourceType}-A` });
    const uri = canonical(value);
    expect(api().parseCanonicalResourceUri(uri)).toEqual(value);
    expect(canonical(api().parseCanonicalResourceUri(uri))).toBe(uri);
  });

  it.each(['A', 'x'.repeat(128)])('round-trips valid opaque ID boundary length %s', (id) => {
    const value = identity({ id });
    expect(api().parseCanonicalResourceUri(canonical(value))).toEqual(value);
  });

  it('round-trips every allowed URI-unreserved character without encoding', () => {
    const value = identity({
      serverUuid: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~',
      id: '~-._0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
    });
    const uri = canonical(value);
    expect(uri).not.toContain('%');
    expect(api().parseCanonicalResourceUri(uri)).toEqual(value);
  });

  it.each(['.', '..'])('round-trips dot-segment opaque IDs %j without path collapse', (id) => {
    const value = identity({ serverUuid: id, id });
    expect(api().parseCanonicalResourceUri(canonical(value))).toEqual(value);
  });

  it.each(['a/b', 'a?b', 'a#b', 'a%b', 'a b'])('rejects non-Wire-ID reserved input %j', (id) => {
    expect(() => canonical(identity({ id }))).toThrow();
  });

  it('preserves case-sensitive server UUID and ID identity', () => {
    const upper = identity({ serverUuid: 'Server-A', id: 'Resource-A' });
    const lower = identity({ serverUuid: 'server-a', id: 'resource-a' });
    const upperUri = canonical(upper);
    const lowerUri = canonical(lower);

    expect(upperUri).not.toBe(lowerUri);
    expect(api().parseCanonicalResourceUri(upperUri)).toEqual(upper);
    expect(api().parseCanonicalResourceUri(lowerUri)).toEqual(lower);
  });

  it('does not apply WHATWG host lowercasing or URL canonicalization to identity', () => {
    const value = identity({ serverUuid: 'MiXeD-Server', id: 'MiXeD-Id' });
    const uri = canonical(value);
    expect(api().parseCanonicalResourceUri(uri)).toEqual(value);
    expect(canonical(api().parseCanonicalResourceUri(uri))).toBe(uri);

    // A generic URL parser is allowed to normalize a host; the COLP parser is not.
    try {
      const whatwg = new URL(uri).href;
      if (whatwg !== uri) expect(api().parseCanonicalResourceUri(whatwg)).not.toEqual(value);
    } catch {
      // An opaque canonical URI is also valid evidence that host normalization is avoided.
    }
  });

  it('accepts a bare ID only with explicit same-server context', () => {
    expect(api().resolveResourceReference('local-node', {
      localServerUuid: 'Server-A',
      resourceType: 'node',
    })).toEqual(identity({ id: 'local-node' }));

    expect(() => (api().resolveResourceReference as (reference: string, context?: ReferenceContext) => ResourceIdentity)(
      'local-node',
    )).toThrow();
  });

  it('rejects a bare ID when the claimed identity belongs to another server', () => {
    expect(() => api().resolveResourceReference('foreign-node', {
      localServerUuid: 'Server-A',
      resourceType: 'node',
      claimedIdentity: identity({ serverUuid: 'Server-B', id: 'foreign-node' }),
    })).toThrow();
  });

  it('requires and accepts a canonical URI for a claimed foreign identity', () => {
    const foreign = identity({ serverUuid: 'Server-B', id: 'foreign-node' });
    expect(api().resolveResourceReference(canonical(foreign), {
      localServerUuid: 'Server-A',
      resourceType: 'node',
      claimedIdentity: foreign,
    })).toEqual(foreign);
  });

  it('does not let a foreign canonical reference masquerade as a local ID', () => {
    const foreign = identity({ serverUuid: 'Server-B', id: 'local-node' });
    expect(api().resolveResourceReference(canonical(foreign), {
      localServerUuid: 'Server-A',
      resourceType: 'node',
    })).toEqual(foreign);
    expect(api().resolveResourceReference('local-node', {
      localServerUuid: 'Server-A',
      resourceType: 'node',
    })).not.toEqual(foreign);
  });

  it('rejects a canonical URI whose parsed tuple differs from the claimed tuple', () => {
    const encoded = identity({ serverUuid: 'Server-B', resourceType: 'node', id: 'foreign-node' });
    const claims = [
      identity({ serverUuid: 'Server-C', resourceType: 'node', id: 'foreign-node' }),
      identity({ serverUuid: 'Server-B', resourceType: 'annotation', id: 'foreign-node' }),
      identity({ serverUuid: 'Server-B', resourceType: 'node', id: 'other-node' }),
    ];
    for (const claim of claims) {
      expect(() => api().parseCanonicalResourceUri(canonical(encoded), claim)).toThrow();
      expect(() => api().resolveResourceReference(canonical(encoded), {
        localServerUuid: 'Server-A',
        resourceType: claim.resourceType,
        claimedIdentity: claim,
      })).toThrow();
    }
  });

  it.each([
    'relative/id',
    '/relative/id',
    'https://Server-A/node/Resource-A',
    'http://Server-A/node/Resource-A',
    'COLP:/resources/~Server-A/node/~Resource-A',
    'colp://Server-A/resources/~Server-A/node/~Resource-A',
    'colp:',
    'colp://',
    'colp:///node/Resource-A',
    'colp://Server-A',
    'colp://Server-A/node',
    'colp://Server-A/node/Resource-A/extra',
    'colp://user@Server-A/node/Resource-A',
    'colp://Server-A/unknown/Resource-A',
    'colp://Server-A/Node/Resource-A',
  ])('rejects malformed or non-canonical URI %j', (uri) => {
    expect(() => api().parseCanonicalResourceUri(uri)).toThrow();
  });

  it.each([
    ['query', (uri: string) => `${uri}?x=1`],
    ['fragment', (uri: string) => `${uri}#x`],
    ['encoded slash', (uri: string) => replaceFinalId(uri, '%2F')],
    ['encoded unreserved character', (uri: string) => replaceFinalId(uri, '%41')],
    ['encoded dot traversal', (uri: string) => replaceFinalId(uri, '%2e%2e')],
    ['double encoding', (uri: string) => replaceFinalId(uri, '%252F')],
    ['invalid percent escape', (uri: string) => replaceFinalId(uri, '%ZZ')],
    ['Unicode', (uri: string) => replaceFinalId(uri, '\u00e9')],
    ['control character', (uri: string) => replaceFinalId(uri, '%00')],
  ] as const)('rejects %s in a canonical URI', (_name, mutate) => {
    expect(() => api().parseCanonicalResourceUri(mutate(canonical()))).toThrow();
  });

  it('keeps existing same-Collection Snapshot bare references valid', async () => {
    const snapshot = JSON.parse(
      await readFile(resolve(fixturesRoot, 'collection-snapshot.json'), 'utf8'),
    ) as Snapshot;
    expect(validateSnapshotSemantics(snapshot)).toEqual({ valid: true, issues: [] });
  });
});
