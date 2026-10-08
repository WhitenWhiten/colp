import { describe, expect, it } from 'vitest';

import {
  collectionProtocolSchema,
  collectionProtocolSchemaV02,
  createValidatorRegistry,
  isLevelOneUriTemplate,
} from '../../src/schema/index.js';

function expectDeeplyFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeeplyFrozen(child, seen);
}

describe('schema validator registry', () => {
  const registry = createValidatorRegistry();

  it('keeps the canonical schema deeply immutable', () => {
    expectDeeplyFrozen(collectionProtocolSchema);
    expectDeeplyFrozen(collectionProtocolSchemaV02);
    expect(() => {
      (collectionProtocolSchema.$defs.opaqueId as { pattern?: string }).pattern = '.*';
    }).toThrow(TypeError);
    expect(registry.validate('opaqueId', 'collection/1').valid).toBe(false);
  });

  it('exposes every named schema definition', () => {
    const expected = [
      ...Object.keys(collectionProtocolSchema.$defs),
      ...Object.keys(collectionProtocolSchemaV02.$defs),
    ];
    expect(registry.definitionNames).toEqual(expected);
    expect(new Set(registry.definitionNames).size).toBe(expected.length);
  });

  it('validates by definition name with format assertions enabled', () => {
    expect(registry.validate('opaqueId', 'collection-1')).toEqual({ valid: true, errors: [] });
    expect(registry.validate('opaqueId', 'collection/1').valid).toBe(false);
    expect(registry.validate('dateTime', 'not-a-date').valid).toBe(false);
  });

  it('caches compiled validators and rejects unknown definition names', () => {
    expect(registry.get('snapshot')).toBe(registry.get('snapshot'));
    expect(() => registry.get('doesNotExist' as never)).toThrow(RangeError);
  });

  it('rejects fields forbidden by discriminated node variants', () => {
    const folder = {
      id: 'folder-1',
      collectionId: 'collection-1',
      kind: 'folder',
      parentId: 'root-1',
      position: 'a',
      title: 'Folder',
      url: 'https://example.com/',
      createdAt: '2026-07-16T00:00:00Z',
      updatedAt: '2026-07-16T00:00:00Z',
      revision: 'r-1',
    };

    expect(registry.validate('node', folder).valid).toBe(false);
  });

  it('supports safe local bookmark URLs and rejects executable schemes', () => {
    expect(registry.validate('bookmarkUrl', 'file:///C:/Docs/guide.html').valid).toBe(true);
    expect(registry.validate('bookmarkUrl', 'javascript:alert(1)').valid).toBe(false);
  });

  it('requires publication endpoints at the manifest mount', () => {
    const manifest = {
      protocol: 'https://know-n.com/colp/spec/0.1',
      protocolVersions: ['0.1'],
      serverId: 'https://example.com/',
      serverUuid: 'server-1',
      title: 'Incomplete',
      mounts: [
        {
          id: 'default',
          baseUrl: 'https://example.com/collections/',
          profiles: ['core', 'publication'],
          endpoints: {},
          features: {},
          auth: { anonymousRead: true, apiKeys: false, oauth: false },
          limits: {
            maxPageSize: 100,
            maxSnapshotNodes: 1000,
            minPollIntervalSeconds: 60,
            recommendedPollIntervalSeconds: 300,
          },
        },
      ],
    };
    expect(registry.validate('manifest', manifest).valid).toBe(false);
  });

  it('bounds every structured uniqueItems array before deep uniqueness checks', () => {
    const structuredUniqueArrays: Record<string, unknown>[] = [];
    const visit = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      const object = value as Record<string, unknown>;
      if (object.uniqueItems === true && object.items && typeof object.items === 'object') {
        const items = object.items as Record<string, unknown>;
        const reference = typeof items.$ref === 'string' ? items.$ref : '';
        if (reference.endsWith('/actor') || reference.endsWith('/sourceRef') || reference.endsWith('/webSubHub')) {
          structuredUniqueArrays.push(object);
        }
      }
      Object.values(object).forEach(visit);
    };
    visit(collectionProtocolSchema);
    expect(structuredUniqueArrays.length).toBeGreaterThan(0);
    for (const arraySchema of structuredUniqueArrays) expect(arraySchema.maxItems).toBe(512);

    const creators = Array.from({ length: 513 }, (_, index) => ({
      id: `https://example.com/actors/${index}`,
      name: `Actor ${index}`,
    }));
    const result = registry.validate('collection', {
      schemaVersion: '0.1',
      id: 'collection-1',
      kind: 'mixed',
      title: 'Bounded',
      rootNodeId: 'root-1',
      visibility: 'public',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      revision: 'revision-1',
      creators,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.keyword === 'maxItems')).toBe(true);
  });

  it('rejects oversized parsed graphs before schema traversal', () => {
    let nested: Record<string, unknown> = {};
    for (let index = 0; index < 130; index += 1) nested = { next: nested };
    const deep = registry.validate('opaqueId', nested);
    expect(deep.valid).toBe(false);
    expect(deep.errors[0]?.keyword).toBe('x-colp-budget');

    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 100_001; index += 1) wide[`k${index}`] = index;
    const broad = registry.validate('opaqueId', wide);
    expect(broad.valid).toBe(false);
    expect(broad.errors[0]?.keyword).toBe('x-colp-budget');

    const broadArray = registry.validate('opaqueId', new Array(100_001));
    expect(broadArray.valid).toBe(false);
    expect(broadArray.errors[0]?.keyword).toBe('x-colp-budget');
  });
});

describe('URI Template format', () => {
  it.each([
    'https://example.com/collections',
    'https://example.com/c/{collectionId}',
    'https://example.com/c/{collectionId}/nodes/{nodeId}',
  ])('accepts Level 1 template %s', (template) => {
    expect(isLevelOneUriTemplate(template)).toBe(true);
  });

  it.each([
    'https://example.com/{+collectionId}',
    'https://example.com/{collectionId:3}',
    'https://example.com/{?collectionId}',
    'https://example.com/{collectionId',
    'https://example.com/path with space',
    'not a uri',
    'http://remote.example/{collectionId}',
    'https://user@example.com/{collectionId}',
  ])('rejects non-Level-1 template %s', (template) => {
    expect(isLevelOneUriTemplate(template)).toBe(false);
  });
});
