import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { placeExtension as placeExtensionFromSchema } from '../../src/schema/index.js';
import type { ColpContract } from '../../src/types/index.js';
import {
  collectionProtocolSchema,
  createValidatorRegistry,
  placeExtension,
  preserveExtensionCarrier,
  preserveExtensions,
  validateWireDocument,
  validateWireJsonDocument,
  type DefinitionName,
  type ExtensionCarrier,
  type ExtensionMap,
} from '../../src/schema/index.js';
import type {
  Annotation,
  AnnotationCreate,
  AnnotationMergePatch,
  Attachment,
  AttachmentCreate,
  AttachmentMergePatch,
  Collection,
  CollectionCreate,
  CollectionMergePatch,
  DirectoryCollection,
  ExtensionFeedEventData,
  Extensions,
  Node,
  NodeCreate,
  NodeMergePatch,
  OperationSource,
  Relation,
  RelationCreate,
  RelationMergePatch,
  Release,
  ReleaseCreate,
  Replica,
  RootCreate,
} from '../../src/types/index.js';

const evidence = '[evidence:core.forward-data-in-extensions]';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const validators = createValidatorRegistry();
const namespace = 'https://vendor.example/extensions/future/v1';
const timestamp = '2026-07-16T07:00:00Z';

type JsonObject = Record<string, any>;
type CarrierCase = Readonly<{
  label: string;
  definition: DefinitionName;
  value: () => JsonObject;
}>;

function fixture(name: string): JsonObject {
  return JSON.parse(readFileSync(resolve(fixturesRoot, name), 'utf8')) as JsonObject;
}

function fixtureAt(name: string, ...path: Array<string | number>): () => JsonObject {
  return () => path.reduce<any>((value, segment) => value[segment], fixture(name)) as JsonObject;
}

function literal(value: JsonObject): () => JsonObject {
  return () => structuredClone(value);
}

function payload(): JsonObject {
  return {
    nullValue: null,
    scalarValues: [false, true, 0, 1.25, ''],
    nested: [{ arrays: [null, { objects: ['opaque', 7] }] }],
  };
}

const nodeBase = {
  collectionId: 'collection-1', createdAt: timestamp, updatedAt: timestamp, revision: 'revision-1',
};

