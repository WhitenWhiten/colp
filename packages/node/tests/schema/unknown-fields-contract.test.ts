import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  collectionProtocolSchema,
  createValidatorRegistry,
  type DefinitionName,
  type ValidatorRegistry,
} from '../../src/schema/index.js';

const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const validators = createValidatorRegistry();

function fixture(name: string): Record<string, any> {
  return JSON.parse(readFileSync(resolve(fixturesRoot, name), 'utf8')) as Record<string, any>;
}

function expectUnknownField(
  registry: ValidatorRegistry,
  definition: DefinitionName,
  value: unknown,
  instancePath: string,
  field = 'futureCoreField',
): void {
  const result = registry.validate(definition, value);
  expect(result.valid).toBe(false);
  if (result.valid) return;
  expect(result.errors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        instancePath,
        keyword: 'additionalProperties',
        params: { additionalProperty: field },
      }),
    ]),
  );
}

const collectionId = 'collection-1';
const rootId = 'root-1';
const timestamp = '2026-07-16T06:30:00Z';
const nodeBase = {
  collectionId,
  createdAt: timestamp,
  updatedAt: timestamp,
  revision: 'revision-1',
};

const nodeVariants = [
  {
    label: 'root',
    value: {
      ...nodeBase,
      id: rootId,
      kind: 'root',
      parentId: null,
      position: null,
      folderRole: 'root',
      title: 'Root',
    },
  },
  {
    label: 'folder',
    value: {
      ...nodeBase,
      id: 'folder-1',
      kind: 'folder',
      parentId: rootId,
      position: 'a',
      title: 'Folder',
    },
  },
  {
    label: 'bookmark',
    value: {
      ...nodeBase,
      id: 'bookmark-1',
      kind: 'bookmark',
      parentId: rootId,
      position: 'b',
      title: 'Bookmark',
      url: 'https://example.com/resource',
    },
  },
  {
    label: 'separator',
    value: {
      ...nodeBase,
      id: 'separator-1',
      kind: 'separator',
      parentId: rootId,
      position: 'c',
    },
  },
  {
    label: 'alias',
    value: {
      ...nodeBase,
      id: 'alias-1',
      kind: 'alias',
      parentId: rootId,
      position: 'd',
      title: 'Alias',
      targetNodeId: 'bookmark-1',
    },
  },
] as const;

