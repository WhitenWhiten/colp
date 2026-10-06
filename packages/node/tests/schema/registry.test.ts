import { describe, expect, it } from 'vitest';

import {
  collectionProtocolSchema,
  createValidatorRegistry,
  isLevelOneUriTemplate,
} from '../../src/schema/index.js';

describe('schema validator registry', () => {
  const registry = createValidatorRegistry();

  it('keeps the canonical schema deeply immutable', () => {
    expect(Object.isFrozen(collectionProtocolSchema)).toBe(true);
    expect(Object.isFrozen(collectionProtocolSchema.$defs)).toBe(true);
    expect(Object.isFrozen(collectionProtocolSchema.$defs.opaqueId)).toBe(true);
    expect(() => {
      (collectionProtocolSchema.$defs.opaqueId as { pattern?: string }).pattern = '.*';
    }).toThrow(TypeError);
    expect(registry.validate('opaqueId', 'collection/1').valid).toBe(false);
  });

  it('exposes every named schema definition', () => {
    expect(registry.definitionNames).toEqual(
      expect.arrayContaining([
        'bookmarkUrl',
        'changePlanOperation',
        'nodeDeleteQuery',
        'nodeDetailQuery',
        'syncSnapshotQuery',
      ]),
    );
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
      protocol: 'https://collectionprotocol.org/spec/0.1',
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