const carrierCases: readonly CarrierCase[] = [
  { label: 'Collection', definition: 'collection', value: fixtureAt('collection-snapshot.json', 'collection') },
  { label: 'root Node', definition: 'node', value: literal({ ...nodeBase, id: 'root-1', kind: 'root', parentId: null, position: null, folderRole: 'root', title: 'Root' }) },
  { label: 'folder Node', definition: 'node', value: literal({ ...nodeBase, id: 'folder-1', kind: 'folder', parentId: 'root-1', position: 'a', title: 'Folder' }) },
  { label: 'bookmark Node', definition: 'node', value: fixtureAt('local-bookmark-node.json') },
  { label: 'separator Node', definition: 'node', value: literal({ ...nodeBase, id: 'separator-1', kind: 'separator', parentId: 'root-1', position: 'b' }) },
  { label: 'alias Node', definition: 'node', value: literal({ ...nodeBase, id: 'alias-1', kind: 'alias', parentId: 'root-1', position: 'c', targetNodeId: 'bookmark-1', title: 'Alias' }) },
  { label: 'Annotation', definition: 'annotation', value: fixtureAt('collection-snapshot.json', 'annotations', 0) },
  { label: 'Attachment', definition: 'attachment', value: literal({ id: 'attachment-1', collectionId: 'collection-1', subject: { type: 'node', id: 'bookmark-1' }, rel: 'alternate', url: 'https://example.com/a', visibility: 'public', createdAt: timestamp, updatedAt: timestamp, revision: 'r-1' }) },
  { label: 'Relation', definition: 'relation', value: literal({ id: 'relation-1', collectionId: 'collection-1', type: 'related', fromNodeId: 'root-1', toNodeId: 'bookmark-1', visibility: 'public', createdAt: timestamp, updatedAt: timestamp, revision: 'r-1' }) },
  { label: 'Collection create', definition: 'collectionCreate', value: fixtureAt('publisher-collection-create.json', 'collection') },
  { label: 'root create', definition: 'rootCreate', value: fixtureAt('publisher-collection-create.json', 'root') },
  { label: 'folder create', definition: 'nodeCreate', value: literal({ kind: 'folder', title: 'Folder' }) },
  { label: 'bookmark create', definition: 'nodeCreate', value: literal({ kind: 'bookmark', title: 'Bookmark', url: 'https://example.com/' }) },
  { label: 'separator create', definition: 'nodeCreate', value: literal({ kind: 'separator' }) },
  { label: 'alias create', definition: 'nodeCreate', value: literal({ kind: 'alias', title: 'Alias', targetNodeId: 'bookmark-1' }) },
  { label: 'Annotation create', definition: 'annotationCreate', value: fixtureAt('publisher-annotation-create.json') },
  { label: 'Attachment create', definition: 'attachmentCreate', value: literal({ subject: { type: 'node', id: 'bookmark-1' }, rel: 'alternate', url: 'https://example.com/a', visibility: 'public' }) },
  { label: 'Relation create', definition: 'relationCreate', value: literal({ type: 'related', fromNodeId: 'root-1', toNodeId: 'bookmark-1', visibility: 'public' }) },
  { label: 'Collection merge patch', definition: 'collectionMergePatch', value: literal({ title: 'Updated' }) },
  { label: 'Node merge patch', definition: 'nodeMergePatch', value: literal({ title: 'Updated' }) },
  { label: 'Annotation merge patch', definition: 'annotationMergePatch', value: literal({ visibility: 'private' }) },
  { label: 'Attachment merge patch', definition: 'attachmentMergePatch', value: literal({ title: null }) },
  { label: 'Relation merge patch', definition: 'relationMergePatch', value: literal({ label: null }) },
  { label: 'directory Collection', definition: 'directoryCollection', value: fixtureAt('collection-directory.json', 'collections', 0) },
  { label: 'release create', definition: 'releaseCreate', value: literal({ title: 'Release' }) },
  { label: 'Release', definition: 'release', value: fixtureAt('release-result.json', 'release') },
  { label: 'Operation source', definition: 'operationSource', value: literal({ adapterProfile: 'browser-v1' }) },
  { label: 'Replica', definition: 'replica', value: fixtureAt('sync-session-request.json', 'replica') },
  { label: 'extension Feed event data', definition: 'extensionFeedEventData', value: literal({ collectionId: 'collection-1', extensions: {} }) },
] as const;

const jsonPayloads = [null, false, 0, '', [], payload()] as const;
const validNamespaces = [
  namespace,
  'HTTPS://EXAMPLE.COM/extensions/v1',
  'https://127.0.0.1:9443/extensions/v1',
  'https://[2001:db8::1]:443/extensions/v1',
  'https://example.com/a~b/c?version=1#shape',
] as const;
const invalidNamespaces = [
  '', 'future', '../extensions/v1', 'http://example.com/extensions/v1',
  'ftp://example.com/extensions/v1', 'https:///extensions/v1',
  'https://user@:443/extensions/v1', 'https://exa mple.com/extensions/v1',
] as const;

function expectUnknownCoreField(result: ReturnType<typeof validators.validate>, path = ''): void {
  expect(result.valid).toBe(false);
  if (result.valid) return;
  expect(result.errors).toEqual(expect.arrayContaining([
    expect.objectContaining({
      instancePath: path,
      keyword: 'additionalProperties',
      params: { additionalProperty: 'futurePayload' },
    }),
  ]));
}