describe('unknown core field contract', () => {
  it('closes every object schema reachable from Snapshot except extension payloads [evidence:schema.unknown-fields]', () => {
    const schema = collectionProtocolSchema as any;
    const pending = ['snapshot'];
    const visited = new Set<string>();
    const openObjects: string[] = [];

    function inspect(value: any, path: string): void {
      if (value === null || typeof value !== 'object') return;
      if (typeof value.$ref === 'string' && value.$ref.startsWith('#/$defs/')) {
        pending.push(value.$ref.slice('#/$defs/'.length));
      }
      if (value.type === 'object' && path !== '#/$defs/extensions' && value.additionalProperties !== false) {
        openObjects.push(path);
      }
      for (const [key, child] of Object.entries(value)) inspect(child, `${path}/${key}`);
    }

    while (pending.length > 0) {
      const definition = pending.shift() as string;
      if (visited.has(definition)) continue;
      visited.add(definition);
      inspect(schema.$defs[definition], `#/$defs/${definition}`);
    }

    expect([...visited]).toEqual(expect.arrayContaining([
      'snapshot', 'collection', 'node', 'annotation', 'attachment', 'relation', 'extensions',
    ]));
    expect(openObjects).toEqual([]);
  });

  it('rejects unknown fields on Snapshot, Collection, Annotation, Attachment, and Relation [evidence:schema.unknown-fields]', () => {
    const base = fixture('collection-snapshot.json');
    const cases = [
      { label: 'Snapshot', path: '', mutate: (value: Record<string, any>) => value },
      { label: 'Collection', path: '/collection', mutate: (value: Record<string, any>) => value.collection },
      { label: 'Annotation', path: '/annotations/0', mutate: (value: Record<string, any>) => value.annotations[0] },
      {
        label: 'Attachment',
        path: '/attachments/0',
        mutate(value: Record<string, any>) {
          value.attachments.push({
            id: 'attachment-1',
            collectionId: value.collection.id,
            subject: { type: 'node', id: value.nodes[1].id },
            rel: 'alternate',
            url: 'https://example.com/attachment',
            visibility: 'public',
            createdAt: timestamp,
            updatedAt: timestamp,
            revision: 'attachment-revision',
          });
          return value.attachments[0];
        },
      },
      {
        label: 'Relation',
        path: '/relations/0',
        mutate(value: Record<string, any>) {
          value.relations.push({
            id: 'relation-1',
            collectionId: value.collection.id,
            type: 'related',
            fromNodeId: value.nodes[0].id,
            toNodeId: value.nodes[1].id,
            visibility: 'public',
            createdAt: timestamp,
            updatedAt: timestamp,
            revision: 'relation-revision',
          });
          return value.relations[0];
        },
      },
    ];

    for (const testCase of cases) {
      const snapshot = structuredClone(base);
      const target = testCase.mutate(snapshot);
      target.futureCoreField = `${testCase.label} extension disguised as core data`;
      expectUnknownField(validators, 'snapshot', snapshot, testCase.path);
    }
  });

  it.each(nodeVariants)(
    'rejects an unknown field on the $label Node discriminant [evidence:schema.unknown-fields]',
    ({ value }) => {
      expect(validators.validate('node', value).valid).toBe(true);
      expectUnknownField(validators, 'node', { ...value, futureCoreField: true }, '');
    },
  );

  it('rejects unknown fields on important nested core objects [evidence:schema.unknown-fields]', () => {
    const base = fixture('collection-snapshot.json');
    const cases = [
      { path: '/collection/description', target: (value: Record<string, any>) => value.collection.description },
      { path: '/collection/creators/0', target: (value: Record<string, any>) => value.collection.creators[0] },
      { path: '/collection/publication', target: (value: Record<string, any>) => value.collection.publication },
      { path: '/nodes/0/constraints', target: (value: Record<string, any>) => value.nodes[0].constraints },
      { path: '/annotations/0/subject', target: (value: Record<string, any>) => value.annotations[0].subject },
      { path: '/annotations/0/creator', target: (value: Record<string, any>) => value.annotations[0].creator },
      { path: '/annotations/0/provenance', target: (value: Record<string, any>) => value.annotations[0].provenance },
      { path: '/page', target: (value: Record<string, any>) => value.page },
    ];

    for (const testCase of cases) {
      const snapshot = structuredClone(base);
      testCase.target(snapshot).futureCoreField = true;
      expectUnknownField(validators, 'snapshot', snapshot, testCase.path);
    }

    const withSourceRef = fixture('sync-snapshot.json');
    expect(validators.validate('snapshot', withSourceRef).valid).toBe(true);
    withSourceRef.nodes[1].sourceRefs[0].futureCoreField = true;
    expectUnknownField(validators, 'snapshot', withSourceRef, '/nodes/1/sourceRefs/0');

    const withWarning = structuredClone(base);
    withWarning.warnings.push({ code: 'warning', message: 'Warning', futureCoreField: true });
    expectUnknownField(validators, 'snapshot', withWarning, '/warnings/0');
  });

  it('rejects unknown fields on optional nested Snapshot DTOs from valid baselines [evidence:schema.unknown-fields]', () => {
    const cases: Array<{
      definition: DefinitionName;
      value: Record<string, any>;
      target?: (value: Record<string, any>) => Record<string, any>;
      path?: string;
    }> = [
      { definition: 'media', value: { url: 'https://example.com/icon.png', mimeType: 'image/png' } },
      {
        definition: 'readingStateValue',
        value: { status: 'in_progress', progress: 0.5, completedAt: null },
      },
      {
        definition: 'highlightValue',
        value: { quote: 'Selected text', selector: { type: 'TextQuoteSelector', exact: 'Selected text' } },
        target: (value) => value.selector,
        path: '/selector',
      },
      {
        definition: 'syncTombstone',
        value: {
          resourceType: 'node', targetId: 'deleted-1', collectionId, scope: 'single',
          deletedAt: timestamp, deleteRevision: 'delete-revision', operationId: 'operation-1',
          deleteCursor: 'cursor-1', affectedCount: 1, purgeAfter: timestamp,
        },
      },
    ];

    for (const testCase of cases) {
      expect(validators.validate(testCase.definition, testCase.value).valid).toBe(true);
      const mutated = structuredClone(testCase.value);
      (testCase.target?.(mutated) ?? mutated).futureCoreField = true;
      expectUnknownField(validators, testCase.definition, mutated, testCase.path ?? '');
    }
  });

  it('accepts arbitrary nested extension values and unknown names inside their payloads [evidence:schema.unknown-fields]', () => {
    const extensions = {
      'https://example.com/ns/arbitrary/v1': {
        unknownName: {
          anotherUnknownName: [null, true, 42, 'text', { deeplyUnknown: { value: false } }],
        },
      },
    };
    expect(validators.validate('extensions', extensions)).toEqual({ valid: true, errors: [] });

    const snapshot = fixture('collection-snapshot.json');
    snapshot.collection.extensions = extensions;
    snapshot.nodes[0].extensions = extensions;
    snapshot.annotations[0].extensions = extensions;
    expect(validators.validate('snapshot', snapshot)).toEqual({ valid: true, errors: [] });
  });

  it.each([
    'https://example.com',
    'https://example.com/ns/v1',
    'HTTPS://EXAMPLE.com:8443/ns?v=1#contract',
    'https://127.0.0.1:9443/extensions/core',
  ])('accepts HTTPS namespace URI %s [evidence:schema.unknown-fields]', (namespace) => {
    expect(validators.validate('extensions', { [namespace]: true })).toEqual({ valid: true, errors: [] });
  });

  it.each([
    ['HTTP namespace', 'http://example.com/ns'],
    ['relative reference', '../extensions/ns'],
    ['malformed HTTPS URI', 'https://example.com/%ZZ'],
    ['RFC 3986-invalid bracket path', 'https://example.com/[]'],
    ['space in URI', 'https://exa mple.com/ns'],
    ['empty key', ''],
    ['non-URI key', 'extension-name'],
  ])('rejects a %s extension key [evidence:schema.unknown-fields]', (_label, namespace) => {
    expect(validators.validate('extensions', { [namespace]: true }).valid).toBe(false);
  });
});