describe(`CORE-0032 forward data belongs in extensions ${evidence}`, () => {
  it.each(carrierCases)('$label rejects a future core sibling and accepts the same payload in extensions', ({ definition, value }) => {
    const unknown = value();
    unknown.futurePayload = payload();
    expectUnknownCoreField(validators.validate(definition, unknown));

    const placed = value();
    placed.extensions = { ...(placed.extensions ?? {}), [namespace]: payload() };
    expect(validators.validate(definition, placed)).toEqual({ valid: true, errors: [] });
  });

  it.each(jsonPayloads)('accepts every JSON payload shape under the namespace: %j', (value) => {
    expect(validators.validate('extensions', { [namespace]: value })).toEqual({ valid: true, errors: [] });
    expect(placeExtension({}, namespace, value).extensions[namespace]).toEqual(value);
  });

  it.each(validNamespaces)('accepts the HTTPS namespace spelling %s', (value) => {
    expect(validators.validate('extensions', { [value]: payload() })).toEqual({ valid: true, errors: [] });
  });

  it.each(invalidNamespaces)('rejects invalid namespace %j at the exact root propertyNames path', (value) => {
    const result = validators.validate('extensions', { [value]: payload() });
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        instancePath: '',
        keyword: 'propertyNames',
        params: { propertyName: value },
      }),
    ]));
    expect(() => placeExtension({}, value, payload())).toThrow(TypeError);
  });

  it.each([
    ['undefined', undefined],
    ['function', () => true],
    ['symbol', Symbol('future')],
    ['bigint', 1n],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
    ['positive unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['negative unsafe integer', Number.MIN_SAFE_INTEGER - 1],
  ] as const)('rejects I-JSON-invalid %s in the public placement helper', (_label, value) => {
    expect(() => placeExtension({}, namespace, value)).toThrow(TypeError);
  });

  it('rejects cycles in arrays and objects without mutating them', () => {
    const objectCycle: JsonObject = {};
    objectCycle.self = objectCycle;
    const arrayCycle: unknown[] = [];
    arrayCycle.push(arrayCycle);
    expect(() => preserveExtensions({ [namespace]: objectCycle }, { surface: 'relay' })).toThrow('cycles');
    expect(() => preserveExtensions({ [namespace]: arrayCycle }, { surface: 'relay' })).toThrow('cycles');
    expect(objectCycle.self).toBe(objectCycle);
    expect(arrayCycle[0]).toBe(arrayCycle);
  });

  it.each([
    ['Manifest', 'manifest', fixtureAt('public-manifest.json')],
    ['Manifest mount', 'manifestMount', fixtureAt('public-manifest.json', 'mounts', 0)],
    ['Manifest features', 'manifestFeatures', fixtureAt('public-manifest.json', 'mounts', 0, 'features')],
    ['Operation wrapper', 'operation', fixtureAt('sync-update-operation.json')],
    ['Feed wrapper', 'feed', fixtureAt('public-feed.json')],
    ['Snapshot wrapper', 'snapshot', fixtureAt('collection-snapshot.json')],
    ['Collection directory wrapper', 'collectionDirectory', fixtureAt('collection-directory.json')],
    ['Collection create result wrapper', 'collectionCreateResult', fixtureAt('publisher-collection-create-result.json')],
    ['Node detail wrapper', 'nodeDetail', fixtureAt('node-detail.json')],
    ['Release directory wrapper', 'releaseDirectory', fixtureAt('release-directory.json')],
    ['Release result wrapper', 'releaseResult', fixtureAt('release-result.json')],
    ['Sync session request wrapper', 'syncSessionRequest', fixtureAt('sync-session-request.json')],
  ] as const)('$label remains closed because this version supports extensions only in its nested carrier', (_label, definition, value) => {
    for (const field of ['futurePayload', 'extensions'] as const) {
      const candidate = value();
      candidate[field] = field === 'extensions' ? { [namespace]: payload() } : payload();
      const result = validators.validate(definition, candidate);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors).toEqual(expect.arrayContaining([
          expect.objectContaining({ keyword: 'additionalProperties', params: { additionalProperty: field } }),
        ]));
      }
    }
  });

  it.each([
    ['Snapshot', 'snapshot', 'collection-snapshot.json', ['collection']],
    ['Collection directory', 'collectionDirectory', 'collection-directory.json', ['collections', 0]],
    ['Collection create result', 'collectionCreateResult', 'publisher-collection-create-result.json', ['collection']],
    ['Node detail', 'nodeDetail', 'node-detail.json', ['node']],
    ['Release directory', 'releaseDirectory', 'release-directory.json', ['releases', 0]],
    ['Release result', 'releaseResult', 'release-result.json', ['release']],
    ['Sync session request', 'syncSessionRequest', 'sync-session-request.json', ['replica']],
  ] as const)('%s accepts forward data only in its nested typed carrier', (_label, definition, file, path) => {
    const wrapper = fixture(file);
    const carrier = path.reduce<JsonObject>((value, segment) => value[segment] as JsonObject, wrapper);
    carrier.extensions = { ...(carrier.extensions ?? {}), [namespace]: payload() };
    expect(validators.validate(definition, wrapper)).toEqual({ valid: true, errors: [] });
  });

  it('places operation extension payload only in a typed nested carrier and reports its exact sibling path', () => {
    const invalid = fixture('sync-update-operation.json');
    invalid.payload.futurePayload = payload();
    expectUnknownCoreField(validators.validate('operation', invalid), '/payload');

    const valid = fixture('sync-update-operation.json');
    valid.payload.value.extensions = { [namespace]: payload() };
    expect(validators.validate('operation', valid)).toEqual({ valid: true, errors: [] });
  });

  it('places Feed extension data only in the extension CloudEvent data carrier', () => {
    const event = fixture('public-feed.json').events[0];
    event.type = namespace;
    event.data = { collectionId: 'collection-1', extensions: { [namespace]: payload() } };
    expect(validators.validate('feedEvent', event)).toEqual({ valid: true, errors: [] });

    event.data = { collectionId: 'collection-1', futurePayload: payload() };
    expectUnknownCoreField(validators.validate('feedEvent', event), '/data');
  });

  it('preserves and overwrites whole extension maps without aliasing or input mutation', () => {
    const source = { id: 'source', extensions: { [namespace]: payload() } };
    const target = { id: 'target', extensions: { 'https://old.example/ns': 'discarded' } };
    const before = structuredClone({ source, target });
    const result = preserveExtensionCarrier(source, target, { surface: 'relay' });

    expect(result).toEqual({ value: { id: 'target', extensions: source.extensions }, removals: [] });
    expect({ source, target }).toEqual(before);
    expect(result.value).not.toBe(target);
    expect(result.value.extensions).not.toBe(source.extensions);
    expect(result.value.extensions?.[namespace]).not.toBe(source.extensions[namespace]);
    (source.extensions[namespace].nested[0] as JsonObject).arrays[0] = 'changed';
    expect(result.value.extensions?.[namespace]).toEqual(payload());
  });

  it('places without mutation, rejects implicit overwrite, and replaces only with explicit policy', () => {
    const otherNamespace = 'https://other.example/extensions/v1';
    const carrier = {
      id: 'node-1',
      extensions: {
        [namespace]: { version: 1 },
        [otherNamespace]: payload(),
      },
    };
    const before = structuredClone(carrier);
    const replacement = { version: 2 };

    expect(() => placeExtension(carrier, namespace, replacement)).toThrow('already exists');
    const replaced = placeExtension(carrier, namespace, replacement, { overwrite: 'replace' });

    expect(replaced).toEqual({
      id: 'node-1',
      extensions: { [namespace]: { version: 2 }, [otherNamespace]: payload() },
    });
    expect(carrier).toEqual(before);
    expect(replaced).not.toBe(carrier);
    expect(replaced.extensions).not.toBe(carrier.extensions);
    expect(replaced.extensions[namespace]).not.toBe(replacement);
    expect(replaced.extensions[otherNamespace]).not.toBe(carrier.extensions[otherNamespace]);
    expect(Object.isFrozen(replaced)).toBe(true);
    expect(Object.isFrozen(replaced.extensions)).toBe(true);
    expect(Object.isFrozen(replaced.extensions[otherNamespace])).toBe(true);
    expect(Object.isFrozen((replaced.extensions[otherNamespace] as JsonObject).nested)).toBe(true);
    expect(Object.isFrozen(((replaced.extensions[otherNamespace] as JsonObject).nested[0] as JsonObject).arrays)).toBe(true);
  });

  it('does not treat an unknown runtime overwrite policy as explicit replacement', () => {
    const carrier = { extensions: { [namespace]: { version: 1 } } };
    expect(() => placeExtension(carrier, namespace, { version: 2 }, {
      overwrite: 'merge' as 'replace',
    })).toThrow(TypeError);
    expect(carrier.extensions[namespace]).toEqual({ version: 1 });
  });

  it('constructs extensions as a complete atomic merge-patch member', () => {
    const otherNamespace = 'https://other.example/extensions/v1';
    for (const definition of [
      'collectionMergePatch', 'nodeMergePatch', 'annotationMergePatch',
      'attachmentMergePatch', 'relationMergePatch',
    ] as const) {
      const patch = placeExtension({ extensions: { [otherNamespace]: 'retained' } }, namespace, null);
      expect(patch.extensions).toEqual({ [otherNamespace]: 'retained', [namespace]: null });
      expect(validators.validate(definition, patch)).toEqual({ valid: true, errors: [] });
      expect(validators.validate(definition, { extensions: null })).toEqual({ valid: true, errors: [] });
    }
  });

  it('does not synthesize extensions and removes a stale target map when the source has none', () => {
    const source = { id: 'source' };
    const target = { id: 'target', extensions: { 'https://old.example/ns': true } };
    expect(preserveExtensionCarrier(source, target, { surface: 'relay' })).toEqual({
      value: { id: 'target' }, removals: [],
    });
    expect(target.extensions).toEqual({ 'https://old.example/ns': true });
  });

  it.each(['__proto__', 'constructor', 'prototype'] as const)('rejects prototype-polluting nested member %s', (key) => {
    const nested = Object.create(null) as JsonObject;
    Object.defineProperty(nested, key, { value: { polluted: true }, enumerable: true });
    expect(() => preserveExtensions({ [namespace]: nested }, { surface: 'relay' })).toThrow(key);
    expect(({} as JsonObject).polluted).toBeUndefined();
  });

  it('does not execute accessors while copying extension payloads', () => {
    const getter = vi.fn(() => 'secret');
    const nested = {} as JsonObject;
    Object.defineProperty(nested, 'value', { enumerable: true, get: getter });
    expect(() => preserveExtensions({ [namespace]: nested }, { surface: 'relay' })).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    ['a sparse array', (() => Array(1))],
    ['an array with a named member', (() => Object.assign([], { named: true }))],
    ['an array with a symbol member', (() => Object.assign([], { [Symbol('item')]: true }))],
    ['a Date instance', (() => new Date(timestamp))],
    ['an object with an exotic prototype', (() => Object.create({ inherited: true }) as JsonObject)],
    ['an object with a symbol member', (() => ({ [Symbol('member')]: true }))],
    ['an object with a non-enumerable member', (() => {
      const value = {};
      Object.defineProperty(value, 'hidden', { value: true });
      return value;
    })],
  ] as const)('rejects non-I-JSON structure: %s', (_label, createValue) => {
    expect(() => placeExtension({}, namespace, createValue())).toThrow(TypeError);
  });

  it('does not execute array item or carrier accessors', () => {
    const arrayGetter = vi.fn(() => 'secret');
    const array = [] as unknown[];
    Object.defineProperty(array, '0', { enumerable: true, get: arrayGetter });
    Object.defineProperty(array, 'length', { value: 1 });
    expect(() => placeExtension({}, namespace, array)).toThrow(TypeError);
    expect(arrayGetter).not.toHaveBeenCalled();

    const carrierGetter = vi.fn(() => ({ [namespace]: payload() }));
    const carrier = {} as ExtensionCarrier;
    Object.defineProperty(carrier, 'extensions', { enumerable: true, get: carrierGetter });
    expect(() => placeExtension(carrier, namespace, payload())).toThrow(TypeError);
    expect(carrierGetter).not.toHaveBeenCalled();
  });

  it('rejects invalid existing maps before reading their payloads', () => {
    const payloadGetter = vi.fn(() => payload());
    const existing = {} as JsonObject;
    Object.defineProperty(existing, namespace, { enumerable: true, get: payloadGetter });
    expect(() => placeExtension({ extensions: existing }, namespace, payload(), { overwrite: 'replace' }))
      .toThrow(TypeError);
    expect(payloadGetter).not.toHaveBeenCalled();
  });

  it('rejects a future sibling before semantics in direct two-stage validation', () => {
    const candidate = fixture('local-bookmark-node.json');
    candidate.futurePayload = payload();
    const semantics = vi.fn(() => ({ valid: true as const, issues: [] as const }));
    const result = validateWireDocument(validators, 'node', candidate, semantics);
    expect(result).toMatchObject({ valid: false, stage: 'structural' });
    expect(semantics).not.toHaveBeenCalled();
    if (!result.valid && result.stage === 'structural') {
      expectUnknownCoreField({ valid: false, errors: result.errors });
    }
  });

  it('accepts correctly placed extensions through parsed two-stage validation', () => {
    const candidate = fixture('local-bookmark-node.json');
    candidate.extensions = { [namespace]: payload() };
    const semantics = vi.fn(() => ({ valid: true as const, issues: [] as const }));
    expect(validateWireJsonDocument(validators, 'node', JSON.stringify(candidate), semantics)).toEqual({
      valid: true, value: candidate,
    });
    expect(semantics).toHaveBeenCalledOnce();
  });

  it('exports the extension schema, helper types, generated carrier types, and root contract mapping', () => {
    const extensionSchema: Extensions = { [namespace]: payload() };
    const rootContract: ColpContract<'extensions'> = extensionSchema;
    const map: ExtensionMap = rootContract;
    const carrier: ExtensionCarrier = { extensions: map };
    expect(validators.definitionNames).toContain('extensions');
    expect(collectionProtocolSchema.$defs.extensions).toBeDefined();
    expect(carrier.extensions).toBe(map);
    expect(placeExtensionFromSchema).toBe(placeExtension);

    type ExportedCarriers = Collection | Node | Annotation | Attachment | Relation | Release | Replica;
    type ExportedDtos = CollectionCreate | RootCreate | NodeCreate | AnnotationCreate | AttachmentCreate
      | RelationCreate | CollectionMergePatch | NodeMergePatch | AnnotationMergePatch
      | AttachmentMergePatch | RelationMergePatch | DirectoryCollection | ReleaseCreate
      | OperationSource | ExtensionFeedEventData;
    const resource: ExportedCarriers = fixture('local-bookmark-node.json') as Node;
    const dto: ExportedDtos = { extensions: extensionSchema } as ReleaseCreate;
    expect(resource).toBeDefined();
    expect(dto.extensions).toBe(extensionSchema);
  });

  it('audits every canonical direct extensions carrier and no unsupported schema object', () => {
    const actual = Object.entries(collectionProtocolSchema.$defs)
      .filter(([, definition]) => 'properties' in definition && definition.properties !== undefined
        && 'extensions' in definition.properties)
      .map(([name]) => name)
      .sort();
    const expected = [...new Set(carrierCases.map(({ definition }) => definition))].sort();
    expect(actual).toEqual(expected);
    expect(expected).toHaveLength(22);
  });

  it('expands a fixed authoritative number of inherited-evidence cases', () => {
    const expanded = carrierCases.length + jsonPayloads.length + validNamespaces.length
      + invalidNamespaces.length + 9 + 1 + 12 + 7 + 1 + 1 + 1 + 1 + 1 + 3 + 1 + 7 + 1 + 1
      + 1 + 1 + 1 + 1 + 1 + 1 + 1;
    expect(carrierCases).toHaveLength(29);
    expect(expanded).toBe(102);
  });
});
